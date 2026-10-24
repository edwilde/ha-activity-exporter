# Settings detail export: design

**Status:** Approved 2026-10-25 (decisions taken autonomously from the briefing
"light detail export for Activity Exporter" and Ed's follow-up: *"we want all useful
attributes on all types of devices, not just lights"*).
**Builds on:** `docs/plans/2026-05-31-ha-activity-exporter-design.md`

## Purpose

Make one export show everything Home Assistant recorded about a device's settings
over time (brightness, colour and colour temperature for a light; target and current
temperature for a thermostat; position for a cover) so an LLM can check
what the device actually did (for example, a 45-minute sunrise script that steps 18
lights every 15-30 seconds). Home Assistant's own logbook export only shows on/off,
so it cannot answer that question.

## What the code does today (verified 2026-10-25)

| Briefing check | Result |
|---|---|
| 1. History flags | **Already correct.** `_loadRecords` sends `significant_changes_only: false`, `minimal_response: false`, `no_attributes: false`. |
| 2. Settings-only rows reach the output | **Broken.** `parseHistoryRecords` timestamps a row with `lc` when present. HA's `row_to_compressed_state` always emits `lu` and emits `lc` only when it differs, where `lc` is the *earlier* moment the value last changed. Every settings-only row (brightness step, colour step) is therefore stamped with the time the light turned on, and `normaliseRecords` then dedupes on `timestamp|state`, dropping all but one of them. |
| 3. Skip repeats | **Broken for settings.** `filterStateChanges` compares the value only, so it deletes every brightness and colour step. |
| 4. Compressed format | Confirmed against HA source: `s`, `a`, `lu` (always), `lc` (only when `!= lu`), epoch seconds floats. |

A further latent issue: the CSV formula-injection guard prefixes any field starting
with `-`, which would turn a negative number (an outdoor temperature) into text once
settings get their own columns.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Row time | **`lu`** (when the row was recorded). `lc` is kept as `lastChangedMs`. | `lu` is the moment of the change the row describes; `lc` only says when the *value* last changed. |
| Value changed? | `state_changed = lc absent or lc == lu` | Exactly HA's definition; settings-only rows read `false`. |
| Which device types | **All**, generically. Lights get named colour columns and `brightness_percent` as a special case of the general rule. | Ed's follow-up. |
| Which attributes become columns | Every attribute **except descriptive/capability metadata**. Metadata = a known set (`friendly_name`, `icon`, `entity_picture`, `unit_of_measurement`, `device_class`, `state_class`, `attribution`, `supported_features`, `supported_color_modes`, `assumed_state`, `editable`, `id`, `restored`, `options`, `entity_id`, `step`) plus the name patterns `min_*`, `max_*`, `*_list`, `*_modes`, `*_step`, **and only while its value is constant across the export.** A metadata-looking attribute that varies gets a column after all. | A known-name rule keeps the column set stable between exports of the same device (a steady thermostat target still gets its column). The "constant" guard means a misclassified attribute (a statistics sensor's `max_value`) is never hidden. |
| Column values | Scalars as-is (`null` → blank). Known light tuples split into named columns. Any other list → one column holding compact JSON. Objects → `details`. | Spreadsheet- and LLM-friendly without inventing structure. |
| Light tuples | `hs_color` → `hue`, `saturation`; `rgb_color` → `red`, `green`, `blue` (falling back to the first three of `rgbw_color`/`rgbww_color` when `rgb_color` is absent); `rgbw_color[3]` → `white`; `rgbww_color[3..4]` → `cold_white`, `warm_white`; `xy_color` → `x`, `y`. A tuple whose numbers were not all placed in columns stays in `details`. | Briefing R1, without losing the raw rgbw values when HA also reports `rgb_color`. |
| Derived values | `brightness_percent = round(brightness / 255 * 100, 1)` (after `brightness`). `seconds_since_previous` (3 dp) is computed **after** Skip repeats, against the previous row in the file; blank on the first row. So with Skip repeats on, `seconds_since_previous` spans the rows that were left out. | Describes the gaps the reader actually sees. |
| Column order | `timestamp, value, seconds_since_previous`, then the light set in briefing order (`brightness, brightness_percent, color_mode, color_temp_kelvin, hue, saturation, red, green, blue, white, cold_white, warm_white, x, y`), then other attribute columns alphabetically, then `changed_by`, then `details`. Only columns that hold a value somewhere in the file are included. | Lights read as the briefing specified; other devices get a stable, predictable order with no empty columns. |
| Column name clash | An attribute named like a fixed column (`timestamp`, `value`, …) is prefixed `attribute_`. | Never two columns with one header. |
| Switch | **"Give each setting its own column"**, on by default, shown for every device. Off → today's exact `timestamp,value,details` CSV. JSON is unaffected. | Briefing UX, generalised; keeps the old format one click away for anyone parsing it. |
| Skip repeats | A repeat = same value **and** same attributes as the previous kept row, ignoring `media_position` and `media_position_updated_at` (a media player rewrites these while playing without anything meaningful changing). | Briefing R2. No light attribute changes without meaning, so none is ignored for lights. |
| Boundary dedupe | `normaliseRecords` keys on time + value + attributes. | Never merges two genuinely different rows. |
| CSV formula guard | Numbers (`-3.5`) are left alone; only non-numeric text starting `= + - @` (tab/CR) is prefixed. | Keeps numeric columns numeric while keeping the spreadsheet-injection guard. |
| JSON | Unchanged keys plus: `entity` block `{entity_id, friendly_name, domain, capabilities}` (capabilities = the metadata attributes of the most recent row); per record `derived: {state_changed, seconds_since_previous, brightness_percent?}` and `cause` (see below). `attributes` stays faithful and complete. | Briefing R1 + R3, domain-agnostic. |
| What caused it (R4) | Fetch `logbook/get_events` (`start_time`, `end_time`, `entity_ids`) per day-chunk alongside history. Match an entry to the row whose `lu` equals the entry's `when` (±1 ms) and whose value matches. CSV gets `changed_by` (the triggering script/automation id with its name, else `domain.action`, else the user id); JSON gets `cause` with the raw `context_*` fields. If the logbook is not available, the export still succeeds without it. | Answers "which script did this". **Limitation:** the logbook only records value changes, so settings-only rows (brightness and colour steps) carry no cause; sensors with a unit are not in the logbook at all. |
| Sibling entities (R4 optional) | **Not built.** | Breaks the single-device model; the briefing allows skipping. |

## Architecture

Unchanged: all new logic is pure functions in `exporter-core.js` (Node-testable);
the panel only adds the switch, the logbook call and wiring. No Python changes. No
build step or runtime dependency.

New/changed pure functions:

- `parseHistoryRecords` → records gain `lastChangedMs` and use `lu` for `timestampMs`.
- `normaliseRecords` → dedupe key includes attributes.
- `filterRepeats` (replaces `filterStateChanges`) → value + attributes, ignoring the volatile set.
- `isMetadataKey`, `flattenAttributes(record)`, `buildColumns(records)` → the column model.
- `toCsv(records, timeZone, { splitColumns })` → split or legacy layout.
- `buildJsonPayload` → `entity` block and per-record `derived`/`cause`.
- `parseLogbookEntries`, `attachCauses(records, entries)`, `describeCause(entry)` → R4.

## Error handling

- Logbook failure (integration not loaded, permission, timeout) → swallowed, export
  proceeds without causes. History failure keeps today's plain-language error.
- Malformed attribute values never crash the export. A non-numeric value (for example
  brightness `"high"`) is kept as-is in its column and only the derived values
  (`brightness_percent`) are left blank. A short or malformed tuple leaves its
  columns blank.

## Testing

`node --test` fixtures built from compressed rows (`s`, `a`, `lu`, `lc`): on/off
only; a brightness ramp with the value unchanged; a colour-mode switch
(`color_temp` → `hs`); off rows; `unavailable`; settings-only rows with Skip
repeats on and off; an rgbw light; a thermostat (generic attributes, negative
temperature); a sensor (all metadata → no extra columns); logbook matching. Every
new test is shown to fail against a mutation of the code it guards
(`mutation-check`).

Acceptance (on Ed's instance): export `light.bedroom_kitty_bedside_light` for a
45-minute sunrise window → a row about every 30 seconds with brightness and
hue/saturation or colour temperature, none dropped by Skip repeats.

## Delivery

Feature branches, each reviewed (`/code-review high --fix`) and merged:

1. `feature/faithful-attribute-history`, `lu` timestamps, attribute-aware dedupe
   and Skip repeats, column model, JSON `entity`/`derived`, the switch, docs.
2. `feature/change-causes`, logbook enrichment (`changed_by` / `cause`), docs.
3. `feature/panel-polish`, fixes from a Hallmark audit of the panel.

Then version 1.1.0, tag `v1.1.0` and a GitHub release.
