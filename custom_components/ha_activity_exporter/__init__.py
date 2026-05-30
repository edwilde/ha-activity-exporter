"""The Activity Exporter integration.

Registers a single sidebar panel whose JavaScript reads entity history over the
authenticated WebSocket connection and builds CSV/JSON downloads in the browser.
There is no backend data path — the Python side only serves the panel asset and
registers/unregisters the sidebar entry.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    DATA_STATIC_REGISTERED,
    DOMAIN,
    PANEL_ICON,
    PANEL_JS_URL,
    PANEL_TITLE,
    PANEL_URL_BASE,
    PANEL_URL_PATH,
    PANEL_WEBCOMPONENT_NAME,
)


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

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry by removing the sidebar panel."""
    async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    return True
