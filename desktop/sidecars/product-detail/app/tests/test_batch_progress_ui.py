"""守护测: batch ai-refine-start 后必须接管进度 UI (progress card + WS).

真实事故 (2026-05-08):
用户跑 batch + AI 精修后, 在 /batch/upload 页面盲等 5-15 min 看不到任何进度,
甚至以为前端死了去刷新. 调查发现 templates/batch/upload.html:1700-1734
ai-refine-start 200 响应处理只 closeEstimateModal + setStatus 一行绿字,
**完全没调 injectProgressCard() 或 openWS()**. 而其他 batch 启动路径
(L947 batch start-mock/real, L1038 batch detail load) 都有完整接管.

修法:
- L1750-1751: setStatus(msg, 'success') 之后加 injectProgressCard() +
  openWS(session.batchId)
- L1078: injectProgressCard 加幂等 guard (防重复点 inject 重复 DOM)
- L1135: openWS 加幂等 guard (防同 batch 重复连接)

3 类守护测对应 3 处改动, regex 扫源码模式 (跟 PR #25 polling 守护同套路).
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UPLOAD_HTML = REPO / "templates" / "batch" / "upload.html"


class TestAiRefineStartTakesOverProgressUI:
    """守护: ai-refine-start 200 响应必须 inject 进度卡 + 开 WS."""

    def test_inject_progress_card_after_setstatus(self):
        """setStatus(msg, 'success') 之后必须紧跟 injectProgressCard()."""
        content = UPLOAD_HTML.read_text(encoding="utf-8")
        # 找 setStatus(msg, 'success') 然后 injectProgressCard 在其后 ~10 行内
        match = re.search(
            r"setStatus\(msg,\s*['\"]success['\"]\);\s*[\s\S]{0,500}?injectProgressCard\(\);",
            content,
        )
        assert match, (
            "templates/batch/upload.html: ai-refine-start 200 响应里 "
            "setStatus(msg, 'success') 之后必须紧跟 injectProgressCard() 调用. "
            "否则用户派发 AI 精修后看不到任何进度 (5-15 min 盲等)."
        )

    def test_openws_after_inject_progress_card(self):
        """injectProgressCard() 之后必须紧跟 openWS(session.batchId)."""
        content = UPLOAD_HTML.read_text(encoding="utf-8")
        # 在 ai-refine-start 响应处理段内, inject 后 ~5 行内开 WS
        match = re.search(
            r"setStatus\(msg,\s*['\"]success['\"]\);\s*[\s\S]{0,500}?"
            r"injectProgressCard\(\);\s*[\s\S]{0,300}?openWS\(session\.batchId\)",
            content,
        )
        assert match, (
            "templates/batch/upload.html: ai-refine-start 200 响应里 "
            "injectProgressCard() 之后必须紧跟 openWS(session.batchId). "
            "否则没有 WS 实时事件推送, 进度卡是死的不更新."
        )


class TestProgressCardIdempotent:
    """守护: injectProgressCard 必须幂等 (防重复点 AI 精修创建多个 #progressCard)."""

    def test_inject_returns_early_if_card_exists(self):
        """函数体首部必须有 if (document.getElementById('progressCard')) return."""
        content = UPLOAD_HTML.read_text(encoding="utf-8")
        # 找 injectProgressCard 函数体 + 首行的 guard
        match = re.search(
            r"function\s+injectProgressCard\(\)\s*\{[\s\S]{0,500}?"
            r"if\s*\(\s*document\.getElementById\(\s*['\"]progressCard['\"]\s*\)\s*\)\s*return\s*;",
            content,
        )
        assert match, (
            "injectProgressCard 函数体首部必须有 idempotency guard "
            "`if (document.getElementById('progressCard')) return;`, "
            "否则用户连点 AI 精修会创建重复 #progressCard 节点 → "
            "querySelector 行为不可预测 (refreshProgressCounts 可能更新错节点)."
        )


class TestOpenWSIdempotent:
    """守护: openWS 必须幂等 (防同 batch 重复 WS 连接)."""

    def test_openws_skips_when_already_open_for_same_batch(self):
        """函数体首部必须 check session.ws OPEN/CONNECTING + 同 batchId 即跳过."""
        content = UPLOAD_HTML.read_text(encoding="utf-8")
        match = re.search(
            r"function\s+openWS\(batchId\)\s*\{[\s\S]{0,500}?"
            r"if\s*\(\s*session\.ws\s*&&[\s\S]{0,300}?"
            r"(WebSocket\.OPEN|WebSocket\.CONNECTING)[\s\S]{0,200}?"
            r"session\.wsBatchId\s*===\s*batchId[\s\S]{0,100}?return\s*;",
            content,
        )
        assert match, (
            "openWS 函数体首部必须有 idempotency guard 检查 session.ws "
            "已 OPEN/CONNECTING 且 wsBatchId === 当前 batchId 时直接 return, "
            "否则同 batch 重复 inject (e.g. ai-refine-start 后又触发 detail load) "
            "会建多个 WebSocket → 双倍 onmessage → 进度计数错乱."
        )
