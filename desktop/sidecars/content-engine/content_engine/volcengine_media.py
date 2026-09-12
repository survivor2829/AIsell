"""Fire-and-report Volcengine transport; reuse existing editorial contracts."""
import base64
import json
import os
import re
import socket
import time
import uuid
import wave
from urllib import request
from urllib.error import HTTPError, URLError

from .creative_analysis import DashScopeMediaClient
from .errors import ContentEngineError
from .provider_usage import (
    ProviderRateLimitRetry,
    ProviderRequest,
    current_usage_context,
    observe_http_error,
    retry_delay_seconds,
    usage_scope,
)
from .provider_tls import gateway_tls_context
from .volcengine_tts import VolcengineTTSProvider, _NoRedirect

ARK_ENDPOINT = os.environ.get(
    "XIAOXI_VOLCENGINE_ARK_API_URL",
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
).strip() or "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
ASR_ENDPOINT = os.environ.get(
    "XIAOXI_VOLCENGINE_ASR_ENDPOINT",
    "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
).strip() or "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash"
DEFAULT_MODEL = "doubao-seed-2-1-pro-260628"
MAX_429_ATTEMPTS = 3
OPAQUE_HEADER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class VolcengineMediaClient(DashScopeMediaClient):
    provider = "volcengine"

    def __init__(self):
        # Do not inherit a historical DashScope key, origin, or model.
        ark_origin = os.environ.get(
            "XIAOXI_VOLCENGINE_ARK_API_HOST", "https://ark.cn-beijing.volces.com"
        ).strip() or "https://ark.cn-beijing.volces.com"
        ark_compatible_origin = os.environ.get(
            "XIAOXI_VOLCENGINE_ARK_COMPATIBLE_ORIGIN", ""
        ).strip() or ARK_ENDPOINT.rsplit("/chat/completions", 1)[0]
        super().__init__(api_key="unused", origin=ark_origin,
                         compatible_origin=ark_compatible_origin,
                         asr_model="volc.bigasr.auc_turbo", vision_model=DEFAULT_MODEL,
                         selection_model=DEFAULT_MODEL)
        self.api_key = os.environ.get("XIAOXI_VOLCENGINE_ARK_API_KEY", "").strip()
        self.selection_model = self.vision_model = os.environ.get("XIAOXI_VOLCENGINE_ARK_MODEL", DEFAULT_MODEL).strip()
        self.speech_key = os.environ.get('XIAOXI_VOLCENGINE_ASR_API_KEY', '').strip()
        if '/v1/provider-gateway/' in ark_compatible_origin:
            self.timeout_seconds = max(self.timeout_seconds, 270)
        self.asr_app_id = os.environ.get("XIAOXI_VOLCENGINE_ASR_APP_ID", "").strip()
        self.asr_access_token = os.environ.get("XIAOXI_VOLCENGINE_ASR_ACCESS_TOKEN", "").strip()

    def _asr_auth_headers(self):
        if os.environ.get("XIAOXI_VOLCENGINE_ASR_GATEWAY_ENABLED", "") == "1":
            return {}
        if self.asr_app_id or self.asr_access_token:
            if not (self.asr_app_id and self.asr_access_token):
                raise ContentEngineError("volcengine_asr_not_configured", "请保存完整的语音识别 APP ID 和 Access Token。")
            return {"X-Api-App-Key": self.asr_app_id, "X-Api-Access-Key": self.asr_access_token}
        if self.speech_key:
            return {"X-Api-Key": self.speech_key}
        raise ContentEngineError("volcengine_asr_not_configured", "请先在语音识别设置中填写认证信息。")

    def _post(self, url, payload, headers, timeout, stage, *, purpose=None, requested_audio_ms=None):
        if "/v1/provider-gateway/" in url:
            timeout = max(timeout, 270)
        context = current_usage_context()
        request_id = str(headers.get("X-Api-Request-Id") or "").strip()
        if not OPAQUE_HEADER.fullmatch(request_id):
            request_id = str(uuid.uuid4())
        operation_id = context.get("operation_id") or request_id
        if not OPAQUE_HEADER.fullmatch(operation_id):
            operation_id = request_id
        request_headers = {"Content-Type": "application/json", **headers, "X-Api-Request-Id": request_id}
        gateway_token = os.environ.get("XIAOXI_PROVIDER_GATEWAY_TOKEN", "").strip()
        gateway_origin = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").strip().rstrip("/")
        gateway_request = gateway_token and gateway_origin and url.startswith(f"{gateway_origin}/v1/provider-gateway/")
        if gateway_request:
            request_headers["Authorization"] = f"Bearer {gateway_token}"
            request_headers["X-Xiaoxi-Operation-Id"] = operation_id
        last_meter = None
        for attempt in range(1, MAX_429_ATTEMPTS + 1):
            op = request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 headers=request_headers, method="POST")
            meter = None
            try:
                with usage_scope(
                    data_dir=getattr(self, "usage_data_dir", None),
                    operation_id=operation_id,
                ):
                    meter = ProviderRequest(
                        provider=self.provider,
                        kind="asr" if stage == "语音识别" else "llm",
                        model=self.asr_model if stage == "语音识别" else payload.get("model", ""),
                        purpose=purpose or stage,
                        request_id=request_id,
                        attempt=attempt,
                        requested_audio_ms=requested_audio_ms,
                    )
                    last_meter = meter
                    with meter:
                        try:
                            tls_context = gateway_tls_context(url)
                            opener_args = [_NoRedirect()]
                            if tls_context is not None:
                                opener_args.append(request.HTTPSHandler(context=tls_context))
                            with request.build_opener(*opener_args).open(op, timeout=timeout) as response:
                                meter.observe(headers=response.headers, http_status=getattr(response, "status", 200))
                                status = response.headers.get("X-Api-Status-Code")
                                if stage == "语音识别" and status not in {"20000000", "20000003"}:
                                    raise ContentEngineError("volcengine_request_rejected", f"火山语音识别未成功，服务状态 {status or '缺失'}；请检查录音文件极速版服务权限。")
                                raw = response.read(16 * 1024 * 1024 + 1)
                                if len(raw) > 16 * 1024 * 1024:
                                    raise ContentEngineError("cloud_response_too_large", "火山返回结果过大，已停止。")
                                result = json.loads(raw) if raw else {}
                                if not isinstance(result, dict):
                                    raise ValueError()
                                meter.observe(result)
                                if stage == "语音识别" and status == "20000003":
                                    return {**result, "result": {"text": "", "utterances": []}, "speech_status": "silent"}
                                if result.get("error"):
                                    raise ContentEngineError("volcengine_request_rejected", "火山方舟拒绝本次请求，请检查服务权限与额度。")
                                return result
                        except HTTPError as error:
                            observe_http_error(meter, error)
                            status_code = int(error.code or 0)
                            if status_code == 429 and attempt < MAX_429_ATTEMPTS:
                                delay = retry_delay_seconds(getattr(error, "headers", None), attempt)
                                if delay is not None:
                                    raise ProviderRateLimitRetry(delay) from None
                            if status_code >= 500:
                                origin = {
                                    "gateway_transport": "网关传输",
                                    "maintenance_transport": "维护服务传输",
                                    "gateway_response": "网关响应",
                                    "coalesced_timeout": "网关合并请求等待",
                                    "upstream": "上游服务",
                                }.get(meter.record.get("error_origin"), "来源未确认")
                                phase = "超时" if status_code == 504 else "暂不可用"
                                message = f"火山{stage}请求{phase}（HTTP {status_code}，{origin}），结果不明，未自动重提。"
                                raise ContentEngineError("volcengine_outcome_unknown", message) from None
                            if stage == "语音识别" and meter.record.get("provider_code") == "45000010":
                                message = "火山语音识别授权未通过（45000010），请开通 volc.bigasr.auc_turbo，并在服务端配置 ASR 专用 API Key 或 APP ID + Access Token。"
                            elif status_code == 429:
                                origin = {
                                    "gateway_rate_limit": "本地网关限流",
                                    "maintenance_rate_limit": "维护服务限流",
                                    "upstream": "上游服务限流",
                                }.get(meter.record.get("error_origin"), "来源未确认")
                                message = f"火山{stage}请求被限流（HTTP 429，{origin}），请稍后再试。"
                            else:
                                message = f"火山{stage}请求被拒绝（HTTP {error.code}），请检查对应 API Key、模型及服务权限。"
                            raise ContentEngineError("volcengine_request_rejected", message) from None
                        except (TimeoutError, socket.timeout, URLError, OSError) as error:
                            meter.observe_transport_error(error)
                            raise ContentEngineError("volcengine_outcome_unknown", f"火山{stage}连接中断或超时，结果不明，未自动重提。") from None
                        except (ValueError, UnicodeError):
                            raise ContentEngineError("volcengine_response_invalid", f"火山{stage}返回无法解析的结果，已停止。") from None
            except ProviderRateLimitRetry as retry:
                if retry.delay_seconds:
                    time.sleep(retry.delay_seconds)
                continue
            finally:
                if meter is not None:
                    self._last_request_usage = dict(meter.record)
        if last_meter is not None:
            self._last_request_usage = dict(last_meter.record)
        raise ContentEngineError("volcengine_request_rejected", f"火山{stage}请求被限流（HTTP 429），已达到本地重试上限，请稍后再试。")

    def _request_json(self, url, *, method="GET", payload=None, headers=None, timeout=None,
                      operation_label=None, retry_on_timeout=False):
        if url != ARK_ENDPOINT or method != "POST":
            raise ContentEngineError("volcengine_operation_unsupported", "当前功能尚未适配火山接口，不会调用百炼。")
        if not self.api_key:
            raise ContentEngineError("volcengine_ark_not_configured", "请在火山引擎设置中保存方舟 API Key。")
        body = {**payload, "thinking": {"type": "disabled"}}
        result = self._post(url, body, {"Authorization": f"Bearer {self.api_key}"}, timeout or self.timeout_seconds, "方舟", purpose=operation_label)
        return result

    def _structured_completion(self, **kwargs):
        try:
            result = super()._structured_completion(**kwargs)
            self.last_completion_metadata["provider"] = self.provider
            return result
        except ContentEngineError as error:
            raise ContentEngineError(error.code, str(error).replace("百炼", "火山方舟")) from None

    def synthesize_auto_mix_phrase(self, text, output_path, persona_private):
        if persona_private.get("provider") != "volcengine":
            raise ContentEngineError("auto_mix_voice_invalid", "请选用已批准的火山音色，例如小何 2.0。")
        return VolcengineTTSProvider(timeout_seconds=self.timeout_seconds, usage_data_dir=getattr(self, "usage_data_dir", None)).synthesize_auto_mix_phrase(text, output_path, persona_private)

    @staticmethod
    def asr_sentences(payload):
        items = []
        for item in (payload.get("result") or {}).get("utterances") or []:
            start, end, text = item.get("start_time"), item.get("end_time"), str(item.get("text") or "").strip()
            if type(start) is not int or type(end) is not int or start < 0 or end <= start or not text:
                continue
            words = [{"text": w["text"], "begin_time": w["start_time"], "end_time": w["end_time"]}
                     for w in item.get("words") or [] if isinstance(w, dict) and w.get("text")
                     and type(w.get("start_time")) is int and type(w.get("end_time")) is int
                     and start <= w["start_time"] < w["end_time"] <= end]
            items.append({"start_ms": start, "end_ms": end, "transcript": text, "speaker": "speaker-0",
                          "metadata": {"words": words, "sentence_complete": text.endswith(("。", "！", "？", ".", "!", "?")), "provider": "volcengine"}})
        return items

    def transcribe(self, audio_path, should_stop):
        if should_stop():
            raise ContentEngineError("task_cancelled", "任务已停止。")
        auth = self._asr_auth_headers()
        if audio_path.stat().st_size > 20 * 1024 * 1024:
            raise ContentEngineError("cloud_audio_too_large", "本次火山识别音频超过20MB，请缩短素材区间。")
        audio_ms = None
        try:
            with wave.open(str(audio_path), "rb") as audio:
                audio_ms = round(audio.getnframes() * 1000 / audio.getframerate())
        except (OSError, EOFError, wave.Error):
            pass
        result = self._post(ASR_ENDPOINT, {"user": {"uid": "xiaoxi-content-engine"},
            "audio": {"data": base64.b64encode(audio_path.read_bytes()).decode("ascii")},
            "request": {"model_name": "bigmodel", "show_utterances": True}},
            {**auth, "X-Api-Resource-Id": self.asr_model,
             "X-Api-Request-Id": str(uuid.uuid4()), "X-Api-Sequence": "-1"}, 180, "语音识别", requested_audio_ms=audio_ms)
        if should_stop():
            raise ContentEngineError("task_cancelled", "任务已停止。")
        sentences = self.asr_sentences(result)
        if (result.get("result") or {}).get("text") and not sentences:
            raise ContentEngineError("cloud_transcription_invalid", "火山识别返回了文字但没有可靠句子时间，已停止同步。")
        return sentences
