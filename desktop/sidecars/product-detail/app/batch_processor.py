"""单产品真实处理器：DeepSeek 解析 + rembg 抠图 + Playwright 渲染长图。

PRD: PRD_批量生成.md F4 / F7 / F8（任务4a 主干 + 4b 渲染）

输入 payload（来自 batch_upload.scan_batch 的 ok 产品）:
    {
        "name": "产品A",
        "main_image_path": "/uploads/batches/.../产品A/product.jpg",  # URL 形式
        "detail_image_paths": [...],
        "desc_text": "...",        # 完整文案
        ...
    }

输出（写到 BatchItem.result）:
    {
        "parsed_path":   "/uploads/batches/.../产品A/parsed.json",
        "parsed_keys":   ["brand", "product_name", ...],
        "cutout_path":   "/uploads/batches/.../产品A/product_cut.png" 或 None,
        "cutout_error":  None 或 "ExceptionType: msg",
        "preview_html":  "/uploads/batches/.../产品A/preview.html" 或 None,
        "preview_png":   "/uploads/batches/.../产品A/preview.png" 或 None,
        "render_error":  None 或 "ExceptionType: msg",
        "product_name":  "产品A",
    }

策略：
- DeepSeek 失败 → 抛异常（整产品 failed，被 batch_queue._submit_one 兜）
- rembg 失败 → 记 cutout_error，不抛（HTML 仍可生成）
- HTML 渲染或截图失败 → 记 render_error，不抛（保留 parsed.json 给用户重试）

并发说明（4b）：
- 每个 worker 跑独立的 sync_playwright + Chromium 进程（~600MB/个）
- 3 worker 并发 ≈ 1.8GB Chromium 内存峰值；OK
- 优化方向（任务 5+）：共享单 Chromium + per-thread context，但 sync_api 跨线程麻烦
"""
from __future__ import annotations

import io
import json
import traceback
from pathlib import Path


def _publish_stage(scope_id: str, name: str, stage: str) -> None:
    """任务2 (2026-04-22): 发 WS stage 事件 + 同步 BatchItem.current_stage.

    - WS: 广播 {type:'stage', name, stage, ts} 给 /ws/batch/<scope_id> 的订阅者
    - DB: UPDATE batch_items.current_stage 让 WS 断线重连时能 catch-up
    - 失败策略: traceback 打印但不抛, worker 主流程继续 (与 _batch_db_sync_callback 一致)
    """
    import time
    ts_ms = int(time.time() * 1000)
    try:
        from app import app as _flask_app, db
        from models import BatchItem, Batch
        import batch_pubsub as batch_pubsub_mod

        batch_pubsub_mod.publish(scope_id, {
            "type": "stage",
            "name": name,
            "stage": stage,
            "ts": ts_ms,
        })

        with _flask_app.app_context():
            batch = Batch.query.filter_by(batch_id=scope_id).first()
            if batch is not None:
                BatchItem.query.filter_by(batch_pk=batch.id, name=name).update(
                    {"current_stage": stage}
                )
                db.session.commit()
    except Exception as e:
        print(f"[stage-publish] {scope_id}/{name} stage={stage} failed: {e}",
              flush=True)
        traceback.print_exc()


def _resolve_path(url_or_path: str, base_dir: Path) -> Path:
    """把 URL 形式的 /uploads/batches/.../foo.jpg 转成绝对 Path。

    磁盘实际落在 static/uploads/... (2026-04-22 修容器持久化 bug), 所以 URL
    前缀 uploads/ 要补成 static/uploads/ 才能拼出磁盘真实路径。
    """
    s = str(url_or_path or "").lstrip("/")
    if s.startswith("uploads/"):
        s = "static/" + s
    return base_dir / s


def _to_url(p: Path, base_dir: Path) -> str:
    """磁盘 Path → URL. static/uploads/ 剥成 /uploads/ (对外 URL 不带 static/)."""
    rel = str(p.resolve().relative_to(base_dir.resolve())).replace("\\", "/")
    if rel.startswith("static/uploads/"):
        rel = rel[len("static/"):]
    return "/" + rel


def _cutout_main_image(src_path: Path, dst_path: Path) -> None:
    """rembg 抠主图 + 色值清纯白残留，落到 dst_path。

    复用 app._remove_bg_if_needed 的核心逻辑（AI + 色值混合），
    但解耦了 user_dir/uid 命名约定，便于批次场景固定写 product_cut.png。

    raises: ImportError / RuntimeError / IOError 由调用方决定如何处置。
    """
    # 延迟导入：避免 batch_processor 模块加载就把 app.py 整个拖起来
    from app import _ensure_rembg, _DESKTOP_MODE
    if _DESKTOP_MODE:
        from offline_cutout import remove_background
        remove_background(src_path, dst_path)
        return
    if not _ensure_rembg():
        raise RuntimeError("rembg 不可用（未安装或模型加载失败）")

    from PIL import Image as _Img
    import numpy as np
    import rembg
    from app import REMBG_SESSION as _SESSION

    im = _Img.open(src_path)
    # 已带真实透明区域 → 不重抠，直接复制（保留用户已有抠好的图）
    if im.mode == "RGBA":
        if np.array(im)[:, :, 3].min() < 250:
            im.save(str(dst_path))
            return

    orig = im.convert("RGB")
    arr = np.array(orig)

    # 1) AI 抠图
    with open(src_path, "rb") as inp:
        ai_bytes = rembg.remove(inp.read(), session=_SESSION)
    ai_img = _Img.open(io.BytesIO(ai_bytes)).convert("RGBA")
    ai_alpha = np.array(ai_img)[:, :, 3]

    # 2) 色值清理纯白残留 — 取四角 15×15 采样作为背景基准
    corners = [arr[:15, :15], arr[:15, -15:], arr[-15:, :15], arr[-15:, -15:]]
    bg_min = np.concatenate([c.reshape(-1, 3) for c in corners]).min(axis=0)
    threshold = max(int(bg_min.min()) - 2, 248)
    pure_bg = np.all(arr >= threshold, axis=2)
    ai_alpha[pure_bg & (ai_alpha < 200)] = 0

    # 3) 合成 + 落盘
    result_arr = np.dstack([arr, ai_alpha])
    _Img.fromarray(result_arr.astype(np.uint8), "RGBA").save(str(dst_path))


def _render_product_preview(
    scope_id: str,
    name: str,
    product_dir: Path,
    parsed: dict,
    product_image_url: str,
) -> tuple[str | None, str | None, str | None]:
    """渲染 assembled.html → 落 preview.html + 截 preview.png。

    每个 worker 自起一个 sync_playwright + Chromium 进程（约 ~600MB）。
    3 worker 并发 ≈ 1.8GB 峰值,可接受;后续任务 5 再考虑共享浏览器。

    返回: (preview_html_url 或 None, preview_png_url 或 None, error 或 None)

    失败原则: 抛任何异常 → 兜回 (None, None, "Type: msg"),不影响产品 done。
    """
    from app import (
        app as _flask_app,
        BASE_DIR,
        _map_parsed_to_form_fields,
        _assemble_all_blocks,
        _load_build_config,
    )
    from flask import render_template

    # ★★ 修复 2026-04-20 worker Flask context 漏洞 (漏网之鱼, 跟 refine_processor 同根):
    # 原写法 `with _flask_app.app_context():` 只包住了 render_template 一行, 且只 push 了
    # app_context — 但 Flask-Login 的 context processor 会在渲染模板时访问 current_user →
    # 内部查 current_app → 触发 "Working outside of application context".
    # 另外 render_template 如果命中模板里间接用的 url_for (扩展 / 宏 / 默认 context processor),
    # 光 app_context 不够, 还要 request context.
    #
    # 统一修法: 用 test_request_context() 一次性 push app+request context, 范围扩到整个 try.
    # test_request_context() 不依赖真实 HTTP 请求, 只用来满足 Flask 内部上下文检查.
    with _flask_app.test_request_context():
      try:
        # 1) parsed → mapped form fields → assembled block data
        mapped = _map_parsed_to_form_fields(parsed)
        cfg = _load_build_config("设备类")
        images = {
            "product_image": product_image_url,
            "scene_image": "",
            "logo_image": "",
            "qr_image": "",
            "product_side_image": "",
            "effect_image": "",
        }
        all_data = _assemble_all_blocks("设备类", mapped, images, cfg)

        # 2) render template — 上面 test_request_context 已经兜住 app+request context
        html = render_template("设备类/assembled.html", **all_data)

        # 3) 把 /static/ 和 /uploads/ 的 src/href 改成 file:/// 绝对路径
        # Playwright 走 file:// 协议时,/static/foo.png 会被解析成磁盘根目录,必死。
        #
        # 2026-04-22 紧急3回归修复: URL 前缀 /uploads/ 在紧急3(f613dd2) 后对应
        # 磁盘路径 /app/static/uploads/ (UPLOAD_DIR 迁移). 这里 file:// 替换
        # 之前直接拼成 /app/uploads/ → 文件 404 → 首屏产品图显示浏览器"加载失败"
        # 占位符 (用户报的问题3). 修法: /uploads/ 的替换目标加 static/ 前缀.
        base_url_str = str(BASE_DIR).replace("\\", "/")
        _URL_TO_DISK = {
            "/static/": "/static/",               # /static/ URL 直接对应 BASE_DIR/static/
            "/uploads/": "/static/uploads/",      # /uploads/ URL 映射到 BASE_DIR/static/uploads/
        }
        for url_prefix, disk_prefix in _URL_TO_DISK.items():
            html = html.replace(
                f'src="{url_prefix}', f'src="file:///{base_url_str}{disk_prefix}'
            ).replace(
                f"src='{url_prefix}", f"src='file:///{base_url_str}{disk_prefix}"
            ).replace(
                f'href="{url_prefix}', f'href="file:///{base_url_str}{disk_prefix}'
            )

        preview_html_path = product_dir / "preview.html"
        preview_html_path.write_text(html, encoding="utf-8")
        print(f"[batch_processor] {scope_id}/{name} → preview.html 已落盘",
              flush=True)
        _publish_stage(scope_id, name, "capturing")  # 任务2 stage 事件 (进 Playwright 截图阶段)

        # 4) Playwright 截图 → preview.png
        preview_png_path = product_dir / "preview.png"
        from playwright.sync_api import sync_playwright
        from browser_runtime import launch_chromium
        with sync_playwright() as pw:
            browser = launch_chromium(pw, args=[
                "--allow-file-access-from-files",
            ])
            ctx = browser.new_context(
                viewport={"width": 750, "height": 900},
                device_scale_factor=2,
            )
            page = ctx.new_page()
            # 2026-04-22 紧急3: wait_until 从 networkidle 改为 load.
            # networkidle 要求"网络静默 500ms 以上"才算, 任何懒加载 / 超大图
            # (实测 DZ70X 上传 254MB 透明 PNG) 都能把它无限拖 → 30s timeout
            # → preview.png 不生成 → DB preview_png=null → 前端列空.
            # load 只等 window.onload (同步资源发起即可), DOM 就绪就返回,
            # 给 3s wait_for_timeout 让大图尽量解码完再截. 截到多少算多少.
            page.goto(preview_html_path.as_uri(),
                      wait_until="load", timeout=30000)
            page.wait_for_timeout(3000)  # DOM 就绪后给大图多 3s 解码
            page.screenshot(path=str(preview_png_path), full_page=True)
            browser.close()
        print(f"[batch_processor] {scope_id}/{name} → preview.png 截图完成",
              flush=True)

        return (
            _to_url(preview_html_path, BASE_DIR),
            _to_url(preview_png_path, BASE_DIR),
            None,
        )
      except Exception as e:
        err = f"{type(e).__name__}: {e}"
        print(f"[batch_processor] {scope_id}/{name} → 渲染/截图失败: {err}",
              flush=True)
        traceback.print_exc()
        return (None, None, err)


def process_one_product(scope_id: str, payload: dict, *, api_key: str) -> dict:
    """单产品真实处理器，匹配 batch_queue.ProcessorFn 签名（外加 api_key kwarg）。

    scope_id: batch_id（batch_queue.submit_batch 透传）
    payload:  scan_batch 产出的单条 ok 产品 dict
    api_key:  发起批次的用户的 DeepSeek Key（已解密明文）；空 → 抛 ValueError

    注意：batch_queue.submit_batch 期望 (scope_id, payload) 两参签名，
    所以本函数必须用 functools.partial 或闭包绑定 api_key 后再传入。
    见 app.py /api/batch/<id>/start 端点用法。

    步骤：
      1. 校验必填字段（含 api_key）
      2. DeepSeek 解析 desc_text → 落 parsed.json
      3. rembg 抠主图 → 落 product_cut.png（失败仅记录，不抛）
    """
    from app import _call_deepseek_parse, BASE_DIR

    name = payload.get("name") or "unknown"
    desc_text = payload.get("desc_text") or ""
    main_url = payload.get("main_image_path") or ""

    if not (api_key or "").strip():
        raise ValueError(f"产品 {name} 没有可用的 DeepSeek API Key（请检查用户账号设置）")
    if not desc_text.strip():
        raise ValueError(f"产品 {name} 缺少 desc_text，无法解析")
    if not main_url:
        raise ValueError(f"产品 {name} 缺少 main_image_path")

    main_path = _resolve_path(main_url, BASE_DIR)
    if not main_path.is_file():
        raise FileNotFoundError(f"主图不存在: {main_path}")

    product_dir = main_path.parent

    # 任务9 (PRD F11): 取批次级模板策略 (来自 batch_start_real 注入)
    product_category = payload.get("product_category") or "设备类"

    # ── 1) DeepSeek 解析（同步阻塞 5–15s/次）──────────────────────
    print(f"[batch_processor] {scope_id}/{name} → DeepSeek 解析中…", flush=True)
    _publish_stage(scope_id, name, "parsing")  # 任务2 stage 事件
    parsed = _call_deepseek_parse(desc_text, product_type=product_category, api_key=api_key)
    parsed_file = product_dir / "parsed.json"
    parsed_file.write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    parsed_rel = _to_url(parsed_file, BASE_DIR)
    print(f"[batch_processor] {scope_id}/{name} → parsed.json 已落盘"
          f"（{len(parsed)} 个字段）", flush=True)

    # ── 1.5) 任务9: 模板智能匹配 (auto 走关键词; fixed 直通批次预选) ─
    from theme_matcher import resolve_with_strategy
    resolved_theme_id, theme_matched_by = resolve_with_strategy(
        strategy=payload.get("template_strategy") or "auto",
        fixed_theme_id=payload.get("fixed_theme_id"),
        parsed_product_type=str(parsed.get("product_type") or ""),
        product_category=product_category,
    )
    print(f"[batch_processor] {scope_id}/{name} → 主题匹配: "
          f"{resolved_theme_id} (by {theme_matched_by})", flush=True)

    # ── 2) rembg 抠主图（失败兜底，不影响产品 done）────────────────
    cutout_rel: str | None = None
    cutout_error: str | None = None
    try:
        cutout_file = product_dir / "product_cut.png"
        print(f"[batch_processor] {scope_id}/{name} → rembg 抠图中…",
              flush=True)
        _publish_stage(scope_id, name, "cutting")  # 任务2 stage 事件
        _cutout_main_image(main_path, cutout_file)
        cutout_rel = _to_url(cutout_file, BASE_DIR)
        print(f"[batch_processor] {scope_id}/{name} → product_cut.png 完成",
              flush=True)
    except Exception as e:
        cutout_error = f"{type(e).__name__}: {e}"
        print(f"[batch_processor] {scope_id}/{name} → 抠图失败（保留原图）: "
              f"{cutout_error}", flush=True)
        traceback.print_exc()

    # ── 3) Playwright 渲染 + 截图（失败兜底,不影响产品 done）────────
    # 用 cutout（如果有）作为产品图;没抠到就用原图。场景图等留空。
    render_main_image = cutout_rel or main_url
    print(f"[batch_processor] {scope_id}/{name} → 渲染长图中…", flush=True)
    _publish_stage(scope_id, name, "rendering")  # 任务2 stage 事件
    preview_html_rel, preview_png_rel, render_error = _render_product_preview(
        scope_id, name, product_dir, parsed, render_main_image
    )

    return {
        "parsed_path":  parsed_rel,
        "parsed_keys":  list(parsed.keys()),
        "cutout_path":  cutout_rel,
        "cutout_error": cutout_error,
        "preview_html": preview_html_rel,
        "preview_png":  preview_png_rel,
        "render_error": render_error,
        "product_name": name,
        # 任务9: 让 DB sync callback 把这两个字段写到 BatchItem
        "resolved_theme_id":         resolved_theme_id,
        "resolved_theme_matched_by": theme_matched_by,
    }
