"""
AI 合成管线 · 阶段一:vs 对比屏 HTML 合成测试

从 _registry.json 读取屏幕元数据;ctx 全 JSON 驱动。
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
meta = REGISTRY["vs"]
CANVAS_W, CANVAS_H = meta["canvas"]
TEMPLATE_NAME = meta["template"]
print(f"[registry] vs -> {TEMPLATE_NAME} {CANVAS_W}x{CANVAS_H}")

# ── 素材 ──────────────────────────────────────────────
BG_PATH = BASE / "output" / "prompt_test_v2" / "segments" / "vs.png"
missing = [str(p) for p in (BG_PATH, TPL_DIR / TEMPLATE_NAME) if not p.exists()]
if missing:
    print("[FATAL] 素材缺失:")
    for m in missing:
        print(f"  - {m}")
    sys.exit(1)

# ── 对比数据:传统人工 vs DZ50X ──────────────────────
compare_items = [
    {
        "label":       "人力投入",
        "left_value":  "8 人",    "left_desc":  "多人协同作业",
        "right_value": "1 人",    "right_desc": "驾驶即可完成",
    },
    {
        "label":       "清扫效率",
        "left_value":  "300 ㎡/h", "left_desc":  "人工拖地速度",
        "right_value": "3600 ㎡/h","right_desc": "12 倍提效",
    },
    {
        "label":       "作业时间",
        "left_value":  "8 小时/天","left_desc":  "白天为主",
        "right_value": "24 小时",  "right_desc": "全时段可用",
    },
    {
        "label":       "月度成本",
        "left_value":  "¥ 8000+", "left_desc":  "单人月薪起",
        "right_value": "¥ 0",     "right_desc": "设备摊销后",
    },
    {
        "label":       "清洁标准",
        "left_value":  "参差不齐", "left_desc":  "依赖人员状态",
        "right_value": "恒定一致", "right_desc": "每次完全一致",
    },
]

# ── 底部总结条:年化节省 + 回本周期 ──────────────────
summary_points = [
    {"num": "¥ 96,000+", "label": "年人力成本节省"},
    {"num": "≤ 3 个月",  "label": "设备投资回收"},
]

ctx = {
    "canvas_width":       CANVAS_W,
    "canvas_height":      CANVAS_H,
    "bg_url":             BG_PATH.as_uri(),

    "theme_primary":      "#E8231A",
    "theme_primary_dark": "#B51A13",
    "theme_accent":       "#FFD166",

    "section_label":      "EFFICIENCY COMPARISON",
    "title_prefix":       "1 台顶 ",
    "title_main":         "8 人",
    "subtitle":           "DZ50X · 以一当八的效率革命",

    "left_label":    "传统人工保洁",
    "left_sublabel": "Traditional Cleaning",
    "left_icon":     "👷",

    "right_label":    "DZ50X 驾驶式",
    "right_sublabel": "Smart Equipment",
    "right_icon":     "🤖",

    "compare_items":  compare_items,
    "summary_points": summary_points,
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

temp_html = OUT_DIR / "_vs_render.html"
temp_html.write_text(html, encoding="utf-8")
print(f"[compose] 临时 HTML: {temp_html} ({len(html)} chars)")
print(f"[compose] 背景: {BG_PATH}")

# ── 截图 ──────────────────────────────────────────────
out_png = OUT_DIR / "vs.png"
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
print(f"[compose] ✅ vs 合成完成 {elapsed:.2f}s")
print(f"  输出: {out_png}")
print(f"  尺寸: {img.width} × {img.height} (2x scale)")
print(f"  大小: {size_kb:.1f} KB")
print(f"  均值像素: {img.resize((1, 1)).getpixel((0, 0))}")
