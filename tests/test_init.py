"""Tests for Activity Exporter setup and teardown.

The entry is set up through ``hass.config_entries.async_setup`` so the real
dependency chain (``http``, ``frontend``, ``panel_custom``) and the sensor
platform load as they do in Home Assistant.
"""

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_activity_exporter.const import DOMAIN, PANEL_URL_PATH


async def _http_ready(hass: HomeAssistant) -> None:
    """Set up the http component the panel's static path needs."""
    assert await async_setup_component(hass, "http", {})
    await hass.async_block_till_done()


async def _setup_entry(hass: HomeAssistant) -> MockConfigEntry:
    """Add the config entry and set it up through Home Assistant."""
    await _http_ready(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_setup_registers_panel_and_unload_removes_it(
    hass: HomeAssistant,
) -> None:
    """Setup adds the sidebar panel; unload removes it."""
    entry = await _setup_entry(hass)
    assert entry.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})

    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert PANEL_URL_PATH not in hass.data.get(DATA_PANELS, {})


async def test_repeated_setup_keeps_single_panel(hass: HomeAssistant) -> None:
    """A reload re-registers the panel without raising."""
    entry = await _setup_entry(hass)

    # Re-running setup must not raise the "Overwriting panel" ValueError.
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})


async def test_static_path_registered_once(hass: HomeAssistant) -> None:
    """The frontend static path is only registered once per process."""
    entry = await _setup_entry(hass)
    assert hass.data[DOMAIN]["static_registered"] is True

    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.data[DOMAIN]["static_registered"] is True
