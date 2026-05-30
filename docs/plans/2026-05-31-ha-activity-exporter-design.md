# HA Activity Exporter — Design

**Status:** Approved 2026-05-31
**Audience:** People who are **not** familiar with Home Assistant concepts or terminology.

## Purpose

A Home Assistant custom integration (distributed via HACS) that adds a **sidebar
panel** for exporting the history of a **single** device or sensor to **CSV** or
**JSON**. The primary use case is feeding that data to an LLM for analysis, so the
output must be logical and self-describing. We do **not** transform or aggregate the
data — we dump it faithfully, with an optional filter to remove no-change noise.

## Approved decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data source | **History** (`history/history_during_period` over WebSocket) | Raw state changes with attribute snapshots — richest data for analysis. |
| Time period | **Preset chips (24h / 7d / 30d) + custom start/end range** | Fast common cases, full control when needed. |
| Download | **Client-side Blob** | Uses the panel's authenticated `hass` WebSocket; no backend endpoint, no token handling. Matches HArvest / HA-Entity-Analyzer. |
| Frontend | **Single vanilla web component, no build step, no CDN runtime deps** | Robust on isolated/offline HA installs; trivial HACS install & release. |
| "Skip repeats" filter | **Client-side dedup**: keep a row only when the state *value* differs from the previous kept row | Predictable and transparent, independent of HA's internal "significant change" heuristic. |
| Copy | **Plain language, zero HA jargon** | Target users don't know "entity / state / recorder". This is a requirement, not a nice-to-have. |

## Architecture

Thin Python backend; all real work is client-side in the panel.

```
ha-activity-exporter/
├── hacs.json
├── README.md · LICENSE · .gitignore
├── .github/workflows/validate.yml        # hassfest + HACS validation + tests
├── tests/
│   ├── test_init.py · test_config_flow.py # pytest-homeassistant-custom-component
│   └── frontend/*.test.mjs               # node --test of pure functions
└── custom_components/ha_activity_exporter/
    ├── manifest.json     # deps: http, frontend, panel_custom
    ├── __init__.py       # async_setup_entry: static path + register panel; unload: remove panel
    ├── config_flow.py    # single-instance "click to add" flow
    ├── const.py · strings.json · translations/en.json
    └── frontend/
        └── activity-exporter-panel.js    # the single vanilla web component
```

### Shared contract (must stay consistent across files)

- **Domain:** `ha_activity_exporter`
- **JS served at:** `/ha_activity_exporter/activity-exporter-panel.js`
- **Web component tag / `webcomponent_name`:** `activity-exporter-panel`
- **Sidebar URL path (`frontend_url_path`):** `activity-exporter`
- **Sidebar title / icon:** "Activity Exporter" / `mdi:file-export-outline`
- **Normalised record shape:** `{ timestamp: <ISO8601 with tz offset>, state: <string>, attributes: <object> }`
- **Pure functions (exported for tests):** `filterStateChanges(records)`, `chunkRangeByDay(startISO, endISO)`, `toCsv(records)`, `toJson(meta, records)`, `sanitizeFilename(s)`

## Backend (Python — minimal)

- `async_setup_entry`:
  1. `await hass.http.async_register_static_paths([StaticPathConfig("/ha_activity_exporter/activity-exporter-panel.js", <abs path>, False)])`
     — note: `register_static_path` is deprecated and removed in 2025.7; must use the async variant.
  2. `await panel_custom.async_register_panel(hass, webcomponent_name="activity-exporter-panel", frontend_url_path="activity-exporter", module_url="/ha_activity_exporter/activity-exporter-panel.js", sidebar_title="Activity Exporter", sidebar_icon="mdi:file-export-outline", require_admin=False, config={})`
- `async_unload_entry`: `frontend.async_remove_panel(hass, "activity-exporter")`.
- `config_flow.py`: single-instance flow — one confirmation step, `async_abort` if already configured. No user-facing settings.

## Frontend (vanilla web component)

Receives `hass`, `narrow`, `panel` properties from HA. `ha-card` layout themed with
HA CSS variables (`--primary-color`, `--card-background-color`, `--primary-text-color`,
`--secondary-text-color`, `--divider-color`). Responsive (honours `narrow`).

### UX flow

1. **Intro line** — "Export the history of any device or sensor to a file you can open or analyse."
2. **What to export** — `ha-entity-picker` (searchable, themed) with a plain `<select>` fallback. Helper: "Pick a device or sensor — like a light, thermostat, or door."
3. **Time period** — preset chips (Last 24 hours / Last 7 days / Last 30 days) + "Or choose your own dates" start/end inputs.
4. **Skip repeats** — toggle "Skip repeats — only show when something actually changed", helper "Keeps your file clean by leaving out rows where nothing changed."
5. **Export** — two buttons: "Download spreadsheet (CSV)" (note: opens in Excel/Sheets) and "Download data file (JSON)" (note: best for feeding to an AI).
6. **Progress** — fetch is chunked by day; progress shown as "Gathering history… N%".

### Data fetch

`hass.callWS({ type: "history/history_during_period", start_time, end_time, entity_ids: [id], significant_changes_only: false, minimal_response: false, no_attributes: false })`, issued per day-chunk and concatenated. Timestamps use HA's configured timezone. The "skip repeats" filter is applied client-side after fetch.

### Output formats

**JSON** — metadata wrapper:
```json
{
  "entity_id": "binary_sensor.front_door",
  "friendly_name": "Front Door",
  "exported_at": "2026-05-31T10:00:00+12:00",
  "period": { "start": "...", "end": "..." },
  "state_changes_only": true,
  "record_count": 42,
  "records": [ { "timestamp": "ISO8601", "state": "on", "attributes": {} } ]
}
```

**CSV** — flat, RFC-4180 quoted: columns `timestamp,state,attributes` where `attributes`
is a compact JSON string (stable when attribute keys vary).

Filename: `{entity_id}_{start}_{end}.{csv|json}`, sanitised.

## Error handling / edge cases (plain language)

- No history found → "Home Assistant may not be recording this item, or there was no activity in this period."
- Nothing selected → export buttons disabled.
- Invalid range (end ≤ start) → inline message.
- WebSocket error → friendly retry message, no raw codes.
- Very large result → soft warning before download.

## Testing (real-HA testing is limited)

- **Python:** `pytest-homeassistant-custom-component` — setup registers static path + panel, unload removes panel, config flow is single-instance.
- **Frontend:** pure functions exported and unit-tested with `node --test` (no build).
- **CI:** GitHub Actions — `hassfest` + `hacs/action` + run both test suites. Green CI gates releases.
- **Manual:** README checklist for a real HA instance.

## References

- Creating custom panels — https://developers.home-assistant.io/docs/frontend/custom-ui/creating-custom-panels/
- `async_register_static_paths` — https://developers.home-assistant.io/blog/2024/06/18/async_register_static_paths/
- History WebSocket API — https://github.com/home-assistant/core/blob/dev/homeassistant/components/history/websocket_api.py
- HACS integration publishing — https://www.hacs.xyz/docs/publish/integration/
- Inspiration: HArvest, HA-Entity-Analyzer, history-explorer-card
