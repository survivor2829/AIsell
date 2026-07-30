"""
AI 合成管线 · 阶段一:specs 屏 HTML 合成测试

架构要点:
- 从 _registry.json 读取屏幕元数据(画布尺寸/模板文件)
- 内容100%由 ctx 驱动,不在HTML里硬编码任何文案
- 排版变量可通过 ctx 覆盖(title_align/spec_value_size 等),支持后续前端动态调整
- 模板独立自描述,不依赖其他屏
"""
import json
import sys
import time
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

BASE = Path(__file__).parent
TPL_DIR = BASE / "templates" / "ai_compose"
OUT_DIR = BASE / "output" / "ai_compose_test"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── 从插件注册表取 specs 屏元数据 ──────────────────────
REGISTRY = json.loads((TPL_DIR / "_registry.json").read_text(encoding="utf-8"))
meta = REGISTRY["specs"]
CANVAS_W, CANVAS_H = meta["canvas"]
TEMPLATE_NAME = meta["template"]
print(f"[registry] specs -> {TEMPLATE_NAME} {CANVAS_W}x{CANVAS_H}")
print(f"           required: {meta['required_keys']}")

# ── 素材路径 ──────────────────────────────────────────
BG_PATH      = BASE / "output" / "prompt_test_v2" / "segments" / "specs.png"
PRODUCT_PATH = BASE / "output" / "dz10_product_nobg.png"

missing = [str(p) for p in (BG_PATH, PRODUCT_PATH, TPL_DIR / TEMPLATE_NAME) if not p.exists()]
if missing:
    print("[FATAL] 素材缺失:")
    for m in missing:
        print(f"  - {m}")
    sys.exit(1)

# ── 真实 DZ50X 参数 ───────────────────────────────────
specs = [
    {"label": "清扫效率", "value": "3600",     "unit": "㎡/h"},
    {"label": "清扫宽度", "value": "850",      "unit": "mm"},
    {"label": "水箱容量", "value": "90L/100L", "unit": ""},
    {"label": "整机重量", "value": "380",      "unit": "kg"},
    {"label": "续航时间", "value": "4",        "unit": "小时"},
    {"label": "最小转弯", "value": "1.2",      "unit": "m"},
    {"label": "运行噪音", "value": "≤68",      "unit": "dB"},
    {"label": "充电时间", "value": "2",        "unit": "小时"},
]

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,
    "bg_url":             BG_PATH.as_uri(),
    "product_url":        PRODUCT_PATH.as_uri(),

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "TECHNICAL SPECS",
    "title_prefix":       "",
    "title_main":         "专业参数",
    "subtitle":           "DZ50X · 驾驶式洗地机",
    "product_badge":      "MODEL DZ50X",
    "specs":              specs,
}

# ── 必填字段校验(插件式架构:注册表说了算) ──────────
missing_keys = [k for k in meta["required_keys"] if k not in ctx or ctx[k] is None]
if missing_keys:
    print(f"[FATAL] ctx 缺少必填字段: {missing_keys}")
    sys.exit(1)

# ── Jinja2 渲染 ───────────────────────────────────────
env = Environment(
    loader=FileSystemLoader(str(TPL_DIR)),
    autoescape=select_autoescape(["html"]),
)
html = env.get_template(TEMPLATE_NAME).render(**ctx)

temp_html = OUT_DIR / "_specs_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
print(f"[compose] 背景: {BG_PATH}")
print(f"[compose] 产品: {PRODUCT_PATH}")

# ── Playwright 截图 ───────────────────────────────────
out_png = OUT_DIR / "specs.png"
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
print(f"[compose] ✅ specs 合成完成 {elapsed:.2f}s")
print(f"  输出:   {out_png}")
print(f"  尺寸:   {img.width} × {img.height} (2x scale)")
print(f"  大小:   {size_kb:.1f} KB")

sample = img.resize((1, 1)).getpixel((0, 0))
print(f"  均值像素: {sample}")
