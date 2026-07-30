"""
AI 合成管线 · 阶段一:scene 场景屏 HTML 合成测试

关键:本文件中的 scene_items 是"DZ50X 驾驶式洗地机"对应的场景集,
     属于测试驱动数据,不代表模板默认值。
     换产品就换 scene_items,模板侧零修改。

架构:
- scene.html 对场景名/描述/图路径零硬编码
- 场景图来自 static/scene_bank/(真实场景照片)
- grid_columns 可动态切换 2×N / 3×N 布局
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
SCENE_BANK = BASE / "static" / "scene_bank"

# ── 注册表 ────────────────────────────────────────────
REGISTRY = json.loads((TPL_DIR / "_registry.json").read_text(encoding="utf-8"))
meta = REGISTRY["scene"]
CANVAS_W, CANVAS_H = meta["canvas"]
TEMPLATE_NAME = meta["template"]
print(f"[registry] scene -> {TEMPLATE_NAME} {CANVAS_W}x{CANVAS_H}")

if not (TPL_DIR / TEMPLATE_NAME).exists():
    print(f"[FATAL] 模板缺失: {TPL_DIR / TEMPLATE_NAME}")
    sys.exit(1)

# ── DZ50X 适配场景(产品文案 → 场景推导,非模板硬编码) ──
# DZ50X 是驾驶式洗地机,适用场景 = 大空间 + 硬地面 + 商用
# (scene_raw: 文件名 → 显示名/描述/可选tag,file 存在性检查走 Path 对象避免 URL 编码问题)
scene_raw = [
    ("商场.jpg",     "商场超市",    "千级㎡大卖场地面清洁",   "HOT"),
    ("机场.jpg",     "机场航站楼",  "夜间深度清洁 0 扰客",    "HOT"),
    ("仓库.jpg",     "物流仓储",    "大面积地面油污清除",     None),
    ("地下车库.jpg", "地下车库",    "油污尘垢一次去除",       None),
    ("工厂车间.jpg", "工厂车间",    "生产线间快速穿行",       None),
    ("酒店大堂.jpg", "酒店大堂",    "≤68dB 静音不扰客",       None),
]

# ── 在 Path 对象状态下做存在性检查,再转 URI ──────────
scene_items = []
missing_imgs = []
for filename, name, desc, tag in scene_raw:
    p = SCENE_BANK / filename
    if not p.exists():
        missing_imgs.append(str(p))
        continue
    item = {"name": name, "image_url": p.as_uri(), "desc": desc}
    if tag:
        item["tag"] = tag
    scene_items.append(item)

if missing_imgs:
    print("[FATAL] 场景图缺失:")
    for m in missing_imgs:
        print(f"  - {m}")
    sys.exit(1)

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "APPLICATION SCENARIOS",
    "title_prefix":       "",
    "title_main":         "多场景适用",
    "subtitle":           "DZ50X · 大空间商用硬地全覆盖",

    "grid_columns":       "1fr 1fr",  # 2 列 × 3 行

    "scene_items":        scene_items,
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

temp_html = OUT_DIR / "_scene_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
print(f"[compose] 场景数: {len(scene_items)}")

# ── 截图 ──────────────────────────────────────────────
out_png = OUT_DIR / "scene.png"
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
    page.wait_for_timeout(250)
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
print(f"[compose] ✅ scene 合成完成 {elapsed:.2f}s")
print(f"  输出: {out_png}")
print(f"  尺寸: {img.width} × {img.height} (2x scale)")
print(f"  大小: {size_kb:.1f} KB")
print(f"  均值像素: {img.resize((1, 1)).getpixel((0, 0))}")
