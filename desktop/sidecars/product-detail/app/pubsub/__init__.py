"""PubSub 后端抽象（批次实时推送的总线层）。

解决的问题:
- gunicorn 多 worker 场景下, 进程内 dict 做订阅集合无法跨 worker 广播事件
- WS 订阅和事件发布可能落在不同 worker, 必须走进程外总线

后端选择:
- PUBSUB_BACKEND=memory (默认, 开发 / 单 worker): 直接进程内 dict
- PUBSUB_BACKEND=redis (生产): Redis pub/sub, 跨 worker 可达

扩展性:
- 未来换 NATS / Kafka / 本地 SQLite pubsub: 新增 pubsub/xxx_backend.py
  实现 PubSubBackend 接口, 在 get_backend() 里加分支即可.
  调用方 (batch_pubsub.py / app.py WS 端点) 不用动.
- 接口刻意做得很窄 — 只支持 channel → event 广播, 没做 request/reply
  等复杂模式, 够用且好迁移.
"""
from __future__ import annotations

import os
import threading
import traceback
from abc import ABC, abstractmethod
from typing import Any


class PubSubBackend(ABC):
    """跨 worker pub/sub 抽象. 所有实现必须线程安全."""

    @abstractmethod
    def subscribe(self, channel: str, ws: Any) -> None:
        """把 ws 加入该 channel 的本地订阅集合."""

    @abstractmethod
    def unsubscribe(self, channel: str, ws: Any) -> None:
        """把 ws 从该 channel 的本地订阅集合移除."""

    @abstractmethod
    def publish(self, channel: str, event: dict) -> int:
        """广播 event (dict) 到所有订阅者 (跨 worker). 返回成功发出的消息数."""

    @abstractmethod
    def subscriber_count(self, channel: str) -> int:
        """本 worker 内的订阅数 (跨 worker 合计代价高, 默认不做)."""

    @abstractmethod
    def stats(self) -> dict:
        """后端快照 — debug 端点用."""

    def close(self) -> None:
        """进程退出时释放资源 (订阅线程、Redis 连接). 默认 no-op."""


_backend: PubSubBackend | None = None
_init_lock = threading.Lock()


def get_backend() -> PubSubBackend:
    """按 PUBSUB_BACKEND env 选实现, 进程级单例.

    Redis 初始化失败 → 自动降级 memory, 打印一次 warning. 业务不阻塞.
    """
    global _backend
    if _backend is not None:
        return _backend
    with _init_lock:
        if _backend is not None:
            return _backend
        name = (os.environ.get("PUBSUB_BACKEND") or "memory").lower().strip()
        if name == "redis":
            try:
                from .redis_backend import RedisPubSub
                _backend = RedisPubSub()
                print("[pubsub] backend=redis", flush=True)
            except Exception as e:
                traceback.print_exc()
                print(f"[pubsub] Redis 初始化失败 ({e}), 降级 memory",
                      flush=True)
                from .memory import InMemoryPubSub
                _backend = InMemoryPubSub()
        else:
            from .memory import InMemoryPubSub
            _backend = InMemoryPubSub()
            print("[pubsub] backend=memory", flush=True)
    return _backend


def reset_backend_for_tests() -> None:
    """仅测试用 — 强制重建 backend. 生产代码不要调."""
    global _backend
    with _init_lock:
        if _backend is not None:
            try:
                _backend.close()
            except Exception:
                pass
        _backend = None
