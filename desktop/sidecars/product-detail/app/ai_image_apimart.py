"""APIMart gpt-image-2 adapter — 统一 router 第三引擎.

Engine:  gpt-image-2 (OpenAI-compatible 模型)
Channel: APIMart 中转站  (endpoint = REFINE_API_BASE_URL env)
API key: REFINE_API_KEY (优先) / GPT_IMAGE_API_KEY (兼容 fallback)

为什么独立一个文件而不是塞 ai_image_router.py:
  router 一直保持 skinny dispatcher 风格 (只调度, 不实现 HTTP). 把 APIMart submit+poll
  HTTP 细节封装在这一个 module 里, 跟 ai_image_volcengine.py / ai_image.py 同形.

对外接口 (router 调这几个):
  generate_segment(zone, prompt, api_key, ...) -> list[str]  # router-compatible
  download_image(url, save_dir, filename)      -> str        # 下载到本地
  default_api_call(prompt, image_data_url, api_key, thinking, size) -> str
       # 给 ai_refine_v2 的 api_call_fn 注入点用 (签名兼容)

历史: 这套代码原本在 ai_refine_v2/refine_generator.py 里 _default_api_call+_submit_image_task+
     _poll_image_task. 2026-05-13 提到 router 层作为可统一切换的引擎抽象.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional


T2I_MODEL = "gpt-image-2"

# 默认 1:1 (gpt-image-2 支持 1:1 / 3:4 / 4:3 / 9:16 / 16:9)
_SIZE_DEFAULT = "1:1"
_POLL_INTERVAL_S = 3
# 480s = 8min, 给 v2 Hero 12 屏 + APIMart 偶发 503 重试边界, env 可覆盖
_POLL_TIMEOUT_S = int(os.environ.get("REFINE_POLL_TIMEOUT_S", "480"))

_UA = (
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def _apimart_base() -> str:
    """读 REFINE_API_BASE_URL. 启动时 app.py:_REQUIRED_PLATFORM_KEYS 已保证非空."""
    return os.environ["REFINE_API_BASE_URL"].rstrip("/")


def _resolve_api_key(api_key: str = "") -> str:
    """优先用传入 key, 否则 REFINE_API_KEY env, 最后 GPT_IMAGE_API_KEY."""
    if api_key:
        return api_key.strip()
    for env_var in ("REFINE_API_KEY", "GPT_IMAGE_API_KEY"):
        v = os.environ.get(env_var, "").strip()
        if v:
            return v
    return ""


# ── HTTP 工具 ──────────────────────────────────────────────────

def _http_post_json(url: str, payload: dict, api_key: str,
                    timeout: int = 30) -> tuple[int, Any]:
    """POST JSON, 返回 (status_code, parsed_body | raw_text). HTTPError 不 raise."""
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": _UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8")
            try:
                return r.status, json.loads(body)
            except json.JSONDecodeError:
                return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body


def _http_get_json(url: str, api_key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── APIMart submit / poll ──────────────────────────────────────

def submit_image_task(prompt: str,
                      image_data_url: Optional[str | list[str]],
                      api_key: str,
                      thinking: str = "medium",
                      size: str = _SIZE_DEFAULT) -> str:
    """提交 gpt-image-2 生图任务, 返回 task_id."""
    payload: dict[str, Any] = {
        "model": T2I_MODEL,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "thinking": thinking,
        "reasoning_effort": thinking,
    }
    if image_data_url:
        if isinstance(image_data_url, list):
            payload["image_urls"] = image_data_url
        else:
            payload["image_urls"] = [image_data_url]

    code, body = _http_post_json(
        f"{_apimart_base()}/images/generations", payload, api_key,
    )
    if code != 200 or not isinstance(body, dict) or body.get("code") != 200:
        raise RuntimeError(f"APIMart submit HTTP {code}: {body}")
    tasks = body.get("data") or []
    if not tasks or not tasks[0].get("task_id"):
        raise RuntimeError(f"APIMart 响应缺 task_id: {body}")
    return tasks[0]["task_id"]


def poll_image_task(task_id: str, api_key: str,
                    poll_interval: int = _POLL_INTERVAL_S,
                    poll_timeout: int = _POLL_TIMEOUT_S) -> str:
    """轮询 task 直到 completed, 返回 image_url. 失败/超时抛异常."""
    t0 = time.time()
    while True:
        elapsed = time.time() - t0
        if elapsed > poll_timeout:
            raise TimeoutError(
                f"APIMart 轮询超时 {poll_timeout}s, task_id={task_id}"
            )
        data = _http_get_json(
            f"{_apimart_base()}/tasks/{task_id}?language=en", api_key,
        )
        node = data.get("data") or data
        status = node.get("status")
        if status == "completed":
            images = (node.get("result") or {}).get("images") or []
            if not images:
                raise RuntimeError(f"APIMart completed 但无 images: {node}")
            url = images[0].get("url")
            if isinstance(url, list):
                url = url[0] if url else None
            if not url:
                raise RuntimeError(f"APIMart completed 但无 url: {images}")
            return url
        if status in ("failed", "cancelled"):
            raise RuntimeError(f"APIMart 任务 {status}: {node}")
        time.sleep(poll_interval)


def default_api_call(prompt: str,
                     image_data_url: Optional[str | list[str]],
                     api_key: str,
                     thinking: str = "medium",
                     size: str = _SIZE_DEFAULT) -> str:
    """submit + poll 一次到位. ai_refine_v2 注入此函数到 api_call_fn 钩子.

    签名约束 (ApiCallFn 兼容):
        (prompt, image_data_url, api_key, thinking, size) -> image_url
    """
    task_id = submit_image_task(
        prompt, image_data_url, api_key, thinking=thinking, size=size,
    )
    return poll_image_task(task_id, api_key)


# ── Router 兼容接口 ────────────────────────────────────────────

# gpt-image-2 支持的 size ratio (近似映射 ai_bg_cache 的 canvas)
_SIZE_RATIOS: dict[str, float] = {
    "1:1": 1.0,
    "3:4": 0.75,
    "4:3": 1.333,
    "9:16": 0.5625,
    "16:9": 1.7778,
}


def _ratio_for_canvas(width: int, height: int) -> str:
    """把 ai_bg_cache 的 width×height 映射到 gpt-image-2 支持的 ratio 字符串.

    例: (768, 1024) → 0.75 → "3:4"
        (768, 832)  → 0.92 → "1:1" (最近)
    """
    if not height:
        return _SIZE_DEFAULT
    r = width / height
    return min(_SIZE_RATIOS, key=lambda k: abs(_SIZE_RATIOS[k] - r))


def generate_segment(zone: str, prompt: str, api_key: str,
                     width: int = 750, height: int = 1334,
                     negative_prompt: str = "",
                     reference_image_url: str = "") -> list[str]:
    """Router-compatible: 返回 [image_url] 成功, [] 失败.

    note: gpt-image-2 原生不接受 negative_prompt, 该参数被忽略 (打 warning).
    reference_image_url: 传 data URL / http URL, 走 i2i 颜色保真.
    """
    if negative_prompt:
        # gpt-image-2 不支持 negative_prompt; 把它拼到 prompt 末尾 "Avoid: ..." 是常见兜底
        prompt = f"{prompt}\n\nAvoid: {negative_prompt}"

    size = _ratio_for_canvas(width, height)
    use_key = _resolve_api_key(api_key)
    if not use_key:
        print(f"[apimart] {zone} 缺 REFINE_API_KEY/GPT_IMAGE_API_KEY")
        return []

    try:
        url = default_api_call(
            prompt,
            reference_image_url or None,
            use_key,
            thinking="medium",
            size=size,
        )
        return [url] if url else []
    except Exception as e:
        print(f"[apimart] {zone} generate_segment 失败: {e}")
        return []


def download_image(url: str, save_dir, filename: str = "") -> str:
    """从 APIMart 返回的 URL 下载到本地, 返回本地文件绝对路径或 ""."""
    save_dir = Path(save_dir)
    save_dir.mkdir(parents=True, exist_ok=True)

    fname = filename or f"apimart_{int(time.time())}.png"
    local = save_dir / fname

    try:
        # APIMart 返回 CDN URL (cloudflare / oss / etc), 不走代理
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            local.write_bytes(r.read())
        return str(local)
    except Exception as e:
        print(f"[apimart] download 失败 {url}: {e}")
        return ""


# ── 兼容 stub: generate_detail_backgrounds ────────────────────
# 给 ai_image_router.generate_detail_backgrounds 用的 fallback;
# gpt-image-2 路径目前不走 "逐块生成" 老接口, 留个明确 NotImplemented 防误用.

def generate_detail_backgrounds(product_data: dict, api_key: str, save_dir) -> dict:
    """legacy 逐块接口: gpt-image-2 暂不实现 (推荐走 generate_segment 无缝长图)."""
    raise NotImplementedError(
        "gpt-image-2/apimart 暂不支持旧逐块 generate_detail_backgrounds; "
        "请改用 ai_image_router.generate_segment 走无缝长图管线"
    )
