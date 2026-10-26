# Detail recording: design

Date: 2026-10-26. Supersedes the README's template-sensor workaround for lights.

## Problem

Home Assistant drops some attributes before they reach the recorder. Each entity
declares them itself: `State.state_info["unrecorded_attributes"]`, which the
recorder subtracts in `StateAttributes.shared_attrs_bytes_from_event`
(`recorder/db_schema.py`). Over 40 core domains do this (`light` brightness and
colour, `media_player` artwork, `camera` tokens, `sun` next times, `climate`,
`vacuum`, `input_*` limits and more). There is no setting to turn it off.

Today the only fix is a hand-written template sensor per entity in
`configuration.yaml`. That is too much for the target audience, and it only covers
lights in the README.

## Goal

From the panel, an admin chooses any entity and which of its details to keep. The
integration then saves those details from that moment on, and exports of that entity
include them as if Home Assistant had recorded them. No YAML.

## Approach

A **mirror entity** per chosen entity. It copies the source's value plus the chosen
details and declares no unrecorded attributes, so the recorder saves all of it. The
export folds the mirror's details back into the source's rows.

Rejected:

- **Patching the recorder** (monkeypatching `state_info` or the attribute filter):
  private internals, breaks across releases.
- **Own event store:** duplicates recorder retention/purging and needs a backend
  history endpoint.
- **Bare `hass.states.async_set` states:** no registry entry, orphaned in developer
  tools, gone until re-set after a restart.
- **Options flow as the main UI:** lives in Settings with HA wording, breaks the
  plain-language rule.

## Components

### Python

- `const.py`: options key `tracked` (`{source_entity_id: [attribute, ...]}`), the
  mirror attribute names (`source_entity_id`, `source_last_updated`), the hard
  denylist, and WS command names.
- `detail.py` (pure helpers, unit-tested without HA running):
  - `is_denied(name)`: true for `access_token`, `entity_picture`,
    `entity_picture_local`, anything matching `/token|secret|password|api_key/i`,
    the recorder's own `attribution`/`restored`/`supported_features`, and the keys
    the mirror sets itself (`friendly_name`, `icon`, `unit_of_measurement`,
    `device_class`, `state_class`, `source_entity_id`, `source_last_updated`).
  - `describe(state)`: for the tab, every current attribute with
    `{name, unrecorded, denied, volatile}`. `unrecorded` comes from
    `state.state_info` (empty when `None`; `MATCH_ALL` means every attribute).
  - `mirror_attributes(state, chosen)`: picks the chosen, non-denied attributes and,
    if the JSON is over the recorder's 16 384-byte cap, drops the largest until it
    fits (with headroom for the mirror's own keys). Returns `(attributes, dropped)`.
- `sensor.py`: `DetailMirror(SensorEntity)`, one per tracked source.
  - `_entity_component_unrecorded_attributes = frozenset()` so the `sensor` component's
    own exclusion of `options` does not apply (the combined set is rebuilt per subclass
    in `Entity.__init_subclass__`).
  - `_attr_entity_registry_visible_default = False` (hidden; the recorder ignores
    `hidden_by`). No device class, unit or state class, so no statistics.
  - `unique_id` = source entity_id; suggested object id
    `activity_exporter_<domain>_<object_id>`; name `<source name> (saved detail)`.
  - Listens with `async_track_state_change_event` on the source. On each event it
    builds `(state, mirrored attributes)` and writes **only when that pair changed**,
    adding `source_entity_id` and `source_last_updated` (the source's
    `last_updated_timestamp`). It writes once at startup from the current source state.
    A removed source writes `unavailable` with no details.
  - Value is the source's state string. `source_last_updated` lets the export join
    exactly, without guessing from timestamps that lag by a few milliseconds.
- `__init__.py`: forwards to the `sensor` platform and registers three WS commands
  once per process. The sensor platform's options listener adds, removes and
  updates mirrors in place when the tracked list changes, without reloading the
  entry:
  - `ha_activity_exporter/detail/list` (any user): `[{source_entity_id,
    mirror_entity_id, attributes, dropped}]`. The export needs it, and non-admins can
    export.
  - `ha_activity_exporter/detail/describe` (admin): `describe()` for one entity.
  - `ha_activity_exporter/detail/save` (admin): `{entity_id, attributes}`; an empty
    list stops recording and removes the mirror's registry entry (its past history
    stays until the recorder purges it). Denied names are rejected.

The architecture invariant becomes: **no backend history endpoint**. The Python side
now also holds a small config surface (one list, two admin commands), which is
metadata, not data.

### Frontend

- `exporter-core.js` (pure, Node-tested):
  - `mergeMirrorRecords(sourceRecords, mirrorRecords)`: each source row gets the
    details of the latest mirror row whose `source_last_updated` (seconds) is at or
    before the row's `timestampMs`. Mirror keys `source_entity_id` and
    `source_last_updated` are stripped. Source keys win on a clash (they were
    recorded). Rows before the first mirror row are unchanged.
  - If the source has **no rows** (excluded from recording) but the mirror has, the
    mirror's rows become the records (value from the mirror, details stripped of the
    mirror keys, `timestampMs` from `source_last_updated`).
  - `detailChoices(described)`: default ticks = unrecorded, not denied, not volatile.
    Volatile = the existing `VOLATILE_ATTRIBUTES` plus `next_*` names from `sun`.
- `activity-exporter-panel.js`:
  - Two tabs: **Export** (today's screen) and **Save more detail**, the second shown
    only when `hass.user.is_admin`.
  - Save-more-detail tab: a list of what is being saved (name, the details, Change,
    Stop saving), and an "Add" picker reusing the export picker / datalist fallback.
    After a pick it calls `describe` and shows checkboxes: details Home Assistant
    doesn't save (ticked by default), then details already saved (unticked), each
    with a plain label. Denied ones are not listed. Volatile ones carry "changes very
    often, uses more space". Nothing unrecorded → "Everything about this is already
    saved." Save calls `save`.
  - Export tab: when a chosen entity is not being saved in detail but loses details,
    a line "Some details of this aren't saved. Save more detail…" linking to the tab
    (admins only).
  - Export: fetch `detail/list` once per export; add mirror ids to the
    `history_during_period` request; merge before `normaliseRecords`/`attachCauses`.
    A failed `detail/list` falls back to today's export.

## Copy (plain language)

Never "entity", "attribute", "state", "recorder". Use "thing", "detail",
"saved", e.g. "Home Assistant doesn't keep these details. Choose which to save from
now on." and "Saved from 26 Oct 2026. Earlier history doesn't have them."

## Error handling

- WS failures in the tab: plain error message, nothing changes.
- Source renamed or removed: the mirror shows `unavailable`; the tab lists it with
  "Can't find this any more" and Stop saving.
- Over-cap details: listed in the tab as "Too large to save: …".

## Testing

- `tests/test_detail.py`: denylist, `describe` (with/without `state_info`,
  `MATCH_ALL`), `mirror_attributes` cap.
- `tests/test_sensor.py`: mirror writes on change only, carries
  `source_last_updated`, ignores denied keys, keeps `options`; options change
  adds/removes mirrors; hidden in the registry.
- `tests/test_websocket.py`: list/describe/save, admin gating, denied names rejected.
- `tests/test_init.py`: adjusted for the forwarded platform.
- `tests/frontend/exporter-core.test.mjs`: `mergeMirrorRecords`, excluded-source
  fallback, `detailChoices`.
- Every new test is mutation-checked.

## Decisions made without user input

The user was away and asked for best judgement. These were the choices:

1. Any entity, with details chosen per entity; unrecorded ones ticked by default.
2. Mirror is a hidden `sensor` with the `options` exclusion cleared, not bare states.
3. Mirror writes only on change and carries `source_last_updated` for an exact join.
4. Hard, non-overridable denylist for secrets; churny details unticked and flagged.
5. Over-cap details are dropped largest-first and reported, rather than losing all.
6. Tab and save/describe are admin-only; the list is readable by all users so their
   exports include the details.
7. An options change updates mirrors in place rather than reloading the entry, so the
   panel stays registered and back-to-back saves are never refused.
8. Source rename is not followed: the mirror goes `unavailable` and the user re-adds.
9. Version 1.3.0.
