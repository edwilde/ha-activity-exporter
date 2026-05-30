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
        """Handle the initial (and only) step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title=PANEL_TITLE, data={})

        return self.async_show_form(step_id="user")
