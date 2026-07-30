"""Redis pub/sub 后端 — 生产多 worker 的总线.

设计:
- 每个 worker 进程启动时建一个 redis.Redis 连接 (发布用) +
  一个 pubsub 连接 + 一个后台线程 _listen_loop
- _listen_loop psubscribe 通配模式 ({prefix}*), 所有批次事件走同一个订阅
- 收到消息 → 查本 worker 的 _local_subscribers 字典 → 转发给本机的 ws
- publish 走普通 redis.publish, 失败只 log warning, 业务不阻断
  (WS 进度是软信息, 丢了不致命)

为什么不为每个 subscribe 动态调 redis.subscribe:
- subscribe/unsubscribe 是 WS 握手/退出热路径, 每个都往 Redis 发命令太贵
- psubscribe 一次固定模式即可, 所有批次事件共用一条订阅
- 副作用: 这 worker 会收到全部批次的事件, 但内部 _local_subscribers 过滤后
  只 forward 给本机 ws; 额外开销仅是 worker 数量 × 事件吞吐, 可接受

扩展点:
- 如果未来要多 app 实例共享 Redis (不只是同 app 的 worker), 调整 prefix 即可
- 如果要做"已订阅客户端数量"跨 worker 汇总, 加 PUBSUB NUMSUB (但不推荐热路径用)
"""
from __future__ import annotations

import json
import os
import threading
import time
import traceback
from typing import Any

from . import PubSubBackend

_CHANNEL_PREFIX = os.environ.get("PUBSUB_CHANNEL_PREFIX", "xiaoxi:batch:").strip()


def _channel_for(batch_id: str) -> str:
    return f"{_CHANNEL_PREFIX}{batch_id}"


def _batch_id_from_channel(channel: str) -> str:
    if channel.startswith(_CHANNEL_PREFIX):
        return channel[len(_CHANNEL_PREFIX):]
    return channel


class RedisPubSub(PubSubBackend):
    def __init__(self) -> None:
        import redis  # 延迟导入, 依赖不装时 get_backend() 降级 memory
        url = os.environ.get("REDIS_URL", "redis://localhost:6379/0").strip()
        self._url = url
        self._redis = redis.Redis.from_url(
            url,
            decode_responses=False,
            socket_keepalive=True,
            socket_connect_timeout=5,
            health_check_interval=30,
        )
        self._redis.ping()  # 启动时握手, 失败立刻抛 → 工厂降级 memory

        self._lock = threading.Lock()
        self._local_subscribers: dict[str, set[Any]] = {}

        # 单个 pubsub 对象 + 通配订阅, 所有批次共享
        self._pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
        self._pattern = f"{_CHANNEL_PREFIX}*"
        self._pubsub.psubscribe(self._pattern)

        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._listen_loop,
            name="pubsub-redis-listener",
            daemon=True,
        )
        self._thread.start()

    def _listen_loop(self) -> None:
        import redis.exceptions as _re
        while not self._stop.is_set():
            try:
                for msg in self._pubsub.listen():
                    if self._stop.is_set():
                        break
                    if msg.get("type") not in ("pmessage", "message"):
                        continue
                    channel = msg.get("channel")
                    if isinstance(channel, bytes):
                        channel = channel.decode("utf-8", errors="replace")
                    data = msg.get("data")
                    if isinstance(data, bytes):
                        data = data.decode("utf-8", errors="replace")
                    self._forward_to_local(channel, data)
            except (_re.ConnectionError, _re.TimeoutError) as e:
                # 断连退避重试, psubscribe 会在重连后由 redis-py 自动恢复
                print(f"[pubsub-redis] listener 断连: {e}, 2s 后重试",
                      flush=True)
                time.sleep(2)
            except Exception:
                traceback.print_exc()
                time.sleep(2)

    def _forward_to_local(self, channel: str, data: str) -> None:
        with self._lock:
            targets = list(self._local_subscribers.get(channel, ()))
        if not targets:
            return
        dead: list[Any] = []
        for ws in targets:
            try:
                ws.send(data)
            except Exception:
                dead.append(ws)
        if dead:
            with self._lock:
                s = self._local_subscribers.get(channel)
                if s:
                    for d in dead:
                        s.discard(d)
                    if not s:
                        self._local_subscribers.pop(channel, None)

    def subscribe(self, batch_id: str, ws: Any) -> None:
        channel = _channel_for(batch_id)
        with self._lock:
            self._local_subscribers.setdefault(channel, set()).add(ws)

    def unsubscribe(self, batch_id: str, ws: Any) -> None:
        channel = _channel_for(batch_id)
        with self._lock:
            s = self._local_subscribers.get(channel)
            if not s:
                return
            s.discard(ws)
            if not s:
                self._local_subscribers.pop(channel, None)

    def publish(self, batch_id: str, event: dict) -> int:
        channel = _channel_for(batch_id)
        payload = dict(event)
        payload.setdefault("ts", time.time())
        payload.setdefault("batch_id", batch_id)
        msg = json.dumps(payload, ensure_ascii=False)
        try:
            return int(self._redis.publish(channel, msg))
        except Exception:
            traceback.print_exc()
            return 0  # 降级: 不阻断 worker / 业务

    def subscriber_count(self, batch_id: str) -> int:
        """仅本 worker 内的订阅数. 跨 worker 合计走 Redis PUBSUB NUMSUB, 本实现不做."""
        channel = _channel_for(batch_id)
        with self._lock:
            return len(self._local_subscribers.get(channel, ()))

    def stats(self) -> dict:
        with self._lock:
            per_channel = {
                _batch_id_from_channel(c): len(s)
                for c, s in self._local_subscribers.items()
            }
        return {
            "backend": "redis",
            "redis_url": self._url,
            "channel_prefix": _CHANNEL_PREFIX,
            "worker_local_listeners_per_batch": per_channel,
            "worker_local_batches": len(per_channel),
        }

    def close(self) -> None:
        self._stop.set()
        try:
            self._pubsub.punsubscribe(self._pattern)
            self._pubsub.close()
        except Exception:
            pass
        try:
            self._redis.close()
        except Exception:
            pass
