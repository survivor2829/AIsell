"""refine_planner 回归单测. 不调真实 DeepSeek API, 用 w1+w2 样本做 mock.

跑法:
    python -m unittest ai_refine_v2.tests.test_refine_planner
或:
    cd <repo_root> && python -m unittest discover -s ai_refine_v2/tests

设计理念:
    W1 + W2 的 15 个历史 JSON 是"黄金样本" — 它们已经被人工 review 过,
    是 AI 应该输出的正确形态. 用这些样本做 mock, 能验证:
      1. plan() 能正确解析 DeepSeek 响应 (JSON 剥离 + schema 验证)
      2. P2 过滤器在 PC-80 / WW-20 (产品名当卖点 bug) case 上生效
      3. schema 合规率 = 100%
      4. visual_type 准确率维持 (mock 响应本身就是高质量样本, 断言解析无损)

    不测 DeepSeek 真实行为 (那是 scripts/test_deepseek_planner.py 的工作).
"""
from __future__ import annotations
import json
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from ai_refine_v2.refine_planner import (
    PlannerError,
    _extract_json,
    _filter_product_name_redundant,
    _validate_schema,
    plan,
)

# 样本目录 (docs/PRD_AI_refine_v2/{w1,w2}_samples/)
_SAMPLES_ROOT = Path(__file__).resolve().parents[2] / "docs" / "PRD_AI_refine_v2"
_W1_DIR = _SAMPLES_ROOT / "w1_samples"
_W2_DIR = _SAMPLES_ROOT / "w2_samples"


# ── 辅助: 加载所有黄金样本 ───────────────────────────────────────
def _load_all_samples() -> list[dict]:
    """读 w1 + w2 目录下所有 [0-9]*.json, 返回 {file, planner_output} 列表."""
    result = []
    for d in (_W1_DIR, _W2_DIR):
        if not d.is_dir():
            continue
        for jp in sorted(d.glob("[0-9]*.json")):
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
            except Exception:
                continue
            po = data.get("planner_output")
            if po:
                result.append({"file": f"{d.name}/{jp.name}", "planner_output": po})
    return result


def _mock_http(response_json: dict) -> callable:
    """构造 mock http_fn, 返回 OpenAI 风格 chat completions response."""
    def _fn(payload: dict, api_key: str) -> dict:
        return {
            "choices": [{"message": {"content": json.dumps(response_json, ensure_ascii=False)}}],
            "usage": {"total_tokens": 1000},
        }
    return _fn


# ── 测试用例 ────────────────────────────────────────────────────
class TestRefinePlannerCore(unittest.TestCase):
    """plan() 主函数行为."""

    def test_import_and_public_api(self):
        """plan + PlannerError 作为公开 API 可导入."""
        from ai_refine_v2 import plan as p, PlannerError as E
        self.assertTrue(callable(p))
        self.assertTrue(issubclass(E, RuntimeError))

    def test_empty_text_raises(self):
        with self.assertRaises(PlannerError) as ctx:
            plan(product_text="", api_key="dummy")
        self.assertIn("不能为空", str(ctx.exception))

        with self.assertRaises(PlannerError):
            plan(product_text="   ", api_key="dummy")

    def test_no_api_key_raises(self):
        import os as _os
        old = _os.environ.pop("DEEPSEEK_API_KEY", None)
        try:
            with self.assertRaises(PlannerError) as ctx:
                plan(product_text="dummy text", api_key=None)
            self.assertIn("DEEPSEEK_API_KEY", str(ctx.exception))
        finally:
            if old is not None:
                _os.environ["DEEPSEEK_API_KEY"] = old


class TestSchemaValidation(unittest.TestCase):
    """_validate_schema: 不合规应返非空 warnings."""

    def _minimal_valid(self) -> dict:
        return {
            "product_meta": {
                "name": "产品 A",
                "category": "设备类",
                "primary_color": "matte gray",
                "key_visual_parts": ["body", "wheel"],
                "proportions": "compact",
            },
            "selling_points": [
                {"idx": 1, "text": "某卖点", "visual_type": "product_in_scene",
                 "priority": "high", "reason": "x"},
            ],
            "planning": {
                "total_blocks": 2,
                "block_order": ["hero", "selling_point_1"],
                "hero_scene_hint": "scene hint",
            },
        }

    def test_valid_sample_no_warnings(self):
        self.assertEqual(_validate_schema(self._minimal_valid()), [])

    def test_missing_category_fails(self):
        d = self._minimal_valid()
        d["product_meta"].pop("category")
        self.assertIn("product_meta.category 缺失",
                      " ".join(_validate_schema(d)))

    def test_illegal_category_fails(self):
        d = self._minimal_valid()
        d["product_meta"]["category"] = "餐具类"
        w = _validate_schema(d)
        self.assertTrue(any("category 非法" in x for x in w))

    def test_illegal_visual_type_fails(self):
        d = self._minimal_valid()
        d["selling_points"][0]["visual_type"] = "hero_image"
        w = _validate_schema(d)
        self.assertTrue(any("visual_type 非法" in x for x in w))

    def test_empty_selling_points_fails(self):
        d = self._minimal_valid()
        d["selling_points"] = []
        self.assertIn("selling_points 为空",
                      " ".join(_validate_schema(d)))

    def test_over_8_selling_points_fails(self):
        d = self._minimal_valid()
        d["selling_points"] = [
            {"idx": i, "text": f"s{i}", "visual_type": "product_closeup",
             "priority": "low", "reason": "r"}
            for i in range(1, 10)
        ]
        self.assertTrue(any("超上限" in x for x in _validate_schema(d)))


class TestP2Filter(unittest.TestCase):
    """_filter_product_name_redundant: W2 发现的产品名当卖点 bug."""

    def test_removes_product_model_duplicate(self):
        """PC-80 case: 首条卖点就是产品名, 应移除."""
        data = {
            "product_meta": {
                "name": "PC-80 便携手持工业吸尘器",
                "category": "工具类", "primary_color": "glossy black",
                "key_visual_parts": ["a", "b"], "proportions": "c",
            },
            "selling_points": [
                {"idx": 1, "text": "PC-80 便携手持工业吸尘器",
                 "visual_type": "product_closeup", "priority": "high", "reason": "x"},
                {"idx": 2, "text": "1200W 电机吸力 20kPa",
                 "visual_type": "concept_visual", "priority": "high", "reason": "y"},
            ],
            "planning": {
                "total_blocks": 3,
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "hero_scene_hint": "scene",
            },
        }
        filtered, removed = _filter_product_name_redundant(data)
        self.assertEqual(removed, [1])
        self.assertEqual(len(filtered["selling_points"]), 1)
        self.assertEqual(filtered["selling_points"][0]["idx"], 2)
        self.assertNotIn("selling_point_1", filtered["planning"]["block_order"])
        self.assertEqual(filtered["planning"]["total_blocks"], 2)

    def test_does_not_remove_unrelated_selling_points(self):
        """DZ600M case: 卖点里完全不含型号, 不应过滤任何条目."""
        data = {
            "product_meta": {
                "name": "DZ600M 无人水面清洁机",
                "category": "设备类", "primary_color": "industrial yellow",
                "key_visual_parts": ["a", "b"], "proportions": "c",
            },
            "selling_points": [
                {"idx": 1, "text": "螺旋清污机构清污效率提升 3 倍",
                 "visual_type": "product_closeup", "priority": "high", "reason": "x"},
                {"idx": 2, "text": "适用于城市河道 / 工厂污水池 / 景区湖泊",
                 "visual_type": "product_in_scene", "priority": "high", "reason": "y"},
            ],
            "planning": {
                "total_blocks": 3,
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "hero_scene_hint": "scene",
            },
        }
        filtered, removed = _filter_product_name_redundant(data)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered["selling_points"]), 2)

    def test_no_product_name_no_filter(self):
        """缺 product_meta.name 时不崩, 原样返回."""
        data = {
            "product_meta": {},
            "selling_points": [{"idx": 1, "text": "x", "visual_type": "product_closeup",
                                "priority": "low", "reason": "r"}],
            "planning": {"total_blocks": 2, "block_order": ["hero", "selling_point_1"],
                         "hero_scene_hint": "s"},
        }
        filtered, removed = _filter_product_name_redundant(data)
        self.assertEqual(removed, [])
        self.assertEqual(len(filtered["selling_points"]), 1)


class TestExtractJSON(unittest.TestCase):
    """_extract_json: LLM 响应剥离代码块."""

    def test_plain_json(self):
        self.assertEqual(_extract_json('{"a": 1}'), {"a": 1})

    def test_wrapped_in_json_fence(self):
        raw = '```json\n{"a": 1}\n```'
        self.assertEqual(_extract_json(raw), {"a": 1})

    def test_wrapped_in_plain_fence(self):
        raw = '```\n{"a": 1}\n```'
        self.assertEqual(_extract_json(raw), {"a": 1})

    def test_prefixed_by_narrative_text(self):
        raw = '以下是 JSON:\n{"a": 1}'
        self.assertEqual(_extract_json(raw), {"a": 1})


class TestGoldenSamplesRegression(unittest.TestCase):
    """用 w1 + w2 的 15 个历史样本做端到端回归."""

    @classmethod
    def setUpClass(cls):
        cls.samples = _load_all_samples()

    def test_samples_loaded(self):
        self.assertGreaterEqual(len(self.samples), 15,
                                f"应至少加载 15 样本, 实际 {len(self.samples)}")

    def test_all_golden_samples_schema_valid(self):
        """所有历史样本本身必须是 schema 合规的."""
        for s in self.samples:
            with self.subTest(file=s["file"]):
                self.assertEqual(_validate_schema(s["planner_output"]), [],
                                 f"黄金样本 {s['file']} 本身 schema 不合规")

    def test_plan_with_mock_returns_parsed(self):
        """每个样本作为 mock 响应, plan() 都能返回合规 dict."""
        for s in self.samples:
            with self.subTest(file=s["file"]):
                result = plan(
                    product_text="dummy text",
                    api_key="dummy-key",
                    http_fn=_mock_http(s["planner_output"]),
                )
                self.assertIn("product_meta", result)
                self.assertIn("selling_points", result)
                self.assertIn("planning", result)
                self.assertEqual(_validate_schema(result), [])

    def test_visual_type_distribution_healthy(self):
        """每个样本的 visual_type 分布不应单类独大 > 80% (w2 补丁 C 效果)."""
        for s in self.samples:
            with self.subTest(file=s["file"]):
                sps = s["planner_output"].get("selling_points") or []
                if len(sps) < 4:
                    continue
                dist = {t: 0 for t in ("product_in_scene", "product_closeup", "concept_visual")}
                for sp in sps:
                    vt = sp.get("visual_type")
                    if vt in dist:
                        dist[vt] += 1
                max_ratio = max(dist.values()) / len(sps)
                self.assertLessEqual(max_ratio, 0.8,
                                     f"{s['file']} visual_type 分布单类 {max_ratio:.0%} > 80%")


class TestRetryAndFailure(unittest.TestCase):
    """重试策略."""

    def test_retries_on_http_error_then_raises(self):
        """HTTPError 连续 2 次 → PlannerError."""
        class _FakeHTTPError(urllib.error.HTTPError):
            def __init__(self):
                super().__init__("http://x", 500, "err", {}, None)
        calls = {"n": 0}

        def _failing(payload, key):
            calls["n"] += 1
            raise _FakeHTTPError()

        with self.assertRaises(PlannerError) as ctx:
            plan(product_text="dummy", api_key="k", http_fn=_failing, max_retries=1)
        self.assertIn("API/解析失败", str(ctx.exception))
        self.assertEqual(calls["n"], 2, "应尝试 1 原次 + 1 重试 = 2")

    def test_retries_on_schema_invalid_then_raises(self):
        """Schema 不合规连续 2 次 → PlannerError."""
        bad_response = {
            "product_meta": {"name": "x"},  # 缺大量字段
            "selling_points": [],
            "planning": {},
        }
        calls = {"n": 0}

        def _returns_bad(payload, key):
            calls["n"] += 1
            return {
                "choices": [{"message": {"content": json.dumps(bad_response, ensure_ascii=False)}}],
            }

        with self.assertRaises(PlannerError) as ctx:
            plan(product_text="dummy", api_key="k", http_fn=_returns_bad, max_retries=1)
        self.assertIn("schema 不合规", str(ctx.exception))
        self.assertEqual(calls["n"], 2)

    def test_recovers_after_one_retry(self):
        """第一次失败 + 第二次成功 → 返回成功结果 (不抛异常)."""
        good = _load_all_samples()[0]["planner_output"] if _load_all_samples() else None
        if good is None:
            self.skipTest("无样本可用")
        calls = {"n": 0}

        def _flaky(payload, key):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.URLError("first call fails")
            return {
                "choices": [{"message": {"content": json.dumps(good, ensure_ascii=False)}}],
            }

        result = plan(product_text="dummy", api_key="k", http_fn=_flaky, max_retries=1)
        self.assertIn("product_meta", result)
        self.assertEqual(calls["n"], 2)


if __name__ == "__main__":
    unittest.main()
