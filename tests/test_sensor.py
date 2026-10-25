"""Tests for the hidden mirror sensors that save attributes the recorder drops."""

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_activity_exporter.const import CONF_TRACKED, DOMAIN

LAMP = "light.lamp"
MIRROR = "sensor.activity_exporter_light_lamp"
UNRECORDED = {"unrecorded_attributes": frozenset({"brightness"})}


def _set_lamp(hass: HomeAssistant, state: str = "on", **attributes: object) -> None:
    """Set the source light's state the way the recorder would see it."""
    hass.states.async_set(LAMP, state, attributes, state_info=UNRECORDED)


async def _setup(
    hass: HomeAssistant, tracked: dict[str, list[str]] | None = None
) -> ConfigEntry:
    """Set up the integration with tracked options and the lamp already present."""
    assert await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN,
        options={CONF_TRACKED: tracked or {LAMP: ["brightness", "options"]}},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_mirror_copies_state_and_chosen_details(hass: HomeAssistant) -> None:
    """The mirror shows the source state with only the chosen attributes."""
    _set_lamp(
        hass, brightness=120, options=["a", "b"], color_mode="hs", friendly_name="Lamp"
    )
    await _setup(hass)

    mirror = hass.states.get(MIRROR)
    assert mirror.state == "on"
    assert mirror.attributes["brightness"] == 120
    assert mirror.attributes["options"] == ["a", "b"]
    assert "color_mode" not in mirror.attributes
    assert mirror.attributes["source_entity_id"] == LAMP
    assert mirror.attributes["friendly_name"] == "Lamp (saved detail)"


async def test_mirror_names_a_source_without_friendly_name_by_its_id(
    hass: HomeAssistant,
) -> None:
    """A source with no friendly name is named by its entity id."""
    _set_lamp(hass, brightness=1)
    await _setup(hass)

    assert hass.states.get(MIRROR).attributes["friendly_name"] == (
        "light.lamp (saved detail)"
    )


async def test_source_last_updated_is_the_sources_timestamp(
    hass: HomeAssistant,
) -> None:
    """The mirror records when the source itself was last updated."""
    _set_lamp(hass, brightness=120)
    await _setup(hass)
    hass.states.async_set(LAMP, "on", {"brightness": 130}, state_info=UNRECORDED)
    await hass.async_block_till_done()

    source = hass.states.get(LAMP)
    mirror = hass.states.get(MIRROR)
    assert mirror.attributes["source_last_updated"] == source.last_updated_timestamp


async def test_unchosen_attribute_change_does_not_write_the_mirror(
    hass: HomeAssistant,
) -> None:
    """A source change touching only an unchosen attribute leaves the mirror alone."""
    _set_lamp(hass, brightness=120, color_mode="hs")
    await _setup(hass)
    before = hass.states.get(MIRROR)

    _set_lamp(hass, brightness=120, color_mode="xy")
    await hass.async_block_till_done()

    after = hass.states.get(MIRROR)
    assert after.last_updated == before.last_updated
    assert after.attributes["source_last_updated"] == (
        before.attributes["source_last_updated"]
    )


async def test_chosen_attribute_change_writes_the_mirror(hass: HomeAssistant) -> None:
    """A change to a chosen attribute produces a new mirror state."""
    _set_lamp(hass, brightness=120)
    await _setup(hass)
    before = hass.states.get(MIRROR)

    _set_lamp(hass, brightness=130)
    await hass.async_block_till_done()

    after = hass.states.get(MIRROR)
    assert after.attributes["brightness"] == 130
    assert after.last_updated > before.last_updated


async def test_state_change_writes_the_mirror(hass: HomeAssistant) -> None:
    """A change to the source state itself produces a new mirror state."""
    _set_lamp(hass, "on", brightness=120)
    await _setup(hass)

    _set_lamp(hass, "off", brightness=120)
    await hass.async_block_till_done()

    assert hass.states.get(MIRROR).state == "off"


async def test_removed_source_makes_the_mirror_unavailable(
    hass: HomeAssistant,
) -> None:
    """A source that disappears shows as unavailable with no details."""
    _set_lamp(hass, brightness=120)
    await _setup(hass)

    hass.states.async_remove(LAMP)
    await hass.async_block_till_done()

    mirror = hass.states.get(MIRROR)
    assert mirror.state == STATE_UNAVAILABLE
    assert "brightness" not in mirror.attributes


async def test_mirror_records_the_attributes_it_carries(hass: HomeAssistant) -> None:
    """The mirror leaves `options` recordable, unlike a plain sensor."""
    _set_lamp(hass, brightness=1, options=["a"])
    entry = await _setup(hass)

    state = hass.states.get(MIRROR)
    assert state.state_info["unrecorded_attributes"] == frozenset()
    assert entry.runtime_data[LAMP].chosen == ["brightness", "options"]


async def test_mirror_is_hidden_in_the_registry(hass: HomeAssistant) -> None:
    """The registry entry is hidden by the integration."""
    _set_lamp(hass, brightness=1)
    await _setup(hass)

    entry = er.async_get(hass).async_get(MIRROR)
    assert entry.hidden_by is er.RegistryEntryHider.INTEGRATION
    assert entry.unique_id == LAMP


async def test_dropped_names_are_kept_for_the_list_command(
    hass: HomeAssistant,
) -> None:
    """Attributes cut to fit the size cap are exposed on the mirror."""
    _set_lamp(hass, brightness=1, options=["x" * 20000])
    entry = await _setup(hass)

    mirror = entry.runtime_data[LAMP]
    assert mirror.dropped == ["options"]
    assert "options" not in hass.states.get(MIRROR).attributes


async def test_changing_options_adds_a_mirror_for_a_new_source(
    hass: HomeAssistant,
) -> None:
    """Saving new options reloads the entry and mirrors the new source."""
    _set_lamp(hass, brightness=1)
    hass.states.async_set("fan.desk", "on", {"percentage": 50})
    entry = await _setup(hass)
    assert hass.states.get("sensor.activity_exporter_fan_desk") is None

    hass.config_entries.async_update_entry(
        entry,
        options={CONF_TRACKED: {LAMP: ["brightness"], "fan.desk": ["percentage"]}},
    )
    await hass.async_block_till_done()

    fan = hass.states.get("sensor.activity_exporter_fan_desk")
    assert fan.attributes["percentage"] == 50
    assert set(entry.runtime_data) == {LAMP, "fan.desk"}
