"""WebSocket commands the panel uses to list, describe and save kept details."""

from __future__ import annotations

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
import voluptuous as vol

from .const import (
    CONF_TRACKED,
    DOMAIN,
    WS_DETAIL_DESCRIBE,
    WS_DETAIL_LIST,
    WS_DETAIL_SAVE,
)
from .detail import describe, is_denied


def _loaded_entry(hass: HomeAssistant) -> ConfigEntry | None:
    """Return the loaded config entry, if any."""
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0] if entries else None


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register the detail commands."""
    websocket_api.async_register_command(hass, ws_detail_list)
    websocket_api.async_register_command(hass, ws_detail_describe)
    websocket_api.async_register_command(hass, ws_detail_save)


@websocket_api.websocket_command({vol.Required("type"): WS_DETAIL_LIST})
@callback
def ws_detail_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Send each tracked source with its mirror, chosen details and dropped details."""
    entry = _loaded_entry(hass)
    if entry is None:
        connection.send_result(msg["id"], [])
        return
    registry = er.async_get(hass)
    rows = []
    for source, chosen in entry.options.get(CONF_TRACKED, {}).items():
        mirror = entry.runtime_data.get(source)
        rows.append(
            {
                "source_entity_id": source,
                "mirror_entity_id": mirror.entity_id
                if mirror
                else registry.async_get_entity_id("sensor", DOMAIN, source),
                "attributes": list(chosen),
                "dropped": list(mirror.dropped) if mirror else [],
            }
        )
    connection.send_result(msg["id"], rows)


@websocket_api.websocket_command(
    {vol.Required("type"): WS_DETAIL_DESCRIBE, vol.Required("entity_id"): str}
)
@websocket_api.require_admin
@callback
def ws_detail_describe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Send the savable details of a source entity."""
    state = hass.states.get(msg["entity_id"])
    if state is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Unknown entity")
        return
    connection.send_result(msg["id"], describe(state))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_DETAIL_SAVE,
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("attributes"): [str],
    }
)
@websocket_api.require_admin
@callback
def ws_detail_save(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Save which details a source keeps; an empty list stops tracking it."""
    source = msg["entity_id"]
    attributes = msg["attributes"]
    if any(is_denied(name) for name in attributes):
        connection.send_error(
            msg["id"], websocket_api.ERR_INVALID_FORMAT, "Attribute cannot be saved"
        )
        return
    entry = _loaded_entry(hass)
    if entry is None:
        connection.send_error(
            msg["id"], "not_loaded", "Activity Exporter is not loaded"
        )
        return
    tracked = dict(entry.options.get(CONF_TRACKED, {}))
    if attributes:
        tracked[source] = list(attributes)
    else:
        tracked.pop(source, None)
        registry = er.async_get(hass)
        entity_id = registry.async_get_entity_id("sensor", DOMAIN, source)
        if entity_id:
            registry.async_remove(entity_id)
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_TRACKED: tracked}
    )
    connection.send_result(msg["id"])
