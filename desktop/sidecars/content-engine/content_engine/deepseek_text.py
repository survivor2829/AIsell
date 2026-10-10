"""Text-only director using the existing structured completion and usage contracts."""
from __future__ import annotations

import json
import os
import socket
from urllib import request
from urllib.error import HTTPError, URLError

from .creative_analysis import DashScopeMediaClient, MAX_PROVIDER_JSON_BYTES, _json_bytes, _read_bounded
from .errors import ContentEngineError
from .provider_tls import gateway_tls_context
from .provider_usage import ProviderRequest, current_usage_context, observe_http_error
from .volcengine_tts import _NoRedirect


DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions"


class DeepSeekTextClient(DashScopeMediaClient):
    provider = "deepseek"

    def __init__(self, *, api_key=None, endpoint=None, model=None, timeout_seconds=None):
        # Credentials enter only through the trusted desktop handoff. Never
        # inherit a vision/ASR provider's key or silently substitute its model.
        self.api_key = str(api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY", "")).strip()
        endpoint = str(endpoint or os.environ.get("DEEPSEEK_API_URL") or DEFAULT_ENDPOINT).strip()
        gateway = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").strip().rstrip("/")
        approved = {DEFAULT_ENDPOINT, "https://api.deepseek.com/v1/chat/completions"}
        if gateway:
            approved.update(gateway + "/v1/provider-gateway/deepseek" + suffix
                            for suffix in ("/chat/completions", "/v1/chat/completions"))
        if endpoint not in approved or not endpoint.startswith("https://"):
            raise ContentEngineError("deepseek_endpoint_invalid", "DeepSeek 导演接口地址无效，已停止请求。")
        self.compatible_origin = endpoint.rsplit("/chat/completions", 1)[0]
        self.selection_model = str(model or os.environ.get("DEEPSEEK_MODEL") or DEFAULT_MODEL).strip()
        self.timeout_seconds = min(300, max(5, int(timeout_seconds or 180)))

    def _request_json(self, url, *, method="GET", payload=None, headers=None,
                      timeout=None, operation_label=None, retry_on_timeout=False):
        if not self.configured:
            raise ContentEngineError("deepseek_not_configured", "DeepSeek 导演服务尚未连接，已有文案和素材已保留。")
        if url != self.compatible_origin + "/chat/completions" or method != "POST":
            raise ContentEngineError("deepseek_operation_unsupported", "DeepSeek 导演只处理文案和剪辑规划。")
        messages = (payload or {}).get("messages") or []
        if any(not isinstance(item.get("content"), str) for item in messages if isinstance(item, dict)):
            raise ContentEngineError("deepseek_text_only", "图片理解应使用素材分析服务，不能发送给文字导演。")
        context = current_usage_context()
        request_headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json",
                           "Accept": "application/json", **(headers or {})}
        if context.get("operation_id"):
            request_headers["X-Xiaoxi-Operation-Id"] = context["operation_id"]
        op = request.Request(url, data=_json_bytes({**payload, "thinking": {"type": "disabled"}}), headers=request_headers, method="POST")
        meter = ProviderRequest(provider=self.provider, kind="llm", model=payload.get("model", ""),
                                purpose=operation_label, data_dir=getattr(self, "usage_data_dir", None),
                                attempt=context.get("correction_attempt", 1))
        try:
            with meter:
                try:
                    tls = gateway_tls_context(url)
                    handlers = [_NoRedirect()]
                    if tls is not None:
                        handlers.append(request.HTTPSHandler(context=tls))
                    with request.build_opener(*handlers).open(op, timeout=timeout or self.timeout_seconds) as response:
                        meter.observe(headers=response.headers, http_status=getattr(response, "status", 200))
                        raw = _read_bounded(response, MAX_PROVIDER_JSON_BYTES, "cloud_response_too_large", "DeepSeek 返回的数据过大。")
                    result = json.loads(raw.decode("utf-8"))
                    if not isinstance(result, dict):
                        raise ValueError("invalid response")
                    meter.observe(result)
                    if result.get("error"):
                        raise ContentEngineError("cloud_request_rejected", "DeepSeek 拒绝了本次导演请求，请检查服务权限。")
                    return result
                except HTTPError as error:
                    observe_http_error(meter, error)
                    raise ContentEngineError("cloud_request_failed", f"DeepSeek 导演请求未完成（HTTP {error.code}），请核对服务权限、额度或原请求记录。") from error
                except (TimeoutError, socket.timeout, URLError, OSError, ValueError) as error:
                    meter.observe_transport_error(error)
                    # Do not retry a paid request after an uncertain transport
                    # result. NarratedBatch retains its existing inflight marker.
                    raise ContentEngineError("cloud_request_failed", "DeepSeek 导演请求结果暂时无法确认，已保留进度，不会自动重提。") from error
        finally:
            self._last_request_usage = dict(meter.record)

    def _structured_completion(self, **kwargs):
        try:
            result = super()._structured_completion(**kwargs)
            self.last_completion_metadata["provider"] = self.provider
            return result
        except ContentEngineError as error:
            # Keep the original transport cause: batch recovery distinguishes
            # definite HTTP rejections from uncertain paid submissions.
            message = str(error).replace("百炼", "DeepSeek")
            if message == str(error):
                raise
            raise ContentEngineError(error.code, message) from error.__cause__
