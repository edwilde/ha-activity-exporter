"""Tests for Activity Exporter setup and teardown."""

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_activity_exporter.const import DOMAIN, PANEL_URL_PATH


async def test_setup_registers_panel_and_unload_removes_it(
    hass: HomeAssistant,
) -> None:
    """Setting up the entry adds the sidebar panel; unloading removes it."""
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.NOT_LOADED
    assert PANEL_URL_PATH not in hass.data.get(DATA_PANELS, {})


async def test_reload_keeps_single_panel(hass: HomeAssistant) -> None:
    """Reloading the entry re-registers the panel without raising."""
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})
