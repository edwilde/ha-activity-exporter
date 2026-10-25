# Panel harness

A mock Home Assistant page for checking the panel in a real browser. It is not
served by the integration and has no runtime dependencies.

## Run it

From the repository root:

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/tests/frontend/harness/index.html`.

## Query flags

| Flag | Effect |
|---|---|
| `theme=dark` | Dark colours. |
| `narrow=1` | Narrow layout, as on a phone. |
| `fail=<ws type>` | Every call of that WebSocket type throws, for example `fail=logbook/get_events`. |
| `picker=1` | Registers a stub `ha-entity-picker` (a native `<select>` inside). Without it the panel uses its text-input fallback. |
| `now=<epoch ms>` | Freezes `Date.now()` so the fixture data, the time range and the file names repeat exactly between loads. |
| `many=<n>` | Adds `n` extra sensors (`sensor.extra_01` and up) with 50 rows each, for the 20 device limit. |

## What it records

- `window.__calls` holds every WebSocket message the panel sent.
- `window.__exports` holds the text of every downloaded file, in order.
- `window.__hass` is the mock `hass` object.
