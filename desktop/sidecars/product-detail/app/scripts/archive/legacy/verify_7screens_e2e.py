"""
端到端 7 屏验证器 — 审计修复后的视觉确认

产物(output/debug/<mode>/):
  hero.png / advantages.png / specs.png / vs.png / scene.png / brand.png / cta.png
  long.jpg                  — 垂直拼接的长图
  ctx_dump.json             — 每屏 ctx 快照(供人工比对)

两种模式,一次跑完:
  A) no_product   — 不传 product_image,验证 hero/specs 的占位兜底
  B) with_product — 传 ref_dz50x_cover.png,验证正常渲染

每屏硬校验(会抛 ValueError 的必填字段):
  hero.main_title / advantages.advantages / specs.specs /
  vs.compare_items / scene.scene_items / brand.brand_name / cta.cta_main

用途:跑完看截图,逐屏检查下列修复点是否生效 ——
  [Hero]  • product_url 空 → 圆形 📷 占位框(不再空白)
          • subtitle 渲染内容来自 sub_slogan
  [Advantages] • 每张卡片右上角出现"红色大数字+单位"(stat_num/stat_unit)
               • 标题下方 subtitle 非空(来自 sub_slogan 兜底)
  [Specs] • value 和 unit 分离(90 / L, 3600 / ㎡/h, 1.2 / m)
          • 左侧产品图区域:有图走 product-img,无图走占位
          • 右下角 product_badge 显示 DZ50X(model)
  [VS]    • 左右大图标 🤖 / 👤 替换了空白
          • 底部 summary_points 显示"1 顶 8 / 3600㎡/h / ¥ 0"三段
  [Scene] • subtitle 非空
  [Brand] • 品牌名下方副名显示 DZ50X(model 兜底)
  [CTA]   • 没真实电话,展示 BRAND/MODEL/CATEGORY 三张"品牌卡"(不瞎编号码)
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

BASE = Path(__file__).parent
sys.path.insert(0, str(BASE))

# 导入主 app + 共享 demo 数据
import app as app_module  # noqa
from ai_compose_pipeline import compose_detail_page, DEFAULT_ORDER
from test_endpoint_html_parsed import PARSED_DEMO


DEBUG_ROOT = BASE / "output" / "debug"
DEBUG_ROOT.mkdir(parents=True, exist_ok=True)

REF_IMG = "/static/设备类/ref_dz50x_cover.png"


def _prepare_rembg_image() -> str:
    """对参考产品图离线跑一次 rembg,返回 /static/... 形式的透明 PNG URL。

    用意:验证"上传 → 抠图 → 透明底 → 合成"完整链路。
    原图背景+品牌水印 vs 抠后透明底 的视觉差异,在 hero/specs 截图上一目了然。
    """
    src = BASE / REF_IMG.lstrip("/")
    if not src.exists():
        print(f"⚠️ 参考图缺失:{src},跳过抠图模式")
        return ""

    cache_dir = BASE / "static" / "cache" / "rembg_verify"
    cache_dir.mkdir(parents=True, exist_ok=True)
    uid = "verify_" + src.stem
    # 已抠过就直接复用
    existing = cache_dir / f"{uid}_nobg.png"
    if existing.exists():
        print(f"[抠图] 复用已有透明底: {existing.name}")
        return "/" + existing.relative_to(BASE).as_posix()

    # 复制原图到缓存目录(helper 要求文件在 user_dir 下,这里用 cache_dir 冒充)
    import shutil
    copied = cache_dir / f"{uid}.png"
    shutil.copy(src, copied)

    print("\n[抠图] 对参考图首次跑 rembg…(3-8 秒)")
    t0 = time.time()
    with app_module.app.app_context(), app_module.app.test_request_context():
        nobg_name = app_module._remove_bg_if_needed(copied, cache_dir, uid)
    elapsed = time.time() - t0

    if not nobg_name:
        print(f"[抠图] ❌ 失败(rembg 未装或图本就透明),回退原图")
        return REF_IMG

    nobg_path = cache_dir / nobg_name
    print(f"[抠图] ✅ 完成 {elapsed:.1f}s → {nobg_path.name}")
    return "/" + nobg_path.relative_to(BASE).as_posix()


# ── ctx 压缩展示(dump 到 JSON 时保留完整,打印到终端时截断)──────

def _compact(v, maxlen=80):
    if isinstance(v, str):
        return v if len(v) <= maxlen else v[:maxlen] + "…"
    if isinstance(v, list):
        if not v:
            return "[]"
        return f"list[{len(v)}] sample={_compact(v[0], 60)}"
    if isinstance(v, dict):
        keys = list(v.keys())[:6]
        return f"{{{', '.join(keys)}{'...' if len(v) > 6 else ''}}}"
    return repr(v)


def _ctx_summary(screen: str, ctx: dict) -> str:
    lines = [f"    [{screen}]  ({len(ctx)} fields)"]
    for k in sorted(ctx.keys()):
        lines.append(f"      {k:22s} = {_compact(ctx[k])}")
    return "\n".join(lines)


# ── 单模式跑一次 ───────────────────────────────────────────────

def run_one(label: str, product_image: str) -> dict:
    """label 用作子目录名;product_image 可传 '' 触发占位分支"""
    out_dir = DEBUG_ROOT / label
    out_dir.mkdir(parents=True, exist_ok=True)

    print("\n" + "═" * 78)
    print(f"  模式: {label}   product_image = {product_image or '<空 → 走占位>'}")
    print("═" * 78)

    # ── Step A: parsed → ctxs ────────────────────────────────
    # 与 /api/generate-ai-detail-html 保持一致: 每屏 ctx 里的 /static/... 要转 file:// URI
    # 否则 Playwright 通过 file:// 加载 tmp HTML 时,/static/xxx.png 会解析成 file:///static/xxx (404)
    with app_module.app.app_context(), app_module.app.test_request_context():
        raw_ctxs = app_module._build_ctxs_from_parsed(
            PARSED_DEMO, product_image, "classic-red",
        )
        ctxs = {k: app_module._resolve_asset_urls_in_ctx(v)
                for k, v in raw_ctxs.items() if isinstance(v, dict)}

    print(f"\n[A] _build_ctxs_from_parsed → ctxs.keys = {sorted(ctxs.keys())}")
    missing = set(DEFAULT_ORDER) - set(ctxs.keys())
    if missing:
        print(f"    ⚠️ 缺屏: {missing}")
    else:
        print(f"    ✅ 7/7 屏全部就绪")

    # 关键字段探针
    print("\n[B] 关键字段探针(验证 9 项修复)")
    probes = [
        ("hero.product_url",       ctxs.get("hero", {}).get("product_url", "<无此key>")),
        ("hero.subtitle",          ctxs.get("hero", {}).get("subtitle", "")),
        ("advantages.subtitle",    ctxs.get("advantages", {}).get("subtitle", "")),
        ("advantages[0].stat_num", (ctxs.get("advantages", {}).get("advantages") or [{}])[0].get("stat_num", "")),
        ("specs[0].unit",          (ctxs.get("specs", {}).get("specs") or [{}])[0].get("unit", "")),
        ("specs.product_badge",    ctxs.get("specs", {}).get("product_badge", "")),
        ("vs.left_icon",           ctxs.get("vs", {}).get("left_icon", "")),
        ("vs.right_icon",          ctxs.get("vs", {}).get("right_icon", "")),
        ("vs.summary_points",      ctxs.get("vs", {}).get("summary_points", [])),
        ("brand.brand_name_sub",   ctxs.get("brand", {}).get("brand_name_sub", "")),
        ("cta.contacts",           ctxs.get("cta", {}).get("contacts", [])),
        ("cta.cta_sub",            ctxs.get("cta", {}).get("cta_sub", "")),
    ]
    for name, v in probes:
        mark = "✅" if v and v != "<无此key>" else "❌"
        print(f"    {mark} {name:28s} = {_compact(v, 60)}")

    # 写 ctx 快照
    dump_path = out_dir / "ctx_dump.json"
    dump_path.write_text(
        json.dumps(ctxs, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"\n[C] ctx 快照写入: {dump_path}")

    # ── Step D: 渲染 7 屏 + 拼长图 ────────────────────────────
    print("\n[D] compose_detail_page → 渲染 7 屏 + 拼长图")
    t0 = time.time()
    try:
        result = compose_detail_page(
            ctxs, DEFAULT_ORDER, out_dir,
            out_jpg_name="long.jpg",
            out_png_name=None,
            verbose=True,
        )
    except Exception as e:
        print(f"\n❌ 渲染失败: {e}")
        traceback.print_exc()
        return {"ok": False, "error": str(e), "out_dir": out_dir}
    elapsed = time.time() - t0

    # ── Step E: 落盘核对 ────────────────────────────────────
    print(f"\n[E] 耗时 {elapsed:.1f}s · segments = {len(result['segments'])}")
    expected = set(DEFAULT_ORDER)
    rendered = {s["type"] for s in result["segments"]}
    print(f"    期望: {sorted(expected)}")
    print(f"    实际: {sorted(rendered)}")
    if expected != rendered:
        print(f"    ❌ 缺 {expected - rendered}")
    else:
        print(f"    ✅ 7/7 全部渲染成功")

    # 每屏 PNG 大小
    print(f"\n    每屏 PNG 文件:")
    for s in result["segments"]:
        p = Path(s["png"])
        if p.exists():
            kb = p.stat().st_size / 1024
            print(f"      ✅ {s['type']:11s} {s['w']:4}×{s['h']:<4}  {kb:6.1f} KB  → {p.name}")
        else:
            print(f"      ❌ {s['type']:11s} 文件丢失: {p}")

    jpg_path = Path(result["jpg"])
    jpg_mb = jpg_path.stat().st_size / (1024 * 1024)
    print(f"\n    长图: {jpg_path}  ({jpg_mb:.2f} MB, {result['width']}×{result['height']})")

    return {
        "ok": True,
        "out_dir": out_dir,
        "result": result,
        "ctxs": ctxs,
    }


# ── 主入口 ────────────────────────────────────────────────────

def main():
    print("╔" + "═" * 76 + "╗")
    print("║  AI 精修专业版 · 7 屏 E2E 验证(覆盖审计全部 9 项修复 + 占位兜底)".ljust(77) + "║")
    print("╚" + "═" * 76 + "╝")
    print(f"产品数据: {PARSED_DEMO['brand']} / {PARSED_DEMO['product_name']} ({PARSED_DEMO['model']})")
    print(f"输出根目录: {DEBUG_ROOT}")

    # 四种模式一次跑完:
    #   no_product   — 走占位兜底
    #   with_product — 原图(带瓷砖背景+海报文字)直接合成,会穿透
    #   with_rembg   — 对同一原图跑 rembg,测试抠图管线(参考图有海报文字,结果会保留)
    #   clean_nobg   — 用一张真正干净的棚拍透明 PNG,证明"用户上传干净图时管线产出干净"
    no_product      = run_one("no_product",      "")
    with_product    = run_one("with_product",    REF_IMG)

    rembg_url = _prepare_rembg_image()
    with_rembg = run_one("with_rembg", rembg_url) if rembg_url else {"ok": False, "out_dir": "<rembg unavailable>"}

    # 干净棚拍透明 PNG — 已被用户早期上传过时抠过图(无原图水印文字)
    # 这模拟"生产里用户上传干净白底图"的正常路径
    clean_img = "/static/uploads/9bfed720711945f59435edf2e8540c0b_nobg.png"
    clean_nobg = run_one("clean_nobg", clean_img)

    # 汇总
    print("\n" + "═" * 78)
    print("  最终结果汇总")
    print("═" * 78)
    for r in (no_product, with_product, with_rembg, clean_nobg):
        mark = "✅" if r.get("ok") else "❌"
        print(f"  {mark} {r.get('out_dir')}")
    if not (no_product["ok"] and with_product["ok"] and clean_nobg["ok"]):
        sys.exit(1)

    print("\n人工核对清单(打开每屏 PNG 对照):")
    print(f"  · {DEBUG_ROOT / 'no_product' / 'hero.png'}     ← 圆形占位 📷 产品图预览")
    print(f"  · {DEBUG_ROOT / 'no_product' / 'specs.png'}    ← 左列方形占位 📷")
    print(f"  · {DEBUG_ROOT / 'with_product' / 'hero.png'}   ← 原图直合成:背景瓷砖+海报文字穿透")
    print(f"  · {DEBUG_ROOT / 'with_rembg' / 'hero.png'}     ← 抠图:背景去掉,但海报文字贴在前景上仍在")
    print(f"  · {DEBUG_ROOT / 'clean_nobg' / 'hero.png'}     ← ★ 干净棚拍透明 PNG:应完全无重影")
    print(f"  · {DEBUG_ROOT / 'clean_nobg' / 'specs.png'}    ← ★ 干净透明 PNG 进 specs")
    print(f"  · {DEBUG_ROOT / 'clean_nobg' / 'cta.png'}      ← ★ 干净透明 PNG 进 cta")


if __name__ == "__main__":
    main()
