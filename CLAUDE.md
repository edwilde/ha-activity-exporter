# CLAUDE.md — ha-activity-exporter

Guidance for Claude Code (and humans) working in this repo.

## What this is

A HACS-distributed Home Assistant **custom integration** that adds one **sidebar
panel** for exporting a single entity's history to **CSV** or **JSON**. The
primary consumer of the output is an LLM, so the data is dumped faithfully (with
an optional "skip repeats" filter), never aggregated or interpreted.

Design doc: `docs/plans/2026-05-31-ha-activity-exporter-design.md`
Plan + built-vs-intended notes: `.ai/implementation-plans/ha-activity-exporter.md`

## Architecture (one sentence)

The Python side is deliberately thin — it serves the frontend directory once and
registers/removes the sidebar panel; **all real work is client-side** in a vanilla
web component that reads history over the authenticated WebSocket and builds the
download in the browser. There is **no backend data endpoint**.

```
custom_components/ha_activity_exporter/
  __init__.py        # async_setup_entry: serve frontend dir + register panel; unload: remove panel
  config_flow.py     # single-instance, confirm-only flow (no settings)
  const.py           # the shared contract: domain, URLs, panel name/icon
  manifest.json      # deps: http, frontend, panel_custom
  frontend/
    exporter-core.js          # PURE logic (no DOM) — unit-tested with node --test
    activity-exporter-panel.js# the web component; imports exporter-core.js
```

## Non-negotiable invariants

1. **Plain language, zero HA jargon in the UI.** The target audience does not
   know Home Assistant. Never expose "entity", "state", "recorder", or
   "significant changes" in visible copy. (The CSV header is `timestamp,value,details`;
   the JSON payload keeps faithful HA keys — `state`, `attributes` — as a stable
   machine schema for LLMs.)
2. **No build step, no CDN/runtime deps in the frontend.** It must work on
   isolated/offline HA installs. Pure logic lives in `exporter-core.js` so it is
   Node-testable without a DOM; the panel imports it. The whole `frontend/`
   directory is served (the panel imports a sibling module), so a single-file
   static registration is not enough.
3. **Keep the shared contract in `const.py` consistent** with the JS: domain
   `ha_activity_exporter`, panel served at `/ha_activity_exporter/...`, web
   component tag `activity-exporter-panel`, sidebar path `activity-exporter`.
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
  `!= lu`). Timestamps are epoch seconds, not ISO. Fetch per day-chunk with
  `include_start_time_state` only on the first chunk to avoid duplicate boundary rows.
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

The `tests/test_init.py` suite calls `async_setup_entry`/`async_unload_entry`
directly (only `http` set up) so it stays fast and does not depend on the heavy
`frontend` component during unit tests.

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
  user-visible changes and tag releases (`vX.Y.Z`).
- Tracked in ticketgraph (project `ha-activity-exporter`) — snapshot at `.ai/TICKETS.md`.
