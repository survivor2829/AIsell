from __future__ import annotations

import json
from unittest import mock

import pytest

from app import (
    _get_labor_reference_image,
    _is_block_empty,
    _parse_text_for_desktop,
    _render_preview_modules,
    app,
)


def test_desktop_workspace_never_requests_paid_labor_reference_image():
    with (
        mock.patch("app._DESKTOP_MODE", True),
        mock.patch(
            "app.ai_bg_cache.get_labor_reference_image",
            side_effect=AssertionError("paid image provider call"),
        ),
    ):
        assert _get_labor_reference_image() == ""


def test_desktop_parser_reuses_explicit_scenes_and_numeric_specs_without_network():
    raw_text = "\n".join(
        [
            "\u54c1\u724c\uff1a\u5c0f\u7280\u725b",
            "\u4ea7\u54c1\u540d\u79f0\uff1a\u667a\u80fd\u6d17\u5730\u673a",
            "\u578b\u53f7\uff1aX50",
            "\u5de5\u4f5c\u6548\u7387\uff1a2600\u33a1/h",
            "\u6e05\u6d17\u5bbd\u5ea6\uff1a500mm",
            "\u7eed\u822a\u65f6\u95f4\uff1a4\u5c0f\u65f6",
            "\u9002\u7528\u573a\u666f\uff1a\u5546\u573a\u3001\u5de5\u5382\u3001\u5730\u4e0b\u8f66\u5e93",
        ]
    )

    with mock.patch("requests.post", side_effect=AssertionError("network call")):
        mapped = _parse_text_for_desktop(raw_text, "\u8bbe\u5907\u7c7b", "")

    parsed = mapped["_raw_parsed"]
    assert [item["name"] for item in parsed["scenes"]] == [
        "\u5546\u573a",
        "\u5de5\u5382",
        "\u5730\u4e0b\u8f66\u5e93",
    ]
    kpis = {item["label"]: f'{item["value"]}{item["unit"]}' for item in parsed["kpis"]}
    assert kpis["\u5de5\u4f5c\u6548\u7387"] == "2600\u33a1/h"
    assert kpis["\u6e05\u6d17\u5bbd\u5ea6"] == "500mm"
    assert kpis["\u5de5\u4f5c\u65f6\u95f4"] == "4\u5c0f\u65f6"
    assert "block_h_json" in mapped
    assert "block_i_json" in mapped

    serialized = json.dumps(mapped, ensure_ascii=False)
    for unverified_claim in ("7\u5929\u9000\u6362", "48\u5c0f\u65f6\u53d1\u8d27", "SGS", "3\u5e74\u4fdd\u8d28\u671f"):
        assert unverified_claim not in serialized


@pytest.mark.parametrize(
    ("block_id", "block_data", "expected_empty"),
    [
        ("block_f", {"vs_left_title": "product"}, False),
        ("block_g", {"brand_title": "brand only"}, True),
        ("block_g", {"brand_stats": [{"value": "10", "label": "years"}]}, False),
        ("block_t", {"client_logos": [{"name": "client", "image": ""}]}, False),
        ("block_y", {"cost_per_use": "0.5"}, False),
        ("block_w", {"cover_image": "/local/cover.png"}, False),
    ],
)
def test_block_visibility_matches_supported_template_data(block_id, block_data, expected_empty):
    assert _is_block_empty(block_id, block_data) is expected_empty


def test_value_calculation_module_is_present_in_workspace_render_order():
    with app.app_context():
        modules = _render_preview_modules({"block_y": {"cost_per_use": "0.5"}})

    assert [module["id"] for module in modules] == ["block_y"]
