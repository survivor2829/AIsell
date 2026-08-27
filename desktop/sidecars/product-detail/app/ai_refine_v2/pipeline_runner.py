"""AI 精修 v2 · 端到端管线 runner · 供 /api/ai-refine-v2/execute 调用.

职责:
  Planner (DeepSeek)  →  6 个 block 的 planning
  Generator (APIMart) →  6 张 AI 精修图
  Assembler (Jinja + Playwright) → assembled.png

特性:
  - 后台线程执行 (3-5 分钟), POST /execute 立即返回 task_id
  - 任务状态/进度/结果存在模块级 dict
  - GET /status/<task_id> 轮询进度
  - **Key 缺失自动降级 mock**: 返回 4/23 那批现成的 6 张占位图,让 UI 能走通
    - DEEPSEEK_API_KEY 缺 → 用 smoke_output_v2/_planning.json (预置)
    - REFINE_API_KEY 缺 → 跳过真 API 调用, 复用 static/smoke_output_v2/block_*.jpg

任务状态机:
  pending → running_planner → running_generator → running_assembler → success
                                                                   ↘ failed

Why not Celery/RQ:
  单机 Flask 项目, 无需消息队列. 内存 dict 够用, 重启全清.
"""
from __future__ import annotations

import json
import os
import shutil
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
    status: str = "pending"  # pending | running_planner | running_generator | running_assembler | success | failed
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
    # 错误
    error: str = ""
    error_trace: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


_TASKS: dict[str, TaskState] = {}
_TASKS_LOCK = threading.Lock()


def _set(task_id: str, **fields):
    with _TASKS_LOCK:
        st = _TASKS.get(task_id)
        if st is None:
            return
        for k, v in fields.items():
            setattr(st, k, v)
        st.elapsed_s = round(time.time() - st.started_at, 1)


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

    # Fallback: 内存丢失但磁盘有任务产物
    summary_file = _OUTPUT_BASE / task_id / "_summary.json"
    if not summary_file.is_file():
        return None
    try:
        data = json.loads(summary_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    assembled_file = _OUTPUT_BASE / task_id / "assembled.png"
    assembled_url = (
        f"/static/ai_refine_v2/{task_id}/assembled.png"
        if assembled_file.is_file() else ""
    )
    return {
        "task_id": task_id,
        "user_id": data.get("user_id"),  # 旧 summary 无 owner 时仍为 None
        "status": "success",  # _summary.json 落盘等于任务已完成
        "mode": data.get("mode", "unknown"),
        "progress_pct": 100,
        "progress_msg": "已完成 (从磁盘恢复)",
        "started_at": 0.0,
        "elapsed_s": 0.0,
        "cost_rmb": float(data.get("total_cost_rmb", 0.0) or 0.0),
        "planning": None,
        "blocks": data.get("blocks", []) or [],
        "raw_urls": data.get("raw_urls", []) or [],
        "assembled_url": assembled_url,
        "error": "",
        "error_trace": "",
    }


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
    for i, role in enumerate(roles, start=1):
        screen = {
            "idx": i,
            "role": role,
            "title": f"屏 {i} · {role}",
            "prompt": f"Screen {i} ({role}): {base_prompt}",
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
def _build_noproxy_opener():
    """独立 opener: 绕代理 (ProxyHandler({})) + 设浏览器 UA (防 CDN 403).

    [绕代理 — 4 刀 A 原由] APIMart 的图 URL 在国外 CDN, Flask 进程可能继承
    shell 里的 Clash 代理 (127.0.0.1:7890); urllib 默认会读 env, 走代理后挂/
    超时 (见 2026-04-24 那次 ¥3.50 白烧). ProxyHandler({}) 显式空掉
    HTTP(S)_PROXY env, 直走外网.

    [浏览器 UA — 2026-04-27 阶段五第 1 关验证补加] APIMart upload.apimart.ai
    CDN 拒绝 urllib 默认 UA 'Python-urllib/3.x', 直接 HTTP 403 Forbidden
    (见 stage5 step1 真测: ¥0.70 出图成功但下载挂; curl -A Mozilla 试下来
    200 OK 验证根因). 用 Chrome desktop UA 模拟浏览器请求, 通过 CDN 反爬虫.
    """
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    opener.addheaders = [
        ("User-Agent",
         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
         "AppleWebKit/537.36 (KHTML, like Gecko) "
         "Chrome/120.0.0.0 Safari/537.36"),
    ]
    return opener


def _download_image(url: str, dst: Path, retries: int = 2,
                    timeout: int = 30, opener=None) -> None:
    """下载一张图到 dst, 绕代理, 失败重试 retries 次. 总失败则 raise RuntimeError.

    不吞异常 — 调用方收到后应该让整单 pipeline fail, 不要走 placeholder 静默路径
    (不然 user 看到假成功 + 白 PNG + 仍被扣钱).
    """
    op = opener or _build_noproxy_opener()
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            with op.open(url, timeout=timeout) as r:
                dst.write_bytes(r.read())
            if dst.stat().st_size < 1024:
                raise RuntimeError(
                    f"下载内容 < 1KB ({dst.stat().st_size} 字节), 视作失败"
                )
            return
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(1)
    raise RuntimeError(f"下载失败 (重试 {retries} 次): {last_err}")


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

    completed = {"count": 0}

    def wrapped_api_call(prompt, image_data_url, api_key, thinking, size):
        url = refine_generator._default_api_call(
            prompt, image_data_url, api_key, thinking=thinking, size=size
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
    )

    # result.blocks: list[BlockResult]. block_id 是 "hero"/"selling_point_N"/...
    # 字符串, 不能 :02d. 用位置序号给文件编号, 再带 block_id 做后缀便于识别.
    opener = _build_noproxy_opener()
    blocks: list[dict] = []
    dl_errors: list[str] = []
    for idx, br in enumerate(result.blocks):
        safe_bid = str(br.block_id).replace("/", "_").replace("\\", "_")
        fn = f"block_{idx+1:02d}_{safe_bid}.jpg"
        dst = task_dir / fn
        raw_url = br.image_url or ""

        download_ok = False
        if raw_url and not br.placeholder:
            try:
                _download_image(raw_url, dst, retries=2, opener=opener)
                download_ok = True
            except Exception as e:
                dl_errors.append(f"{br.block_id}: {e}")
                print(f"[pipeline] 下载 block_{br.block_id} 失败: {e}")

        blocks.append({
            "block_id": br.block_id,
            "visual_type": br.visual_type,
            "is_hero": (br.block_id == "hero"),
            "file": fn,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{fn}",
            # D: 原始 APIMart CDN URL, 用于故障救图 (代理好了可手动绕过重下)
            "raw_url": raw_url,
            "success": download_ok,
            "placeholder": (not download_ok),
        })

    # B: 任何下载失败都抛出, 让 pipeline 走 failed. 假成功 > 真失败.
    if dl_errors:
        raise RuntimeError(
            f"下载 {len(dl_errors)}/{len(blocks)} 张图失败 (绕代理后仍挂): "
            f"{dl_errors}. 原始 APIMart URL 已存 raw_url 字段供救图."
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

    completed = {"count": 0}

    def wrapped_api_call(prompt, image_data_url, api_key, thinking, size):
        url = refine_generator._default_api_call(
            prompt, image_data_url, api_key, thinking=thinking, size=size,
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
    )

    # A 刀: 下载绕代理, 复用 v1 的 opener 实现
    opener = _build_noproxy_opener()
    blocks: list[dict] = []
    dl_errors: list[str] = []
    for idx, br in enumerate(result.blocks):
        # block_id 已是 "screen_NN_role" (generate_v2 给的), 文件系统安全
        safe_bid = str(br.block_id).replace("/", "_").replace("\\", "_")
        fn = f"block_{idx + 1:02d}_{safe_bid}.jpg"
        dst = task_dir / fn
        raw_url = br.image_url or ""

        download_ok = False
        if raw_url and not br.placeholder:
            try:
                # B 刀: _download_image 失败重试耗尽会 raise (不静默)
                _download_image(raw_url, dst, retries=2, opener=opener)
                download_ok = True
            except Exception as e:
                dl_errors.append(f"{br.block_id}: {e}")
                print(f"[pipeline_v2] 下载 block_{br.block_id} 失败: {e}")

        blocks.append({
            "block_id": br.block_id,
            "visual_type": br.visual_type,
            "is_hero": (idx == 0),  # v2 第 1 屏 (idx 0) 严格视为 hero
            "file": fn,
            "image_url": f"/static/ai_refine_v2/{task_dir.name}/{fn}",
            # D 刀: 原始 APIMart CDN URL 持久化 (代理炸了可手动救图)
            "raw_url": raw_url,
            "success": download_ok,
            "placeholder": (not download_ok),
        })

    # B 刀: 任何下载失败汇总抛 RuntimeError, 让 _worker_v2 走 failed 分支
    if dl_errors:
        raise RuntimeError(
            f"v2 下载 {len(dl_errors)}/{len(blocks)} 张图失败 (绕代理后仍挂): "
            f"{dl_errors}. 原始 APIMart URL 已存 raw_url 字段供救图."
        )

    return blocks, result.total_cost_rmb


# ─────────────────────────────────────────────────────────────
# Assembler (Jinja + Playwright 截图)
# ─────────────────────────────────────────────────────────────
def _validate_assembled_png(path: Path, min_bytes: int = 100_000) -> None:
    """检查 assembled.png 体积合理. < min_bytes 视作源图缺失导致的纯白 PNG, raise.

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

        # D: 抽一份原始 APIMart URL 存到 TaskState — 代理炸了还能从这救图.
        raw_urls = [b.get("raw_url", "") for b in blocks]
        _set(task_id, blocks=blocks, cost_rmb=cost, raw_urls=raw_urls,
             progress_pct=80,
             progress_msg="6 张图就绪, 开始拼装长图...")

        # Summary (含 raw_urls, 便于离线救图脚本使用 _summary.json)
        summary = {
            "user_id": (get_task_status(task_id) or {}).get("user_id"),
            "product": planning.get("product_meta", {}).get("name", ""),
            "mode": mode,
            "total_cost_rmb": cost,
            "raw_urls": raw_urls,
            "blocks": blocks,
        }
        (task_dir / "_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── Stage 3: Assembler ──
        _set(task_id, status="running_assembler", progress_pct=85,
             progress_msg="Playwright 截图中...")
        assembled_url = _run_assembler(task_dir, blocks,
                                        planning.get("product_meta", {}))

        _set(task_id, status="success", progress_pct=100,
             progress_msg="完成", assembled_url=assembled_url)

    except Exception as e:
        tb = traceback.format_exc()
        outcome_unknown = bool(getattr(e, "outcome_unknown", False))
        terminal_status = "outcome_unknown" if outcome_unknown else "failed"
        print(f"[pipeline] task {task_id} {terminal_status}:\n{tb}")
        _set(task_id, status=terminal_status, error=str(e), error_trace=tb,
             progress_msg=(f"结果不明，已停止自动重提: {e}"
                           if outcome_unknown else f"失败: {e}"))


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

        # D 刀: raw_url 存 TaskState (v1/v2 共用机制)
        raw_urls = [b.get("raw_url", "") for b in blocks]
        _set(task_id, blocks=blocks, cost_rmb=cost, raw_urls=raw_urls,
             progress_pct=80,
             progress_msg=f"{len(blocks)} 张图就绪, 开始 PIL 拼接...")

        summary = {
            "user_id": (get_task_status(task_id) or {}).get("user_id"),
            "product": planning.get("product_meta", {}).get("name", ""),
            "mode": actual_mode,
            "schema_mode": "v2",
            "total_cost_rmb": cost,
            "raw_urls": raw_urls,
            "blocks": blocks,
        }
        (task_dir / "_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

        # ── Stage 3: Assembler (PIL stub, PRD §阶段三正式) ──
        _set(task_id, status="running_assembler", progress_pct=85,
             progress_msg="PIL 拼接长图中...")
        assembled_url = _run_assembler_v2(task_dir, blocks)

        _set(task_id, status="success", progress_pct=100,
             progress_msg="完成", assembled_url=assembled_url)

    except Exception as e:
        tb = traceback.format_exc()
        outcome_unknown = bool(getattr(e, "outcome_unknown", False))
        terminal_status = "outcome_unknown" if outcome_unknown else "failed"
        print(f"[pipeline_v2] task {task_id} {terminal_status}:\n{tb}")
        _set(task_id, status=terminal_status, error=str(e), error_trace=tb,
             progress_msg=(f"结果不明，已停止自动重提: {e}"
                           if outcome_unknown else f"失败: {e}"))


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
