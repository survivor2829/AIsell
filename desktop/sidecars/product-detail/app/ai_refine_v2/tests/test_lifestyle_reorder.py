"""守护测: PR A — lifestyle_demo 调到第 2 屏 (post-planning reorder).

需求 (用户 2026-05-07):
v3.2.x 精修 8 屏中 lifestyle_demo (真人演示/操作产品) 默认在第 8 屏 (最后),
用户希望调到第 2 屏 (首屏后的"黄金注意力位")。仅对耗材类/配件类生效,
设备类/工具类的 lifestyle_demo 含义可能不同, 保持 DeepSeek 原顺序。

实现:
ai_refine_v2/refine_planner.py 加 _reorder_lifestyle_to_second(planning, product_category)
post-planning helper: 在 plan_v2 拿到 DeepSeek 结果后, 强制把 lifestyle_demo idx 改到 2,
原 idx=2 的屏 idx 改到 lifestyle_demo 原位置。
"""
from __future__ import annotations
import pytest
from copy import deepcopy


def _make_planning(roles_in_order: list[str]) -> dict:
    """构造一个 v2 planning dict, 按给定 role 顺序生成 idx=1..N 的屏."""
    return {
        "product_meta": {"name": "测试产品"},
        "screen_count": len(roles_in_order),
        "screens": [
            {
                "idx": i + 1,
                "role": role,
                "title": f"屏 {i + 1} · {role}",
                "prompt": "..." * 70,
            }
            for i, role in enumerate(roles_in_order)
        ],
    }


def _roles_by_idx(planning: dict) -> list[str]:
    """从 planning 里按 idx 升序提取 role 列表."""
    sorted_screens = sorted(planning.get("screens", []), key=lambda s: s["idx"])
    return [s["role"] for s in sorted_screens]


class TestReorderConsumable:
    """守护: 耗材类 lifestyle_demo 必须被 reorder 到 idx=2."""

    def test_consumable_lifestyle_at_8_moves_to_2(self):
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert roles[0] == "hero", "屏 1 必须保持 hero"
        assert roles[1] == "lifestyle_demo", (
            f"屏 2 必须是 lifestyle_demo (耗材类 reorder 后), 实际: {roles!r}"
        )
        # 原 idx=2 的 brand_quality 应被换到 lifestyle_demo 原位置 (idx=8)
        assert roles[7] == "brand_quality", (
            f"原 idx=2 (brand_quality) 必须被换到 idx=8, 实际: {roles!r}"
        )

    def test_idx_stays_continuous_1_to_n(self):
        """reorder 后 idx 必须保持 1..N 连续无缺."""
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "耗材类")
        idx_set = sorted([s["idx"] for s in result["screens"]])
        assert idx_set == list(range(1, 9)), (
            f"idx 必须 1..8 连续, 实际 {idx_set!r}"
        )


class TestReorderPart:
    """守护: 配件类 lifestyle_demo 必须被 reorder 到 idx=2."""

    def test_part_lifestyle_at_8_moves_to_2(self):
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "配件类")
        roles = _roles_by_idx(result)
        assert roles[1] == "lifestyle_demo", (
            f"配件类 reorder 后屏 2 必须是 lifestyle_demo, 实际: {roles!r}"
        )


class TestNoReorderForOtherCategories:
    """守护: 设备类/工具类不重排 (保持 DeepSeek 原顺序)."""

    def test_device_unchanged(self):
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "设备类")
        roles = _roles_by_idx(result)
        assert roles == [
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ], f"设备类不能被 reorder, 实际 {roles!r}"

    def test_tool_unchanged(self):
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "feature_wall", "scenario_grid_2x3", "spec_table",
            "detail_zoom", "value_story", "brand_quality", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "工具类")
        roles_before = _roles_by_idx(original)
        roles_after = _roles_by_idx(result)
        assert roles_after == roles_before, (
            f"工具类必须保持原顺序, before={roles_before!r}, after={roles_after!r}"
        )

    def test_none_category_unchanged(self):
        """product_category=None 时不重排 (向后兼容老调用)."""
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "value_story", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "lifestyle_demo",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), None)
        assert _roles_by_idx(result) == _roles_by_idx(original)


class TestEdgeCases:
    """边界: 缺 lifestyle_demo / 缺 idx=2 / 空 planning."""

    def test_no_lifestyle_demo_returns_unchanged(self):
        """DeepSeek 没出 lifestyle_demo 屏 → reorder no-op (不抛异常)."""
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "brand_quality", "feature_wall", "spec_table",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert roles == ["hero", "brand_quality", "feature_wall", "spec_table"], (
            "缺 lifestyle_demo 时必须 no-op"
        )

    def test_lifestyle_already_at_2_idempotent(self):
        """lifestyle_demo 已经在 idx=2 → no-op (幂等)."""
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "spec_table",
        ])
        result = _reorder_lifestyle_to_second(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert roles[1] == "lifestyle_demo"
        assert roles == _roles_by_idx(original), "幂等性: 重复调用结果相同"

    def test_empty_screens_no_crash(self):
        """planning 含空 screens 列表 → 不崩."""
        from ai_refine_v2.refine_planner import _reorder_lifestyle_to_second
        empty = {"product_meta": {}, "screen_count": 0, "screens": []}
        result = _reorder_lifestyle_to_second(empty, "耗材类")
        assert result["screens"] == []
