"""screen_types.yaml + 加载逻辑回归保护 (PRD §阶段一·任务 1.2).

测试覆盖:
  - YAML 文件本身: 存在, 默认 enabled: false (PRD 铁律), 含 8 个 id
  - _peek_enabled: 各种字面值 + 注释 + 空行 + 缺失情况
  - load_screen_types: enabled false/true 两条路径 + 文件缺失
  - ScreenType / ScreenTypesConfig dataclass shape
  - (可选) 真 pyyaml 解析: 装了就跑, 没装就 skip

设计:
  全程不调真 DeepSeek / pyyaml (除非装了 pyyaml), 零外部依赖.
  enabled: false 路径必须能在没装 pyyaml 的环境下跑过 (第一版铁律).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ai_refine_v2.screen_types import (
    ScreenType,
    ScreenTypesConfig,
    _YAML_PATH,
    _peek_enabled,
    _parse_yaml_text,
    load_screen_types,
)


# 第一版必须的 8 种屏型 id (PRD §1.2)
_REQUIRED_SCREEN_IDS = (
    "hero", "feature_wall", "vs_compare", "scenario",
    "detail_zoom", "spec_table", "value_story", "brand_quality",
)
# 每个屏型必填字段
_REQUIRED_FIELDS = ("id", "name", "purpose", "prompt_hint", "typical_position")


# ──────────────────────────────────────────────────────────────────
# A: YAML 文件本身的健康检查 (不依赖 pyyaml)
# ──────────────────────────────────────────────────────────────────
class TestYamlFileShape(unittest.TestCase):

    def test_yaml_file_exists(self):
        self.assertTrue(_YAML_PATH.is_file(),
                        f"screen_types.yaml 应存在: {_YAML_PATH}")

    def test_yaml_default_enabled_is_false(self):
        """PRD §阶段一·任务 1.2 铁律: 第一版必须 enabled: false."""
        text = _YAML_PATH.read_text(encoding="utf-8")
        self.assertFalse(
            _peek_enabled(text),
            "PRD 铁律违反: enabled 必须 false (第一版不许偷偷启用 fallback)",
        )

    def test_yaml_contains_all_8_screen_ids(self):
        """文本断言 8 个 id 都在 (用 in 而非真 yaml 解析, 不依赖 pyyaml)."""
        text = _YAML_PATH.read_text(encoding="utf-8")
        for sid in _REQUIRED_SCREEN_IDS:
            with self.subTest(id=sid):
                self.assertIn(
                    f"id: {sid}", text,
                    f"screen_types.yaml 缺屏型 id={sid}",
                )

    def test_yaml_each_type_has_required_fields_in_text(self):
        """每个屏型都要含 5 必填字段 (text-level 检查, 不依赖 pyyaml)."""
        text = _YAML_PATH.read_text(encoding="utf-8")
        for field in _REQUIRED_FIELDS:
            with self.subTest(field=field):
                # 字段名出现次数 >= 屏型数 (8)
                # 注: 'id:' 也会匹配 'id: hero', 但 'name:' 等不会冲突
                count = text.count(f"{field}:")
                self.assertGreaterEqual(
                    count, 8,
                    f"字段 '{field}:' 在 yaml 中应出现 ≥ 8 次, 实际 {count}",
                )


# ──────────────────────────────────────────────────────────────────
# B: _peek_enabled — 纯文本扫描, 不依赖 pyyaml
# ──────────────────────────────────────────────────────────────────
class TestPeekEnabled(unittest.TestCase):

    def test_false_lowercase(self):
        self.assertFalse(_peek_enabled("enabled: false"))

    def test_false_capitalized(self):
        self.assertFalse(_peek_enabled("enabled: False"))

    def test_false_uppercase(self):
        self.assertFalse(_peek_enabled("enabled: FALSE"))

    def test_true_lowercase(self):
        self.assertTrue(_peek_enabled("enabled: true"))

    def test_true_capitalized(self):
        self.assertTrue(_peek_enabled("enabled: True"))

    def test_truthy_aliases(self):
        for v in ("yes", "Yes", "YES", "on", "1"):
            with self.subTest(v=v):
                self.assertTrue(_peek_enabled(f"enabled: {v}"),
                                f"'{v}' 应被视为 truthy")

    def test_inline_comment_stripped(self):
        self.assertFalse(_peek_enabled("enabled: false  # PRD 铁律"))
        self.assertTrue(_peek_enabled("enabled: true  # 阶段六开"))

    def test_skips_comment_and_blank_lines(self):
        text = "# header\n\n\n\nenabled: false\nscreen_types:\n  - id: hero"
        self.assertFalse(_peek_enabled(text))

    def test_missing_enabled_defaults_to_false(self):
        self.assertFalse(_peek_enabled(""))
        self.assertFalse(_peek_enabled("# only comments"))
        self.assertFalse(_peek_enabled("screen_types:\n  - id: hero"))

    def test_first_enabled_wins(self):
        """文件里多个 enabled 行 (理论不该有), 取第一条."""
        self.assertFalse(_peek_enabled("enabled: false\nenabled: true"))


# ──────────────────────────────────────────────────────────────────
# C: load_screen_types 主入口
# ──────────────────────────────────────────────────────────────────
class TestLoadScreenTypes(unittest.TestCase):

    def test_load_default_yaml_returns_disabled(self):
        """实际 yaml 文件 (enabled: false) → 返 disabled state."""
        cfg = load_screen_types()
        self.assertIsInstance(cfg, ScreenTypesConfig)
        self.assertFalse(cfg.enabled, "PRD 铁律: 默认必须返 disabled")
        self.assertEqual(cfg.types, [])
        # source_path 不为空 (文件存在)
        self.assertTrue(cfg.source_path)

    def test_load_missing_file_returns_disabled(self):
        """文件不存在不崩, 返 disabled state + source_path=''."""
        cfg = load_screen_types(yaml_path=Path("/nonexistent/totally/x.yaml"))
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.types, [])
        self.assertEqual(cfg.source_path, "")

    def test_load_disabled_does_not_call_pyyaml(self):
        """关键: enabled: false 路径不应触发 _parse_yaml_text (即不需 pyyaml)."""
        with mock.patch(
            "ai_refine_v2.screen_types._parse_yaml_text",
        ) as mock_parse:
            cfg = load_screen_types()
            self.assertFalse(cfg.enabled)
            mock_parse.assert_not_called()

    def test_load_with_enabled_true_returns_full_types(self):
        """enabled: true → 调 _parse_yaml_text → 返 8 个 ScreenType."""
        # 构造 enabled: true 的临时 YAML (内容不重要, _parse_yaml_text 被 mock)
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False, encoding="utf-8",
        ) as tf:
            tf.write("enabled: true\n# rest mocked\n")
            tmp_path = Path(tf.name)

        fake_data = {
            "enabled": True,
            "screen_types": [
                {"id": sid, "name": f"name_{sid}", "purpose": f"p_{sid}",
                 "prompt_hint": f"hint_{sid}",
                 "typical_position": "first" if i == 0 else "middle"}
                for i, sid in enumerate(_REQUIRED_SCREEN_IDS)
            ],
        }
        try:
            with mock.patch(
                "ai_refine_v2.screen_types._parse_yaml_text",
                return_value=fake_data,
            ):
                cfg = load_screen_types(yaml_path=tmp_path)
            self.assertTrue(cfg.enabled)
            self.assertEqual(len(cfg.types), 8)
            for st in cfg.types:
                self.assertIsInstance(st, ScreenType)
                self.assertIn(st.id, _REQUIRED_SCREEN_IDS)
            # 第一项是 hero, typical_position=first
            self.assertEqual(cfg.types[0].id, "hero")
            self.assertEqual(cfg.types[0].typical_position, "first")
            self.assertEqual(cfg.source_path, str(tmp_path))
        finally:
            tmp_path.unlink(missing_ok=True)

    def test_load_filters_non_dict_screen_type_entries(self):
        """fake yaml 含非 dict 项 → 跳过, 不崩."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", delete=False, encoding="utf-8",
        ) as tf:
            tf.write("enabled: true\n")
            tmp_path = Path(tf.name)
        fake_data = {
            "enabled": True,
            "screen_types": [
                {"id": "hero", "name": "首屏", "purpose": "p",
                 "prompt_hint": "h", "typical_position": "first"},
                "garbage_string",  # 非 dict, 应跳过
                None,              # 非 dict, 应跳过
                {"id": "feature_wall", "name": "卖点墙", "purpose": "p",
                 "prompt_hint": "h", "typical_position": "middle"},
            ],
        }
        try:
            with mock.patch(
                "ai_refine_v2.screen_types._parse_yaml_text",
                return_value=fake_data,
            ):
                cfg = load_screen_types(yaml_path=tmp_path)
            self.assertEqual(len(cfg.types), 2,
                             "非 dict 条目应被跳过")
            self.assertEqual([t.id for t in cfg.types], ["hero", "feature_wall"])
        finally:
            tmp_path.unlink(missing_ok=True)


# ──────────────────────────────────────────────────────────────────
# D: dataclass shape
# ──────────────────────────────────────────────────────────────────
class TestDataclassShape(unittest.TestCase):

    def test_screen_type_required_fields(self):
        st = ScreenType(
            id="hero", name="首屏", purpose="抓眼球",
            prompt_hint="cinematic hero shot",
            typical_position="first",
        )
        self.assertEqual(st.id, "hero")
        self.assertEqual(st.name, "首屏")
        self.assertEqual(st.typical_position, "first")

    def test_screen_types_config_defaults(self):
        cfg = ScreenTypesConfig()
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.types, [])
        self.assertEqual(cfg.source_path, "")


# ──────────────────────────────────────────────────────────────────
# E: 真 pyyaml 解析 (装了才跑)
# ──────────────────────────────────────────────────────────────────
try:
    import yaml as _real_yaml  # noqa: F401
    _has_pyyaml = True
except ImportError:
    _has_pyyaml = False


@unittest.skipUnless(_has_pyyaml, "pyyaml 未装 (第一版可选), skip 真解析测")
class TestRealYamlParsing(unittest.TestCase):
    """阶段六前 pyyaml 通常没装, 这组测会被 skip. 装了就验证真解析."""

    def test_real_pyyaml_loads_8_types_when_enabled_flipped(self):
        """临时把 enabled 翻到 true, 用真 pyyaml 解析, 应读出 8 个完整屏型."""
        text = _YAML_PATH.read_text(encoding="utf-8")
        # 临时替换 enabled 字面 (不写回文件)
        text_enabled = text.replace("enabled: false", "enabled: true", 1)

        data = _parse_yaml_text(text_enabled)
        types = data.get("screen_types") or []
        self.assertEqual(len(types), 8, f"应有 8 个屏型, 实际 {len(types)}")
        ids = [t["id"] for t in types]
        self.assertEqual(set(ids), set(_REQUIRED_SCREEN_IDS),
                         "8 个 id 应齐全")
        for t in types:
            for f in _REQUIRED_FIELDS:
                self.assertIn(f, t, f"屏型 {t.get('id')} 缺字段 {f}")
                self.assertTrue(str(t[f]).strip(),
                                f"屏型 {t.get('id')} 字段 {f} 不能空")


# ──────────────────────────────────────────────────────────────────
# F: 主流程隔离验证 — 第一版任何 v2 主流程模块都不应 import screen_types
# ──────────────────────────────────────────────────────────────────
class TestMainPipelineIsolation(unittest.TestCase):
    """PRD 铁律: 第一版 fallback 不许偷偷启用. 主流程文件不该 import 本模块."""

    def test_pipeline_runner_does_not_import_screen_types(self):
        from ai_refine_v2 import pipeline_runner
        src = Path(pipeline_runner.__file__).read_text(encoding="utf-8")
        self.assertNotIn(
            "screen_types", src,
            "pipeline_runner 不应 import screen_types (第一版 fallback 待命)",
        )

    def test_refine_planner_does_not_import_screen_types(self):
        from ai_refine_v2 import refine_planner
        src = Path(refine_planner.__file__).read_text(encoding="utf-8")
        self.assertNotIn(
            "screen_types", src,
            "refine_planner 不应 import screen_types (第一版 fallback 待命, "
            "阶段六真启用时再加)",
        )

    def test_refine_generator_does_not_import_screen_types(self):
        from ai_refine_v2 import refine_generator
        src = Path(refine_generator.__file__).read_text(encoding="utf-8")
        self.assertNotIn(
            "screen_types", src,
            "refine_generator 不应 import screen_types",
        )


if __name__ == "__main__":
    unittest.main()
