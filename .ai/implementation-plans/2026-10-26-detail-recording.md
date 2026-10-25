# Detail recording Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Let an admin choose any entity and which of its unrecorded details to save, without YAML, and fold those details into exports.
**Architecture:** A hidden mirror `sensor` per chosen entity copies the source's value plus chosen details (with `source_last_updated`), so the recorder keeps them. Config lives in `entry.options["tracked"]`, edited through admin-only WebSocket commands from a new panel tab. The exporter fetches mirror history alongside the source and merges it client-side.
**Tech Stack:** HA custom integration (Python, pytest-homeassistant-custom-component), vanilla web component + pure ES module (`node --test`).
**Design:** `docs/plans/2026-10-26-detail-recording-design.md` (the spec; read it first).

---

## Ticket-scoped context

- `State.state_info` is Python-only (`homeassistant/core.py:1809`); `as_dict`/compressed state do not carry it, so the panel needs the `describe` WS command.
- Recorder drops **all** attributes of a state whose JSON exceeds 16 384 bytes (`recorder/db_schema.py:92,580`), returning `{}`.
- `Entity.__init_subclass__` rebuilds the combined unrecorded set from the subclass (`helpers/entity.py:597`), so overriding `_entity_component_unrecorded_attributes = frozenset()` on the mirror clears the sensor's `options` exclusion (`sensor/__init__.py:187`).
- `_attr_entity_registry_visible_default = False` hides the mirror; the recorder never looks at `hidden_by`.
- CI installs `home-assistant-frontend` (`.github/workflows/validate.yml:53-57`), so platform tests may set the entry up through `hass.config_entries.async_setup(entry.entry_id)`. `.venv` already has it.
- Existing tests: `tests/test_init.py` calls `async_setup_entry` directly; that cannot forward to a platform outside a real config-entry setup.

---

## Task 1: Pure detail helpers

**Files:**
- Modify: `custom_components/ha_activity_exporter/const.py`
- Create: `custom_components/ha_activity_exporter/detail.py`
- Create: `tests/test_detail.py`

**Decisions:**
- Constants in `const.py`: `CONF_TRACKED = "tracked"`, `ATTR_SOURCE_ENTITY_ID = "source_entity_id"`, `ATTR_SOURCE_LAST_UPDATED = "source_last_updated"`, `MAX_RECORDED_ATTRS_BYTES = 16384`, WS type names `ha_activity_exporter/detail/list|describe|save`.
- `is_denied(name)`: exact set `{access_token, entity_picture, entity_picture_local, attribution, restored, supported_features, friendly_name, icon, unit_of_measurement, device_class, state_class, source_entity_id, source_last_updated}` plus regex `token|secret|password|api_key` (case-insensitive) *because* secrets must never reach the DB or an export, and the mirror sets the others itself.
- `is_volatile(name)`: `media_position`, `media_position_updated_at`, and names starting `next_` *because* they change constantly and bloat the DB (mirrors `VOLATILE_ATTRIBUTES` in `exporter-core.js:187`).
- `describe(state)` returns `{"entity_id", "name", "details": [{"name", "unrecorded", "volatile"}]}` sorted unrecorded-first then by name, excluding denied names. `unrecorded` = name in `state.state_info["unrecorded_attributes"]`, or every name when it contains `MATCH_ALL`; `state_info is None` → none unrecorded.
- `mirror_attributes(attributes, chosen)` returns `(kept: dict, dropped: list[str])`: keep chosen, present, non-denied names; JSON-encode with HA's `json_bytes`; while over `MAX_RECORDED_ATTRS_BYTES - 512` drop the largest-encoded attribute, recording its name. 512 bytes of headroom covers the two mirror keys + friendly_name.

**Don't:**
- Don't import HA's recorder module, *because* the integration must not depend on recorder internals; mirror the cap as a constant.

**Implement:** The helpers above, pure functions taking plain dicts / `State`.

**Verify:** `.venv/bin/pytest tests/test_detail.py -q` covers: each denied exact name and a regex hit (`api_token`), a normal name allowed; `describe` with `state_info=None`, with a set, with `MATCH_ALL`, denied names absent, ordering; `mirror_attributes` keeps only chosen, drops denied even if chosen, drops the largest over the cap and lists it. Mutation-check (`mutation-check`) the denylist, MATCH_ALL branch and the cap loop.

---

## Task 2: Mirror sensor platform and setup wiring

**Files:**
- Create: `custom_components/ha_activity_exporter/sensor.py`
- Modify: `custom_components/ha_activity_exporter/__init__.py`
- Modify: `tests/test_init.py`
- Create: `tests/test_sensor.py`

**Decisions:**
- `DetailMirror(SensorEntity)`: `_attr_should_poll = False`, `_attr_has_entity_name = False`, `_attr_unique_id = source_entity_id`, name `"<source friendly name or entity_id> (saved detail)"`, `_attr_entity_registry_visible_default = False`, `_entity_component_unrecorded_attributes = frozenset()`, no device class/unit/state class. Suggested object id `activity_exporter_<domain>_<object_id>` via `self.entity_id = f"sensor.activity_exporter_{domain}_{object_id}"` set before adding (registry keeps it afterwards).
- In `async_added_to_hass`: subscribe with `async_track_state_change_event(hass, [source], cb)` via `self.async_on_remove`, then apply the current source state once.
- Apply: compute `(state_str, kept)` from the source `State` with `mirror_attributes`; if equal to the last applied pair, do nothing; otherwise store, set `extra_state_attributes = {**kept, source_entity_id, source_last_updated: source.last_updated_timestamp}` and `async_write_ha_state()`. Missing source → value `unavailable`, no details, `source_last_updated` = now. Keep `dropped` on the entity for the list command.
- Native value is the source state string truncated to 255 chars (the state machine limit).
- `__init__.py`: `PLATFORMS = [Platform.SENSOR]`; `await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)`; `entry.async_on_unload(entry.add_update_listener(_reload))` where `_reload` calls `hass.config_entries.async_reload`; unload calls `async_unload_platforms` and removes the panel. Mirrors kept in `entry.runtime_data` (dict source→entity) for the WS list.
- Update the module docstring: no backend *history* path; a small config surface exists.

**Don't:**
- Don't write on every source event, *because* unchanged details would add a mirror row per source row; `source_last_updated` on changed rows plus carry-forward in the export (Task 4) is enough.
- Don't remove registry entries in the platform; Task 3's save does that.

**Implement:** The platform and the setup changes above.

**Verify:** `tests/test_sensor.py` (set up through `hass.config_entries.async_setup` with `http` ready, options `{"tracked": {"light.lamp": ["brightness", "options"]}}`, source states set with `hass.states.async_set(..., state_info={"unrecorded_attributes": frozenset({"brightness"})})`): mirror state equals source state; carries `brightness` and `options` but not unchosen attributes; `source_last_updated` equals the source's `last_updated_timestamp`; a source change touching only an unchosen attribute does not change the mirror's `last_updated`; a change to `brightness` does; registry entry `hidden_by == INTEGRATION`; changing options via `hass.config_entries.async_update_entry` adds a mirror for a new source. `tests/test_init.py` moves to `async_setup` for the panel tests. Mutation-check the change guard and the unrecorded override.

---

## Task 3: WebSocket commands

**Files:**
- Create: `custom_components/ha_activity_exporter/websocket.py`
- Modify: `custom_components/ha_activity_exporter/__init__.py`
- Create: `tests/test_websocket.py`

**Decisions:**
- Register once per process in `async_setup_entry` (guard in `hass.data[DOMAIN]`, like the static path), with `websocket_api.async_register_command`.
- `detail/list` (no admin gate, `@websocket_api.async_response` not needed): from the loaded entry's options + runtime mirrors return `[{source_entity_id, mirror_entity_id, attributes, dropped}]`; no loaded entry → `[]`.
- `detail/describe` `{entity_id: str}` (`@websocket_api.require_admin`): `describe(hass.states.get(id))`; unknown id → error `not_found`.
- `detail/save` `{entity_id: str, attributes: [str]}` (`require_admin`): reject any denied name with `invalid_format`; empty list removes the key from `tracked` and removes the mirror's entity registry entry (lookup by platform `DOMAIN`, unique_id = source); otherwise set it. Persist with `hass.config_entries.async_update_entry(entry, options=...)` (the update listener reloads).
- Copy options dicts before mutating, *because* `entry.options` is a read-only mapping.

**Don't:**
- Don't add a history or data-returning command; the invariant is "no backend history endpoint".

**Implement:** The three commands above.

**Verify:** `tests/test_websocket.py` with `hass_ws_client` (and `hass_admin_user` / non-admin via `hass_read_only_user`... use `hass_ws_client(hass, hass_read_only_access_token)` for the non-admin case): list returns the tracked mirror; describe returns unrecorded flags; save adds then (empty list) removes the option and the registry entry; save rejects `access_token`; describe and save return `unauthorized` for a non-admin; list works for a non-admin. Mutation-check the admin gates and the denied rejection.

---

## Task 4: Export merge in the core module

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/exporter-core.js`
- Modify: `tests/frontend/exporter-core.test.mjs`

**Decisions:**
- `mergeMirrorRecords(sourceRecords, mirrorRecords)`: mirror records sorted by `attributes.source_last_updated`; for each source record (sorted), attach the details of the latest mirror record with `source_last_updated * 1000 <= timestampMs + 1` (1 ms float tolerance, like `CAUSE_MATCH_MS`). Merge as `{...mirrorDetails, ...source.attributes}` (recorded values win). Strip `source_entity_id`, `source_last_updated`, `friendly_name` from mirror details. Return new objects; do not mutate inputs.
- Source has no records but mirror has → return mirror records rebuilt with `timestampMs = lastChangedMs = source_last_updated * 1000`, mirror keys stripped.
- `detailChoices(details)` → `[{name, label, checked, note}]`: `checked = unrecorded && !volatile`; `note` "changes very often, uses more space" when volatile; `label` = name with `_` → space, first letter capitalised.

**Implement:** The two exported functions, each with a one-line docblock.

**Verify:** node tests: join picks the mirror row with matching `source_last_updated` even when its own `timestampMs` is later; carry-forward to a later source row; rows before the first mirror row unchanged; recorded attribute wins a clash; mirror keys stripped; excluded-source fallback; `detailChoices` defaults. `node --test tests/frontend/*.test.mjs` green; mutation-check the `<=` comparison, the clash order and the fallback branch.

---

## Task 5: Panel tab and export wiring

**Files:**
- Modify: `custom_components/ha_activity_exporter/frontend/activity-exporter-panel.js`

**Decisions:**
- Two tabs, **Export** and **Save more detail**, as buttons with `role="tab"`/`aria-selected`, a `role="tablist"` wrapper and `role="tabpanel"` sections; the second tab only when `hass.user?.is_admin`.
- Save-more-detail tab: list from `detail/list` (name from `hass.states`, chosen details as labels, "Change" and "Stop saving" buttons; "Too large to save: …" when `dropped`; "Can't find this any more" when the source is missing). An add picker reusing the existing picker/datalist pattern (`activity-exporter-panel.js:422`). After a pick, `detail/describe` → checkboxes from `detailChoices`, unrecorded group first with heading "Home Assistant doesn't keep these", then "Already kept". No unrecorded details → "Everything about this is already saved." Save → `detail/save`, then refresh the list and show "Saving from now on. Earlier history doesn't have these details."
- Export tab: when a single chosen thing is untracked, an admin, and `describe` shows unrecorded details, show "Some details of this aren't saved. Save more detail" as a button switching tabs with that thing preselected. Call `describe` lazily on selection change; failures hide the hint.
- `_loadRecords`: fetch `detail/list` first (failure → `[]`); add mirror ids for chosen sources to `entity_ids`; after collecting, set each source's records to `mergeMirrorRecords(source, mirror)` before `normaliseRecords`/`attachCauses`; drop mirror ids from the result map. Include mirror ids in `buildCacheKey` input.
- Copy uses no HA jargon (CLAUDE.md invariant 1).

**Don't:**
- Don't export mirror rows as separate groups.

**Implement:** The tab UI and the export wiring above.

**Verify:** `node --check` on the panel file; `node --test tests/frontend/*.test.mjs` green; manual reading of the copy for jargon (grep the file for `entity|state|attribute|recorder` in user-visible strings).

---

## Task 6: Docs and release

**Files:**
- Modify: `README.md` (replace the template-sensor section with how to use the tab; keep a short note that history only starts when saving starts)
- Modify: `CLAUDE.md` (architecture sentence, file tree, invariant wording, verified facts above)
- Modify: `custom_components/ha_activity_exporter/manifest.json` (`version` 1.3.0; `dependencies` unchanged; keep key order)

**Verify:** both test suites green.

---

## Caveats & known risks

- A mirror only covers time after it was added; carry-forward can attribute stale details across a period when saving was stopped and restarted.
- Renamed sources are not followed (design decision 8).
- Reloading the entry on every save re-registers the panel; acceptable.

---

## Review record

(populated post-implementation by the `review-implementation` skill)
