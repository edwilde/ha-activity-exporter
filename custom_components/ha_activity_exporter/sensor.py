"""Hidden mirror sensors that save attributes the recorder drops."""

from __future__ import annotations

from collections.abc import Collection
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import (
    Event,
    EventStateChangedData,
    HomeAssistant,
    State,
    callback,
)
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import ATTR_SOURCE_ENTITY_ID, ATTR_SOURCE_LAST_UPDATED, CONF_TRACKED
from .detail import mirror_attributes


def _display_name(hass: HomeAssistant, source_entity_id: str) -> str:
    """Name a source by its friendly name, falling back to its id."""
    state = hass.states.get(source_entity_id)
    friendly = state.attributes.get("friendly_name") if state else None
    return friendly or source_entity_id


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add one mirror sensor for each tracked source."""
    tracked: dict[str, list[str]] = entry.options.get(CONF_TRACKED, {})
    mirrors = {
        source: DetailMirror(source, chosen, _display_name(hass, source))
        for source, chosen in tracked.items()
    }
    entry.runtime_data.update(mirrors)
    async_add_entities(mirrors.values())

    async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Bring the mirrors in line with the saved options."""
        await _sync_mirrors(hass, entry, async_add_entities)

    entry.async_on_unload(entry.add_update_listener(_options_updated))


async def _sync_mirrors(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add, remove or update mirrors so they match the tracked options."""
    tracked: dict[str, list[str]] = entry.options.get(CONF_TRACKED, {})
    mirrors: dict[str, DetailMirror] = entry.runtime_data
    dropped = [mirrors.pop(source) for source in set(mirrors) - set(tracked)]
    added = [
        DetailMirror(source, chosen, _display_name(hass, source))
        for source, chosen in tracked.items()
        if source not in mirrors
    ]
    mirrors.update({mirror.source_entity_id: mirror for mirror in added})
    for source, chosen in tracked.items():
        mirrors[source].async_set_chosen(chosen)
    if added:
        async_add_entities(added)
    for mirror in dropped:
        await mirror.async_remove(force_remove=True)


class DetailMirror(SensorEntity):
    """A hidden sensor that copies a source's state and its chosen attributes."""

    _attr_should_poll = False
    _attr_has_entity_name = False
    _attr_entity_registry_visible_default = False
    # Sensor marks `options` as unrecorded; a mirror must record everything it carries.
    _entity_component_unrecorded_attributes = frozenset()

    def __init__(
        self, source_entity_id: str, chosen: Collection[str], name: str
    ) -> None:
        """Create a mirror for a source and the attributes to save from it."""
        self.source_entity_id = source_entity_id
        self.chosen = list(chosen)
        self.dropped: list[str] = []
        self._applied: tuple[str, dict[str, Any]] | None = None
        domain, object_id = source_entity_id.split(".", 1)
        self._attr_unique_id = source_entity_id
        self._attr_name = f"{name} (saved detail)"
        self.entity_id = f"sensor.activity_exporter_{domain}_{object_id}"

    async def async_added_to_hass(self) -> None:
        """Follow the source and apply its current state."""
        self.async_on_remove(
            async_track_state_change_event(
                self.hass, [self.source_entity_id], self._handle_source_event
            )
        )
        self._apply(self.hass.states.get(self.source_entity_id))

    @callback
    def async_set_chosen(self, chosen: Collection[str]) -> None:
        """Save a new list of attributes and re-copy the source with it."""
        chosen = list(chosen)
        if chosen == self.chosen:
            return
        self.chosen = chosen
        if self.hass is not None:
            self._applied = None
            self._apply(self.hass.states.get(self.source_entity_id))

    @callback
    def _handle_source_event(self, event: Event[EventStateChangedData]) -> None:
        """Apply the source's new state."""
        self._apply(event.data["new_state"])

    @callback
    def _apply(self, source: State | None) -> None:
        """Copy the source state, writing only when the saved value or details changed."""
        if source is None:
            value, kept, dropped = STATE_UNAVAILABLE, {}, []
            updated = dt_util.utcnow().timestamp()
        else:
            value = source.state
            kept, dropped = mirror_attributes(source.attributes, self.chosen)
            updated = source.last_updated_timestamp
        if self._applied == (value, kept):
            return
        self._applied = (value, kept)
        self.dropped = dropped
        self._attr_native_value = value
        self._attr_extra_state_attributes = {
            **kept,
            ATTR_SOURCE_ENTITY_ID: self.source_entity_id,
            ATTR_SOURCE_LAST_UPDATED: updated,
        }
        self.async_write_ha_state()
