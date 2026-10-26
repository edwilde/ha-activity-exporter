# CLAUDE.md — ha-activity-exporter

Guidance for Claude Code (and humans) working in this repo.

## What this is

A HACS-distributed Home Assistant **custom integration** that adds one **sidebar
panel** for exporting the history of one entity, or up to 20 at once, to **CSV** or **JSON**. The
primary consumer of the output is an LLM, so the data is dumped faithfully (with
an optional "skip repeats" filter that keeps any row where the value or a
setting changed), never aggregated or interpreted. The CSV gives each setting its
own column by default (`timestamp,value,seconds_since_previous,<settings>,details`).
Choosing several entities gives one timeline in one file: the CSV gains an
`entity_id,name,` prefix, rows run in time order across entities and
`seconds_since_previous` is per entity; the JSON wraps an `entities[]` list. One
entity's output is unchanged.

Design docs: `docs/plans/2026-05-31-ha-activity-exporter-design.md`, then
`docs/plans/2026-10-25-settings-detail-export-design.md` (settings columns, which supersedes parts of it),
then `docs/plans/2026-10-26-detail-recording-design.md` (the "Save more detail" tab and mirror sensors)
Plans + built-vs-intended notes: `.ai/implementation-plans/ha-activity-exporter.md`,
then `.ai/implementation-plans/2026-10-25-settings-detail-export.md`,
then `.ai/implementation-plans/2026-10-25-multi-entity-export.md` (several-entity export),
then `.ai/implementation-plans/2026-10-26-detail-recording.md` (detail recording)

## Architecture (one sentence)

The Python side is deliberately thin: it serves the frontend directory once,
registers/removes the sidebar panel, runs a `sensor` platform of hidden "mirror"
sensors (one per thing whose details the user chose to save) and registers three
WebSocket commands to list, describe and save those choices; **all real work is
client-side** in a vanilla web component that reads history over the authenticated
WebSocket, folds the mirrors' details back into the exported rows and builds the
download in the browser. There is **no backend history endpoint**.

```
custom_components/ha_activity_exporter/
  __init__.py        # async_setup_entry: serve frontend dir, register panel + WS commands, forward to sensor; unload: remove panel
  config_flow.py     # single-instance, confirm-only flow (no settings)
  const.py           # the shared contract: domain, URLs, panel name/icon, WS command names
  detail.py          # pure helpers: denylist, describe a state's details, pick/cap mirror attributes
  sensor.py          # DetailMirror: hidden sensor copying a source's value + chosen details
  websocket.py       # detail/list (any user), detail/describe and detail/save (admin)
  manifest.json      # deps: http, frontend, panel_custom
  frontend/
    exporter-core.js          # PURE logic (no DOM) — unit-tested with node --test
    activity-exporter-panel.js# the web component; imports exporter-core.js
```

## Non-negotiable invariants

1. **Plain language, zero HA jargon in the UI.** The target audience does not
   know Home Assistant. Never expose "entity", "state", "recorder", or
   "significant changes" in visible copy. (The CSV header starts `timestamp,value`, and is
   exactly `timestamp,value,details` when per-setting columns are off; with several entities
   it starts `entity_id,name,timestamp,value` and is `entity_id,name,timestamp,value,details`
   when per-setting columns are off;
   the JSON payload keeps faithful HA keys — `state`, `attributes` — as a stable
   machine schema for LLMs.)
2. **No build step, no CDN/runtime deps in the frontend.** It must work on
   isolated/offline HA installs. Pure logic lives in `exporter-core.js` so it is
   Node-testable without a DOM; the panel imports it. The whole `frontend/`
   directory is served (the panel imports a sibling module), so a single-file
   static registration is not enough.
3. **Keep the shared contract in `const.py` consistent** with the JS: domain
   `ha_activity_exporter`, panel served at `/ha_activity_exporter/...`, web
   component tag `activity-exporter-panel`, sidebar path `activity-exporter`, and
   the WebSocket commands `ha_activity_exporter/detail/list`, `.../describe` and
   `.../save`.
4. **Verify HA APIs against source before using them.** Real-HA testing is
   limited here; CI (hassfest + HACS + tests) is the gate.

## Verified HA API facts (easy to get wrong)

- `panel_custom.async_register_panel(hass, frontend_url_path, webcomponent_name, ...)`
  — `frontend_url_path` comes **before** `webcomponent_name`; the param is
  `webcomponent_name` (not `name`); there is **no `update` arg** (remove the panel
  before re-registering to avoid "Overwriting panel").
- `frontend.async_remove_panel(...)` is a **synchronous `@callback`** — do NOT await it.
- `hass.http.async_register_static_paths([StaticPathConfig(url_path, path, cache_headers)])`
  is awaitable; the old `register_static_path` was removed in 2025.7. Static paths
  cannot be unregistered, so register once per process (guarded by `hass.data`).
- History WS command `history/history_during_period` returns the **compressed**
  format keyed by entity_id: rows use `s` (state), `a` (attributes), `lu`
  (last_updated, epoch **seconds float**), `lc` (last_changed, present only when
  `!= lu`). Timestamps are epoch seconds, not ISO. Time rows by `lu` (always
  present); `lc` is the earlier moment the value last changed, so a settings-only
  row (brightness step, colour step) has `lc` < `lu`. Fetch per day-chunk with
  `include_start_time_state` only on the first chunk to avoid duplicate boundary rows.
- The start-time state row (from `include_start_time_state`) has `lu` = the
  requested start time and **no `lc`**: `_stmt_and_join_attributes_for_start_state`
  selects literal 0 for both timestamps. Its real `last_changed` is not available
  from `history_during_period`, so the JSON marks that first row
  `start_of_period: true` with `last_changed: null` instead of claiming a change.
- `ha-entity-picker` (and the plural `ha-entities-picker`) have **no `hass`
  property** since home-assistant/frontend PR #52833 (2026-06-24): they read states
  and registries from Lit context, so they only work as DOM descendants of HA's
  context provider. Both are lazy-loaded by HA pages and may be undefined when the
  panel renders, which is why the datalist fallback exists. The panel still sets
  `picker.hass` for HA versions before that change; on newer ones it is ignored.
- Since HA 2024.8 (core PR #121776) lights mark `brightness`, `color_mode`,
  `color_temp(_kelvin)`, `effect` and `hs/rgb/rgbw/rgbww/xy_color` as unrecorded, so
  `history_during_period` never returns them for a `light.*`. Settings-only rows still
  arrive (each with a new `lu`) but carry none of those attributes. A template sensor
  copying them is recorded normally (verified on 2026.10.4); the "Save more detail" tab
  automates this with a mirror sensor.
- `State.state_info["unrecorded_attributes"]` is Python-only: it is not in
  `State.as_dict()` or the compressed history state, so the frontend cannot see which
  attributes are unrecorded and must ask the `detail/describe` command.
- The recorder drops **all** of a state's attributes when their JSON is over 16384
  bytes, so a mirror trims its own attributes (largest first) to stay under the cap.
- `SensorEntity` excludes `options` from the recorder through
  `_entity_component_unrecorded_attributes`. Overriding
  `_entity_component_unrecorded_attributes = frozenset()` on a subclass clears it,
  because `Entity.__init_subclass__` rebuilds the combined set for every subclass.
- The recorder ignores an entity's `hidden_by`, so hiding a mirror in the registry
  does not stop its states being recorded.
- `single_config_entry: true` in the manifest makes core handle single-instance
  (aborts the second flow, hides "Add") — no manual guard needed.
- **manifest.json keys must be ordered `domain, name, then alphabetical`** or
  hassfest fails the build.

## Commands

```bash
# Frontend pure-function tests (no build)
node --test tests/frontend/*.test.mjs

# Python tests (HA's frontend asset package is NOT bundled by the test helper —
# install the version HA core pins so the `frontend` component can set up)
python -m venv .venv && .venv/bin/pip install -r requirements_test.txt
.venv/bin/pip install -c "$(.venv/bin/python -c 'import os,homeassistant;print(os.path.join(os.path.dirname(homeassistant.__file__),"package_constraints.txt"))')" home-assistant-frontend
.venv/bin/pytest
```

The `tests/test_init.py` suite sets the entry up through
`hass.config_entries.async_setup` with the real dependency chain (`http`,
`frontend`, `panel_custom`), so the panel and the sensor platform load as they do
in Home Assistant.

## Gotchas

- MDI sidebar icons: validate names against the bundled set
  (`hass_frontend/static/mdi/iconList.json`). Prefer filled glyphs — thin
  `-outline` variants can read as blank at sidebar size. Current icon:
  `mdi:file-export`.
- HACS validation requires GitHub repository **topics** to be set.
- Brand icon/logo go to the `home-assistant/brands` repo separately; the HACS
  `brands` check is intentionally ignored in CI until that PR lands.

## Conventions

- Commit per logical change; keep CI green. Bump `manifest.json` `version` for
  user-visible changes and tag releases with the bare version (`X.Y.Z`, no `v` prefix).
- Tracked in ticketgraph (project `ha-activity-exporter`) — snapshot at `.ai/TICKETS.md`.
