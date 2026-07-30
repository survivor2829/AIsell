"""双资源池任务队列：批量池 + 单品池 + 精修池，互不阻塞。

PRD: PRD_批量生成.md F4 / F7

设计:
- 三个独立的 ThreadPoolExecutor (默认各 3 worker, env 可配)
- 状态存进程内 dict + threading.Lock (重启丢, 真源数据在 DB 的 Batch/BatchItem)
- 真实业务函数 batch_processor.process_one_product / refine_processor.refine_one_product
- 池计数器走 wrapper,不依赖 ThreadPoolExecutor 的私有字段

── 跨 worker 重入 / 并发安全 ───────────────────────────────────────
本模块的 submit_batch / submit_refine 内部 ValueError 检查是**单 worker 内**防重入,
不能跨 gunicorn worker (进程之间 _batches 字典互不可见).

真正的"跨 worker 原子 claim"在调用方 (app.py 的路由) 走 DB 条件 UPDATE 实现:
  /api/batch/<id>/start         → Batch.status uploaded/failed → queued (CAS)
  /api/batch/<id>/ai-refine-start → BatchItem.ai_refine_status not_requested/failed → queued
                                    (with_for_update + skip_locked)

两层防线的语义:
- DB claim: 跨 worker 互斥 (Postgres 行锁 / SQLite 单写). 最主要的一道.
- 进程内 ValueError: 同 worker 内误重入兜底 (比如 processor_fn 异步回调里意外再次提交).

如果只剩一层 DB claim, 某 worker 线程调栈里双重提交仍能绕过 — 所以保留两层.
"""
from __future__ import annotations

import os
import random
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

# 并发数 (PRD F4: 默认 3,可配)
BATCH_POOL_SIZE = int(os.environ.get("BATCH_POOL_SIZE", "3"))
SINGLE_POOL_SIZE = int(os.environ.get("SINGLE_POOL_SIZE", "3"))
# 任务11: 精修池独立,不挤 HTML 阶段的批量池
REFINE_POOL_SIZE = int(os.environ.get("REFINE_POOL_SIZE", "3"))

# 处理器签名: (batch_id 或 task_id, payload) -> result_dict
ProcessorFn = Callable[[str, dict], dict]

# 状态变更回调签名: (batch_id, product_name, status, result_or_None, error_or_None)
# 用于把 worker 状态实时推到 DB / WebSocket / 任何外部副作用容器。
StateChangeFn = Callable[[str, str, str, dict | None, str | None], None]


# ── 池统计计数器 ─────────────────────────────────────────────────────
@dataclass
class _PoolStats:
    name: str
    max_workers: int
    active: int = 0
    queued: int = 0
    done: int = 0
    failed: int = 0


_lock = threading.Lock()  # 保护下面所有状态

_batch_stats = _PoolStats(name="batch_pool", max_workers=BATCH_POOL_SIZE)
_single_stats = _PoolStats(name="single_pool", max_workers=SINGLE_POOL_SIZE)
_refine_stats = _PoolStats(name="refine_pool", max_workers=REFINE_POOL_SIZE)

_batch_pool = ThreadPoolExecutor(max_workers=BATCH_POOL_SIZE,
                                  thread_name_prefix="batch")
_single_pool = ThreadPoolExecutor(max_workers=SINGLE_POOL_SIZE,
                                   thread_name_prefix="single")
_refine_pool = ThreadPoolExecutor(max_workers=REFINE_POOL_SIZE,
                                   thread_name_prefix="refine")

# 状态字典: {batch_id: {batch_id, batch_name, created_at, products:{name:state}}}
_batches: dict[str, dict] = {}
# {task_id: {task_id, status, payload, started_at, finished_at, error, result}}
_single_tasks: dict[str, dict] = {}
# 任务11 精修状态: {batch_id: {batch_id, created_at, products:{name:state}}}
# 跟 _batches 平行存在,因为精修走独立池 + 独立生命周期 (HTML 完成后才开始)
_refine_batches: dict[str, dict] = {}


# ── 批量池：按批次提交 N 个产品任务 ─────────────────────────────────
def submit_batch(batch_id: str, batch_name: str,
                 products: list[dict], processor_fn: ProcessorFn,
                 on_state_change: StateChangeFn | None = None) -> dict:
    """把一个批次的所有产品扔进批量池。

    products: [{"name": "产品A", ...其它字段透传给 processor_fn}, ...]
    on_state_change: 每次产品 status 变更时回调 (在 _lock 外执行,可做 DB I/O)。
                     回调抛错不会影响 worker (吞掉并打 traceback)。
    raises: ValueError 如果 batch_id 已存在 (避免重复触发覆盖状态)
    """
    with _lock:
        if batch_id in _batches:
            existing = _batches[batch_id]
            running = sum(1 for p in existing["products"].values()
                         if p["status"] in ("pending", "processing"))
            raise ValueError(
                f"batch_id 已存在 (running={running}, total={len(existing['products'])})"
            )
        product_states = {
            p["name"]: {
                "name": p["name"],
                "status": "pending",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "result": None,
            } for p in products
        }
        state = {
            "batch_id": batch_id,
            "batch_name": batch_name,
            "created_at": time.time(),
            "products": product_states,
        }
        _batches[batch_id] = state

    def _build_on_status(product_name: str):
        def _cb(status: str, result: dict | None, err: str | None) -> None:
            _update_batch_product(batch_id, product_name, status, result, err)
            if on_state_change is not None:
                try:
                    on_state_change(batch_id, product_name, status, result, err)
                except Exception:
                    traceback.print_exc()  # 回调挂了不能卡死 worker
        return _cb

    for p in products:
        _submit_one(_batch_pool, _batch_stats,
                    work=lambda p=p: processor_fn(batch_id, p),
                    on_status=_build_on_status(p["name"]))
    return state


def _update_batch_product(batch_id: str, name: str, status: str,
                          result: dict | None, error: str | None) -> None:
    with _lock:
        ps = _batches.get(batch_id, {}).get("products", {}).get(name)
        if not ps:
            return
        ps["status"] = status
        if status == "processing":
            ps["started_at"] = time.time()
        elif status in ("done", "failed"):
            ps["finished_at"] = time.time()
            ps["result"] = result
            ps["error"] = error


# ── 单品池：散提交 ──────────────────────────────────────────────────
def submit_single(task_id: str, payload: dict, processor_fn: ProcessorFn,
                  user_id: int | None = None) -> dict:
    """提交一个单品任务到单品池.

    user_id: 任务发起人 ID (P4 §A.6 owner 标记). 路由轮询时校验 task_id ownership.
             None = 后台脚本 / mock (允许 admin 读, 普通用户 403).
    """
    with _lock:
        if task_id in _single_tasks:
            raise ValueError(f"task_id 已存在: {task_id}")
        state = {
            "task_id": task_id,
            "user_id": user_id,  # P4 §A.6: owner 标记防 IDOR
            "status": "pending",
            "payload": payload,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "result": None,
            "created_at": time.time(),
        }
        _single_tasks[task_id] = state

    _submit_one(_single_pool, _single_stats,
                work=lambda: processor_fn(task_id, payload),
                on_status=lambda status, result, err:
                    _update_single_task(task_id, status, result, err))
    return state


def _update_single_task(task_id: str, status: str,
                        result: dict | None, error: str | None) -> None:
    with _lock:
        ts = _single_tasks.get(task_id)
        if not ts:
            return
        ts["status"] = status
        if status == "processing":
            ts["started_at"] = time.time()
        elif status in ("done", "failed"):
            ts["finished_at"] = time.time()
            ts["result"] = result
            ts["error"] = error


# ── 精修池 (任务11):独立于批量池,HTML 版完成后才走 ───────────────────
def submit_refine(batch_id: str, items: list[dict],
                  processor_fn: ProcessorFn,
                  on_state_change: StateChangeFn | None = None) -> dict:
    """把一批 BatchItem 扔进精修池。

    签名跟 submit_batch 几乎一致,但:
      - 用独立池 _refine_pool (不挡 HTML 阶段)
      - 状态存到 _refine_batches (不污染 _batches)
      - 允许同 batch_id 多次提交 (重跑场景) — 新提交的 item 覆盖旧状态

    items: [{"name": ..., ...其它字段透传给 processor_fn}, ...]
    on_state_change: 每次产品 status 变更回调 (在 _lock 外执行)
    """
    with _lock:
        existing = _refine_batches.get(batch_id)
        if existing is None:
            existing = {
                "batch_id": batch_id,
                "created_at": time.time(),
                "products": {},
            }
            _refine_batches[batch_id] = existing
        for p in items:
            existing["products"][p["name"]] = {
                "name": p["name"],
                "status": "pending",
                "started_at": None,
                "finished_at": None,
                "error": None,
                "result": None,
            }
        state_snapshot = dict(existing)

    def _build_on_status(product_name: str):
        def _cb(status: str, result: dict | None, err: str | None) -> None:
            _update_refine_product(batch_id, product_name, status, result, err)
            if on_state_change is not None:
                try:
                    on_state_change(batch_id, product_name, status, result, err)
                except Exception:
                    traceback.print_exc()
        return _cb

    for p in items:
        _submit_one(_refine_pool, _refine_stats,
                    work=lambda p=p: processor_fn(batch_id, p),
                    on_status=_build_on_status(p["name"]))
    return state_snapshot


def _update_refine_product(batch_id: str, name: str, status: str,
                           result: dict | None, error: str | None) -> None:
    with _lock:
        ps = _refine_batches.get(batch_id, {}).get("products", {}).get(name)
        if not ps:
            return
        ps["status"] = status
        if status == "processing":
            ps["started_at"] = time.time()
        elif status in ("done", "failed"):
            ps["finished_at"] = time.time()
            ps["result"] = result
            ps["error"] = error


def get_refine_status(batch_id: str) -> dict | None:
    with _lock:
        state = _refine_batches.get(batch_id)
        if not state:
            return None
        products_list = [dict(p) for p in state["products"].values()]
    counts = {"pending": 0, "processing": 0, "done": 0, "failed": 0}
    for p in products_list:
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    return {
        "batch_id": state["batch_id"],
        "created_at": state["created_at"],
        "total": len(products_list),
        **counts,
        "products": products_list,
    }


# ── 池公共 wrapper:管 active/queued 计数 + 失败兜底 ──────────────────
def _submit_one(pool: ThreadPoolExecutor, stats: _PoolStats,
                work: Callable[[], dict],
                on_status: Callable[..., None]) -> None:
    """所有提交都走这,统一统计 + 异常吞掉防止整批崩 (PRD F7)。"""
    with _lock:
        stats.queued += 1

    def runner() -> None:
        with _lock:
            stats.queued -= 1
            stats.active += 1
        on_status("processing", None, None)
        try:
            result = work()
            on_status("done", result, None)
            with _lock:
                stats.active -= 1
                stats.done += 1
        except Exception as e:
            err_msg = f"{type(e).__name__}: {e}"
            traceback.print_exc()  # 失败必须打日志 (用户偏好规则)
            on_status("failed", None, err_msg)
            with _lock:
                stats.active -= 1
                stats.failed += 1

    pool.submit(runner)


# ── 状态查询 ────────────────────────────────────────────────────────
def get_batch_status(batch_id: str) -> dict | None:
    with _lock:
        state = _batches.get(batch_id)
        if not state:
            return None
        products_list = [dict(p) for p in state["products"].values()]
    counts = {"pending": 0, "processing": 0, "done": 0, "failed": 0}
    for p in products_list:
        counts[p["status"]] = counts.get(p["status"], 0) + 1
    return {
        "batch_id": state["batch_id"],
        "batch_name": state["batch_name"],
        "created_at": state["created_at"],
        "total": len(products_list),
        **counts,
        "products": products_list,
    }


def get_single_status(task_id: str) -> dict | None:
    with _lock:
        ts = _single_tasks.get(task_id)
        return dict(ts) if ts else None


def get_pool_stats() -> dict:
    with _lock:
        return {
            "batch_pool": {
                "max_workers": _batch_stats.max_workers,
                "active": _batch_stats.active,
                "queued": _batch_stats.queued,
                "done": _batch_stats.done,
                "failed": _batch_stats.failed,
            },
            "single_pool": {
                "max_workers": _single_stats.max_workers,
                "active": _single_stats.active,
                "queued": _single_stats.queued,
                "done": _single_stats.done,
                "failed": _single_stats.failed,
            },
            "refine_pool": {
                "max_workers": _refine_stats.max_workers,
                "active": _refine_stats.active,
                "queued": _refine_stats.queued,
                "done": _refine_stats.done,
                "failed": _refine_stats.failed,
            },
            "batches_in_memory": len(_batches),
            "single_tasks_in_memory": len(_single_tasks),
            "refine_batches_in_memory": len(_refine_batches),
        }


# ── Mock 处理器 (任务4 替换为真实业务) ─────────────────────────────
def mock_processor(scope_id: str, payload: dict) -> dict:
    """模拟处理:随机 sleep 1-3 秒,10% 概率抛错。

    用于任务2 验证池行为,不接任何真实业务。
    """
    delay = random.uniform(1.0, 3.0)
    time.sleep(delay)
    if random.random() < 0.10:
        raise RuntimeError(f"模拟失败 ({payload.get('name') or scope_id})")
    return {
        "scope_id": scope_id,
        "name": payload.get("name"),
        "delay_seconds": round(delay, 2),
        "fake_html_path": f"mock/{scope_id}/{payload.get('name', 'task')}.jpg",
        # 任务7: 让 mock 流程也能演示前端"完成→显示缩略图→勾选 AI 精修"。
        # 真实 worker(batch_processor)走 _render_product_preview 出真 preview.png。
        "preview_png": payload.get("main_image_path") or "",
    }
