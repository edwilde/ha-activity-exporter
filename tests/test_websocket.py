"""Tests for the WebSocket commands that list, describe and save kept details."""

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.ha_activity_exporter.const import (
    CONF_TRACKED,
    DOMAIN,
    WS_DETAIL_DESCRIBE,
    WS_DETAIL_LIST,
    WS_DETAIL_SAVE,
)

LAMP = "light.lamp"
FAN = "fan.desk"
MIRROR = "sensor.activity_exporter_light_lamp"
UNRECORDED = {"unrecorded_attributes": frozenset({"brightness"})}


async def _setup(
    hass: HomeAssistant, tracked: dict[str, list[str]] | None = None
) -> MockConfigEntry:
    """Set up the integration with the lamp present and the given tracked options."""
    assert await async_setup_component(hass, "http", {})
    hass.states.async_set(
        LAMP,
        "on",
        {"brightness": 120, "color_mode": "hs", "friendly_name": "Lamp"},
        state_info=UNRECORDED,
    )
    entry = MockConfigEntry(
        domain=DOMAIN,
        options={CONF_TRACKED: {LAMP: ["brightness"]} if tracked is None else tracked},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _call(client: Any, command: str, **payload: Any) -> dict[str, Any]:
    """Send a command over the socket and return the raw response."""
    await client.send_json_auto_id({"type": command, **payload})
    return await client.receive_json()


async def test_list_returns_the_tracked_mirror(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """List reports each tracked source with its mirror, details and drops."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    response = await _call(client, WS_DETAIL_LIST)

    assert response["success"]
    assert response["result"] == [
        {
            "source_entity_id": LAMP,
            "mirror_entity_id": MIRROR,
            "attributes": ["brightness"],
            "dropped": [],
        }
    ]


async def test_list_falls_back_to_the_registry_without_a_runtime_mirror(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """A tracked source with no runtime mirror is listed from the registry, with no drops."""
    entry = await _setup(hass)
    del entry.runtime_data[LAMP]
    client = await hass_ws_client(hass)

    found = await _call(client, WS_DETAIL_LIST)
    er.async_get(hass).async_remove(MIRROR)
    missing = await _call(client, WS_DETAIL_LIST)

    expected = {
        "source_entity_id": LAMP,
        "attributes": ["brightness"],
        "dropped": [],
    }
    assert found["result"] == [{**expected, "mirror_entity_id": MIRROR}]
    assert missing["result"] == [{**expected, "mirror_entity_id": None}]


async def test_list_is_empty_without_a_loaded_entry(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """With no loaded entry, list returns an empty list."""
    entry = await _setup(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    client = await hass_ws_client(hass)

    response = await _call(client, WS_DETAIL_LIST)

    assert response["success"]
    assert response["result"] == []


async def test_list_is_readable_by_a_non_admin(
    hass: HomeAssistant,
    hass_ws_client: ClientSessionGenerator,
    hass_read_only_access_token: str,
) -> None:
    """A non-admin user can list the kept details."""
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)

    response = await _call(client, WS_DETAIL_LIST)

    assert response["success"]
    assert len(response["result"]) == 1


async def test_describe_returns_unrecorded_flags(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Describe lists the source's details with the unrecorded ones flagged."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    response = await _call(client, WS_DETAIL_DESCRIBE, entity_id=LAMP)

    assert response["success"]
    assert response["result"] == {
        "entity_id": LAMP,
        "name": "Lamp",
        "details": [
            {"name": "brightness", "unrecorded": True, "volatile": False},
            {"name": "color_mode", "unrecorded": False, "volatile": False},
        ],
    }


async def test_describe_unknown_entity_is_not_found(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Describe reports not_found for an entity with no state."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    response = await _call(client, WS_DETAIL_DESCRIBE, entity_id="light.missing")

    assert not response["success"]
    assert response["error"]["code"] == "not_found"


async def test_describe_works_without_a_loaded_entry(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Describe needs no config entry, only the source state."""
    entry = await _setup(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    client = await hass_ws_client(hass)

    response = await _call(client, WS_DETAIL_DESCRIBE, entity_id=LAMP)

    assert response["success"]
    assert response["result"]["entity_id"] == LAMP


async def test_describe_is_refused_for_a_non_admin(
    hass: HomeAssistant,
    hass_ws_client: ClientSessionGenerator,
    hass_read_only_access_token: str,
) -> None:
    """A non-admin user cannot describe an entity."""
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)

    response = await _call(client, WS_DETAIL_DESCRIBE, entity_id=LAMP)

    assert not response["success"]
    assert response["error"]["code"] == "unauthorized"


async def test_save_adds_then_empty_list_removes_the_source(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Saving names sets the option; saving none removes it and the registry entry."""
    entry = await _setup(hass)
    client = await hass_ws_client(hass)

    response = await _call(
        client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=["brightness", "color_mode"]
    )
    await hass.async_block_till_done()

    assert response["success"]
    assert entry.options[CONF_TRACKED] == {LAMP: ["brightness", "color_mode"]}
    registry = er.async_get(hass)
    assert registry.async_get_entity_id("sensor", DOMAIN, LAMP) == MIRROR

    response = await _call(client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=[])
    await hass.async_block_till_done()

    assert response["success"]
    assert entry.options[CONF_TRACKED] == {}
    assert registry.async_get_entity_id("sensor", DOMAIN, LAMP) is None
    assert hass.states.get(MIRROR) is None


async def test_save_keeps_other_sources_when_changing_one(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Saving one source leaves the other tracked sources untouched."""
    entry = await _setup(hass, {LAMP: ["brightness"], FAN: ["speed"]})
    client = await hass_ws_client(hass)

    await _call(client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=[])
    await hass.async_block_till_done()

    assert entry.options[CONF_TRACKED] == {FAN: ["speed"]}


async def test_save_rejects_a_denied_name(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Saving a credential-like attribute fails with invalid_format and changes nothing."""
    entry = await _setup(hass)
    client = await hass_ws_client(hass)

    response = await _call(
        client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=["brightness", "access_token"]
    )

    assert not response["success"]
    assert response["error"]["code"] == "invalid_format"
    assert entry.options[CONF_TRACKED] == {LAMP: ["brightness"]}


async def test_save_without_a_loaded_entry_is_not_loaded(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Save reports not_loaded when the integration has no loaded entry."""
    entry = await _setup(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    client = await hass_ws_client(hass)

    response = await _call(
        client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=["brightness"]
    )

    assert not response["success"]
    assert response["error"]["code"] == "not_loaded"


async def test_save_is_refused_for_a_non_admin(
    hass: HomeAssistant,
    hass_ws_client: ClientSessionGenerator,
    hass_read_only_access_token: str,
) -> None:
    """A non-admin user cannot change which details are kept."""
    entry = await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)

    response = await _call(
        client, WS_DETAIL_SAVE, entity_id=LAMP, attributes=["color_mode"]
    )

    assert not response["success"]
    assert response["error"]["code"] == "unauthorized"
    assert entry.options[CONF_TRACKED] == {LAMP: ["brightness"]}


async def test_save_rejects_a_malformed_request(
    hass: HomeAssistant, hass_ws_client: ClientSessionGenerator
) -> None:
    """Save validates the entity id and the attribute list."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    bad_id = await _call(client, WS_DETAIL_SAVE, entity_id="Not An Id", attributes=[])
    bad_list = await _call(client, WS_DETAIL_SAVE, entity_id=LAMP, attributes="brightness")

    assert bad_id["error"]["code"] == "invalid_format"
    assert bad_list["error"]["code"] == "invalid_format"
