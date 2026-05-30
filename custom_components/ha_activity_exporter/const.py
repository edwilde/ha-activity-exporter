"""Constants for the Activity Exporter integration."""

from __future__ import annotations

DOMAIN = "ha_activity_exporter"

# Sidebar panel registration.
PANEL_URL_PATH = "activity-exporter"
PANEL_TITLE = "Activity Exporter"
# Filled "export" glyph (a page with an out-arrow). Reads clearly at sidebar
# size, unlike the thin outline variant. Valid across all supported HA versions.
PANEL_ICON = "mdi:file-export"
PANEL_WEBCOMPONENT_NAME = "activity-exporter-panel"

# The whole frontend/ directory is served under this URL base (the panel imports
# a sibling module, exporter-core.js, so a single-file registration is not enough).
PANEL_URL_BASE = f"/{DOMAIN}"
PANEL_JS_FILENAME = "activity-exporter-panel.js"
PANEL_JS_URL = f"{PANEL_URL_BASE}/{PANEL_JS_FILENAME}"

# hass.data key marking that the (process-wide) static path has been registered.
DATA_STATIC_REGISTERED = "static_registered"
