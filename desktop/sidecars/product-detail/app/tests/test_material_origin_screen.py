"""守护测: PR B — 耗材/配件类加 material_origin 第 9 屏 (原材料溯源/加工过程).

需求 (用户 2026-05-07): 让产品有故事感 + 可信度. 耗材/配件类生成的 12 屏长图
里加一屏展示原材料溯源 (天然橡胶 → 工人在橡胶林采集; 化学剂 → 实验室合成;
植物提取 → 种植采摘等), 把"专业"升级成"专业 + 人情味".

实现 (基于 PR A 已 wire 好 product_category chain):
1. ai_refine_v2/refine_planner.py: _VALID_ROLES_V2 加 "material_origin"
2. ai_refine_v2/refine_planner.py: 加 _inject_material_origin(planning, product_category) helper
3. ai_refine_v2/pipeline_runner.py: _worker_v2 在 reorder 后 + 写文件前调 inject
4. app.py 耗材类 + 配件类 DeepSeek prompt 加 'materials' 字段引导 (4 source_type)
5. ai_refine_v2/prompts/planner.py: SYSTEM_PROMPT_V2 准则 3 加 material_origin 屏型
6. prompt_templates.py: SCREEN_VARIANTS 加 material_origin 4 个 variant (per source_type)
"""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"


def _make_planning(roles_in_order: list[str]) -> dict:
    """构造 v2 planning dict, 按给定 role 顺序生成 idx=1..N 的屏."""
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
    return [s["role"] for s in sorted(planning.get("screens", []), key=lambda s: s["idx"])]


class TestValidRolesIncludesMaterialOrigin:
    """守护: _VALID_ROLES_V2 必须含 material_origin."""

    def test_in_valid_roles(self):
        from ai_refine_v2.refine_planner import _VALID_ROLES_V2
        assert "material_origin" in _VALID_ROLES_V2, (
            "_VALID_ROLES_V2 必须含 'material_origin' "
            "(否则 _validate_schema_v2 会拒掉这屏)"
        )


class TestInjectMaterialOrigin:
    """守护: _inject_material_origin helper 行为正确."""

    def test_helper_exists(self):
        from ai_refine_v2 import refine_planner
        assert hasattr(refine_planner, "_inject_material_origin"), (
            "refine_planner 必须有 _inject_material_origin(planning, product_category) helper"
        )

    def test_consumable_with_materials_injects(self):
        """耗材类 + DeepSeek 输出含 materials 字段 → 注入 material_origin 屏."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "value_story",
        ])
        # 模拟 DeepSeek 输出含 materials 字段 (放在 product_meta 里)
        original["product_meta"]["materials"] = [
            {"name": "天然橡胶", "source_type": "natural",
             "source_story_hint": "东南亚橡胶林手工采集"},
        ]
        result = _inject_material_origin(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert "material_origin" in roles, (
            f"耗材类 + materials 时必须注入 material_origin 屏, 实际 {roles!r}"
        )

    def test_part_with_materials_injects(self):
        """配件类 + materials 字段 → 注入."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "value_story",
        ])
        original["product_meta"]["materials"] = [
            {"name": "304 不锈钢", "source_type": "mineral",
             "source_story_hint": "国内特钢厂出料"},
        ]
        result = _inject_material_origin(deepcopy(original), "配件类")
        roles = _roles_by_idx(result)
        assert "material_origin" in roles

    def test_device_with_materials_no_inject(self):
        """设备类 + materials 字段 → 不注入 (设备类不适用)."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "value_story",
        ])
        original["product_meta"]["materials"] = [
            {"name": "钢", "source_type": "mineral", "source_story_hint": "x"}
        ]
        result = _inject_material_origin(deepcopy(original), "设备类")
        roles = _roles_by_idx(result)
        assert "material_origin" not in roles, (
            "设备类不该注入 material_origin (PR B 范围: 仅耗材+配件)"
        )

    def test_consumable_no_materials_no_inject(self):
        """耗材类 + 无 materials 字段 → 不注入 (DeepSeek 没提取出来时降级)."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "value_story",
        ])
        # 无 materials 字段
        result = _inject_material_origin(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert "material_origin" not in roles, (
            "无 materials 时必须不注入 (信息不足时优雅降级)"
        )

    def test_already_has_material_origin_no_double_inject(self):
        """DeepSeek 自己出了 material_origin 屏 → 不重复注入."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "material_origin", "brand_quality",
            "feature_wall", "detail_zoom", "spec_table", "value_story",
        ])
        original["product_meta"]["materials"] = [
            {"name": "天然橡胶", "source_type": "natural", "source_story_hint": "x"}
        ]
        result = _inject_material_origin(deepcopy(original), "耗材类")
        roles = _roles_by_idx(result)
        assert roles.count("material_origin") == 1, (
            f"已有 material_origin 时必须不重复注入 (幂等), 实际 {roles!r}"
        )

    def test_inject_increases_screen_count(self):
        """注入成功后 screens 数量从 8 → 9."""
        from ai_refine_v2.refine_planner import _inject_material_origin
        original = _make_planning([
            "hero", "lifestyle_demo", "brand_quality", "feature_wall",
            "detail_zoom", "scenario_grid_2x3", "spec_table", "value_story",
        ])
        original["product_meta"]["materials"] = [
            {"name": "x", "source_type": "natural", "source_story_hint": "y"}
        ]
        result = _inject_material_origin(deepcopy(original), "耗材类")
        assert len(result["screens"]) == 9, (
            f"耗材+materials 注入后必须 9 屏, 实际 {len(result['screens'])}"
        )


class TestPromptHasMaterialsField:
    """守护: 耗材类 + 配件类 DeepSeek prompt 必须有 materials 字段引导."""

    def test_consumable_prompt_has_materials(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找耗材类 prompt 块
        import re
        match = re.search(
            r'elif\s+product_type\s*==\s*[\'"]耗材类[\'"]\s*:\s*return\s*\(\s*(.+?)\)',
            content,
            re.S,
        )
        assert match, "找不到耗材类 DeepSeek prompt"
        prompt = match.group(1)
        assert '"materials"' in prompt, (
            "耗材类 DeepSeek prompt 必须含 'materials' 字段引导 "
            "(driver of material_origin 屏)"
        )
        # 必须含 source_type 4 种枚举至少出现 (引导 AI 选)
        assert "natural" in prompt or "chemical" in prompt or "mineral" in prompt, (
            "prompt 必须 mention source_type 选项 (natural/chemical/mineral/recycled)"
        )

    def test_part_prompt_has_materials(self):
        content = APP_PY.read_text(encoding="utf-8")
        import re
        # 找配件类 prompt (it's first branch with `if`, not `elif`)
        match = re.search(
            r'(?:if|elif)\s+product_type\s*==\s*[\'"]配件类[\'"]\s*:\s*return\s*\(\s*(.+?)\)',
            content,
            re.S,
        )
        assert match, "找不到配件类 DeepSeek prompt"
        prompt = match.group(1)
        assert '"materials"' in prompt, (
            "配件类 DeepSeek prompt 必须含 'materials' 字段引导"
        )
