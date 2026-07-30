"""
AI 合成管线 · 阶段一：advantages 屏 HTML 合成测试

流程与 hero 一致：
- Jinja2 渲染 templates/ai_compose/advantages.html
- AI 背景：output/prompt_test_v2/segments/advantages.png
- 真实 DZ50X 6 大优势数据（扩成 icon + title + desc 三段式）
- Playwright 截图 750×900 → output/ai_compose_test/advantages.png
"""
import sys
import time
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

BASE = Path(__file__).parent
TPL_DIR = BASE / "templates" / "ai_compose"
OUT_DIR = BASE / "output" / "ai_compose_test"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BG_PATH = BASE / "output" / "prompt_test_v2" / "segments" / "advantages.png"

CANVAS_W, CANVAS_H = 750, 900

missing = [str(p) for p in (BG_PATH, TPL_DIR / "advantages.html") if not p.exists()]
if missing:
    print("[FATAL] 素材缺失：")
    for m in missing:
        print(f"  - {m}")
    sys.exit(1)

# ── 6 大优势（四段式：icon + title + 核心数字 + 双行描述） ──
advantages = [
    {
        "icon": "⚡", "title": "高效清扫",
        "stat_num": "3600", "stat_unit": "㎡/h",
        "desc_main": "相当于 8 名保洁同时作业",
        "desc_sub":  "商用大场景一次清洁到位",
    },
    {
        "icon": "💧", "title": "大水箱长续航",
        "stat_num": "90L", "stat_unit": "/ 100L",
        "desc_main": "清水 + 污水双箱设计",
        "desc_sub":  "连续作业不必频繁加水",
    },
    {
        "icon": "🔋", "title": "锂电续航",
        "stat_num": "4", "stat_unit": "小时",
        "desc_main": "一次充电覆盖全天班次",
        "desc_sub":  "2 小时快充即可满电复工",
    },
    {
        "icon": "🔇", "title": "静音运行",
        "stat_num": "≤68", "stat_unit": "dB",
        "desc_main": "商场酒店办公楼全时段可用",
        "desc_sub":  "夜间作业不扰客不投诉",
    },
    {
        "icon": "📐", "title": "精准转弯",
        "stat_num": "1.2", "stat_unit": "m",
        "desc_main": "行业领先的最小转弯半径",
        "desc_sub":  "狭窄货架通道轻松穿行",
    },
    {
        "icon": "🛡️", "title": "安全防护",
        "stat_num": "5", "stat_unit": "重",
        "desc_main": "激光 + 红外 + 碰撞 + 边界 + 急停",
        "desc_sub":  "全方位主动避障与防护",
    },
]

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,
    "bg_url":             BG_PATH.as_uri(),

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "CORE ADVANTAGES",
    "title_prefix":       "六大",
    "title_main":         "核心优势",
    "subtitle":           "DZ50X · 为效率而生",
    "advantages":         advantages,
}

env = Environment(
    loader=FileSystemLoader(str(TPL_DIR)),
    autoescape=select_autoescape(["html"]),
)
html = env.get_template("advantages.html").render(**ctx)

temp_html = OUT_DIR / "_advantages_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
print(f"[compose] 背景: {BG_PATH}")

# ── Playwright 截图 ───────────────────────────────────
out_png = OUT_DIR / "advantages.png"
t0 = time.time()

from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        args=[
            "--allow-file-access-from-files",
            "--disable-web-security",
        ],
    )
    page = browser.new_page(
        viewport={"width": CANVAS_W, "height": CANVAS_H},
        device_scale_factor=2,
    )

    console_msgs = []
    page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

    page.goto(temp_html.as_uri(), wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(200)

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

from PIL import Image

img = Image.open(out_png)
size_kb = out_png.stat().st_size / 1024
print("=" * 60)
print(f"[compose] ✅ advantages 合成完成 {elapsed:.2f}s")
print(f"  输出:   {out_png}")
print(f"  尺寸:   {img.width} × {img.height} (2x scale)")
print(f"  大小:   {size_kb:.1f} KB")

sample = img.resize((1, 1)).getpixel((0, 0))
print(f"  均值像素: {sample}")
