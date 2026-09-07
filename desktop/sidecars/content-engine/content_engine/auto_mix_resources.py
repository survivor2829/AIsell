from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any, Mapping

from .auto_mix_v2 import canonical_hash
from .errors import ContentEngineError


VOICE_PERSONA_ID = re.compile(r"^[a-z][a-z0-9-]{1,63}@[1-9][0-9]{0,5}$", re.I)
VOICE_PREFIX = re.compile(r"^[A-Za-z0-9]{1,10}$")
AUTO_MIX_TTS_MODEL = "cosyvoice-v3.5-plus"
BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES = (0x7FFFFFBF, 0x7FFFFF9B)
VOICE_PREVIEW_SAMPLE = "你好，这是一段自然、清晰的中文口播试听。接下来，我会用真实分享的语气把重点讲明白。"
POPULAR_VOICE_PREVIEW_SAMPLE = (
    "我挑一个地方，最怕的不是花钱，而是到了以后才发现，跟想象中完全不一样。"
    "想住得舒服、走得轻松，就先看看真实的环境，再决定值不值得去。"
    "把时间留给自己喜欢的事，比赶着打卡更重要。"
)
SUPPORTED_VOICE_MODELS = {"bailian": {AUTO_MIX_TTS_MODEL}, "volcengine": {"seed-tts-1.0", "seed-tts-2.0"}}
MAX_VOICE_PREVIEW_BYTES = 8 * 1024 * 1024
BUILTIN_VOICE_CATALOG = (
    Path(__file__).resolve().parent
    / "assets"
    / "auto-mix-voice-personas.v1.json"
)


def _clean(value: Any, maximum: int) -> str:
    return " ".join(str(value or "").strip().split())[:maximum]


def _auto_select_priority(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(-1_000, min(1_000, int(value)))
    except (TypeError, ValueError):
        return 0


def _configured_persona(value: Mapping[str, Any]) -> dict[str, Any] | None:
    provider = _clean(value.get("provider") or "bailian", 30).lower()
    model = _clean(value.get("providerModel") or value.get("provider_model") or AUTO_MIX_TTS_MODEL, 80)
    persona_id = _clean(value.get("voicePersonaId") or value.get("personaId"), 72)
    provider_voice_id = _clean(value.get("providerVoiceId"), 160)
    voice_prompt = _clean(value.get("voicePrompt"), 500)
    voice_prefix = _clean(value.get("voicePrefix") or value.get("prefix"), 10)
    design_ready = bool(voice_prompt and VOICE_PREFIX.fullmatch(voice_prefix))
    if (
        not VOICE_PERSONA_ID.fullmatch(persona_id)
        or not (provider_voice_id or design_ready)
        or model not in SUPPORTED_VOICE_MODELS.get(provider, set())
        or provider != "bailian" and not provider_voice_id
    ):
        return None
    return {
        "persona_id": persona_id,
        "provider": provider,
        "provider_model": model,
        "display_name": _clean(value.get("displayName"), 80) or "自然生活",
        "style": _clean(value.get("style") or value.get("category"), 80)
        or "natural_life",
        "catalog_version": _clean(value.get("catalogVersion"), 80)
        or "local-configured",
        "provider_voice_id": provider_voice_id,
        "voice_prompt": voice_prompt,
        "voice_prefix": voice_prefix if design_ready else "",
        "auto_select_priority": _auto_select_priority(
            value.get("autoSelectPriority")
            if "autoSelectPriority" in value
            else value.get("auto_select_priority")
        ),
        "instruction": (_clean(value.get("instruction"), 240)
                        or "自然、松弛、像真实生活分享，短句之间保留清晰停顿。") if provider == "bailian" else "",
        "source_url": _clean(value.get("sourceUrl"), 500),
        "recommendation_url": _clean(value.get("recommendationUrl"), 500),
        "research_date": _clean(value.get("researchDate"), 20),
        "evidence_note": _clean(value.get("evidenceNote"), 400),
    }


def _builtin_voice_personas() -> list[dict[str, Any]]:
    try:
        payload = json.loads(BUILTIN_VOICE_CATALOG.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        return []
    catalog_version = _clean(payload.get("catalogVersion"), 80)
    personas = []
    for item in payload.get("personas") or []:
        if not isinstance(item, dict):
            continue
        candidate = dict(item)
        candidate.setdefault("catalogVersion", catalog_version)
        persona = _configured_persona(candidate)
        if persona is not None:
            personas.append(persona)
    return personas


def configured_voice_personas(
    environment: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    values = environment if environment is not None else os.environ
    configured = []
    raw_catalog = values.get("XIAOXI_TTS_PERSONA_CATALOG_JSON")
    if raw_catalog:
        try:
            parsed = json.loads(raw_catalog)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed = []
        for item in parsed if isinstance(parsed, list) else []:
            if not isinstance(item, dict):
                continue
            persona = _configured_persona(item)
            if persona is not None:
                configured.append(persona)
    if configured:
        return list({item["persona_id"]: item for item in configured}.values())
    if values.get("XIAOXI_COSYVOICE_VOICE_ID") or values.get(
        "XIAOXI_COSYVOICE_VOICE_PROMPT"
    ):
        persona = _configured_persona(
            {
                "voicePersonaId": values.get("XIAOXI_TTS_PERSONA_ID")
                or "natural-life@1",
                "displayName": values.get("XIAOXI_TTS_PERSONA_NAME")
                or "自然生活",
                "style": values.get("XIAOXI_TTS_PERSONA_STYLE")
                or "natural_life",
                "catalogVersion": values.get("XIAOXI_TTS_CATALOG_VERSION")
                or "local-configured",
                "providerVoiceId": values.get("XIAOXI_COSYVOICE_VOICE_ID"),
                "voicePrompt": values.get("XIAOXI_COSYVOICE_VOICE_PROMPT"),
                "voicePrefix": values.get("XIAOXI_COSYVOICE_VOICE_PREFIX")
                or "life26",
                "instruction": values.get("XIAOXI_COSYVOICE_INSTRUCTION"),
            },
        )
        if persona is not None:
            configured.append(persona)
    if not configured:
        configured = _builtin_voice_personas()
    return list({item["persona_id"]: item for item in configured}.values())


def auto_select_voice_persona_ids(
    environment: Mapping[str, str] | None = None,
) -> list[str]:
    personas = configured_voice_personas(environment)
    return [
        item["persona_id"]
        for item in sorted(
            personas,
            key=lambda item: (
                -int(item.get("auto_select_priority") or 0),
                item["persona_id"],
            ),
        )
    ]


def voice_preview_sample(persona: Mapping[str, Any]) -> str:
    try:
        provider = persona["provider"]
    except (KeyError, IndexError):
        provider = "bailian"
    return POPULAR_VOICE_PREVIEW_SAMPLE if provider == "volcengine" else VOICE_PREVIEW_SAMPLE


def voice_preview_ffmpeg() -> str:
    from .render_mix import discover_media_executable
    executable = discover_media_executable("ffmpeg", "XIAOXI_FFMPEG_PATH")
    if not executable:
        raise ContentEngineError("auto_mix_voice_preview_normalization_unavailable", "试听需要本地音频处理组件，请检查 FFmpeg 配置。")
    return executable


def normalize_voice_preview(path: Path, executable: str) -> None:
    from .render_mix import _windows_process_options
    normalized = path.with_name(path.stem + ".normalized.wav")
    try:
        result = subprocess.run([executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(path), "-vn", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7", "-ar", "24000", "-ac", "1",
            "-c:a", "pcm_s16le", str(normalized)], capture_output=True, timeout=30, **_windows_process_options())
        if result.returncode or not normalized.is_file():
            raise OSError("preview normalization failed")
        normalized.replace(path)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ContentEngineError("auto_mix_voice_preview_normalization_failed", "配音已保存，但试听响度处理未完成；重试会复用已生成音频。") from error


def voice_preview_cache_key(persona: Mapping[str, Any]) -> str:
    def value(key: str) -> Any:
        try:
            return persona[key]
        except (KeyError, TypeError):
            return None

    voice_prompt = str(value("voice_prompt") or "").strip()
    return canonical_hash(
        {
            "stage": "voice_persona_preview",
            "sample": voice_preview_sample(persona),
            "persona_id": value("id"),
            "catalog_version": value("catalog_version"),
            "provider_model": value("provider_model"),
            "provider_voice_id": (
                "" if voice_prompt else value("provider_voice_id")
            ),
            "voice_prompt": voice_prompt,
            "voice_prefix": value("voice_prefix"),
            "instruction": value("instruction"),
        }
    )


def voice_preview_data_url(path: Path) -> str:
    try:
        size = path.stat().st_size
        if not 0 < size <= MAX_VOICE_PREVIEW_BYTES:
            raise OSError("invalid preview size")
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    except OSError as error:
        raise ContentEngineError(
            "auto_mix_voice_preview_unavailable", "声音试听文件不可用。"
        ) from error
    return f"data:audio/wav;base64,{encoded}"
