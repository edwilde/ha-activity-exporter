# Multi-entity export Implementation Plan

> **For the implementer:** Use `executing-plans` (or `subagent-driven-development`) to implement task-by-task.

**Goal:** Let one export cover two or more devices or sensors, in one CSV or one JSON file, so an LLM can correlate them, while leaving single-device output byte-identical.
**Architecture:** Records stay per entity end to end (parse, normalise, Skip repeats, causes, metadata, derived values) in a `Map<entityId, records[]>`. Only the final formatting step merges them: new pure functions `toMultiCsv` and `buildMultiJsonPayload` beside the untouched single-entity `toCsv` and `buildJsonPayload`. The panel picks the single or multi formatter by selection count.
**Tech Stack:** Vanilla web component, `node --test`, HA WebSocket (`history/history_during_period`, `logbook/get_events`).
**Project context cache:** `~/.claude/projects/-Users-edwilde-Scripts-ha-activity-exporter/writing-plans-cache.md` (refreshed 2026-10-25)
**Source:** GitHub issue #1 (acceptance criteria, back-compat rule, dev notes), rebased on 1.1.1.

---

## Difficulty

**Medium, not cheap.** The issue was written against 1.0.x, when the CSV was three columns and "mostly UI + formatting" was true. Since 1.1.0 the formatting layer is the hard part: per-setting columns, per-entity metadata detection, `seconds_since_previous`, causes, the `entity` block, `derived`, and the start-of-period marker all assume one entity. The data plumbing is still cheap (both WS commands already take an `entity_ids` list). Expect roughly the size of the 1.1.0 `feature/faithful-attribute-history` branch: 6 tasks, about 40 new tests, one branch. The one real unknown is the multi-select picker (Task 4).

---

## Ticket-scoped context

- The issue names `filterStateChanges`; it is now `filterRepeats` (`exporter-core.js:210`). The CSV is no longer `timestamp,value,details` by default; see `toCsv` (`exporter-core.js:624-670`).
- `history/history_during_period` and `logbook/get_events` both accept a list in `entity_ids` and answer in one request per day-chunk. History returns an object keyed by entity id; the logbook returns one flat list whose entries carry `entity_id`. `parseHistoryRecords(wsResult, entityId)` (`:128`) and `parseLogbookEntries(result, entityId)` (`:441`) already filter by id, so they are reused per entity on the same response.
- `metadataKeys` (`:307`) decides "metadata" by a value being constant across the export. Pooled across entities, two lights with different `friendly_name`s would make `friendly_name` vary and turn it into a column. It must run per entity.
- `isStartOfPeriod` (`:710`, 1.1.1) only looks at index 0 of the records it is given, so it is correct as long as `buildJsonPayload` is called per entity.
- Panel state is a single string `this._entityId` (`activity-exporter-panel.js:171`), used in the picker (`:372-423`), buttons (`:488-500`), export (`:545-626`), fetch and cache (`:628-679`), logbook (`:684-707`).
- `LARGE_RESULT_THRESHOLD = 25000` (`panel:37`).

---

## Task 1: Multi-entity fixtures
<!-- REVIEW: completed -->

**Files:**
- Modify: `tests/frontend/exporter-core.test.mjs` (new section at the end)

**Decisions:**
- One shared fixture of three entities with overlapping times, used by Tasks 2-3, *because* the interesting cases (pooled metadata, ties, mixed columns) only appear across entities.

**Implement:** Add this fixture verbatim.

```js
// --- multi-entity ---------------------------------------------------------

const M0 = 1768435200; // 2026-01-15T00:00:00Z

/** Three entities' compressed rows as one history response. */
function multiResponse() {
  return {
    "light.bedside": [
      { s: "off", lu: M0, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: null, brightness: null } },
      { s: "on", lu: M0 + 60, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: "hs", brightness: 26, hs_color: [30, 80] } },
      { s: "on", lu: M0 + 90, lc: M0 + 60, a: { friendly_name: "Bedside", supported_color_modes: ["hs"], color_mode: "hs", brightness: 51, hs_color: [30, 70] } },
    ],
    "light.hall": [
      { s: "on", lu: M0, a: { friendly_name: "Hall", supported_color_modes: ["color_temp"], color_mode: "color_temp", brightness: 255, color_temp_kelvin: 3000 } },
      { s: "on", lu: M0 + 60, lc: M0 - 3600, a: { friendly_name: "Hall", supported_color_modes: ["color_temp"], color_mode: "color_temp", brightness: 128, color_temp_kelvin: 3000 } },
    ],
    "climate.lounge": [
      { s: "heat", lu: M0 + 30, a: { friendly_name: "Lounge", hvac_modes: ["off", "heat"], current_temperature: -1.5, temperature: 21 } },
    ],
  };
}

const MULTI_IDS = ["light.bedside", "light.hall", "climate.lounge"];
const MULTI_NAMES = { "light.bedside": "Bedside", "light.hall": "Hall", "climate.lounge": "Lounge" };

/** The fixture as the groups the multi formatters take, in selection order. */
function multiGroups() {
  const response = multiResponse();
  return MULTI_IDS.map((entityId) => ({
    entityId,
    friendlyName: MULTI_NAMES[entityId],
    records: normaliseRecords(parseHistoryRecords(response, entityId)),
  }));
}
```

**Verify:** `node --test tests/frontend/*.test.mjs` still passes (fixture only).

---

## Task 2: `toMultiCsv`
<!-- REVIEW: deviated (approved) -->

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/exporter-core.js` (beside `toCsv`, `:617-670`; `columnName` `:337`; `buildColumns` `:402`)
- Modify: `tests/frontend/exporter-core.test.mjs`

**Decisions:**
- Input is `groups: {entityId, friendlyName, records}[]` in selection order, each group already normalised and Skip-repeats filtered. Same options as `toCsv` (`splitColumns`, `userNames`).
- **Row order: global chronological**, ties broken by selection order, then by each entity's own order, *because* the stated purpose is cross-device correlation (the issue's own recommendation).
- **Split header:** `entity_id,name,timestamp,value,seconds_since_previous,<setting columns>,[changed_by,]details`. **Legacy header:** `entity_id,name,timestamp,value,details`. `name` is the friendly name, blank when unknown.
- **Setting columns = union** of each entity's `buildColumns(records, metadataKeys(records))`, ordered as today (light columns first in `LIGHT_COLUMNS` order, the rest alphabetical). A shared name (two entities with `temperature`) shares one column; the `entity_id` column disambiguates.
- **Metadata per entity:** each row is flattened with its own entity's `metadataKeys`, never a pooled set.
- **`seconds_since_previous` is per entity:** the gap since that entity's previous row in the file, blank on each entity's first row, *because* that keeps its 1.1.0 meaning; a gap to some other device's row means nothing.
- `changed_by` appears when any row of any entity has a cause.
- `entity_id` and `name` join the fixed columns **in multi mode only**, so an attribute called `name` becomes `attribute_name` there. Pass the fixed set into the column-naming step rather than adding to `FIXED_COLUMNS`, which would change single-entity output.

**Don't:**
- Don't route a single selection through `toMultiCsv`. Single output must stay byte-identical, and the cheapest proof is that it never reaches the new code.
- Don't pool records before `metadataKeys`; two lights' different `friendly_name`s would make it vary and become a column.

**Implement:** Add `toMultiCsv(groups, timeZone, options)`, reusing `metadataKeys`, `buildColumns`, `flattenAttributes`, `describeCause` and `csvEscape`. Generalise `columnName` to take the fixed set.

**Verify:** new tests, each shown to fail by a mutation:
- `toMultiCsv: rows are in time order with ties in selection order` (fixture rows at `M0` and `M0 + 60` from both lights).
- `toMultiCsv: split header unions the columns, light columns first` (expect `entity_id,name,timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,color_temp_kelvin,hue,saturation,current_temperature,temperature,details`, `details` only if a leftover exists; work out the exact header from the fixture and assert it whole).
- `toMultiCsv: friendly_name is not a column even though the names differ` (per-entity metadata).
- `toMultiCsv: seconds_since_previous is per entity` (`light.hall` second row reads `60`, not the gap to the `climate.lounge` row).
- `toMultiCsv: legacy layout is entity_id,name,timestamp,value,details`.
- `toMultiCsv: a name attribute becomes attribute_name`.
- `toMultiCsv: -1.5 stays numeric` and `changed_by` present when only one entity has a cause.
- `toCsv` single-entity tests still pass unchanged.

---

> **Review [2026-10-25]:**
> **Status:** Deviated (approved)
> **What changed:** `toCsv` and `toMultiCsv` are thin wrappers over one internal `buildCsv` (exporter-core.js:695-709), so single-device output now passes through shared code instead of an untouched `toCsv`.
> **Root cause:** `/code-review high --fix` flagged the two near-identical builders as drift-prone (also a Task 2 deferred minor). A seeded comparison of 24,000 outputs against the previous code (and the reviewer's own 4,000 against `main`) showed no byte differences, which is the guarantee the original "never reaches the new code" rule was there to protect.
> **Decision:** Approved.

## Task 3: `buildMultiJsonPayload`, `toMultiJson`, `buildMultiFilename`
<!-- REVIEW: completed -->

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/exporter-core.js` (beside `buildJsonPayload` `:749`, `buildFilename` `:580`)
- Modify: `tests/frontend/exporter-core.test.mjs`

**Decisions:**
- Shape, grouped per entity (the issue's proposal), with each entity block equal to what `buildJsonPayload` would give for that entity minus the shared keys:
  `{ exported_at, period: {start, end}, state_changes_only, entity_count, record_count, entities: [ { entity_id, friendly_name, entity: {...}, record_count, records: [...] } ] }`.
  Top-level `record_count` is the total.
- Build each entity block by calling `buildJsonPayload` per entity and dropping `exported_at`, `period`, `state_changes_only`, *because* that reuses `derived`, `last_changed`, `start_of_period` and `cause` exactly, so the per-entity shape cannot drift from the single-entity file.
- An entity with no records is still listed, with `record_count: 0` and `records: []`, *because* "asked for and had none" is information an LLM should see.
- Entities appear in selection order.
- Filename for 2+: `activity-export_{N}-items_{startDate}_{endDate}.{ext}`, built with the existing `formatDateForFilename`. One entity keeps `buildFilename`.

**Don't:**
- Don't add a flat cross-entity `records` list to the JSON. The CSV is the flat timeline; the issue leaves a flat JSON list for later.

**Implement:** Add the three functions with one-line docblocks.

**Verify:** new tests, each shown to fail by a mutation:
- `buildMultiJsonPayload: wraps entities in selection order with shared period and totals`.
- `buildMultiJsonPayload: each entity block deep-equals buildJsonPayload for that entity minus the shared keys`.
- `buildMultiJsonPayload: start_of_period is marked per entity` (both lights have a row at `M0` with no `lc`, period start `M0`; the climate's first row at `M0 + 30` is not marked).
- `buildMultiJsonPayload: an entity with no records is listed with record_count 0`.
- `buildMultiFilename: 3 items and the date range`.

---

## Task 4: Multi-select picker and selection state
<!-- REVIEW: unplanned (approved) -->

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/activity-exporter-panel.js` (`:171`, `:225-230`, `:370-465`, `:488-534`, `STYLES` `:40-160`)

**Decisions:**
- State becomes `this._entityIds: string[]` in selection order, duplicates ignored.
- **Picker: a list of our own `ha-entity-picker` rows** (one per chosen device, each with a remove button, plus one empty picker to add another) rather than `ha-entities-picker`, *because* `ha-entity-picker` is the element we already depend on and load-check, `ha-entities-picker` is lazy-loaded by even fewer HA pages, and it is built from the same rows anyway (see "Picker research").
- Give the add picker the already-chosen ids through `excludeEntities` if `ha-entity-picker` has that property on the HA version in use; ignore a duplicate on add either way.
- **Fallback (no `ha-entity-picker`):** keep the datalist input; choosing an option adds it to a list of chosen names, each with a remove button. No comma-separated text, *because* friendly names can contain commas.
- **Cap: 20 devices.** At 20 the add control is hidden and the help says "You can export up to 20 at once." *because* every row is held in the browser, and the combined-row warning only fires after the download.
- Copy (plain language, no dashes): label stays "What do you want to export?"; help becomes "Pick one or more devices or sensors, like a light, thermostat or door."; remove buttons are labelled "Remove {friendly name}"; the no-selection hint becomes "Pick a device or sensor above to turn on the download buttons." (unchanged).
- Any change to the selection calls `_invalidateCache()` and `_updateButtons()`.

**Don't:**
- Don't show entity ids in visible copy except where the fallback already does to separate duplicate names.

**Implement:** Replace the single picker with the chosen-list UI in both the picker and fallback paths; make `_updateButtons` check `_entityIds.length > 0`.

**Verify:** In the mock-hass harness (see Caveats), pick 3 devices, remove the middle one, add it back; buttons enable and disable correctly; at 20 the add control disappears; keyboard only (Tab, Enter, Delete on a remove button) works; run once with `ha-entity-picker` unregistered to exercise the fallback. Screenshots at 375 px and desktop.

---

> **Review [2026-10-25]:**
> **Status:** Unplanned addition (approved)
> **What was added:** The add picker is labelled "Add a device or sensor" / "Add another device or sensor" and each chosen row "Device or sensor N"; changing a chosen row's picker swaps that device in place and clearing it removes the row (`_changeChosen`); after the last device is removed, focus falls back to the field title (`tabindex="-1"`, `_focusAddControl`). Picker labels and exclusions are only rewritten when they change.
> **Root cause:** The final review found the add picker repeated the visible title as its label, and that every HA state update re-rendered up to 21 Lit pickers. Testing in a real HA 2026.10.4 found the real `ha-entity-picker` cannot take focus (no own `focus()`, `delegatesFocus: false`), so removing the last device dropped focus to `<body>`; the harness stub had hidden this.
> **Decision:** Approved.

## Task 5: Fetch, cache, causes and export for several entities
<!-- REVIEW: deviated (approved); one finding skipped -->

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/activity-exporter-panel.js` (`_export` `:545-626`, `_loadRecords` `:628-679`, `_requestLogbook` `:684-693`, `_retryCauses` `:698-707`)

**Decisions:**
- One history request and one logbook request per day-chunk with `entity_ids: this._entityIds`, *because* both commands take the list; progress stays per chunk.
- Cache holds `Map<entityId, records[]>`, each value `attachCauses(normaliseRecords(...), entriesForThatEntity)`. **Cache key:** sorted ids joined with `,`, then `|start|end`, *because* order does not change the data; output order comes from the current selection at export time.
- `_retryCauses` re-fetches the logbook once per chunk for all ids and reattaches per entity.
- Skip repeats runs per entity before formatting (acceptance criterion 2).
- One selected: call `toCsv` / `toJson` / `buildFilename` exactly as today. Two or more: `toMultiCsv` / `toMultiJson` / `buildMultiFilename`.
- The large-file warning uses the combined row count.
- Empty status when every entity has no rows: "We couldn't find any history for these devices or sensors in the time period you chose. Try a longer time period, some devices don't keep a long history." (single keeps today's text). Success status counts all rows.

**Don't:**
- Don't key the cache on selection order; reordering the same devices must not refetch.
- Don't pass `include_start_time_state` on any chunk but the first (unchanged rule; now it seeds every entity at once).

**Implement:** Generalise the fetch loop and export dispatch as above.

**Verify:** Harness: export 3 entities to CSV and JSON and check the downloaded text (`window.__exports`) matches `toMultiCsv` / `toMultiJson` on the same fixture; one recorded `window.__calls` history request per chunk carries all 3 ids; changing order then exporting again makes no new calls; with `?fail=logbook/get_events` the export succeeds and says causes were unavailable; a single selection's download is byte-identical to the 1.1.1 output for the same range.

---

> **Review [2026-10-25]:**
> **Status:** Deviated (approved) and one finding skipped
> **What changed:** The several-device empty message reads "...Try a longer time period. Some devices don't keep a long history." (full stop, not the planned comma). `describeMissingHistory` falls back to the raw entity id when a device has no friendly name.
> **Root cause:** The planned wording was a comma splice (final review M1). The id fallback only applies to a device that has left `hass.states`, where the id is the only identifier left.
> **Decision:** Wording approved; id fallback skipped (rare, noted here).

## Task 6: Docs, version, screenshot
<!-- REVIEW: deviated (fixed before merge); unplanned (approved) -->

**Files:**
- Modify: `README.md` (formats section, Limitations `:152-160`, screenshot)
- Modify: `CLAUDE.md` (What this is; Invariant 1's CSV header note)
- Modify: `custom_components/ha_activity_exporter/manifest.json` (`version` to `1.2.0`)
- Replace: `docs/images/activity-exporter-panel.jpg`

**Decisions:**
- Minor version (`1.2.0`): a new capability, single output unchanged.
- README gains a short "Several devices at once" section with a generated CSV and JSON excerpt from the Task 1 fixture, and drops "Exports one device or sensor at a time" from Limitations.

**Implement:** Update the docs from real `toMultiCsv` / `toMultiJson` output, not hand-typed.

**Verify:** README excerpts equal the functions' output for the fixture; `node --test` and `pytest` pass; CI green on the branch.

---

> **Review [2026-10-25]:**
> **Status:** Deviated (fixed before merge) and unplanned addition (approved)
> **What changed:** README gains a "Lights: brightness and colour" section with a template-sensor workaround, and CLAUDE.md gains facts on unrecorded light attributes and on `ha-entity-picker` having no `hass` property. The README examples that showed light brightness and colour were regenerated from recorded-style data (a thermostat and a light settings sensor), and the column-switch help became "Puts things like temperature, position and mode in separate spreadsheet columns. Turn off for a simpler file with fewer columns."
> **Root cause:** Exporting from a real HA 2026.10.4 returned light rows with only `friendly_name`. Since HA 2024.8 (core PR #121776) lights mark `brightness`, `color_mode`, `color_temp(_kelvin)`, `effect` and the colour tuples as unrecorded, so `history_during_period` never returns them. A template sensor copying them is recorded normally (verified on 2026.10.4). The help text change came from a Task 4-5 review: "three-column" was wrong for several devices.
> **Decision:** Approved; the contradicting examples were fixed before merge.

## Caveats & known risks

- **Picker element availability.** HA lazy-loads many `ha-*` elements. The panel already handles a missing `ha-entity-picker` with the datalist fallback; the multi UI must keep that path working, not only the picker path.
- **Wide, sparse CSV.** A light, a thermostat and a media player together can give 40+ columns, most blank on any row. That is the cost of one flat timeline; the JSON stays tidy. Worth one sentence in the README.
- **Same-named settings from different device types share a column** (`temperature` on a thermostat and a weather entity). Correct but easy to misread without the `entity_id` column; keep it first.
- **Memory.** 20 chatty sensors over a long range can produce hundreds of thousands of rows. The cap and the existing warning limit the damage; streaming is out of scope.
- **The mock-hass harness** used for 1.1.0 lives only in a session scratchpad. Commit a copy under `tests/frontend/harness/` (not served by the integration) as part of Task 4 so Tasks 4-5 have a repeatable check.

---

## Validation review

Opus delta review, 2026-10-25. The fixture was run through the real `exporter-core.js`: the split header is exactly `entity_id,name,timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,color_temp_kelvin,hue,saturation,current_temperature,temperature,details` (`hvac_modes` is metadata; `friendly_name` and `supported_color_modes` stay out only when metadata is per entity). Line offsets: `isStartOfPeriod` :721, `buildJsonPayload` :760, `_export` :544. **These deltas override the task text where they conflict.**

**Decisions to challenge**
- `details` is always emitted in the split layout (as `toCsv` does), not "only if a leftover exists". Here it is an empty column.
- The tie-break test must use a selection order that is not alphabetical (`["light.hall", "light.bedside", "climate.lounge"]`), or sorting by id would also pass.
- Replace the "-1.5 stays numeric" test (already guaranteed by `csvEscape`) with: a friendly name `=cmd` in the `name` column comes out `'=cmd`.
- The Task 1 fixture has no repeats, causes, leftovers or `name` attribute. The `changed_by`, `attribute_name` and per-entity Skip repeats tests each build their own small fixture.
- The per-entity metadata test also asserts `supported_color_modes` is absent.

**Decisions to add**
- Thread the fixed-column set through `flattenAttributes` and `buildColumns` (both exported) as an optional argument defaulting to `FIXED_COLUMNS`, so single output stays byte-identical.
- Core test: one entity's repeats do not affect another's (`filterRepeats` per group).
- When some selected devices have no rows, the success message names them in plain language ("No history for Hall in this period.").
- JSON top-level `record_count` and the large-file warning count rows after Skip repeats, as single mode does.
- The byte-identical single-download check fixes `Date.now()` or compares everything except `exported_at`.

**Lifecycle-stage misapplications**
- Selection changes do **not** call `_invalidateCache()`; the sorted-id cache key already decides whether to refetch (so a reorder reuses the cache). Task 4's "calls `_invalidateCache()`" is withdrawn.
- `_export` copies `this._entityIds` at its start and passes that copy through fetch, naming and formatting, so a selection edited mid-fetch cannot desync.
- Per entity, in order: `filterRepeats`, then formatting (which computes `seconds_since_previous` per entity), then the global merge. Never compute gaps on the merged list.
- `_retryCauses` loops over the cached Map's keys, not the live selection.

**Risks under-weighted**
- The mock harness has no Lit context provider, so Task 4 can pass there while the real picker fails on HA 2026.7+. The real-HA picker check is a **release gate** for 1.2.0, not a note.
- Each history chunk response grows with the number of devices. Try a busy 20-device day in the harness before keeping the cap at 20.
- Merge by (timestamp, selection index, row index) with a stable sort; ties are exact float equality only.

---

## Picker research

Checked against home-assistant/frontend `dev` (2026-10-24) and release 20260930.5:

- `ha-entities-picker` exists (`src/components/entity/ha-entities-picker.ts`). `value: string[]`; fires `value-changed` with `detail.value` = the whole new array. Props include `includeDomains`, `excludeDomains`, `excludeEntities`, `entityFilter`, `label`, `helper`, `reorder`. No `allowCustomEntity`.
- It renders one `ha-entity-picker` per chosen entity plus a trailing add picker that excludes chosen ids and turns into an add button once one is chosen. No chips.
- **It is lazy-loaded**, only by `ha-selector-entity` and four editor or dialog modules, so it is not reliably defined when a custom panel renders. `ha-entity-picker` has the same problem, which is why the datalist fallback exists. `window.loadCardHelpers` is only set once the Lovelace chunk has loaded. Hence the decision in Task 4.
- **No `hass` property any more.** Since PR #52833 (2026-06-24, "Migrate entity picker to context") `ha-entity-picker` reads states and registries from Lit context (`@consume`). Setting `picker.hass` (as the panel does today, `activity-exporter-panel.js:396`) is now a harmless no-op. The picker only works if the panel element sits under HA's context provider in the DOM, which a `panel_custom` element should, but this is **unverified**. Check it on a real HA 2026.7+ instance during Task 4; the same check tells you whether today's single picker still works there.

---

## Review record

**Reviewed:** 2026-10-25
**Reviewer:** Claude (Opus subagent, fresh context)
**Branch:** feature/multi-entity-export
**Commit:** 1b8f233

### Verification Results
- **Tests:** `node --test tests/frontend/*.test.mjs` 134 pass, 0 fail; `pytest` 5 passed; GitHub Actions Validate green.
- **Lint:** none configured.
- **Mutation checks:** Task 2 17/17, Task 3 12/12, Tasks 4-5 core helpers 14/14 caught. Panel-only code was checked in the harness and in a real HA 2026.10.4 (Docker, localhost), not by mutation.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | Single-device CSV runs through a shared builder | Deviation | Approved |
| 2 | Docs on unrecorded light attributes and picker context | Unplanned | Approved |
| 3 | README examples showed light brightness/colour HA never records | Deviation | Fixed before merge |
| 4 | Raw entity id can appear in "No history for..." | Deviation | Skipped |
| 5 | Several-device empty message uses a full stop | Deviation | Approved |
| 6 | Picker labels, swappable rows, focus fallback | Unplanned | Approved |
| 7 | Column-switch help reworded | Unplanned | Approved |

### Technical Context & Learnings
- Home Assistant has not recorded light `brightness`, `color_mode`, `color_temp(_kelvin)`, `effect` or `hs/rgb/rgbw/rgbww/xy_color` since 2024.8 (core PR #121776). A light export shows a row per step with none of those values; a template sensor copying them is recorded and exports with `hue`/`saturation` columns.
- The real `ha-entity-picker` (HA 2026.10) works inside a `panel_custom` element through Lit context, honours `excludeEntities`, and fires `value-changed` with `""` when its own clear button is used. It cannot take focus via `focus()`.
- A stub picker in the harness cannot prove focus or context behaviour; a disposable HA container (`ghcr.io/home-assistant/home-assistant:stable` on `127.0.0.1:8123`, onboarding via `/api/onboarding/*`) can, in a few minutes.
- Preset ranges (last 24 hours/7/30 days) build their cache key from `Date.now()`, so switching CSV to JSON refetches; with 20 devices that is 20 times the data. Known and left as is: reusing a preset's result would make its end time stale.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Finding 4 (raw id in the no-history message) skipped.
- Code review notes left as is: same-named devices get identical Remove labels in picker mode; a picker registering late rebuilds the fallback input mid-typing (as in 1.1.x); the field title's `<label for>` only associates with the fallback input.
