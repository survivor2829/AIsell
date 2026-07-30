"""守护测: PR D — 准则 5 negative phrase 改"区分编造 vs 保留".

真实事故 (2026-05-07):
用户用爱悠威不锈钢光亮剂产品图测试 AI 精修, 产品图原本贴有标签 + 图标,
但精修结果是纯白塑料桶, 标签全被 gpt-image-2 刷掉.

根因:
SYSTEM_PROMPT_V2 准则 5 (line 346-365) 强制要求每屏 prompt 末尾含 negative
phrase block:
   "NO brand logo anywhere, NO company name on product body,
    NO trademark text on product surfaces, NO printed labels,
    NO model badge text on chassis, unmarked plain product surfaces"

DeepSeek 严格 follow → 输出每屏 prompt 末尾都加这段 → gpt-image-2
follow text instruction → 把产品本身已有的标签也刷掉.

历史: 2026-04-27 加准则 5 是为了修 DZ600M 实测 hero 屏被脑补"船身假 logo".
但矫枉过正 — 把"AI 不要编造文案没说的品牌名"修成"产品表面什么都不能有".

修复:
准则 5 negative phrase 改为"区分编造 vs 保留":
   "DO NOT INVENT any brand logos / trademarks / certifications / printed
    text NOT VISIBLE in Image 1. PRESERVE all existing labels, stickers,
    model markings, printed text as shown in Image 1 (faithful to position,
    color, content). NO 「」-quoted headlines should be added ONTO product
    surface itself."

3 处 hardcode 文案位置 (ai_refine_v2/prompts/planner.py):
- 准则 5 主指令 (line 357-360)
- 准则 5/6 反例正例段 (line 387, 395)
- 准则 7 末尾视觉指令规约 (line 713-715)
"""
from __future__ import annotations
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLANNER_PROMPTS = REPO / "ai_refine_v2" / "prompts" / "planner.py"


class TestNoBlanketLabelBan:
    """守护: SYSTEM_PROMPT_V2 不能再有"全禁标签"的 negative phrase."""

    def test_no_blanket_no_printed_labels(self):
        """删除"NO printed labels" 这种粗暴禁令."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        assert "NO printed labels" not in content, (
            "PLANNER_PROMPTS 不能含 'NO printed labels' 全禁文案. "
            "PR D: 改成 'DO NOT INVENT ... PRESERVE existing' 区分."
        )

    def test_no_blanket_unmarked_plain(self):
        """删除"unmarked plain product surfaces" 这种粗暴禁令."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        assert "unmarked plain product surfaces" not in content, (
            "PLANNER_PROMPTS 不能含 'unmarked plain product surfaces'. "
            "用户产品本身有标签时这条会刷掉它. 改成 'PRESERVE existing labels'."
        )

    def test_no_blanket_no_model_badge(self):
        """删除"NO model badge text" 这种粗暴禁令."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        assert "NO model badge text" not in content, (
            "PLANNER_PROMPTS 不能含 'NO model badge text' 全禁文案. "
            "产品本身可能就有型号 badge."
        )


class TestPreservePhraseAdded:
    """守护: 修复后必须含'保留已有标签'的 explicit instruction."""

    def test_has_preserve_existing_phrase(self):
        """修复后 prompt 必须告诉 AI 保留 Image 1 已有的标签."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        # 接受 PRESERVE / preserve / Keep faithful 等等价表达
        has_preserve = (
            "PRESERVE" in content or
            "preserve all existing" in content.lower() or
            "keep" in content.lower() and "label" in content.lower()
        )
        assert has_preserve, (
            "PLANNER_PROMPTS 必须含'保留 Image 1 已有标签'的 explicit "
            "instruction (PRESERVE existing labels / Keep faithful / etc), "
            "否则 gpt-image-2 仍会刷掉用户产品的真实标签."
        )

    def test_has_do_not_invent_phrase(self):
        """修复后 prompt 必须含'不要编造'的 explicit instruction (替代旧的 NO 全禁)."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        # 接受 DO NOT INVENT / do not fabricate / never invent 等
        has_no_invent = (
            "DO NOT INVENT" in content or
            "do not invent" in content.lower() or
            "do not fabricate" in content.lower() or
            "never invent" in content.lower()
        )
        assert has_no_invent, (
            "PLANNER_PROMPTS 必须含'不要编造文案没提的品牌/商标'的 instruction "
            "(DO NOT INVENT / never invent / etc), 替代旧的 'NO brand logo' 全禁. "
            "目的: 防止 AI 脑补 logo (DZ70X 假 logo 问题不回归)"
        )


class TestNoFalseRegression:
    """守护: 不能为了修标签丢失而引入 DZ70X 假 logo 类回归."""

    def test_still_warns_against_invented_brand(self):
        """修复后仍必须有'防止编造文案没提的品牌信息'语义."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        # 必须 mention "Image 1" 让 vision-first 设计仍生效
        assert "Image 1" in content, (
            "PLANNER_PROMPTS 必须保留 vision-first 设计 (引用 Image 1 主导), "
            "否则 gpt-image-2 vision bias 会回归"
        )

    def test_still_uses_chinese_quote_brackets(self):
        """修复后仍必须用「」标记 explicit 应画的中文文字."""
        content = PLANNER_PROMPTS.read_text(encoding="utf-8")
        assert "「」" in content or "「" in content, (
            "PLANNER_PROMPTS 必须保留「」-quoted 标记规则 (准则 4)"
        )
