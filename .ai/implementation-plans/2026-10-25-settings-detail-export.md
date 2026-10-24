# Settings Detail Export Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Export every useful setting a device recorded (brightness, colour, temperatures, positions...) as faithful rows, with per-setting CSV columns, an attribute-aware Skip repeats, and the cause of each change where Home Assistant knows it.
**Architecture:** All logic is new or changed pure functions in `exporter-core.js` (tested with `node --test`); the panel adds one switch, one logbook WebSocket call and wiring. No Python change.
**Tech Stack:** Vanilla ES modules, `node:test`, Home Assistant WebSocket API.
**Design:** `docs/plans/2026-10-25-settings-detail-export-design.md` (all decisions live there; this plan does not repeat them).

---

## Ticket-scoped context

- HA compressed history rows (verified in `homeassistant/components/recorder/models/state.py` `row_to_compressed_state`): `lu` always present; `lc` only when it differs from `lu` and is the *earlier* value-change time. Times are epoch seconds floats.
- Current bug: `parseHistoryRecords` (`exporter-core.js:127-143`) stamps rows with `lc`; `normaliseRecords` (`:151-163`) then merges every settings-only row of one "on" period. Brightness ramps never reach the file today.
- `csvEscape` (`exporter-core.js:221-225`) prefixes any field starting with `-`, which would break negative numeric columns.
- `logbook/get_events` (verified in `homeassistant/components/logbook/websocket_api.py:452-520`, `processor.py`): params `start_time`, `end_time`, `entity_ids`; with `timestamp=True` each entry has `when` (epoch seconds float, equal to the state's `last_updated_ts`), `state`, `entity_id`, and optionally `context_user_id`, `context_event_type`, `context_domain`, `context_service`, `context_entity_id`, `context_state`, `context_name`, `context_message`, `context_source`. `context_entity_id_name` is NOT sent (`include_entity_name=False`). Only value changes appear; sensors with a unit are excluded.
- Ed's sample lights (fixtures): bedside `hs` `[12,100]` at brightness 3; entrance WiZ `rgbw [165,136,0,88]` brightness 26; snug `hs [287.717,100]` brightness 38; lounge `color_temp` only 2202-4000 K, supported_features 32.
- Tests: `tests/frontend/exporter-core.test.mjs`, plain `test(...)` blocks grouped by `// --- fn ---` comments. Every new function and test gets a one-line docblock/comment per Ed's rules; each new test must be shown to fail (`mutation-check`).

---

## Branch 1: `feature/faithful-attribute-history`

### Task 1: Row timing and attribute-aware dedupe

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/exporter-core.js:121-180`
- Modify: `tests/frontend/exporter-core.test.mjs`

**Decisions:**
- `timestampMs = lu * 1000`; new `lastChangedMs = (lc ?? lu) * 1000`; a row without `lu` is skipped (HA always sends it).
- `normaliseRecords` key = time + state + stable JSON of attributes (sorted keys) *because* two different settings rows can share a second.
- Replace `filterStateChanges` with `filterRepeats`: repeat = same state and same attributes (stable comparison) ignoring `media_position`, `media_position_updated_at`. Remove the old export; update the panel import.

**Don't:**
- Don't compare attributes with plain `JSON.stringify` (key order is not guaranteed equal between rows).

**Implement:** Fix the parser timing, widen the dedupe key, add `filterRepeats` with a stable deep-equal helper.

**Verify:** New tests: a ramp fixture (same `lc`, ascending `lu`, state `on`) yields N rows with distinct timestamps; Skip repeats keeps every brightness/colour step and drops an exact repeat; a media-position-only change counts as a repeat. All existing tests pass (update ones that asserted `lc` timing).

### Task 2: Column model

**Files:**
- Modify: `exporter-core.js` (new section `// --- settings columns ---`)
- Modify: tests

**Decisions:** as the design's Decisions table (metadata set + patterns + constant guard; light tuple mapping; derived `brightness_percent`; column order; `attribute_` prefix on clashes; only non-empty columns).
- Expose `buildColumns(records)` returning the ordered column list and `flattenAttributes(attributes, metadataKeys)` returning `{ cells, leftovers }`, where `leftovers` (the `details` object) holds objects and any tuple not fully placed in columns.
- `seconds_since_previous` is computed by the formatter from the records it is given (already filtered), rounded to 3 dp.

**Implement:** Pure functions for metadata detection (`metadataKeys(records)`), per-row flattening, and column ordering.

**Verify:** Tests: bedside `hs` light gives hue/saturation and `brightness_percent` 1.2 for brightness 3; colour-mode switch `color_temp`→`hs` fills `color_temp_kelvin` then hue/saturation; off row leaves light cells blank; rgbw light without `rgb_color` gives red/green/blue/white = 165/136/0/88 and no `rgbw_color` in details; rgbw light *with* `rgb_color` keeps `rgbw_color` in details; thermostat attributes (`current_temperature: -3.5`, `temperature`, `hvac_action`) become columns and `hvac_modes`/`min_temp` do not; a `max_value` that varies gets a column; a plain sensor with only metadata yields no extra columns.

### Task 3: CSV and JSON output

**Files:**
- Modify: `exporter-core.js` (`csvEscape`, `toCsv`, `buildJsonPayload`, `toJson`)
- Modify: tests

**Decisions:**
- `toCsv(records, timeZone, { splitColumns = true } = {})`; `splitColumns: false` returns exactly today's three-column output (keep the existing tests for that path).
- `csvEscape` leaves finite numbers (and numeric strings matching `/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i`) unprefixed.
- JSON keeps every existing key; adds `entity: { entity_id, friendly_name, domain, capabilities }` and per record `derived: { state_changed, seconds_since_previous, brightness_percent? }`. `state_changed` = `lastChangedMs === timestampMs`.

**Implement:** Wire the column model into both formatters.

**Verify:** Tests: split CSV header for the bedside fixture equals `timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,hue,saturation,red,green,blue,x,y,details` (or whatever columns that fixture actually fills, asserted exactly); `-3.5` stays numeric; `=cmd` is still neutralised; JSON settings-only row has `state_changed: false`; `entity.capabilities.supported_color_modes` comes from the latest row.

### Task 4: Panel switch and wiring

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/activity-exporter-panel.js`

**Decisions:**
- Switch label "Give each setting its own column", help "Puts things like brightness, colour and temperature in separate spreadsheet columns. Turn off for a simple three-column file." Checked by default, visible for every device, affects CSV only.
- Skip-repeats help text becomes "Leaves out rows where neither the value nor any setting changed."
- Switching it never refetches (cache unchanged).

**Don't:** No HA jargon in copy (no entity, state, attribute, recorder).

**Implement:** Add the checkbox in the same `.toggle-row` pattern, pass `splitColumns` to `toCsv`, use `filterRepeats`.

**Verify:** `node --check` on the panel; render in the mock-hass harness (scratchpad) and confirm the switch shows checked and the CSV header changes when toggled.

### Task 5: Docs and version

**Files:** `README.md`, `docs/plans/2026-05-31-ha-activity-exporter-design.md` (note the superseded skip-repeats rule and CSV columns, pointing at the new design), `custom_components/ha_activity_exporter/manifest.json` (`1.1.0`), `CLAUDE.md` (lu/lc fact).

**Verify:** README examples match real output of the formatter for a fixture (generate them, don't hand-write).

---

## Branch 2: `feature/change-causes`

### Task 6: Logbook causes

**Files:** `exporter-core.js` (new `// --- causes ---` section), panel `_loadRecords`, tests, README.

**Decisions:**
- `parseLogbookEntries(result, entityId)` keeps entries for that entity with numeric `when`; `attachCauses(records, entries)` sets `record.cause` (the raw `context_*` fields) on the row whose `timestampMs` is within 1 ms of `when*1000` and whose state matches.
- `describeCause(cause)`: `context_entity_id` (+ ` (context_name)` when present) → else `context_domain.context_service` → else `context_source`/`context_message` → else `user <context_user_id>` → else blank.
- CSV split mode adds `changed_by` before `details` only when some row has a cause; JSON records gain `cause` only when matched.
- The logbook call runs per chunk after history, inside its own try/catch; any failure disables causes for that export silently.

**Verify:** Tests: an on row matches a logbook entry by `when`; a settings-only row never gets a cause; a script-triggered entry reads `script.weekend_sunrise`; a service-only entry reads `light.turn_on`; no entries → no `changed_by` column.

---

## Branch 3: `feature/panel-polish`

### Task 7: Hallmark audit fixes

Run `/hallmark` audit on the panel (rendered in the mock-hass harness), fix what it finds that fits HA theming and the plain-language invariant, and re-take the README screenshot if the harness can stand in for HA.

---

## Caveats & known risks

- Real-HA verification is Ed's acceptance step (bedside sunrise export); this session can only test against fixtures that follow HA's verified row format.
- The default CSV layout changes for every user; the switch restores the old one.

---

## Review record

(populated post-implementation by the `review-implementation` skill)
