"""Pure helpers that pick which attributes a detail mirror saves."""

from __future__ import annotations

from collections.abc import Collection
import re
from typing import Any

from homeassistant.const import MATCH_ALL
from homeassistant.core import State
from homeassistant.helpers.json import json_bytes

from .const import (
    ATTR_SOURCE_ENTITY_ID,
    ATTR_SOURCE_LAST_UPDATED,
    MAX_RECORDED_ATTRS_BYTES,
)

# Attributes the mirror sets itself, or that are never worth saving.
DENIED_NAMES = frozenset(
    {
        "access_token",
        "entity_picture",
        "entity_picture_local",
        "attribution",
        "restored",
        "supported_features",
        "friendly_name",
        "icon",
        "unit_of_measurement",
        "device_class",
        "state_class",
        ATTR_SOURCE_ENTITY_ID,
        ATTR_SOURCE_LAST_UPDATED,
    }
)
# Names that look like credentials are never saved.
_SECRET_PATTERN = re.compile("token|secret|password|api_key", re.IGNORECASE)

# Attributes that change continuously (mirrors VOLATILE_ATTRIBUTES in exporter-core.js).
VOLATILE_NAMES = frozenset({"media_position", "media_position_updated_at"})
VOLATILE_PREFIX = "next_"

# Space left for the two mirror keys and friendly_name.
_HEADROOM_BYTES = 512


def is_denied(name: str) -> bool:
    """Say whether an attribute must never be saved by a mirror."""
    return name in DENIED_NAMES or _SECRET_PATTERN.search(name) is not None


def is_volatile(name: str) -> bool:
    """Say whether an attribute changes constantly and would bloat the database."""
    return name in VOLATILE_NAMES or name.startswith(VOLATILE_PREFIX)


def describe(state: State) -> dict[str, Any]:
    """List the savable details of a state, with the unrecorded ones first."""
    unrecorded = (state.state_info or {}).get("unrecorded_attributes", frozenset())
    details = [
        {
            "name": name,
            "unrecorded": MATCH_ALL in unrecorded or name in unrecorded,
            "volatile": is_volatile(name),
        }
        for name in state.attributes
        if not is_denied(name)
    ]
    details.sort(key=lambda d: (not d["unrecorded"], d["name"]))
    return {
        "entity_id": state.entity_id,
        "name": state.attributes.get("friendly_name") or state.entity_id,
        "details": details,
    }


def mirror_attributes(
    attributes: dict[str, Any], chosen: Collection[str]
) -> tuple[dict[str, Any], list[str]]:
    """Pick the chosen attributes to save and the names dropped to fit the size cap."""
    kept = {
        name: value
        for name, value in attributes.items()
        if name in chosen and not is_denied(name)
    }
    dropped: list[str] = []
    limit = MAX_RECORDED_ATTRS_BYTES - _HEADROOM_BYTES
    while kept and len(json_bytes(kept)) > limit:
        largest = max(kept, key=lambda name: len(json_bytes(kept[name])))
        dropped.append(largest)
        del kept[largest]
    return kept, dropped
