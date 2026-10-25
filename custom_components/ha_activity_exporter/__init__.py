"""The Activity Exporter integration.

Registers a single sidebar panel whose JavaScript reads entity history over the
authenticated WebSocket connection and builds CSV/JSON downloads in the browser.
There is no backend history path: the Python side serves the panel asset,
registers/unregisters the sidebar entry, and keeps a small config surface of
hidden mirror sensors that save attributes the recorder drops.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import (
    DATA_STATIC_REGISTERED,
    DATA_WS_REGISTERED,
    DOMAIN,
    PANEL_ICON,
    PANEL_JS_URL,
    PANEL_TITLE,
    PANEL_URL_BASE,
    PANEL_URL_PATH,
    PANEL_WEBCOMPONENT_NAME,
)

from .websocket import async_register_commands

PLATFORMS = [Platform.SENSOR]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Activity Exporter from a config entry."""
    domain_data = hass.data.setdefault(DOMAIN, {})

    # Static paths cannot be unregistered, so register the frontend directory
    # only once per Home Assistant process even if the entry is reloaded. The
    # whole directory is served so the panel can import its sibling core module.
    if not domain_data.get(DATA_STATIC_REGISTERED):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_URL_BASE, str(frontend_dir), False)]
        )
        domain_data[DATA_STATIC_REGISTERED] = True

    # Commands cannot be unregistered, so register them once per process.
    if not domain_data.get(DATA_WS_REGISTERED):
        async_register_commands(hass)
        domain_data[DATA_WS_REGISTERED] = True

    # Removing any stale registration first avoids the "Overwriting panel" error
    # when the entry is reloaded (panel_custom has no update flag).
    async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_WEBCOMPONENT_NAME,
        module_url=PANEL_JS_URL,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,
    )

    # Mirror sensors register themselves here, keyed by source entity id.
    entry.runtime_data = {}
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_reload))

    return True


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when its options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the mirror sensors and remove the sidebar panel."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    return unloaded
