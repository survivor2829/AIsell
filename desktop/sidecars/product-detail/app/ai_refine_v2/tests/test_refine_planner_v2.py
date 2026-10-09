"""plan_v2 单测: 不调真 DeepSeek, 仅 mock 验证 schema 解析 + 重试逻辑.

PRD §阶段一·任务 1.1 — 新 v2 schema (style_dna + N 屏导演 prompt) 的回归保护.
跟 v1 plan() 单测共存, 两套互不影响 (60 v1 单测继续过, 这里加 v2 一组).

设计:
  - 用 mock http_fn 模拟 DeepSeek 响应, 不烧任何成本
  - 黄金 fixture _v2_sample(): 一份完整合规的 v2 dict, 各测试基于它做变异
  - 每条测试只破坏一个字段, 保证 fail message 单一可定位
"""
from __future__ import annotations

import json
import unittest
import urllib.error
from unittest import mock

from ai_refine_v2.refine_planner import (
    PlannerError,
    MAX_PRODUCT_TEXT_CHARS,
    MAX_PRODUCT_TITLE_CHARS,
    _validate_schema_v2,
    plan_v2,
)


# ── 黄金 fixture (合规的 v3 schema dict, PRD AI_refine_v3.1) ────────
# v3 (2026-04-28 deliberate_iron_rule_5_break):
#   - default screen_count 7 → 8 (新 schema 下限)
#   - roles 序列重写: 8 屏覆盖必出 3 屏 (hero/brand_quality/spec_table) + 5 高优 role
#   - 9-11 屏: scenario_grid_2x3 / icon_grid_radial / FAQ (3 个新屏型)
#   - 12-15 屏: 循环非 SCOTT_OVERRIDE role
#   - SCOTT_OVERRIDE 屏 (spec_table / FAQ) 必须 deliberate_dna_divergence=true
#   - unified_visual_treatment 改用 v3 关键词 (warm golden-hour + industrial cool tones)

# v3 默认 8 屏 role 序列 (v3.2 精修: 含必出 4 屏 hero/brand_quality/spec_table/lifestyle_demo)
_V3_DEFAULT_ROLES = [
    "hero",            # 1, 必出
    "feature_wall",    # 2
    "scenario",        # 3
    "vs_compare",      # 4
    "detail_zoom",     # 5
    "lifestyle_demo",  # 6, 必出 (v3.2 精修, Scott 反馈 1)
    "brand_quality",   # 7, 必出
    "spec_table",      # 8, 必出 + SCOTT_OVERRIDE
]
# v3.iter2 (Scott 4/9 反馈): 11 → 12 屏型, +lifestyle_demo
# v3.2 精修: lifestyle_demo 移到 default 8 屏, 9-12 屏改用其他 4 个屏型
# screen_count 9-12 时增补的新屏型 (4 个 v3.2 全部用上)
_V3_EXTRA_ROLES = [
    "scenario_grid_2x3",
    "icon_grid_radial",
    "FAQ",
    "value_story",  # v3.2: 从 default 8 屏移到 extra (lifestyle_demo 占了 idx 6)
]
# screen_count 13-15 时循环复用 — 准则 11 屏型唯一性硬约束会触发重复警告
# (用于负向测试 TestV3iter2RoleUniqueness, 不是 happy path)
_V3_REPEAT_POOL = ["feature_wall", "scenario", "vs_compare", "detail_zoom"]

_LAYOUT_HINT_BY_ROLE = {
    "hero": "centered hero shot",
    "feature_wall": "grid layout",
    "scenario": "triptych",
    "scenario_grid_2x3": "6-scene application grid",
    "vs_compare": "side-by-side card comparison",
    "detail_zoom": "zoom + callouts",
    "icon_grid_radial": "radial icon grid",
    "spec_table": "product hero shot on top half, spec table on bottom half",
    "value_story": "HUD overlays on photo background",
    "brand_quality": "heroic centered composition",
    "FAQ": "FAQ card grid",
    "lifestyle_demo": "engineer using product in scene",
}

_NEGATIVE_GUARD = (
    "DO NOT INVENT any brand logos, company names, trademarks, certifications, "
    "or printed text NOT VISIBLE in Image 1. "
    "PRESERVE all existing labels, stickers, model markings, printed text exactly "
    "as shown in Image 1 (faithful to position, color, content). "
    "NO 「」-quoted headlines should be added ONTO the product surface itself."
)


def _v2_sample(screen_count: int = 8) -> dict:
    """一份合规的 v3.iter2 schema 样本 (PRD AI_refine_v3.1 + Scott iter2).
    测试通过 deepcopy + 改字段做边界 case.

    支持 screen_count [8, 15]:
      - 1-8 屏 (合规): _V3_DEFAULT_ROLES (含必出 3 屏 hero/brand_quality/spec_table)
      - 9-12 屏 (合规): _V3_EXTRA_ROLES (4 个 v3.iter2 新屏型, 全部唯一)
      - 13-15 屏 (违规, 故意): _V3_REPEAT_POOL 循环复用, 触发准则 11 重复警告
    """
    screens = []
    for i in range(1, screen_count + 1):
        if i <= 8:
            role = _V3_DEFAULT_ROLES[i - 1]
        elif i <= 12:
            role = _V3_EXTRA_ROLES[i - 9]
        else:
            role = _V3_REPEAT_POOL[(i - 13) % len(_V3_REPEAT_POOL)]
        screen = {
            "idx": i,
            "role": role,
            "title": f"屏 {i} 标题",
            # 长 prompt (> 200 字符), 模拟导演视角
            "prompt": (
                "Wide low-angle hero shot of an industrial yellow water-cleaning "
                "robot cruising on a calm urban river at golden hour. The product "
                "fills the center-right of the frame, two crane silhouettes blurred "
                "in the distance. A bold white display headline anchors the upper-left "
                "with generous negative space. Cinematic lens flare on water ripples, "
                "deep slate-blue sky transitions to amber on horizon. Magazine-cover "
                f"composition with editorial confidence. (screen {i})"
            ) + f" Layout contract: {_LAYOUT_HINT_BY_ROLE[role]}. " + _NEGATIVE_GUARD,
        }
        # v3: SCOTT_OVERRIDE 屏型 (spec_table / FAQ) 必须设 deliberate_dna_divergence=true
        if role in ("spec_table", "FAQ"):
            screen["deliberate_dna_divergence"] = True
        screens.append(screen)
    return {
        "product_meta": {
            "name": "DZ600M 无人水面清洁机",
            "category": "设备类",
            "primary_color": "industrial yellow with black auger trim",
            "key_visual_parts": [
                "industrial yellow body",
                "two black cylindrical auger floats",
                "transparent dome camera housing",
            ],
        },
        "style_dna": {
            "color_palette": "industrial yellow + slate gray + amber highlight palette",
            "lighting": "cinematic low-angle golden-hour key light with steel-blue rim",
            "composition_style": "asymmetric editorial layout with large negative space top-left",
            "mood": "confident B2B premium industrial mood",
            "typography_hint": "modern condensed sans-serif headlines",
            # v3.2: unified_visual_treatment 改用大疆风高级灰关键词
            # (v3.iter2 warm golden-hour + industrial cool tones 已废弃)
            "unified_visual_treatment": (
                "DJI/Apple-inspired premium minimalist aesthetic; "
                "sophisticated grayscale palette as dominant base "
                "(#F5F5F7 light gray, #2C2C2E dark gray accents, #86868B mid gray text); "
                "neutral cool studio lighting; product retains EXACT original color, "
                "NO ambient color shifting; high-end e-commerce detail page aesthetic."
            ),
        },
        "screen_count": screen_count,
        "screens": screens,
    }


def _mock_http(response_dict: dict):
    """构造 mock http_fn: 返 OpenAI-style chat completions response.

    response_dict 是 plan_v2 期望从 .choices[0].message.content 解析出来的 JSON.
    """
    def _fn(payload: dict, api_key: str) -> dict:
        return {
            "choices": [{
                "message": {"content": json.dumps(response_dict, ensure_ascii=False)}
            }],
        }
    return _fn


# ──────────────────────────────────────────────────────────────────
# A: schema validation — 合规样本不报警, 各种破坏分别报对警
# ──────────────────────────────────────────────────────────────────
class TestValidateSchemaV2Pass(unittest.TestCase):
    """合规样本应返空 warning list."""

    def test_minimal_valid_sample_no_warnings(self):
        # v3 (PRD AI_refine_v3.1): 下限 6 → 8
        self.assertEqual(_validate_schema_v2(_v2_sample(screen_count=8)), [])

    def test_max_unique_screens_12_no_warnings(self):
        """v3.iter2: 12 屏型全部用上 (8 默认 + 4 新增) 仍合规, 不触发任何 warning.

        历史: v3 是 max=15 + 11 屏型, 但 v3.iter2 加准则 11 屏型唯一硬约束后,
        实际可达上限 = 12 屏 (与 12 个 role 一一对应). schema 仍允许 13-15
        但 13+ 必触发"屏型重复"warning, 见 TestV3iter2RoleUniqueness.
        """
        self.assertEqual(_validate_schema_v2(_v2_sample(screen_count=12)), [])


class TestValidateSchemaV2ProductMeta(unittest.TestCase):
    """product_meta 破坏 → 对应 warning."""

    def test_missing_product_meta(self):
        d = _v2_sample()
        d.pop("product_meta")
        w = _validate_schema_v2(d)
        self.assertTrue(any("product_meta 缺失" in x for x in w))

    def test_illegal_category(self):
        d = _v2_sample()
        d["product_meta"]["category"] = "餐具类"
        w = _validate_schema_v2(d)
        self.assertTrue(any("category 非法" in x for x in w))

    def test_peijian_category_is_valid(self):
        d = _v2_sample()
        d["product_meta"]["category"] = "配件类"
        self.assertEqual(_validate_schema_v2(d), [])

    def test_empty_key_visual_parts(self):
        d = _v2_sample()
        d["product_meta"]["key_visual_parts"] = []
        w = _validate_schema_v2(d)
        self.assertTrue(any("key_visual_parts 缺失或空列表" in x for x in w))


class TestValidateSchemaV2StyleDna(unittest.TestCase):
    """style_dna 5 字段破坏 → 警告对应字段."""

    def test_missing_style_dna(self):
        d = _v2_sample()
        d.pop("style_dna")
        w = _validate_schema_v2(d)
        self.assertTrue(any("style_dna 缺失或非 dict" in x for x in w))

    def test_color_palette_too_short(self):
        d = _v2_sample()
        d["style_dna"]["color_palette"] = "blue, white"  # 11 字符 < 20
        w = _validate_schema_v2(d)
        self.assertTrue(any("color_palette 过短" in x for x in w))

    def test_mood_too_short(self):
        d = _v2_sample()
        d["style_dna"]["mood"] = "cool"  # 4 < 12
        w = _validate_schema_v2(d)
        self.assertTrue(any("mood 过短" in x for x in w))

    def test_each_field_required(self):
        for k in ("color_palette", "lighting", "composition_style", "mood",
                  "typography_hint", "unified_visual_treatment"):
            with self.subTest(field=k):
                d = _v2_sample()
                d["style_dna"].pop(k)
                w = _validate_schema_v2(d)
                self.assertTrue(
                    any(k in x and "缺失" in x for x in w),
                    f"删除 style_dna.{k} 应触发 '缺失' 警告, 实际 warnings={w}",
                )

    def test_unified_visual_treatment_required(self):
        """v2 PRD §阶段五·step2 修补: unified_visual_treatment 必填 (准则 2)."""
        d = _v2_sample()
        d["style_dna"].pop("unified_visual_treatment")
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("unified_visual_treatment" in x and "缺失" in x for x in w),
            f"删除 unified_visual_treatment 应触发 '缺失' 警告, warnings={w}",
        )

    def test_unified_visual_treatment_too_short(self):
        """unified_visual_treatment 阈值 30 字符 (比 typography_hint 8 严, 强制有针对性)."""
        d = _v2_sample()
        d["style_dna"]["unified_visual_treatment"] = "short text"  # 10 < 30
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("unified_visual_treatment" in x and "过短" in x for x in w),
            f"unified_visual_treatment < 30 应触发 '过短' 警告, warnings={w}",
        )


class TestValidateSchemaV2Screens(unittest.TestCase):
    """screens 数组破坏."""

    def test_screen_count_below_min(self):
        # v3 (PRD AI_refine_v3.1): 下限 6 → 8, 测 7 触发 [8,15] 警告
        d = _v2_sample()
        d["screen_count"] = 7
        d["screens"] = d["screens"][:7]
        w = _validate_schema_v2(d)
        self.assertTrue(any("screen_count" in x and "[8,15]" in x for x in w))

    def test_screen_count_above_max(self):
        # v3 (PRD AI_refine_v3.1): 上限 10 → 15, 测 16 触发警告
        # v3.iter2 fixture: 用 12 屏 (12 个唯一 role 上限) 触发"长度不一致"
        d = _v2_sample(screen_count=12)
        d["screen_count"] = 16
        # screens 仍 12 个, 触发 "长度不一致"
        w = _validate_schema_v2(d)
        self.assertTrue(any("screen_count" in x for x in w))

    def test_screens_count_mismatch(self):
        d = _v2_sample(screen_count=8)
        d["screens"] = d["screens"][:6]  # 留 6 屏但 screen_count=8
        w = _validate_schema_v2(d)
        self.assertTrue(any("不一致" in x for x in w))

    def test_screen_idx_wrong_order(self):
        d = _v2_sample()
        d["screens"][2]["idx"] = 99  # 应为 3
        w = _validate_schema_v2(d)
        self.assertTrue(any("screens[2].idx 应为 3" in x for x in w))

    def test_prompt_too_short_seo_list(self):
        d = _v2_sample()
        d["screens"][0]["prompt"] = "industrial robot, 8K, sharp focus"  # 33 < 200
        w = _validate_schema_v2(d)
        self.assertTrue(any("prompt 过短" in x for x in w))

    def test_screen_missing_role(self):
        d = _v2_sample()
        d["screens"][0].pop("role")
        w = _validate_schema_v2(d)
        self.assertTrue(any("screens[0].role" in x for x in w))

    def test_missing_negative_guard_triggers_warning(self):
        d = _v2_sample()
        d["screens"][0]["prompt"] = d["screens"][0]["prompt"].split(
            "DO NOT INVENT", 1
        )[0]
        w = _validate_schema_v2(d, product_text="DZ600M 水面清洁机")
        self.assertTrue(any("negative" in x.lower() for x in w), w)

    def test_wrong_role_layout_triggers_warning(self):
        d = _v2_sample()
        d["screens"][1]["prompt"] = d["screens"][1]["prompt"].replace(
            "grid layout", "single product photograph"
        )
        w = _validate_schema_v2(d, product_text="DZ600M 水面清洁机")
        self.assertTrue(any("layout" in x.lower() for x in w), w)

    def test_positive_logo_instruction_triggers_warning(self):
        d = _v2_sample()
        d["screens"][0]["prompt"] += " Add a new company logo onto the chassis."
        w = _validate_schema_v2(d, product_text="DZ600M 水面清洁机")
        self.assertTrue(any("logo" in x.lower() for x in w), w)

    def test_unbacked_commercial_claim_triggers_warning(self):
        d = _v2_sample()
        d["screens"][6]["prompt"] += " Headline 「全国 200+ 售后网点」."
        w = _validate_schema_v2(d, product_text="DZ600M 水面清洁机")
        self.assertTrue(any("商业承诺" in x for x in w), w)

    def test_commercial_claim_copied_from_product_text_is_allowed(self):
        d = _v2_sample()
        d["screens"][6]["prompt"] += " Headline 「全国 200+ 售后网点」."
        w = _validate_schema_v2(
            d,
            product_text="DZ600M 水面清洁机，全国 200+ 售后网点",
        )
        self.assertFalse(any("商业承诺" in x for x in w), w)

    def test_reordered_numeric_claim_with_same_semantics_is_allowed(self):
        d = _v2_sample()
        d["screens"][6]["prompt"] += " Headline 「8小时续航」."
        w = _validate_schema_v2(
            d,
            product_text="DZ600M 水面清洁机，续航时长 8 小时",
        )
        self.assertFalse(any("商业承诺" in x for x in w), w)

    def test_different_numeric_value_with_same_semantics_is_rejected(self):
        d = _v2_sample()
        d["screens"][6]["prompt"] += " Headline 「8小时续航」."
        w = _validate_schema_v2(
            d,
            product_text="DZ600M 水面清洁机，续航时长 6 小时",
        )
        self.assertTrue(any("商业承诺" in x for x in w), w)

    def test_unbacked_certification_and_fixed_claims_stay_strict(self):
        for claim in ("ISO 9001 认证", "终身质保"):
            with self.subTest(claim=claim):
                d = _v2_sample()
                d["screens"][6]["prompt"] += f" Headline 「{claim}」."
                w = _validate_schema_v2(
                    d,
                    product_text="DZ600M 水面清洁机",
                )
                self.assertTrue(any("商业承诺" in x for x in w), w)


# ──────────────────────────────────────────────────────────────────
# B: plan_v2 主入口 — mock http_fn, 端到端 schema 解析
# ──────────────────────────────────────────────────────────────────


class TestPlanV2InputValidation(unittest.TestCase):

    def test_empty_text_raises(self):
        with self.assertRaises(PlannerError) as ctx:
            plan_v2(product_text="", api_key="dummy")
        self.assertIn("不能为空", str(ctx.exception))

    def test_whitespace_only_raises(self):
        with self.assertRaises(PlannerError):
            plan_v2(product_text="   \n\t  ", api_key="dummy")

    def test_product_text_over_limit_raises_before_http(self):
        http_fn = mock.Mock()
        with self.assertRaises(PlannerError) as ctx:
            plan_v2(
                product_text="产" * (MAX_PRODUCT_TEXT_CHARS + 1),
                api_key="dummy",
                http_fn=http_fn,
            )
        self.assertIn(str(MAX_PRODUCT_TEXT_CHARS), str(ctx.exception))
        http_fn.assert_not_called()

    def test_product_title_over_limit_raises_before_http(self):
        http_fn = mock.Mock()
        with self.assertRaises(PlannerError) as ctx:
            plan_v2(
                product_text="真实产品文案",
                product_title="T" * (MAX_PRODUCT_TITLE_CHARS + 1),
                api_key="dummy",
                http_fn=http_fn,
            )
        self.assertIn(str(MAX_PRODUCT_TITLE_CHARS), str(ctx.exception))
        http_fn.assert_not_called()

    def test_no_api_key_raises(self):
        import os as _os
        old = _os.environ.pop("DEEPSEEK_API_KEY", None)
        try:
            with self.assertRaises(PlannerError) as ctx:
                plan_v2(product_text="dummy text", api_key=None)
            self.assertIn("DEEPSEEK_API_KEY", str(ctx.exception))
        finally:
            if old is not None:
                _os.environ["DEEPSEEK_API_KEY"] = old




# ──────────────────────────────────────────────────────────────────
# C: v1 / v2 互不污染验证
# ──────────────────────────────────────────────────────────────────
class TestV1V2Isolation(unittest.TestCase):
    """v1 schema 不应被 v2 校验通过, 反之亦然."""

    def test_v1_sample_fails_v2_validation(self):
        """v1 schema 缺 style_dna / screens → v2 校验大量警告."""
        v1_sample = {
            "product_meta": {
                "name": "X", "category": "设备类",
                "primary_color": "yellow",
                "key_visual_parts": ["a", "b"],
                "proportions": "compact",
            },
            "selling_points": [
                {"idx": 1, "text": "x", "visual_type": "product_in_scene",
                 "priority": "high", "reason": "y"},
            ],
            "planning": {
                "total_blocks": 2,
                "block_order": ["hero", "selling_point_1"],
                "hero_scene_hint": "scene",
            },
        }
        warnings = _validate_schema_v2(v1_sample)
        # 应至少警告 style_dna 缺失 + screen_count 缺失 + screens 缺失
        msg = " ".join(warnings)
        self.assertIn("style_dna", msg)
        self.assertIn("screen_count", msg)
        self.assertIn("screens", msg)

    def test_v2_sample_fails_v1_validation(self):
        """v2 schema 喂给 v1 _validate_schema 也应警告 (selling_points 缺失等)."""
        from ai_refine_v2.refine_planner import _validate_schema as _v1_validate
        v2_sample = _v2_sample()
        v1_warnings = _v1_validate(v2_sample)
        # v1 必查 selling_points / planning.block_order
        msg = " ".join(v1_warnings)
        self.assertIn("selling_points", msg)


class TestPlanV2ExportPath(unittest.TestCase):
    """from ai_refine_v2 import plan_v2 的导入路径."""

    def test_import_from_package_root(self):
        from ai_refine_v2 import plan_v2 as p2  # noqa: F401
        self.assertTrue(callable(p2))

    def test_v1_plan_still_exported(self):
        """加 plan_v2 不能挤掉老 plan."""
        from ai_refine_v2 import plan as p1, PlannerError as PE  # noqa: F401
        self.assertTrue(callable(p1))
        self.assertTrue(issubclass(PE, RuntimeError))


# ──────────────────────────────────────────────────────────────────
# D: v3 (PRD AI_refine_v3.1) 新增 schema 校验 + SYSTEM_PROMPT_V2 v3 关键词
# ──────────────────────────────────────────────────────────────────
class TestV3RoleEnum(unittest.TestCase):
    """v3.iter2 role 白名单 (12 屏型, +lifestyle_demo)."""

    def test_invalid_role_triggers_warning(self):
        d = _v2_sample()
        d["screens"][1]["role"] = "fake_role_xyz"
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("非法" in x and "12 屏型" in x for x in w),
            f"非法 role 应触发警告. warnings={w}",
        )

    def test_all_13_roles_in_valid_set(self):
        """v3.iter2 + PR B (2026-05-07) _VALID_ROLES_V2: 12 + material_origin = 13."""
        from ai_refine_v2.refine_planner import _VALID_ROLES_V2
        self.assertEqual(
            len(_VALID_ROLES_V2), 13,
            f"v3.iter2+PR B 应有 13 个合法 role, 实际 {len(_VALID_ROLES_V2)}",
        )
        for new_role in (
            "scenario_grid_2x3", "icon_grid_radial", "FAQ", "lifestyle_demo",
            "material_origin",  # PR B (2026-05-07): 耗材/配件原材料溯源屏
        ):
            with self.subTest(role=new_role):
                self.assertIn(new_role, _VALID_ROLES_V2)

    def test_fixture_with_all_extra_roles_no_role_warning(self):
        """12 屏 fixture 涵盖 9-12 屏的 4 个 v3.iter2 新 role, 不触发非法警告."""
        d = _v2_sample(screen_count=12)
        w = _validate_schema_v2(d)
        self.assertFalse(
            any("非法" in x for x in w),
            f"12 屏 fixture 含全 v3.iter2 新 role, 不应触发非法警告. warnings={w}",
        )


class TestV3RequiredRoles(unittest.TestCase):
    """v3.2 精修必出屏型 (hero / brand_quality / spec_table / lifestyle_demo)."""

    def test_missing_hero_triggers_warning(self):
        d = _v2_sample()
        d["screens"][0]["role"] = "scenario_grid_2x3"  # idx=1 hero 改成非必出
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("必出屏型缺失" in x and "hero" in x for x in w),
            f"缺 hero 应触发警告. warnings={w}",
        )

    def test_missing_brand_quality_triggers_warning(self):
        d = _v2_sample()
        d["screens"][6]["role"] = "scenario_grid_2x3"  # idx=7 brand_quality 改
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("必出屏型缺失" in x and "brand_quality" in x for x in w),
            f"缺 brand_quality 应触发警告. warnings={w}",
        )

    def test_missing_spec_table_triggers_warning(self):
        d = _v2_sample()
        d["screens"][7]["role"] = "scenario_grid_2x3"  # idx=8 spec_table 改
        d["screens"][7].pop("deliberate_dna_divergence", None)
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("必出屏型缺失" in x and "spec_table" in x for x in w),
            f"缺 spec_table 应触发警告. warnings={w}",
        )

    def test_missing_lifestyle_demo_triggers_warning(self):
        """v3.2 精修 (Scott 反馈 1): lifestyle_demo 是第 4 必出屏, 缺失必触发警告."""
        d = _v2_sample()
        # idx=6 (索引 5) 在新 fixture 顺序是 lifestyle_demo, 改成非必出 role
        d["screens"][5]["role"] = "scenario_grid_2x3"
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("必出屏型缺失" in x and "lifestyle_demo" in x for x in w),
            f"缺 lifestyle_demo 应触发警告. warnings={w}",
        )

    def test_default_fixture_has_all_4_required(self):
        """v3.2: default 8 屏 fixture 含全 4 必出屏型, 无缺失警告."""
        d = _v2_sample()
        w = _validate_schema_v2(d)
        self.assertFalse(
            any("必出屏型缺失" in x for x in w),
            f"v3.2 default 8 屏 fixture 含全 4 必出屏型, 不应缺失. warnings={w}",
        )

    def test_required_roles_set_has_4_members(self):
        """v3.2: _REQUIRED_ROLES_V2 应有 4 个 (3 个 v3 + lifestyle_demo)."""
        from ai_refine_v2.refine_planner import _REQUIRED_ROLES_V2
        self.assertEqual(
            _REQUIRED_ROLES_V2,
            frozenset({"hero", "brand_quality", "spec_table", "lifestyle_demo"}),
        )


class TestV3ScottOverrideDivergence(unittest.TestCase):
    """v3 SCOTT_OVERRIDE 屏型 (spec_table / FAQ) 必须 deliberate_dna_divergence=true."""

    def test_spec_table_without_divergence_triggers_warning(self):
        d = _v2_sample()
        # idx=8 (索引 7) 是 spec_table, 删掉 deliberate_dna_divergence
        d["screens"][7].pop("deliberate_dna_divergence", None)
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("SCOTT_OVERRIDE" in x and "spec_table" in x for x in w),
            f"spec_table 缺 deliberate_dna_divergence 应触发警告. warnings={w}",
        )

    def test_FAQ_without_divergence_triggers_warning(self):
        # v3.iter2: 11 屏 fixture, idx=11 (索引 10) 是 FAQ (_V3_EXTRA_ROLES[2])
        d = _v2_sample(screen_count=11)
        d["screens"][10].pop("deliberate_dna_divergence", None)
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("SCOTT_OVERRIDE" in x and "FAQ" in x for x in w),
            f"FAQ 缺 deliberate_dna_divergence 应触发警告. warnings={w}",
        )

    def test_divergence_false_treated_as_missing(self):
        """deliberate_dna_divergence=False 也算未设 (必须 True)."""
        d = _v2_sample()
        d["screens"][7]["deliberate_dna_divergence"] = False
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("SCOTT_OVERRIDE" in x for x in w),
            f"deliberate_dna_divergence=False 应等同 missing. warnings={w}",
        )

    def test_default_fixture_spec_table_has_divergence_true(self):
        """default 8 屏 fixture spec_table 屏 deliberate_dna_divergence=True."""
        d = _v2_sample()
        spec_screen = next(s for s in d["screens"] if s["role"] == "spec_table")
        self.assertEqual(spec_screen.get("deliberate_dna_divergence"), True)




# ──────────────────────────────────────────────────────────────────
# E: v3.iter2 (Scott 4/9 反馈) — 准则 10/11 + 12 屏型 + lifestyle_demo
# ──────────────────────────────────────────────────────────────────
class TestV3iter2RoleUniqueness(unittest.TestCase):
    """v3.iter2 准则 11: 屏型唯一性硬约束 (Scott 改动 5)."""

    def test_duplicate_role_triggers_warning(self):
        """同一 role 出现 2 次必触发 schema 警告."""
        d = _v2_sample()
        # idx=5 (索引 4) 改 detail_zoom → 撞 idx=5 仍是 detail_zoom (无变化)
        # 改 idx=2 (索引 1) feature_wall → detail_zoom, 让 detail_zoom 出现 2 次
        d["screens"][1]["role"] = "detail_zoom"
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("屏型重复" in x and "detail_zoom" in x for x in w),
            f"detail_zoom × 2 应触发屏型重复警告. warnings={w}",
        )

    def test_13_screens_inherits_dup_warning(self):
        """13 屏 fixture 走 _V3_REPEAT_POOL → 必触发屏型重复警告."""
        d = _v2_sample(screen_count=13)
        w = _validate_schema_v2(d)
        self.assertTrue(
            any("屏型重复" in x for x in w),
            f"13 屏 fixture 含重复 role, 必触发警告. warnings={w}",
        )

    def test_unique_8_screens_no_dup_warning(self):
        """合规 8 屏 fixture 全唯一, 不触发屏型重复警告."""
        d = _v2_sample()
        w = _validate_schema_v2(d)
        self.assertFalse(
            any("屏型重复" in x for x in w),
            f"8 屏 fixture 全唯一, 不应触发重复警告. warnings={w}",
        )

    def test_unique_12_screens_no_dup_warning(self):
        """合规 12 屏 fixture (12 屏型一一对应) 不触发屏型重复警告."""
        d = _v2_sample(screen_count=12)
        w = _validate_schema_v2(d)
        self.assertFalse(
            any("屏型重复" in x for x in w),
            f"12 屏 fixture 全唯一, 不应触发重复警告. warnings={w}",
        )




# ──────────────────────────────────────────────────────────────────
# F: v3.2 精修 (Scott v3.2 PASS 后 2 个精修)
# ──────────────────────────────────────────────────────────────────




if __name__ == "__main__":
    unittest.main()
