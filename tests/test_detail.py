"""Tests for the detail-recording helpers."""

import pytest
from homeassistant.const import MATCH_ALL
from homeassistant.core import State

from custom_components.ha_activity_exporter.const import MAX_RECORDED_ATTRS_BYTES
from custom_components.ha_activity_exporter.detail import (
    describe,
    is_denied,
    is_volatile,
    mirror_attributes,
)

DENIED = [
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
    "source_entity_id",
    "source_last_updated",
]


def _state(attributes: dict, unrecorded: frozenset | None = None) -> State:
    """Build a light state whose state_info lists the unrecorded attributes."""
    info = None if unrecorded is None else {"unrecorded_attributes": unrecorded}
    return State("light.lamp", "on", attributes, state_info=info)


@pytest.mark.parametrize("name", DENIED)
def test_exact_denied_names_are_denied(name: str) -> None:
    """Every name on the exact denylist is refused."""
    assert is_denied(name)


@pytest.mark.parametrize(
    "name", ["api_token", "Client_SECRET", "wifi_password", "my_api_key"]
)
def test_secret_looking_names_are_denied(name: str) -> None:
    """Names containing token, secret, password or api_key are refused, any case."""
    assert is_denied(name)


@pytest.mark.parametrize("name", ["brightness", "color_temp", "effect", "iconic"])
def test_normal_names_are_allowed(name: str) -> None:
    """Ordinary attribute names, including ones merely containing a denied word, pass."""
    assert not is_denied(name)


@pytest.mark.parametrize(
    "name", ["media_position", "media_position_updated_at", "next_rising", "next_dawn"]
)
def test_volatile_names(name: str) -> None:
    """Constantly changing attributes are flagged volatile."""
    assert is_volatile(name)


@pytest.mark.parametrize("name", ["brightness", "media_title", "xnext_thing"])
def test_non_volatile_names(name: str) -> None:
    """Other attributes are not flagged volatile."""
    assert not is_volatile(name)


def test_describe_without_state_info_marks_none_unrecorded() -> None:
    """A state with no state_info has no unrecorded attributes."""
    result = describe(_state({"brightness": 10}))
    assert result["details"] == [
        {"name": "brightness", "unrecorded": False, "volatile": False}
    ]


def test_describe_marks_listed_names_unrecorded() -> None:
    """Only names in unrecorded_attributes are unrecorded."""
    result = describe(_state({"brightness": 10, "effect": "x"}, frozenset({"effect"})))
    assert {d["name"]: d["unrecorded"] for d in result["details"]} == {
        "brightness": False,
        "effect": True,
    }


def test_describe_match_all_marks_everything_unrecorded() -> None:
    """MATCH_ALL means every attribute is unrecorded."""
    result = describe(_state({"a": 1, "b": 2}, frozenset({MATCH_ALL})))
    assert [d["unrecorded"] for d in result["details"]] == [True, True]


def test_describe_omits_denied_names() -> None:
    """Denied attributes never appear in the details."""
    result = describe(
        _state({"friendly_name": "Lamp", "api_token": "s", "brightness": 1})
    )
    assert [d["name"] for d in result["details"]] == ["brightness"]


def test_describe_orders_unrecorded_first_then_by_name() -> None:
    """Unrecorded details come first, each group sorted by name."""
    result = describe(
        _state({"b": 1, "a": 1, "z": 1, "y": 1}, frozenset({"z", "y"}))
    )
    assert [d["name"] for d in result["details"]] == ["y", "z", "a", "b"]


def test_describe_flags_volatile_details() -> None:
    """Volatile attributes carry the volatile flag in the description."""
    result = describe(_state({"media_position": 3, "media_title": "t"}))
    assert {d["name"]: d["volatile"] for d in result["details"]} == {
        "media_position": True,
        "media_title": False,
    }


def test_describe_names_the_entity_from_friendly_name() -> None:
    """The name is the friendly name when there is one."""
    result = describe(_state({"friendly_name": "Lamp"}))
    assert (result["entity_id"], result["name"]) == ("light.lamp", "Lamp")


def test_describe_falls_back_to_entity_id_for_name() -> None:
    """Without a friendly name the entity id is the name."""
    assert describe(_state({}))["name"] == "light.lamp"


def test_mirror_keeps_only_chosen_attributes() -> None:
    """Attributes not chosen are left out and nothing is dropped."""
    kept, dropped = mirror_attributes({"a": 1, "b": 2, "c": 3}, {"a", "c"})
    assert (kept, dropped) == ({"a": 1, "c": 3}, [])


def test_mirror_ignores_chosen_names_that_are_absent() -> None:
    """A chosen name missing from the attributes is simply not kept."""
    kept, dropped = mirror_attributes({"a": 1}, {"a", "gone"})
    assert (kept, dropped) == ({"a": 1}, [])


def test_mirror_drops_denied_names_even_when_chosen() -> None:
    """A denied attribute is never kept, even if chosen."""
    kept, dropped = mirror_attributes(
        {"api_token": "s", "icon": "mdi:x", "a": 1}, {"api_token", "icon", "a"}
    )
    assert (kept, dropped) == ({"a": 1}, [])


def test_mirror_drops_the_largest_attributes_over_the_cap() -> None:
    """Over the cap the largest attributes go first until the rest fits."""
    big = "x" * 9000
    medium = "y" * 7000
    attributes = {"small": 1, "medium": medium, "big": big}
    kept, dropped = mirror_attributes(attributes, set(attributes))
    assert kept == {"small": 1, "medium": medium}
    assert dropped == ["big"]


def test_mirror_keeps_dropping_until_under_the_cap() -> None:
    """More than one attribute is dropped when one removal is not enough."""
    chunk = "x" * 8000
    attributes = {"a": chunk, "b": chunk + "y", "c": chunk + "yy", "tiny": 1}
    kept, dropped = mirror_attributes(attributes, set(attributes))
    assert dropped == ["c", "b"]
    assert kept == {"a": chunk, "tiny": 1}


def test_mirror_leaves_room_for_the_mirror_keys() -> None:
    """A payload that fits the cap but not the headroom is still trimmed."""
    value = "x" * (MAX_RECORDED_ATTRS_BYTES - 512 - 20)
    kept, dropped = mirror_attributes({"a": value}, {"a"})
    assert (kept, dropped) == ({"a": value}, [])
    kept, dropped = mirror_attributes({"a": value + "x" * 100}, {"a"})
    assert (kept, dropped) == ({}, ["a"])
