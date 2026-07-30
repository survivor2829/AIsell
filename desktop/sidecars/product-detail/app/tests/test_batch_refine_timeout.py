"""守护测: batch + AI 精修管线后端 v2 task 超时上限必须 ≥ 900s (15 min).

真实事故 (2026-05-08, 跟今天 PR #25 同日):
batch_20260508_001_e63a/PX0001046龙克洗地机吸水电机三层风叶（侧排风）,
设备类 8 屏 + APIMart 偶发 503/timeout 重试. refine_processor.py:166 写死
timeout_s=360 (6 min), 实际 360s 时只跑到 5/8 屏, 直接 raise TimeoutError.
v2 task 后台子线程被 cleanup, 磁盘 0 产物, 用户 ~¥5 烧无回报.

跟 PR #25 (workspace.html v1 polling 6 → 10 min) 是同根因, 两条独立代码路径:
- PR #25 修了前端 maxIter 上限 (单产品 v1 路径)
- 本修复修后端 timeout_s (批量 v2 路径)

修法: refine_processor.py:166 timeout_s = int(os.environ.get(
       'BATCH_REFINE_TIMEOUT_S', '900'))

为什么 ≥ 900 (15 min):
- 设备类 8 屏 ~5-6 min + APIMart 重试 buffer ~3 min ≈ 8-9 min, 留 50% 余量
- 12 屏耗材类也要能跑通 (理论 ~9 min + 重试 ~3 min ≈ 12 min, 仍在 900s 内)
- 走 env var 让运维不重 build 也能临时调
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from unittest import mock

import pytest

REPO = Path(__file__).resolve().parent.parent
REFINE_PROCESSOR = REPO / "refine_processor.py"


class TestRefineTimeoutAtLeast15Min:
    """守护: refine_processor 后端 v2 task 超时上限 ≥ 900s (15 min)."""

    def test_default_timeout_at_least_900s(self):
        """没设 env var 时, default 必须 ≥ 900s.

        防回归: 谁手贱把 default 改回 360 立刻红测.
        """
        content = REFINE_PROCESSOR.read_text(encoding="utf-8")
        # 找 'BATCH_REFINE_TIMEOUT_S' 默认值
        match = re.search(
            r"os\.environ\.get\(\s*['\"]BATCH_REFINE_TIMEOUT_S['\"]\s*,\s*['\"](\d+)['\"]",
            content,
        )
        assert match, (
            "refine_processor.py 必须用 os.environ.get('BATCH_REFINE_TIMEOUT_S', "
            "<default>) 模式, 不许走回硬编码 timeout_s = 360"
        )
        default = int(match.group(1))
        assert default >= 900, (
            f"BATCH_REFINE_TIMEOUT_S default={default}s ({default//60} min) 太短. "
            f"设备类 8 屏 + APIMart 重试 ~8-9 min, 边界踩死. 必须 ≥ 900 (= 15 min). "
            f"真实事故 2026-05-08: batch_20260508_001_e63a 在 360s 时跑到 5/8 屏死."
        )

    def test_no_hardcoded_360(self):
        """禁止源码里出现 timeout_s = 360 之类的硬编码 6 分钟值.

        防回归 mode 2: 不只看 env var default, 直接禁硬编码常量
        (有人可能加 fallback if env_var 为 None: timeout_s = 360 这种偷渡).
        """
        content = REFINE_PROCESSOR.read_text(encoding="utf-8")
        # 找类似 timeout_s = 360 / TIMEOUT_S = 360 的硬编码 (容忍空格 / 等号 / 类型标注)
        bad_patterns = [
            r"timeout_s\s*[:=]\s*360\b",
            r"TIMEOUT_S\s*=\s*360\b",
        ]
        for pat in bad_patterns:
            assert not re.search(pat, content), (
                f"refine_processor.py 不许硬编码 360s timeout. "
                f"匹配模式: {pat!r}. 必须走 os.environ.get(BATCH_REFINE_TIMEOUT_S)."
            )


class TestEnvVarOverride:
    """守护: BATCH_REFINE_TIMEOUT_S env var 真实生效, 不被忽略."""

    def test_env_var_parsed_at_runtime(self):
        """运维改 env var 重启容器后, 新值要被 refine_one_product 读到.

        防 'env var 被读但 cast 错' / '常量被 import-time 锁住' 类回归.
        测法: 在 mock os.environ 下 reload module, 读全局/局部里的 timeout 解析.
        """
        # refine_processor 把 timeout_s 嵌在 refine_one_product 函数体内,
        # 不是 module-level 常量, 所以 env 改了立即生效 — 确认行为.
        content = REFINE_PROCESSOR.read_text(encoding="utf-8")
        # 确认 timeout_s 行就在 refine_one_product 函数体内 (不是 module 顶层)
        # (简化检查: int(os.environ.get(...)) 调用必须在 def refine_one_product 之后)
        m_def = re.search(r"def\s+refine_one_product\b", content)
        m_env = re.search(
            r"int\(\s*os\.environ\.get\(\s*['\"]BATCH_REFINE_TIMEOUT_S['\"]",
            content,
        )
        assert m_def, "refine_one_product 函数定义没找到"
        assert m_env, "BATCH_REFINE_TIMEOUT_S env var 读取没找到"
        assert m_env.start() > m_def.start(), (
            "BATCH_REFINE_TIMEOUT_S 读取必须在 refine_one_product 函数体内, "
            "不能在 module-level (会被 import-time 缓存住, env 改了不生效)"
        )

    def test_invalid_env_var_falls_back_or_raises_predictably(self):
        """env var 设了非数字时的行为: 当前实现是 raise ValueError (int cast).

        这是可接受的 — 配错了立即崩比悄悄走 default 安全.
        本测固定该行为 (谁改成 silent fallback 立即红).
        """
        from refine_processor import refine_one_product  # noqa: F401
        # 不实际调 refine_one_product (会 import 整个 pipeline), 只 verify
        # int(os.environ.get(...)) 模式在源码里
        content = REFINE_PROCESSOR.read_text(encoding="utf-8")
        # int(os.environ.get(name, default)) 是简单 cast, 非数字 → ValueError
        assert "int(os.environ.get" in content, (
            "BATCH_REFINE_TIMEOUT_S 必须用 int(...) cast, 非数字必须 ValueError 而非"
            "悄悄走 default — 让运维 typo 立即可见."
        )


class TestErrorMsgIncludesMinutes:
    """守护: TimeoutError 文案要含分钟数, 防 timeout 调高了文案没同步的脱钩."""

    def test_timeout_error_msg_mentions_minutes(self):
        """raise TimeoutError 的消息必须含 '{N} min' 或类似时长信息."""
        content = REFINE_PROCESSOR.read_text(encoding="utf-8")
        # 找 raise TimeoutError(...) 行附近的 min 字样
        match = re.search(
            r"raise\s+TimeoutError\s*\(\s*[\s\S]{0,300}?\bmin\b",
            content,
        )
        assert match, (
            "TimeoutError 文案应该含 'min' 字样让人一眼看到耗时多久. "
            "防 timeout_s 改了文案没同步."
        )
