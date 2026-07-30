"""
AI 合成管线 · 阶段一:brand 品牌屏 HTML 合成测试

关键:brand_name / brand_story / credentials 都是测试驱动数据,
     代表"清洁工业"品牌在 DZ50X 产品文案下的合理表达。
     换产品 = 换 ctx,模板零修改。
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

# ── 注册表 ────────────────────────────────────────────
REGISTRY = json.loads((TPL_DIR / "_registry.json").read_text(encoding="utf-8"))
meta = REGISTRY["brand"]
CANVAS_W, CANVAS_H = meta["canvas"]
TEMPLATE_NAME = meta["template"]
print(f"[registry] brand -> {TEMPLATE_NAME} {CANVAS_W}x{CANVAS_H}")

# ── 素材 ──────────────────────────────────────────────
BG_PATH = BASE / "output" / "prompt_test_v2" / "segments" / "brand.png"
if not BG_PATH.exists():
    print(f"[WARN] 品牌屏 AI 背景不存在,将使用模板内置深色渐变: {BG_PATH}")
    BG_URI = None
else:
    BG_URI = BG_PATH.as_uri()

if not (TPL_DIR / TEMPLATE_NAME).exists():
    print(f"[FATAL] 模板缺失: {TPL_DIR / TEMPLATE_NAME}")
    sys.exit(1)

# ── 清洁工业品牌信息(DZ50X 对应品牌层面的表达) ───────
brand_name     = "CLEAN INDUSTRY"
brand_name_sub = "清洁工业 · 智能清洁解决方案"
brand_story    = (
    "深耕商用清洁领域 15 年,服务全球 3000+ 商业客户。"
    "专注为大空间场景提供高效、静音、耐用的智能清洁解决方案,"
    "让每一次清洁都更省力、更专业、更值得信赖。"
)

credentials = [
    {"icon": "🏆", "main": "15+",    "label": "深耕年限"},
    {"icon": "🌍", "main": "3000+",  "label": "商用客户"},
    {"icon": "🔬", "main": "12 项",  "label": "发明专利"},
    {"icon": "📜", "main": "ISO",    "label": "质量认证"},
]

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,
    "bg_url":             BG_URI,

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "ABOUT US",
    "brand_name":         brand_name,
    "brand_name_sub":     brand_name_sub,
    "brand_story":        brand_story,
    "credentials":        credentials,
    "credentials_cols":   4,
}

# ── 必填字段校验 ──────────────────────────────────────
missing_keys = [k for k in meta["required_keys"] if k not in ctx]
if missing_keys:
    print(f"[FATAL] ctx 缺少必填字段: {missing_keys}")
    sys.exit(1)

# ── 渲染 ──────────────────────────────────────────────
env = Environment(
    loader=FileSystemLoader(str(TPL_DIR)),
    autoescape=select_autoescape(["html"]),
)
html = env.get_template(TEMPLATE_NAME).render(**ctx)

temp_html = OUT_DIR / "_brand_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
if BG_URI:
    print(f"[compose] 背景: {BG_PATH}")

# ── 截图 ──────────────────────────────────────────────
out_png = OUT_DIR / "brand.png"
t0 = time.time()

from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        args=["--allow-file-access-from-files", "--disable-web-security"],
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
    page.screenshot(path=str(out_png),
                    clip={"x": 0, "y": 0, "width": CANVAS_W, "height": CANVAS_H})
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
print(f"[compose] ✅ brand 合成完成 {elapsed:.2f}s")
print(f"  输出: {out_png}")
print(f"  尺寸: {img.width} × {img.height} (2x scale)")
print(f"  大小: {size_kb:.1f} KB")
print(f"  均值像素: {img.resize((1, 1)).getpixel((0, 0))}")
