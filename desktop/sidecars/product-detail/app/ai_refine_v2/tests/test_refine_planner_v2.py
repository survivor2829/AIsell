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
            ),
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


# ──────────────────────────────────────────────────────────────────
# B: plan_v2 主入口 — mock http_fn, 端到端 schema 解析
# ──────────────────────────────────────────────────────────────────
class TestPlanV2HappyPath(unittest.TestCase):

    def test_returns_parsed_v2_dict(self):
        sample = _v2_sample()
        result = plan_v2(
            product_text="DZ600M 无人水面清洁机, 续航 8 小时...",
            product_image_url="https://example.com/p.jpg",
            product_title="DZ600M",
            api_key="dummy",
            http_fn=_mock_http(sample),
        )
        self.assertEqual(result["product_meta"]["name"], sample["product_meta"]["name"])
        self.assertEqual(result["screen_count"], sample["screen_count"])
        self.assertEqual(len(result["screens"]), sample["screen_count"])
        # 关键: 解析出来的就是合规 v2 dict
        self.assertEqual(_validate_schema_v2(result), [])

    def test_no_product_image_url_still_works(self):
        result = plan_v2(
            product_text="DZ600M 无人水面清洁机, 续航 8 小时...",
            product_image_url=None,
            product_title=None,
            api_key="dummy",
            http_fn=_mock_http(_v2_sample()),
        )
        self.assertEqual(_validate_schema_v2(result), [])

    def test_payload_uses_v2_system_prompt(self):
        """plan_v2 的 payload 必须用 SYSTEM_PROMPT_V2 (含'导演视角'关键词), 不是 v1."""
        captured: dict = {}

        def _capture(payload, api_key):
            captured["payload"] = payload
            return _mock_http(_v2_sample())(payload, api_key)

        plan_v2(
            product_text="x", api_key="dummy", http_fn=_capture,
        )
        sys_msg = captured["payload"]["messages"][0]
        self.assertEqual(sys_msg["role"], "system")
        # SYSTEM_PROMPT_V2 应含"导演视角"和"style_dna"两个关键概念
        self.assertIn("导演视角", sys_msg["content"])
        self.assertIn("style_dna", sys_msg["content"])
        # 不应含 v1 的"卖点 → 视觉"判定逻辑
        self.assertNotIn("visual_type", sys_msg["content"])

    def test_payload_uses_higher_temperature(self):
        """v2 默认 temperature=0.7, 不是 v1 的 0.1."""
        captured: dict = {}

        def _capture(payload, api_key):
            captured["payload"] = payload
            return _mock_http(_v2_sample())(payload, api_key)

        plan_v2(product_text="x", api_key="dummy", http_fn=_capture)
        self.assertAlmostEqual(captured["payload"]["temperature"], 0.7, places=2)

    def test_system_prompt_v2_warns_against_brand_logos(self):
        """SYSTEM_PROMPT_V2 必须含品牌 logo 禁令 (PRD §明确排除 §2)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("logo", SYSTEM_PROMPT_V2.lower())
        self.assertIn("失真", SYSTEM_PROMPT_V2)
        # 应明确说由客户后期合成
        self.assertTrue(
            "客户" in SYSTEM_PROMPT_V2 and "合成" in SYSTEM_PROMPT_V2,
            "SYSTEM_PROMPT_V2 应说明 logo 由客户后期合成",
        )

    def test_system_prompt_v2_teaches_chinese_text_quoting(self):
        """SYSTEM_PROMPT_V2 必须教 DeepSeek 用「」标记画面文字 + 强调清晰准确."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 「」必须出现 (中文角括号示范)
        self.assertIn("「」", SYSTEM_PROMPT_V2)
        # 必须含"清晰/准确/sharp/accurate"任一关键词强调
        clarity_keywords = ("sharp", "accurate", "清晰", "no typos")
        hits = [k for k in clarity_keywords if k.lower() in SYSTEM_PROMPT_V2.lower()]
        self.assertTrue(
            len(hits) >= 2,
            f"SYSTEM_PROMPT_V2 至少应含 2 个清晰度关键词, 实际命中 {hits}",
        )

    def test_system_prompt_v2_includes_information_density_rule(self):
        """准则 6: 信息密度规则必须在 (2026-04-27 stage5 step2 修补)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("信息单元", SYSTEM_PROMPT_V2)
        self.assertIn("数据卡", SYSTEM_PROMPT_V2)
        self.assertIn("spec chip", SYSTEM_PROMPT_V2)
        # hero 是特例必须明说 (不强求)
        self.assertIn("hero 屏不强求", SYSTEM_PROMPT_V2)

    def test_system_prompt_v2_includes_layout_mapping_table(self):
        """准则 7: 屏型 → layout 类型映射表必须在 (2026-04-27 stage5 step2 修补)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 3 类 layout 类型关键词 (中文)
        self.assertIn("聚焦镜头", SYSTEM_PROMPT_V2)
        self.assertIn("拼贴", SYSTEM_PROMPT_V2)
        self.assertIn("混合", SYSTEM_PROMPT_V2)
        # 关键 prompt 词汇 (英文, 防 DeepSeek 写成中文)
        self.assertIn("triptych", SYSTEM_PROMPT_V2)                  # scenario
        # v3 (PRD AI_refine_v3.1): vs_compare 从 "split-screen" 改 "side-by-side card comparison"
        self.assertIn("side-by-side card comparison", SYSTEM_PROMPT_V2)  # vs_compare
        self.assertIn("HUD overlays", SYSTEM_PROMPT_V2)              # value_story
        self.assertIn("grid layout", SYSTEM_PROMPT_V2)               # feature_wall


class TestPlanV2InputValidation(unittest.TestCase):

    def test_empty_text_raises(self):
        with self.assertRaises(PlannerError) as ctx:
            plan_v2(product_text="", api_key="dummy")
        self.assertIn("不能为空", str(ctx.exception))

    def test_whitespace_only_raises(self):
        with self.assertRaises(PlannerError):
            plan_v2(product_text="   \n\t  ", api_key="dummy")

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


class TestPlanV2RetryLogic(unittest.TestCase):

    def test_retries_on_http_error_then_raises(self):
        """两次 HTTPError → PlannerError."""
        class _FakeHTTPError(urllib.error.HTTPError):
            def __init__(self):
                super().__init__("http://x", 500, "err", {}, None)
        calls = {"n": 0}

        def _failing(payload, key):
            calls["n"] += 1
            raise _FakeHTTPError()

        with self.assertRaises(PlannerError) as ctx:
            plan_v2(product_text="dummy", api_key="k",
                    http_fn=_failing, max_retries=1)
        self.assertIn("v2 API/解析失败", str(ctx.exception))
        self.assertEqual(calls["n"], 2, "应跑 1 次原 + 1 次重试 = 2 次")

    def test_retries_on_schema_invalid_then_raises(self):
        """两次 schema 不合规 → PlannerError."""
        bad = _v2_sample()
        bad["screen_count"] = 3  # v3 (PRD AI_refine_v3.1): 违反 [8,15]
        bad["screens"] = bad["screens"][:3]
        calls = {"n": 0}

        def _bad(payload, key):
            calls["n"] += 1
            return {
                "choices": [{
                    "message": {"content": json.dumps(bad, ensure_ascii=False)}
                }],
            }

        with self.assertRaises(PlannerError) as ctx:
            plan_v2(product_text="dummy", api_key="k",
                    http_fn=_bad, max_retries=1)
        self.assertIn("v2 schema 不合规", str(ctx.exception))
        self.assertEqual(calls["n"], 2)

    def test_recovers_after_one_retry(self):
        """第 1 次 URLError + 第 2 次合规 → 返回成功结果."""
        good = _v2_sample()
        calls = {"n": 0}

        def _flaky(payload, key):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.URLError("first call fails")
            return _mock_http(good)(payload, key)

        result = plan_v2(product_text="dummy", api_key="k",
                         http_fn=_flaky, max_retries=1)
        self.assertEqual(_validate_schema_v2(result), [])
        self.assertEqual(calls["n"], 2)


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


class TestV3SystemPromptKeywords(unittest.TestCase):
    """v3.iter2 SYSTEM_PROMPT_V2 必含 v3 路线 + 12 屏型 + SCOTT_OVERRIDE + 准则 10/11 关键词."""

    def test_includes_premium_minimalist_v32(self):
        """v3.2: SYSTEM_PROMPT 应含'premium minimalist' (大疆风高级灰路线核心关键词)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("premium minimalist", SYSTEM_PROMPT_V2)

    def test_includes_grayscale_palette_v32(self):
        """v3.2: SYSTEM_PROMPT 应含 grayscale (副关键词) 和具体灰色 hex code."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("grayscale", SYSTEM_PROMPT_V2)
        self.assertIn("#F5F5F7", SYSTEM_PROMPT_V2)  # 浅灰
        self.assertIn("#2C2C2E", SYSTEM_PROMPT_V2)  # 深灰

    def test_includes_4_new_screen_types(self):
        """v3.iter2: 4 个新屏型扩展 (3 个 v3 + 1 个 v3.iter2) 应在 prompt 中明示."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        for new_role in (
            "scenario_grid_2x3", "icon_grid_radial", "FAQ", "lifestyle_demo",
        ):
            with self.subTest(role=new_role):
                self.assertIn(new_role, SYSTEM_PROMPT_V2)

    def test_includes_legal_compliance_constraint(self):
        """准则 8 法律合规约束必须在 (v3.2 精修扩展为 GLOBAL 商业承诺约束)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("LEGAL COMPLIANCE", SYSTEM_PROMPT_V2)
        # v3.2 改用中文表述: 保修期 / 认证 / 时间承诺 / 数量承诺
        self.assertIn("保修期", SYSTEM_PROMPT_V2)
        self.assertIn("认证", SYSTEM_PROMPT_V2)

    def test_includes_scott_override_section(self):
        """准则 9 SCOTT_OVERRIDE 模式必须在."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("SCOTT_OVERRIDE", SYSTEM_PROMPT_V2)
        self.assertIn("deliberate_dna_divergence", SYSTEM_PROMPT_V2)

    def test_screen_count_range_8_to_15(self):
        """SYSTEM_PROMPT_V2 应明确 8-15 屏 (v2 已废弃 6-10)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("8-15", SYSTEM_PROMPT_V2)
        # 已废弃的"6-10 屏" 不应作为有效数字范围出现
        # (但允许在 v2 历史注释里, 不在 v3 主文中)

    def test_v1_system_prompt_unchanged(self):
        """v3 改 v2 不能影响 v1 SYSTEM_PROMPT (回归保护)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT
        self.assertIn("视觉策划总监", SYSTEM_PROMPT)
        self.assertIn("visual_type", SYSTEM_PROMPT)


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


class TestV3iter2NewKeywords(unittest.TestCase):
    """v3.iter2 SYSTEM_PROMPT_V2 必含准则 10/11 + 中文易错词 + lifestyle_demo 关键词."""

    def test_includes_lifestyle_demo_screen_type(self):
        """v3.iter2 加 lifestyle_demo 屏型在 prompt 中."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("lifestyle_demo", SYSTEM_PROMPT_V2)

    def test_includes_rule_10_product_image_frequency(self):
        """v3.iter2 准则 10: 产品图露出频率限制关键词."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 准则 10 标题
        self.assertIn("准则 10", SYSTEM_PROMPT_V2)
        # 关键约束: feature_wall 0 次 + scenario_grid_2x3 ≤ 2 格 + 总数 ≤ 8
        self.assertIn("产品图露出频率", SYSTEM_PROMPT_V2)
        self.assertIn("≤ 8", SYSTEM_PROMPT_V2)

    def test_includes_rule_11_role_uniqueness(self):
        """v3.iter2 准则 11: 屏型唯一性硬约束关键词."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("准则 11", SYSTEM_PROMPT_V2)
        self.assertIn("屏型唯一性", SYSTEM_PROMPT_V2)

    def test_includes_chinese_typo_guard(self):
        """v3.iter2 准则 4 中文易错词显式书写规则 ('5G/LTE 移动物联网')."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("移动物联网", SYSTEM_PROMPT_V2)
        self.assertIn("中文易错词", SYSTEM_PROMPT_V2)

    def test_eleven_rules_section_header(self):
        """SYSTEM_PROMPT_V2 标题应是 '十一个核心准则' (v3 9 个 → v3.iter2 11 个)."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        self.assertIn("十一个核心准则", SYSTEM_PROMPT_V2)


# ──────────────────────────────────────────────────────────────────
# F: v3.2 精修 (Scott v3.2 PASS 后 2 个精修)
# ──────────────────────────────────────────────────────────────────
class TestV3_2LifestyleDemoRequired(unittest.TestCase):
    """v3.2 精修反馈 1: lifestyle_demo 加进必出屏 (Scott 强需产品使用效果展示)."""

    def test_lifestyle_demo_in_required_roles(self):
        from ai_refine_v2.refine_planner import _REQUIRED_ROLES_V2
        self.assertIn("lifestyle_demo", _REQUIRED_ROLES_V2)

    def test_required_roles_count_4(self):
        """必出屏从 v3 的 3 个 (hero/brand_quality/spec_table) → 4 个 (+lifestyle_demo)."""
        from ai_refine_v2.refine_planner import _REQUIRED_ROLES_V2
        self.assertEqual(len(_REQUIRED_ROLES_V2), 4)

    def test_system_prompt_marks_lifestyle_demo_required(self):
        """SYSTEM_PROMPT_V2 准则 3 必出屏列表应含 lifestyle_demo."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 准则 3 段必出屏列表包含 lifestyle_demo
        idx_required = SYSTEM_PROMPT_V2.find("必出屏 (任何产品都生成")
        self.assertGreater(idx_required, 0, "准则 3 必出屏段应存在")
        idx_high = SYSTEM_PROMPT_V2.find("高优先级屏", idx_required)
        required_section = SYSTEM_PROMPT_V2[idx_required:idx_high]
        self.assertIn("lifestyle_demo", required_section,
                      "lifestyle_demo 必须在准则 3 必出屏列表里")


class TestV3_2GlobalCommitmentExtraction(unittest.TestCase):
    """v3.2 精修反馈 2: 商业承诺真实性约束扩展为 GLOBAL (法律合规, 适用所有屏型).

    旧 v3.iter2 仅 FAQ 屏适用, 实测 DZ70X brand_quality 屏出现"41 年品牌保证"
    "全国 200+ 售后网点" 虚假宣传 → 法律风险. v3.2 扩展到所有屏型.
    """

    def test_system_prompt_includes_global_commitment_rule(self):
        """准则 8 标题应说"GLOBAL 法律合规, 适用所有屏型"."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 准则 8 标题
        self.assertIn("商业承诺真实性硬约束", SYSTEM_PROMPT_V2)
        self.assertIn("GLOBAL", SYSTEM_PROMPT_V2)
        # 旧 v3 LEGAL COMPLIANCE 关键词保留
        self.assertIn("LEGAL COMPLIANCE", SYSTEM_PROMPT_V2)

    def test_system_prompt_lists_5_commitment_categories(self):
        """5 类商业承诺都在 prompt 中."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        for category in (
            "时间承诺",      # 类别 1
            "数量承诺",      # 类别 2
            "资质认证",      # 类别 3
            "退换政策",      # 类别 4
            "具体数字承诺",  # 类别 5
        ):
            with self.subTest(category=category):
                self.assertIn(category, SYSTEM_PROMPT_V2)

    def test_system_prompt_includes_dz70x_real_examples(self):
        """SYSTEM_PROMPT 含 DZ70X iter1 实测的虚假宣传反例 (41 年 / 200+) 作为约束依据."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # 反例 1: 41 年品牌 (文案没写, DeepSeek 编造)
        self.assertIn("41 年", SYSTEM_PROMPT_V2)
        # 反例 2: 全国 200+ 售后网点
        self.assertIn("200+", SYSTEM_PROMPT_V2)

    def test_system_prompt_provides_safe_fallback_phrases(self):
        """prompt 应提供"无具体数字"的 fallback 通用文案选项."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # fallback: 通用品牌话术 (不含具体数字)
        self.assertIn("专业品质", SYSTEM_PROMPT_V2)
        self.assertIn("品质保障", SYSTEM_PROMPT_V2)

    def test_system_prompt_explicit_brand_quality_caveat(self):
        """明确指出 brand_quality 屏不能自动加品牌承诺类话术."""
        from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2
        # brand_quality 屏不能加 "品牌保证" / "全国售后" 类话术
        self.assertIn("brand_quality", SYSTEM_PROMPT_V2)
        # 显式禁止 "12315 投诉" 法律风险
        self.assertIn("12315", SYSTEM_PROMPT_V2)


if __name__ == "__main__":
    unittest.main()
