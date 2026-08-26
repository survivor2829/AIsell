from __future__ import annotations

import base64
import hashlib
import http.client
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import time
from typing import Any, Callable
from urllib import parse, request
from urllib.error import HTTPError, URLError
import uuid
import wave

from .apimart_cover import (
    ProviderResponseTooLarge,
    ProviderUrlError,
    provider_urlopen,
    public_https_get,
)
from .auto_mix_resources import (
    AUTO_MIX_TTS_MODEL,
    BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES,
    MAX_VOICE_PREVIEW_BYTES,
    VOICE_PREFIX,
    VOICE_PREVIEW_SAMPLE,
)
from .auto_mix_v2 import guided_script_audience_copy_issue
from .errors import ContentEngineError
from .product_pipeline import normalize_product_context
from .render_mix import discover_media_executable, _windows_process_options


DEFAULT_ANALYSIS_VERSION = "creative-v5-bulk-visual-evidence"
DEFAULT_ASR_MODEL = "paraformer-v2"
DEFAULT_VISION_MODEL = "qwen-vl-plus"
DEFAULT_SELECTION_MODEL = "qwen-plus"
DEFAULT_DASHSCOPE_ORIGIN = "https://dashscope.aliyuncs.com"
DEFAULT_CLOUD_TIMEOUT_SECONDS = 90
MAX_CLOUD_TIMEOUT_SECONDS = 300
AUTO_MIX_TTS_ENDPOINT = "/api/v1/services/audio/tts/SpeechSynthesizer"
AUTO_MIX_VOICE_DESIGN_ENDPOINT = "/api/v1/services/audio/tts/customization"
AUTO_MIX_TTS_SAMPLE_RATE = 24_000
AUTO_MIX_TTS_MAX_INSTRUCTION_UNITS = 100
ANALYSIS_MANIFEST_NAME = "analysis-manifest.json"
MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024
MAX_TRANSCRIPTION_JSON_BYTES = 32 * 1024 * 1024
MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024
MAX_TTS_AUDIO_BYTES = 64 * 1024 * 1024
MOTION_EVENT_TYPES = {
    "hook",
    "keyword",
    "emphasis",
    "step",
    "scene",
    "result",
    "warning",
    "quote",
}
MOTION_LAYOUT_ZONES = {
    "top_banner",
    "upper_left",
    "upper_right",
    "middle_left",
    "middle_right",
}
MOTION_EVENT_SIZES = {"hero", "card", "chip"}
MIN_MOTION_TEXT_GROUNDING = 0.6
LOCAL_VISUAL_SIGNAL_VERSION = "ffmpeg-gray64-sequence-v4"
LOCAL_VISUAL_SAMPLE_SIZE = 64
LOCAL_VISUAL_SAMPLE_BYTES = LOCAL_VISUAL_SAMPLE_SIZE * LOCAL_VISUAL_SAMPLE_SIZE
LOCAL_FREEZE_MIN_SPAN_MS = 2_000
LOCAL_VISUAL_EVIDENCE_INTERVAL_MS = 2_000
LOCAL_VISUAL_MAX_EVIDENCE_BYTES = 64 * 1024 * 1024


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _balanced_json_candidates(text: str):
    """Yield balanced JSON objects embedded in a provider text response.

    Models sometimes wrap an otherwise valid JSON object in a sentence or a
    markdown fence.  This scanner deliberately understands quoted strings and
    escapes instead of trying to repair JSON with unsafe eval-like methods.
    """
    for start, character in enumerate(text):
        if character != "{":
            continue
        depth = 0
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            current = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    in_string = False
                continue
            if current == '"':
                in_string = True
            elif current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    yield text[start : index + 1]
                    break
                if depth < 0:
                    break


def _safe_json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not text:
        raise ContentEngineError("cloud_response_invalid", "百炼返回了无法解析的结果。")
    # Remove fences wherever the model put them, then try the complete value
    # before scanning for a JSON object embedded in explanatory prose.
    cleaned = re.sub(r"```(?:json)?", "", text, flags=re.I).replace("```", "").strip()
    candidates = [cleaned]
    if cleaned != text:
        candidates.append(text)
    candidates.extend(_balanced_json_candidates(cleaned))
    candidates.extend(_balanced_json_candidates(text))
    seen = set()
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ContentEngineError("cloud_response_invalid", "百炼返回了无法解析的结果。")


def _read_bounded(response, maximum: int, code: str, message: str) -> bytes:
    raw = response.read(maximum + 1)
    if len(raw) > maximum:
        raise ContentEngineError(code, message)
    return raw


def _normalize_https_origin(value: str, *, field: str) -> str:
    candidate = str(value or "").strip().rstrip("/")
    parsed = parse.urlsplit(candidate)
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ContentEngineError(
            "cloud_origin_invalid", f"{field} must be a complete HTTPS origin."
        )
    try:
        port = parsed.port
    except ValueError as error:
        raise ContentEngineError(
            "cloud_origin_invalid", f"{field} contains an invalid port."
        ) from error
    if port not in {None, 443}:
        raise ContentEngineError(
            "cloud_origin_invalid", f"{field} must use the HTTPS port."
        )
    return candidate


def _bailian_tts_https_download_url(value: str) -> str:
    """Upgrade only DashScope's documented temporary OSS audio URL to HTTPS.

    Qwen-TTS may return an ``http`` OSS URL even though the same signed object
    is available over HTTPS.  Keep the generic public downloader HTTPS-only;
    this narrow compatibility bridge is deliberately limited to the official
    DashScope result bucket pattern and still runs the normal DNS/IP checks.
    """
    url = str(value or "").strip()
    parsed = parse.urlsplit(url)
    if parsed.scheme.casefold() != "http":
        return url
    hostname = str(parsed.hostname or "").casefold().rstrip(".")
    is_dashscope_result_bucket = (
        hostname.startswith("dashscope-result-")
        and ".oss-cn-" in hostname
        and hostname.endswith(".aliyuncs.com")
    )
    if not is_dashscope_result_bucket:
        raise ProviderUrlError(
            "Bailian TTS HTTP download URL is not an official result bucket."
        )
    return parse.urlunsplit(parsed._replace(scheme="https"))


class DashScopeMediaClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        origin: str | None = None,
        compatible_origin: str | None = None,
        asr_model: str | None = None,
        vision_model: str | None = None,
        selection_model: str | None = None,
        timeout_seconds: int | None = None,
    ):
        self.api_key = str(api_key or os.environ.get("DASHSCOPE_API_KEY") or "").strip()
        # Provider origins are not inherited from the launch environment. The
        # saved key may only leave through the official defaults in production;
        # explicit constructor overrides remain available to isolated tests.
        configured_origin = os.environ.get("XIAOXI_BAILIAN_API_HOST", "").strip()
        self.origin = _normalize_https_origin(
            origin
            if origin is not None
            else (configured_origin or DEFAULT_DASHSCOPE_ORIGIN),
            field="DashScope origin",
        )
        self.compatible_origin = _normalize_https_origin(
            compatible_origin
            if compatible_origin is not None
            else f"{self.origin}/compatible-mode/v1",
            field="DashScope compatible origin",
        )
        self.asr_model = str(
            asr_model or os.environ.get("XIAOXI_BAILIAN_ASR_MODEL") or DEFAULT_ASR_MODEL
        ).strip()
        self.vision_model = str(
            vision_model
            or os.environ.get("XIAOXI_BAILIAN_VISION_MODEL")
            or DEFAULT_VISION_MODEL
        ).strip()
        self.selection_model = str(
            selection_model
            or os.environ.get("XIAOXI_BAILIAN_SELECTION_MODEL")
            or DEFAULT_SELECTION_MODEL
        ).strip()
        self.tts_model = str(
            os.environ.get("XIAOXI_BAILIAN_TTS_MODEL") or "qwen3-tts-flash"
        ).strip()
        self.tts_voice = str(
            os.environ.get("XIAOXI_BAILIAN_TTS_VOICE") or "Cherry"
        ).strip()
        configured_timeout = timeout_seconds
        if configured_timeout is None:
            configured_timeout = os.environ.get(
                "XIAOXI_BAILIAN_TIMEOUT_SECONDS", DEFAULT_CLOUD_TIMEOUT_SECONDS
            )
        try:
            configured_timeout = int(configured_timeout)
        except (TypeError, ValueError):
            configured_timeout = DEFAULT_CLOUD_TIMEOUT_SECONDS
        self.timeout_seconds = min(
            MAX_CLOUD_TIMEOUT_SECONDS, max(5, configured_timeout)
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _request_json(
        self,
        url: str,
        *,
        method: str = "GET",
        payload: Any = None,
        headers: dict[str, str] | None = None,
        timeout: int | None = None,
        operation_label: str | None = None,
        retry_on_timeout: bool = False,
    ) -> dict[str, Any]:
        request_headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            **(headers or {}),
        }
        data = None
        if payload is not None:
            data = _json_bytes(payload)
            request_headers.setdefault("Content-Type", "application/json")
        operation = request.Request(url, data=data, headers=request_headers, method=method)
        attempts = 2 if retry_on_timeout else 1
        label = str(operation_label or "").strip()
        timeout_value = timeout or self.timeout_seconds
        for attempt in range(attempts):
            try:
                with provider_urlopen(operation, timeout=timeout_value) as response:
                    raw = _read_bounded(
                        response,
                        MAX_PROVIDER_JSON_BYTES,
                        "cloud_response_too_large",
                        "百炼返回的数据超过安全大小限制。",
                    )
                break
            except ContentEngineError:
                raise
            except HTTPError as error:
                status = int(getattr(error, "code", 0) or 0)
                if status in {401, 403}:
                    message = f"百炼请求被拒绝（HTTP {status}），请检查 API Key、业务空间和模型权限。"
                elif status == 429:
                    message = "百炼请求被限流或额度不足（HTTP 429），请检查用量与套餐。"
                elif 400 <= status < 500:
                    message = f"百炼请求参数未被接受（HTTP {status}），请检查接口地址和模型配置。"
                elif status >= 500:
                    message = f"百炼服务暂时不可用（HTTP {status}），请稍后重试。"
                else:
                    message = "百炼请求失败，请检查网络与配置。"
                raise ContentEngineError("cloud_request_failed", message) from error
            except (TimeoutError, socket.timeout) as error:
                if attempt + 1 < attempts:
                    continue
                prefix = f"百炼{label}请求" if label else "百炼请求"
                raise ContentEngineError(
                    "cloud_request_failed",
                    f"{prefix}超时（{timeout_value} 秒），请检查网络或稍后重试。",
                ) from error
            except URLError as error:
                raise ContentEngineError(
                    "cloud_request_failed",
                    "无法连接阿里百炼，请检查网络、接口地址和代理设置。",
                ) from error
            except Exception as error:
                raise ContentEngineError(
                    "cloud_request_failed", "无法连接阿里百炼，请检查网络与配置。"
                ) from error
        try:
            result = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ContentEngineError("cloud_response_invalid", "百炼返回了无效数据。") from error
        if not isinstance(result, dict):
            raise ContentEngineError("cloud_response_invalid", "百炼返回了无效数据。")
        if result.get("code"):
            raise ContentEngineError("cloud_request_rejected", "百炼拒绝了本次分析请求。")
        return result

    @staticmethod
    def _message_content(message: Any) -> str:
        if not isinstance(message, dict):
            return ""
        content = message.get("content")
        if isinstance(content, list):
            return "".join(
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict)
            )
        if isinstance(content, dict):
            return json.dumps(content, ensure_ascii=False, separators=(",", ":"))
        return str(content or "")

    def _structured_completion(
        self,
        *,
        messages: list[dict[str, Any]],
        model: str,
        empty_code: str,
        empty_message: str,
        parse_code: str = "cloud_response_invalid",
        parse_message: str = "百炼返回了无法解析的结果。",
        operation_label: str | None = None,
        validate: Callable[[dict[str, Any]], bool] | None = None,
        validation_error: Callable[[dict[str, Any]], str | None] | None = None,
        validation_retry_context: (
            Callable[[str, dict[str, Any]], list[dict[str, Any]] | None] | None
        ) = None,
    ) -> dict[str, Any]:
        """Request one JSON response, with one bounded correction retry.

        Provider/network/authentication failures are raised by _request_json and
        are never retried here. Only an empty choices array, malformed model
        text, or an explicit schema validation failure gets the second request,
        avoiding an unbounded paid retry loop.
        """
        def failure_message(message: str, issue: str) -> str:
            safe_issue = re.sub(r"\s+", " ", str(issue or "")).strip()[:240]
            if not safe_issue:
                return message
            return f"{str(message or '').rstrip('。；;：: ')}：{safe_issue}。"

        previous_issue = ""
        previous_item: dict[str, Any] | None = None
        for attempt in range(2):
            request_messages = [dict(message) for message in messages]
            if attempt:
                retry_instruction = (
                    f"上一次输出未通过校验：{previous_issue or '返回内容不是可解析的 JSON 对象。'}"
                    "请按原始要求完整修正。现在只返回一个合法的 JSON 对象；"
                    "不要解释、不要 Markdown 代码围栏、不要在 JSON 前后添加任何文字。"
                )
                retry_context = (
                    validation_retry_context(previous_issue, previous_item)
                    if previous_item is not None
                    and validation_retry_context is not None
                    else None
                )
                if retry_context:
                    request_messages.extend(
                        dict(message)
                        for message in retry_context
                        if isinstance(message, dict)
                    )
                elif request_messages:
                    last = dict(request_messages[-1])
                    content = last.get("content")
                    if isinstance(content, list):
                        last["content"] = [*content, {"type": "text", "text": retry_instruction}]
                    else:
                        last["content"] = f"{str(content or '').rstrip()}\n\n{retry_instruction}"
                    request_messages[-1] = last
            response = self._request_json(
                f"{self.compatible_origin}/chat/completions",
                method="POST",
                payload={
                    "model": model,
                    "messages": request_messages,
                    "temperature": 0.0 if attempt else 0.1,
                    "response_format": {"type": "json_object"},
                },
                operation_label=operation_label,
            )
            choices = response.get("choices") or []
            if not choices:
                previous_issue = "没有返回可用结果。"
                if attempt == 0:
                    continue
                raise ContentEngineError(
                    empty_code, failure_message(empty_message, previous_issue)
                )
            message = choices[0].get("message") if isinstance(choices[0], dict) else None
            try:
                parsed = _safe_json_object(self._message_content(message))
            except ContentEngineError as error:
                if error.code == "cloud_response_invalid":
                    previous_issue = "返回内容不是可解析的 JSON 对象。"
                    if attempt == 0:
                        continue
                raise ContentEngineError(
                    parse_code, failure_message(parse_message, previous_issue)
                ) from error
            if validation_error is not None:
                validation_issue = validation_error(parsed)
                if validation_issue is not None:
                    previous_issue = re.sub(r"\s+", " ", str(validation_issue)).strip()[:240]
                    previous_item = parsed
                    if not previous_issue:
                        previous_issue = "返回内容不符合预期字段或内容要求。"
                    if attempt == 0:
                        continue
                    raise ContentEngineError(
                        parse_code, failure_message(parse_message, previous_issue)
                    )
            if validate is not None and not validate(parsed):
                previous_issue = "返回内容不符合预期字段或内容要求。"
                previous_item = parsed
                if attempt == 0:
                    continue
                raise ContentEngineError(
                    parse_code, failure_message(parse_message, previous_issue)
                )
            return parsed
        raise ContentEngineError(
            parse_code, failure_message(parse_message, previous_issue)
        )

    def generate_product_script(
        self, brief: dict[str, Any], assets: list[dict[str, Any]], *, count: int = 3
    ) -> dict[str, Any]:
        """Generate one structured product-showcase script, with strict JSON retry."""
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        product_name = str((brief or {}).get("product_name") or "").strip()
        requested_voiceover_max = (brief or {}).get("voiceover_max_chars")
        requested_voiceover_min = (brief or {}).get("voiceover_min_chars")
        requested_sentence_count = (brief or {}).get("voiceover_min_sentence_count")
        guided_storyboard = bool((brief or {}).get("guided_storyboard"))
        if requested_voiceover_max is None:
            voiceover_rule = "voiceover 控制在 140 到 260 个汉字，适合 60 到 90 秒中文配音；"
            voiceover_max_chars = 260
            voiceover_min_chars = 0
            voiceover_min_sentence_count = 0
        else:
            try:
                voiceover_max_chars = int(requested_voiceover_max)
                voiceover_min_chars = int(requested_voiceover_min)
                voiceover_min_sentence_count = int(requested_sentence_count)
            except (TypeError, ValueError):
                voiceover_max_chars = 0
                voiceover_min_chars = 0
                voiceover_min_sentence_count = 0
            if not (
                8 <= voiceover_min_chars <= voiceover_max_chars <= 260
                and 2 <= voiceover_min_sentence_count <= 12
            ):
                raise ContentEngineError(
                    "product_copy_invalid", "素材时长对应的口播字数或分段要求无效。"
                )
            voiceover_rule = (
                f"voiceover 必须在 {voiceover_min_chars} 到 {voiceover_max_chars} 个汉字之间，"
                f"由不少于 {voiceover_min_sentence_count} 句完整、自然的中文短句组成；"
                "按开场、现场过程、适用场景、真实价值和收束组织，不能只写一句概述；"
            )
        retry_target_chars = min(
            voiceover_max_chars,
            max(
                voiceover_min_chars,
                (voiceover_min_chars + voiceover_max_chars + 1) // 2,
            ),
        )
        retry_target_floor = max(voiceover_min_chars, retry_target_chars - 5)
        retry_target_ceiling = min(voiceover_max_chars, retry_target_chars + 5)
        identity_rule = (
            "brief 中的 product_name 是不可变的商品身份；全文只能围绕该商品，"
            "不得替换成相近品类或凭空加入厨房、餐具、洗碗机等未被素材证明的内容。"
            if product_name
            else
            "brief 没有指定商品名称；不要猜测具体品类、品牌、参数或使用场景，只能根据输入的"
            "visual_evidence、transcript_evidence 和素材标签写通用的效果展示解说。"
        )
        if guided_storyboard:
            output_schema_rule = (
                "输出严格 JSON 对象，字段必须包括 hook、voiceover、cta。"
                "不需要 title_candidates、shots 或 bgm_mood，也不得输出解释或额外字段。"
                "hook 必须逐字复制 voiceover 的第一句，cta 必须逐字复制 voiceover 的最后一句，"
                "两者都要保留原句末尾标点。"
            )
            guided_delivery_rule = (
                "提交前请在内部逐项自检：voiceover 去掉空白后（标点也计入）必须在 "
                f"{voiceover_min_chars} 到 {voiceover_max_chars} 个字符之间，优先写到 "
                f"{retry_target_floor} 到 {retry_target_ceiling} 个字符，并至少有 "
                f"{voiceover_min_sentence_count} 句完整自然短句；确认 hook 与 cta 分别逐字复制"
                "正文首句和末句后，才返回 JSON。"
            )
        else:
            output_schema_rule = (
                "输出严格 JSON 对象，字段必须包括 title_candidates(字符串数组)、hook、voiceover、"
                "shots(数组)、cta、bgm_mood。shots 每项包括 asset_id、asset_tags、caption、action。"
            )
            guided_delivery_rule = ""
        prompt = (
            "你是商品展示短视频的中文编导。根据真实素材摘要写一份可渲染脚本。"
            "不得虚构产品参数、客户评价、效果数据或素材中不存在的画面。"
            "voiceover 就是成片中实际念出的口播，并会逐字生成同文字幕；必须面向普通观众，"
            "使用自然、通俗、连贯的中文短句，按画面顺序说清楚产品在做什么、适合什么场景、"
            "能带来什么已被素材或用户确认的信息。素材标签和镜头类型只是理解依据，必须改写成"
            "观众听得懂的话，禁止照抄标签清单、内部镜头名称或编辑说明，禁止出现“素材画面记录了”、"
            "“素材包含”、“过程记录镜头”、“结果展示镜头”、“已确认场景”、“继续查看真实素材”"
            "或“真实现场记录”等元话语。不得为了满足字数重复同义句。hook 和 cta 也必须自然、"
            "具体，并与 product_name、selling_points 和真实画面一致。hook 必须是 voiceover 开头"
            "的完整原句，cta 必须是 voiceover 结尾的完整原句，确保开场、口播、字幕和收束使用同一套"
            "文案。brief 中 must_include 里的“不要写”、“仅使用”等内容属于生成约束，不能原样念给观众。"
            + identity_rule
            + output_schema_rule
            + voiceover_rule
            + guided_delivery_rule
            + ("" if guided_storyboard else "镜头只引用输入 asset_id。")
            + "输入 brief="
            + json.dumps(brief or {}, ensure_ascii=False, separators=(",", ":"))
            + "，素材="
            + json.dumps(assets[:80], ensure_ascii=False, separators=(",", ":"))
            + f"，候选数量={max(1, min(3, int(count)))}。"
        )
        allowed_asset_ids = {
            str(asset.get("asset_id") or "").strip()
            for asset in assets
            if isinstance(asset, dict) and str(asset.get("asset_id") or "").strip()
        }

        def product_script_validation_error(item: dict[str, Any]) -> str | None:
            issues = []
            title_candidates = item.get("title_candidates")
            if (
                not guided_storyboard
                and (not isinstance(title_candidates, list) or not title_candidates)
            ):
                issues.append("title_candidates 必须是非空数组")
            hook = item.get("hook")
            if not isinstance(hook, str) or not hook.strip():
                issues.append("hook 必须是非空字符串")
            voiceover = item.get("voiceover")
            if not isinstance(voiceover, str):
                issues.append("voiceover 必须是字符串")
            else:
                compact = re.sub(r"\s+", "", voiceover)
                if not compact:
                    issues.append("voiceover 不能为空")
                if len(compact) > voiceover_max_chars:
                    issues.append(
                        f"voiceover 去空白后为 {len(compact)} 个字符，最多允许 "
                        f"{voiceover_max_chars} 个字符"
                    )
                if guided_storyboard:
                    if len(compact) < voiceover_min_chars:
                        issues.append(
                            f"voiceover 去空白后为 {len(compact)} 个字符，至少需要 "
                            f"{voiceover_min_chars} 个字符"
                        )
                    sentence_count = len(
                        [
                            sentence
                            for sentence in re.split(r"[。！？!?；;]+|\n+", voiceover)
                            if sentence.strip()
                        ]
                    )
                    if sentence_count < voiceover_min_sentence_count:
                        issues.append(
                            f"voiceover 只有 {sentence_count} 句，至少需要 "
                            f"{voiceover_min_sentence_count} 句；每句请用句号等结束"
                        )
            shots = item.get("shots")
            if not guided_storyboard and (not isinstance(shots, list) or not shots):
                issues.append("shots 必须是非空数组")
            elif not guided_storyboard:
                missing_asset_count = 0
                unknown_asset_count = 0
                for shot in shots:
                    asset_id = (
                        str(shot.get("asset_id") or "").strip()
                        if isinstance(shot, dict)
                        else ""
                    )
                    if not asset_id:
                        missing_asset_count += 1
                    elif allowed_asset_ids and asset_id not in allowed_asset_ids:
                        unknown_asset_count += 1
                if missing_asset_count:
                    issues.append(
                        f"shots 有 {missing_asset_count} 项缺少非空的 asset_id"
                    )
                if unknown_asset_count:
                    issues.append(
                        f"shots 有 {unknown_asset_count} 项引用了未提供的 asset_id"
                    )
            cta = item.get("cta")
            if not isinstance(cta, str) or not cta.strip():
                issues.append("cta 必须是非空字符串")
            if guided_storyboard and isinstance(voiceover, str):
                audience_issue = guided_script_audience_copy_issue(
                    hook, voiceover, cta
                )
                if audience_issue:
                    issues.append(audience_issue)
            return "；".join(issues) + "。" if issues else None

        def product_script_retry_context(
            issue: str, previous_item: dict[str, Any]
        ) -> list[dict[str, Any]]:
            previous_voiceover = re.sub(
                r"\s+", " ", str(previous_item.get("voiceover") or "")
            ).strip()[:1_200]
            previous_draft = {
                "hook": re.sub(
                    r"\s+", " ", str(previous_item.get("hook") or "")
                ).strip()[:160],
                "voiceover": previous_voiceover,
                "cta": re.sub(
                    r"\s+", " ", str(previous_item.get("cta") or "")
                ).strip()[:160],
            }
            previous_char_count = len(re.sub(r"\s+", "", previous_voiceover))
            missing_chars = max(0, voiceover_min_chars - previous_char_count)
            return [
                {
                    "role": "assistant",
                    "content": json.dumps(
                        previous_draft,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "请基于上面这份你刚生成的百炼初稿，定向改写成可直接交付的完整 JSON，"
                        "不要重新概述，也不要省略字段。"
                        f"本次校验问题：{issue}。"
                        f"voiceover 去空白后（标点也计入）必须在 {voiceover_min_chars} 到 "
                        f"{voiceover_max_chars} 个字符之间，优先写到 {retry_target_floor} 到 "
                        f"{retry_target_ceiling} 个字符，并至少有 "
                        f"{voiceover_min_sentence_count} 句完整自然短句。"
                        + (
                            f"当前初稿还差至少 {missing_chars} 个字符；"
                            if missing_chars
                            else ""
                        )
                        + "不要只在结尾生硬补一句；请顺着真实画面把整段口播改得自然、通俗、连贯。"
                        "请先在内部完成三项检查再回复：第一，字数和完整短句数都达标；第二，hook 必须逐字"
                        "复制 voiceover 的第一句并保留末尾标点；第三，cta 必须逐字复制 voiceover 的"
                        "最后一句并保留末尾标点。保留真实产品身份和已证实画面，不要虚构，不要解释，只返回完整 JSON。"
                    ),
                },
            ]

        parsed = self._structured_completion(
            messages=[{"role": "user", "content": prompt}],
            model=self.selection_model,
            empty_code="product_copy_invalid",
            empty_message="百炼没有返回商品文案。",
            parse_code="product_copy_invalid",
            parse_message="百炼商品文案未通过结构化校验。",
            operation_label="商品文案",
            validation_error=product_script_validation_error,
            validation_retry_context=(
                product_script_retry_context if guided_storyboard else None
            ),
        )
        return {**parsed, "schema_version": 1, "provider": "bailian"}

    def synthesize_product_voice(self, text: str, output_path: Path) -> dict[str, Any]:
        """Use Bailian's native non-streaming Qwen-TTS endpoint and persist audio."""
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        normalized = re.sub(r"\s+", " ", str(text or "")).strip()
        if not normalized:
            raise ContentEngineError("product_voice_invalid", "商品配音文案为空。")
        response = self._request_json(
            f"{self.origin}/api/v1/services/aigc/multimodal-generation/generation",
            method="POST",
            payload={
                "model": self.tts_model,
                "input": {
                    "text": normalized[:4_000],
                    "voice": self.tts_voice,
                    "language_type": "Chinese",
                },
            },
            timeout=max(self.timeout_seconds, 120),
            operation_label="中文配音",
        )
        output = response.get("output")
        audio = output.get("audio") if isinstance(output, dict) else None
        if not isinstance(audio, dict):
            raise ContentEngineError(
                "product_voice_invalid", "百炼没有返回可用的配音文件。"
            )
        encoded = audio.get("data")
        audio_url = str(audio.get("url") or "").strip()
        try:
            if isinstance(encoded, str) and encoded.strip():
                raw = base64.b64decode(encoded, validate=True)
            elif audio_url:
                status, raw = public_https_get(
                    _bailian_tts_https_download_url(audio_url),
                    timeout=max(self.timeout_seconds, 120),
                    max_bytes=MAX_TTS_AUDIO_BYTES,
                    headers={"User-Agent": "Xiaoxi-Creative-Workbench/1.0"},
                )
                if status < 200 or status >= 300:
                    raise ContentEngineError(
                        "product_voice_download_failed",
                        f"百炼配音文件下载失败（HTTP {status}），请稍后重试。",
                    )
            else:
                raise ContentEngineError(
                    "product_voice_invalid", "百炼没有返回可用的配音文件。"
                )
        except ProviderResponseTooLarge as error:
            raise ContentEngineError(
                "product_voice_too_large", "百炼配音结果超过安全大小限制。"
            ) from error
        except ProviderUrlError as error:
            raise ContentEngineError(
                "product_voice_download_failed", "百炼返回的配音下载地址无效。"
            ) from error
        except ContentEngineError:
            raise
        except Exception as error:
            raise ContentEngineError(
                "product_voice_download_failed", "百炼配音文件下载失败，请稍后重试。"
            ) from error
        if not raw or len(raw) < 44:
            raise ContentEngineError("product_voice_invalid", "百炼返回的配音为空。")
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(raw)
        return {"provider": "bailian", "model": self.tts_model, "voice": self.tts_voice}

    def design_auto_mix_voice(
        self,
        output_path: Path,
        persona_private: dict[str, Any],
    ) -> dict[str, Any]:
        """Create one private CosyVoice persona and persist its returned preview.

        The provider voice identifier is returned only to the private domain
        layer. Network-ambiguous results fail closed because a second create
        request could allocate another provider resource.
        """
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        try:
            persona = dict(persona_private or {})
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_voice_design_invalid", "声音设计模板无效。"
            ) from error
        model = str(
            persona.get("provider_model") or persona.get("model") or ""
        ).strip()
        voice_prompt = re.sub(
            r"\s+", " ", str(persona.get("voice_prompt") or "")
        ).strip()
        voice_prefix = str(persona.get("voice_prefix") or "").strip()
        if (
            model != AUTO_MIX_TTS_MODEL
            or not voice_prompt
            or len(voice_prompt) > 500
            or not VOICE_PREFIX.fullmatch(voice_prefix)
        ):
            raise ContentEngineError(
                "auto_mix_voice_design_invalid", "声音设计模板无效。"
            )
        try:
            response = self._request_json(
                f"{self.origin}{AUTO_MIX_VOICE_DESIGN_ENDPOINT}",
                method="POST",
                payload={
                    "model": "voice-enrollment",
                    "input": {
                        "action": "create_voice",
                        "target_model": AUTO_MIX_TTS_MODEL,
                        "voice_prompt": voice_prompt,
                        "preview_text": VOICE_PREVIEW_SAMPLE,
                        "prefix": voice_prefix,
                        "language_hints": ["zh"],
                    },
                    "parameters": {
                        "sample_rate": AUTO_MIX_TTS_SAMPLE_RATE,
                        "response_format": "wav",
                    },
                },
                timeout=max(self.timeout_seconds, 120),
                operation_label="V2 声音设计",
                retry_on_timeout=False,
            )
        except ContentEngineError as error:
            cause = error.__cause__
            status = (
                int(getattr(cause, "code", 0) or 0)
                if isinstance(cause, HTTPError)
                else 0
            )
            outcome_unknown = (
                error.code in {"cloud_response_invalid", "cloud_response_too_large"}
                or (
                    error.code == "cloud_request_failed"
                    and (not isinstance(cause, HTTPError) or status >= 500)
                )
            )
            if outcome_unknown:
                raise ContentEngineError(
                    "auto_mix_voice_design_outcome_unknown",
                    "声音设计提交结果不明，已停止且不会自动重试。",
                ) from error
            raise

        request_id = str(response.get("request_id") or "").strip()
        output = response.get("output")
        voice_id = (
            str(output.get("voice_id") or "").strip()
            if isinstance(output, dict)
            else ""
        )
        target_model = (
            str(output.get("target_model") or "").strip()
            if isinstance(output, dict)
            else ""
        )
        preview = output.get("preview_audio") if isinstance(output, dict) else None
        encoded = (
            str(preview.get("data") or "").strip()
            if isinstance(preview, dict)
            else ""
        )
        response_format = (
            str(preview.get("response_format") or "").strip().casefold()
            if isinstance(preview, dict)
            else ""
        )
        if (
            not request_id
            or target_model != AUTO_MIX_TTS_MODEL
            or not voice_id
            or len(voice_id) > 300
            or any(character.isspace() for character in voice_id)
            or response_format != "wav"
            or not encoded
        ):
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "百炼声音设计结果无法确认，已停止且不会自动重试。",
            )
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "百炼声音设计结果无法确认，已停止且不会自动重试。",
            ) from error
        if not 0 < len(raw) <= MAX_VOICE_PREVIEW_BYTES:
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "百炼声音设计试听文件无效，已停止且不会自动重试。",
            )
        try:
            raw, wav_info = self._normalize_auto_mix_wav(raw)
        except ContentEngineError as error:
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "百炼声音设计试听文件无效，已停止且不会自动重试。",
            ) from error
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(raw)
            temporary.replace(destination)
        except OSError as error:
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "声音已经提交设计，但本地试听文件状态不明；不会自动重试。",
            ) from error
        finally:
            temporary.unlink(missing_ok=True)
        return {
            "provider": "bailian",
            "model": AUTO_MIX_TTS_MODEL,
            "provider_voice_id": voice_id,
            "format": "wav",
            "sample_rate": wav_info["sample_rate"],
            "duration_ms": wav_info["duration_ms"],
        }

    def reconcile_auto_mix_voice_design(
        self, persona_private: dict[str, Any]
    ) -> dict[str, Any]:
        """Observe a prior ambiguous create without submitting another create."""
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        try:
            persona = dict(persona_private or {})
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_voice_design_invalid", "声音设计模板无效。"
            ) from error
        model = str(
            persona.get("provider_model") or persona.get("model") or ""
        ).strip()
        voice_prompt = re.sub(
            r"\s+", " ", str(persona.get("voice_prompt") or "")
        ).strip()
        voice_prefix = str(persona.get("voice_prefix") or "").strip()
        if (
            model != AUTO_MIX_TTS_MODEL
            or not voice_prompt
            or len(voice_prompt) > 500
            or not VOICE_PREFIX.fullmatch(voice_prefix)
        ):
            raise ContentEngineError(
                "auto_mix_voice_design_invalid", "声音设计模板无效。"
            )

        try:
            listed = self._request_json(
                f"{self.origin}{AUTO_MIX_VOICE_DESIGN_ENDPOINT}",
                method="POST",
                payload={
                    "model": "voice-enrollment",
                    "input": {
                        "action": "list_voice",
                        "prefix": voice_prefix,
                        "page_size": 100,
                        "page_index": 0,
                    },
                },
                operation_label="V2 声音结果查询",
                retry_on_timeout=True,
            )
        except ContentEngineError as error:
            raise ContentEngineError(
                "auto_mix_voice_reconciliation_unavailable",
                "暂时无法查询百炼声音设计结果。",
            ) from error
        output = listed.get("output")
        voices = output.get("voice_list") if isinstance(output, dict) else None
        if not str(listed.get("request_id") or "").strip() or not isinstance(
            voices, list
        ):
            raise ContentEngineError(
                "auto_mix_voice_reconciliation_unavailable",
                "百炼声音设计查询返回了无效结果。",
            )
        expected_voice_prefix = f"{model}-vd-{voice_prefix}-"
        matches = []
        for item in voices:
            if not isinstance(item, dict):
                continue
            voice_id = str(item.get("voice_id") or "").strip()
            if (
                voice_id.startswith(expected_voice_prefix)
                and str(item.get("voice_prompt") or "").strip() == voice_prompt
                and str(item.get("preview_text") or "").strip()
                == VOICE_PREVIEW_SAMPLE
            ):
                matches.append(voice_id)
        matches = list(dict.fromkeys(matches))
        if not matches:
            return {"status": "not_found"}
        if len(matches) != 1:
            return {"status": "ambiguous"}

        voice_id = matches[0]
        try:
            queried = self._request_json(
                f"{self.origin}{AUTO_MIX_VOICE_DESIGN_ENDPOINT}",
                method="POST",
                payload={
                    "model": "voice-enrollment",
                    "input": {
                        "action": "query_voice",
                        "voice_id": voice_id,
                    },
                },
                operation_label="V2 声音详情查询",
                retry_on_timeout=True,
            )
        except ContentEngineError as error:
            raise ContentEngineError(
                "auto_mix_voice_reconciliation_unavailable",
                "暂时无法核对百炼声音设计详情。",
            ) from error
        details = queried.get("output")
        if (
            not str(queried.get("request_id") or "").strip()
            or not isinstance(details, dict)
            or str(details.get("voice_id") or "").strip() != voice_id
            or str(details.get("target_model") or "").strip() != model
            or str(details.get("voice_prompt") or "").strip() != voice_prompt
            or str(details.get("preview_text") or "").strip()
            != VOICE_PREVIEW_SAMPLE
        ):
            return {"status": "ambiguous"}
        provider_status = str(details.get("status") or "").strip().upper()
        if provider_status == "OK":
            return {
                "status": "recovered",
                "provider_voice_id": voice_id,
            }
        if provider_status == "DEPLOYING":
            return {"status": "pending"}
        if provider_status == "UNDEPLOYED":
            return {"status": "rejected"}
        return {"status": "ambiguous"}

    @staticmethod
    def _auto_mix_instruction_units(value: str) -> int:
        """Count CosyVoice instruction units using Bailian's documented rule."""
        return sum(
            2
            if (
                "\u3400" <= character <= "\u4dbf"
                or "\u4e00" <= character <= "\u9fff"
                or "\uf900" <= character <= "\ufaff"
            )
            else 1
            for character in value
        )

    @staticmethod
    def _normalize_auto_mix_wav(raw: bytes) -> tuple[bytes, dict[str, int]]:
        if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼没有返回有效的 WAV 配音。"
            )
        normalized = raw
        declared_riff_size = int.from_bytes(raw[4:8], "little")
        cursor = 12
        data_size_offset = None
        data_start = None
        declared_data_size = None
        while cursor + 8 <= len(raw):
            chunk_id = raw[cursor : cursor + 4]
            chunk_size = int.from_bytes(raw[cursor + 4 : cursor + 8], "little")
            chunk_start = cursor + 8
            if chunk_id == b"data":
                data_size_offset = cursor + 4
                data_start = chunk_start
                declared_data_size = chunk_size
                break
            if chunk_size > len(raw) - chunk_start:
                raise ContentEngineError(
                    "auto_mix_voice_invalid", "百炼没有返回完整的 WAV 配音。"
                )
            cursor = chunk_start + chunk_size + (chunk_size % 2)
        if data_size_offset is None or data_start is None or declared_data_size is None:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼没有返回有效的 WAV 配音。"
            )
        available_data_size = len(raw) - data_start
        header_overflows_file = (
            declared_riff_size > len(raw) - 8
            or declared_data_size > available_data_size
        )
        if header_overflows_file:
            # Bailian's streaming WAV uses near-2 GiB RIFF/data placeholders even
            # though the downloaded response already contains the complete PCM.
            # Only normalize that known sentinel shape; ordinary truncation must
            # still fail closed instead of being accepted as shorter audio.
            if (
                declared_riff_size,
                declared_data_size,
            ) != BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES:
                raise ContentEngineError(
                    "auto_mix_voice_invalid", "百炼没有返回完整的 WAV 配音。"
                )
            normalized_bytes = bytearray(raw)
            normalized_bytes[4:8] = (len(raw) - 8).to_bytes(4, "little")
            normalized_bytes[data_size_offset : data_size_offset + 4] = (
                available_data_size.to_bytes(4, "little")
            )
            normalized = bytes(normalized_bytes)
        try:
            with wave.open(io.BytesIO(normalized), "rb") as wav_file:
                sample_rate = int(wav_file.getframerate())
                frame_count = int(wav_file.getnframes())
                channels = int(wav_file.getnchannels())
                sample_width = int(wav_file.getsampwidth())
                compression = str(wav_file.getcomptype() or "")
                frame_bytes = wav_file.readframes(frame_count)
        except (EOFError, wave.Error) as error:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼没有返回有效的 WAV 配音。"
            ) from error
        if (
            sample_rate != AUTO_MIX_TTS_SAMPLE_RATE
            or frame_count <= 0
            or channels <= 0
            or sample_width <= 0
            or compression != "NONE"
            or len(frame_bytes) != frame_count * channels * sample_width
        ):
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼返回的 WAV 配音格式不符合要求。"
            )
        duration_ms = max(1, round(frame_count * 1_000 / sample_rate))
        return normalized, {
            "sample_rate": sample_rate,
            "frame_count": frame_count,
            "duration_ms": duration_ms,
        }

    def synthesize_auto_mix_phrase(
        self,
        text: str,
        output_path: Path,
        persona_private: dict[str, Any],
    ) -> dict[str, Any]:
        """Synthesize one V2 phrase with an approved private CosyVoice persona.

        V1 continues to use ``synthesize_product_voice``. This path deliberately
        accepts the provider voice only in the private persona object and never
        returns that voice identifier in its metadata or error messages.
        """
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        normalized = re.sub(r"\s+", " ", str(text or "")).strip()
        if not normalized:
            raise ContentEngineError("auto_mix_voice_invalid", "口播短语为空。")
        if not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", normalized):
            raise ContentEngineError(
                "auto_mix_voice_invalid", "口播短语不能只包含标点符号。"
            )
        try:
            persona = dict(persona_private or {})
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_voice_persona_invalid", "配音角色配置未通过 V2 审核。"
            ) from error
        provider = str(persona.get("provider") or "bailian").strip().casefold()
        model = str(
            persona.get("provider_model") or persona.get("model") or ""
        ).strip()
        voice_id = str(
            persona.get("provider_voice_id") or persona.get("voice_id") or ""
        ).strip()
        instruction = str(persona.get("instruction") or "").strip()
        if (
            provider != "bailian"
            or model != AUTO_MIX_TTS_MODEL
            or not voice_id
            or len(voice_id) > 300
            or any(character.isspace() for character in voice_id)
            or self._auto_mix_instruction_units(instruction)
            > AUTO_MIX_TTS_MAX_INSTRUCTION_UNITS
        ):
            raise ContentEngineError(
                "auto_mix_voice_persona_invalid", "配音角色配置未通过 V2 审核。"
            )
        synthesis_input = {
            "text": normalized,
            "voice": voice_id,
            "format": "wav",
            "sample_rate": AUTO_MIX_TTS_SAMPLE_RATE,
        }
        if instruction:
            synthesis_input["instruction"] = instruction
        try:
            response = self._request_json(
                f"{self.origin}{AUTO_MIX_TTS_ENDPOINT}",
                method="POST",
                payload={"model": AUTO_MIX_TTS_MODEL, "input": synthesis_input},
                timeout=max(self.timeout_seconds, 120),
                operation_label="V2 短语配音",
                retry_on_timeout=False,
            )
        except ContentEngineError as error:
            cause = error.__cause__
            submission_outcome_unknown = (
                error.code
                in {
                    "cloud_response_invalid",
                    "cloud_response_too_large",
                }
                or (
                    error.code == "cloud_request_failed"
                    and not isinstance(cause, HTTPError)
                )
            )
            if submission_outcome_unknown:
                raise ContentEngineError(
                    "auto_mix_voice_outcome_unknown",
                    "短语配音提交结果不明，已停止且不会自动重试。",
                ) from error
            raise
        request_id = str(response.get("request_id") or "").strip()
        output = response.get("output")
        finish_reason = (
            str(output.get("finish_reason") or "").strip()
            if isinstance(output, dict)
            else ""
        )
        audio = output.get("audio") if isinstance(output, dict) else None
        audio_url = str(audio.get("url") or "").strip() if isinstance(audio, dict) else ""
        audio_id = str(audio.get("id") or "").strip() if isinstance(audio, dict) else ""
        if not request_id or finish_reason != "stop" or not audio_url or not audio_id:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼没有返回可验证的短语配音。"
            )
        try:
            status, raw = public_https_get(
                _bailian_tts_https_download_url(audio_url),
                timeout=max(self.timeout_seconds, 120),
                max_bytes=MAX_TTS_AUDIO_BYTES,
                headers={"User-Agent": "Xiaoxi-Creative-Workbench/2.0"},
            )
            if status < 200 or status >= 300:
                raise ContentEngineError(
                    "auto_mix_voice_download_failed", "短语配音文件下载失败。"
                )
        except ProviderResponseTooLarge as error:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "短语配音结果超过安全大小限制。"
            ) from error
        except ProviderUrlError as error:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "百炼返回的短语配音地址无效。"
            ) from error
        except ContentEngineError:
            raise
        except Exception as error:
            raise ContentEngineError(
                "auto_mix_voice_download_failed", "短语配音文件下载失败。"
            ) from error
        raw, wav_info = self._normalize_auto_mix_wav(raw)
        destination = Path(output_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(raw)
            temporary.replace(destination)
        except OSError as error:
            raise ContentEngineError(
                "auto_mix_voice_write_failed", "短语配音文件保存失败。"
            ) from error
        finally:
            temporary.unlink(missing_ok=True)
        usage = response.get("usage")
        try:
            billed_characters = max(
                0,
                int(usage.get("characters") or 0) if isinstance(usage, dict) else 0,
            )
        except (TypeError, ValueError):
            billed_characters = 0
        return {
            "provider": "bailian",
            "model": AUTO_MIX_TTS_MODEL,
            "format": "wav",
            "sample_rate": wav_info["sample_rate"],
            "frame_count": wav_info["frame_count"],
            "duration_ms": wav_info["duration_ms"],
            "request_id": request_id,
            "audio_id": audio_id,
            "billed_characters": billed_characters,
        }

    def _temporary_upload(self, source: Path, model: str) -> str:
        query = parse.urlencode({"action": "getPolicy", "model": model})
        policy_response = self._request_json(
            f"{self.origin}/api/v1/uploads?{query}",
            operation_label="分析上传凭证",
            retry_on_timeout=True,
        )
        policy = policy_response.get("data")
        if not isinstance(policy, dict):
            raise ContentEngineError("cloud_response_invalid", "百炼未返回上传凭证。")
        filename = re.sub(r'[\\/"\r\n]', "_", source.name)
        object_key = f"{str(policy.get('upload_dir') or '').rstrip('/')}/{filename}"
        fields = [
            ("OSSAccessKeyId", str(policy.get("oss_access_key_id") or "")),
            ("Signature", str(policy.get("signature") or "")),
            ("policy", str(policy.get("policy") or "")),
            ("x-oss-object-acl", str(policy.get("x_oss_object_acl") or "private")),
            (
                "x-oss-forbid-overwrite",
                str(policy.get("x_oss_forbid_overwrite") or "true"),
            ),
            ("key", object_key),
            ("success_action_status", "200"),
        ]
        if not all(value for _, value in fields[:3]) or not policy.get("upload_host"):
            raise ContentEngineError("cloud_response_invalid", "百炼上传凭证不完整。")
        boundary = f"----xiaoxi-{uuid.uuid4().hex}"
        parts = []
        for name, value in fields:
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
            )
        mime = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            (
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode()
        )
        preamble = b"".join(parts)
        closing = f"\r\n--{boundary}--\r\n".encode()
        upload_url = parse.urlsplit(str(policy["upload_host"]))
        if upload_url.scheme != "https" or not upload_url.hostname:
            raise ContentEngineError("cloud_response_invalid", "百炼上传地址无效。")
        connection = http.client.HTTPSConnection(
            upload_url.hostname,
            upload_url.port,
            timeout=max(120, self.timeout_seconds),
        )
        try:
            upload_target = upload_url.path or "/"
            if upload_url.query:
                upload_target = f"{upload_target}?{upload_url.query}"
            connection.putrequest("POST", upload_target)
            connection.putheader(
                "Content-Type", f"multipart/form-data; boundary={boundary}"
            )
            connection.putheader(
                "Content-Length", str(len(preamble) + source.stat().st_size + len(closing))
            )
            connection.endheaders()
            connection.send(preamble)
            with source.open("rb") as source_file:
                while chunk := source_file.read(1024 * 1024):
                    connection.send(chunk)
            connection.send(closing)
            response = connection.getresponse()
            _read_bounded(
                response,
                MAX_UPLOAD_RESPONSE_BYTES,
                "cloud_upload_response_too_large",
                "百炼上传服务返回的数据超过安全大小限制。",
            )
            if response.status < 200 or response.status >= 300:
                raise OSError("upload rejected")
        except ContentEngineError:
            raise
        except Exception as error:
            raise ContentEngineError("cloud_upload_failed", "分析用音频上传失败。") from error
        finally:
            connection.close()
        return f"oss://{object_key}"

    def transcribe(self, audio_path: Path, should_stop: Callable[[], bool]) -> list[dict[str, Any]]:
        if not self.configured:
            return []
        audio_url = self._temporary_upload(audio_path, self.asr_model)
        submitted = self._request_json(
            f"{self.origin}/api/v1/services/audio/asr/transcription",
            method="POST",
            headers={
                "X-DashScope-Async": "enable",
                "X-DashScope-OssResourceResolve": "enable",
            },
            payload={
                "model": self.asr_model,
                "input": {"file_urls": [audio_url]},
                "parameters": {
                    "channel_id": [0],
                    "language_hints": ["zh", "en"],
                    "timestamp_alignment_enabled": True,
                    "diarization_enabled": True,
                },
            },
            operation_label="语音识别提交",
        )
        task_id = str(submitted.get("output", {}).get("task_id") or "")
        if not task_id:
            raise ContentEngineError("cloud_response_invalid", "百炼未返回转写任务编号。")
        deadline = time.monotonic() + 60 * 60
        while time.monotonic() < deadline:
            if should_stop():
                return []
            state = self._request_json(
                f"{self.origin}/api/v1/tasks/{parse.quote(task_id)}",
                method="POST",
                payload=None,
                operation_label="语音识别轮询",
                retry_on_timeout=True,
            )
            output = state.get("output") or {}
            status = str(output.get("task_status") or "").upper()
            if status == "SUCCEEDED":
                results = output.get("results") or []
                successful = next(
                    (
                        item
                        for item in results
                        if item.get("subtask_status") == "SUCCEEDED"
                        and item.get("transcription_url")
                    ),
                    None,
                )
                if not successful:
                    raise ContentEngineError("cloud_transcription_failed", "百炼未生成转写结果。")
                try:
                    status_code, raw = public_https_get(
                        str(successful["transcription_url"]),
                        timeout=self.timeout_seconds,
                        max_bytes=MAX_TRANSCRIPTION_JSON_BYTES,
                        headers={"User-Agent": "Xiaoxi-Creative-Workbench/1.0"},
                    )
                    if not 200 <= int(status_code) < 300:
                        raise ContentEngineError(
                            "cloud_transcription_failed",
                            "百炼转写结果下载失败。",
                        )
                    transcript = json.loads(raw.decode("utf-8"))
                except ProviderResponseTooLarge as error:
                    raise ContentEngineError(
                        "cloud_transcription_too_large",
                        "百炼转写结果超过安全大小限制。",
                    ) from error
                except ProviderUrlError as error:
                    raise ContentEngineError(
                        "cloud_transcription_url_invalid",
                        "百炼返回了不安全的转写结果地址。",
                    ) from error
                except ContentEngineError:
                    raise
                except Exception as error:
                    raise ContentEngineError(
                        "cloud_transcription_failed", "无法读取百炼转写结果。"
                    ) from error
                return self._sentences(transcript)
            if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                raise ContentEngineError("cloud_transcription_failed", "百炼转写任务失败。")
            time.sleep(2)
        raise ContentEngineError("cloud_transcription_timeout", "百炼转写任务超时。")

    @staticmethod
    def _sentences(payload: dict[str, Any]) -> list[dict[str, Any]]:
        items = []
        for transcript in payload.get("transcripts") or []:
            for sentence in transcript.get("sentences") or []:
                start = sentence.get("begin_time")
                end = sentence.get("end_time")
                text = str(sentence.get("text") or "").strip()
                if not isinstance(start, int) or not isinstance(end, int) or end <= start or not text:
                    continue
                items.append(
                    {
                        "start_ms": start,
                        "end_ms": end,
                        "transcript": text,
                        "speaker": str(sentence.get("speaker_id") or "speaker-0"),
                        "metadata": {
                            "sentence_complete": text.endswith(("。", "！", "？", ".", "!", "?")),
                            "words": sentence.get("words") or [],
                        },
                    }
                )
        return items

    def understand_frames(
        self,
        frames: list[dict[str, Any]],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if not self.configured or not frames:
            return []
        content = []
        for frame in frames[:12]:
            data = base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{data}"},
                }
            )
        product_context = normalize_product_context(context)
        product_name = str(
            product_context.get("product_name")
            or product_context.get("product")
            or ""
        ).strip()
        industry = str(product_context.get("industry") or "").strip()
        context_instruction = ""
        if product_name or industry:
            context_instruction = (
                f"这是商品展示素材。锁定商品名称为“{product_name or '未填写'}”，"
                f"所属行业为“{industry or '未填写'}”。只描述画面中能够核验的证据，"
                "不得把商品改写成其他品类；如果画面无法确认商品，shot_type 使用 unknown，"
                "不要猜测洗碗机、餐具、厨房等无证据类别。"
            )
        content.append(
            {
                "type": "text",
                "text": (
                    "这些图片按时间顺序来自素材。只根据画面证据返回JSON对象，格式为"
                    '{"frames":[{"index":0,"role":"hook|process|result|general",'
                    '"shot_type":"lecturer|slide|audience|equipment|operation|result|unknown",'
                    '"tags":["标签"],"quality":0.0,"caption":"客观描述"}]}。'
                    "不要虚构课程效果、人物身份或学员评价。"
                    + context_instruction
                ),
            }
        )
        parsed = self._structured_completion(
            messages=[{"role": "user", "content": content}],
            model=self.vision_model,
            empty_code="cloud_response_invalid",
            empty_message="百炼未返回画面分析结果。",
            operation_label="画面理解",
            validate=lambda item: isinstance(item.get("frames"), list),
        )
        results = []
        for item in parsed.get("frames") or []:
            if not isinstance(item, dict) or not isinstance(item.get("index"), int):
                continue
            index = item["index"]
            if 0 <= index < len(frames[:12]):
                results.append({**item, "timestamp_ms": frames[index]["timestamp_ms"]})
        return results

    def plan_motion_events(
        self,
        *,
        transcript: str,
        duration_ms: int,
        captions: list[dict[str, Any]],
        visual_context: list[dict[str, Any]],
        style_id: str,
    ) -> dict[str, Any]:
        plans = self.plan_motion_events_batch(
            [{
                "id": "single",
                "transcript": transcript,
                "duration_ms": duration_ms,
                "captions": captions,
                "visual_context": visual_context,
                "style_id": style_id,
            }]
        )
        return plans["single"]

    @staticmethod
    def _normalize_motion_events(
        items: Any, duration_ms: int, evidence_text: str
    ) -> list[dict[str, Any]]:
        evidence_key = "".join(
            character.casefold()
            for character in str(evidence_text or "")
            if character.isalnum()
        )
        events = []
        for item in (items if isinstance(items, list) else [])[:12]:
            if not isinstance(item, dict):
                continue
            event_type = str(item.get("type") or "").strip()
            zone = str(item.get("zone") or "").strip()
            size = str(item.get("size") or "").strip()
            text = str(item.get("text") or "").strip()[:48]
            try:
                start_ms = max(0, min(duration_ms, int(item.get("start_ms"))))
                end_ms = max(0, min(duration_ms, int(item.get("end_ms"))))
                priority = max(1, min(3, int(item.get("priority"))))
            except (TypeError, ValueError):
                continue
            if (
                event_type not in MOTION_EVENT_TYPES
                or zone not in MOTION_LAYOUT_ZONES
                or size not in MOTION_EVENT_SIZES
                or not text
                or end_ms <= start_ms
                or not 400 <= end_ms - start_ms <= 5_000
            ):
                continue
            text_key = "".join(
                character.casefold() for character in text if character.isalnum()
            )
            grounded_characters = sum(
                1 for character in text_key if character in evidence_key
            )
            if (
                not text_key
                or grounded_characters / len(text_key) < MIN_MOTION_TEXT_GROUNDING
            ):
                continue
            events.append(
                {
                    "type": event_type,
                    "text": text,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "zone": zone,
                    "size": size,
                    "priority": priority,
                    "icon": str(item.get("icon") or "spark")[:24],
                    "reason": str(item.get("reason") or "").strip()[:80],
                }
            )
        return events

    def plan_motion_events_batch(
        self, candidates: list[dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        """Plan several clips in one text request and return opaque-id keyed plans."""
        if not self.configured:
            raise ContentEngineError("cloud_not_configured", "请先配置百炼 API Key。")
        if not isinstance(candidates, list) or not candidates or len(candidates) > 20:
            raise ContentEngineError("invalid_motion_plan_input", "动效编导批次无效。")

        prompt_candidates = []
        candidate_id_map: dict[str, str] = {}
        durations: dict[str, int] = {}
        transcripts: dict[str, str] = {}
        for index, candidate in enumerate(candidates):
            if not isinstance(candidate, dict):
                raise ContentEngineError("invalid_motion_plan_input", "动效编导输入无效。")
            source_id = str(candidate.get("id") or "").strip()[:128]
            try:
                duration = int(candidate.get("duration_ms"))
            except (TypeError, ValueError) as error:
                raise ContentEngineError(
                    "invalid_motion_plan_input", "动效编导输入时长无效。"
                ) from error
            transcript = str(candidate.get("transcript") or "").strip()
            if (
                not source_id
                or source_id in durations
                or not transcript
                or not 1_000 <= duration <= 180_000
            ):
                raise ContentEngineError("invalid_motion_plan_input", "动效编导输入无效。")

            def safe_time(value: Any) -> int:
                try:
                    return max(0, min(duration, int(value or 0)))
                except (TypeError, ValueError):
                    return 0

            captions = []
            for item in (candidate.get("captions") or [])[:80]:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text") or "").strip()[:120]
                if text:
                    captions.append(
                        {
                            "text": text,
                            "start_ms": safe_time(item.get("start_ms", item.get("startMs"))),
                            "end_ms": safe_time(item.get("end_ms", item.get("endMs"))),
                        }
                    )
            visual = []
            for item in (candidate.get("visual_context") or [])[:24]:
                if not isinstance(item, dict):
                    continue
                visual.append(
                    {
                        "start_ms": safe_time(item.get("start_ms")),
                        "end_ms": safe_time(item.get("end_ms")),
                        "shot_type": str(item.get("shot_type") or "unknown")[:48],
                        "tags": [str(tag)[:32] for tag in (item.get("tags") or [])[:8]],
                        "description": str(item.get("description") or "")[:160],
                    }
                )
            prompt_id = f"c{index + 1}"
            candidate_id_map[prompt_id] = source_id
            durations[source_id] = duration
            transcripts[source_id] = transcript
            prompt_candidates.append(
                {
                    "id": prompt_id,
                    "duration_ms": duration,
                    "style_id": str(candidate.get("style_id") or "auto")[:40],
                    "transcript": transcript[:4_000],
                    "captions": captions,
                    "visual_context": visual,
                }
            )
        prompt = (
            "你是中文短视频的动效编导。一次处理多个候选，只根据真实转写、时间码和画面摘要决定辅助元素。"
            "不要改写老师观点，不要虚构效果，不要给出像素坐标、百分比坐标或 CSS。"
            "只返回语义区域：top_banner、upper_left、upper_right、middle_left、middle_right；"
            "字幕固定在底部保留区，任何事件都不能放在字幕区。"
            "元素类型只能是 hook、keyword、emphasis、step、scene、result、warning、quote；"
            "尺寸只能是 hero、card、chip，优先级只能是1到3。"
            "每个事件持续0.8到3.6秒，文本不超过24个汉字；同一时间最多建议两个元素，避免连续堆叠。"
            "开头可有一个hero钩子，中间只在关键词或步骤真正说到时出现，结尾只有内容确实形成结论时才用result。"
            "icon只可选spark、brush、office、shop、warning、check、question。"
            "严格返回JSON对象："
            '{"candidates":[{"id":"c1","events":[{"type":"hook","text":"...",'
            '"start_ms":0,"end_ms":2200,"zone":"top_banner","size":"hero",'
            '"priority":3,"icon":"question","reason":"..."}]}]}。'
            "每个输入 id 必须且只能返回一次；任何候选缺失都视为失败。输入数据："
            + json.dumps(prompt_candidates, ensure_ascii=False, separators=(",", ":"))
        )
        parsed = self._structured_completion(
            messages=[{"role": "user", "content": prompt}],
            model=self.selection_model,
            empty_code="cloud_motion_plan_invalid",
            empty_message="百炼未返回动效编导结果。",
            parse_code="cloud_motion_plan_invalid",
            parse_message="百炼返回的动效编导结果无法解析。",
        )
        returned = parsed.get("candidates")
        if returned is None and len(prompt_candidates) == 1:
            returned = [{"id": "c1", "events": parsed.get("events")}]
        plans = {}
        for item in returned if isinstance(returned, list) else []:
            prompt_id = str(item.get("id") or "") if isinstance(item, dict) else ""
            source_id = candidate_id_map.get(prompt_id)
            if not source_id or source_id in plans:
                continue
            events = self._normalize_motion_events(
                item.get("events"), durations[source_id], transcripts[source_id]
            )
            if not events:
                continue
            plans[source_id] = {
                "version": 1,
                "provider": "bailian",
                "model": self.selection_model,
                "events": events,
            }
        if set(plans) != set(durations):
            raise ContentEngineError(
                "cloud_motion_plan_invalid", "百炼没有为全部成片返回可安全使用的动效编导事件。"
            )
        return plans

    def rank_course_candidates(
        self,
        candidates: list[dict[str, Any]],
        theme: str,
        *,
        experiment_mode: str | None = None,
    ) -> list[dict[str, Any]]:
        if not self.configured or not candidates:
            return []
        is_supoclip_experiment = experiment_mode == "supoclip_bailian_v1"
        safe_candidates = []
        # Four-dimension output for 48 windows is large enough to be truncated by
        # the editor model. Twelve locally shortlisted windows leave ample choice
        # for five diverse clips while keeping request cost and JSON output bounded.
        candidate_limit = 12 if is_supoclip_experiment else 48
        candidate_id_map = {}
        for index, item in enumerate(candidates[:candidate_limit]):
            source_id = str(item.get("id") or "")
            if not source_id:
                continue
            prompt_id = f"c{index + 1}"
            candidate_id_map[prompt_id] = source_id
            safe_item = {
                "id": prompt_id,
                "duration_seconds": round(int(item.get("duration_ms") or 0) / 1000, 1),
                "transcript": str(item.get("transcript") or "")[:800],
            }
            if is_supoclip_experiment:
                safe_item.update(
                    {
                        "start_ms": max(0, int(item.get("start_ms") or 0)),
                        "end_ms": max(0, int(item.get("end_ms") or 0)),
                        "visual": [
                            {
                                "shot_type": str(frame.get("shot_type") or "unknown")[:64],
                                "tags": [str(tag)[:64] for tag in (frame.get("tags") or [])[:12]],
                                "quality": frame.get("quality"),
                                "visual_caption": str(frame.get("visual_caption") or "")[:300],
                            }
                            for frame in (item.get("visual") or [])[:12]
                            if isinstance(frame, dict)
                        ],
                    }
                )
            safe_candidates.append(safe_item)
        if is_supoclip_experiment:
            prompt = (
                "你是中文知识短视频主编。只能依据候选的真实转写和画面证据评分，"
                "不得虚构课程效果、人物身份或学员反馈。主题是：" + str(theme)[:100] + "。"
                "为每个候选给出四项0到25分的整数或小数：hook（前5秒的明确吸引力）、"
                "engagement（语言节奏和持续观看动力）、value（独立且完整的知识收获）、"
                "shareability（值得收藏或转发的程度）。total为四项综合分，范围0到100。"
                "半句话开场、依赖上文、重复铺垫、声音或画面证据差必须降分。"
                "reason只写1到3条可核验的中文短理由。严格返回JSON对象："
                '{"candidates":[{"id":"...","hook":0,"engagement":0,'
                '"value":0,"shareability":0,"total":0,"reason":["..."]}]}。'
                "候选数据：" + json.dumps(safe_candidates, ensure_ascii=False, separators=(",", ":"))
            )
        else:
            prompt = (
                "你是短视频课程内容主编。只依据转写文本评价候选片段，不得虚构。"
                "主题是：" + str(theme)[:100] + "。"
                "请为每个候选分别给出0到1之间的 opening_hook（前5秒是否吸引人）、"
                "standalone_value（脱离上下文仍有明确收获）、content_completeness（观点是否完整）、"
                "language_quality（口头语少且连贯）、theme_relevance（与主题贴合度）。"
                "不要因为文字多就给高分；从半句话开始、只有铺垫、重复内容必须降分。"
                "reason只写1到3条可核验的中文短理由。严格返回JSON对象："
                '{"candidates":[{"id":"...","opening_hook":0.0,'
                '"standalone_value":0.0,"content_completeness":0.0,'
                '"language_quality":0.0,"theme_relevance":0.0,"reason":["..."]}]}。'
                "候选数据：" + json.dumps(safe_candidates, ensure_ascii=False, separators=(",", ":"))
            )
        parsed = self._structured_completion(
            messages=[{"role": "user", "content": prompt}],
            model=self.selection_model,
            empty_code="cloud_response_invalid",
            empty_message="百炼未返回课程选段结果。",
            validate=lambda item: isinstance(item.get("candidates"), list),
        )
        results = []
        allowed_ids = set(candidate_id_map)
        incomplete_standard_scores = False
        for item in parsed.get("candidates") or []:
            if not isinstance(item, dict) or str(item.get("id") or "") not in allowed_ids:
                continue
            normalized = {"id": candidate_id_map[str(item["id"])]}
            if is_supoclip_experiment:
                required_scores = []
                for field in ("hook", "engagement", "value", "shareability"):
                    value = item.get(field)
                    if (
                        not isinstance(value, (int, float))
                        or isinstance(value, bool)
                        or not math.isfinite(float(value))
                    ):
                        required_scores = []
                        break
                    bounded = max(0.0, min(25.0, float(value)))
                    normalized[field] = bounded
                    required_scores.append(bounded)
                if len(required_scores) != 4:
                    continue
                # The displayed total must always be explainable by the four
                # dimensions. Ignore a contradictory total supplied by the model.
                normalized["total"] = round(sum(required_scores), 3)
            else:
                fields = (
                    "opening_hook",
                    "standalone_value",
                    "content_completeness",
                    "language_quality",
                    "theme_relevance",
                )
                valid_fields = 0
                for field in fields:
                    value = item.get(field)
                    if (
                        isinstance(value, (int, float))
                        and not isinstance(value, bool)
                        and math.isfinite(float(value))
                    ):
                        normalized[field] = max(0.0, min(1.0, float(value)))
                        valid_fields += 1
                if valid_fields != len(fields):
                    incomplete_standard_scores = True
                    continue
            normalized["reason"] = [
                str(reason).strip()[:60]
                for reason in (item.get("reason") or [])[:3]
                if str(reason).strip()
            ]
            results.append(normalized)
        if is_supoclip_experiment and parsed.get("candidates") and not results:
            raise ContentEngineError(
                "cloud_scores_incomplete", "百炼没有返回完整的四维候选评分。"
            )
        if not is_supoclip_experiment and (
            incomplete_standard_scores
            or {item["id"] for item in results} != set(candidate_id_map.values())
        ):
            raise ContentEngineError(
                "cloud_scores_incomplete", "百炼没有返回完整的课程候选评分。"
            )
        return results


class FFmpegCreativeAnalyzer:
    def __init__(
        self,
        data_dir: Path,
        *,
        ffmpeg_path: str | None = None,
        cloud_client: DashScopeMediaClient | None = None,
        command_runner=subprocess.run,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.ffmpeg_path = ffmpeg_path or discover_media_executable(
            "ffmpeg", "XIAOXI_FFMPEG_PATH"
        )
        self.cloud_client = cloud_client or DashScopeMediaClient()
        self._run_process = command_runner

    @property
    def capability(self):
        return {
            "available": bool(self.ffmpeg_path),
            "cloud_configured": self.cloud_client.configured,
            "provider": "bailian" if self.cloud_client.configured else "local_baseline",
        }

    def _command(self, args, timeout=2 * 60 * 60):
        if not self.ffmpeg_path:
            raise ContentEngineError("media_tools_unavailable", "FFmpeg is required for analysis.")
        try:
            result = self._run_process(
                list(args),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
                shell=False,
                **_windows_process_options(),
            )
        except subprocess.TimeoutExpired as error:
            raise ContentEngineError("analysis_timeout", "素材分析超时。") from error
        if result.returncode != 0:
            raise ContentEngineError("analysis_failed", (result.stderr or "FFmpeg failed")[-2_000:])

    def rank_course_windows(self, windows, theme, *, experiment_mode=None):
        candidates = []
        for item in windows[:48]:
            candidate = {
                "id": item.get("signature"),
                "duration_ms": item.get("duration_ms"),
                "transcript": item.get("transcript"),
            }
            if experiment_mode == "supoclip_bailian_v1":
                candidate.update(
                    {
                        "start_ms": item.get("start_ms"),
                        "end_ms": item.get("end_ms"),
                        "visual": [
                            {
                                "shot_type": segment.get("shot_type"),
                                "tags": segment.get("tags") or [],
                                "quality": segment.get("quality_score"),
                                "visual_caption": (
                                    segment.get("metadata") or {}
                                ).get("visual_caption"),
                            }
                            for segment in (item.get("segments") or [])[:12]
                        ],
                    }
                )
            candidates.append(candidate)
        return self.cloud_client.rank_course_candidates(
            candidates, theme, experiment_mode=experiment_mode
        )

    def plan_motion_events_batch(self, candidates):
        return self.cloud_client.plan_motion_events_batch(candidates)

    def synthesize_auto_mix_phrase(self, text, output_path, persona_private):
        return self.cloud_client.synthesize_auto_mix_phrase(
            text, output_path, persona_private
        )

    def design_auto_mix_voice(self, output_path, persona_private):
        return self.cloud_client.design_auto_mix_voice(
            output_path, persona_private
        )

    def reconcile_auto_mix_voice_design(self, persona_private):
        return self.cloud_client.reconcile_auto_mix_voice_design(persona_private)

    def analysis_version_for(self, asset, profile=None) -> str:
        effective_profile = profile if isinstance(profile, dict) else {}
        version_seed = {
            "base": DEFAULT_ANALYSIS_VERSION,
            "fingerprint": asset["fingerprint"],
            "provider": self.capability["provider"],
            "asr_model": self.cloud_client.asr_model,
            "vision_model": self.cloud_client.vision_model,
            "profile": effective_profile,
        }
        return hashlib.sha256(_json_bytes(version_seed)).hexdigest()[:24]

    @staticmethod
    def _frame_visual_evidence(gray_pixels: bytes) -> dict[str, Any]:
        """Measure one normalized 64x64 grayscale keyframe.

        The signal is intentionally local and deterministic.  The perceptual
        signature uses horizontal differences over a 9x8 area-average grid,
        which remains stable across ordinary re-encoding and small brightness
        shifts while still being comparable across different source assets.
        """
        if len(gray_pixels) != LOCAL_VISUAL_SAMPLE_BYTES:
            raise ValueError("normalized visual sample has an unexpected size")
        values = list(gray_pixels)
        sample_count = len(values)
        luma_mean = sum(values) / sample_count
        luma_variance = sum(
            (value - luma_mean) ** 2 for value in values
        ) / sample_count
        luma_stddev = math.sqrt(luma_variance)
        sorted_values = sorted(values)
        luma_p95 = sorted_values[int((sample_count - 1) * 0.95)]

        edge_sum = 0
        edge_count = 0
        width = LOCAL_VISUAL_SAMPLE_SIZE
        for row in range(width):
            offset = row * width
            for column in range(width - 1):
                edge_sum += abs(values[offset + column + 1] - values[offset + column])
                edge_count += 1
        for row in range(width - 1):
            offset = row * width
            next_offset = (row + 1) * width
            for column in range(width):
                edge_sum += abs(values[next_offset + column] - values[offset + column])
                edge_count += 1
        edge_energy = edge_sum / max(1, edge_count)

        grid = []
        for grid_row in range(8):
            row_start = grid_row * width // 8
            row_end = (grid_row + 1) * width // 8
            row_values = []
            for grid_column in range(9):
                column_start = grid_column * width // 9
                column_end = (grid_column + 1) * width // 9
                block = [
                    values[row * width + column]
                    for row in range(row_start, row_end)
                    for column in range(column_start, column_end)
                ]
                row_values.append(sum(block) / max(1, len(block)))
            grid.append(row_values)
        difference_bits = 0
        for row_values in grid:
            for column in range(8):
                difference_bits = (difference_bits << 1) | int(
                    row_values[column] > row_values[column + 1]
                )
        perceptual_hash = f"{difference_bits:016x}"

        black_screen = luma_mean <= 12.0 and luma_p95 <= 20
        nearly_uniform = luma_stddev <= 2.5 and edge_energy <= 0.75
        severe_blur = (
            not black_screen
            and luma_stddev > 2.0
            and edge_energy <= 0.75
        )
        return {
            "version": LOCAL_VISUAL_SIGNAL_VERSION,
            "status": "measured",
            "black_screen": black_screen,
            "severe_blur": severe_blur,
            "frozen": False,
            "meaningless": bool(black_screen or nearly_uniform),
            "perceptual_hash": perceptual_hash,
            "content_signature": f"dhash64:{perceptual_hash}",
            "luma_mean": round(luma_mean, 3),
            "luma_stddev": round(luma_stddev, 3),
            "edge_energy": round(edge_energy, 3),
            "pixel_digest": hashlib.sha256(gray_pixels).hexdigest(),
            "method": "ffmpeg_gray64_dhash",
        }

    @staticmethod
    def _unavailable_visual_evidence(reason: str) -> dict[str, Any]:
        return {
            "version": LOCAL_VISUAL_SIGNAL_VERSION,
            "status": "unavailable",
            "black_screen": None,
            "severe_blur": None,
            "frozen": None,
            "meaningless": None,
            "perceptual_hash": None,
            "content_signature": None,
            "reason": str(reason or "probe_unavailable")[:80],
            "method": "ffmpeg_gray64_dhash",
        }

    def _analyze_frame_file(self, frame_path: Path, temp_dir: Path, ordinal: int):
        normalized = temp_dir / f"frame-{ordinal:03d}.gray"
        try:
            self._command(
                [
                    self.ffmpeg_path,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(frame_path),
                    "-vf",
                    (
                        f"scale={LOCAL_VISUAL_SAMPLE_SIZE}:"
                        f"{LOCAL_VISUAL_SAMPLE_SIZE}:flags=area,format=gray"
                    ),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    str(normalized),
                ],
                timeout=300,
            )
            return self._frame_visual_evidence(normalized.read_bytes())
        except (ContentEngineError, OSError, ValueError):
            # This probe is a quality signal, not permission to discard an
            # otherwise readable source.  Unknown stays unknown; it must never
            # be converted into a false "bad material" claim.
            return self._unavailable_visual_evidence("frame_probe_failed")
        finally:
            try:
                normalized.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _mark_temporal_freeze(frames: list[dict[str, Any]]) -> None:
        measured = []
        for item in frames:
            if (item.get("visual_evidence") or {}).get("status") == "measured":
                measured.append(item)
        for item in measured:
            item["visual_evidence"]["frozen"] = False
        run = []
        previous_digest = None
        for item in frames + [None]:
            evidence = item.get("visual_evidence") if item is not None else {}
            digest = (
                evidence.get("pixel_digest")
                if isinstance(evidence, dict)
                and evidence.get("status") == "measured"
                else None
            )
            if run and (not digest or digest != previous_digest):
                span_ms = int(run[-1]["timestamp_ms"]) - int(run[0]["timestamp_ms"])
                if len(run) >= 2 and span_ms >= LOCAL_FREEZE_MIN_SPAN_MS:
                    for frozen_item in run:
                        frozen_item["visual_evidence"]["frozen"] = True
                run = []
            if item is not None and digest:
                run.append(item)
            previous_digest = digest
        for item in measured:
            item["visual_evidence"].pop("pixel_digest", None)

    def analyze(self, *, asset, source_path, task_id, profile, should_stop):
        if not self.capability["available"]:
            raise ContentEngineError("media_tools_unavailable", "FFmpeg is required for analysis.")
        source = Path(source_path)
        profile = profile if isinstance(profile, dict) else {}
        analysis_version = self.analysis_version_for(asset, profile)
        final_dir = self.data_dir / "derivatives" / asset["id"] / analysis_version
        temp_dir = self.data_dir / "analysis-temp" / task_id / asset["id"]
        if final_dir.is_dir():
            cached = self._read_manifest(final_dir, analysis_version)
            if cached is not None:
                shutil.rmtree(temp_dir, ignore_errors=True)
                return {**cached, "reuse_existing": True}
        shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=True)
        try:
            if should_stop():
                return {"stopped": True}
            duration_ms = int(asset["duration_ms"] or 0)
            dense_visual_signals = profile.get("workflow") == "auto_mix_v2"
            derivatives = []
            if asset["media_kind"] == "video":
                proxy = temp_dir / "proxy.mp4"
                self._command(
                    [
                        self.ffmpeg_path,
                        "-y",
                        "-i",
                        str(source),
                        "-vf",
                        "fps=30,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280",
                        "-an",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "28",
                        "-pix_fmt",
                        "yuv420p",
                        "-movflags",
                        "+faststart",
                        str(proxy),
                    ]
                )
                derivatives.append(self._derivative("proxy", proxy))
                if asset["has_audio"]:
                    audio = temp_dir / "speech.wav"
                    self._command(
                        [
                            self.ffmpeg_path,
                            "-y",
                            "-i",
                            str(source),
                            "-vn",
                            "-ac",
                            "1",
                            "-ar",
                            "16000",
                            "-c:a",
                            "pcm_s16le",
                            str(audio),
                        ]
                    )
                    derivatives.append(self._derivative("audio", audio))
                frames = self._extract_frames(
                    source,
                    temp_dir,
                    duration_ms,
                    dense=False,
                    analyze_visual=not dense_visual_signals,
                )
                evidence_frames = (
                    self._extract_visual_evidence_frames(
                        source, temp_dir, duration_ms
                    )
                    if dense_visual_signals
                    else frames
                )
                derivatives.extend(
                    self._derivative("keyframe", item["path"], index, {"timestamp_ms": item["timestamp_ms"]})
                    for index, item in enumerate(frames)
                )
            else:
                frame_path = temp_dir / "frame-000.jpg"
                self._command(
                    [
                        self.ffmpeg_path,
                        "-y",
                        "-i",
                        str(source),
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=720:-2",
                        str(frame_path),
                    ]
                )
                frames = [
                    {
                        "path": frame_path,
                        "timestamp_ms": 0,
                        "visual_evidence": self._analyze_frame_file(
                            frame_path, temp_dir, 0
                        ),
                    }
                ]
                evidence_frames = frames
                derivatives.append(self._derivative("keyframe", frame_path, 0, {"timestamp_ms": 0}))
                duration_ms = 3_000
            if should_stop():
                return {"stopped": True}
            sentences = []
            audio_path = temp_dir / "speech.wav"
            has_audio = bool(
                asset["has_audio"]
                if isinstance(asset, sqlite3.Row)
                else asset.get("has_audio")
            )
            audio_info = {
                "audio_track": "present" if has_audio else "none",
                "audio_mode": (
                    "source_audio_unclassified"
                    if has_audio
                    else "no_audio"
                ),
                "speech_status": (
                    "not_attempted" if has_audio else "not_present"
                ),
                "asr_error_code": None,
            }
            if audio_path.is_file() and self.cloud_client.configured:
                try:
                    sentences = self.cloud_client.transcribe(audio_path, should_stop)
                except ContentEngineError as error:
                    # ASR is an optional interpretation signal. A failed or
                    # unparseable transcript must not discard frames that can
                    # still be understood visually.
                    if (
                        error.code.startswith("cloud_transcription_")
                        or error.code
                        in {
                            "cloud_upload_failed",
                            "cloud_response_invalid",
                            # A timeout while obtaining an upload token,
                            # submitting ASR, or polling ASR is an optional
                            # speech signal failure. Keep going to visual
                            # understanding instead of discarding the asset.
                            "cloud_request_failed",
                        }
                    ):
                        audio_info["speech_status"] = "failed"
                        audio_info["asr_error_code"] = error.code
                    else:
                        raise
                if sentences:
                    audio_info["audio_mode"] = "source_voice"
                    audio_info["speech_status"] = "recognized"
                elif audio_info["speech_status"] == "not_attempted":
                    audio_info["speech_status"] = "not_recognized"
            elif audio_path.is_file():
                audio_info["speech_status"] = "not_requested"
            if self.cloud_client.configured:
                vision_frames = self._representative_frames(frames, limit=12)
                product_context = profile.get("product_context")
                if isinstance(product_context, dict) and product_context:
                    visual = self.cloud_client.understand_frames(
                        vision_frames, context=product_context
                    )
                else:
                    visual = self.cloud_client.understand_frames(vision_frames)
            else:
                visual = []
            segments = self._segments(
                duration_ms,
                sentences,
                visual,
                frames,
                audio_info,
                fallback_step_ms=5_000 if dense_visual_signals else 15_000,
                fixed_visual_windows=dense_visual_signals,
                evidence_frames=evidence_frames,
            )
            srt = temp_dir / "transcript.srt"
            if sentences:
                srt.write_text(self._srt(sentences), encoding="utf-8")
                derivatives.append(self._derivative("srt", srt))
            manifest = self._manifest_payload(
                analysis_version=analysis_version,
                provider=self.capability["provider"],
                derivatives=derivatives,
                segments=segments,
                audio=audio_info,
            )
            manifest_temp = temp_dir / f".{ANALYSIS_MANIFEST_NAME}.tmp"
            manifest_temp.write_text(
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(manifest_temp, temp_dir / ANALYSIS_MANIFEST_NAME)
            final_dir.parent.mkdir(parents=True, exist_ok=True)
            if final_dir.exists():
                shutil.rmtree(final_dir)
            temp_dir.replace(final_dir)
            completed = self._read_manifest(final_dir, analysis_version)
            if completed is None:
                raise ContentEngineError(
                    "analysis_failed", "Analysis cache manifest is invalid."
                )
            return completed
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def _representative_frames(frames, *, limit):
        if len(frames) <= limit:
            return list(frames)
        indices = {
            round(index * (len(frames) - 1) / max(1, limit - 1))
            for index in range(limit)
        }
        return [frames[index] for index in sorted(indices)]

    def _extract_frames(
        self,
        source,
        temp_dir,
        duration_ms,
        *,
        dense=False,
        analyze_visual=True,
    ):
        temp_dir.mkdir(parents=True, exist_ok=True)
        if dense:
            count = min(48, max(3, math.ceil(max(1, duration_ms) / 2_500) + 1))
        else:
            count = min(12, max(3, int(duration_ms / 60_000) + 3))
        if duration_ms <= 0:
            timestamps = [0]
        elif dense:
            last_timestamp = max(0, duration_ms - 1)
            timestamps = [
                round(last_timestamp * index / max(1, count - 1))
                for index in range(count)
            ]
        else:
            timestamps = [int(duration_ms * (index + 1) / (count + 1)) for index in range(count)]
        frames = []
        for index, timestamp in enumerate(timestamps):
            output = temp_dir / f"frame-{index:03d}.jpg"
            self._command(
                [
                    self.ffmpeg_path,
                    "-y",
                    "-ss",
                    f"{timestamp / 1000:.3f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=480:-2",
                    "-q:v",
                    "3",
                    str(output),
                ],
                timeout=300,
            )
            frames.append(
                {
                    "path": output,
                    "timestamp_ms": timestamp,
                    "visual_evidence": (
                        self._analyze_frame_file(output, temp_dir, index)
                        if analyze_visual
                        else self._unavailable_visual_evidence(
                            "separate_bulk_evidence"
                        )
                    ),
                }
            )
        if analyze_visual:
            self._mark_temporal_freeze(frames)
        return frames

    def _extract_visual_evidence_frames(self, source, temp_dir, duration_ms):
        """Decode V2 quality evidence in one bounded FFmpeg invocation."""

        duration_ms = max(0, int(duration_ms or 0))
        if duration_ms <= 0:
            return []
        expected_frames = max(
            1, math.ceil(duration_ms / LOCAL_VISUAL_EVIDENCE_INTERVAL_MS)
        )
        maximum_frames = LOCAL_VISUAL_MAX_EVIDENCE_BYTES // LOCAL_VISUAL_SAMPLE_BYTES
        if expected_frames > maximum_frames:
            return []
        raw_path = temp_dir / "visual-evidence.gray"
        try:
            self._command(
                [
                    self.ffmpeg_path,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(source),
                    "-an",
                    "-sn",
                    "-dn",
                    "-vf",
                    (
                        "fps=fps=1/2:start_time=0,"
                        f"scale={LOCAL_VISUAL_SAMPLE_SIZE}:"
                        f"{LOCAL_VISUAL_SAMPLE_SIZE}:flags=area,format=gray"
                    ),
                    "-frames:v",
                    str(expected_frames),
                    "-pix_fmt",
                    "gray",
                    "-f",
                    "rawvideo",
                    str(raw_path),
                ]
            )
            size = raw_path.stat().st_size
            if (
                size <= 0
                or size > LOCAL_VISUAL_MAX_EVIDENCE_BYTES
                or size % LOCAL_VISUAL_SAMPLE_BYTES
                or size // LOCAL_VISUAL_SAMPLE_BYTES > expected_frames
            ):
                return []
            frames = []
            with raw_path.open("rb") as stream:
                for index in range(size // LOCAL_VISUAL_SAMPLE_BYTES):
                    pixels = stream.read(LOCAL_VISUAL_SAMPLE_BYTES)
                    if len(pixels) != LOCAL_VISUAL_SAMPLE_BYTES:
                        return []
                    timestamp_ms = index * LOCAL_VISUAL_EVIDENCE_INTERVAL_MS
                    if timestamp_ms >= duration_ms:
                        break
                    frames.append(
                        {
                            "timestamp_ms": timestamp_ms,
                            "visual_evidence": self._frame_visual_evidence(pixels),
                        }
                    )
                if stream.read(1):
                    return []
            self._mark_temporal_freeze(frames)
            return frames
        except (ContentEngineError, OSError, ValueError):
            return []
        finally:
            try:
                raw_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _derivative(kind, path, ordinal=0, metadata=None):
        return {
            "kind": kind,
            "ordinal": ordinal,
            "relative_path": str(path),
            "metadata": metadata or {},
        }

    @staticmethod
    def _manifest_payload(*, analysis_version, provider, derivatives, segments, audio=None):
        return {
            "schema_version": 1,
            "analysis_version": analysis_version,
            "provider": str(provider or "local")[:64],
            "derivatives": [
                {
                    "kind": str(item.get("kind") or ""),
                    "ordinal": int(item.get("ordinal") or 0),
                    "file_name": Path(str(item.get("relative_path") or "")).name,
                    "metadata": item.get("metadata") or {},
                }
                for item in derivatives
            ],
            "segments": segments,
            "audio": audio if isinstance(audio, dict) else {},
        }

    def _read_manifest(self, final_dir, expected_version):
        manifest_path = final_dir / ANALYSIS_MANIFEST_NAME
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                not isinstance(manifest, dict)
                or manifest.get("schema_version") != 1
                or manifest.get("analysis_version") != expected_version
                or not isinstance(manifest.get("provider"), str)
                or not isinstance(manifest.get("derivatives"), list)
                or not isinstance(manifest.get("segments"), list)
            ):
                return None
            derivatives = []
            for item in manifest["derivatives"]:
                if not isinstance(item, dict):
                    return None
                kind = item.get("kind")
                ordinal = item.get("ordinal")
                file_name = item.get("file_name")
                metadata = item.get("metadata")
                if (
                    kind not in {"proxy", "audio", "keyframe", "srt"}
                    or not isinstance(ordinal, int)
                    or isinstance(ordinal, bool)
                    or not isinstance(file_name, str)
                    or not file_name
                    or Path(file_name).name != file_name
                    or not isinstance(metadata, dict)
                ):
                    return None
                if kind in {"proxy", "audio", "srt"} and ordinal != 0:
                    return None
                derivative_path = final_dir / file_name
                if not derivative_path.is_file():
                    return None
                derivatives.append(
                    {
                        "kind": kind,
                        "ordinal": ordinal,
                        "relative_path": str(derivative_path.relative_to(self.data_dir)),
                        "metadata": metadata,
                    }
                )
            for segment in manifest["segments"]:
                if not isinstance(segment, dict):
                    return None
                start = segment.get("start_ms")
                end = segment.get("end_ms")
                if (
                    not isinstance(start, int)
                    or isinstance(start, bool)
                    or not isinstance(end, int)
                    or isinstance(end, bool)
                    or end <= start
                    or not isinstance(segment.get("metadata") or {}, dict)
                ):
                    return None
            audio = manifest.get("audio")
            if not isinstance(audio, dict):
                audio = {
                    "audio_track": "unknown",
                    "audio_mode": "source_audio_unclassified",
                    "speech_status": "unknown",
                    "asr_error_code": None,
                }
            return {
                "analysis_version": expected_version,
                "provider": manifest["provider"],
                "derivatives": derivatives,
                "segments": manifest["segments"],
                "audio": audio,
            }
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
            return None

    @staticmethod
    def _segment_visual_evidence(
        frames,
        start_ms,
        end_ms,
        reference_timestamp,
        *,
        require_in_range=False,
        minimum_signature_samples=1,
    ):
        if not frames:
            evidence = FFmpegCreativeAnalyzer._unavailable_visual_evidence(
                "keyframe_evidence_missing"
            )
            return 0, evidence, {"method": evidence["method"], "timestamps_ms": []}
        keyframe_ordinal = min(
            range(len(frames)),
            key=lambda frame_index: abs(
                int(frames[frame_index].get("timestamp_ms") or 0)
                - reference_timestamp
            ),
        )
        candidates = [
            frame
            for frame in frames
            if start_ms <= int(frame.get("timestamp_ms") or 0) < end_ms
        ]
        if not candidates:
            if require_in_range:
                evidence = FFmpegCreativeAnalyzer._unavailable_visual_evidence(
                    "segment_evidence_out_of_range"
                )
                return keyframe_ordinal, evidence, {
                    "method": evidence["method"],
                    "timestamps_ms": [],
                    "sample_count": 0,
                    "measured_count": 0,
                }
            candidates = [frames[keyframe_ordinal]]
        measured = [
            frame
            for frame in candidates
            if isinstance(frame.get("visual_evidence"), dict)
            and frame["visual_evidence"].get("status") == "measured"
        ]
        timestamps = [int(frame.get("timestamp_ms") or 0) for frame in candidates]
        if not measured:
            evidence = FFmpegCreativeAnalyzer._unavailable_visual_evidence(
                "segment_evidence_unavailable"
            )
            return keyframe_ordinal, evidence, {
                "method": evidence["method"],
                "timestamps_ms": timestamps,
                "sample_count": len(candidates),
                "measured_count": 0,
            }
        evidences = [frame["visual_evidence"] for frame in measured]
        hashes = [
            str(item.get("perceptual_hash"))
            for item in evidences
            if item.get("perceptual_hash")
        ]
        aggregate_hash = (
            hashlib.sha256("|".join(hashes).encode("ascii")).hexdigest()[:16]
            if len(hashes) > 1
            else hashes[0] if hashes else None
        )
        signature_hash = (
            aggregate_hash
            if len(measured) >= max(1, int(minimum_signature_samples or 1))
            else None
        )
        numeric_keys = ("luma_mean", "luma_stddev", "edge_energy")
        aggregate = {
            "version": LOCAL_VISUAL_SIGNAL_VERSION,
            "status": "measured",
            "black_screen": any(item.get("black_screen") is True for item in evidences),
            "severe_blur": any(item.get("severe_blur") is True for item in evidences),
            "frozen": bool(evidences)
            and all(item.get("frozen") is True for item in evidences),
            "meaningless": any(item.get("meaningless") is True for item in evidences),
            "perceptual_hash": aggregate_hash,
            "content_signature": (
                f"dhash64-sequence:{signature_hash}" if signature_hash else None
            ),
            "method": "ffmpeg_gray64_dhash_sequence",
        }
        for key in numeric_keys:
            values = [
                float(item[key])
                for item in evidences
                if isinstance(item.get(key), (int, float))
            ]
            if values:
                aggregate[key] = round(sum(values) / len(values), 3)
        summary = {
            "method": aggregate["method"],
            "timestamps_ms": timestamps,
            "sample_count": len(candidates),
            "measured_count": len(measured),
        }
        for key in numeric_keys:
            if key in aggregate:
                summary[key] = aggregate[key]
        return keyframe_ordinal, aggregate, summary

    @staticmethod
    def _segments(
        duration_ms,
        sentences,
        visual,
        frames,
        audio=None,
        *,
        fallback_step_ms=15_000,
        fixed_visual_windows=False,
        evidence_frames=None,
    ):
        if fixed_visual_windows:
            step = max(1_000, min(15_000, int(fallback_step_ms or 5_000)))
            base = []
            for start in range(0, max(duration_ms, 1), step):
                end = min(duration_ms, start + step)
                if end <= start:
                    continue
                overlapping = [
                    sentence
                    for sentence in sentences or []
                    if int(sentence.get("start_ms") or 0) < end
                    and start < int(sentence.get("end_ms") or 0)
                ]
                transcripts = [
                    str(sentence.get("transcript") or "").strip()
                    for sentence in overlapping
                    if str(sentence.get("transcript") or "").strip()
                ]
                speakers = [
                    str(sentence.get("speaker") or "").strip()
                    for sentence in overlapping
                    if str(sentence.get("speaker") or "").strip()
                ]
                base.append(
                    {
                        "start_ms": start,
                        "end_ms": end,
                        "transcript": " ".join(transcripts)[:5_000],
                        "speaker": speakers[0][:100] if speakers else "",
                        "metadata": {
                            "sentence_complete": bool(overlapping)
                            and all(
                                bool(
                                    (sentence.get("metadata") or {}).get(
                                        "sentence_complete", True
                                    )
                                )
                                for sentence in overlapping
                            ),
                            "transcript_evidence_count": len(overlapping),
                        },
                    }
                )
        elif sentences:
            base = sentences
        else:
            step = max(1_000, min(15_000, int(fallback_step_ms or 15_000)))
            base = [
                {
                    "start_ms": start,
                    "end_ms": min(duration_ms, start + step),
                    "transcript": "",
                    "speaker": "",
                    "metadata": {"sentence_complete": False},
                }
                for start in range(0, max(duration_ms, 1), step)
                if min(duration_ms, start + step) > start
            ]
        results = []
        for sentence in base:
            midpoint = (sentence["start_ms"] + sentence["end_ms"]) // 2
            closest = min(
                visual,
                key=lambda item: abs(int(item.get("timestamp_ms") or 0) - midpoint),
                default={},
            )
            if closest:
                role = str(closest.get("role") or "general")
            else:
                ratio = midpoint / max(duration_ms, 1)
                role = "hook" if ratio < 0.2 else "result" if ratio > 0.8 else "process"
            if role not in {"hook", "process", "result", "general"}:
                role = "general"
            quality = closest.get("quality", 0.62 if sentence.get("transcript") else 0.52)
            try:
                quality = min(1.0, max(0.0, float(quality)))
            except (TypeError, ValueError):
                quality = 0.5
            reference_timestamp = int(closest.get("timestamp_ms") or midpoint)
            evidence_keyframe_ordinal, visual_evidence, evidence_summary = (
                FFmpegCreativeAnalyzer._segment_visual_evidence(
                    evidence_frames if evidence_frames is not None else frames,
                    int(sentence["start_ms"]),
                    int(sentence["end_ms"]),
                    reference_timestamp,
                    require_in_range=fixed_visual_windows,
                    minimum_signature_samples=2 if fixed_visual_windows else 1,
                )
            )
            keyframe_ordinal = evidence_keyframe_ordinal
            if evidence_frames is not None and frames:
                keyframe_ordinal = min(
                    range(len(frames)),
                    key=lambda frame_index: abs(
                        int(frames[frame_index].get("timestamp_ms") or 0)
                        - reference_timestamp
                    ),
                )
            results.append(
                {
                    **sentence,
                    "role": role,
                    "shot_type": str(closest.get("shot_type") or "unknown")[:64],
                    "tags": [str(tag)[:64] for tag in (closest.get("tags") or [])[:20]],
                    "quality_score": quality,
                    "metadata": {
                        **(sentence.get("metadata") or {}),
                        "visual_caption": str(closest.get("caption") or "")[:500],
                        "keyframe_ordinal": keyframe_ordinal,
                        **(audio if isinstance(audio, dict) else {}),
                        "visual_signal_version": str(
                            visual_evidence.get("version")
                            or LOCAL_VISUAL_SIGNAL_VERSION
                        ),
                        "visual_signal_status": str(
                            visual_evidence.get("status") or "unavailable"
                        ),
                        "black_screen": visual_evidence.get("black_screen"),
                        "severe_blur": visual_evidence.get("severe_blur"),
                        "frozen": visual_evidence.get("frozen"),
                        "meaningless": visual_evidence.get("meaningless"),
                        "perceptual_hash": visual_evidence.get("perceptual_hash"),
                        "content_signature": visual_evidence.get("content_signature"),
                        "visual_signal_evidence": evidence_summary,
                    },
                }
            )
        return results

    @staticmethod
    def _srt(sentences):
        def stamp(milliseconds):
            hours, remainder = divmod(milliseconds, 3_600_000)
            minutes, remainder = divmod(remainder, 60_000)
            seconds, millis = divmod(remainder, 1_000)
            return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

        return "\n\n".join(
            f"{index}\n{stamp(item['start_ms'])} --> {stamp(item['end_ms'])}\n{item['transcript']}"
            for index, item in enumerate(sentences, 1)
        ) + "\n"
