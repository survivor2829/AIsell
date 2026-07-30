"""批次进度推送的 Pub/Sub 门面 — 转发到 pubsub 包的抽象后端。

为什么保留这个旧模块名而不是全仓改导入:
- app.py / batch_processor.py / refine_processor.py / tests/ 里有 30+ 调用点
- 改名的 diff 噪音很大, git blame 追溯也会断层
- 保留这个 shim 等同于"语义稳定的门面": 新代码可以直接 `from pubsub import get_backend`,
  老代码 `from batch_pubsub import publish` 也继续工作
- 实际实现在 pubsub/{memory,redis_backend}.py

PRD: PRD_批量生成.md F5 (实时通信 + 浏览器连接状态)

升级路径:
- PUBSUB_BACKEND=memory (默认) → 进程内 dict (dev/单 worker)
- PUBSUB_BACKEND=redis (生产)   → Redis pub/sub (多 worker 广播)
"""
from __future__ import annotations

from typing import Any

from pubsub import get_backend


def subscribe(batch_id: str, ws: Any) -> None:
    """注册 ws 到指定批次的订阅集合 (本 worker 本地)."""
    get_backend().subscribe(batch_id, ws)


def unsubscribe(batch_id: str, ws: Any) -> None:
    """显式移除 ws (ws 端点退出时务必调一次)."""
    get_backend().unsubscribe(batch_id, ws)


def publish(batch_id: str, event: dict) -> int:
    """把事件广播给该批次的所有订阅者 (跨 worker 可达, 如果 backend=redis).

    event 至少含 type 字段; ts/batch_id 由后端补; 返回成功推送的数量.
    """
    return get_backend().publish(batch_id, event)


def subscriber_count(batch_id: str) -> int:
    """本 worker 内的订阅数 (跨 worker 合计代价高, 不做)."""
    return get_backend().subscriber_count(batch_id)


def stats() -> dict:
    """全局快照 — debug 端点用."""
    return get_backend().stats()
