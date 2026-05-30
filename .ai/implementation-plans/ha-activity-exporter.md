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
