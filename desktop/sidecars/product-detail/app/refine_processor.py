"""任务11 单产品 AI 精修处理器 (v3.2 大疆风高级灰路线 — 2026-04-29 切换).

历史:
  v1 (PRD F6 初版): 调豆包 Seedream 生成 6 屏 AI 背景 → HTML/CSS 合成
                    → Playwright 截图 → 落 ai_refined.jpg
  v3.2 (本版): 切换到 ai_refine_v2 pipeline (DeepSeek plan_v2 + APIMart
              gpt-image-2 + PIL 拼接), 12 屏大疆风高级灰 + lifestyle_demo
              + 商业承诺合规. ARK_API_KEY 不再使用 (保留 ark_api_key 参数
              兼容 batch_queue 调用约定但内部忽略).

切换原因:
  - 用户要求"批量生成的 AI 精修接通 v3.2"
  - v1 ARK 路径生成的 6 屏背景跟 v3.2 12 屏方案不同代差太大
  - 让批量入口也享受 v3.2 路线 (色保真 / 屏型唯一 / 法律合规)

成本/时延对比:
  v1 ARK 路径: ~30s/产品 + ~¥1-2/产品 (主要烧豆包 + Playwright)
  v3.2 v2 路径: ~4-5min/产品 + ~¥8.4/产品 (主要烧 APIMart gpt-image-2 12 屏)
  → 批量请求务必谨慎, 10 产品 = ¥84 + 50min

与任务4 `batch_processor.process_one_product` 的关系:
  - 任务4 仍出 preview.png (HTML 版底图, 纯 CSS, 不变)
  - 任务11 v3.2 出 ai_refined.jpg (12 屏 v3.2 v2 长图)
  - 复用任务4 已落盘的 parsed.json / product_cut.png

覆盖语义:
  - 文件 product_dir/ai_refined.jpg — 自动覆盖 (兼容旧版语义)
"""
from __future__ import annotations

import json
import os
import shutil
import time
import traceback
from pathlib import Path


def _reconstruct_product_text(parsed: dict, name: str) -> str:
    """从 parsed.json 重建 plan_v2 喂的原始文案.

    parsed.json 是任务4 已 DeepSeek 解析过的结构化数据 (brand/main_title/
    selling_points/specs/...). v2 plan_v2 要的是非结构化原文, 我们把结构
    化字段重新拼成段落让 DeepSeek 第 2 阶段重新规划成 v2 schema.
    """
    parts: list[str] = []
    title = (parsed.get("main_title") or parsed.get("product_name")
             or parsed.get("model") or name).strip()
    if title:
        parts.append(f"产品名称：{title}")
    sub = (parsed.get("subtitle") or parsed.get("sub_title") or "").strip()
    if sub:
        parts.append(sub)
    sps = parsed.get("selling_points") or []
    if isinstance(sps, list) and sps:
        sp_lines = []
        for sp in sps:
            if isinstance(sp, dict):
                t = (sp.get("text") or sp.get("title") or "").strip()
                if t:
                    sp_lines.append(t)
            elif isinstance(sp, str):
                sp_lines.append(sp.strip())
        if sp_lines:
            parts.append("核心卖点：")
            parts.extend(f"- {x}" for x in sp_lines if x)
    specs = parsed.get("specs") or parsed.get("spec_table") or []
    if isinstance(specs, list) and specs:
        spec_lines = []
        for s in specs:
            if isinstance(s, dict):
                k = (s.get("key") or s.get("name") or "").strip()
                v = (s.get("value") or "").strip()
                if k and v:
                    spec_lines.append(f"{k}: {v}")
        if spec_lines:
            parts.append("技术参数：")
            parts.extend(spec_lines)
    return "\n".join(parts).strip() or title or name


def refine_one_product(scope_id: str, payload: dict, *, ark_api_key: str) -> dict:
    """对单个 BatchItem 执行 AI 精修, 产出 ai_refined.jpg (v3.2 v2 path).

    scope_id: batch_id (日志前缀)
    payload: 同 v1 兼容字段 (name / main_image_path / cutout_path /
             parsed_json_path / resolved_theme_id / product_category)
    ark_api_key: v3.2 已不使用, 保留参数兼容 batch_queue 调用约定. v3.2 用
                 服务端 env DEEPSEEK_API_KEY + REFINE_API_KEY (兼容 GPT_IMAGE_API_KEY fallback).

    raises: 任何异常上抛 (batch_queue._submit_one 兜成 status=failed)

    returns:
        {
            "ai_refined_path": "/uploads/.../产品A/ai_refined.jpg",  # URL
            "ai_refined_at":   1712345678,
            "segments_count":  12,                                    # v3.2 默认 12 屏
            "total_elapsed":   265.3,
            "task_id":         "v2_..._abc123",                       # v3.2 新增
            "mode":            "real",                                # v3.2 新增
        }
    """
    from app import app, BASE_DIR
    from ai_refine_v2 import pipeline_runner

    name = payload.get("name") or "unknown"
    main_url = (payload.get("main_image_path") or "").strip()
    cutout_url = (payload.get("cutout_path") or "").strip()
    parsed_url = (payload.get("parsed_json_path") or "").strip()
    # PR A (2026-05-07): batch 产品的品类透传给 v2 worker, 用于 post-planning
    # reorder (耗材/配件 lifestyle_demo → idx=2). 缺则 None=不重排.
    product_category = (payload.get("product_category") or "").strip() or None
    if not main_url:
        raise ValueError(f"产品 {name} 缺 main_image_path")
    if not parsed_url:
        raise ValueError(f"产品 {name} 缺 parsed_json_path")

    # URL /uploads/... → 磁盘 static/uploads/... (容器持久化铁律, 见 2026-04-22)
    def _url_to_fs(u: str) -> Path:
        rel = u.lstrip("/")
        if rel.startswith("uploads/"):
            rel = "static/" + rel
        elif rel.startswith("static/"):
            pass
        return BASE_DIR / rel

    parsed_path = _url_to_fs(parsed_url)
    if not parsed_path.is_file():
        raise FileNotFoundError(f"parsed.json 不在: {parsed_path}")
    parsed = json.loads(parsed_path.read_text(encoding="utf-8"))
    product_dir = parsed_path.parent

    # 喂给 v2: 优先用抠图 (cutout_path), 没有就原图 (main_image_path)
    image_fs_path = _url_to_fs(cutout_url) if cutout_url else _url_to_fs(main_url)
    if not image_fs_path.is_file():
        raise FileNotFoundError(f"产品图不存在: {image_fs_path}")

    product_text = _reconstruct_product_text(parsed, name)
    product_title = (parsed.get("main_title") or parsed.get("product_name")
                     or parsed.get("model") or name).strip()

    # v3.2 双 key 从 env 读 (生产 .env 已注入, 见 2026-04-29 部署日志)
    import os as _os
    deepseek_key = _os.environ.get("DEEPSEEK_API_KEY", "").strip()
    gpt_image_key = (
        _os.environ.get("REFINE_API_KEY", "").strip()
        or _os.environ.get("GPT_IMAGE_API_KEY", "").strip()
    )
    if not deepseek_key or not gpt_image_key:
        raise RuntimeError(
            "v3.2 v2 path 需要 DEEPSEEK_API_KEY + REFINE_API_KEY 都配上 "
            f"(deepseek={bool(deepseek_key)}, gpt={bool(gpt_image_key)}). "
            "在生产 .env 加这两个 key 后 docker compose up -d --force-recreate web."
        )

    print(f"[refine-v3.2] {scope_id}/{name} → 启动 v2 pipeline (12 屏大疆风, ~4-5min, ~¥8.4)",
          flush=True)
    t0 = time.time()
    task_id = pipeline_runner.start_task(
        product_text=product_text,
        product_image_url=str(image_fs_path),  # fs path, 让 _to_data_url 直接读
        product_title=product_title,
        deepseek_key=deepseek_key,
        gpt_image_key=gpt_image_key,
        mode="v2",
        product_category=product_category,  # PR A reorder gating
    )

    # 同步等待 v2 task 完成 (轮询 _TASKS).
    # 2026-05-08: 360s → 900s (6 → 15 min). 真实事故同日 batch_20260508_001_e63a/
    # 龙克洗地机吸水电机三层风叶, 设备类 8 屏 + APIMart 偶发 503/timeout 重试,
    # 实际 360s 时只跑到 5/8 屏, 直接 raise TimeoutError, v2 task 后台死透
    # 磁盘 0 产物, 用户 ¥5 烧无回报. 是 PR #25 polling timeout (前端 6→10min)
    # 的后端镜像 — 同根因, 两条独立代码路径, 之前只修了前端.
    # 上限 900s (15 min): 设备类 8 屏 + 重试 buffer + 50% 余量, 12 屏耗材类
    # 也能跑通. 走 env var 让运维不重 build 也能临时调.
    timeout_s = int(os.environ.get("BATCH_REFINE_TIMEOUT_S", "900"))
    poll_interval = 3.0
    elapsed = 0.0
    last_msg = ""
    while elapsed < timeout_s:
        time.sleep(poll_interval)
        elapsed = time.time() - t0
        state = pipeline_runner.get_task_status(task_id)
        if state is None:
            raise RuntimeError(f"task_id {task_id} 在 _TASKS 里消失")
        msg = f"{state.get('status')} · {state.get('progress_pct',0)}% · {state.get('progress_msg','')}"
        if msg != last_msg:
            print(f"[refine-v3.2] {scope_id}/{name} ← {msg}", flush=True)
            last_msg = msg
        if state.get("status") == "success":
            break
        if state.get("status") == "failed":
            raise RuntimeError(
                f"v2 task 失败: {state.get('error','')} | trace: {state.get('error_trace','')[:500]}"
            )
    else:
        raise TimeoutError(
            f"v2 task {task_id} 超过 {timeout_s}s ({timeout_s // 60} min) 仍未完成"
        )

    # 拷贝 v2 产物 assembled.{png,jpg} → product_dir/ai_refined.jpg
    v2_task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
    src_candidates = [
        v2_task_dir / "assembled.jpg",
        v2_task_dir / "assembled.png",
    ]
    src = next((p for p in src_candidates if p.is_file()), None)
    if src is None:
        raise FileNotFoundError(
            f"v2 task {task_id} 完成但 assembled.{{jpg,png}} 不存在 "
            f"(in {v2_task_dir})"
        )
    dst = product_dir / "ai_refined.jpg"
    if src.suffix.lower() == ".png":
        # PNG → JPG: 用 Pillow 转 (v2 默认输出 PNG, batch 历史 API 期望 JPG)
        from PIL import Image
        img = Image.open(src).convert("RGB")
        img.save(dst, format="JPEG", quality=90, optimize=True)
    else:
        shutil.copy2(src, dst)

    # 磁盘 static/uploads/ → URL /uploads/ (跟 v1 同款映射)
    rel = dst.resolve().relative_to(BASE_DIR.resolve()).as_posix()
    if rel.startswith("static/uploads/"):
        rel = rel[len("static/"):]
    ai_refined_url = "/" + rel

    final_state = pipeline_runner.get_task_status(task_id) or {}
    out = {
        "ai_refined_path": ai_refined_url,
        "ai_refined_at":   int(time.time()),
        "segments_count":  len(final_state.get("blocks") or []),
        "total_elapsed":   round(time.time() - t0, 2),
        "task_id":         task_id,
        "mode":            final_state.get("mode", "real"),
        "cost_rmb":        final_state.get("cost_rmb", 0.0),
    }
    print(f"[refine-v3.2] {scope_id}/{name} → 完成 {ai_refined_url} "
          f"({out['total_elapsed']}s, {out['segments_count']} 屏, ¥{out['cost_rmb']:.2f})",
          flush=True)
    return out
