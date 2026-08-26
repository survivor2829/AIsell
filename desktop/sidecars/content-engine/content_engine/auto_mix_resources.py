from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
from typing import Any, Mapping

from .auto_mix_v2 import canonical_hash
from .errors import ContentEngineError


VOICE_PERSONA_ID = re.compile(r"^[a-z][a-z0-9-]{1,63}@[1-9][0-9]{0,5}$", re.I)
VOICE_PREFIX = re.compile(r"^[A-Za-z0-9]{1,10}$")
AUTO_MIX_TTS_MODEL = "cosyvoice-v3.5-plus"
BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES = (0x7FFFFFBF, 0x7FFFFF9B)
VOICE_PREVIEW_SAMPLE = "你好，这是一段自然、清晰的中文口播试听。接下来，我会用真实分享的语气把重点讲明白。"
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
    persona_id = _clean(value.get("voicePersonaId") or value.get("personaId"), 72)
    provider_voice_id = _clean(value.get("providerVoiceId"), 160)
    voice_prompt = _clean(value.get("voicePrompt"), 500)
    voice_prefix = _clean(value.get("voicePrefix") or value.get("prefix"), 10)
    design_ready = bool(voice_prompt and VOICE_PREFIX.fullmatch(voice_prefix))
    if (
        not VOICE_PERSONA_ID.fullmatch(persona_id)
        or not (provider_voice_id or design_ready)
    ):
        return None
    return {
        "persona_id": persona_id,
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
        "instruction": _clean(value.get("instruction"), 240)
        or "自然、松弛、像真实生活分享，短句之间保留清晰停顿。",
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
            "sample": VOICE_PREVIEW_SAMPLE,
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
