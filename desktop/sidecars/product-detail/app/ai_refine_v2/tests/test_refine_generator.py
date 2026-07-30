"""W2 Day 3-5 · refine_generator 真功能单测.

目的: 验证 API shape + 模板渲染 + generate() 完整业务逻辑.
通过 api_call_fn 注入 mock, **不调真实 gpt-image-2 API** (零成本可重复).

覆盖:
  [Shape]        3 个测: 公开符号, dataclass 结构, Exception 继承
  [Template]     5 个测: 3 个 visual_type 渲染 + STYLE_BASE 追加 + 未知类型抛
  [Integration]  1 个测: refine_planner → render 数据流通畅
  [Real funcs]   7 个测 (W2 Day 3-5):
                   - happy path (3 block 全成功)
                   - Hero 重试耗尽 → HeroFailure
                   - Hero 重试一次后成功
                   - SP 失败 → placeholder=True, 不阻塞
                   - block_order 顺序 (ThreadPool 乱序完成时仍按 planning 排序)
                   - 成本追踪精确
                   - invalid planning → ValueError
  合计 16 tests.
"""
from __future__ import annotations
import json
import time
import unittest
from dataclasses import is_dataclass, fields
from pathlib import Path

from ai_refine_v2.refine_generator import (
    BlockResult,
    GenerationResult,
    HeroFailure,
    generate,
)
from ai_refine_v2.prompts.generator import (
    STYLE_BASE,
    TEMPLATES,
    PromptRenderError,
    render,
)


class TestPublicAPIShape(unittest.TestCase):
    """验证 refine_generator 公开符号 + 结构."""

    def test_imports_work(self):
        self.assertTrue(callable(generate))
        self.assertTrue(is_dataclass(BlockResult))
        self.assertTrue(is_dataclass(GenerationResult))
        self.assertTrue(issubclass(HeroFailure, RuntimeError))

    def test_block_result_fields(self):
        names = {f.name for f in fields(BlockResult)}
        self.assertEqual(
            names,
            {"block_id", "visual_type", "prompt", "image_url", "error", "placeholder"},
        )

    def test_generation_result_defaults(self):
        gr = GenerationResult()
        self.assertEqual(gr.blocks, [])
        self.assertFalse(gr.hero_success)
        self.assertEqual(gr.total_cost_rmb, 0.0)
        self.assertEqual(gr.errors, [])


class TestTemplateShape(unittest.TestCase):
    """验证 3 个 .j2 模板文件都存在, STYLE_BASE 合理."""

    def test_three_visual_types_mapped(self):
        self.assertEqual(
            set(TEMPLATES),
            {"product_in_scene", "product_closeup", "concept_visual"},
        )

    def test_all_template_files_exist(self):
        tdir = Path(__file__).resolve().parents[1] / "prompts" / "templates"
        for fname in TEMPLATES.values():
            self.assertTrue((tdir / fname).is_file(),
                            f"模板文件缺失: {fname}")

    def test_style_base_content(self):
        self.assertIn("Taobao", STYLE_BASE)
        self.assertIn("8K", STYLE_BASE)
        self.assertIn("commercial", STYLE_BASE.lower())

    def test_unknown_visual_type_raises(self):
        with self.assertRaises(PromptRenderError):
            render("hero_image", product={})


class TestPromptRendering(unittest.TestCase):
    """对 3 个 visual_type 各跑一次渲染, 断言核心字段出现."""

    def test_concept_visual_minimal_prompt(self):
        """concept_visual 是极简模板, 只需 selling_point.text."""
        prompt = render(
            "concept_visual",
            selling_point={"text": "续航 8 小时一天不充电"},
        )
        self.assertIn("续航 8 小时一天不充电", prompt)
        self.assertIn("NO text", prompt)
        self.assertIn("NO logo", prompt)
        self.assertIn("NO watermark", prompt)
        # 末尾追加 STYLE_BASE
        self.assertTrue(prompt.rstrip().endswith("commercial photography standard."),
                        f"should end with STYLE_BASE, got: {prompt[-200:]!r}")

    def test_in_scene_hero_contains_preserve(self):
        prompt = render(
            "product_in_scene",
            product={
                "name": "DZ600M 无人水面清洁机",
                "primary_color": "industrial yellow",
                "key_visual_parts": ["yellow body", "black auger floats"],
                "proportions": "compact flat float-style watercraft",
            },
            scene="modern urban riverbank at golden hour",
            hero=True,
            human_hint="engineer with tablet",
            selling_point={"text": "unused in hero"},
        )
        self.assertIn("PRESERVE", prompt)
        self.assertIn("industrial yellow", prompt)
        self.assertIn("NO color drift", prompt)
        self.assertIn("hero shot", prompt)
        self.assertIn("engineer with tablet", prompt)
        self.assertIn("cinematic golden-hour", prompt)

    def test_in_scene_non_hero_uses_selling_point(self):
        prompt = render(
            "product_in_scene",
            product={
                "name": "X", "primary_color": "red",
                "key_visual_parts": ["a"], "proportions": "b",
            },
            scene="workshop",
            hero=False,
            selling_point={"text": "specific context description"},
            human_hint="",
        )
        self.assertIn("specific context description", prompt)
        self.assertNotIn("hero shot", prompt)

    def test_closeup_contains_focus_part(self):
        prompt = render(
            "product_closeup",
            product={"name": "DZ600M", "primary_color": "industrial yellow"},
            focus_part="two black cylindrical auger floats",
        )
        self.assertIn("PRESERVE", prompt)
        self.assertIn("two black cylindrical auger floats", prompt)
        self.assertIn("macro close-up", prompt)
        self.assertIn("studio", prompt.lower())

    def test_missing_variable_raises(self):
        """StrictUndefined: 缺变量时抛 PromptRenderError (不生成空洞 prompt)."""
        with self.assertRaises(PromptRenderError):
            # product_closeup 需要 focus_part, 故意不传
            render("product_closeup",
                   product={"name": "X", "primary_color": "red"})


class TestGenerateRealFunctionality(unittest.TestCase):
    """W2 Day 3-5 实装后, generate() 可用 api_call_fn 注入 mock 单测.

    注: 所有 mock 都返预设 URL, 不调真实 APIMart, 零成本可重复.
    """

    @staticmethod
    def _make_planning(
        block_order: list[str] | None = None,
        sps: list[dict] | None = None,
    ) -> dict:
        """生成符合 PRD §3.3 schema 的最小 planning, 供测试用."""
        return {
            "product_meta": {
                "name": "TestBot 扫地机器人",
                "category": "设备类",
                "primary_color": "matte gray",
                "key_visual_parts": ["gray metal body", "LiDAR sensor"],
                "proportions": "compact round disc robot",
            },
            "selling_points": sps if sps is not None else [
                {"idx": 1, "text": "城市道路清扫", "visual_type": "product_in_scene",
                 "priority": "high", "reason": "场景"},
                {"idx": 2, "text": "续航 8 小时", "visual_type": "concept_visual",
                 "priority": "medium", "reason": "抽象指标"},
            ],
            "planning": {
                "total_blocks": len(block_order) if block_order else 3,
                "block_order": block_order or ["hero", "selling_point_1", "selling_point_2"],
                "hero_scene_hint": "urban street morning",
            },
        }

    def test_happy_path_all_blocks_succeed(self):
        """3 block 全成功 → GenerationResult 齐全, 成本 = 3 × 0.70"""
        call_log: list[str] = []

        def mock_ok(prompt, img_url, api_key, thinking, size):
            call_log.append(prompt[:30])
            return f"https://fake.cdn/img_{len(call_log)}.png"

        planning = self._make_planning()
        result = generate(
            planning, product_cutout_url=None, api_key="test-key",
            api_call_fn=mock_ok, max_retries_hero=0, max_retries_sp=0,
        )

        self.assertTrue(result.hero_success)
        self.assertEqual(len(result.blocks), 3)
        self.assertEqual([b.block_id for b in result.blocks],
                         ["hero", "selling_point_1", "selling_point_2"])
        self.assertTrue(all(b.image_url for b in result.blocks))
        self.assertTrue(all(not b.placeholder for b in result.blocks))
        self.assertEqual(len(call_log), 3)
        self.assertAlmostEqual(result.total_cost_rmb, 3 * 0.70, places=2)
        self.assertEqual(len(result.errors), 0)
        # elapsed 可能被 round(..., 2) 打成 0.0 (Windows 计时器粒度), 只验证上界
        self.assertGreaterEqual(result.total_elapsed_s, 0.0)
        self.assertLess(result.total_elapsed_s, 10.0)

    def test_hero_fails_all_retries_raises_hero_failure(self):
        """Hero 重试上限后仍挂 → HeroFailure. 卖点不应被调用 (整单 fail)."""
        sp_calls: list[int] = []

        def mock_hero_fail(prompt, *a, **kw):
            if "hero shot" in prompt or "urban street morning" in prompt:
                raise RuntimeError("APIMart 500 apimart_error: get_channel_failed")
            sp_calls.append(1)
            return "https://fake.cdn/sp.png"

        planning = self._make_planning()
        with self.assertRaises(HeroFailure) as ctx:
            generate(planning, api_key="x", api_call_fn=mock_hero_fail,
                     max_retries_hero=1, max_retries_sp=0)
        self.assertIn("500", str(ctx.exception))
        self.assertIn("重试", str(ctx.exception))
        self.assertEqual(len(sp_calls), 0, "Hero 失败应整单 fail, SP 不该被调")

    def test_hero_retries_then_succeeds(self):
        """Hero 第 1 次失败第 2 次成功 → hero_success=True"""
        attempts = {"n": 0}

        def mock_transient(prompt, *a, **kw):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("transient network")
            return "https://fake.cdn/hero_ok.png"

        planning = self._make_planning(block_order=["hero"])
        result = generate(planning, api_key="x", api_call_fn=mock_transient,
                          max_retries_hero=2, max_retries_sp=0)

        self.assertTrue(result.hero_success)
        self.assertEqual(attempts["n"], 2, "Hero 应调 2 次 (初次 + 重试 1)")
        self.assertAlmostEqual(result.total_cost_rmb, 0.70, places=2)
        self.assertEqual(result.blocks[0].image_url, "https://fake.cdn/hero_ok.png")

    def test_sp_fails_returns_placeholder_not_blocking(self):
        """Hero 成功 + 所有 SP 失败 → placeholder=True, 整单不 raise"""
        call_n = {"n": 0}

        def mock_hero_only(prompt, *a, **kw):
            call_n["n"] += 1
            if call_n["n"] == 1:  # hero 先跑 (同步)
                return "https://fake.cdn/hero.png"
            raise RuntimeError("SP network oops")

        planning = self._make_planning()
        result = generate(planning, api_key="x", api_call_fn=mock_hero_only,
                          max_retries_hero=0, max_retries_sp=0, concurrency=1)

        self.assertTrue(result.hero_success)
        self.assertEqual(len(result.blocks), 3)
        self.assertIsNotNone(result.blocks[0].image_url)  # hero
        self.assertFalse(result.blocks[0].placeholder)
        # SP 全部 placeholder
        for sp_block in result.blocks[1:]:
            self.assertIsNone(sp_block.image_url)
            self.assertTrue(sp_block.placeholder)
            self.assertIsNotNone(sp_block.error)
        self.assertEqual(len(result.errors), 2, "2 个 SP 失败应记录 2 条 error")
        self.assertAlmostEqual(result.total_cost_rmb, 0.70, places=2)  # 只 hero 成功

    def test_block_order_preserved_despite_concurrent_completion(self):
        """ThreadPool 完成顺序无关, result.blocks 必须按 planning.block_order"""
        def mock_variable_latency(prompt, *a, **kw):
            # concept (SP2) 比 in_scene (SP1) 快完成, 故意反序
            if "续航" in prompt or "8 小时" in prompt.lower():
                time.sleep(0.01)
            else:
                time.sleep(0.05)
            return f"https://fake/{abs(hash(prompt)) % 10000}.png"

        planning = self._make_planning()
        result = generate(planning, api_key="x", api_call_fn=mock_variable_latency,
                          max_retries_hero=0, max_retries_sp=0, concurrency=3)

        self.assertEqual(
            [b.block_id for b in result.blocks],
            ["hero", "selling_point_1", "selling_point_2"],
            "即使 SP2 比 SP1 先完成, 最终顺序也要按 block_order 排",
        )

    def test_cost_tracking_with_custom_cost(self):
        """cost_per_call_rmb 可覆盖默认 ¥0.70"""
        def mock_ok(prompt, *a, **kw):
            return "https://fake/ok.png"

        planning = self._make_planning()  # 3 blocks
        result = generate(planning, api_key="x", api_call_fn=mock_ok,
                          max_retries_hero=0, max_retries_sp=0,
                          cost_per_call_rmb=1.00)
        self.assertAlmostEqual(result.total_cost_rmb, 3.00, places=2)

    def test_invalid_planning_raises_value_error(self):
        """planning 不合规 → ValueError (不是 HeroFailure)"""
        with self.assertRaises(ValueError):
            generate({}, api_key="x", api_call_fn=lambda *a, **kw: "x")

        with self.assertRaises(ValueError):
            generate({"product_meta": {}}, api_key="x",
                     api_call_fn=lambda *a, **kw: "x")

        # block_order 首项非 hero → ValueError
        bad_planning = self._make_planning(
            block_order=["selling_point_1", "hero"],  # 反序
        )
        with self.assertRaises(ValueError) as ctx:
            generate(bad_planning, api_key="x", api_call_fn=lambda *a, **kw: "x")
        self.assertIn("hero", str(ctx.exception).lower())


class TestPlannerGeneratorIntegration(unittest.TestCase):
    """验证 refine_planner 输出 ↔ refine_generator/render 输入的数据流通畅.

    取一个历史黄金样本, 用它的 planning 数据直接喂给 render, 应能生成合法 prompt.
    """

    def test_golden_sample_flows_into_render(self):
        repo_root = Path(__file__).resolve().parents[2]
        sample_path = repo_root / "docs" / "PRD_AI_refine_v2" / "w1_samples" / "10_device_dz600m.json"
        if not sample_path.is_file():
            self.skipTest("DZ600M 黄金样本不在, 跳过")

        data = json.loads(sample_path.read_text(encoding="utf-8"))
        po = data["planner_output"]
        pm = po["product_meta"]
        # 取一个 product_closeup 卖点做特写
        sp_closeup = next(
            (sp for sp in po["selling_points"] if sp["visual_type"] == "product_closeup"),
            None,
        )
        self.assertIsNotNone(sp_closeup, "黄金样本应至少有一个 closeup 卖点")

        # 渲染 closeup
        closeup_prompt = render(
            "product_closeup",
            product={"name": pm["name"], "primary_color": pm["primary_color"]},
            focus_part=sp_closeup["text"],  # 中文特写描述
        )
        self.assertIn(pm["primary_color"], closeup_prompt)
        self.assertIn(sp_closeup["text"], closeup_prompt)

        # 渲染 concept (若有)
        sp_concept = next(
            (sp for sp in po["selling_points"] if sp["visual_type"] == "concept_visual"),
            None,
        )
        if sp_concept:
            concept_prompt = render("concept_visual", selling_point=sp_concept)
            self.assertIn(sp_concept["text"], concept_prompt)


if __name__ == "__main__":
    unittest.main()
