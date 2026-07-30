"""
AI 背景图缓存层 — v2 HTML 合成管线专用

两种模式(环境变量 AI_BG_MODE 控制):
  - cache    (默认/开发/测试):  同 (theme_id, screen_type, product_category) 24h 内复用
                                不重复烧 Seedream API
  - realtime (生产/面向客户):   每次都实时调 Seedream 生成全新背景
                                忽略缓存文件的存在

失败降级:
  API 未配置 / 调用超时 / 下载失败 → 返回空字符串 bg_url
  → 模板 {% if bg_url %}...{% else %}<CSS 渐变>{% endif %} 自动走兜底

屏级策略(SCREENS_NEEDING_BG):
  需要 AI 背景的 6 屏: hero / advantages / specs / vs / scene / brand
  主动排除 1 屏: cta
    原因: cta.html 已有精心设计的 3 层渐变 + 左下金晕 + 右上聚光
          AI 背景会破坏这套品牌色视觉,留 CSS 渐变效果更好
"""
from __future__ import annotations

import base64
import hashlib
import mimetypes
import os
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Iterable

import ai_image_router as _router  # 2026-05-13: 走统一引擎路由层 (豆包/通义/gpt-image-2/nano-banana)
import prompt_templates


def _engine() -> str:
    """挑当前生效的图像引擎 (env BG_IMAGE_ENGINE > router DEFAULT_ENGINE).
    想换成 gpt-image-2: export BG_IMAGE_ENGINE=gpt-image-2 即可, 0 代码改动."""
    return os.environ.get("BG_IMAGE_ENGINE", "").strip() or _router.DEFAULT_ENGINE


def _wrap_legacy_key(engine: str, legacy_api_key: str) -> dict:
    """旧调用方传单 api_key str, 包装成 router 的 api_keys dict.
    如 legacy key 跟当前 engine 不匹配, dict 为空 → router 走 env fallback."""
    if not legacy_api_key:
        return {}
    field = _router.ENGINES.get(engine, {}).get("key_field", "")
    return {field: legacy_api_key} if field else {}


# ── 参考图工具 ──────────────────────────────────────────────

def _to_data_url(local_path_or_url: str) -> str:
    """
    把本地图片路径转成 data:image/<mime>;base64,... 字符串。

    - 输入是 /static/uploads/xxx.png 或 C:\\...\\xxx.png 等绝对/相对路径。
    - 根据文件扩展名用 mimetypes.guess_type 判 mime，默认 image/png。
    - 文件不存在或读取失败 → 返回 ""（上层走纯文生图，不报错）。
    - 不处理 http(s):// URL，原样返回（调用方已是 data URL 时也原样返回）。
    """
    if not local_path_or_url:
        return ""
    # 已经是 data URL 或远程 URL，直接透传
    if local_path_or_url.startswith("data:") or local_path_or_url.startswith("http"):
        return local_path_or_url

    path = Path(local_path_or_url)
    # 相对路径：以 BASE_DIR 为基准解析（如 /static/uploads/xxx.png）
    if not path.is_absolute():
        # 去掉开头的 /，再拼 BASE_DIR
        rel = local_path_or_url.lstrip("/\\")
        path = BASE_DIR / rel

    try:
        raw = path.read_bytes()
    except Exception as e:
        print(f"[bg] _to_data_url 读取失败 {path}: {e}")
        return ""

    mime, _ = mimetypes.guess_type(path.name)
    if not mime:
        mime = "image/png"

    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"


# ── 常量 ─────────────────────────────────────────────────────

BASE_DIR = Path(__file__).parent
CACHE_DIR = BASE_DIR / "static" / "cache" / "ai_bg"

PROMPT_VERSION = "v2-prompt-lib"  # 切到 prompt_templates 6 维实景 prompt(强制旧缓存失效)
CACHE_TTL_SECONDS = 24 * 3600    # cache 模式的文件新鲜期(24h)

SCREENS_NEEDING_BG = ("hero", "advantages", "specs", "vs", "scene", "brand")

# 每屏的 Seedream 生图尺寸(会被 _pick_seedream_size 映射到最接近的支持尺寸)
# 按模板 canvas 宽高比选,不必精确匹配 — CSS background-size: cover 会托底
_SCREEN_CANVAS: dict[str, tuple[int, int]] = {
    "hero":       (768, 1024),
    "advantages": (768, 960),
    "specs":      (768, 832),
    "vs":         (768, 960),
    "scene":      (768, 832),
    "brand":      (768, 768),
}


# ── 模式解析 ────────────────────────────────────────────────

def get_mode() -> str:
    """
    永久 realtime 模式 — 不走磁盘缓存,每次调 Doubao API 新生成。

    Why: 用户明确要求"每次都是盲盒",避免重复生成的模板感。
         测试 & 生产都走 realtime,不再提供 cache 模式。
    How to apply: 任何场景都返回 "realtime",完全忽略 AI_BG_MODE 环境变量。
                  旧 cache 分支在 _generate_one 里保留但不会被触发。
    """
    return "realtime"


def _cache_key(theme_id: str, screen: str, category: str,
               product_name: str = "", variant: str = "") -> str:
    """
    缓存 key 要把"能决定背景视觉差异的轴"都混入:
      theme_id   — 主题色调决定
      screen     — 屏别(hero/specs/...)决定构图
      variant    — 风格包变体(showroom/factory/...)决定场景
      category   — 品类(驾驶式洗地机/扫地机/...)决定主体语义
      product_name — 型号(DZ50X/DZ60X/...)决定具体产品;不加 → 同品类所有型号串包
      PROMPT_VERSION — 提示词版本,改版时自动让旧缓存失效
    """
    raw = f"{theme_id}|{screen}|{variant}|{category}|{product_name}|{PROMPT_VERSION}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _cached_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.png"


def _is_fresh(path: Path) -> bool:
    if not path.exists():
        return False
    return (time.time() - path.stat().st_mtime) < CACHE_TTL_SECONDS


def _to_static_url(path: Path) -> str:
    """把 static/cache/ai_bg/xxx.png 绝对路径转成 /static/cache/ai_bg/xxx.png"""
    rel = path.relative_to(BASE_DIR)
    return "/" + rel.as_posix()


# ── Prompt 构造 ─────────────────────────────────────────────

def _build_prompt(theme_id: str, screen: str, category: str,
                  prev_screen: str | None,
                  next_screen: str | None,
                  variant: str = "",
                  prev_variant: str = "",
                  next_variant: str = "") -> tuple[str, str]:
    """
    v2 实景 prompt — 走 prompt_templates 的 6 维散文 prompt + 强 negative。

    返回 (prompt, negative_prompt),由调用方分别传给 Seedream。
    product_hint 用 category(如"驾驶式洗地机")让 hero 等屏的环境带语境。
    variant: 场景变体名(如 showroom/mall_corridor/...),来自 prompt_templates.DEFAULT_VARIANTS_MAP。
    传 "" → 走 DEFAULT_VARIANT。

    prev_variant/next_variant: 邻屏实际的 variant。
    必须传下去,_transition_hint 才能按真实邻屏 palette 拼接缝描述。
    不传 → 回退 DEFAULT,六图串联时会出现可见色带(本 bug 要解决的正是这个)。

    Why: 旧实现拼了一段抽象色调描述(theme_color_flows.bg_tone) +
         vol.prompt_* 函数,出来的图全是色块/渐变;新 prompt_templates
         给的是 cinematic 实景描述(showroom/transport_hub/...) + 强 negative,
         能拉到设计师级摄影质感。
    """
    prompt = prompt_templates.build_prompt(
        screen_type=screen,
        variant=variant or None,  # None → 走 DEFAULT_VARIANT(showroom/mall_corridor/...)
        theme_id=theme_id,
        prev_screen=prev_screen,
        next_screen=next_screen,
        product_hint=category or "",
        prev_variant=prev_variant or None,
        next_variant=next_variant or None,
    )
    return prompt, prompt_templates.NEGATIVE_PROMPT


# ── 单屏生成 ────────────────────────────────────────────────

def _generate_one(theme_id: str, screen: str, category: str,
                  brand: str, api_key: str, mode: str,
                  product_name: str = "",
                  prev_screen: str | None = None,
                  next_screen: str | None = None,
                  reference_image_url: str = "",
                  variant: str = "",
                  prev_variant: str = "",
                  next_variant: str = "") -> str:
    """
    单屏生成入口 — 根据 mode 决定走缓存或实时调 API。
    返回 /static/cache/ai_bg/<key>.png(成功)或 ""(失败 → 模板兜底)

    prev_screen/next_screen 由 generate_backgrounds 按 screens 顺序算好,
    传给 prompt_templates 拼"边缘融合提示"(seamless gradient, no seam)。

    reference_image_url: 可选参考图路径或 data URL。
                         传空字符串(默认) → 纯文生图,行为与原来完全一致。
    variant: 场景变体名(如 showroom/mall_corridor/...)，影响 prompt 和缓存 key。
    """
    key = _cache_key(theme_id, screen, category, product_name, variant)
    path = _cached_path(key)

    # cache 模式且缓存新鲜 → 直接复用
    if mode == "cache" and _is_fresh(path):
        print(f"[bg] HIT   {screen:11s} → {path.name}")
        return _to_static_url(path)

    prompt, negative = _build_prompt(theme_id, screen, category,
                                     prev_screen, next_screen, variant,
                                     prev_variant, next_variant)
    w, h = _SCREEN_CANVAS.get(screen, (768, 1024))

    # 参考图：把本地路径转成 data URL（已是 data URL 或 http URL 则原样透传）
    ref_data_url = _to_data_url(reference_image_url) if reference_image_url else ""
    if ref_data_url:
        print(f"[bg] REF   {screen:11s} → 用参考图生成 (data_url len={len(ref_data_url)})")

    try:
        engine = _engine()
        api_keys = _wrap_legacy_key(engine, api_key)
        urls = _router.generate_segment(engine, screen, prompt, api_keys,
                                        width=w, height=h,
                                        negative_prompt=negative,
                                        reference_image_url=ref_data_url)
        if not urls:
            print(f"[bg] EMPTY {screen:11s} {engine} 返回空 URL 列表")
            return ""

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # 走 router; 各引擎 download_image 实现各异 (seedream 清代理, apimart 直下)
        local = _router.download_image(engine, urls[0], CACHE_DIR, filename=f"{key}.png")
        if not local or not Path(local).exists():
            print(f"[bg] DLFAIL {screen:11s} 下载失败")
            return ""

        tag = "NEW  " if mode == "realtime" else "MISS "
        print(f"[bg] {tag} {screen:11s} → {path.name}")
        return _to_static_url(path)

    except Exception as e:
        print(f"[bg] ERROR {screen:11s} 生成失败: {e}")
        traceback.print_exc()
        return ""


# ── 批量并发生成 ────────────────────────────────────────────

def generate_backgrounds(theme_id: str,
                         product_category: str,
                         brand: str = "",
                         api_key: str = "",
                         screens: Iterable[str] = SCREENS_NEEDING_BG,
                         product_name: str = "",
                         reference_image_url: str = "",
                         ) -> Dict[str, str]:
    """
    并发生成 N 屏背景图。返回 {screen_type: bg_url 或 ""}。

    注意: 这里不抛异常,任何单屏失败都降级为 "" → 模板走 CSS 兜底。
    这样单点故障不会阻塞整张长图生成。

    product_name 是缓存 key 的一部分(见 _cache_key):
      不传 → 同主题+品类所有产品串用同一张背景(DZ50X 看到 DZ60X 的图)
      传了 → 每个型号各自有独立缓存,避免视觉串包

    reference_image_url: 可选参考图路径或 data URL。
      传空字符串(默认) → 纯文生图,行为与原来完全一致。
      传本地路径(如 /static/uploads/xxx.png)或 data URL →
        每屏调用都带同一张参考图,Seedream 会在风格/色调上向参考图靠拢。
    """
    screens = tuple(screens)
    mode = get_mode()

    # P5.5: 按品类挑 variants — 耗材类走 lab_minimal + warehouse_aisle,
    # 其他品类继续 DEFAULT_VARIANTS_MAP (商场/工厂调性)
    variants_map = prompt_templates.resolve_variants_map(product_category)

    # 没有 API key → 全部走 CSS 兜底,不联网
    engine = _engine()
    if not api_key:
        # 让 router 自己再 fallback env;但如果 caller 显式传空也尊重它走兜底
        meta = _router.ENGINES.get(engine, {})
        env_key = os.environ.get(meta.get("key_env", ""), "").strip()
        if not env_key:
            print(f"[bg] 无 {meta.get('key_env', engine + ' API')} key, 全部 {len(screens)} 屏走 CSS 兜底")
            return {s: "" for s in screens}

    ref_hint = f"  参考图={'有' if reference_image_url else '无'}"
    print(f"[bg] 模式={mode}  主题={theme_id}  品类={product_category or '(空)'}  "
          f"产品={product_name or '(空)'}  并发屏数={len(screens)}{ref_hint}")

    # 计算每屏的相邻屏(供 prompt_templates 拼"边缘融合提示")
    # 顺序就是 screens 的迭代顺序,默认 SCREENS_NEEDING_BG
    screens_list = list(screens)
    prev_map = {s: (screens_list[i - 1] if i > 0 else None)
                for i, s in enumerate(screens_list)}
    next_map = {s: (screens_list[i + 1] if i + 1 < len(screens_list) else None)
                for i, s in enumerate(screens_list)}

    results: Dict[str, str] = {s: "" for s in screens_list}
    # I/O bound,用线程池;Seedream 调用是串行 HTTP,并发可减总时长到接近单屏
    with ThreadPoolExecutor(max_workers=min(len(screens_list), 7)) as pool:
        futures = {
            pool.submit(_generate_one, theme_id, s, product_category,
                        brand, api_key, mode, product_name,
                        prev_map[s], next_map[s],
                        reference_image_url,
                        variants_map.get(s, ""),
                        # 邻屏的实际 variant — 让接缝描述与邻屏真实 palette 一致
                        variants_map.get(prev_map[s], "") if prev_map[s] else "",
                        variants_map.get(next_map[s], "") if next_map[s] else ""): s
            for s in screens_list
        }
        for fut in as_completed(futures):
            s = futures[fut]
            try:
                results[s] = fut.result() or ""
            except Exception as e:
                print(f"[bg] ERROR {s} 未捕获异常: {e}")
                traceback.print_exc()
                results[s] = ""

    hits = sum(1 for v in results.values() if v)
    print(f"[bg] 完成: {hits}/{len(screens)} 屏拿到背景图")
    return results


# ── VS 对比屏"传统人工"参考图 ─────────────────────────────────
#
# 与背景图不同:这是"对照物"语义,需要"每次长得一样"的稳定性。
# 所以:
#   - 不走 AI_BG_MODE (即使设成 realtime 也不重烧)
#   - 不加 theme / variant 变体
#   - 永久磁盘缓存 (force_refresh=True 才重烧)
#   - prompt 固定
#
# Why: 用户反馈"VS 屏要有两张并列图做对照";对照物每次视觉不一样反而削弱对比说服力。

_LABOR_CACHE_FILENAME = "vs_labor.png"

_LABOR_PROMPT = (
    "一位身穿蓝色工作服的中年保洁员,双手握住拖把,"
    "正在商场大堂的光滑地面上推拖把清洁;中景写实摄影,自然顶光,"
    "景深浅,背景是明亮的商场大堂(虚化),1:1 构图,高清,"
    "人物姿态自然,面部清晰,不露商标不露店招,专业摄影"
)

_LABOR_NEGATIVE = (
    "卡通,插画,低质量,模糊,变形,多余手指,水印,文字,商标,"
    "机器人,扫地机器人,洗地机,设备,科技感,未来感"
)

_LABOR_URL_CACHE: str | None = None


def get_labor_reference_image(api_key: str = "", force_refresh: bool = False) -> str:
    """
    返回 VS 对比屏用的"传统人工清洁工"HD 参考图 URL(相对路径)。

    策略:
      - 进程级内存 memo `_LABOR_URL_CACHE`(仅缓存非空结果 → 降级态可重试)
      - 永久磁盘缓存: static/cache/ai_bg/vs_labor.png (除非手动删或 force_refresh=True)
      - 命中缓存 → 直接返回 "/static/cache/ai_bg/vs_labor.png"
      - 未命中 + 有 api_key → 调 Seedream 生成 1:1 高清写实图,下载保存
      - 未命中 + 无 api_key → 返回 "" (模板回退到单图模式)

    复用底层:
      - _router.generate_segment(engine, zone, prompt, api_keys, ...) 返回图片 URL 列表
      - _router.download_image(engine, url, save_dir, filename) 下载到本地
    """
    global _LABOR_URL_CACHE
    if _LABOR_URL_CACHE and not force_refresh:
        return _LABOR_URL_CACHE

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / _LABOR_CACHE_FILENAME

    if cache_path.exists() and not force_refresh:
        url = _to_static_url(cache_path)
        _LABOR_URL_CACHE = url
        return url

    engine = _engine()
    api_keys = _wrap_legacy_key(engine, api_key)
    if not api_key and not api_keys:
        print(f"[labor] 无 {engine} key, 跳过生成, VS 屏走单图")
        return ""

    try:
        urls = _router.generate_segment(
            engine,
            "vs_labor",
            _LABOR_PROMPT,
            api_keys,
            width=1024,
            height=1024,
            negative_prompt=_LABOR_NEGATIVE,
        )
        if not urls:
            print(f"[labor] {engine} 返回空 URL 列表")
            return ""

        local = _router.download_image(engine, urls[0], CACHE_DIR, filename=_LABOR_CACHE_FILENAME)
        if not local or not Path(local).exists():
            print("[labor] 下载失败")
            return ""

        print(f"[labor] 生成并缓存 → {cache_path}")
        url = _to_static_url(cache_path)
        _LABOR_URL_CACHE = url
        return url

    except Exception as e:
        print(f"[labor] ERROR: {e}")
        traceback.print_exc()
        return ""
