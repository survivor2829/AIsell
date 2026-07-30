"""generate_v2 单测: 全 mock 验证, 0 真调 APIMart (PRD §阶段二·任务 2.1).

测试覆盖:
  [Public API shape] 3 测   — generate_v2 callable, dataclass/exception 共用
  [_build_blocks_v2] 4 测   — screens[] → block dict 列表
  [Happy path]       5 测   — 全成功 / 顺序 / size 默认 / cost 默认+自定义
  [Failure paths]    4 测   — Hero raise / Hero 重试成功 / SP 失败降级 / 混合
  [Input validation] 5 测   — empty / 缺 screens / 非 list / 无 key 无 mock / screens 空
  [v1↔v2 isolation]  2 测   — schema 不应跨调用

总 23 测. 全部 api_call_fn 注入 mock, 零成本.
"""
from __future__ import annotations
import time
import unittest
from unittest import mock

from ai_refine_v2.refine_generator import (
    BlockResult,
    GenerationResult,
    HeroFailure,
    generate,
    generate_v2,
    _V2_SIZE_DEFAULT,
    _build_blocks_v2,
)


# ── 黄金 fixture ──────────────────────────────────────────────────
def _v2_planning(n: int = 6, hero_role: str = "hero") -> dict:
    """构造合规的 v2 planning dict (用于 generate_v2 测试)."""
    screens = []
    for i in range(1, n + 1):
        screens.append({
            "idx": i,
            "role": hero_role if i == 1 else f"screen_role_{i}",
            "title": f"屏 {i}",
            # 长 prompt 模拟导演视角 (≥200 字符 plan_v2 schema 已守门)
            "prompt": (
                f"Screen {i} cinematic prompt with industrial yellow body, "
                f"low-angle hero shot, bold white display headline 「屏{i}」, "
                f"all chinese text render sharp, no typos. "
                * 3
            ),
        })
    return {
        "product_meta": {
            "name": "TestBot DZ-Test",
            "category": "设备类",
            "primary_color": "industrial yellow",
            "key_visual_parts": ["body", "wheels"],
        },
        "style_dna": {
            "color_palette": "test palette with multiple colors and tones",
            "lighting": "test lighting from upper-left with cool fill",
            "composition_style": "test asymmetric editorial layout with negative space",
            "mood": "test confident B2B premium",
            "typography_hint": "test sans-serif",
        },
        "screen_count": n,
        "screens": screens,
    }


# ──────────────────────────────────────────────────────────────────
# A: Public API shape
# ──────────────────────────────────────────────────────────────────
class TestPublicAPIShapeV2(unittest.TestCase):

    def test_generate_v2_callable(self):
        self.assertTrue(callable(generate_v2))

    def test_dataclass_and_exception_shared_with_v1(self):
        """v2 复用 v1 的 BlockResult / GenerationResult / HeroFailure (60 单测保护)."""
        # 字段一致性 — 万一以后有人乱改, 这里报警
        from dataclasses import fields
        names = {f.name for f in fields(BlockResult)}
        self.assertEqual(
            names,
            {"block_id", "visual_type", "prompt", "image_url", "error", "placeholder"},
            "BlockResult 字段被改了, 60 单测会崩",
        )
        self.assertTrue(issubclass(HeroFailure, RuntimeError))

    def test_v2_default_size_is_3_4(self):
        """PRD §阶段二: 1536×2048 锁定. _V2_SIZE_DEFAULT 必须是 '3:4'."""
        self.assertEqual(_V2_SIZE_DEFAULT, "3:4")


# ──────────────────────────────────────────────────────────────────
# B: _build_blocks_v2
# ──────────────────────────────────────────────────────────────────
class TestBuildBlocksV2(unittest.TestCase):

    def test_screens_to_blocks_in_order(self):
        planning = _v2_planning(n=6)
        blocks = _build_blocks_v2(planning)
        self.assertEqual(len(blocks), 6)
        # 顺序按 screens 索引
        for i, b in enumerate(blocks):
            self.assertIn(f"screen_{i+1:02d}", b["block_id"])

    def test_first_screen_marked_hero(self):
        planning = _v2_planning(n=6, hero_role="hero")
        blocks = _build_blocks_v2(planning)
        self.assertTrue(blocks[0]["is_hero"])
        for b in blocks[1:]:
            self.assertFalse(b["is_hero"])

    def test_block_id_includes_idx_and_role(self):
        planning = _v2_planning(n=3)
        blocks = _build_blocks_v2(planning)
        # screen_01_hero / screen_02_screen_role_2 / screen_03_screen_role_3
        self.assertEqual(blocks[0]["block_id"], "screen_01_hero")
        self.assertEqual(blocks[1]["block_id"], "screen_02_screen_role_2")

    def test_skips_non_dict_screen_entries(self):
        planning = {
            "screens": [
                {"idx": 1, "role": "hero", "title": "x", "prompt": "p"},
                "garbage",  # 非 dict
                None,
                {"idx": 2, "role": "feature_wall", "title": "y", "prompt": "p2"},
            ],
        }
        blocks = _build_blocks_v2(planning)
        self.assertEqual(len(blocks), 2, "非 dict 应跳过")
        self.assertEqual(blocks[0]["block_id"], "screen_01_hero")
        self.assertEqual(blocks[1]["block_id"], "screen_02_feature_wall")


# ──────────────────────────────────────────────────────────────────
# C: Happy path
# ──────────────────────────────────────────────────────────────────
class TestGenerateV2HappyPath(unittest.TestCase):

    def test_all_screens_succeed_8_screens(self):
        """8 屏全成功 → blocks 完整, hero_success, cost 累计."""
        call_log: list[str] = []

        def mock_ok(prompt, img_url, api_key, thinking, size):
            call_log.append(prompt[:30])
            return f"https://fake.cdn/v2_screen_{len(call_log)}.png"

        result = generate_v2(
            _v2_planning(n=8),
            api_key="test", api_call_fn=mock_ok,
            max_retries_hero=0, max_retries_sp=0,
        )
        self.assertTrue(result.hero_success)
        self.assertEqual(len(result.blocks), 8)
        self.assertTrue(all(b.image_url for b in result.blocks))
        self.assertTrue(all(not b.placeholder for b in result.blocks))
        self.assertEqual(len(call_log), 8)
        self.assertAlmostEqual(result.total_cost_rmb, 8 * 0.70, places=2)
        self.assertEqual(len(result.errors), 0)

    def test_block_order_preserved_under_concurrency(self):
        """ThreadPool 完成顺序乱 (人为延迟), result.blocks 仍按 screens.idx."""
        def mock_variable_latency(prompt, img_url, api_key, thinking, size):
            # 提取 idx (从 prompt 里 「屏N」 标志找)
            import re
            m = re.search(r"「屏(\d+)」", prompt)
            idx = int(m.group(1)) if m else 99
            # 后面屏故意比前面屏快完成 → 触发乱序
            time.sleep(0.001 if idx > 3 else 0.05)
            return f"https://fake/v2_{idx}.png"

        result = generate_v2(
            _v2_planning(n=6),
            api_key="test", api_call_fn=mock_variable_latency,
            max_retries_hero=0, max_retries_sp=0, concurrency=3,
        )
        # 排序后 block_id 必须按 idx 升序
        bids = [b.block_id for b in result.blocks]
        self.assertEqual(bids, [f"screen_{i:02d}_" + ("hero" if i == 1 else f"screen_role_{i}")
                                for i in range(1, 7)])

    def test_default_size_passed_to_api(self):
        """size 默认 '3:4' 传给 api_call_fn (PRD §阶段二)."""
        captured: dict = {"sizes": []}

        def mock_capture(prompt, img_url, api_key, thinking, size):
            captured["sizes"].append(size)
            return "https://fake/x.png"

        generate_v2(
            _v2_planning(n=3),
            api_key="test", api_call_fn=mock_capture,
            max_retries_hero=0, max_retries_sp=0,
        )
        self.assertEqual(set(captured["sizes"]), {"3:4"},
                         "v2 应锁定 size='3:4' (1536×2048)")

    def test_cost_tracking_default_per_call(self):
        """默认 cost_per_call_rmb=¥0.70 × N."""
        def mock_ok(*a, **kw):
            return "https://fake/x.png"
        result = generate_v2(
            _v2_planning(n=5),
            api_key="test", api_call_fn=mock_ok,
            max_retries_hero=0, max_retries_sp=0,
        )
        self.assertAlmostEqual(result.total_cost_rmb, 5 * 0.70, places=2)

    def test_cost_tracking_with_custom_per_call(self):
        """cost_per_call_rmb 可覆盖默认值."""
        def mock_ok(*a, **kw):
            return "https://fake/x.png"
        result = generate_v2(
            _v2_planning(n=4),
            api_key="test", api_call_fn=mock_ok,
            max_retries_hero=0, max_retries_sp=0,
            cost_per_call_rmb=1.50,
        )
        self.assertAlmostEqual(result.total_cost_rmb, 4 * 1.50, places=2)


# ──────────────────────────────────────────────────────────────────
# D: Failure paths (PRD §7)
# ──────────────────────────────────────────────────────────────────
class TestGenerateV2Failure(unittest.TestCase):

    def test_hero_fails_raises_hero_failure(self):
        """第 1 屏重试上限后仍挂 → HeroFailure, SP 不该被调."""
        sp_calls: list[int] = []

        def mock_hero_fail(prompt, *a, **kw):
            # 第 1 屏标志: prompt 含 「屏1」
            if "「屏1」" in prompt:
                raise RuntimeError("APIMart 500 hero down")
            sp_calls.append(1)
            return "https://fake/sp.png"

        with self.assertRaises(HeroFailure) as ctx:
            generate_v2(
                _v2_planning(n=4),
                api_key="test", api_call_fn=mock_hero_fail,
                max_retries_hero=1, max_retries_sp=0,
            )
        self.assertIn("500", str(ctx.exception))
        self.assertIn("整单 fail", str(ctx.exception))
        self.assertEqual(len(sp_calls), 0, "Hero 失败 → SP 不应被调用")

    def test_hero_retries_then_succeeds(self):
        """Hero 第 1 次失败 + 第 2 次成功 → hero_success=True."""
        attempts = {"n": 0}

        def mock_transient(prompt, *a, **kw):
            if "「屏1」" in prompt:
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise RuntimeError("transient hero fail")
                return "https://fake/hero_recover.png"
            return "https://fake/sp.png"

        result = generate_v2(
            _v2_planning(n=2),
            api_key="test", api_call_fn=mock_transient,
            max_retries_hero=2, max_retries_sp=0,
        )
        self.assertTrue(result.hero_success)
        self.assertEqual(attempts["n"], 2, "Hero 应调 2 次 (初次 + 重试 1)")
        self.assertEqual(result.blocks[0].image_url, "https://fake/hero_recover.png")

    def test_sp_fails_returns_placeholder_not_blocking(self):
        """Hero 成功 + 所有 SP 失败 → placeholder=True, 不 raise."""
        call_n = {"n": 0}

        def mock_hero_only(prompt, *a, **kw):
            call_n["n"] += 1
            if "「屏1」" in prompt:
                return "https://fake/hero.png"
            raise RuntimeError("SP network down")

        result = generate_v2(
            _v2_planning(n=4),
            api_key="test", api_call_fn=mock_hero_only,
            max_retries_hero=0, max_retries_sp=0, concurrency=1,
        )
        self.assertTrue(result.hero_success)
        self.assertEqual(len(result.blocks), 4)
        self.assertIsNotNone(result.blocks[0].image_url)
        self.assertFalse(result.blocks[0].placeholder)
        for sp in result.blocks[1:]:
            self.assertIsNone(sp.image_url)
            self.assertTrue(sp.placeholder, "SP 失败必须 placeholder=True")
            self.assertIsNotNone(sp.error)
        self.assertEqual(len(result.errors), 3, "3 个 SP 失败应 3 条 error")
        # 只 hero 成功收 ¥0.70
        self.assertAlmostEqual(result.total_cost_rmb, 0.70, places=2)

    def test_some_sp_fail_some_succeed(self):
        """混合成功/失败 → 各按结果状态返回, 不阻塞整单."""
        def mock_mixed(prompt, *a, **kw):
            # 屏 1, 3 成功; 屏 2, 4 失败
            if "「屏1」" in prompt or "「屏3」" in prompt:
                return f"https://fake/ok.png"
            raise RuntimeError("SP fail")

        result = generate_v2(
            _v2_planning(n=4),
            api_key="test", api_call_fn=mock_mixed,
            max_retries_hero=0, max_retries_sp=0, concurrency=3,
        )
        self.assertTrue(result.hero_success)
        # 屏 1 (hero) 成功
        self.assertIsNotNone(result.blocks[0].image_url)
        # 屏 2 失败
        self.assertIsNone(result.blocks[1].image_url)
        self.assertTrue(result.blocks[1].placeholder)
        # 屏 3 成功
        self.assertIsNotNone(result.blocks[2].image_url)
        # 屏 4 失败
        self.assertIsNone(result.blocks[3].image_url)
        self.assertTrue(result.blocks[3].placeholder)
        # cost: 屏 1 + 屏 3 = ¥1.40
        self.assertAlmostEqual(result.total_cost_rmb, 1.40, places=2)


# ──────────────────────────────────────────────────────────────────
# E: Input validation
# ──────────────────────────────────────────────────────────────────
class TestGenerateV2InputValidation(unittest.TestCase):

    def test_empty_planning_raises(self):
        with self.assertRaises(ValueError) as ctx:
            generate_v2({}, api_key="x", api_call_fn=lambda *a, **kw: "x")
        self.assertIn("非空 dict", str(ctx.exception))

    def test_none_planning_raises(self):
        with self.assertRaises(ValueError):
            generate_v2(None, api_key="x", api_call_fn=lambda *a, **kw: "x")  # type: ignore

    def test_missing_screens_raises(self):
        bad = {"product_meta": {}, "style_dna": {}}  # 缺 screens
        with self.assertRaises(ValueError) as ctx:
            generate_v2(bad, api_key="x", api_call_fn=lambda *a, **kw: "x")
        self.assertIn("screens", str(ctx.exception))

    def test_screens_not_list_raises(self):
        bad = {"screens": "not a list"}
        with self.assertRaises(ValueError):
            generate_v2(bad, api_key="x", api_call_fn=lambda *a, **kw: "x")

    def test_no_api_key_no_mock_raises(self):
        """无 key 且无 api_call_fn → ValueError (mock 注入路径不受影响)."""
        import os as _os
        old_refine = _os.environ.pop("REFINE_API_KEY", None)
        old_gpt = _os.environ.pop("GPT_IMAGE_API_KEY", None)
        try:
            with self.assertRaises(ValueError) as ctx:
                generate_v2(_v2_planning(n=2), api_key=None)
            self.assertIn("REFINE_API_KEY", str(ctx.exception))
            self.assertIn("GPT_IMAGE_API_KEY", str(ctx.exception))
        finally:
            if old_refine is not None:
                _os.environ["REFINE_API_KEY"] = old_refine
            if old_gpt is not None:
                _os.environ["GPT_IMAGE_API_KEY"] = old_gpt

    def test_empty_screens_list_raises(self):
        """screens=[] 应 raise."""
        bad = {"screens": []}
        with self.assertRaises(ValueError) as ctx:
            generate_v2(bad, api_key="x", api_call_fn=lambda *a, **kw: "x")
        self.assertIn("无屏可生成", str(ctx.exception))


# ──────────────────────────────────────────────────────────────────
# F: v1 ↔ v2 schema isolation
# ──────────────────────────────────────────────────────────────────
class TestV1V2SchemaIsolation(unittest.TestCase):
    """v1 schema 不应被 generate_v2 接受, 反之亦然."""

    def _v1_planning(self) -> dict:
        return {
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

    def test_v1_planning_fails_v2_generate(self):
        """v1 schema 喂 generate_v2 → ValueError (缺 screens)."""
        with self.assertRaises(ValueError) as ctx:
            generate_v2(self._v1_planning(), api_key="x",
                        api_call_fn=lambda *a, **kw: "x")
        self.assertIn("screens", str(ctx.exception))

    def test_v2_planning_fails_v1_generate(self):
        """v2 schema 喂 v1 generate → ValueError (缺 selling_points/planning)."""
        with self.assertRaises(ValueError) as ctx:
            generate(_v2_planning(n=3), api_key="x",
                     api_call_fn=lambda *a, **kw: "x")
        # v1 generate 校验 product_meta / selling_points / planning 三大字段
        # v2 planning 含 product_meta + style_dna + screens, 缺 selling_points 和 planning
        msg = str(ctx.exception).lower()
        self.assertTrue("selling_points" in msg or "planning" in msg)


# ──────────────────────────────────────────────────────────────────
# G: v3 (PRD AI_refine_v3.1) cutout_whitelist 参数 — per-screen 喂图控制
# ──────────────────────────────────────────────────────────────────
def _v3_planning_with_real_roles() -> dict:
    """构造 8 屏 planning, role 是 v3.iter2 12 屏型成员 (whitelist 行为测试用).

    v3.iter2 (Scott 改动 1+4): 默认白名单加了 spec_table 和 lifestyle_demo,
    现在唯一真正不喂图的屏型是 FAQ. 故 fixture idx 8 = FAQ.
    """
    roles = ["hero", "feature_wall", "scenario", "vs_compare",
             "detail_zoom", "value_story", "brand_quality", "FAQ"]
    screens = []
    for i, role in enumerate(roles, start=1):
        screens.append({
            "idx": i,
            "role": role,
            "title": f"屏 {i}",
            "prompt": (
                f"Screen {i} cinematic prompt with industrial yellow body "
                f"and bold display headline. " * 5
            ),
        })
    return {
        "product_meta": {
            "name": "X", "category": "设备类",
            "primary_color": "yellow", "key_visual_parts": ["a", "b"],
        },
        "style_dna": {
            "color_palette": "test palette tone tone tone tone tone tone",
            "lighting": "test lighting upper-left cool fill warm rim",
            "composition_style": "test asymmetric editorial layout space",
            "mood": "test confident B2B premium",
            "typography_hint": "test sans-serif",
        },
        "screen_count": 8,
        "screens": screens,
    }


class TestCutoutWhitelistV3(unittest.TestCase):
    """v3 generate_v2 cutout_whitelist 参数 — per-screen 喂图控制 (PRD §5.1, §9.3)."""

    def _capture(self, planning, cutout="data:image/png;base64,iVBORw0KGgo=",
                 **kwargs):
        """跑 generate_v2, 抓每屏 image_data_url 是否非空."""
        seen: dict[int, bool] = {}

        def _fn(prompt, image_data_url, key, thinking, size):
            import re
            m = re.search(r"Screen (\d+) ", prompt)
            idx = int(m.group(1)) if m else 99
            seen[idx] = bool(image_data_url)
            return f"https://fake/{idx}.png"

        generate_v2(
            planning, product_cutout_url=cutout, api_key="dummy",
            api_call_fn=_fn, concurrency=4,
            max_retries_hero=0, max_retries_sp=0,
            **kwargs,
        )
        return seen

    def test_default_whitelist_excludes_FAQ(self):
        """cutout_whitelist=None → v3.iter2 默认 (FAQ 唯一不喂; spec_table 改回喂图)."""
        seen = self._capture(_v3_planning_with_real_roles())
        # idx 1-7: hero/feature_wall/scenario/vs_compare/detail_zoom/value_story/brand_quality
        for idx in range(1, 8):
            with self.subTest(idx=idx):
                self.assertTrue(seen[idx], f"idx {idx} 应在默认白名单内, 应喂图")
        # idx 8 (FAQ) 不应喂 — v3.iter2 准则 10 硬约束: FAQ 0 次产品图
        self.assertFalse(seen[8], "idx 8 FAQ 不在默认白名单, 不应喂图")

    def _planning_with_extra_role(self, role: str, prompt_text: str) -> dict:
        """复用 _v3_planning_with_real_roles 8 屏 + 追加第 9 屏 (指定 role)."""
        planning = _v3_planning_with_real_roles()
        planning["screens"].append({
            "idx": 9,
            "role": role,
            "title": "屏 9",
            "prompt": f"Screen 9 {prompt_text}. " * 4,
        })
        planning["screen_count"] = 9
        return planning

    def test_default_whitelist_includes_spec_table_iter2(self):
        """v3.iter2 (Scott 改动 4): spec_table 改回默认白名单 (上半部产品图 + 下方参数)."""
        seen = self._capture(self._planning_with_extra_role(
            "spec_table", "industrial spec sheet with product hero shot top half"))
        self.assertTrue(seen[9], "v3.iter2: spec_table 改回默认白名单, idx 9 应喂图")

    def test_default_whitelist_includes_lifestyle_demo_iter2(self):
        """v3.iter2 (Scott 改动 3): lifestyle_demo 在默认白名单 (真人 + 产品)."""
        seen = self._capture(self._planning_with_extra_role(
            "lifestyle_demo", "engineer using product in scene with cool studio lighting"))
        self.assertTrue(seen[9], "v3.iter2: lifestyle_demo 在默认白名单, idx 9 应喂图")

    def test_whitelist_only_hero(self):
        """cutout_whitelist={'hero'} → 只 hero 喂."""
        seen = self._capture(
            _v3_planning_with_real_roles(),
            cutout_whitelist={"hero"},
        )
        self.assertTrue(seen[1], "hero 应喂图")
        for idx in range(2, 9):
            with self.subTest(idx=idx):
                self.assertFalse(seen[idx], f"idx {idx} 不在 whitelist, 不应喂图")

    def test_whitelist_empty_set_no_screen_fed(self):
        """cutout_whitelist=set() → 全不喂."""
        seen = self._capture(
            _v3_planning_with_real_roles(),
            cutout_whitelist=set(),
        )
        for idx in range(1, 9):
            with self.subTest(idx=idx):
                self.assertFalse(seen[idx], f"empty whitelist idx {idx} 不应喂图")

    def test_whitelist_custom_set(self):
        """cutout_whitelist={'hero','FAQ'} → 这 2 屏喂 (自定义白名单优先于默认)."""
        seen = self._capture(
            _v3_planning_with_real_roles(),
            cutout_whitelist={"hero", "FAQ"},
        )
        self.assertTrue(seen[1], "hero 在 whitelist 应喂图")
        self.assertTrue(seen[8], "FAQ 在 whitelist (即使它通常不喂) 应喂图 — 自定义优先")
        for idx in range(2, 8):
            with self.subTest(idx=idx):
                self.assertFalse(seen[idx], f"idx {idx} 不在 whitelist, 不应喂图")

    def test_no_cutout_url_no_screen_fed_even_with_whitelist(self):
        """product_cutout_url=None → 即使 whitelist 包含也不喂."""
        seen = self._capture(
            _v3_planning_with_real_roles(),
            cutout=None,
            cutout_whitelist={"hero", "feature_wall"},
        )
        for idx in range(1, 9):
            with self.subTest(idx=idx):
                self.assertFalse(seen[idx], f"cutout=None 下 idx {idx} 不应喂图")


# ──────────────────────────────────────────────────────────────────
# H: v3 (PRD AI_refine_v3.1 §5.2) INJECTION_PREFIX 注入逻辑
# ──────────────────────────────────────────────────────────────────
class TestInjectionPrefixV3(unittest.TestCase):
    """v3 喂图屏 prompt 开头自动 prepend "Image 1 is the reference product cutout..." (PRD §5.2)."""

    def _capture_prompts(self, planning, cutout="data:image/png;base64,iVBORw0KGgo=",
                          **kwargs) -> dict[int, tuple[str, bool]]:
        """跑 generate_v2, 抓每屏的 (prompt, has_image_data_url)."""
        captured: dict[int, tuple[str, bool]] = {}

        def _fn(prompt, image_data_url, key, thinking, size):
            import re
            m = re.search(r"Screen (\d+) ", prompt)
            idx = int(m.group(1)) if m else 99
            captured[idx] = (prompt, bool(image_data_url))
            return f"https://fake/{idx}.png"

        generate_v2(
            planning, product_cutout_url=cutout, api_key="dummy",
            api_call_fn=_fn, concurrency=4,
            max_retries_hero=0, max_retries_sp=0,
            **kwargs,
        )
        return captured

    def test_fed_screens_have_injection_prefix(self):
        """喂图屏 prompt 开头必须含 'Image 1 is the reference product cutout'."""
        captured = self._capture_prompts(_v3_planning_with_real_roles())
        # idx 1-7 在默认 whitelist (hero/feature_wall/scenario/vs_compare/detail_zoom/value_story/brand_quality)
        for idx in range(1, 8):
            with self.subTest(idx=idx):
                prompt, fed = captured[idx]
                self.assertTrue(fed, f"idx {idx} 应喂图")
                self.assertTrue(
                    prompt.startswith("Image 1 is the AUTHORITATIVE source"),
                    f"idx {idx} 喂图屏 prompt 必须以注入语开头, 实际开头 100 字符: {prompt[:100]!r}",
                )

    def test_unfed_screens_do_not_have_injection_prefix(self):
        """不喂图屏 (v3.iter2: FAQ) prompt 不能带注入语 (image_urls 不存在, 注入会误导模型)."""
        captured = self._capture_prompts(_v3_planning_with_real_roles())
        # idx 8 FAQ 不在 v3.iter2 默认 whitelist (准则 10: FAQ 0 次产品图)
        prompt, fed = captured[8]
        self.assertFalse(fed, "FAQ 不应喂图")
        self.assertNotIn(
            "Image 1 is the AUTHORITATIVE source", prompt,
            "FAQ 不喂图屏不应有注入语 prefix",
        )

    def test_no_cutout_no_injection_anywhere(self):
        """product_cutout_url=None → 全屏都不喂图, 全屏都没注入语."""
        captured = self._capture_prompts(
            _v3_planning_with_real_roles(), cutout=None,
        )
        for idx in range(1, 9):
            with self.subTest(idx=idx):
                prompt, fed = captured[idx]
                self.assertFalse(fed, f"cutout=None 下 idx {idx} 不应喂图")
                self.assertNotIn(
                    "Image 1 is the AUTHORITATIVE source", prompt,
                    f"idx {idx} 无 cutout 时不应有注入语",
                )


class TestColorAnchorDualImage(unittest.TestCase):
    """v3.2.2 双图 + ENV 三档开关.

    color_anchor 注入路径:
      ENV=on (默认)  + anchor 成功 → 双图 + TEMPLATE prefix (含 hex)
      ENV=b1_only   + anchor 成功 → 单图 + TEMPLATE prefix (含 hex)
      ENV=off       + color 任何 → 单图 + LEGACY prefix (无 hex)
      ENV 任何       + anchor 失败 → 单图 + LEGACY prefix (跟 v3.2.1 一致)
    """

    def _make_anchor(self) -> "ColorAnchor":
        from ai_refine_v2.color_extractor import ColorAnchor
        return ColorAnchor(
            primary_hex="#6B7280",
            palette_hex=["#6B7280", "#3A3D42", "#D8D8D8"],
            confidence=0.85,
            swatch_png_bytes=b"\x89PNG\r\n\x1a\n_FAKE_SWATCH_BYTES_",
        )

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "on"})
    def test_env_on_dual_image_with_hex(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertIn("#6B7280", prompt, "ENV=on 时 prompt 应含 primary_hex")
        self.assertIn("Image 2 is a pure-color reference swatch", prompt)
        self.assertIsInstance(img_url, list, "ENV=on 应双图 list")
        self.assertEqual(len(img_url), 2)

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "b1_only"})
    def test_env_b1_only_single_image_with_hex(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertIn("#6B7280", prompt, "ENV=b1_only 时 prompt 仍应含 hex")
        # b1_only 是字符串 (str) 不是 list
        self.assertIsInstance(img_url, str, "ENV=b1_only 应单图 str")

    @mock.patch.dict("os.environ", {"COLOR_ANCHOR_DUAL_IMAGE": "off"})
    def test_env_off_falls_back_to_legacy(self):
        from ai_refine_v2.refine_generator import _generate_one_block_v2
        block = {"block_id": "test", "visual_type": "hero", "is_hero": True,
                 "prompt": "test prompt " * 20, "title": "t"}
        captured = []

        def fake_call(prompt, img_url, api_key, thinking, size):
            captured.append((prompt, img_url))
            return "https://example.com/result.png"

        _generate_one_block_v2(
            block, "data:image/png;base64,FAKE_CUTOUT", "key", fake_call,
            max_retries=0, thinking="medium", size="3:4",
            color_anchor=self._make_anchor(),
        )

        prompt, img_url = captured[0]
        self.assertNotIn("#6B7280", prompt, "ENV=off 时 prompt 不应含 hex")
        self.assertNotIn("Image 2", prompt, "ENV=off 时不应提 Image 2")
        self.assertIsInstance(img_url, str, "ENV=off 应单图 str")


class TestToDataUrlResize(unittest.TestCase):
    """_to_data_url 文件兜底: 过大文件 resize 防 APIMart 413/超时.

    实测案例: HE150-60 透图 33MB cutout 直接 base64 → 45MB data URL → API 拒.
    Patch 后: max_bytes=5MB 触发 Pillow resize 到 max_dim=1024 长边重压.
    """

    def test_passthrough_remote_url_unchanged(self):
        """http(s):// + data:... 直接返回, 不读盘不 resize."""
        from ai_refine_v2.refine_generator import _to_data_url
        for url in ("https://example.com/x.png", "data:image/png;base64,abc"):
            self.assertEqual(_to_data_url(url), url, f"{url!r} 应原样返回")

    def test_small_file_no_resize(self):
        """文件 < max_bytes 时原样 base64, 不调 PIL."""
        from ai_refine_v2.refine_generator import _to_data_url
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from PIL import Image
        import base64

        with TemporaryDirectory() as td:
            p = Path(td) / "small.png"
            Image.new("RGB", (100, 100), (50, 100, 200)).save(p, "PNG")
            url = _to_data_url(str(p))
            self.assertTrue(url.startswith("data:image/png;base64,"))
            decoded = base64.b64decode(url.split(",", 1)[1])
            self.assertEqual(decoded, p.read_bytes(),
                "小文件应原样 base64, 不重压")

    def test_oversize_file_resized(self):
        """文件 > max_bytes 触发 resize, 长边 ≤ max_dim, 仍是合法图."""
        from ai_refine_v2.refine_generator import _to_data_url
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from PIL import Image
        import base64
        import io

        with TemporaryDirectory() as td:
            p = Path(td) / "big.png"
            # 2000x1500 RGB, 用低 max_bytes=100 强制触发 resize
            Image.new("RGB", (2000, 1500), (180, 90, 30)).save(p, "PNG")

            url = _to_data_url(str(p), max_bytes=100, max_dim=512)
            self.assertTrue(url.startswith(("data:image/png;base64,",
                                            "data:image/jpeg;base64,")))
            decoded = base64.b64decode(url.split(",", 1)[1])
            img = Image.open(io.BytesIO(decoded))
            self.assertLessEqual(max(img.size), 512,
                f"长边应 ≤ max_dim=512, 实际 {img.size}")
            self.assertLess(len(decoded), p.stat().st_size,
                "resize 后体积应小于原图")


if __name__ == "__main__":
    unittest.main()
