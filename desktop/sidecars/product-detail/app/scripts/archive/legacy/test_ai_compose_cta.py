"""
AI 合成管线 · 阶段一:cta 行动屏 HTML 合成测试

关键:cta_main / cta_sub / contacts 全是测试驱动数据,
     对应 DZ50X 品牌层面的联系方式。换产品 = 换 ctx,模板零修改。

设计理念:CTA 屏不走 AI 背景,直接用品牌色对角渐变 + 双光晕,
         前 6 屏视觉密度已很高,最后一屏走"大片干净"反差,才抓得住视线。
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
meta = REGISTRY["cta"]
CANVAS_W, CANVAS_H = meta["canvas"]
TEMPLATE_NAME = meta["template"]
print(f"[registry] cta -> {TEMPLATE_NAME} {CANVAS_W}x{CANVAS_H}")

if not (TPL_DIR / TEMPLATE_NAME).exists():
    print(f"[FATAL] 模板缺失: {TPL_DIR / TEMPLATE_NAME}")
    sys.exit(1)

# ── DZ50X 对应的 CTA 文案(最小化 ctx:模拟"用户只给了电话和邮箱"的场景) ──
# 设计约定:用户说啥放啥 — 没给 service 热线说明/网址/7x24 承诺就不硬塞,
#           没给 qr_url / product_url 就右列留空,整体由 ctx 决定密度
cta_main = "立即开启智能清洁新时代"
cta_sub  = "获取 DZ50X 专属清洁方案"

contacts = [
    {"icon": "📞", "value": "400-888-6666"},
    {"icon": "✉️", "value": "biz@cleanindustry.cn"},
]

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "CONTACT US",
    "cta_main":           cta_main,
    "cta_sub":            cta_sub,
    "contacts":           contacts,
    # 不传 qr_url / product_url:template 右列 {% elif %} 会跳过渲染 — 零留白脏容器
    # 不传 cta_start/mid/end:走 Apple 调色师默认三段(柔红→酒红→近黑)
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

temp_html = OUT_DIR / "_cta_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")

# ── 截图 ──────────────────────────────────────────────
out_png = OUT_DIR / "cta.png"
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
print(f"[compose] ✅ cta 合成完成 {elapsed:.2f}s")
print(f"  输出: {out_png}")
print(f"  尺寸: {img.width} × {img.height} (2x scale)")
print(f"  大小: {size_kb:.1f} KB")
print(f"  均值像素: {img.resize((1, 1)).getpixel((0, 0))}")
