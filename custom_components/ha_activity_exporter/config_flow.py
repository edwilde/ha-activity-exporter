"""Config flow for the Activity Exporter integration.

The integration has nothing to configure; the flow exists only so the panel can
be added (and removed) from the UI. Only a single instance is ever needed.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, PANEL_TITLE


class ActivityExporterConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a single-instance config flow for Activity Exporter."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial (and only) step.

        ``single_config_entry`` in the manifest makes Home Assistant core abort a
        second user flow (and hide the "Add" button) on its own, so no manual
        guard is needed here.
        """
        if user_input is not None:
            return self.async_create_entry(title=PANEL_TITLE, data={})

        return self.async_show_form(step_id="user")
