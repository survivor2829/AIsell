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

import base64
import hashlib
import json
import os
import threading
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional


T2I_MODEL = "gpt-image-2"

# 默认 1:1 (gpt-image-2 支持 1:1 / 3:4 / 4:3 / 9:16 / 16:9)
_SIZE_DEFAULT = "1:1"
_POLL_INTERVAL_S = 3
# 480s = 8min, 给 v2 Hero 12 屏 + APIMart 偶发 503 重试边界, env 可覆盖
_POLL_TIMEOUT_S = int(os.environ.get("REFINE_POLL_TIMEOUT_S", "480"))
_MAX_CONSECUTIVE_POLL_ERRORS = 3
_ACTIVE_TASK_STATUSES = frozenset({
    "submitted",
    "pending",
    "queued",
    "processing",
    "in_progress",
})

_UA = (
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024
_UPLOAD_CACHE_TTL_S = 71 * 60 * 60
_UPLOAD_CACHE: dict[str, tuple[float, str, bool]] = {}
_UPLOAD_CACHE_LOCK = threading.Lock()
_RESULT_ROUTE_BY_URL: dict[str, bool] = {}
_RESULT_ROUTE_LOCK = threading.Lock()


def _snapshot_apimart_proxy_settings() -> dict[str, str]:
    """Keep APIMart on the proxy route selected when the sidecar starts.

    Other image providers run in the same Python process and may change proxy
    environment variables for their own SDKs. APIMart must not silently switch
    from the user's working system proxy to direct networking midway through a
    reference upload.
    """
    discovered = urllib.request.getproxies()
    fallback = str(discovered.get("all") or "").strip()
    settings: dict[str, str] = {}
    for scheme in ("http", "https"):
        value = str(discovered.get(scheme) or fallback).strip()
        if value:
            settings[scheme] = value
    return settings


_APIMART_PROXY_SETTINGS = _snapshot_apimart_proxy_settings()


class APIMartError(RuntimeError):
    """Known APIMart failure that must not be retried by the image generator."""

    do_not_retry = True
    outcome_unknown = False


class APIMartOutcomeUnknown(APIMartError):
    """A generation was submitted, but its final billable outcome is unknown."""

    outcome_unknown = True

    def __init__(self, task_id: str, message: str):
        self.task_id = task_id
        suffix = f" task_id={task_id}" if task_id else ""
        super().__init__(f"{message}.{suffix} 请先核对 APIMart 任务，禁止自动重提")


class APIMartTaskFailed(APIMartError):
    """APIMart explicitly reported a terminal failed/cancelled task."""


class APIMartReferenceUploadTransportError(APIMartError):
    """The reference image never reached a confirmed upload response."""


class APIMartResultDownloadError(APIMartError):
    """A paid result exists remotely but could not be persisted locally."""

    recovery_required = True



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

def _build_apimart_opener(*, direct: bool = False):
    """Create an isolated APIMart transport without inheriting global opener state."""
    proxy_settings = {} if direct else _APIMART_PROXY_SETTINGS
    return urllib.request.build_opener(urllib.request.ProxyHandler(proxy_settings))


def _open_apimart(request: urllib.request.Request, *, timeout: int, direct: bool = False):
    return _build_apimart_opener(direct=direct).open(request, timeout=timeout)


def _remember_result_route(url: str, direct: bool) -> None:
    """Associate a completed result URL with the route that polled it."""
    if not url:
        return
    with _RESULT_ROUTE_LOCK:
        if len(_RESULT_ROUTE_BY_URL) >= 512:
            _RESULT_ROUTE_BY_URL.pop(next(iter(_RESULT_ROUTE_BY_URL)))
        _RESULT_ROUTE_BY_URL[url] = bool(direct)


def get_result_route(url: str) -> str:
    """Return ``system``, ``direct`` or ``unknown`` for a result URL."""
    with _RESULT_ROUTE_LOCK:
        direct = _RESULT_ROUTE_BY_URL.get(url)
    if direct is None:
        return "unknown"
    return "direct" if direct else "system"


def _result_download_routes(preferred_route: str) -> list[bool]:
    preferred = str(preferred_route or "unknown").strip().lower()
    if preferred == "direct":
        routes = [True]
        if _APIMART_PROXY_SETTINGS:
            routes.append(False)
        return routes
    if preferred == "system":
        routes = [False]
        if _APIMART_PROXY_SETTINGS:
            routes.append(True)
        return routes
    routes = [False]
    if _APIMART_PROXY_SETTINGS:
        routes.append(True)
    return routes


def download_result_image(
    url: str,
    destination: str | Path,
    *,
    preferred_route: str = "unknown",
    timeout: int = 60,
    retries: int = 2,
) -> str:
    """Download one completed result without ever submitting a new task.

    The route proven during reference upload / submit / poll is tried first.
    Because GET is non-billable, the alternate route is a safe fallback. Bytes
    are atomically replaced so a process crash cannot leave a partial image at
    the final path. The selected route is returned for durable checkpoints.
    """
    if not str(url or "").startswith(("https://", "http://")):
        raise APIMartResultDownloadError("APIMart 结果 URL 无效，已保留任务供恢复")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None
    for direct in _result_download_routes(preferred_route):
        for attempt in range(max(0, int(retries)) + 1):
            temp_path = destination.with_name(
                f".{destination.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                request = urllib.request.Request(url, headers={"User-Agent": _UA})
                with _open_apimart(request, timeout=timeout, direct=direct) as response:
                    payload = response.read()
                if len(payload) < 1024:
                    raise RuntimeError(
                        f"下载内容 < 1KB ({len(payload)} 字节)，视作失败"
                    )
                with temp_path.open("wb") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, destination)
                selected = "direct" if direct else "system"
                _remember_result_route(url, direct)
                return selected
            except Exception as exc:
                last_error = exc
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                if attempt < max(0, int(retries)):
                    time.sleep(1)
    raise APIMartResultDownloadError(
        f"APIMart 已生成结果但本地下载失败，原始 URL 已保留供恢复: {last_error}"
    ) from last_error

def _http_post_json(url: str, payload: dict, api_key: str,
                    timeout: int = 30, *, direct: bool = False) -> tuple[int, Any]:
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
        with _open_apimart(req, timeout=timeout, direct=direct) as r:
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


def _http_get_json(url: str, api_key: str, timeout: int = 30,
                   *, direct: bool = False) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": _UA},
    )
    with _open_apimart(req, timeout=timeout, direct=direct) as r:
        return json.loads(r.read().decode("utf-8"))


# ── APIMart submit / poll ──────────────────────────────────────

def _safe_error_detail(body: Any) -> str:
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            value = error.get("message") or error.get("type") or "provider_error"
        else:
            value = body.get("message") or body.get("code") or "provider_error"
    else:
        value = "provider_error"
    return str(value)[:300]


def _http_post_image_upload(url: str, image_bytes: bytes, mime: str,
                            filename: str, api_key: str,
                            timeout: int = 60, *, direct: bool = False) -> tuple[int, Any]:
    boundary = f"----xiaoxi-apimart-{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode("ascii") + image_bytes + f"\r\n--{boundary}--\r\n".encode("ascii")
    request = urllib.request.Request(
        url,
        method="POST",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": _UA,
        },
    )
    try:
        with _open_apimart(request, timeout=timeout, direct=direct) as response:
            raw = response.read().decode("utf-8")
            try:
                return response.status, json.loads(raw)
            except json.JSONDecodeError:
                return response.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def _upload_reference_with_transport_fallback(
    url: str,
    image_bytes: bytes,
    mime: str,
    filename: str,
    api_key: str,
    *,
    direct: bool = False,
) -> tuple[int, Any, bool]:
    """Try the saved system route once, then direct only before model submission.

    This is deliberately limited to `/uploads/images`: an upload timeout occurs
    before `/images/generations` can create a billable task.  The selected route
    is returned so submit and poll can keep using the same proven connection.
    """
    if direct:
        try:
            code, body = _http_post_image_upload(
                url, image_bytes, mime, filename, api_key, direct=True,
            )
            return code, body, True
        except (urllib.error.URLError, TimeoutError, OSError) as direct_error:
            raise APIMartReferenceUploadTransportError(
                "APIMart 参考图上传连接失败，未提交生图任务。"
                "请检查网络后重新发起。"
            ) from direct_error
    try:
        code, body = _http_post_image_upload(url, image_bytes, mime, filename, api_key)
        return code, body, False
    except (urllib.error.URLError, TimeoutError, OSError) as system_error:
        if not _APIMART_PROXY_SETTINGS:
            raise APIMartReferenceUploadTransportError(
                "APIMart 参考图上传连接失败，未提交生图任务。"
                "请检查网络后重新发起。"
            ) from system_error
        try:
            code, body = _http_post_image_upload(
                url, image_bytes, mime, filename, api_key, direct=True,
            )
            return code, body, True
        except (urllib.error.URLError, TimeoutError, OSError) as direct_error:
            raise APIMartReferenceUploadTransportError(
                "APIMart 参考图上传连接失败，已尝试系统代理和直连，未提交生图任务。"
                "请检查网络或代理后重新发起。"
            ) from direct_error


def _decode_data_url(value: str) -> tuple[bytes, str, str]:
    header, separator, encoded = value.partition(",")
    if not separator or not header.startswith("data:image/") or ";base64" not in header:
        raise APIMartError("APIMart 参考图必须是受支持的图片 data URL")
    mime = header[5:].split(";", 1)[0].lower()
    extension_by_mime = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    extension = extension_by_mime.get(mime)
    if not extension:
        raise APIMartError(f"APIMart 不支持参考图类型: {mime}")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise APIMartError("参考图 base64 数据无效") from exc
    if not raw or len(raw) > _MAX_UPLOAD_BYTES:
        raise APIMartError("参考图为空或超过 APIMart 20MB 上传上限")
    return raw, mime, f"reference.{extension}"


def _upload_data_url_for_route(
    value: str, api_key: str, *, direct: bool = False,
) -> tuple[str, bool]:
    """Upload one reference while retaining the route for the enclosing task."""
    raw, mime, filename = _decode_data_url(value)
    digest = hashlib.sha256(raw).hexdigest()
    now = time.time()
    with _UPLOAD_CACHE_LOCK:
        cached = _UPLOAD_CACHE.get(digest)
        if cached and cached[0] > now:
            return cached[1], direct or cached[2]
        for attempt in range(2):
            code, body, selected_direct = _upload_reference_with_transport_fallback(
                f"{_apimart_base()}/uploads/images", raw, mime, filename, api_key,
                direct=direct,
            )
            if code == 200 and isinstance(body, dict) and body.get("url"):
                url = str(body["url"])
                _UPLOAD_CACHE[digest] = (now + _UPLOAD_CACHE_TTL_S, url, selected_direct)
                return url, selected_direct
            if code == 503 and attempt == 0:
                time.sleep(1)
                continue
            raise APIMartError(
                f"APIMart 参考图上传失败 HTTP {code}: {_safe_error_detail(body)}"
            )
    raise APIMartError("APIMart 参考图上传失败")


def upload_data_url(value: str, api_key: str) -> str:
    """Upload a data URL once and cache the provider URL for its 72-hour lifetime."""
    url, _selected_direct = _upload_data_url_for_route(value, api_key)
    return url


def _prepare_reference_urls_for_route(
    image_data_url: Optional[str | list[str]], api_key: str,
) -> tuple[list[str], bool]:
    if not image_data_url:
        return [], False
    values = image_data_url if isinstance(image_data_url, list) else [image_data_url]
    prepared: list[str] = []
    selected_direct = False
    for raw_value in values:
        value = str(raw_value or "").strip()
        if value.startswith("data:image/"):
            url, selected_direct = _upload_data_url_for_route(
                value, api_key, direct=selected_direct,
            )
            prepared.append(url)
        elif value.startswith(("https://", "http://")):
            prepared.append(value)
        else:
            raise APIMartError("APIMart 参考图必须是图片 data URL 或公开 URL")
    return prepared, selected_direct


def _submit_task_id(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    data = body.get("data") or []
    nodes = data if isinstance(data, list) else [data]
    for node in nodes:
        if isinstance(node, dict):
            task_id = node.get("task_id") or node.get("id")
            if task_id:
                return str(task_id)
    return ""


def _submit_image_task_for_route(prompt: str,
                                 image_data_url: Optional[str | list[str]],
                                 api_key: str,
                                 thinking: str = "medium",
                                 size: str = _SIZE_DEFAULT) -> tuple[str, bool]:
    """Submit once and retain the proven route for polling the same task."""
    payload: dict[str, Any] = {
        "model": T2I_MODEL,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "resolution": "1k",
    }
    reference_urls, selected_direct = _prepare_reference_urls_for_route(image_data_url, api_key)
    if reference_urls:
        payload["image_urls"] = reference_urls

    try:
        if selected_direct:
            code, body = _http_post_json(
                f"{_apimart_base()}/images/generations", payload, api_key, direct=True,
            )
        else:
            code, body = _http_post_json(
                f"{_apimart_base()}/images/generations", payload, api_key,
            )
    except Exception as exc:
        raise APIMartOutcomeUnknown("", "APIMart 提交响应未确认") from exc
    task_id = _submit_task_id(body)
    if task_id:
        return task_id, selected_direct
    if 400 <= code < 500:
        raise APIMartError(
            f"APIMart 明确拒绝提交 HTTP {code}: {_safe_error_detail(body)}"
        )
    raise APIMartOutcomeUnknown(
        "", f"APIMart 提交结果不明 HTTP {code}: {_safe_error_detail(body)}"
    )


def submit_image_task(prompt: str,
                      image_data_url: Optional[str | list[str]],
                      api_key: str,
                      thinking: str = "medium",
                      size: str = _SIZE_DEFAULT) -> str:
    """Submit one billable task exactly once; uncertain responses must not be retried."""
    task_id, _selected_direct = _submit_image_task_for_route(
        prompt, image_data_url, api_key, thinking=thinking, size=size,
    )
    return task_id


def poll_image_task(task_id: str, api_key: str,
                    poll_interval: int = _POLL_INTERVAL_S,
                    poll_timeout: int = _POLL_TIMEOUT_S,
                    *, direct: bool = False) -> str:
    """Poll the existing task only; any uncertain result stops without resubmission."""
    started_at = time.time()
    consecutive_poll_errors = 0
    while True:
        if time.time() - started_at > poll_timeout:
            raise APIMartOutcomeUnknown(task_id, "APIMart 轮询超时，结果不明")
        try:
            if direct:
                data = _http_get_json(
                    f"{_apimart_base()}/tasks/{task_id}?language=en", api_key, direct=True,
                )
            else:
                data = _http_get_json(
                    f"{_apimart_base()}/tasks/{task_id}?language=en", api_key,
                )
        except Exception as exc:
            consecutive_poll_errors += 1
            if consecutive_poll_errors >= _MAX_CONSECUTIVE_POLL_ERRORS:
                raise APIMartOutcomeUnknown(
                    task_id, "APIMart 连续轮询连接失败，结果不明"
                ) from exc
            time.sleep(poll_interval)
            continue
        consecutive_poll_errors = 0
        if not isinstance(data, dict):
            raise APIMartOutcomeUnknown(task_id, "APIMart 状态响应无效，结果不明")
        node = data.get("data") or data
        if not isinstance(node, dict):
            raise APIMartOutcomeUnknown(task_id, "APIMart 状态响应无效，结果不明")
        status = str(node.get("status") or "").lower()
        if status == "completed":
            result = node.get("result") or {}
            if not isinstance(result, dict):
                raise APIMartOutcomeUnknown(task_id, "APIMart 已完成但结果结构无效")
            images = result.get("images") or []
            if not isinstance(images, list) or not images:
                raise APIMartOutcomeUnknown(task_id, "APIMart 已完成但结果图片缺失")
            url = images[0].get("url") if isinstance(images[0], dict) else ""
            if isinstance(url, list):
                url = url[0] if url and isinstance(url[0], str) else ""
            if not isinstance(url, str):
                url = ""
            url = url.strip()
            if not url.startswith(("https://", "http://")):
                raise APIMartOutcomeUnknown(task_id, "APIMart 已完成但结果 URL 缺失")
            return url
        if status in ("failed", "cancelled"):
            raise APIMartTaskFailed(
                f"APIMart 任务 {status}: {_safe_error_detail(node)} task_id={task_id}"
            )
        if status not in _ACTIVE_TASK_STATUSES:
            raise APIMartOutcomeUnknown(task_id, f"APIMart 返回未知状态 {status!r}")
        time.sleep(poll_interval)


def default_api_call(prompt: str,
                     image_data_url: Optional[str | list[str]],
                     api_key: str,
                     thinking: str = "medium",
                     size: str = _SIZE_DEFAULT,
                     *,
                     lifecycle_callback: Optional[Callable[[dict[str, Any]], None]] = None,
                     ) -> str:
    """Upload references, submit once, then poll that same task to completion."""
    task_id, selected_direct = _submit_image_task_for_route(
        prompt, image_data_url, api_key, thinking=thinking, size=size,
    )
    route = "direct" if selected_direct else "system"
    if lifecycle_callback is not None:
        try:
            lifecycle_callback({
                "event": "submitted",
                "provider_task_id": task_id,
                "route": route,
            })
        except Exception as exc:
            raise APIMartOutcomeUnknown(
                task_id, "APIMart 任务已提交但本地断点保存失败",
            ) from exc
    result_url = poll_image_task(task_id, api_key, direct=selected_direct)
    _remember_result_route(result_url, selected_direct)
    if lifecycle_callback is not None:
        try:
            lifecycle_callback({
                "event": "completed",
                "provider_task_id": task_id,
                "raw_url": result_url,
                "route": route,
            })
        except Exception as exc:
            raise APIMartOutcomeUnknown(
                task_id, "APIMart 已返回结果但本地断点保存失败",
            ) from exc
    return result_url

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
        download_result_image(
            url,
            local,
            preferred_route=get_result_route(url),
            timeout=60,
        )
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
