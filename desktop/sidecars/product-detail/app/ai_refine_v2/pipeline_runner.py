"""AI 精修 v2 · 端到端管线 runner · 供 /api/ai-refine-v2/execute 调用.

职责:
  Planner (DeepSeek)  →  动态多屏 planning
  Generator (APIMart) →  对应 AI 精修图
  Assembler (Jinja + Playwright) → assembled.png

特性:
  - 后台线程执行 (3-5 分钟), POST /execute 立即返回 task_id
  - 任务状态/进度/结果存在模块级 dict
  - GET /status/<task_id> 轮询进度
  - **Key 缺失自动降级 mock**: 返回 4/23 那批现成的 6 张占位图,让 UI 能走通
    - DEEPSEEK_API_KEY 缺 → 用 smoke_output_v2/_planning.json (预置)
    - REFINE_API_KEY 缺 → 跳过真 API 调用, 复用 static/smoke_output_v2/block_*.jpg

任务状态机:
  pending → running_planner → running_generator → running_assembler
                                                   ↳ success | partial_success
                                                   ↳ recovery_required | failed

Why not Celery/RQ:
  单机 Flask 项目, 无需消息队列. 内存 dict 够用, 重启全清.
"""
from __future__ import annotations

import json
import os
import shutil
import concurrent.futures
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from browser_runtime import launch_chromium

_RESOURCE_ROOT = Path(
    os.environ.get(
        "XIAOXI_PRODUCT_DETAIL_RESOURCE_DIR",
        Path(__file__).resolve().parents[1],
    )
).resolve()
_DATA_ROOT = Path(
    os.environ.get("XIAOXI_PRODUCT_DETAIL_DATA_DIR", _RESOURCE_ROOT)
).resolve()
_REPO_ROOT = _DATA_ROOT
_OUTPUT_BASE = _DATA_ROOT / "static" / "ai_refine_v2"
_MOCK_IMAGES_DIR = _RESOURCE_ROOT / "static" / "smoke_output_v2"  # 4/23 占位图来源
_MOCK_PLANNING = _RESOURCE_ROOT / "smoke_output_v2" / "_planning.json"


# ─────────────────────────────────────────────────────────────
# 任务状态
# ─────────────────────────────────────────────────────────────
@dataclass
class TaskState:
    task_id: str
    # P4 §A.6: owner 标记防 IDOR. None = 历史任务 (无 owner) → 仅 admin 可读.
    user_id: int | None = None
    status: str = "pending"  # running_* | success | partial_success | recovery_required | failed | outcome_unknown
    mode: str = "unknown"     # real | mock | partial-mock
    progress_pct: int = 0     # 0-100
    progress_msg: str = "排队中..."
    started_at: float = field(default_factory=time.time)
    elapsed_s: float = 0.0
    cost_rmb: float = 0.0
    # 结果
    planning: dict | None = None
    blocks: list[dict] = field(default_factory=list)
    # 保留 APIMart CDN 的原始 URL (与 blocks 同序). 本机下载挂掉时用来救图 —
    # 不然 blocks[i].image_url 会被 pipeline 覆盖成本地 /static/... 路径, 原 URL 丢失.
    raw_urls: list[str] = field(default_factory=list)
    assembled_url: str = ""
    planned_count: int = 0
    success_count: int = 0
    failed_count: int = 0
    # 错误
    error: str = ""
    error_trace: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


_TASKS: dict[str, TaskState] = {}
_TASKS_LOCK = threading.Lock()
_RECOVERY_TASK_IDS: set[str] = set()


class PaidResultRecoveryRequired(RuntimeError):
    """Paid provider results exist and must be recovered, never resubmitted."""

    do_not_retry = True
    outcome_unknown = False
    recovery_required = True


def _set(task_id: str, **fields):
    with _TASKS_LOCK:
        st = _TASKS.get(task_id)
        if st is None:
            return
        for k, v in fields.items():
            setattr(st, k, v)
        st.elapsed_s = round(time.time() - st.started_at, 1)


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write JSON through a same-directory temporary file and atomic replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _result_counts(blocks: list[dict], planned_count: int) -> tuple[int, int, int]:
    planned = max(int(planned_count or 0), len(blocks))
    success = sum(1 for block in blocks if bool(block.get("success")))
    failed = max(planned - success, 0)
    return planned, success, failed


def _task_identity(task_id: str) -> tuple[int | None, str]:
    with _TASKS_LOCK:
        state = _TASKS.get(task_id)
        if state is None:
            return None, "unknown"
        return state.user_id, state.mode


def _persist_recovery(
    task_dir: Path,
    blocks: list[dict],
    total_cost_rmb: float,
    planned_count: int,
    *,
    status: str,
    error: str = "",
    schema_mode: str = "",
) -> dict:
    """Persist provider URLs and local download state before terminal assembly."""
    planned, success, failed = _result_counts(blocks, planned_count)
    user_id, mode = _task_identity(task_dir.name)
    payload = {
        "schema_version": 1,
        "task_id": task_dir.name,
        "user_id": user_id,
        "mode": mode,
        "schema_mode": schema_mode,
        "status": status,
        "planned_count": planned,
        "success_count": success,
        "failed_count": failed,
        "total_cost_rmb": float(total_cost_rmb or 0.0),
        "raw_urls": [str(block.get("raw_url") or "") for block in blocks],
        "blocks": blocks,
        "error": str(error or ""),
        "updated_at": time.time(),
    }
    _atomic_write_json(task_dir / "_recovery.json", payload)
    return payload


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def _status_from_record(task_id: str, data: dict, *, terminal: bool) -> dict:
    blocks = data.get("blocks", []) or []
    raw_urls = data.get("raw_urls", []) or []
    inferred_planned, inferred_success, inferred_failed = _result_counts(
        blocks, int(data.get("planned_count", 0) or len(raw_urls) or len(blocks)),
    )
    planned = int(data.get("planned_count", inferred_planned) or inferred_planned)
    success = int(data.get("success_count", inferred_success) or 0)
    failed = int(data.get("failed_count", inferred_failed) or 0)
    planned = max(planned, len(blocks), success + failed)
    failed = max(failed, planned - success)
    if terminal:
        status = str(data.get("terminal_status") or "").strip()
        if status not in {"success", "partial_success"}:
            status = "success" if failed == 0 else "partial_success"
        if status == "success" and failed:
            status = "partial_success"
        progress_pct = 100
        progress_msg = (
            "已完成 (从磁盘恢复)"
            if status == "success"
            else f"部分完成 {success}/{planned} (从磁盘恢复)"
        )
    else:
        recorded_status = str(data.get("status") or "").strip()
        # A persisted recovery worker disappears when the process exits.  Do not
        # expose that stale disk marker as a live worker after restart; make the
        # original task recoverable again instead.
        if recorded_status == "running_recovery":
            recorded_status = "recovery_required"
        status = (
            recorded_status
            if recorded_status in {
                "outcome_unknown", "recovery_required", "failed",
            }
            else "recovery_required"
        )
        progress_pct = 100 if status == "failed" else 90
        progress_msg = (
            "原付费任务结果仍不确定，已停止自动重提"
            if status == "outcome_unknown"
            else (
                "原任务已明确失败，未自动重提"
                if status == "failed"
                else "已保留付费结果，等待恢复下载/拼装"
            )
        )
    return {
        "task_id": task_id,
        "user_id": data.get("user_id"),
        "status": status,
        "mode": data.get("mode", "unknown"),
        "progress_pct": progress_pct,
        "progress_msg": progress_msg,
        "started_at": 0.0,
        "elapsed_s": 0.0,
        "cost_rmb": float(data.get("total_cost_rmb", 0.0) or 0.0),
        "planning": None,
        "blocks": blocks,
        "raw_urls": raw_urls,
        "assembled_url": "",
        "planned_count": planned,
        "success_count": success,
        "failed_count": failed,
        "error": str(data.get("error") or ""),
        "error_trace": "",
    }


def get_task_status(task_id: str) -> dict | None:
    """读 task 状态. 优先 in-memory, 缺失时从磁盘 _summary.json 重建.

    Why fallback: in-memory _TASKS 在 worker 重启 / 内存清理后会丢失,
    但磁盘 _summary.json + 8 屏图 + assembled.png 仍保留. 不 fallback 的话
    端点返 404 → 前端误报"AI精修失败" (实际任务已成功). 真实事故见
    2026-05-07 v2_1778126382035_b3cca1: 8 屏 success + assembled.png 13MB
    在磁盘但 _TASKS 内存丢, 用户被迫重跑浪费 ¥5.6.

    桌面任务把 user_id 持久化到 _summary.json，重启后仍可执行 owner 校验。
    早期没有 user_id 的历史任务继续只允许 admin 读取。
    """
    with _TASKS_LOCK:
        st = _TASKS.get(task_id)
        if st:
            return st.to_dict()

    # Fallback: only a decodable assembled image plus terminal summary is success.
    task_dir = _OUTPUT_BASE / task_id
    summary_data = _read_json(task_dir / "_summary.json")
    if summary_data is not None:
        result = _status_from_record(task_id, summary_data, terminal=True)
        try:
            _validate_assembled_png(task_dir / "assembled.png")
        except Exception as exc:
            result["status"] = (
                "recovery_required" if any(result["raw_urls"]) else "failed"
            )
            result["progress_pct"] = 90
            result["progress_msg"] = "成品校验失败，已保留原始结果"
            result["error"] = f"assembled.png 校验失败: {exc}"
            return result
        result["assembled_url"] = f"/static/ai_refine_v2/{task_id}/assembled.png"
        return result

    recovery_data = _read_json(task_dir / "_recovery.json")
    if recovery_data is not None and (
        recovery_data.get("status") in {
            "outcome_unknown", "recovery_required", "running_recovery", "failed",
        }
        or any(recovery_data.get("raw_urls", []) or [])
        or any(
            str(block.get("provider_task_id") or "")
            for block in (recovery_data.get("blocks", []) or [])
            if isinstance(block, dict)
        )
    ):
        return _status_from_record(task_id, recovery_data, terminal=False)
    return None


# ─────────────────────────────────────────────────────────────
# Key 探测 + 模式决定 + 临时安全阀 (PRD §阶段五真测前)
# ─────────────────────────────────────────────────────────────
def _is_real_api_allowed() -> bool:
    """开发环境临时安全阀: 防止本机/UI 误点烧钱.

    仅 FLASK_ENV=development 时生效; 生产环境配了真 key 就应按真实模式运行.
    开发环境可用 V2_ALLOW_REAL_API=true 临时解锁真 API.
    """
    if os.environ.get("FLASK_ENV", "").strip().lower() != "development":
        return True
    return os.environ.get("V2_ALLOW_REAL_API", "").strip().lower() == "true"


def _apply_safety_valve(deepseek_key: str, gpt_image_key: str) -> tuple[str, str]:
    """安全阀闸门: 关时清空 keys, 让下游一律走 mock 路径.

    返回过滤后的 (deepseek_key, gpt_image_key). 安全阀开则透传.
    """
    if _is_real_api_allowed():
        return deepseek_key, gpt_image_key
    return "", ""


def _detect_mode(deepseek_key: str, gpt_image_key: str) -> str:
    # 安全阀关 + 任意真 key 在 → 强制 mock + 打提示日志, 防 UI 误点烧钱
    if not _is_real_api_allowed():
        if deepseek_key or gpt_image_key:
            print(
                "[v2-safety] real_api_allowed=False, forcing mock mode "
                "(set V2_ALLOW_REAL_API=true to unlock for stage-5 real test)"
            )
        return "mock"
    if deepseek_key and gpt_image_key:
        return "real"
    if gpt_image_key and not deepseek_key:
        return "partial-mock"  # 真 planner 得不到, 只有图能真
    return "mock"  # planner 和 generator 全占位


# ─────────────────────────────────────────────────────────────
# Mock planning (无 DEEPSEEK_API_KEY 时用)
# ─────────────────────────────────────────────────────────────
def _load_mock_planning(product_text: str, product_title: str) -> dict:
    """回落到 4/23 demo 的 planning, 但把 product name 替换为当前输入."""
    if _MOCK_PLANNING.is_file():
        data = json.loads(_MOCK_PLANNING.read_text(encoding="utf-8"))
    else:
        data = {
            "product_meta": {
                "name": product_title or "产品",
                "category": "device",
                "primary_color": "orange and black",
                "key_visual_parts": ["主体", "操作面板"],
                "proportions": "compact unit",
            },
            "planning": {
                "total_blocks": 6,
                "block_order": [1, 2, 3, 4, 5, 6],
                "hero_scene_hint": "工业场景",
            },
            "selling_points": [
                {"idx": i, "text": f"卖点 {i}"} for i in range(1, 6)
            ],
        }
    # 用前端输入覆盖 name (让 UI 看起来"是我的产品")
    if product_title:
        data.setdefault("product_meta", {})["name"] = product_title
    return data


# ─────────────────────────────────────────────────────────────
# Mock images (无 REFINE_API_KEY 时用)
# ─────────────────────────────────────────────────────────────
def _copy_mock_images(task_dir: Path) -> list[dict]:
    """把 4/23 demo 的 6 张占位图复制到 task_dir.

    返回 blocks 列表 (含 block_id / visual_type / is_hero / file / image_url).
    """
    task_dir.mkdir(parents=True, exist_ok=True)
    mock_files = sorted(_MOCK_IMAGES_DIR.glob("block_*.jpg"))
    if len(mock_files) < 6:
        raise RuntimeError(
            f"Mock images 不足 6 张, 只找到 {len(mock_files)}. "
            f"请先跑过 4/23 的 demo 生成 {_MOCK_IMAGES_DIR}/block_*.jpg"
        )

    # 解析视觉类型 (从文件名: block_01_product_in_scene.jpg → product_in_scene)
    blocks = []
    for i, src in enumerate(mock_files[:6], start=1):
        stem_parts = src.stem.split("_", 2)
        visual_type = stem_parts[2] if len(stem_parts) >= 3 else "product_in_scene"
        dst_name = f"block_{i:02d}.jpg"
        dst = task_dir / dst_name
        shutil.copy2(src, dst)
        blocks.append({
            "block_id": i,
            "visual_type": visual_type,
            "is_hero": (i == 1),
            "file": dst_name,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{dst_name}",
            "success": True,
            "placeholder": True,  # 标记是占位图, UI 可以显示 badge
        })
    return blocks


# ─────────────────────────────────────────────────────────────
# v2 mock helpers (PRD §阶段二·任务 2.2): 缺 key 时走 v2 mock 路径
# ─────────────────────────────────────────────────────────────
def _load_mock_planning_v2(product_text: str, product_title: str) -> dict:
    """v3 schema mock planning (PRD AI_refine_v3.1). 8 屏最小合规 dict.

    v3: 6 → 8 屏, 含必出 3 屏 (hero/brand_quality/spec_table),
    spec_table 屏走 SCOTT_OVERRIDE 模式 (deliberate_dna_divergence=True).
    unified_visual_treatment 含 v3 关键词 (warm golden-hour + industrial cool tones).

    每屏 prompt ≥200 字符, 让 generate_v2 不会因空 prompt 跳过.
    第一版用硬编码 fallback; 未来可选从 stage1_eval_output/ 加载真样本.
    """
    from ai_refine_v2.refine_planner import (
        _LAYOUT_HINTS_V2,
        _NEGATIVE_GUARD_PARTS_V2,
    )

    name = product_title or "MockProduct 测试产品"
    base_prompt = (
        "Mock planning v2 screen prompt with cinematic low-angle shot, "
        "industrial yellow body anchored at center-right, bold white display "
        "headline reading 「" + name + "」 at upper-left with generous negative "
        "space, cool steel-blue rim light, magazine-cover composition. "
        "All Chinese characters render sharp, accurate, no typos."
    )
    # v3.2 精修: 8 屏 (必出 4 屏 hero/brand_quality/spec_table/lifestyle_demo + 4 高优)
    roles = ["hero", "feature_wall", "scenario", "vs_compare",
             "detail_zoom", "lifestyle_demo", "brand_quality", "spec_table"]
    screens = []
    negative_guard = ". ".join(_NEGATIVE_GUARD_PARTS_V2) + "."
    for i, role in enumerate(roles, start=1):
        layout_hint = (_LAYOUT_HINTS_V2.get(role) or ("editorial layout",))[0]
        screen = {
            "idx": i,
            "role": role,
            "title": f"屏 {i} · {role}",
            "prompt": (
                f"Screen {i} ({role}): {base_prompt} "
                f"Layout contract: {layout_hint}. {negative_guard}"
            ),
        }
        # v3: SCOTT_OVERRIDE 屏 (spec_table / FAQ) 必须设 deliberate_dna_divergence=True
        if role in ("spec_table", "FAQ"):
            screen["deliberate_dna_divergence"] = True
        screens.append(screen)
    return {
        "product_meta": {
            "name": name,
            "category": "设备类",
            "primary_color": "industrial yellow",
            "key_visual_parts": ["body", "wheels", "sensor"],
        },
        "style_dna": {
            "color_palette": "mock palette with multiple tones for dev testing",
            "lighting": "mock lighting from upper-left with cool fill",
            "composition_style": "mock asymmetric editorial layout dev",
            "mood": "mock dev confident",
            "typography_hint": "mock sans-serif",
            # v3: unified_visual_treatment 改用 v3 关键词 (warm golden-hour + industrial cool tones)
            "unified_visual_treatment": (
                "mock cinematic photography with warm golden-hour atmosphere "
                "and industrial cool tones for technical screens, dev testing"
            ),
        },
        "screen_count": 8,
        "screens": screens,
    }


def _copy_mock_images_v2(task_dir: Path, n: int) -> list[dict]:
    """复制 N 张 4/23 占位图到 task_dir, 返回 v2 风格 blocks.

    n 屏 (6-10), 4/23 demo 只有 6 张, 不够时循环复用.
    block_id 用 'screen_<NN>_<role>' 格式 (跟 generate_v2 一致).
    """
    task_dir.mkdir(parents=True, exist_ok=True)
    mock_files = sorted(_MOCK_IMAGES_DIR.glob("block_*.jpg"))
    if not mock_files:
        raise RuntimeError(
            f"Mock images 一张都没找到. 请先跑过 4/23 demo 生成 "
            f"{_MOCK_IMAGES_DIR}/block_*.jpg"
        )
    roles = ["hero", "feature_wall", "scenario", "vs_compare",
             "spec_table", "brand_quality", "value_story", "detail_zoom",
             "feature_wall", "scenario"][:n]
    blocks: list[dict] = []
    for i, role in enumerate(roles, start=1):
        src = mock_files[(i - 1) % len(mock_files)]
        bid = f"screen_{i:02d}_{role}"
        dst_name = f"block_{i:02d}_{bid}.jpg"
        dst = task_dir / dst_name
        shutil.copy2(src, dst)
        blocks.append({
            "block_id": bid,
            "visual_type": role,
            "is_hero": (i == 1),
            "file": dst_name,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{dst_name}",
            "raw_url": "",  # mock 没有 APIMart 原始 URL
            "success": True,
            "placeholder": True,  # 占位图 badge
        })
    return blocks


# ─────────────────────────────────────────────────────────────
# 真 Generator (REFINE_API_KEY 已配时)
# ─────────────────────────────────────────────────────────────
def _download_image(url: str, dst: Path, retries: int = 2,
                    timeout: int = 30,
                    preferred_route: str = "unknown") -> str:
    """沿用 APIMart 已验证路由下载结果；该路径绝不提交新生图任务。"""
    import ai_image_apimart

    return ai_image_apimart.download_result_image(
        url,
        dst,
        preferred_route=preferred_route,
        timeout=timeout,
        retries=retries,
    )


def _make_provider_checkpoint(
    task_dir: Path,
    provider_blocks: list[dict],
    planned_count: int,
    *,
    schema_mode: str,
):
    """Return a block-bound callback that durably records every provider event."""
    checkpoint_lock = threading.Lock()
    blocks: list[dict] = []
    for idx, source in enumerate(provider_blocks):
        block_id = str(source.get("block_id") or f"block_{idx + 1}")
        safe_bid = block_id.replace("/", "_").replace("\\", "_")
        filename = f"block_{idx + 1:02d}_{safe_bid}.jpg"
        blocks.append({
            "block_id": block_id,
            "visual_type": str(source.get("visual_type") or "screen"),
            "is_hero": bool(source.get("is_hero") or idx == 0),
            "file": filename,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{filename}",
            "raw_url": "",
            "provider_task_id": "",
            "download_route": "unknown",
            "success": False,
            "placeholder": False,
            "error": "",
        })
    by_id = {block["block_id"]: block for block in blocks}
    _persist_recovery(
        task_dir,
        blocks,
        0.0,
        planned_count,
        status="submitting",
        schema_mode=schema_mode,
    )

    def checkpoint(block_id: str, event: dict) -> None:
        with checkpoint_lock:
            block = by_id.get(str(block_id))
            if block is None:
                raise RuntimeError(f"未知 provider block_id: {block_id}")
            provider_task_id = str(event.get("provider_task_id") or "").strip()
            if provider_task_id:
                block["provider_task_id"] = provider_task_id
            route = str(event.get("route") or "").strip()
            if route in {"system", "direct"}:
                block["download_route"] = route
            raw_url = str(event.get("raw_url") or "").strip()
            if raw_url:
                block["raw_url"] = raw_url
            block["provider_status"] = str(event.get("event") or "")
            if event.get("error"):
                block["error"] = str(event["error"])
            _persist_recovery(
                task_dir,
                blocks,
                0.0,
                planned_count,
                status="generating",
                schema_mode=schema_mode,
            )
            _set(
                task_dir.name,
                blocks=blocks,
                raw_urls=[str(item.get("raw_url") or "") for item in blocks],
                planned_count=planned_count,
            )

    return checkpoint


def _download_generation_results(
    result_blocks,
    task_dir: Path,
    total_cost_rmb: float,
    planned_count: int,
    *,
    schema_mode: str,
    is_v2: bool,
) -> list[dict]:
    """Checkpoint every provider URL, then download without any resubmission."""
    import ai_image_apimart

    checkpoint = _read_json(task_dir / "_recovery.json") or {}
    checkpoint_by_id = {
        str(block.get("block_id") or ""): block
        for block in (checkpoint.get("blocks", []) or [])
        if isinstance(block, dict)
    }
    blocks: list[dict] = []
    for idx, provider_block in enumerate(result_blocks):
        safe_bid = str(provider_block.block_id).replace("/", "_").replace("\\", "_")
        filename = f"block_{idx + 1:02d}_{safe_bid}.jpg"
        raw_url = str(provider_block.image_url or "")
        provider_failed = bool(provider_block.placeholder or not raw_url)
        prior = checkpoint_by_id.get(str(provider_block.block_id), {})
        blocks.append({
            "block_id": provider_block.block_id,
            "visual_type": provider_block.visual_type,
            "is_hero": (idx == 0) if is_v2 else (provider_block.block_id == "hero"),
            "file": filename,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{filename}",
            "raw_url": raw_url,
            "provider_task_id": str(prior.get("provider_task_id") or ""),
            "download_route": str(
                prior.get("download_route")
                or ai_image_apimart.get_result_route(raw_url)
            ),
            "success": False,
            "placeholder": provider_failed,
            "error": str(provider_block.error or ""),
        })

    # This write is deliberately before the first network GET. A crash or CDN
    # outage can no longer erase URLs for already-billed provider results.
    _persist_recovery(
        task_dir,
        blocks,
        total_cost_rmb,
        planned_count,
        status="results_ready",
        schema_mode=schema_mode,
    )

    download_errors: list[str] = []
    for block in blocks:
        raw_url = block["raw_url"]
        if raw_url and not block["placeholder"]:
            try:
                destination = task_dir / block["file"]
                selected_route = _download_image(
                    raw_url,
                    destination,
                    retries=2,
                    preferred_route=block["download_route"],
                )
                if not _valid_local_image(destination):
                    raise PaidResultRecoveryRequired(
                        f"下载后的图片无法解码: {block['block_id']}"
                    )
                block["download_route"] = selected_route or block["download_route"]
                block["success"] = True
            except Exception as exc:
                block["placeholder"] = True
                block["error"] = str(exc)
                download_errors.append(f"{block['block_id']}: {exc}")
            _persist_recovery(
                task_dir,
                blocks,
                total_cost_rmb,
                planned_count,
                status="downloading",
                schema_mode=schema_mode,
            )
    if download_errors:
        message = (
            f"本地下载 {len(download_errors)}/{len(blocks)} 张付费结果失败: "
            f"{download_errors}. 原始 URL 已原子保存，禁止重新提交生图任务."
        )
        _persist_recovery(
            task_dir,
            blocks,
            total_cost_rmb,
            planned_count,
            status="recovery_required",
            error=message,
            schema_mode=schema_mode,
        )
        raise PaidResultRecoveryRequired(message)

    _persist_recovery(
        task_dir,
        blocks,
        total_cost_rmb,
        planned_count,
        status="ready_for_assembly",
        schema_mode=schema_mode,
    )
    return blocks


def _run_real_generator(planning: dict, product_image_url: str,
                        gpt_image_key: str, task_dir: Path,
                        progress_cb) -> tuple[list[dict], float]:
    """调 refine_generator.generate() 真调 APIMart, 下载图到 task_dir.

    progress_cb(pct, msg): 回调给 task state 更新进度. 分母按实际 block_order 算
    (planner 可能输出 ≠6 个 block, 比如 force_vs/force_scenes 会多加屏).

    BlockResult 的 schema: block_id(str) / visual_type(str) / prompt(str) /
    image_url(Optional[str]) / error(Optional[str]) / placeholder(bool).
    **没有 is_hero / success** — 这些要在本函数里推导.

    下载失败策略 (2026-04-24 后): 不再 placeholder 静默. 任何 block 下载失败
    重试耗尽后, 汇总错误并 raise RuntimeError, 让 _worker 走 failed 分支.
    每个 block 输出 dict 里保留 `raw_url` 字段 — 原始 APIMart CDN URL, 供救图.
    """
    from ai_refine_v2 import refine_generator

    task_dir.mkdir(parents=True, exist_ok=True)

    # 真实 block 总数以 planning.block_order 为准, 不硬编码 6
    plan_section = planning.get("planning") or {}
    total = len(plan_section.get("block_order") or []) or 6
    provider_checkpoint = _make_provider_checkpoint(
        task_dir,
        refine_generator._build_blocks(planning),
        total,
        schema_mode="v1",
    )

    completed = {"count": 0}

    def wrapped_api_call(
        prompt, image_data_url, api_key, thinking, size, *, lifecycle_callback=None,
    ):
        url = refine_generator._default_api_call(
            prompt,
            image_data_url,
            api_key,
            thinking=thinking,
            size=size,
            lifecycle_callback=lifecycle_callback,
        )
        completed["count"] += 1
        # 进度窗口 20-80 (前 20 给 planner, 后 20 给 assembler), 均摊到 total 张
        pct = 20 + int(completed["count"] / max(total, 1) * 60)
        progress_cb(min(pct, 80),
                    f"AI 精修中 {completed['count']}/{total}")
        return url

    result = refine_generator.generate(
        planning=planning,
        product_cutout_url=product_image_url,
        api_key=gpt_image_key,
        api_call_fn=wrapped_api_call,
        concurrency=3,
        max_retries_hero=2,
        max_retries_sp=1,
        lifecycle_callback=provider_checkpoint,
    )

    blocks = _download_generation_results(
        result.blocks,
        task_dir,
        result.total_cost_rmb,
        total,
        schema_mode="v1",
        is_v2=False,
    )
    return blocks, result.total_cost_rmb


# ─────────────────────────────────────────────────────────────
# v2 真 Generator (PRD §阶段二·任务 2.2): 4 刀 A/B/D guard 复用
# ─────────────────────────────────────────────────────────────
def _run_real_generator_v2(planning_v2: dict, product_image_url: str,
                            gpt_image_key: str, task_dir: Path,
                            progress_cb) -> tuple[list[dict], float]:
    """调 refine_generator.generate_v2() 真调 APIMart, 下载图到 task_dir.

    跟 _run_real_generator (v1) 完全等价的 4 刀 guard 模式, 只是调 generate_v2:
      A 刀: _build_noproxy_opener + _download_image (下载绕代理, 共享 v1 实现)
      B 刀: dl_errors 汇总 raise (下载失败 raise, 不静默 placeholder)
      D 刀: blocks[i].raw_url 保留 APIMart CDN URL (下载挂掉时救图用)

    E 刀 (assembled.png 太小) 在 _run_assembler_v2 里独立守门.
    """
    from ai_refine_v2 import refine_generator

    task_dir.mkdir(parents=True, exist_ok=True)

    # v2 总屏数从 screens 数组算 (跟 _run_real_generator 用 block_order 等价)
    screens = planning_v2.get("screens") or []
    total = len(screens) or 6
    provider_checkpoint = _make_provider_checkpoint(
        task_dir,
        refine_generator._build_blocks_v2(planning_v2),
        total,
        schema_mode="v2",
    )

    completed = {"count": 0}

    def wrapped_api_call(
        prompt, image_data_url, api_key, thinking, size, *, lifecycle_callback=None,
    ):
        url = refine_generator._default_api_call(
            prompt,
            image_data_url,
            api_key,
            thinking=thinking,
            size=size,
            lifecycle_callback=lifecycle_callback,
        )
        completed["count"] += 1
        # 进度窗口 20-80 (前 20 给 planner, 后 20 给 assembler)
        pct = 20 + int(completed["count"] / max(total, 1) * 60)
        progress_cb(min(pct, 80),
                    f"AI 精修 v2 中 {completed['count']}/{total}")
        return url

    result = refine_generator.generate_v2(
        planning_v2=planning_v2,
        product_cutout_url=product_image_url,
        api_key=gpt_image_key,
        api_call_fn=wrapped_api_call,
        concurrency=3,
        max_retries_hero=2,
        max_retries_sp=1,
        lifecycle_callback=provider_checkpoint,
    )

    blocks = _download_generation_results(
        result.blocks,
        task_dir,
        result.total_cost_rmb,
        total,
        schema_mode="v2",
        is_v2=True,
    )
    return blocks, result.total_cost_rmb


# ─────────────────────────────────────────────────────────────
# Assembler (Jinja + Playwright 截图)
# ─────────────────────────────────────────────────────────────
def _validate_assembled_png(
    path: Path,
    min_bytes: int = 100_000,
    min_width: int = 100,
    min_height: int = 100,
) -> tuple[int, int]:
    """检查 assembled.png 可完整解码、尺寸合理且不是微小空壳.

    2026-04-24 案例: 5 张 block 图下载失败 → Playwright 截 HTML 时 <img> 全 broken
    → 截出 1500×1800 纯白 PNG, 仅 11841 字节. 正常成品应 > 1MB.
    这是整条管线最后一道资产完整性 guard — 即便前面所有检查都漏了, 这里也能挡下.
    """
    if not path.is_file():
        raise RuntimeError(f"assembled.png 不存在: {path}")
    size = path.stat().st_size
    if size < min_bytes:
        raise RuntimeError(
            f"assembled.png 太小 ({size} 字节 < {min_bytes}), "
            f"疑源图缺失导致纯白 PNG. 请查上游 block 下载."
        )
    try:
        from PIL import Image

        with Image.open(path) as image:
            if image.format != "PNG":
                raise RuntimeError(f"格式不是 PNG: {image.format!r}")
            image.load()
            width, height = image.size
    except Exception as exc:
        raise RuntimeError(f"assembled.png 无法完整解码: {exc}") from exc
    if width < min_width or height < min_height:
        raise RuntimeError(
            f"assembled.png 尺寸异常 ({width}x{height}), "
            f"至少需要 {min_width}x{min_height}"
        )
    return width, height


def _write_terminal_summary(
    task_id: str,
    task_dir: Path,
    planning: dict,
    mode: str,
    blocks: list[dict],
    total_cost_rmb: float,
    planned_count: int,
    assembled_url: str,
    *,
    schema_mode: str,
) -> tuple[str, int, int, int]:
    """Validate the assembled asset, then atomically publish its terminal marker."""
    width, height = _validate_assembled_png(task_dir / "assembled.png")
    planned, success, failed = _result_counts(blocks, planned_count)
    terminal_status = "success" if failed == 0 else "partial_success"
    payload = {
        "schema_version": 2,
        "user_id": _task_identity(task_id)[0],
        "product": planning.get("product_meta", {}).get("name", ""),
        "mode": mode,
        "schema_mode": schema_mode,
        "terminal_status": terminal_status,
        "total_cost_rmb": float(total_cost_rmb or 0.0),
        "planned_count": planned,
        "success_count": success,
        "failed_count": failed,
        "raw_urls": [str(block.get("raw_url") or "") for block in blocks],
        "blocks": blocks,
        "assembled_url": assembled_url,
        "assembled_width": width,
        "assembled_height": height,
        "assembled_bytes": (task_dir / "assembled.png").stat().st_size,
        "completed_at": time.time(),
    }
    # _summary.json is the terminal marker and therefore must be written last.
    _atomic_write_json(task_dir / "_summary.json", payload)
    return terminal_status, planned, success, failed


def _record_worker_exception(
    task_id: str,
    task_dir: Path,
    exc: Exception,
    *,
    log_prefix: str,
) -> None:
    tb = traceback.format_exc()
    outcome_unknown = bool(getattr(exc, "outcome_unknown", False))
    recovery = _read_json(task_dir / "_recovery.json")
    provider_evidence = bool(
        recovery
        and any(
            str(block.get("raw_url") or block.get("provider_task_id") or "")
            for block in (recovery.get("blocks", []) or [])
            if isinstance(block, dict)
        )
    )
    if recovery is not None and (outcome_unknown or provider_evidence):
        recovery.update(
            status="outcome_unknown" if outcome_unknown else "recovery_required",
            error=str(exc),
            updated_at=time.time(),
        )
        _atomic_write_json(task_dir / "_recovery.json", recovery)
        _set(
            task_id,
            blocks=recovery.get("blocks", []) or [],
            raw_urls=recovery.get("raw_urls", []) or [],
            cost_rmb=float(recovery.get("total_cost_rmb", 0.0) or 0.0),
            planned_count=int(recovery.get("planned_count", 0) or 0),
            success_count=int(recovery.get("success_count", 0) or 0),
            failed_count=int(recovery.get("failed_count", 0) or 0),
        )
    recoverable = bool(recovery and provider_evidence)
    if outcome_unknown:
        terminal_status = "outcome_unknown"
        progress_msg = f"结果不明，已停止自动重提: {exc}"
    elif recoverable:
        terminal_status = "recovery_required"
        progress_msg = f"付费结果已保存，禁止重新生图，等待恢复: {exc}"
    else:
        terminal_status = "failed"
        progress_msg = f"失败: {exc}"
    print(f"[{log_prefix}] task {task_id} {terminal_status}:\n{tb}")
    _set(
        task_id,
        status=terminal_status,
        error=str(exc),
        error_trace=tb,
        progress_msg=progress_msg,
    )


def _run_assembler(task_dir: Path, blocks: list[dict],
                   product_meta: dict) -> str:
    """渲染 assembled.html + 截图 assembled.png. 返回 assembled_url.

    Why 独立 Flask app: 后台线程拿不到主 app 的 context, 且模板里
    有 url_for/csrf_token 等 Flask global, Jinja2 裸跑会 NameError.
    做法与 scripts/assemble_smoke_v2.py 一致 — 起一个只做渲染的最小 app.
    """
    from flask import Flask, render_template

    hero_url = blocks[0]["image_url"]
    fixed_images = [b["image_url"] for b in blocks[1:]]

    data = {
        "product_type": "设备类",
        "block_a": {
            "brand_text": "",
            "model_name": product_meta.get("name", ""),
            "category_line": product_meta.get("name", ""),
            "main_title": "",
            "cover_image": hero_url,
            "show_hero_params": False,
            "params": [],
        },
        "block_b2": {}, "block_b3": {}, "block_f": {}, "block_e": {},
        "fixed_selling_images": fixed_images,
        "effect_image": "",
        "export_mode": True,
        "hero_block_template": "blocks/block_a_hero_robot_cover.html",
        "spec_block_template": "blocks/block_e_glass_dimension.html",
    }

    render_app = Flask(
        __name__,
        template_folder=str(_RESOURCE_ROOT / "templates"),
        static_folder=str(_DATA_ROOT / "static"),
    )
    render_app.config["SECRET_KEY"] = "refine-v2-pipeline-stub"
    render_app.jinja_env.globals.setdefault("csrf_token", lambda: "stub-csrf")

    with render_app.app_context(), render_app.test_request_context():
        html = render_template("设备类/assembled.html", **data)
    # /static/... → file:///.../static/... (供 Playwright 离线加载)
    base_url = str(_DATA_ROOT).replace("\\", "/")
    html = html.replace('src="/static/', f'src="file:///{base_url}/static/')
    html = html.replace("src='/static/", f"src='file:///{base_url}/static/")

    out_html = task_dir / "assembled.html"
    out_html.write_text(html, encoding="utf-8")

    # Playwright 截图
    out_png = task_dir / "assembled.png"
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = launch_chromium(pw, args=[
            "--allow-file-access-from-files",
        ])
        ctx = browser.new_context(
            viewport={"width": 750, "height": 900},
            device_scale_factor=2,
        )
        page = ctx.new_page()
        page.goto(out_html.as_uri(), wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path=str(out_png), full_page=True)
        browser.close()

    # E: 资产完整性 guard — 截出纯白 PNG 的兜底检测
    _validate_assembled_png(out_png)

    return f"/static/ai_refine_v2/{task_dir.name}/assembled.png"


# ─────────────────────────────────────────────────────────────
# v2 Assembler (PRD §阶段二·任务 2.2 stub, PRD §阶段三正式实现 PIL 拼接)
# ─────────────────────────────────────────────────────────────
def _run_assembler_v2(task_dir: Path, blocks: list[dict]) -> str:
    """v2 临时 assembler: PIL 纵向拼接成功的 N 张图为 1 张长 PNG.

    跟 v1 _run_assembler 的区别:
      - 不起 Flask app, 不渲染 Jinja 模板, 不调 Playwright 截图
      - 纯 PIL 操作, 几百毫秒级 (vs v1 60-90s 启动 Chromium)
    4 刀 E (_validate_assembled_png) 同样守门, 太小 PNG 会 raise.

    PRD §阶段三正式实现完整 PIL 拼接 (含 1536 宽度校准 / 间隙 / 元数据 / etc).
    """
    from PIL import Image

    images = []
    for b in blocks:
        if not b.get("success"):
            continue  # 跳过失败的 block, 不进拼接
        path = task_dir / b["file"]
        if path.is_file():
            images.append(Image.open(path))

    if not images:
        # 0 张能拼 → 直接 raise (反向 E 刀: 没图也算 fail)
        raise RuntimeError("v2 assembler: 无可用 block 图, 无法拼接")

    total_h = sum(im.height for im in images)
    max_w = max(im.width for im in images)

    canvas = Image.new("RGB", (max_w, total_h), (255, 255, 255))
    y = 0
    for im in images:
        canvas.paste(im, (0, y))
        y += im.height

    out_png = task_dir / "assembled.png"
    canvas.save(out_png, "PNG")

    # E 刀: 资产完整性 guard, < 100KB 视作纯白 PNG fail (跟 v1 共用阈值)
    _validate_assembled_png(out_png)

    return f"/static/ai_refine_v2/{task_dir.name}/assembled.png"


# ─────────────────────────────────────────────────────────────
# 后台线程 worker
# ─────────────────────────────────────────────────────────────
def _worker(task_id: str, product_text: str, product_image_url: str,
            product_title: str, deepseek_key: str, gpt_image_key: str,
            mode: str = "v1", product_category: str | None = None):
    """Dispatcher: 按 mode 分发到 _worker_v1 / _worker_v2.

    mode='v1' (默认, 兼容直调 _worker 的 4 个老单测): plan + generate + Jinja+Playwright
    mode='v2' (PRD §阶段二·任务 2.2): plan_v2 + generate_v2 + PIL stub assembler

    product_category: PR A (2026-05-07) 透传给 _worker_v2 用于 post-planning reorder.
                      v1 路径不需要 (老单测向后兼容).
    """
    if mode == "v2":
        _worker_v2(task_id, product_text, product_image_url,
                   product_title, deepseek_key, gpt_image_key,
                   product_category=product_category)
        return
    if mode != "v1":
        _set(task_id, status="failed",
             error=f"无效 mode={mode!r}, 必须 'v1' 或 'v2'")
        return
    _worker_v1(task_id, product_text, product_image_url,
               product_title, deepseek_key, gpt_image_key)


def _worker_v1(task_id: str, product_text: str, product_image_url: str,
               product_title: str, deepseek_key: str, gpt_image_key: str):
    """v1 路径 (一字不动的老逻辑, 60 单测保护)."""
    mode = _detect_mode(deepseek_key, gpt_image_key)
    _set(task_id, mode=mode, status="running_planner",
         progress_pct=5, progress_msg="准备输入...")

    task_dir = _OUTPUT_BASE / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ── Stage 1: Planner ──
        if deepseek_key:
            _set(task_id, progress_msg="DeepSeek 分析产品文案...", progress_pct=10)
            from ai_refine_v2 import refine_planner
            # plan() 签名不含 product_name_hint (它从 product_text 自己抽 name).
            # 若用户另外在表单填了"产品标题",按下面 _load_mock_planning 的同款模式
            # 后置覆盖 product_meta.name,让 UI 显示用户写的标题,不动 planner 内部逻辑.
            planning = refine_planner.plan(
                product_text=product_text,
                product_image_url=product_image_url,
                api_key=deepseek_key,
            )
            if product_title:
                planning.setdefault("product_meta", {})["name"] = product_title
        else:
            _set(task_id, progress_msg="[mock] 加载预置 planning", progress_pct=10)
            planning = _load_mock_planning(product_text, product_title)
            time.sleep(0.5)

        _set(task_id, planning=planning, progress_pct=20, progress_msg="planning 已生成")
        (task_dir / "_planning.json").write_text(
            json.dumps(planning, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── Stage 2: Generator ──
        _set(task_id, status="running_generator", progress_pct=25,
             progress_msg="开始生成 6 张 AI 精修图...")

        if gpt_image_key:
            def prog(pct, msg):
                _set(task_id, progress_pct=pct, progress_msg=msg)
            blocks, cost = _run_real_generator(
                planning, product_image_url, gpt_image_key, task_dir, prog
            )
        else:
            _set(task_id, progress_msg="[mock] 使用 4/23 demo 占位图", progress_pct=70)
            blocks = _copy_mock_images(task_dir)
            cost = 0.0
            time.sleep(1.0)

        planned_count = (
            len((planning.get("planning") or {}).get("block_order") or [])
            or len(blocks)
        )
        planned_count, success_count, failed_count = _result_counts(
            blocks, planned_count,
        )
        # D: 抽一份原始 APIMart URL 存到 TaskState — 代理炸了还能从这救图.
        raw_urls = [b.get("raw_url", "") for b in blocks]
        _set(task_id, blocks=blocks, cost_rmb=cost, raw_urls=raw_urls,
             planned_count=planned_count, success_count=success_count,
             failed_count=failed_count,
             progress_pct=80,
             progress_msg=f"已就绪 {success_count}/{planned_count} 张, 开始拼装长图...")

        # ── Stage 3: Assembler ──
        _set(task_id, status="running_assembler", progress_pct=85,
             progress_msg="Playwright 截图中...")
        assembled_url = _run_assembler(task_dir, blocks,
                                        planning.get("product_meta", {}))
        terminal_status, planned_count, success_count, failed_count = (
            _write_terminal_summary(
                task_id,
                task_dir,
                planning,
                mode,
                blocks,
                cost,
                planned_count,
                assembled_url,
                schema_mode="v1",
            )
        )

        _set(
            task_id,
            status=terminal_status,
            progress_pct=100,
            progress_msg=(
                "完成"
                if terminal_status == "success"
                else f"部分完成 {success_count}/{planned_count}"
            ),
            assembled_url=assembled_url,
            planned_count=planned_count,
            success_count=success_count,
            failed_count=failed_count,
        )

    except Exception as e:
        _record_worker_exception(
            task_id,
            task_dir,
            e,
            log_prefix="pipeline",
        )


def _worker_v2(task_id: str, product_text: str, product_image_url: str,
               product_title: str, deepseek_key: str, gpt_image_key: str,
               product_category: str | None = None):
    """v2 路径: plan_v2 + generate_v2 + PIL stub assembler.

    跟 _worker_v1 镜像结构, 调 v2 函数. 4 刀 guard 复用:
      A 绕代理 / B 失败 raise / D raw_url   → _run_real_generator_v2 内部
      E assembled.png 太小 raise            → _run_assembler_v2 内部

    Args:
        product_category: PR A (2026-05-07): 4 大品类之一 (设备类/耗材类/配件类/工具类),
                          用于 post-planning reorder (耗材/配件类 lifestyle_demo 提到 idx=2).
                          None=向后兼容老调用, 不重排.
    """
    actual_mode = _detect_mode(deepseek_key, gpt_image_key)
    _set(task_id, mode=actual_mode, status="running_planner",
         progress_pct=5, progress_msg="准备输入...")

    task_dir = _OUTPUT_BASE / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ── Stage 1: Planner (plan_v2) ──
        if deepseek_key:
            _set(task_id, progress_msg="DeepSeek (v2) 分析产品文案...", progress_pct=10)
            from ai_refine_v2 import refine_planner
            planning = refine_planner.plan_v2(
                product_text=product_text,
                product_image_url=product_image_url,
                product_title=product_title,
                api_key=deepseek_key,
            )
        else:
            _set(task_id, progress_msg="[v2 mock] 加载预置 planning_v2", progress_pct=10)
            planning = _load_mock_planning_v2(product_text, product_title)
            time.sleep(0.5)

        # PR A (2026-05-07): 耗材类/配件类 lifestyle_demo 强制提到 idx=2
        from ai_refine_v2 import refine_planner
        planning = refine_planner._reorder_lifestyle_to_second(planning, product_category)
        # PR B (2026-05-07): 耗材类/配件类 + DeepSeek 输出 materials 时注入 material_origin 屏
        planning = refine_planner._inject_material_origin(planning, product_category)

        _set(task_id, planning=planning, progress_pct=20,
             progress_msg="planning_v2 已生成")
        (task_dir / "_planning.json").write_text(
            json.dumps(planning, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── Stage 2: Generator (generate_v2) ──
        n_screens = len(planning.get("screens") or [])
        _set(task_id, status="running_generator", progress_pct=25,
             progress_msg=f"开始生成 {n_screens} 张 v2 AI 精修图...")

        if gpt_image_key:
            def prog(pct, msg):
                _set(task_id, progress_pct=pct, progress_msg=msg)
            blocks, cost = _run_real_generator_v2(
                planning, product_image_url, gpt_image_key, task_dir, prog,
            )
        else:
            _set(task_id, progress_msg="[v2 mock] 复用 4/23 demo 占位图", progress_pct=70)
            blocks = _copy_mock_images_v2(task_dir, n=n_screens or 6)
            cost = 0.0
            time.sleep(1.0)

        planned_count, success_count, failed_count = _result_counts(
            blocks, n_screens or len(blocks),
        )
        # D 刀: raw_url 存 TaskState (v1/v2 共用机制)
        raw_urls = [b.get("raw_url", "") for b in blocks]
        _set(task_id, blocks=blocks, cost_rmb=cost, raw_urls=raw_urls,
             planned_count=planned_count, success_count=success_count,
             failed_count=failed_count,
             progress_pct=80,
             progress_msg=f"已就绪 {success_count}/{planned_count} 张, 开始 PIL 拼接...")

        # ── Stage 3: Assembler (PIL stub, PRD §阶段三正式) ──
        _set(task_id, status="running_assembler", progress_pct=85,
             progress_msg="PIL 拼接长图中...")
        assembled_url = _run_assembler_v2(task_dir, blocks)
        terminal_status, planned_count, success_count, failed_count = (
            _write_terminal_summary(
                task_id,
                task_dir,
                planning,
                actual_mode,
                blocks,
                cost,
                planned_count,
                assembled_url,
                schema_mode="v2",
            )
        )

        _set(
            task_id,
            status=terminal_status,
            progress_pct=100,
            progress_msg=(
                "完成"
                if terminal_status == "success"
                else f"部分完成 {success_count}/{planned_count}"
            ),
            assembled_url=assembled_url,
            planned_count=planned_count,
            success_count=success_count,
            failed_count=failed_count,
        )

    except Exception as e:
        _record_worker_exception(
            task_id,
            task_dir,
            e,
            log_prefix="pipeline_v2",
        )


def _valid_local_image(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 1024:
        return False
    try:
        from PIL import Image

        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
        return True
    except Exception:
        return False


def _recover_task(task_id: str, gpt_image_key: str) -> dict:
    """Resume only known provider tasks/URLs; never submit or generate again."""
    import ai_image_apimart

    current = get_task_status(task_id)
    current_status = str((current or {}).get("status") or "")
    if current_status not in {
        "outcome_unknown", "recovery_required", "running_recovery",
    }:
        raise ValueError(f"任务 {task_id} 当前状态不可恢复: {current_status or 'missing'}")
    task_dir = _OUTPUT_BASE / task_id
    record = _read_json(task_dir / "_recovery.json")
    if record is None:
        state = get_task_status(task_id)
        if state and state.get("status") in {"success", "partial_success"}:
            return state
        raise ValueError(f"任务 {task_id} 没有可恢复断点")
    blocks = record.get("blocks", []) or []
    if not isinstance(blocks, list) or not blocks:
        raise ValueError(f"任务 {task_id} 的恢复断点无效")
    planning = _read_json(task_dir / "_planning.json") or {}
    planned_count = int(record.get("planned_count", 0) or len(blocks))
    schema_mode = str(record.get("schema_mode") or "v2")

    with _TASKS_LOCK:
        state = _TASKS.get(task_id)
        if state is None:
            state = TaskState(
                task_id=task_id,
                user_id=record.get("user_id"),
                mode=str(record.get("mode") or "real"),
            )
            _TASKS[task_id] = state
        state.status = "running_recovery"
        state.progress_pct = 90
        state.progress_msg = "正在继续检查原付费任务..."
        state.planning = planning

    def persist(status: str, error: str = "") -> dict:
        snapshot = _persist_recovery(
            task_dir,
            blocks,
            float(record.get("total_cost_rmb", 0.0) or 0.0),
            planned_count,
            status=status,
            error=error,
            schema_mode=schema_mode,
        )
        planned, success, failed = _result_counts(blocks, planned_count)
        _set(
            task_id,
            status=status,
            progress_pct=100 if status == "failed" else 90,
            progress_msg=(
                "原任务仍无法确认，未自动重提"
                if status == "outcome_unknown"
                else (
                    "原任务已明确失败，未自动重提"
                    if status == "failed"
                    else "已保留原任务结果，等待继续恢复"
                )
            ),
            blocks=blocks,
            raw_urls=snapshot["raw_urls"],
            cost_rmb=float(snapshot["total_cost_rmb"]),
            planned_count=planned,
            success_count=success,
            failed_count=failed,
            error=error,
        )
        return get_task_status(task_id) or {}

    persist("running_recovery")
    unknown_errors: list[str] = []
    poll_candidates: list[dict] = []
    for block in blocks:
        if str(block.get("raw_url") or "").strip():
            continue
        provider_task_id = str(block.get("provider_task_id") or "").strip()
        provider_status = str(block.get("provider_status") or "").strip()
        if provider_status == "cancelled":
            block["placeholder"] = True
            block["error"] = "结果不明后已在提交前取消，未创建该屏任务"
            persist("running_recovery")
            continue
        if not provider_task_id:
            if provider_status == "outcome_unknown":
                unknown_errors.append(
                    f"{block.get('block_id')}: 提交响应不明且没有 provider_task_id"
                )
            else:
                block["placeholder"] = True
                block["error"] = "该屏没有 provider 任务断点，按未提交处理"
            persist("running_recovery")
            continue
        poll_candidates.append(block)

    def poll(block: dict):
        provider_task_id = str(block.get("provider_task_id") or "")
        try:
            raw_url = ai_image_apimart.poll_image_task(
                provider_task_id,
                gpt_image_key,
                direct=str(block.get("download_route") or "") == "direct",
            )
            return block, raw_url, None
        except Exception as exc:
            return block, "", exc

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(poll, block) for block in poll_candidates]
        for future in concurrent.futures.as_completed(futures):
            block, raw_url, error = future.result()
            if error is None:
                block["raw_url"] = raw_url
                block["provider_status"] = "completed"
                block["error"] = ""
            else:
                block["error"] = str(error)
                if getattr(error, "outcome_unknown", False):
                    block["provider_status"] = "outcome_unknown"
                    unknown_errors.append(f"{block.get('block_id')}: {error}")
                else:
                    block["provider_status"] = "failed"
                    block["placeholder"] = True
            persist("running_recovery")

    def download(block: dict):
        destination = task_dir / str(block.get("file") or "")
        if _valid_local_image(destination):
            return block, str(block.get("download_route") or "unknown"), None
        try:
            route = _download_image(
                str(block.get("raw_url") or ""),
                destination,
                preferred_route=str(block.get("download_route") or "unknown"),
            )
            if not _valid_local_image(destination):
                raise PaidResultRecoveryRequired(
                    f"恢复下载后的图片无法解码: {block.get('block_id')}"
                )
            return block, route, None
        except Exception as exc:
            return block, "", exc

    candidates = [block for block in blocks if str(block.get("raw_url") or "").strip()]
    download_errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(download, block) for block in candidates]
        for future in concurrent.futures.as_completed(futures):
            block, route, error = future.result()
            if error is None:
                block["download_route"] = route or block.get("download_route") or "unknown"
                block["success"] = True
                block["placeholder"] = False
                block["error"] = ""
            else:
                block["success"] = False
                block["error"] = str(error)
                download_errors.append(f"{block.get('block_id')}: {error}")
            persist("running_recovery")

    if unknown_errors:
        return persist("outcome_unknown", "; ".join(unknown_errors))
    if download_errors:
        return persist("recovery_required", "; ".join(download_errors))

    successful = [block for block in blocks if block.get("success")]
    if not successful or not blocks[0].get("success"):
        return persist("failed", "原任务没有可拼装的 Hero 结果")
    try:
        if schema_mode == "v2":
            assembled_url = _run_assembler_v2(task_dir, blocks)
        else:
            assembled_url = _run_assembler(
                task_dir, successful, planning.get("product_meta", {}),
            )
        terminal_status, planned, success, failed = _write_terminal_summary(
            task_id,
            task_dir,
            planning,
            str(record.get("mode") or "real"),
            blocks,
            float(record.get("total_cost_rmb", 0.0) or 0.0),
            planned_count,
            assembled_url,
            schema_mode=schema_mode,
        )
    except Exception as exc:
        return persist("recovery_required", f"恢复拼装失败: {exc}")

    _set(
        task_id,
        status=terminal_status,
        progress_pct=100,
        progress_msg=(
            "完成" if terminal_status == "success" else f"部分完成 {success}/{planned}"
        ),
        assembled_url=assembled_url,
        blocks=blocks,
        raw_urls=[str(block.get("raw_url") or "") for block in blocks],
        planned_count=planned,
        success_count=success,
        failed_count=failed,
        error="",
    )
    return get_task_status(task_id) or {}


def _recovery_worker(task_id: str, gpt_image_key: str) -> None:
    try:
        _recover_task(task_id, gpt_image_key)
    except Exception as exc:
        _record_worker_exception(
            task_id,
            _OUTPUT_BASE / task_id,
            exc,
            log_prefix="pipeline_recovery",
        )
    finally:
        with _TASKS_LOCK:
            _RECOVERY_TASK_IDS.discard(task_id)


def start_task_recovery(task_id: str, gpt_image_key: str) -> dict:
    """Start one idempotent non-billable recovery worker for a blocked task."""
    state = get_task_status(task_id)
    if state is None:
        raise ValueError(f"任务不存在或已过期: {task_id}")
    status = str(state.get("status") or "")
    if status not in {"outcome_unknown", "recovery_required", "running_recovery"}:
        raise ValueError(f"任务 {task_id} 当前状态不可恢复: {status}")
    with _TASKS_LOCK:
        if task_id in _RECOVERY_TASK_IDS:
            return _TASKS[task_id].to_dict()
        current = _TASKS.get(task_id)
        if current is not None and current.status.startswith("running_") \
                and current.status != "running_recovery":
            raise ValueError("原任务仍在运行，不能并行启动恢复")
        if current is None:
            current = TaskState(
                task_id=task_id,
                user_id=state.get("user_id"),
                mode=str(state.get("mode") or "real"),
            )
            _TASKS[task_id] = current
        current.status = "running_recovery"
        current.progress_pct = 90
        current.progress_msg = "正在继续检查原付费任务..."
        _RECOVERY_TASK_IDS.add(task_id)
        response = current.to_dict()
    threading.Thread(
        target=_recovery_worker,
        args=(task_id, gpt_image_key),
        daemon=True,
    ).start()
    return response


# ─────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────
def start_task(product_text: str, product_image_url: str,
               product_title: str, deepseek_key: str,
               gpt_image_key: str, mode: str = "v1",
               user_id: int | None = None,
               product_category: str | None = None) -> str:
    """启动后台管线任务, 立即返回 task_id.

    mode='v1' (默认, 向后兼容): plan + generate + Jinja+Playwright
    mode='v2' (PRD §阶段二·任务 2.2 起): plan_v2 + generate_v2 + PIL stub assembler

    user_id: 任务发起人 ID (P4 §A.6 owner 标记). 路由轮询时校验 task_id ownership.
             None = 后台脚本 / 测试 (允许 admin 读, 普通用户 403).

    product_category: PR A (2026-05-07) 4 大品类之一 (设备类/耗材类/配件类/工具类),
                      v2 路径下用于 post-planning reorder (耗材/配件 lifestyle_demo→idx=2).
                      None=向后兼容老调用 / v1 路径忽略此参数.

    安全阀: 仅 development 且 V2_ALLOW_REAL_API!=true 时强制清空 keys, _worker 自动走 mock 路径.
    生产唯一入口经过这里, 所以任何 UI 误点都被截断在烧 API 前.
    """
    if mode not in ("v1", "v2"):
        raise ValueError(f"mode 必须 'v1' 或 'v2', 实际 {mode!r}")
    deepseek_key, gpt_image_key = _apply_safety_valve(deepseek_key, gpt_image_key)
    task_id = f"v2_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"
    with _TASKS_LOCK:
        _TASKS[task_id] = TaskState(task_id=task_id, user_id=user_id)
    t = threading.Thread(
        target=_worker, daemon=True,
        kwargs=dict(
            task_id=task_id, product_text=product_text,
            product_image_url=product_image_url, product_title=product_title,
            deepseek_key=deepseek_key, gpt_image_key=gpt_image_key,
            mode=mode, product_category=product_category,
        ),
    )
    t.start()
    return task_id
