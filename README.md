# Activity Exporter for Home Assistant

Export the history of any single device or sensor to a **CSV** or **JSON** file —
straight from a panel in your Home Assistant sidebar. No configuration, no scripting.

It's built for one job: getting a clean, faithful dump of one thing's history out of
Home Assistant so you can open it in a spreadsheet or hand it to an AI for analysis.

> **Designed for everyone.** You don't need to know any Home Assistant jargon to use
> it. Pick a thing, pick a time period, click download.

![The Activity Exporter panel in the Home Assistant sidebar](docs/images/activity-exporter-panel.jpg)

## What it does

- 🔎 **Pick one device or sensor** with a searchable selector.
- 🗓️ **Choose a time period** — quick buttons (last 24 hours / 7 days / 30 days) or your own start and end dates.
- 🎚️ **Every setting in its own column** - brightness, colour, temperature, position and more each get a column in the spreadsheet, and every recorded step is included, so you can see exactly what a device did and when.
- 🧹 **Skip repeats** - an optional switch that leaves out rows where neither the value nor any setting changed, so your file isn't full of noise.
- 📊 **Download as a spreadsheet (CSV)** — opens in Excel, Numbers, or Google Sheets.
- 🤖 **Download as a data file (JSON)** — self-describing, ideal for feeding to an LLM.
- ⏳ **Live progress** while it gathers the history.

It does **not** change, summarise, or interpret your data. It exports the history
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
4. Leave **Give each setting its own column** on to get one spreadsheet column per setting (brightness, colour, temperature and so on), or turn it off for a simple three-column file.
5. Optionally turn on **Skip repeats** to leave out rows where nothing changed.
6. Click **Download spreadsheet (CSV)** or **Download data file (JSON)**.

## What the files look like

**CSV** - one row each time Home Assistant recorded a change, including changes to a setting while the value stays the same. `seconds_since_previous` is the time since the row above it, and each setting has its own column. Descriptive information such as the name, icon, units and supported modes is left out of the columns; `details` holds anything that could not get a column.

```csv
timestamp,value,seconds_since_previous,brightness,brightness_percent,color_mode,hue,saturation,red,green,blue,x,y,details
2026-05-30T06:30:00+12:00,on,,26,10.2,hs,30,80,255,170,51,0.55,0.39,
2026-05-30T06:30:30+12:00,on,30,51,20,hs,30,70,255,189,77,0.5,0.39,
2026-05-30T06:31:00+12:00,on,30,77,30.2,hs,30,60,255,204,102,0.46,0.39,
```

With **Give each setting its own column** turned off, the header is `timestamp,value,details` and `details` holds all the extra information as compact JSON.

When Home Assistant knows what caused a change, the spreadsheet gains a `changed_by` column just before `details`. It names the script, automation, action or person behind an on/off style change, for example `script.weekend_sunrise (Weekend sunrise)` or `light.turn_on`. A person is shown by name when they are set up in Home Assistant as a person with a user account, otherwise by an id such as `user 3f2a...`. In the JSON file the same information appears as a `cause` entry on that row. The column is left out of the spreadsheet when none of the rows has a cause, and it does not appear when each setting's own column is turned off.

**JSON** - a self-describing wrapper so an LLM has all the context it needs. `entity` describes the device, and each record has a `derived` block with values worked out for you, such as whether the value itself changed and the seconds since the previous row (shown here for two records):

```json
{
  "entity_id": "light.bedroom_lamp",
  "friendly_name": "Bedroom Lamp",
  "entity": {
    "entity_id": "light.bedroom_lamp",
    "friendly_name": "Bedroom Lamp",
    "domain": "light",
    "capabilities": {
      "friendly_name": "Bedroom Lamp",
      "supported_color_modes": [
        "hs"
      ]
    }
  },
  "exported_at": "2026-05-30T07:00:00+12:00",
  "period": {
    "start": "2026-05-30T06:00:00+12:00",
    "end": "2026-05-30T07:00:00+12:00"
  },
  "state_changes_only": false,
  "record_count": 2,
  "records": [
    {
      "timestamp": "2026-05-30T06:30:00+12:00",
      "state": "on",
      "attributes": {
        "friendly_name": "Bedroom Lamp",
        "supported_color_modes": [
          "hs"
        ],
        "color_mode": "hs",
        "brightness": 26,
        "hs_color": [
          30,
          80
        ]
      },
      "derived": {
        "state_changed": true,
        "seconds_since_previous": null,
        "brightness_percent": 10.2
      }
    },
    {
      "timestamp": "2026-05-30T06:30:30+12:00",
      "state": "on",
      "attributes": {
        "friendly_name": "Bedroom Lamp",
        "supported_color_modes": [
          "hs"
        ],
        "color_mode": "hs",
        "brightness": 51,
        "hs_color": [
          30,
          70
        ]
      },
      "derived": {
        "state_changed": false,
        "seconds_since_previous": 30,
        "brightness_percent": 20
      }
    }
  ]
}
```

`state_changes_only` is `true` when **Skip repeats** was on. With it on, `seconds_since_previous` is the time since the previous row in the file, so it spans any rows that were left out.

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
- `changed_by` is blank for steps that only change a setting (brightness, colour), because Home Assistant only notes what caused a change of value. It is also blank for sensors that report a unit, which Home Assistant leaves out of its activity log.

## Development & testing

Real Home Assistant testing is intentionally light; correctness is guarded by tests + CI.

```bash
# Frontend pure-function tests (no build step required)
node --test tests/frontend/*.test.mjs

# Python tests
pip install -r requirements_test.txt
# The frontend asset package isn't pulled in by the test helper; install the
# version Home Assistant core pins so the frontend component can set up:
pip install -c "$(python -c 'import os,homeassistant;print(os.path.join(os.path.dirname(homeassistant.__file__),"package_constraints.txt"))')" home-assistant-frontend
pytest
```

CI runs Home Assistant's `hassfest`, HACS validation, and both test suites on every push.

## License

[MIT](LICENSE)
