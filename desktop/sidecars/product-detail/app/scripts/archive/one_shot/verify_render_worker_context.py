"""验证 batch_processor._render_product_preview 在真 ThreadPoolExecutor worker 里能跑通.

背景:
  - 2026-04-20 线上事故: batch_20260420_019_3932 3 个产品 render 全部抛
    "Working outside of application context", 但 status=done, 前端假绿.
  - 根因: 原写法 `with _flask_app.app_context():` 只包 render_template 一行,
    且只 push 了 app context (Flask-Login 的 context processor 还是会炸).
  - 修复: 改成 `with _flask_app.test_request_context():` 扩大到整个 try 块.

本脚本:
  - 用真 ThreadPoolExecutor (not 主线程) 跑 _render_product_preview
  - 造一个最小可行的 fixture parsed.json (不调 DeepSeek)
  - 造一张真 JPG 作为产品主图
  - 跑完看:
      (A) 返回 (preview_html_url, preview_png_url, None) 三元组里 error 必须是 None
      (B) 磁盘上必须有 preview.png (真 PNG 字节头)
      (C) 磁盘上必须有 preview.html (非空)
  - 任何一条失败 → 退出码 1
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# PIL 造真图
try:
    from PIL import Image
except ImportError:
    print("缺 Pillow, pip install pillow"); sys.exit(1)


def _log(m: str) -> None:
    print(f"[render-worker] {m}", flush=True)


def _write_fixture(tmp_root: Path) -> tuple[Path, dict, str]:
    """在 tmp_root 下造一个产品目录 + parsed.json + product 图."""
    product_dir = tmp_root / "TST_产品 中文名"  # 带空格+中文, 打边界
    product_dir.mkdir(parents=True, exist_ok=True)
    # 真 1024x1024 JPG
    img_path = product_dir / "product.jpg"
    Image.new("RGB", (1024, 1024), (100, 150, 200)).save(img_path, format="JPEG")
    # 最小可用 parsed.json — _map_parsed_to_form_fields 需要这些字段
    parsed = {
        "brand": "测试品牌",
        "product_name": "测试洗地机",
        "model": "TST-001",
        "main_title": "商用清洁利器",
        "product_type": "洗地机",
        "tagline_line1": "强劲吸力",
        "tagline_line2": "持久续航",
        "e_specs": [
            {"name": "工作宽度", "value": "620mm"},
            {"name": "续航时间", "value": "8 小时"},
            {"name": "清水箱", "value": "60L"},
        ],
        "scenes": [
            {"name": "商场", "image": ""},
            {"name": "超市", "image": ""},
        ],
    }
    (product_dir / "parsed.json").write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    # product_cut.png (假抠图, 用原图即可; _render_product_preview 拿这个作为产品图)
    Image.new("RGBA", (1024, 1024), (200, 220, 250, 255)).save(
        product_dir / "product_cut.png", format="PNG"
    )
    # _render_product_preview 接受的是 URL 形式, 不是磁盘路径
    cut_url = f"/{product_dir.relative_to(ROOT).as_posix()}/product_cut.png"
    return product_dir, parsed, cut_url


def main() -> int:
    from batch_processor import _render_product_preview

    # 用 tmp 目录, 跑完就清
    with tempfile.TemporaryDirectory(prefix="render_worker_", dir=ROOT) as tmp:
        tmp_root = Path(tmp)
        product_dir, parsed, product_image_url = _write_fixture(tmp_root)
        _log(f"fixture: {product_dir.relative_to(ROOT)}")

        results: list = []

        def _run():
            # scope_id: 日志前缀; name: 产品名; product_dir / parsed / image_url
            return _render_product_preview(
                "TST_RENDER",
                product_dir.name,
                product_dir,
                parsed,
                product_image_url,
            )

        t0 = time.time()
        _log("起 ThreadPoolExecutor (1 worker, 真非主线程)...")
        with ThreadPoolExecutor(max_workers=1,
                                 thread_name_prefix="render-worker") as pool:
            fut = pool.submit(_run)
            try:
                preview_html_rel, preview_png_rel, err = fut.result(timeout=60)
            except Exception as e:
                _log(f"✗ worker 抛出: {type(e).__name__}: {e}")
                return 1

        elapsed = round(time.time() - t0, 2)
        _log(f"worker 返回 — html={preview_html_rel!r} png={preview_png_rel!r} "
             f"err={err!r} ({elapsed}s)")

        failures: list[str] = []

        # (A) error 必须是 None
        if err is not None:
            failures.append(f"返回 err 不为 None: {err}")
        else:
            _log("✓ 返回 err=None (没抛 Flask context 错误)")

        # (B) preview.png 必须存在且是真 PNG
        png_path = product_dir / "preview.png"
        if not png_path.is_file():
            failures.append(f"preview.png 没落盘: {png_path}")
        else:
            head = png_path.read_bytes()[:8]
            if head != b"\x89PNG\r\n\x1a\n":
                failures.append(f"preview.png 字节头不对: {head!r}")
            else:
                size = png_path.stat().st_size
                _log(f"✓ preview.png 真 PNG ({size} bytes)")

        # (C) preview.html 必须存在
        html_path = product_dir / "preview.html"
        if not html_path.is_file():
            failures.append(f"preview.html 没落盘: {html_path}")
        else:
            html_content = html_path.read_text(encoding="utf-8")
            if len(html_content) < 1000:
                failures.append(f"preview.html 内容太短: {len(html_content)} 字符")
            elif "file:///" not in html_content:
                failures.append("preview.html 缺 file:/// URL 改写")
            else:
                _log(f"✓ preview.html 落盘 ({len(html_content)} 字符, file:// 改写 OK)")

        # (D) 返回 URL 形如 /xxx/preview.png (相对于 BASE_DIR)
        if preview_png_rel:
            if not preview_png_rel.startswith("/"):
                failures.append(f"preview_png URL 不是绝对路径: {preview_png_rel!r}")
            elif "preview.png" not in preview_png_rel:
                failures.append(f"preview_png URL 异常: {preview_png_rel!r}")
            else:
                _log(f"✓ preview_png URL: {preview_png_rel}")

        print("\n" + "═" * 60)
        if failures:
            print(f"✗ 验证 {len(failures)} 项失败 — render worker context 仍有问题:")
            for f in failures: print(f"  - {f}")
            return 1
        print("✓ render worker 在 ThreadPoolExecutor 里能跑通, Flask context 修复生效")
        print(f"  总耗时 {elapsed}s (含 1 次 Playwright Chromium 冷启动)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
