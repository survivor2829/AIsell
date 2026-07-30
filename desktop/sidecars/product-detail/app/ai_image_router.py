"""
AI 生图引擎路由层 — 统一接口, 按 engine 字段分发到任一引擎+通道.

支持引擎 (engine) × 通道 (channel):
  - 通义万相 wanxiang   官方 (阿里云百炼 DashScope)
  - 豆包 Seedream       官方 (字节跳动 火山方舟 Ark)
  - GPT image 2.0       中转站 (APIMart / REFINE_API_BASE_URL)
  - nano banana         中转站 (规划中, 启用前 raise NotImplementedError)

设计原则 (2026-05-13 用户拍板):
  - 所有生图功能 (ai_bg_cache / ai_refine_v2 / 将来的新功能) 走这个统一入口
  - 换引擎只改 env DEFAULT_IMAGE_ENGINE, 不动业务代码
  - prompt/variant 等 "内容层" 由 prompt_templates 等模块管, router 不参与
"""
import os
from pathlib import Path

import ai_image_volcengine       # 豆包 Seedream 4.0 (Ark, 火山官方) — 一般都装了
import ai_image_apimart          # gpt-image-2 / nano banana 等 (APIMart 中转站)
import prompt_templates          # 专业级 prompt 模板库（六维结构化）

# 通义万相依赖 dashscope; prod 镜像若未装则软降级 (引擎标记 unavailable 而非崩溃)
try:
    import ai_image as _ai_wanxiang  # 通义万相 (DashScope, 阿里官方)
    _WANXIANG_AVAILABLE = True
    _WANXIANG_T2I_MODEL = _ai_wanxiang.T2I_MODEL
except ImportError:
    _ai_wanxiang = None  # type: ignore
    _WANXIANG_AVAILABLE = False
    _WANXIANG_T2I_MODEL = "wanx2.1-t2i-turbo"  # 兜底常量,不影响注册


# ── 引擎元数据（前端下拉框可读取）──────────────────────────────
ENGINES = {
    "wanxiang": {
        "id": "wanxiang",
        "label": "通义万相",
        "vendor": "阿里云百炼",
        "channel": "official",
        "model": _WANXIANG_T2I_MODEL,
        "key_env": "DASHSCOPE_API_KEY",
        "key_field": "dashscope_api_key",
        "cost_hint": "约 0.04-0.08 元/张",
        "supports_i2i": False,
    },
    "seedream": {
        "id": "seedream",
        "label": "豆包 Seedream 4.0",
        "vendor": "字节跳动 火山方舟",
        "channel": "official",
        "model": ai_image_volcengine.T2I_MODEL,
        "key_env": "ARK_API_KEY",
        "key_field": "ark_api_key",
        "cost_hint": "约 0.08-0.16 元/张",
        "supports_i2i": True,
    },
    "gpt-image-2": {
        "id": "gpt-image-2",
        "label": "GPT image 2.0",
        "vendor": "OpenAI",
        "channel": "apimart",
        "model": ai_image_apimart.T2I_MODEL,
        "key_env": "REFINE_API_KEY",
        "fallback_key_envs": ("GPT_IMAGE_API_KEY",),
        "key_field": "gpt_image_api_key",
        "cost_hint": "约 0.70 元/张 (thinking=medium)",
        "supports_i2i": True,
    },
    "nano-banana": {
        "id": "nano-banana",
        "label": "nano banana (规划中)",
        "vendor": "Google",
        "channel": "apimart",
        "model": "nano-banana",
        "key_env": "REFINE_API_KEY",  # 中转站共用 key; GPT_IMAGE_API_KEY 兼容 fallback
        "fallback_key_envs": ("GPT_IMAGE_API_KEY",),
        "key_field": "gpt_image_api_key",
        "cost_hint": "TBD",
        "supports_i2i": True,
        "stub": True,  # 启用前 generate_segment 直接 raise NotImplementedError
    },
}

# 默认引擎: env DEFAULT_IMAGE_ENGINE 决定, 否则 seedream
# 想换成 gpt-image-2 就 export DEFAULT_IMAGE_ENGINE=gpt-image-2, 0 代码改动
DEFAULT_ENGINE = os.environ.get("DEFAULT_IMAGE_ENGINE", "seedream").strip() or "seedream"


# ── 专业 prompt 规划 ─────────────────────────────────────────────
# 统一入口：app.py 调本函数拿到每段 prompt，再交给 generate_segment_to_local

def plan_page(theme_id: str,
              zones: list[str] | None = None,
              product_hint: str = "",
              variants: dict[str, str] | None = None) -> list[dict]:
    """
    规划无缝长图的每段 prompt（使用 prompt_templates 的六维模板）。

    返回 list[dict]，每项含：
        zone / variant / height / overlap_bottom / prompt / negative_prompt
    """
    zones = zones or prompt_templates.DEFAULT_VARIANT  # dict → keys iterable
    if isinstance(zones, dict):
        zones = ["hero", "advantages", "specs", "vs", "scene", "brand", "cta"]
    return prompt_templates.get_prompts_for_theme(
        theme_id, zones, variants=variants, product_hint=product_hint
    )


def list_engines() -> list[dict]:
    """返回引擎列表，前端下拉框直接消费"""
    return list(ENGINES.values())


def _resolve_key(engine: str, api_keys: dict) -> str:
    """
    解析 API key：优先 api_keys 字段（请求体传入），其次环境变量。
    api_keys = {"dashscope_api_key": "...", "ark_api_key": "..."}
    """
    meta = ENGINES.get(engine) or ENGINES[DEFAULT_ENGINE]
    key = (api_keys or {}).get(meta["key_field"], "")
    if not key:
        env_vars = (meta["key_env"], *meta.get("fallback_key_envs", ()))
        for env_var in env_vars:
            key = os.environ.get(env_var, "")
            if key:
                break
    return key.strip()


def generate_segment(engine: str, zone: str, prompt: str,
                     api_keys: dict,
                     width: int = 750, height: int = 1334,
                     negative_prompt: str = "",
                     reference_image_url: str = "") -> list[str]:
    """
    统一段生成接口（无缝长图方案）。
    返回 URL 列表（成功时长度 1，失败时空列表）。

    reference_image_url: 可选参考图 (data URL / http URL)。
        传给底层引擎走 image-to-image (颜色 / silhouette 保真)。
        ENGINES[engine].supports_i2i 标了哪些引擎原生支持; 不支持的会被忽略并打 warning。
    """
    engine = engine if engine in ENGINES else DEFAULT_ENGINE
    meta = ENGINES[engine]

    if meta.get("stub"):
        raise NotImplementedError(
            f"引擎 {engine} ({meta['label']}) 尚未接通; 启用前请补 generate_segment 实现"
        )

    key = _resolve_key(engine, api_keys)
    if not key:
        raise ValueError(
            f"缺少 {meta['label']} 的 API Key (env {meta['key_env']} 或请求字段 {meta['key_field']})"
        )

    if engine == "seedream":
        return ai_image_volcengine.generate_segment(zone, prompt, key,
                                                    width=width, height=height,
                                                    negative_prompt=negative_prompt,
                                                    reference_image_url=reference_image_url)
    if engine == "gpt-image-2":
        return ai_image_apimart.generate_segment(zone, prompt, key,
                                                 width=width, height=height,
                                                 negative_prompt=negative_prompt,
                                                 reference_image_url=reference_image_url)
    # wanxiang (default fallback)
    if not _WANXIANG_AVAILABLE:
        raise RuntimeError("wanxiang 引擎不可用: dashscope 未安装 (pip install dashscope)")
    return _ai_wanxiang.generate_segment(zone, prompt, key,
                                         width=width, height=height,
                                         negative_prompt=negative_prompt,
                                         reference_image_url=reference_image_url)


def download_image(engine: str, url: str, save_dir, filename: str = "") -> str:
    """按引擎选择对应的下载实现（两边接口一致，但保留分发以便未来差异化）"""
    if engine == "seedream":
        return ai_image_volcengine.download_image(url, save_dir, filename)
    if engine in ("gpt-image-2", "nano-banana"):
        return ai_image_apimart.download_image(url, save_dir, filename)
    if not _WANXIANG_AVAILABLE:
        raise RuntimeError("wanxiang 引擎不可用: dashscope 未安装")
    return _ai_wanxiang.download_image(url, save_dir, filename)


# ── ai_refine_v2 集成钩子 ────────────────────────────────────────
# refine_generator 用 api_call_fn 注入点 (签名: (prompt, img_data_url, key, thinking, size) -> url)
# 把"哪个引擎+通道"决策权从 refine_generator 抽到 router, 业务侧改 env 即可切

def get_refine_call_fn(engine: str | None = None):
    """返回签名兼容 refine_v2.ApiCallFn 的 (prompt, image_data_url, api_key, thinking, size) -> url.

    engine 不传 → 走 env DEFAULT_REFINE_ENGINE, 否则 fallback gpt-image-2 (refine v2 原生默认).
    """
    eng = (engine
           or os.environ.get("DEFAULT_REFINE_ENGINE", "").strip()
           or "gpt-image-2")
    meta = ENGINES.get(eng)
    if not meta or meta.get("stub"):
        raise ValueError(f"refine engine 不可用: {eng}")

    if eng == "gpt-image-2":
        return ai_image_apimart.default_api_call
    # 其他引擎: 暂未提供与 refine_v2 兼容的 (thinking, size) 签名,
    # 启用时各引擎 adapter 自己补 default_api_call 即可
    raise NotImplementedError(
        f"引擎 {eng} 暂未实现 refine_v2 ApiCallFn 签名; "
        f"在 ai_image_<engine>.py 加 default_api_call(prompt, image_data_url, api_key, thinking, size) 即可"
    )


def generate_segment_to_local(engine: str, zone: str, prompt: str,
                              api_keys: dict, save_dir,
                              width: int = 750, height: int = 1334,
                              filename: str = "",
                              reference_image_url: str = "") -> str:
    """
    一步到位：调用引擎生成 + 下载到本地，返回本地文件路径（失败返回空串）。
    供 /api/build/<type>/generate-ai-detail 端点逐段调用。

    reference_image_url: 可选参考图, 透传到 generate_segment 走 i2i 颜色保真。
    """
    urls = generate_segment(engine, zone, prompt, api_keys,
                            width=width, height=height,
                            reference_image_url=reference_image_url)
    if not urls:
        return ""
    fname = filename or f"{engine}_{zone}.png"
    return download_image(engine, urls[0], save_dir, fname)


# ── 兼容旧 /api/generate-ai-images 流程（逐块模式）─────────────

def generate_detail_backgrounds(engine: str, product_data: dict,
                                api_keys: dict, save_dir) -> dict:
    """旧版逐块生成接口（保留兼容），按 engine 分发"""
    engine = engine if engine in ENGINES else DEFAULT_ENGINE
    key = _resolve_key(engine, api_keys)
    if not key:
        meta = ENGINES[engine]
        raise ValueError(f"缺少 {meta['label']} 的 API Key")

    if engine == "seedream":
        return ai_image_volcengine.generate_detail_backgrounds(product_data, key, save_dir)
    if not _WANXIANG_AVAILABLE:
        raise RuntimeError("wanxiang 引擎不可用: dashscope 未安装")
    return _ai_wanxiang.generate_detail_backgrounds(product_data, key, save_dir)


if __name__ == "__main__":
    print("可用引擎:")
    for e in list_engines():
        print(f"  - {e['id']} ({e['label']} / {e['vendor']}) → 模型 {e['model']}, 环境变量 {e['key_env']}")
