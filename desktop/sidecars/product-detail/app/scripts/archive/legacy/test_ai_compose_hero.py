"""
AI 合成管线 · 阶段一：hero 屏 HTML 合成测试

流程：
1. Jinja2 渲染 templates/ai_compose/hero.html
   - AI 背景：output/prompt_test_v2/segments/hero.png（Seedream 4.0 已生成）
   - 产品抠图：output/dz10_product_nobg.png（rembg 已处理）
   - 主题色：classic-red(#E8231A)
   - 真实洗地机数据（DZ50X 驾驶式）
2. Playwright 截图 750×1000 → output/ai_compose_test/hero.png

关键：跨目录 file:// 资源必须用 --allow-file-access-from-files 放行 Chromium。
"""
import sys
import time
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

BASE = Path(__file__).parent
TPL_DIR = BASE / "templates" / "ai_compose"
OUT_DIR = BASE / "output" / "ai_compose_test"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BG_PATH      = BASE / "output" / "prompt_test_v2" / "segments" / "hero.png"
PRODUCT_PATH = BASE / "output" / "dz10_product_nobg.png"

CANVAS_W, CANVAS_H = 750, 1000

# ── 素材检查 ──────────────────────────────────────────
missing = [str(p) for p in (BG_PATH, PRODUCT_PATH, TPL_DIR / "hero.html") if not p.exists()]
if missing:
    print("[FATAL] 素材缺失：")
    for m in missing:
        print(f"  - {m}")
    sys.exit(1)

# ── 真实数据（DZ50X 驾驶式洗地机） ─────────────────────
ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,
    "bg_url":             BG_PATH.as_uri(),
    "product_url":        PRODUCT_PATH.as_uri(),

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "main_title":         "DZ50X",
    "subtitle":           "驾驶式洗地机 · 商用清洁智能驾驶",
    "taglines":           ["一台顶八人", "效率 3600㎡/h"],
    "kpi_list": [
        {"value": "3600㎡/h", "label": "清扫效率"},
        {"value": "850mm",    "label": "清扫宽度"},
        {"value": "4小时",    "label": "续航时间"},
        {"value": "≤68dB",    "label": "运行噪音"},
    ],
}

# ── Jinja2 渲染 ───────────────────────────────────────
env = Environment(
    loader=FileSystemLoader(str(TPL_DIR)),
    autoescape=select_autoescape(["html"]),
)
html = env.get_template("hero.html").render(**ctx)

temp_html = OUT_DIR / "_hero_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
print(f"[compose] 背景: {BG_PATH}")
print(f"[compose] 产品: {PRODUCT_PATH}")

# ── Playwright 截图 ───────────────────────────────────
out_png = OUT_DIR / "hero.png"
t0 = time.time()

from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        args=[
            "--allow-file-access-from-files",  # 跨目录 file:// 放行
            "--disable-web-security",           # 保险层
        ],
    )
    page = browser.new_page(
        viewport={"width": CANVAS_W, "height": CANVAS_H},
        device_scale_factor=2,  # 2x 超清输出，导出后会自动 retina 级别
    )

    console_msgs = []
    page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

    page.goto(temp_html.as_uri(), wait_until="networkidle", timeout=20000)
    # 等一帧让 backdrop-filter 稳定
    page.wait_for_timeout(150)

    page.screenshot(
        path=str(out_png),
        clip={"x": 0, "y": 0, "width": CANVAS_W, "height": CANVAS_H},
    )
    browser.close()

    if console_msgs:
        print("[compose] Chromium 控制台:")
        for m in console_msgs:
            print(f"  {m}")

elapsed = time.time() - t0

# ── 验证 ──────────────────────────────────────────────
from PIL import Image

img = Image.open(out_png)
size_kb = out_png.stat().st_size / 1024
print("=" * 60)
print(f"[compose] ✅ hero 合成完成 {elapsed:.2f}s")
print(f"  输出:   {out_png}")
print(f"  尺寸:   {img.width} × {img.height} (2x scale → 实际像素)")
print(f"  大小:   {size_kb:.1f} KB")

# 简单像素健康检查：截图不应该是全白或全黑
sample = img.resize((1, 1)).getpixel((0, 0))
print(f"  均值像素: {sample}  (全白=(255,255,255,255), 全黑=(0,0,0,255))")
if sample[:3] == (255, 255, 255) or sample[:3] == (0, 0, 0):
    print("  ⚠️ 警告：均值像素异常，可能背景或产品未加载成功")
