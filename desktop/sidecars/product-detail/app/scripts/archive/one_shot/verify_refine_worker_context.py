"""再现 2026-04-20 线上事故 + 验证 refine_processor 在 worker 线程能跑通。

事故:
  3 个产品精修全部报 RuntimeError: Working outside of application context
  根因: _build_ctxs_from_parsed → _enrich_scenes_with_images → _match_scene_image
        在 worker 线程里调 url_for('static', ...), 没有 app context 直接炸.

本脚本用真 ThreadPoolExecutor 跑 refine_one_product (模拟生产环境),
mock 掉 ai_bg_cache.generate_backgrounds 和 ai_compose_pipeline.compose_detail_page
(绝不烧真豆包 API), 只暴露 Flask app context 层的逻辑.

没修之前: 必报 RuntimeError
修完后: 返回 {ai_refined_path, ai_refined_at, ...}
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)


def _log(m: str) -> None:
    print(f"[verify-worker] {m}", flush=True)


def _write_fixture_parsed(product_dir: Path, name: str) -> Path:
    """写一个结构逼真的 parsed.json — 必须含 scenes 才能触发 _match_scene_image → url_for"""
    parsed_path = product_dir / "parsed.json"
    # scenes 必须是 list[dict{name}], 触发 _enrich_scenes_with_images
    parsed = {
        "brand": "小玺测试品牌",
        "brand_en": "XIAOXI_TEST",
        "product_name": name,
        "model": name,
        "main_title": f"{name} 高效清洁",
        "sub_title": "工业级性能",
        "category_label": "商用扫地机",
        "hero_kpis": [
            {"label": "续航", "value": "8", "unit": "小时"},
            {"label": "效率", "value": "3600", "unit": "㎡/h"},
        ],
        "advantages": [
            {"icon_key": "battery", "title": "长续航", "desc": "连续工作 8 小时"},
            {"icon_key": "brush", "title": "强吸力", "desc": "吸除细小颗粒"},
        ],
        "detail_params": [
            {"key": "重量", "value": "45 kg"},
            {"key": "噪音", "value": "62 dB"},
        ],
        "dimensions": {"长": "85cm", "宽": "50cm", "高": "100cm"},
        "scenes": [
            {"name": "商场", "description": "夜间无人清洁"},
            {"name": "仓库", "description": "全天候作业"},
            {"name": "酒店大堂", "description": "低噪音巡检"},
        ],
        "vs_rows": [
            {"feature": "工作时长", "us": "8h", "manual": "2h"},
            {"feature": "作业面积", "us": "3600㎡", "manual": "500㎡"},
        ],
        "story": {"title": "清洁故事", "body": "为无人场景而生"},
    }
    parsed_path.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    return parsed_path


def main() -> int:
    failures: list[str] = []

    # ── 1. 准备真磁盘 fixture ──────────────────────────────────────
    # 必须在 BASE_DIR 下, 因为 payload 里的 URL 是相对路径, 解析时会拼 BASE_DIR
    try:
        from app import BASE_DIR
    except Exception as e:
        print(f"导入 app 失败: {e!r}")
        return 1

    tmp_root = BASE_DIR / "static" / "uploads" / f"_tmp_verify_worker_{int(time.time())}"
    product_name = "测试产品_X"
    product_dir = tmp_root / product_name
    product_dir.mkdir(parents=True, exist_ok=True)
    try:
        parsed_path = _write_fixture_parsed(product_dir, product_name)
        rel_parsed = "/" + parsed_path.resolve().relative_to(BASE_DIR.resolve()).as_posix()
        # 伪造一张 1x1 png 当产品图 (ai_compose 被 mock 掉不会真用它)
        fake_img = product_dir / "product.jpg"
        fake_img.write_bytes(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
            b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00"
            b"\x01\x01\x00\x01\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        rel_img = "/" + fake_img.resolve().relative_to(BASE_DIR.resolve()).as_posix()
        _log(f"✓ fixture: {product_dir} (parsed={rel_parsed})")

        # ── 2. Mock 外部依赖 (绝不烧真豆包) ─────────────────────────
        import ai_bg_cache
        import ai_compose_pipeline

        bg_calls: list[dict] = []
        def _fake_bgs(*, theme_id, product_category, brand, api_key,
                      product_name, reference_image_url=""):
            bg_calls.append({"theme_id": theme_id, "brand": brand, "api_key": api_key})
            # 返回 6 个假的背景 URL
            return {i: {"url": "", "prompt": f"fake-bg-{i}"} for i in range(1, 7)}
        ai_bg_cache.generate_backgrounds = _fake_bgs

        compose_calls: list[dict] = []
        def _fake_compose(*, ctxs, order, out_dir, out_jpg_name, jpg_quality=90,
                          verbose=False):
            compose_calls.append({
                "n_ctxs": len(ctxs),
                "order": order,
                "out_dir": str(out_dir),
                "out_name": out_jpg_name,
            })
            # 模拟落盘
            out_jpg = Path(out_dir) / out_jpg_name
            out_jpg.write_bytes(fake_img.read_bytes())
            return {
                "jpg": str(out_jpg),
                "segments": list(range(1, len(ctxs) + 1)),
                "width": 750,
                "height": 5000,
            }
        ai_compose_pipeline.compose_detail_page = _fake_compose
        _log("✓ ai_bg_cache.generate_backgrounds 和 ai_compose_pipeline.compose_detail_page 已 mock")

        # ── 3. 用 ThreadPoolExecutor 真 worker 跑 (关键: 不是主线程!) ───
        import refine_processor
        payload = {
            "name": product_name,
            "main_image_path": rel_img,
            "cutout_path": "",
            "parsed_json_path": rel_parsed,
            "resolved_theme_id": "tech-blue",
            "product_category": "设备类",
        }

        def _run():
            return refine_processor.refine_one_product(
                "TEST_WORKER", payload, ark_api_key="sk-FAKE-TEST-KEY"
            )

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-refine") as pool:
            fut = pool.submit(_run)
            try:
                result = fut.result(timeout=30)
            except RuntimeError as e:
                msg = str(e)
                traceback.print_exc()
                if "Working outside of application context" in msg:
                    failures.append(f"★ bug 未修: 仍然报 'Working outside of application context': {msg}")
                else:
                    failures.append(f"worker 抛 RuntimeError: {msg}")
                return 1 if failures else 0
            except Exception as e:
                traceback.print_exc()
                failures.append(f"worker 抛异常: {type(e).__name__}: {e}")
                return 1 if failures else 0

        _log(f"✓ worker 返回: {result}")

        # ── 4. 结果契约校验 ─────────────────────────────────────────
        if not result.get("ai_refined_path"):
            failures.append("result 缺 ai_refined_path")
        elif not result["ai_refined_path"].startswith("/"):
            failures.append(f"ai_refined_path 应为相对 URL: {result['ai_refined_path']}")
        else:
            _log(f"✓ ai_refined_path = {result['ai_refined_path']}")
        if not result.get("ai_refined_at"):
            failures.append("result 缺 ai_refined_at 时间戳")
        if result.get("segments_count", 0) < 1:
            failures.append(f"segments_count 应 >=1: {result}")
        else:
            _log(f"✓ segments_count = {result['segments_count']}")

        # ── 5. 外部 API 调用次数 ────────────────────────────────────
        if len(bg_calls) != 1:
            failures.append(f"ai_bg_cache 应调 1 次, 实际 {len(bg_calls)}")
        else:
            _log(f"✓ ai_bg_cache 调 1 次, api_key={bg_calls[0]['api_key']}")
        if len(compose_calls) != 1:
            failures.append(f"ai_compose_pipeline 应调 1 次, 实际 {len(compose_calls)}")
        else:
            _log(f"✓ ai_compose_pipeline 调 1 次, n_ctxs={compose_calls[0]['n_ctxs']} "
                 f"out_name={compose_calls[0]['out_name']}")

        # ── 6. ctxs 确实含被 _match_scene_image 处理过的 scenes ──────
        # 看 compose_calls[0] 的 ctxs 是否在 scene 屏里含有 scene_bank 路径
        # (这才证明 url_for 真的被调用了而且没报错)
        # 我们不直接验 ctxs 内容 (已 mock), 只确保 fake_compose 拿到了非空 ctxs
        if compose_calls and compose_calls[0]["n_ctxs"] < 1:
            failures.append("ctxs 空 — _build_ctxs_from_parsed 没正确输出")

    finally:
        # 清理 fixture
        try:
            import shutil
            shutil.rmtree(tmp_root, ignore_errors=True)
            _log(f"✓ fixture {tmp_root.name} 已清理")
        except Exception as e:
            _log(f"清理出错(忽略): {e}")

    print("\n" + "═" * 60)
    if failures:
        print(f"✗ 验证 {len(failures)} 项失败:")
        for f in failures:
            print(f"  - {f}")
        print("═" * 60)
        return 1
    print("✓ refine worker 在 ThreadPoolExecutor 线程里能跑通,app_context 已修好")
    print("═" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
