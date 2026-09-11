"""Volcengine TTS V3 SSE adapter; one submission, no automatic retries.

Protocol reference: https://www.volcengine.com/docs/6561/1598757
Official sample: bytedance/agentkit-samples, byted-text-to-speech.
"""

from __future__ import annotations

import base64
import binascii
import http.client
import io
import json
import os
from pathlib import Path
import re
import socket
import time
from typing import Any, Mapping
from urllib import request
from urllib.error import HTTPError, URLError
import uuid
import wave

from .errors import ContentEngineError
from .provider_usage import ProviderRequest, observe_http_error


TTS_ENDPOINT = os.environ.get(
    "XIAOXI_VOLCENGINE_TTS_API_URL",
    "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
).strip() or "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse"
SAMPLE_RATE = 24_000
SUPPORTED_MODELS = {"seed-tts-1.0", "seed-tts-2.0"}
MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 96 * 1024 * 1024
MAX_EVENT_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARACTERS = 10_000


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # X-Api-Key must never be forwarded to a different endpoint.
        return None


class VolcengineTTSProvider:
    def __init__(self, api_key: str | None = None, *, timeout_seconds: int = 90, usage_data_dir=None):
        self._api_key = str(
            os.environ.get("XIAOXI_VOLCENGINE_TTS_API_KEY", "")
            if api_key is None
            else api_key
        ).strip()
        self.timeout_seconds = max(10, min(120, int(timeout_seconds)))
        self.usage_data_dir = usage_data_dir

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    @staticmethod
    def _unknown(message: str) -> ContentEngineError:
        return ContentEngineError(
            "auto_mix_voice_outcome_unknown",
            f"{message}；为避免重复计费，已停止且不会自动重试。",
        )

    @staticmethod
    def _request_body(text: str, persona: Mapping[str, Any]) -> dict[str, Any]:
        provider = str(persona.get("provider") or "").strip()
        model = str(persona.get("provider_model") or "").strip()
        speaker = str(persona.get("provider_voice_id") or "").strip()
        if (
            provider != "volcengine"
            or model not in SUPPORTED_MODELS
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", speaker)
        ):
            raise ContentEngineError(
                "auto_mix_voice_persona_invalid", "火山语音的音色或模型配置无效。"
            )
        # The UI stores approved settings; no arbitrary instruction is submitted
        # to voices that have not explicitly advertised instruction support.
        return {
            "user": {"uid": "xiaoxi-content-engine"},
            "req_params": {
                "text": text,
                "speaker": speaker,
                "sample_rate": SAMPLE_RATE,
                "audio_params": {
                    "format": "pcm",
                    "sample_rate": SAMPLE_RATE,
                    "speech_rate": 0,
                    "loudness_rate": 0,
                },
                "additions": json.dumps(
                    {"disable_markdown_filter": True}, separators=(",", ":")
                ),
            },
        }

    def _read_audio(self, response, deadline: float, usage_observer=None) -> bytes:
        audio = bytearray()
        event_parts: list[bytes] = []
        event_size = 0
        response_size = 0
        completed = False

        def consume_event() -> None:
            nonlocal completed
            if not event_parts:
                return
            try:
                event = json.loads(b"\n".join(event_parts).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise self._unknown("火山语音返回的数据不完整") from None
            if not isinstance(event, dict):
                raise self._unknown("火山语音返回了无法识别的数据")
            if usage_observer is not None:
                usage_observer(event)
            code = event.get("code")
            if isinstance(code, bool) or not isinstance(code, int):
                raise self._unknown("火山语音未返回有效状态码")
            if code == 20000000:
                completed = True
                return
            if code != 0:
                # Only a numeric provider code is exposed, never message/body.
                raise ContentEngineError(
                    "cloud_request_rejected",
                    f"火山语音拒绝本次合成（代码 {code}），请检查音色权限、服务开通状态与额度。",
                )
            encoded = event.get("data")
            if encoded in (None, ""):
                return
            if not isinstance(encoded, str):
                raise self._unknown("火山语音返回了无效音频数据")
            try:
                chunk = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise self._unknown("火山语音返回的音频无法解码") from None
            if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
                raise self._unknown("火山语音返回的音频超出大小限制")
            audio.extend(chunk)

        while not completed:
            if time.monotonic() >= deadline:
                raise self._unknown("火山语音合成超时，提交结果无法确认")
            raw_line = response.readline(MAX_EVENT_BYTES + 1)
            if not raw_line:
                consume_event()
                break
            response_size += len(raw_line)
            if len(raw_line) > MAX_EVENT_BYTES or response_size > MAX_RESPONSE_BYTES:
                raise self._unknown("火山语音返回的数据超出大小限制")
            line = raw_line.rstrip(b"\r\n")
            if not line:
                consume_event()
                event_parts.clear()
                event_size = 0
            elif line.startswith(b"data:"):
                payload = line[5:].lstrip(b" ")
                event_size += len(payload)
                if event_size > MAX_EVENT_BYTES:
                    raise self._unknown("火山语音单次返回的数据超出大小限制")
                event_parts.append(payload)
            # Comments, event names and SSE ids do not contain audio.
        if not completed:
            raise self._unknown("火山语音连接已结束，但未确认合成完成")
        if not audio or len(audio) % 2:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "火山语音未返回完整的 PCM 音频。"
            )
        return bytes(audio)

    def synthesize_auto_mix_phrase(
        self,
        text: str,
        output_path: Path,
        persona_private: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not self.configured:
            raise ContentEngineError(
                "volcengine_tts_not_configured", "请先在声音设置中配置火山语音 API Key。"
            )
        normalized = re.sub(r"\s+", " ", str(text or "")).strip()
        if (
            not normalized
            or len(normalized) > MAX_TEXT_CHARACTERS
            or not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", normalized)
        ):
            raise ContentEngineError("auto_mix_voice_invalid", "口播文本为空或过长。")
        persona = dict(persona_private or {})
        body = self._request_body(normalized, persona)
        request_id = str(uuid.uuid4())
        request_headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "X-Api-Key": self._api_key,
            "X-Api-Resource-Id": persona["provider_model"],
            "X-Api-Request-Id": request_id,
            # Official V3 contract returns billing characters in the final SSE event.
            "X-Control-Require-Usage-Tokens-Return": "text_words",
        }
        gateway_token = os.environ.get("XIAOXI_PROVIDER_GATEWAY_TOKEN", "").strip()
        gateway_origin = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").strip().rstrip("/")
        if gateway_token and gateway_origin and TTS_ENDPOINT.startswith(f"{gateway_origin}/v1/provider-gateway/"):
            request_headers["Authorization"] = f"Bearer {gateway_token}"
        operation = request.Request(
            TTS_ENDPOINT,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=request_headers,
            method="POST",
        )
        deadline = time.monotonic() + self.timeout_seconds
        meter = ProviderRequest(provider="volcengine", kind="tts", model=persona["provider_model"],
                                purpose="短语配音", request_id=request_id, requested_characters=len(normalized),
                                data_dir=self.usage_data_dir)
        try:
            with meter:
                try:
                    # A private opener avoids changing the sidecar's global HTTP policy.
                    opener = request.build_opener(_NoRedirect())
                    with opener.open(operation, timeout=self.timeout_seconds) as response:
                        meter.observe(headers=getattr(response, "headers", None), http_status=getattr(response, "status", 200))
                        pcm = self._read_audio(response, deadline, meter.observe)
                        meter.observe(generated_audio_ms=round(len(pcm) * 1000 / (2 * SAMPLE_RATE)))
                except ContentEngineError:
                    raise
                except HTTPError as error:
                    observe_http_error(meter, error)
                    status = int(error.code or 0)
                    if status in {401, 403}:
                        message = "火山语音鉴权失败，请检查 API Key、服务开通与音色权限。"
                    elif status == 429:
                        message = "火山语音额度不足或请求限流，请检查用量。"
                    elif 400 <= status < 500:
                        message = "火山语音未接受当前参数，请检查音色与模型是否匹配。"
                    else:
                        message = "火山语音服务请求失败，请稍后检查服务状态。"
                    raise ContentEngineError("cloud_request_failed", f"{message}（HTTP {status}）") from None
                except (TimeoutError, socket.timeout, URLError, OSError, http.client.HTTPException):
                    raise self._unknown("火山语音连接中断，提交结果无法确认") from None
        finally:
            self.last_request_usage = dict(meter.record)

        frame_count = len(pcm) // 2
        wav_buffer = io.BytesIO()
        with wave.open(wav_buffer, "wb") as output_wav:
            output_wav.setnchannels(1)
            output_wav.setsampwidth(2)
            output_wav.setframerate(SAMPLE_RATE)
            output_wav.writeframes(pcm)
        destination = Path(output_path)
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_bytes(wav_buffer.getvalue())
            temporary.replace(destination)
        except OSError:
            raise ContentEngineError(
                "auto_mix_voice_write_failed", "配音已经返回，但本地音频保存失败。"
            ) from None
        finally:
            if temporary.is_file():
                temporary.unlink(missing_ok=True)
        return {
            "provider": "volcengine",
            "model": persona["provider_model"],
            "format": "wav",
            "sample_rate": SAMPLE_RATE,
            "frame_count": frame_count,
            "duration_ms": round(frame_count * 1000 / SAMPLE_RATE),
            "request_id": request_id,
            "audio_id": request_id,
            "billed_characters": meter.record["billed_characters"],
            "provider_usage_call_id": meter.record["call_id"],
        }
