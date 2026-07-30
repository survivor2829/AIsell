"""守护测: P5.1 耗品类 MVP — _map_parsed_to_form_fields 按品类分支.

前置: P5.0 audit 报告 §F.1 立即可做的 4 件事.
背景: app.py:754-757 硬编码 "工作效率/清洗宽度/清水箱/续航时间" 是设备类专属,
      耗材类用户在前端表单看到的 param_label 应该是耗品语义("稀释比/覆盖面积/净含量/保质期").

设计:
- _PARAM_LABELS_BY_CATEGORY: 4 品类 x 4 label 映射 (设备/耗材/配件/工具)
- _CAT_FALLBACK: 4 品类 x 兜底字符串 (替代硬编码"商用清洁设备")
- _map_parsed_to_form_fields(parsed, product_category=None) 加可选参数, None=设备类老路径
- /api/build/<product_type>/parse-text 端点 (line 2988) 改传 product_category=product_type
- 耗材 DeepSeek prompt 补 compat_models 字段引导 (P5.0 §C 缺口)
"""
from __future__ import annotations
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"


class TestParamLabelsByCategoryConstant:
    """守护: app.py 必须定义 _PARAM_LABELS_BY_CATEGORY 字典."""

    def test_constant_exists(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert "_PARAM_LABELS_BY_CATEGORY" in content, (
            "app.py 必须定义 _PARAM_LABELS_BY_CATEGORY 字典 (4 品类 x 4 label). "
            "P5.0 §F.1 §1: 替代 line 754-757 硬编码."
        )

    def test_includes_all_four_categories(self):
        from app import _PARAM_LABELS_BY_CATEGORY
        for cat in ["设备类", "耗材类", "配件类", "工具类"]:
            assert cat in _PARAM_LABELS_BY_CATEGORY, (
                f"_PARAM_LABELS_BY_CATEGORY 必须含 {cat!r} key. "
                f"4 品类与 ALLOWED_PRODUCT_TYPES 对齐."
            )

    def test_each_category_has_four_labels(self):
        from app import _PARAM_LABELS_BY_CATEGORY
        for cat, labels in _PARAM_LABELS_BY_CATEGORY.items():
            assert len(labels) == 4, (
                f"_PARAM_LABELS_BY_CATEGORY[{cat!r}] 必须正好 4 个 label "
                f"(对应 param_1-4_label). 实际: {labels!r}"
            )
            for i, label in enumerate(labels, 1):
                assert isinstance(label, str) and label, (
                    f"_PARAM_LABELS_BY_CATEGORY[{cat!r}][{i-1}] 必须非空字符串"
                )

    def test_device_labels_unchanged(self):
        """设备类标签必须保持不变 (向后兼容)."""
        from app import _PARAM_LABELS_BY_CATEGORY
        device = _PARAM_LABELS_BY_CATEGORY["设备类"]
        assert device == ("工作效率", "清洗宽度", "清水箱", "续航时间"), (
            f"设备类 4 label 必须保持原值 (向后兼容老用户). 实际: {device!r}"
        )

    def test_consumable_labels_are_consumable_specific(self):
        """耗材类 label 必须不同于设备类, 且语义匹配 (含至少一个耗品词)."""
        from app import _PARAM_LABELS_BY_CATEGORY
        cons = _PARAM_LABELS_BY_CATEGORY["耗材类"]
        device = _PARAM_LABELS_BY_CATEGORY["设备类"]
        assert cons != device, (
            "耗材类 label 不能跟设备类完全一样, 否则等于没修."
        )
        # 至少含一个耗品语义关键词
        consumable_keywords = ["稀释", "覆盖", "净含量", "保质期", "容量", "浓度", "成分"]
        joined = " ".join(cons)
        assert any(kw in joined for kw in consumable_keywords), (
            f"耗材类 4 label 必须至少含一个耗品语义词 {consumable_keywords!r}, "
            f"实际: {cons!r}"
        )


class TestCategoryFallbackConstant:
    """守护: app.py 必须定义 _CAT_FALLBACK 字典 (替代 line 739 硬编码兜底)."""

    def test_constant_exists(self):
        content = APP_PY.read_text(encoding="utf-8")
        assert "_CAT_FALLBACK" in content, (
            "app.py 必须定义 _CAT_FALLBACK 字典. "
            "P5.0 §F.1 §2: 替代 line 739 硬编码 '商用清洁设备'."
        )

    def test_includes_all_four_categories(self):
        from app import _CAT_FALLBACK
        for cat in ["设备类", "耗材类", "配件类", "工具类"]:
            assert cat in _CAT_FALLBACK, (
                f"_CAT_FALLBACK 必须含 {cat!r} key."
            )

    def test_device_fallback_unchanged(self):
        """设备类兜底必须保持 '商用清洁设备' (向后兼容)."""
        from app import _CAT_FALLBACK
        assert _CAT_FALLBACK["设备类"] == "商用清洁设备", (
            "设备类兜底必须保持 '商用清洁设备' (老路径行为不变)."
        )

    def test_consumable_fallback_not_device(self):
        from app import _CAT_FALLBACK
        cons = _CAT_FALLBACK["耗材类"]
        assert cons != "商用清洁设备" and "耗" in cons or "清洁" in cons, (
            f"耗材类兜底必须语义匹配, 不能复用 '商用清洁设备'. 实际: {cons!r}"
        )


class TestMapFunctionAcceptsCategory:
    """守护: _map_parsed_to_form_fields 必须接受可选 product_category 参数."""

    def test_signature_has_optional_category_param(self):
        from app import _map_parsed_to_form_fields
        import inspect
        sig = inspect.signature(_map_parsed_to_form_fields)
        params = sig.parameters
        assert "product_category" in params, (
            "_map_parsed_to_form_fields 必须有 product_category 参数. "
            "签名建议: (parsed: dict, product_category: str | None = None)"
        )
        # 必须是 optional (有默认值)
        assert params["product_category"].default is None, (
            "product_category 默认值必须是 None (向后兼容老调用点)."
        )

    def test_no_category_returns_device_labels(self):
        """不传 category (= None) 应走设备类老路径."""
        from app import _map_parsed_to_form_fields
        result = _map_parsed_to_form_fields({"product_type": ""})
        assert result["param_1_label"] == "工作效率", (
            f"不传 product_category 时 param_1_label 必须是 '工作效率' "
            f"(向后兼容). 实际: {result['param_1_label']!r}"
        )
        assert result["param_4_label"] == "续航时间"

    def test_consumable_category_returns_consumable_labels(self):
        """传 product_category='耗材类' 应返回耗材 label."""
        from app import _map_parsed_to_form_fields, _PARAM_LABELS_BY_CATEGORY
        result = _map_parsed_to_form_fields({"product_type": ""}, product_category="耗材类")
        expected = _PARAM_LABELS_BY_CATEGORY["耗材类"]
        for i, label in enumerate(expected, 1):
            actual = result[f"param_{i}_label"]
            assert actual == label, (
                f"耗材类 param_{i}_label 应为 {label!r}, 实际 {actual!r}"
            )

    def test_unknown_category_falls_back_to_device(self):
        """未知品类 (如 'xxx') 应安全降级到设备类."""
        from app import _map_parsed_to_form_fields
        result = _map_parsed_to_form_fields({"product_type": ""}, product_category="xxx")
        # 不应抛异常, 应返回设备类 label (兜底)
        assert result["param_1_label"] == "工作效率"


class TestCategoryFallbackInUse:
    """守护: line 739 兜底应用 _CAT_FALLBACK[product_category] 替代硬编码."""

    def test_consumable_category_fallback_when_no_product_type(self):
        """耗材类 + parsed 无 product_type 时, _cat 应是 _CAT_FALLBACK['耗材类']."""
        from app import _map_parsed_to_form_fields, _CAT_FALLBACK
        # parsed 缺 product_type 触发兜底
        result = _map_parsed_to_form_fields(
            {"main_title": "", "category_line": "", "product_type": ""},
            product_category="耗材类",
        )
        # category_line 兜底应来自 _CAT_FALLBACK
        cat = result.get("category_line", "")
        assert cat == _CAT_FALLBACK["耗材类"], (
            f"耗材类 + 无 product_type 时 category_line 兜底应是 "
            f"{_CAT_FALLBACK['耗材类']!r}, 实际 {cat!r}"
        )


class TestParseTextEndpointWiresCategory:
    """守护: /api/build/<product_type>/parse-text 端点必须把 product_type 传给 _map_parsed_to_form_fields."""

    def test_endpoint_passes_product_category(self):
        import re
        content = APP_PY.read_text(encoding="utf-8")
        # 找 parse_text_for_build 函数体
        match = re.search(
            r'def parse_text_for_build\([^)]*\):.*?(?=\n@app\.route|\nclass\s|\Z)',
            content,
            re.S,
        )
        assert match, "找不到 parse_text_for_build 函数"
        body = match.group(0)
        # 必须有 _map_parsed_to_form_fields(..., product_category=product_type) 形式
        wired = re.search(
            r'_map_parsed_to_form_fields\s*\([^)]*product_category\s*=\s*product_type',
            body,
        )
        assert wired, (
            "parse_text_for_build 必须调 _map_parsed_to_form_fields(parsed, "
            "product_category=product_type), 否则前端表单 param_label 跟品类对不上."
        )


class TestConsumablePromptHasCompatModels:
    """守护: 耗材类 DeepSeek prompt 必须含 compat_models 字段引导 (P5.0 §C 缺口)."""

    def test_consumable_prompt_includes_compat_models(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找 elif product_type == "耗材类": 后的 prompt 文本块
        import re
        match = re.search(
            r'elif\s+product_type\s*==\s*[\'"]耗材类[\'"]\s*:\s*return\s*\(\s*(.+?)\)',
            content,
            re.S,
        )
        assert match, "找不到耗材类 DeepSeek prompt 块"
        prompt = match.group(1)
        assert "compat_models" in prompt, (
            "耗材类 DeepSeek prompt 必须含 compat_models 字段引导. "
            "P5.0 §C: block_p_compatibility 已就位但 prompt 没要求 AI 输出此字段."
        )
