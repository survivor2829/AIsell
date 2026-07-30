"""进程内 pub/sub 实现 — 单 worker 场景 (dev / 小部署).

从原 batch_pubsub.py 移植而来, 语义不变.
"""
from __future__ import annotations

import json
import threading
import time
import traceback
from typing import Any

from . import PubSubBackend


class InMemoryPubSub(PubSubBackend):
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: dict[str, set[Any]] = {}

    def subscribe(self, channel: str, ws: Any) -> None:
        with self._lock:
            self._subscribers.setdefault(channel, set()).add(ws)

    def unsubscribe(self, channel: str, ws: Any) -> None:
        with self._lock:
            s = self._subscribers.get(channel)
            if not s:
                return
            s.discard(ws)
            if not s:
                self._subscribers.pop(channel, None)

    def publish(self, channel: str, event: dict) -> int:
        payload = dict(event)
        payload.setdefault("ts", time.time())
        payload.setdefault("batch_id", channel)
        msg = json.dumps(payload, ensure_ascii=False)

        # 拷订阅者快照, 不持锁调 ws.send (可能阻塞)
        with self._lock:
            targets = list(self._subscribers.get(channel, ()))

        dead: list[Any] = []
        sent = 0
        for ws in targets:
            try:
                ws.send(msg)
                sent += 1
            except Exception:
                traceback.print_exc()
                dead.append(ws)

        if dead:
            with self._lock:
                s = self._subscribers.get(channel)
                if s:
                    for d in dead:
                        s.discard(d)
                    if not s:
                        self._subscribers.pop(channel, None)
        return sent

    def subscriber_count(self, channel: str) -> int:
        with self._lock:
            return len(self._subscribers.get(channel, ()))

    def stats(self) -> dict:
        with self._lock:
            return {
                "backend": "memory",
                "batches_with_listeners": len(self._subscribers),
                "listeners_per_batch": {
                    c: len(s) for c, s in self._subscribers.items()
                },
            }
