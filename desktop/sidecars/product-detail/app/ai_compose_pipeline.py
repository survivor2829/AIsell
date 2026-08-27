"""
AI 合成管线 · 可复用模块(阶段三抽取自 build_long_image.py)

核心 API:
  compose_detail_page(ctxs, order, out_dir, ...) → dict
    一站式:渲染 + 拼接 → 返回 {segments, jpg, width, height, ...}

  render_screens(ctxs, order, out_dir, ...) → list[dict]
    只渲染,不拼接(debug/单屏重渲用)

  stitch_to_files(segments, out_png, out_jpg, ...) → dict
    只拼接,不渲染(素材复用 / 顺序换位再拼)

设计原则:
- 无副作用:函数只写指定 out_dir,不碰其他目录
- 注册表单一源:`_registry.json` 决定每屏 canvas/模板/必填
- 复用 Chromium:render_screens 内部只启动 1 次,所有屏复用同 page
"""
import json
import os
import time
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from PIL import Image
from playwright.sync_api import sync_playwright
from browser_runtime import launch_chromium


RESOURCE_BASE = Path(
    os.environ.get("XIAOXI_PRODUCT_DETAIL_RESOURCE_DIR", Path(__file__).parent)
).resolve()
BASE = Path(
    os.environ.get("XIAOXI_PRODUCT_DETAIL_DATA_DIR", RESOURCE_BASE)
).resolve()

# 一次 re.sub 替代 6 次 str.replace, 同时覆盖 src=" / src=' / href=" 三种 + 两个前缀.
# 紧急3 UPLOAD_DIR 迁移后 /uploads/ 磁盘实际在 /app/static/uploads/
import re as _re
_BASE_URL = str(BASE).replace("\\", "/")
_PLAYWRIGHT_URL_RE = _re.compile(r'''(src|href)=(["'])/(static/|uploads/)''')
def _playwright_url_sub(m):
    attr, quote, prefix = m.group(1), m.group(2), m.group(3)
    disk = "static/uploads/" if prefix == "uploads/" else "static/"
    return f'{attr}={quote}file:///{_BASE_URL}/{disk}'
TPL_DIR = RESOURCE_BASE / "templates" / "ai_compose"
DEFAULT_REGISTRY_PATH = TPL_DIR / "_registry.json"

DEFAULT_ORDER = ["hero", "effect", "advantages", "vs", "scene", "brand", "specs", "cta"]
# 顺序逻辑(详情页心智):钩子→实景→优势→对比→场景→品牌→详细参数→CTA

_ENV = Environment(
    loader=FileSystemLoader(str(TPL_DIR)),
    autoescape=select_autoescape(["html"]),
)


def load_registry(path: Path | None = None) -> dict:
    p = path or DEFAULT_REGISTRY_PATH
    return json.loads(p.read_text(encoding="utf-8"))


def _render_one(page, env, registry, screen_type, ctx, out_dir):
    """单屏渲染(内部用),返回 (png_path, w, h)
    canvas 尺寸优先级:ctx 显式传入 > registry 默认值
    Why: 让 advantages/vs 这类"按数据项数撑版"的屏能按 ctx['canvas_height'] 动态撑版,
         registry 回退到默认值,两边都不用改。
    """
    meta = registry[screen_type]
    cw_reg, ch_reg = meta["canvas"]
    template = meta["template"]

    full_ctx = dict(ctx)
    # ctx 胜出,registry 兜底(允许数据驱动的动态尺寸)
    cw = int(full_ctx.get("canvas_width") or cw_reg)
    ch = int(full_ctx.get("canvas_height") or ch_reg)
    full_ctx["canvas_width"] = cw
    full_ctx["canvas_height"] = ch

    # 必填字段校验(None 和 "" 都视为缺失)
    missing = [k for k in meta["required_keys"]
               if k not in full_ctx or full_ctx[k] in (None, "")]
    if missing:
        raise ValueError(f"{screen_type}: 缺少必填字段 {missing}")

    html = env.get_template(template).render(**full_ctx)
    # URL → file:// for Playwright (同 batch_processor._render_product_preview,
    # 紧急3 f613dd2 孪生漏洞 A2). /uploads/ 磁盘在 static/uploads/.
    html = _PLAYWRIGHT_URL_RE.sub(_playwright_url_sub, html)
    tmp = out_dir / f"_{screen_type}_render.html"
    tmp.write_text(html, encoding="utf-8")

    out_png = out_dir / f"{screen_type}.png"
    page.set_viewport_size({"width": cw, "height": ch})
    page.goto(tmp.as_uri(), wait_until="networkidle", timeout=20000)
    page.wait_for_timeout(200)
    page.screenshot(
        path=str(out_png),
        clip={"x": 0, "y": 0, "width": cw, "height": ch},
    )
    return out_png, cw, ch


def render_screens(ctxs: dict, order: list[str], out_dir: Path,
                   registry: dict | None = None,
                   tpl_dir: Path | None = None,
                   verbose: bool = False) -> list[dict]:
    """
    按 order 渲染 ctxs 中的屏幕,返回 segments 列表。

    参数:
      ctxs:     {screen_type: ctx_dict}
      order:    [screen_type, ...]  — 只有同时在 ctxs 和 registry 里的会渲染
      out_dir:  输出目录,会自动创建
      verbose:  是否打印每屏进度

    返回:
      [{"type", "png", "w", "h", "elapsed"}, ...]
    """
    out_dir = Path(out_dir).resolve()  # 必须绝对路径,Playwright tmp.as_uri() 才能工作
    out_dir.mkdir(parents=True, exist_ok=True)
    registry = registry or load_registry()

    if tpl_dir is not None and Path(tpl_dir) != TPL_DIR:
        env = Environment(
            loader=FileSystemLoader(str(tpl_dir)),
            autoescape=select_autoescape(["html"]),
        )
    else:
        env = _ENV

    segments = []
    with sync_playwright() as pw:
        browser = launch_chromium(
            pw,
            args=["--allow-file-access-from-files"],
        )
        page = browser.new_page(device_scale_factor=2)

        try:
            for screen_type in order:
                if screen_type not in ctxs:
                    if verbose:
                        print(f"  [SKIP] {screen_type}: ctxs 里无此屏")
                    continue
                if screen_type not in registry:
                    if verbose:
                        print(f"  [SKIP] {screen_type}: 注册表无此屏")
                    continue
                t0 = time.time()
                out_png, cw, ch = _render_one(
                    page, env, registry, screen_type,
                    ctxs[screen_type], out_dir,
                )
                elapsed = time.time() - t0
                segments.append({
                    "type": screen_type, "png": str(out_png),
                    "w": cw, "h": ch, "elapsed": elapsed,
                })
                if verbose:
                    print(f"  ✅ {screen_type:12s} {cw}×{ch}  {elapsed:.2f}s")
        finally:
            browser.close()

    return segments


def stitch_to_files(segments: list[dict],
                    out_png: Path | None = None,
                    out_jpg: Path | None = None,
                    jpg_quality: int = 90) -> dict:
    """
    垂直拼接 segments 的 PNG,可选输出 PNG 和/或 JPEG。至少需要一个输出。

    返回:
      {"width", "height", "png"?, "png_bytes"?, "jpg"?, "jpg_bytes"?}
    """
    if not (out_png or out_jpg):
        raise ValueError("out_png 和 out_jpg 至少需要一个")
    if not segments:
        raise ValueError("segments 为空,无法拼接")

    imgs = [Image.open(s["png"]) for s in segments]
    W = max(im.width for im in imgs)
    H = sum(im.height for im in imgs)

    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    y = 0
    for im in imgs:
        x = (W - im.width) // 2  # 宽度不同时居中
        if im.mode == "RGBA":
            canvas.paste(im, (x, y), im)
        else:
            canvas.paste(im, (x, y))
        y += im.height

    result = {"width": W, "height": H}
    if out_png:
        out_png = Path(out_png)
        canvas.save(out_png, "PNG", optimize=True)
        result["png"] = str(out_png)
        result["png_bytes"] = out_png.stat().st_size
    if out_jpg:
        out_jpg = Path(out_jpg)
        canvas.save(out_jpg, "JPEG",
                    quality=jpg_quality, optimize=True, progressive=True)
        result["jpg"] = str(out_jpg)
        result["jpg_bytes"] = out_jpg.stat().st_size
    return result


def compose_detail_page(ctxs: dict, order: list[str], out_dir: Path,
                        out_jpg_name: str = "long.jpg",
                        out_png_name: str | None = None,
                        jpg_quality: int = 90,
                        registry: dict | None = None,
                        verbose: bool = False) -> dict:
    """
    一站式:渲染 7 屏 + 垂直拼接。

    参数:
      ctxs:         {screen_type: ctx_dict}
      order:        屏顺序(list),可用 DEFAULT_ORDER
      out_dir:      输出目录(png 片段 + long 文件都落这里)
      out_jpg_name: 交付 JPEG 文件名(默认 "long.jpg")
      out_png_name: 档案 PNG 文件名,None=不输出 PNG(生产推荐,省 ~20s)

    返回:
      {
        "segments":       [{type, png, w, h, elapsed}, ...],
        "render_elapsed": float,  # 渲染耗时
        "stitch_elapsed": float,  # 拼接耗时
        "total_elapsed":  float,
        "width": int, "height": int,
        "jpg": str, "jpg_bytes": int,
        "png"?: str, "png_bytes"?: int,
      }
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    t_render0 = time.time()
    segments = render_screens(ctxs, order, out_dir,
                              registry=registry, verbose=verbose)
    if not segments:
        raise ValueError("渲染完成但 segments 为空 — 检查 ctxs/order 是否匹配")
    t_render = time.time() - t_render0

    t_stitch0 = time.time()
    out_png = (out_dir / out_png_name) if out_png_name else None
    out_jpg = out_dir / out_jpg_name
    stitch = stitch_to_files(
        segments, out_png=out_png, out_jpg=out_jpg, jpg_quality=jpg_quality,
    )
    t_stitch = time.time() - t_stitch0

    return {
        "segments":       segments,
        "render_elapsed": round(t_render, 2),
        "stitch_elapsed": round(t_stitch, 2),
        "total_elapsed":  round(t_render + t_stitch, 2),
        **stitch,
    }
