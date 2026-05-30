# Activity Exporter for Home Assistant

Export the history of any single device or sensor to a **CSV** or **JSON** file —
straight from a panel in your Home Assistant sidebar. No configuration, no scripting.

It's built for one job: getting a clean, faithful dump of one thing's history out of
Home Assistant so you can open it in a spreadsheet or hand it to an AI for analysis.

> **Designed for everyone.** You don't need to know any Home Assistant jargon to use
> it. Pick a thing, pick a time period, click download.

## What it does

- 🔎 **Pick one device or sensor** with a searchable selector.
- 🗓️ **Choose a time period** — quick buttons (last 24 hours / 7 days / 30 days) or your own start and end dates.
- 🧹 **Skip repeats** — an optional switch that leaves out rows where nothing actually changed, so your file isn't full of noise.
- 📊 **Download as a spreadsheet (CSV)** — opens in Excel, Numbers, or Google Sheets.
- 🤖 **Download as a data file (JSON)** — self-describing, ideal for feeding to an LLM.
- ⏳ **Live progress** while it gathers the history.

It does **not** change, summarise, or interpret your data. It dumps exactly what
Home Assistant recorded (optionally minus the repeats).

## Installation

### Via HACS (recommended)

1. In Home Assistant, open **HACS → Integrations**.
2. Click the **⋮** menu (top-right) → **Custom repositories**.
3. Add `https://github.com/edwilde/ha-activity-exporter` with category **Integration**.
4. Find **Activity Exporter** in the list and click **Download**.
5. **Restart Home Assistant.**
6. Go to **Settings → Devices & Services → Add Integration**, search for
   **Activity Exporter**, and add it.
7. **Activity Exporter** now appears in your sidebar.

### Manual

1. Copy `custom_components/ha_activity_exporter/` into your Home Assistant
   `config/custom_components/` folder.
2. Restart Home Assistant and add the integration as in steps 5–7 above.

## Using it

1. Open **Activity Exporter** from the sidebar.
2. **What do you want to export?** — start typing the name of a device or sensor and pick it.
3. **Time period** — tap a quick button, or choose your own start and end dates.
4. Optionally turn on **Skip repeats** to leave out no-change rows.
5. Click **Download spreadsheet (CSV)** or **Download data file (JSON)**.

## What the files look like

**CSV** — one row per recorded change:

```csv
timestamp,state,attributes
2026-05-30T08:01:12+12:00,on,"{""friendly_name"":""Front Door"",""device_class"":""door""}"
2026-05-30T08:04:55+12:00,off,"{""friendly_name"":""Front Door"",""device_class"":""door""}"
```

**JSON** — a self-describing wrapper so an LLM has all the context it needs:

```json
{
  "entity_id": "binary_sensor.front_door",
  "friendly_name": "Front Door",
  "exported_at": "2026-05-31T10:00:00+12:00",
  "period": { "start": "2026-05-30T00:00:00+12:00", "end": "2026-05-31T00:00:00+12:00" },
  "state_changes_only": true,
  "record_count": 2,
  "records": [
    { "timestamp": "2026-05-30T08:01:12+12:00", "state": "on", "attributes": { "friendly_name": "Front Door", "device_class": "door" } },
    { "timestamp": "2026-05-30T08:04:55+12:00", "state": "off", "attributes": { "friendly_name": "Front Door", "device_class": "door" } }
  ]
}
```

## How it works (for the curious)

The panel runs entirely in your browser, using your existing Home Assistant login.
It reads history over Home Assistant's WebSocket API (`history/history_during_period`),
builds the file in your browser, and downloads it directly. Nothing is sent anywhere
else, and no extra server endpoints are added. Large date ranges are fetched a day at
a time so you get a real progress bar.

## Limitations

- Exports **one** device or sensor at a time (by design — keeps files focused).
- Only covers history that Home Assistant has actually recorded. If a thing is
  excluded from recording, or the range predates your retention period, there will be
  nothing to export.
- The whole result is assembled in your browser, so extremely long ranges of a very
  chatty sensor may be slow.

## Development & testing

Real Home Assistant testing is intentionally light; correctness is guarded by tests + CI.

```bash
# Frontend pure-function tests (no build step required)
node --test tests/frontend

# Python tests
pip install -r requirements_test.txt
pytest
```

CI runs Home Assistant's `hassfest`, HACS validation, and both test suites on every push.

### Manual test checklist (on a real HA instance)

- [ ] Integration installs and a single "Activity Exporter" entry appears in the sidebar.
- [ ] Re-adding the integration is prevented (single instance).
- [ ] Entity selector searches and shows friendly names.
- [ ] Each preset (24h / 7d / 30d) and a custom range produce sensible results.
- [ ] "Skip repeats" reduces the row count and only drops no-change rows.
- [ ] CSV opens cleanly in a spreadsheet; commas/quotes in attributes are intact.
- [ ] JSON parses and contains the metadata wrapper.
- [ ] An entity with no history shows the friendly "No history found" message.
- [ ] Removing the integration removes the sidebar panel.

## License

[MIT](LICENSE)
