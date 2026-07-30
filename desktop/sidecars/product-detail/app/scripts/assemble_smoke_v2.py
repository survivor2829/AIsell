"""AI 精修 v2 端到端拼接 · smoke_output_v2 的 6 张 AI 图 → assembled.html + PNG.

复用 v1 Seedream 的 Jinja 拼接层 (templates/设备类/assembled.html).
最简策略:
  - block_a.cover_image  = AI hero (block_01)
  - fixed_selling_images = [AI block_02 .. block_06]
  - 其它 block 全空 → Jinja if 护栏跳过
  → 详情页 = Hero + 5 张全宽 AI 图, 共 6 屏

跑法:
  python scripts/assemble_smoke_v2.py            # 只出 HTML
  python scripts/assemble_smoke_v2.py --png      # 加导出 PNG (Playwright)

产物:
  smoke_output_v2/assembled.html                 # 浏览器打开看
  smoke_output_v2/assembled.png                  # 导出 PNG (若 --png)

前置:
  smoke_output_v2/ 里要有 _summary.json + _planning.json + 6 张 block_*.jpg
  (先跑过 scripts/smoke_test_refine_v2.py)
"""
from __future__ import annotations
import argparse
import json
import shutil
import sys
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO_ROOT))

# 延迟 import Flask, 让无 Flask 时也能 --help
SMOKE_DIR = _REPO_ROOT / "smoke_output_v2"
STATIC_COPY_DIR = _REPO_ROOT / "static" / "smoke_output_v2"


def _copy_ai_images_to_static() -> int:
    """把 smoke_output_v2/block_*.jpg 复制到 static/smoke_output_v2/.

    Why: assembled.html 里 <img src="/static/..."> 必须能被 Flask 或浏览器 file:// 解析到.
    """
    STATIC_COPY_DIR.mkdir(parents=True, exist_ok=True)
    count = 0
    for jp in sorted(SMOKE_DIR.glob("block_*.jpg")):
        dst = STATIC_COPY_DIR / jp.name
        shutil.copy2(jp, dst)
        count += 1
    print(f"[copy] {count} 张 AI 图 → {STATIC_COPY_DIR.relative_to(_REPO_ROOT)}")
    return count


def _build_data() -> dict:
    """从 smoke_output_v2/_summary.json + _planning.json 构造 Jinja context."""
    summary_path = SMOKE_DIR / "_summary.json"
    planning_path = SMOKE_DIR / "_planning.json"
    if not summary_path.is_file():
        raise RuntimeError(f"缺 {summary_path}. 先跑 smoke_test_refine_v2.py")
    if not planning_path.is_file():
        raise RuntimeError(f"缺 {planning_path}. 先跑 smoke_test_refine_v2.py")

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    planning = json.loads(planning_path.read_text(encoding="utf-8"))

    blocks = summary.get("blocks") or []
    if len(blocks) < 1:
        raise RuntimeError("_summary.json 里 blocks 为空, 无图可拼")

    # Hero = 第 1 张
    hero_file = blocks[0]["file"]
    hero_url = f"/static/smoke_output_v2/{hero_file}"

    # 其它 → fixed_selling_images (全宽贴图)
    fixed_selling_images = [
        f"/static/smoke_output_v2/{b['file']}" for b in blocks[1:]
    ]

    pm = planning.get("product_meta") or {}

    # block_a cover_image 模式: 传 cover_image, 其它字段即便填了也不显示 (block_a_hero.html:24)
    # 但保留 category_line / brand_text / model_name 作为 fallback, 以防未来改模板
    block_a = {
        "brand_text": "小玺 AI",
        "model_name": "DZ600M",
        "category_line": pm.get("name", "DZ600M 无人水面清洁机"),
        "main_title": "",
        "cover_image": hero_url,
        "show_hero_params": False,
        "params": [],
    }

    data = {
        "product_type": "设备类",
        "block_a": block_a,
        "block_b2": {},   # 跳过 (无 items)
        "block_b3": {},   # 跳过
        "block_f": {},    # 跳过 (无 title_line1)
        "block_e": {},    # 跳过 (无 specs + 无 product_image)
        "fixed_selling_images": fixed_selling_images,
        "effect_image": "",
        "export_mode": True,  # 去掉顶部 export 栏
        "hero_block_template": "blocks/block_a_hero_robot_cover.html",
        "spec_block_template": "blocks/block_e_glass_dimension.html",
    }
    return data


def _render_html(data: dict) -> str:
    """Flask 最小应用渲染 Jinja. 注入假 csrf_token 避免 global 缺失."""
    from flask import Flask, render_template

    app = Flask(
        __name__,
        template_folder=str(_REPO_ROOT / "templates"),
        static_folder=str(_REPO_ROOT / "static"),
    )
    app.config["SECRET_KEY"] = "smoke-assemble-stub"
    # assembled_base.html 里引用了 csrf_token()(export_mode=True 时走不到,
    # 但 Jinja compile 仍需 global 可调用), 注入占位函数避免解析异常.
    app.jinja_env.globals.setdefault("csrf_token", lambda: "stub-csrf")

    with app.app_context(), app.test_request_context():
        return render_template("设备类/assembled.html", **data)


def _rewrite_static_urls_to_file(html: str) -> str:
    """把 src="/static/..." 替换成 src="file:///<repo>/static/..." .

    Why: 离线打开 HTML 或 Playwright 截图时, /static/ 绝对路径解析不了.
    替换成 file:// URL 后, 浏览器和 Playwright 都能直接读到本地文件.
    """
    base_url = str(_REPO_ROOT).replace("\\", "/")
    html = html.replace('src="/static/', f'src="file:///{base_url}/static/')
    html = html.replace("src='/static/", f"src='file:///{base_url}/static/")
    return html


def _export_png(html_path: Path, png_path: Path):
    """Playwright 全页截图 · 750px 宽 · DPR=2 高清 (跟 v1 导出一致)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            args=[
                "--no-sandbox",
                "--disable-web-security",
                "--allow-file-access-from-files",
            ]
        )
        ctx = browser.new_context(
            viewport={"width": 750, "height": 900},
            device_scale_factor=2,
        )
        page = ctx.new_page()
        page.goto(html_path.as_uri(), wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path=str(png_path), full_page=True)
        browser.close()
    size_kb = png_path.stat().st_size // 1024
    print(f"[png] {png_path.relative_to(_REPO_ROOT)} ({size_kb}KB)")


def main() -> int:
    ap = argparse.ArgumentParser(description="AI 精修 v2 端到端拼接")
    ap.add_argument("--png", action="store_true",
                    help="加 Playwright 导出 PNG (~30s, 需 Chromium)")
    args = ap.parse_args()

    print("=" * 66)
    print("AI 精修 v2 端到端拼接 · DZ600M")
    print("=" * 66)

    # 预检
    if not (SMOKE_DIR / "_summary.json").is_file():
        print(f"[FAIL] {SMOKE_DIR}/_summary.json 不存在")
        print("       先跑: python scripts/smoke_test_refine_v2.py")
        return 1

    # Step 1: 复制 AI 图到 static (Flask/浏览器可 serve)
    _copy_ai_images_to_static()

    # Step 2: 构造数据
    data = _build_data()
    print(f"[data] Hero: {data['block_a']['cover_image']}")
    print(f"[data] 5 张 fixed_selling_images:")
    for u in data["fixed_selling_images"]:
        print(f"       - {u}")

    # Step 3: 渲染 Jinja
    html = _render_html(data)
    html = _rewrite_static_urls_to_file(html)

    # Step 4: 保存 HTML
    out_html = SMOKE_DIR / "assembled.html"
    out_html.write_text(html, encoding="utf-8")
    size_kb = len(html.encode("utf-8")) // 1024
    print(f"[html] {out_html.relative_to(_REPO_ROOT)} ({size_kb}KB)")
    print(f"[open] file:///{out_html.as_posix()}")

    # Step 5: 可选 PNG
    if args.png:
        out_png = SMOKE_DIR / "assembled.png"
        print(f"\n[png] Playwright 截图中 ...")
        try:
            _export_png(out_html, out_png)
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"[png WARN] Playwright 失败, 但 HTML 已生成: {e}")
            return 2

    print("=" * 66)
    print("[DONE]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
