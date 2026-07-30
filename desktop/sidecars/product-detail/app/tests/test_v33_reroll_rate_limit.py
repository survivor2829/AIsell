"""守护测: v3.3 reroll 端点必须有 rate-limit 装饰器.

防止快速重复点击 🔄 按钮导致 burst 烧钱 (¥0.7 × N).
即使前端有 modal 和 process-level 锁, 服务端 rate-limit 是 defense-in-depth.

设计:
- 限流值: 10 per minute; 30 per hour (单用户单 IP)
- 静态守护测 (grep app.py 内容), 不真发 11 个 HTTP (rate-limit 测试 in-memory backend 在并发测里有 flake 风险)
"""
from __future__ import annotations
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP_PY = REPO / "app.py"


class TestRerollRouteHasRateLimit:
    """守护: app.py reroll 端点必须有 @limiter.limit 装饰器."""

    def test_reroll_route_decorated_with_limit(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找 def batch_item_regenerate_screen 函数前的装饰器堆
        match = re.search(
            r'((?:@[^\n]*\n\s*)+)def\s+batch_item_regenerate_screen\s*\(',
            content,
        )
        assert match, (
            "找不到 batch_item_regenerate_screen 函数. "
            "v3.3 reroll 端点应在 app.py 定义."
        )
        decorators = match.group(1)
        has_limit = "limiter.limit" in decorators
        assert has_limit, (
            "app.py batch_item_regenerate_screen 必须有 @limiter.limit 装饰器. "
            "推荐: @limiter.limit(\"10 per minute; 30 per hour\", methods=[\"POST\"]) "
            "防 ¥0.7 burst 烧钱攻击."
        )

    def test_reroll_limit_strict_enough(self):
        """限流值必须不超过 15/分钟 (防 burst 烧钱)."""
        content = APP_PY.read_text(encoding="utf-8")
        # 在 batch_item_regenerate_screen 装饰器范围内找 limiter.limit
        match = re.search(
            r'@limiter\.limit\s*\(\s*["\']([^"\']+)["\'][^)]*\)\s*\n\s*def\s+batch_item_regenerate_screen',
            content,
        )
        if not match:
            return  # 上一个测试会捕获缺装饰器的情况
        rule = match.group(1)
        # 抓 "N per minute" 部分
        per_min = re.search(r'(\d+)\s*per\s+minute', rule, re.I)
        assert per_min, (
            f"reroll 限流规则必须含 'N per minute', 实际: {rule!r}"
        )
        n = int(per_min.group(1))
        assert n <= 15, (
            f"reroll 限流 {n}/min 太松, burst 烧钱风险. "
            f"推荐 10/min (¥7/min 上限) 或更严格."
        )
