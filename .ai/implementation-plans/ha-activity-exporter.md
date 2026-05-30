# Implementation Plan — HA Activity Exporter

Design: `docs/plans/2026-05-31-ha-activity-exporter-design.md`
Tickets: ticketgraph project `ha-activity-exporter` (`hae-1`..`hae-17`)

## Execution order & verification

| # | Ticket | Deliverable | Verify |
|---|---|---|---|
| 1 | hae-2 | git repo, GitHub remote `edwilde/ha-activity-exporter`, LICENSE, README, .gitignore, hacs.json | `gh repo view` ok; first commit pushed |
| 2 | hae-3 | manifest.json, const.py, config_flow.py (single-instance), __init__ skeleton, strings/translations | hassfest passes (CI); config-flow test |
| 3 | hae-4 | panel registration (static path + panel_custom), removal on unload | unit test asserts registration/removal |
| 4 | hae-5 | frontend shell: vanilla component, theming, intro copy, responsive | renders; no CDN imports |
| 5 | hae-6 | entity picker + fallback, plain label | pure-fn/selection logic testable |
| 6 | hae-7 | period presets + custom range | range→ISO conversion test |
| 7 | hae-9 | chunked WS fetch + progress | `chunkRangeByDay` unit test |
| 8 | hae-8 | skip-repeats client-side dedup | `filterStateChanges` unit test |
| 9 | hae-10 | CSV formatter + Blob download | `toCsv` escaping unit test |
| 10 | hae-11 | JSON formatter + Blob download | `toJson` shape unit test |
| 11 | hae-12 | error handling / edge cases | manual + logic checks |
| 12 | hae-13 | plain-language + a11y pass | jargon audit; aria labels |
| 13 | hae-14 | python tests | `pytest` green (CI) |
| 14 | hae-15 | frontend pure-fn tests | `node --test` green |
| 15 | hae-16 | CI workflow (hassfest + HACS + tests) | workflow file valid |
| 16 | hae-17 | README + manual test checklist | docs complete |

## Strategy

Tightly-coupled greenfield repo → single-author implementation pass for consistency
(shared contract in the design doc), then **fan-out adversarial review** (ultracode):
HA-API correctness, JS correctness, UX/jargon, a11y, security, HACS compliance, test
adequacy. Fix findings, run test suites, then `review-implementation` against this plan.

Commit per logical milestone; push to remote throughout.

## Built vs intended (Stage 4 — review-implementation)

All 17 tickets delivered and pushed. A 6-dimension adversarial review (with
per-finding skeptical verification) produced 22 confirmed findings, all fixed.
Final state: **CI fully green** — Hassfest, HACS validation, Frontend (27 node
tests), and Python (5 pytest) all pass on GitHub Actions.

Deviations from the original design, and why:

- **CSV headers** changed from `timestamp,state,attributes` to
  `timestamp,value,details`. Reason: the audience is non-technical, so the
  human-facing spreadsheet avoids HA jargon. The JSON payload keeps the faithful
  `state`/`attributes` keys as a stable machine schema for LLMs.
- **Custom date range** is now interpreted in the **Home Assistant** time zone
  (new pure `computeRange`/`wallClockToEpochMs` in `exporter-core.js`), not the
  browser's, so the queried window matches the exported timestamps when the two
  zones differ. This was a latent correctness bug caught in review.
- **Single-instance** is handled solely by `single_config_entry: true` in the
  manifest (core aborts the second flow and hides "Add"); the manual guard and
  custom abort string were removed as dead/never-shown code.
- **manifest.json key order** must be `domain, name, then alphabetical` or
  hassfest fails — fixed (confirmed against the actual CI failure).
- **CSV formula-injection** guard added (`= + - @` etc. prefixed) — not in the
  original design but a real spreadsheet-safety issue.
- **Test environment**: `home-assistant-frontend` (the `hass_frontend` asset
  package) is not pulled in by `pytest-homeassistant-custom-component`; CI and
  the README install the version HA core pins so the `frontend` component can
  set up. The `test_init` suite calls `async_setup_entry` directly (only `http`
  needed) to stay fast/deterministic.
- **Repo config**: HACS validation requires GitHub repository **topics** — added
  (`home-assistant`, `hacs`, `homeassistant`, `home-automation`,
  `home-assistant-integration`). Brand assets (icon/logo) still need a separate
  PR to `home-assistant/brands` before public HACS listing (HACS `brands` check
  is intentionally ignored in CI until then).

Not done by design (out of scope for MVP): multi-entity export, server-side
streaming for very large ranges, and a real-HA screenshot in the README.
