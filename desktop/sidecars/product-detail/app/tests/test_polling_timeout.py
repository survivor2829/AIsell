"""守护测: workspace.html v2 polling timeout 必须 ≥ 10 min.

真实事故 (2026-05-07): 用户跑爱悠威光亮剂耗材类 task, DeepSeek 出 12 屏 +
APIMart 偶发 503 重试, 实际跑 ~6 min (18:48 → 18:54). 前端 polling
maxIter=180 × 2s = 360s = 6 min 边界踩死, throw '轮询超时' → 显示
'AI 精修失败'. 但后端 task 实际已成功, assembled.png 16MB 在磁盘.

PR #17 disk fallback 兜底了"内存丢但磁盘有"的场景, 但前端 polling 必须
**等到磁盘有 _summary.json**, 6 min 边界恰好不够.

修法: maxIter 180 → 300 (10 min), 给 12 屏 task + 503 重试余量.
"""
from __future__ import annotations
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORKSPACE_HTML = REPO / "templates" / "workspace.html"


class TestPollingTimeoutAtLeast10Min:
    """守护: workspace.html v2 polling 必须 ≥ 10 min (300 iters × 2s)."""

    def test_max_iter_at_least_300(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        match = re.search(r"const\s+maxIter\s*=\s*(\d+)\s*;", content)
        assert match, "workspace.html 必须有 'const maxIter = N' 定义 polling 上限"
        n = int(match.group(1))
        assert n >= 300, (
            f"maxIter={n} (×2s={n*2}s) 太短. 12 屏 task + APIMart 503 重试 ~6 min, "
            f"边界踩死. 必须 ≥ 300 (= 10 min). 真实事故 2026-05-07: 18:48-18:54."
        )

    def test_setTimeout_2000_unchanged(self):
        """polling 间隔仍是 2s (改间隔会影响 maxIter 算法语义)."""
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        # 确保 setTimeout(r, 2000) 仍存在 (polling delay)
        assert "setTimeout(r, 2000)" in content, (
            "polling 间隔必须保持 2000ms, 否则 maxIter 上限语义会变"
        )


class TestErrorMsgUpdated:
    """守护: 超时报错信息要跟 maxIter 同步 (避免 prompt 跟实际行为脱钩)."""

    def test_timeout_msg_mentions_actual_minutes(self):
        """报错文案"轮询超时 (>X 分钟)"必须跟 maxIter 一致."""
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        # 找 throw new Error('轮询超时 ...') 字符串
        match = re.search(r"轮询超时\s*\(>(\d+)\s*分钟\)", content)
        if not match:
            return  # 无此格式 (允许 — 但若有必须正确)
        msg_min = int(match.group(1))
        # maxIter × 2s / 60 = 期望分钟数
        max_iter_match = re.search(r"const\s+maxIter\s*=\s*(\d+)", content)
        if max_iter_match:
            actual_min = int(max_iter_match.group(1)) * 2 // 60
            assert msg_min == actual_min, (
                f"'轮询超时' 文案显示 {msg_min} 分钟, 但 maxIter={max_iter_match.group(1)} "
                f"实际是 {actual_min} 分钟 — 两者必须一致, 否则用户被误导"
            )
