"""Tests for the Activity Exporter config flow."""

from unittest.mock import patch

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_activity_exporter.const import DOMAIN, PANEL_TITLE


async def test_user_flow_creates_entry(hass: HomeAssistant) -> None:
    """A fresh user flow shows a form, then creates the single entry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    # Confirm-only flow: no fields to fill in.
    assert result["data_schema"] is None

    # Stub our own entry setup so the test stays focused on the flow's
    # behaviour rather than on panel registration (covered in test_init.py).
    with patch(
        "custom_components.ha_activity_exporter.async_setup_entry",
        return_value=True,
    ):
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == PANEL_TITLE
    assert result["data"] == {}


async def test_single_instance_only(hass: HomeAssistant) -> None:
    """A second flow aborts because only one instance is allowed."""
    MockConfigEntry(domain=DOMAIN).add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"
