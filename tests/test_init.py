"""Tests for Activity Exporter setup and teardown.

These call ``async_setup_entry`` / ``async_unload_entry`` directly rather than
going through ``config_entries.async_setup`` so the suite does not depend on the
heavyweight ``frontend`` component (and its ``hass_frontend`` asset package)
being installed. Panel registration only writes to ``hass.data[DATA_PANELS]``,
so setting up ``http`` (needed for the static path) is sufficient.
"""

from homeassistant.components.frontend import DATA_PANELS
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_activity_exporter import (
    async_setup_entry,
    async_unload_entry,
)
from custom_components.ha_activity_exporter.const import DOMAIN, PANEL_URL_PATH


async def _http_ready(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "http", {})
    await hass.async_block_till_done()


async def test_setup_registers_panel_and_unload_removes_it(
    hass: HomeAssistant,
) -> None:
    """Setup adds the sidebar panel; unload removes it."""
    await _http_ready(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await async_setup_entry(hass, entry) is True
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})

    assert await async_unload_entry(hass, entry) is True
    assert PANEL_URL_PATH not in hass.data.get(DATA_PANELS, {})


async def test_repeated_setup_keeps_single_panel(hass: HomeAssistant) -> None:
    """A second setup (e.g. a reload) re-registers without raising."""
    await _http_ready(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await async_setup_entry(hass, entry) is True
    # Re-running setup must not raise the "Overwriting panel" ValueError.
    assert await async_setup_entry(hass, entry) is True
    assert PANEL_URL_PATH in hass.data.get(DATA_PANELS, {})


async def test_static_path_registered_once(hass: HomeAssistant) -> None:
    """The frontend static path is only registered once per process."""
    await _http_ready(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await async_setup_entry(hass, entry) is True
    assert hass.data[DOMAIN]["static_registered"] is True
