"""Day 4 · 3 个边界 case · 验证 refine_planner 鲁棒性.

跟 test_refine_planner.py 分开放, 语义更清晰: 这里专测"非典型输入"的处理.

3 个边界场景:
  A. 文案 < 15 字 (短文案, DeepSeek 可能只返 1-2 个 selling_points)
  B. 纯英文文案 (中英混合能力, prompt 模板对非中文输入的健壮性)
  C. 图片 URL 无效 (W1 阶段 plan 不下载图片, URL 仅作 prompt hint, 不应影响)

硬约束:
  - 不跑真实 DeepSeek API (用 mock)
  - 不验证 DeepSeek 实际响应质量 (那是生产 A/B 测试的工作)
  - 只验证 plan() 本身对"非典型输入"能否优雅处理 / 何时该抛 PlannerError
"""
from __future__ import annotations
import json
import unittest

from ai_refine_v2.refine_planner import PlannerError, plan


def _mock_http(response_json: dict):
    """构造 mock http_fn."""
    def _fn(payload: dict, api_key: str) -> dict:
        return {
            "choices": [{"message": {"content": json.dumps(response_json, ensure_ascii=False)}}],
        }
    return _fn


# ── Case A · 超短文案 ────────────────────────────────────────────
class TestShortProductText(unittest.TestCase):
    """文案 < 15 字. 行为: plan() 不崩, 接受 DeepSeek 的最小合规规划."""

    def test_short_text_with_minimal_valid_response(self):
        """11 字文案: "XX 强力清洁剂". DeepSeek 返 1 个 selling_point, 应通过."""
        minimal_response = {
            "product_meta": {
                "name": "XX 强力清洁剂",
                "category": "耗材类",
                "primary_color": "blue HDPE bottle",
                "key_visual_parts": ["blue HDPE drum", "product label"],
                "proportions": "standard cleaning bottle",
            },
            "selling_points": [
                {"idx": 1, "text": "强力清洁剂",
                 "visual_type": "product_closeup", "priority": "high",
                 "reason": "主语是产品本体"},
            ],
            "planning": {
                "total_blocks": 2,
                "block_order": ["hero", "selling_point_1"],
                "hero_scene_hint": "A blue cleaning bottle on a white studio backdrop",
            },
        }
        result = plan(
            product_text="XX 强力清洁剂",
            api_key="dummy-key",
            http_fn=_mock_http(minimal_response),
        )
        self.assertEqual(len(result["selling_points"]), 1)
        self.assertEqual(result["product_meta"]["category"], "耗材类")

    def test_short_text_with_empty_selling_points_fails(self):
        """超短文案 + DeepSeek 无法抽卖点 → 触发重试 → 仍空 → PlannerError.
        上层 (W2 refine_generator) 应接 PlannerError 走固定模板 fallback."""
        empty_sp_response = {
            "product_meta": {
                "name": "短文本", "category": "耗材类",
                "primary_color": "unknown", "key_visual_parts": ["a", "b"],
                "proportions": "unknown",
            },
            "selling_points": [],  # 空卖点
            "planning": {"total_blocks": 1, "block_order": ["hero"],
                         "hero_scene_hint": "generic"},
        }
        with self.assertRaises(PlannerError) as ctx:
            plan(product_text="清洁剂", api_key="k",
                 http_fn=_mock_http(empty_sp_response), max_retries=1)
        self.assertIn("schema 不合规", str(ctx.exception))
        self.assertIn("selling_points 为空", str(ctx.exception))


# ── Case B · 纯英文文案 ──────────────────────────────────────────
class TestEnglishOnlyProductText(unittest.TestCase):
    """纯英文文案, prompt 模板应能无损拼接."""

    def test_english_product_text_passes(self):
        """英文 product_text + 英文响应, schema 合规即可."""
        english_response = {
            "product_meta": {
                "name": "DZ600M Unmanned Water Surface Cleaner",
                "category": "设备类",
                "primary_color": "industrial yellow",
                "key_visual_parts": [
                    "industrial yellow body",
                    "two black cylindrical auger floats",
                    "transparent dome camera",
                    "black propeller blade",
                ],
                "proportions": "compact flat float-style watercraft",
            },
            "selling_points": [
                {"idx": 1, "text": "Spiral cleaning mechanism 3x efficiency",
                 "visual_type": "product_closeup", "priority": "high",
                 "reason": "describes specific structural part"},
                {"idx": 2, "text": "Suitable for city rivers, factory ponds, park lakes",
                 "visual_type": "product_in_scene", "priority": "high",
                 "reason": "explicit application scenarios"},
                {"idx": 3, "text": "8-hour battery life",
                 "visual_type": "concept_visual", "priority": "medium",
                 "reason": "abstract endurance indicator"},
            ],
            "planning": {
                "total_blocks": 4,
                "block_order": ["hero", "selling_point_1", "selling_point_2", "selling_point_3"],
                "hero_scene_hint": "A DZ600M robot operating on an urban river at golden hour",
            },
        }
        text = (
            "DZ600M unmanned water surface cleaning robot, industrial yellow body, "
            "spiral cleaning mechanism 3x efficiency, 8-hour battery life, "
            "suitable for city rivers, factory ponds, park lakes, "
            "anti-corrosion coating lasts 5 years, low-noise operation."
        )
        result = plan(
            product_text=text,
            api_key="dummy-key",
            http_fn=_mock_http(english_response),
        )
        self.assertEqual(result["product_meta"]["category"], "设备类")
        self.assertEqual(len(result["selling_points"]), 3)
        # 英文 text 没有中文型号前缀, P2 过滤器不误杀
        self.assertEqual(result["selling_points"][0]["text"],
                         "Spiral cleaning mechanism 3x efficiency")


# ── Case C · 图片 URL 无效 ───────────────────────────────────────
class TestInvalidImageURL(unittest.TestCase):
    """W1 阶段 plan 不下载图片, URL 仅作 prompt hint, 非法 URL 不应导致崩溃."""

    def _good_response(self) -> dict:
        return {
            "product_meta": {
                "name": "PC-80 便携吸尘器", "category": "工具类",
                "primary_color": "glossy black",
                "key_visual_parts": ["glossy black body", "orange buttons"],
                "proportions": "compact handheld",
            },
            "selling_points": [
                {"idx": 1, "text": "1200W 电机吸力 20kPa",
                 "visual_type": "concept_visual", "priority": "high",
                 "reason": "抽象性能指标"},
            ],
            "planning": {
                "total_blocks": 2, "block_order": ["hero", "selling_point_1"],
                "hero_scene_hint": "handheld vacuum in workshop",
            },
        }

    def test_broken_url_string_does_not_affect_plan(self):
        """URL 指向死链, plan() 照常返回 (W1 不下载图片)."""
        result = plan(
            product_text="PC-80 便携吸尘器, 1200W 电机",
            product_image_url="https://does-not-exist-000000.example/broken.png",
            api_key="dummy",
            http_fn=_mock_http(self._good_response()),
        )
        self.assertIn("product_meta", result)

    def test_none_url_uses_default_hint(self):
        """URL=None, plan() 用默认 hint, 不崩."""
        result = plan(
            product_text="PC-80 便携吸尘器, 1200W 电机",
            product_image_url=None,
            api_key="dummy",
            http_fn=_mock_http(self._good_response()),
        )
        self.assertIn("product_meta", result)

    def test_empty_string_url_uses_default_hint(self):
        """URL='', plan() 用默认 hint."""
        result = plan(
            product_text="PC-80 便携吸尘器, 1200W 电机",
            product_image_url="",
            api_key="dummy",
            http_fn=_mock_http(self._good_response()),
        )
        self.assertIn("product_meta", result)


if __name__ == "__main__":
    unittest.main()
