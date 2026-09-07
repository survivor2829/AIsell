"""Public contracts and deterministic planning helpers for Auto Mix V2.

V1 product editing deliberately remains in :mod:`product_pipeline`.  This
module is additive: it owns the material-supported duration ceiling, the two
text tracks, licensed-music admission and the fail-closed formal-output gates
required by the V2 contract.
"""

from __future__ import annotations

from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
import math
import re
from typing import Any, Iterable
import unicodedata

from .errors import ContentEngineError
from .hashing import canonical_json_sha256


AUTO_MIX_SPEC_VERSION = "2"
AUTO_MIX_MAX_DURATION_MS = 120_000
AUTO_MIX_MAX_SHOT_MS = 6_500
AUTO_MIX_IMAGE_DURATION_MS = 3_500
AUTO_MIX_CAPTION_CHARS = 14
AUTO_MIX_MIN_TTS_PHRASE_CHARS = 5
AUTO_MIX_MAX_EVIDENCE_REFS = 40

AUTO_MIX_STATES = frozenset(
    {
        "analyzing",
        "planned",
        "synthesizing",
        "verifying_voice",
        "selecting_music",
        "rendering",
        "quality_check",
        "completed",
        "needs_attention",
        "failed",
        "outcome_unknown",
    }
)

VISUAL_TEXT_TYPES = frozenset({"hook", "callout", "cta"})
REGENERATION_LAYERS = frozenset({"text", "voice", "music"})

_CREATE_LEGACY_FIELDS = frozenset(
    {"specVersion", "assetIds", "title", "copyFramework"}
)
_CREATE_GUIDED_FIELDS = frozenset(
    {"specVersion", "guidedSessionId", "scriptRevision"}
)
_MUSIC_IMPORT_FIELDS = frozenset(
    {
        "sourcePath",
        "displayName",
        "source",
        "commercialScope",
        "commercialUseAllowed",
        "licenseStatus",
        "expiresAt",
        "credentialReference",
        "evidencePath",
        "bpm",
        "moods",
        "energy",
        "loopStartMs",
        "loopEndMs",
    }
)
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;])\s*|\n+")
_TEXT_BREAKS = ("，", ",", "、", "：", ":", "；", ";", "。", "！", "？", "!", "?")
GUIDED_SCRIPT_FORBIDDEN_META_PHRASES = (
    "设置标签",
    "素材画面记录了",
    "素材包含",
    "过程记录镜头",
    "结果展示镜头",
    "已确认场景",
    "继续查看真实素材",
    "真实现场记录",
)
_MUSIC_MOOD_ALIAS_GROUPS = (
    (
        frozenset({"calm", "warm"}),
        frozenset(
            {
                "calm",
                "warm",
                "舒缓",
                "温柔",
                "治愈",
                "放松",
                "平静",
                "明亮",
                "relaxed",
                "lighthearted",
            }
        ),
    ),
    (
        frozenset({"steady", "credible"}),
        frozenset(
            {
                "steady",
                "credible",
                "可靠",
                "稳健",
                "稳定",
                "平稳",
                "沉稳",
                "商务",
                "专业",
                "positive",
                "futuristic",
                "technology",
            }
        ),
    ),
    (
        frozenset({"energetic", "driving"}),
        frozenset(
            {
                "energetic",
                "driving",
                "激情",
                "澎湃",
                "冲击",
                "速度",
                "热血",
                "动感",
                "轻快",
                "励志",
                "motivational",
                "dramatic",
                "cinematic",
                "humorous",
                "quirky",
                "comedy",
            }
        ),
    ),
)
_PUBLIC_PLAN_FIELDS = frozenset(
    {
        "usableMaterialDurationMs",
        "estimatedDurationRangeMs",
        "selectedDurationMs",
        "selectedSegments",
        "spokenPhrases",
        "speechCaptions",
        "visualTextItems",
        "voicePersona",
        "music",
        "musicBrief",
        "durationPlan",
        "qualityWarnings",
        "qualityReport",
        "supplementalImage",
        "generatedVideoId",
        "outputCount",
        "cache",
        "attention",
    }
)


class AutoMixV2ContractError(ContentEngineError):
    def __init__(self, code: str, message: str):
        super().__init__(code, message)


def _contract(condition: bool, code: str, message: str) -> None:
    if not condition:
        raise AutoMixV2ContractError(code, message)


def _clean_text(value: Any, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _canonical_music_moods(values: Iterable[Any] | None) -> set[str]:
    output: set[str] = set()
    for value in values or ():
        token = unicodedata.normalize("NFKC", _clean_text(value, 40)).casefold()
        if not token:
            continue
        for canonical, aliases in _MUSIC_MOOD_ALIAS_GROUPS:
            if token in aliases:
                output.update(canonical)
                break
        else:
            output.add(token)
    return output


def canonical_hash(value: Any) -> str:
    return canonical_json_sha256(value)


def validate_create_auto_mix_v2(value: Any) -> dict[str, Any]:
    _contract(isinstance(value, dict), "invalid_auto_mix_v2", "V2 创建请求必须是对象。")
    fields = set(value)
    _contract(
        fields == _CREATE_LEGACY_FIELDS or fields == _CREATE_GUIDED_FIELDS,
        "invalid_auto_mix_v2_fields",
        "V2 创建请求包含不支持的字段。",
    )
    spec_version = _clean_text(value.get("specVersion"), 16)
    _contract(
        spec_version == AUTO_MIX_SPEC_VERSION,
        "unsupported_auto_mix_spec",
        "当前只支持一键混剪 V2 契约。",
    )
    if fields == _CREATE_GUIDED_FIELDS:
        guided_session_id = _clean_text(value.get("guidedSessionId"), 128)
        script_revision = value.get("scriptRevision")
        _contract(
            bool(_SAFE_ID.fullmatch(guided_session_id))
            and guided_session_id.startswith("guided_auto_mix_session_"),
            "invalid_guided_auto_mix_session",
            "引导脚本会话无效，请重新解析素材。",
        )
        _contract(
            isinstance(script_revision, int)
            and not isinstance(script_revision, bool)
            and 1 <= script_revision <= 1_000_000,
            "invalid_guided_auto_mix_script_revision",
            "引导脚本版本无效，请重新生成脚本。",
        )
        return {
            "mode": "guided",
            "spec_version": spec_version,
            "guided_session_id": guided_session_id,
            "script_revision": script_revision,
            "duration_policy": "fit_materials",
            "copy_policy": "guided_script",
            "voice_policy": "tts_only",
            "music_policy": "licensed_auto",
            "output_count": 1,
        }

    raw_asset_ids = value.get("assetIds")
    _contract(
        isinstance(raw_asset_ids, list) and 1 <= len(raw_asset_ids) <= 120,
        "invalid_auto_mix_assets",
        "请提供 1 到 120 条素材。",
    )
    asset_ids = []
    for item in raw_asset_ids:
        candidate = str(item or "").strip()
        _contract(
            bool(_SAFE_ID.fullmatch(candidate)),
            "invalid_auto_mix_asset_id",
            "素材标识无效。",
        )
        if candidate not in asset_ids:
            asset_ids.append(candidate)
    _contract(
        bool(asset_ids),
        "invalid_auto_mix_assets",
        "请至少提供一条素材。",
    )
    title = _clean_text(value.get("title"), 100)
    copy_framework = _clean_text(value.get("copyFramework"), 2_400)
    _contract(bool(title), "auto_mix_title_missing", "请填写视频标题。")
    _contract(
        bool(copy_framework),
        "auto_mix_copy_framework_missing",
        "请填写文案框架。",
    )
    return {
        "mode": "legacy",
        "spec_version": spec_version,
        "asset_ids": asset_ids,
        "title": title,
        "copy_framework": copy_framework,
        "duration_policy": "fit_materials",
        "copy_policy": "smart_spoken",
        "voice_policy": "tts_only",
        "music_policy": "licensed_auto",
        "output_count": 1,
    }


def validate_music_catalog_track_v1(value: Any) -> dict[str, Any]:
    _contract(isinstance(value, dict), "invalid_music_track", "授权音乐导入请求必须是对象。")
    _contract(
        not (set(value) - _MUSIC_IMPORT_FIELDS),
        "invalid_music_track_fields",
        "授权音乐导入请求包含不支持的字段。",
    )
    source_path = str(value.get("sourcePath") or "").strip()
    display_name = _clean_text(value.get("displayName"), 160)
    source = _clean_text(value.get("source"), 160)
    commercial_scope = _clean_text(value.get("commercialScope"), 240)
    commercial_use_allowed = value.get("commercialUseAllowed")
    license_status = str(value.get("licenseStatus") or "unknown").strip()
    credential_reference = _clean_text(value.get("credentialReference"), 240)
    evidence_path = str(value.get("evidencePath") or "").strip()
    _contract(bool(source_path), "music_source_path_missing", "请选择真实音乐文件。")
    _contract(bool(display_name), "music_display_name_missing", "请填写曲目名称。")
    _contract(bool(source), "music_source_missing", "请填写曲目来源。")
    _contract(
        bool(commercial_scope),
        "music_commercial_scope_missing",
        "请填写音乐的商用范围。",
    )
    _contract(
        isinstance(commercial_use_allowed, bool),
        "music_commercial_entitlement_invalid",
        "请明确该授权是否允许商用。",
    )
    _contract(
        license_status in {"valid", "expired", "restricted", "unknown"},
        "music_license_status_invalid",
        "音乐授权状态无效。",
    )
    if license_status == "valid":
        _contract(
            bool(credential_reference) and bool(evidence_path),
            "music_license_evidence_missing",
            "有效商用音乐必须提供凭证引用和证据文件。",
        )
    expires_at = str(value.get("expiresAt") or "").strip() or None
    if expires_at is not None:
        _contract(
            _parse_utc(expires_at) is not None,
            "music_license_expiry_invalid",
            "音乐授权到期时间无效。",
        )
    bpm = value.get("bpm")
    if bpm is not None:
        _contract(
            not isinstance(bpm, bool) and isinstance(bpm, int) and 20 <= bpm <= 300,
            "music_bpm_invalid",
            "音乐 BPM 必须在 20 到 300 之间。",
        )
    raw_moods = value.get("moods") or []
    _contract(isinstance(raw_moods, list), "music_moods_invalid", "音乐情绪标签无效。")
    moods = [
        _clean_text(item, 40)
        for item in raw_moods
        if _clean_text(item, 40)
    ][:12]
    try:
        energy = float(value.get("energy", 0.5))
    except (TypeError, ValueError) as error:
        raise AutoMixV2ContractError("music_energy_invalid", "音乐能量值无效。") from error
    _contract(
        math.isfinite(energy) and 0 <= energy <= 1,
        "music_energy_invalid",
        "音乐能量值必须在 0 到 1 之间。",
    )
    loop_start = value.get("loopStartMs")
    loop_end = value.get("loopEndMs")
    for raw in (loop_start, loop_end):
        _contract(
            raw is None
            or (not isinstance(raw, bool) and isinstance(raw, int) and raw >= 0),
            "music_loop_invalid",
            "音乐循环点无效。",
        )
    _contract(
        (loop_start is None and loop_end is None)
        or (
            isinstance(loop_start, int)
            and not isinstance(loop_start, bool)
            and isinstance(loop_end, int)
            and not isinstance(loop_end, bool)
            and loop_end > loop_start
        ),
        "music_loop_invalid",
        "音乐循环点必须成对提供。",
    )
    return {
        "source_path": source_path,
        "display_name": display_name,
        "source": source,
        "commercial_scope": commercial_scope,
        "commercial_use_allowed": commercial_use_allowed,
        "license_status": license_status,
        "expires_at": expires_at,
        "credential_reference": credential_reference,
        "evidence_path": evidence_path,
        "bpm": bpm,
        "moods": moods,
        "energy": energy,
        "loop_start_ms": loop_start,
        "loop_end_ms": loop_end,
    }


def _spoken_phrase_character_count(value: Any) -> int:
    return sum(
        1
        for character in str(value or "")
        if character.isalnum() or "\u4e00" <= character <= "\u9fff"
    )


def _split_spoken_text(value: Any, *, limit: int = AUTO_MIX_CAPTION_CHARS) -> list[str]:
    text = _clean_text(value, 2_400)
    if not text:
        return []
    output: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            output.append(remaining)
            break
        max_cut = min(limit, len(remaining) - 1)
        boundary_cuts = [
            index + 1
            for index, character in enumerate(remaining[:max_cut])
            if character in _TEXT_BREAKS
            and _spoken_phrase_character_count(remaining[: index + 1])
            >= AUTO_MIX_MIN_TTS_PHRASE_CHARS
            and _spoken_phrase_character_count(remaining[index + 1 :])
            >= AUTO_MIX_MIN_TTS_PHRASE_CHARS
        ]
        if boundary_cuts:
            cut = max(boundary_cuts)
        else:
            tail_characters = _spoken_phrase_character_count(remaining[limit:])
            if tail_characters < AUTO_MIX_MIN_TTS_PHRASE_CHARS:
                safe_cuts = [
                    index
                    for index in range(max_cut, 0, -1)
                    if _spoken_phrase_character_count(remaining[:index])
                    >= AUTO_MIX_MIN_TTS_PHRASE_CHARS
                    and _spoken_phrase_character_count(remaining[index:])
                    >= AUTO_MIX_MIN_TTS_PHRASE_CHARS
                ]
                cut = safe_cuts[0] if safe_cuts else limit
            else:
                cut = limit
        output.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    normalized: list[str] = []
    for item in output:
        if not item:
            continue
        if not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", item):
            if normalized:
                normalized[-1] = f"{normalized[-1]}{item}"
            continue
        normalized.append(item)
    return normalized


def guided_script_audience_copy_issue(
    hook: Any, voiceover: Any, cta: Any
) -> str | None:
    hook_text = re.sub(r"\s+", "", str(hook or "")).strip()
    voiceover_text = re.sub(r"\s+", "", str(voiceover or "")).strip()
    cta_text = re.sub(r"\s+", "", str(cta or "")).strip()
    if not hook_text:
        return "hook 必须是非空的自然开场句"
    if not voiceover_text:
        return "voiceover 必须是非空的自然口播"
    if not cta_text:
        return "cta 必须是非空的自然收束句"
    combined = f"{hook_text}{voiceover_text}{cta_text}"
    forbidden = next(
        (phrase for phrase in GUIDED_SCRIPT_FORBIDDEN_META_PHRASES if phrase in combined),
        "",
    )
    if forbidden:
        return f"面向观众的文案不能包含内部说明“{forbidden}”"
    sentence_marks = "。！？!?；;"
    if not voiceover_text.startswith(hook_text.rstrip(sentence_marks)):
        return "hook 必须是 voiceover 开头的原句"
    if not voiceover_text.rstrip(sentence_marks).endswith(
        cta_text.rstrip(sentence_marks)
    ):
        return "cta 必须是 voiceover 结尾的原句"
    return None


def _normalized_evidence_facts(value: Any) -> list[dict[str, Any]]:
    output = []
    seen = set()
    for index, raw in enumerate(value or []):
        if not isinstance(raw, dict):
            continue
        text = _clean_text(raw.get("text"), 96).strip(" ，。；、")
        if len(text) < 2:
            continue
        signature = text.casefold()
        if signature in seen:
            continue
        seen.add(signature)
        refs = [
            _clean_text(item, 128)
            for item in raw.get("evidenceRefs") or raw.get("evidence_refs") or []
            if _clean_text(item, 128)
        ]
        output.append(
            {
                "factId": _clean_text(raw.get("factId"), 64)
                or f"material-fact-{index + 1}",
                "text": text,
                "kind": _clean_text(raw.get("kind"), 24) or "visual",
                "role": _clean_text(raw.get("role"), 24) or "process",
                "timelineStartMs": max(0, int(raw.get("timelineStartMs") or 0)),
                "qualityScore": min(
                    1.0, max(0.0, float(raw.get("qualityScore") or 0.0))
                ),
                "evidenceRefs": refs[:8],
            }
        )
    return output


def build_material_evidence_facts(timeline: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn selected, traceable material signals into concise factual claims.

    The copy framework is deliberately absent here: it may describe rhetoric,
    but it is not evidence that a product or scene actually has a property.
    """

    shot_labels = {
        "function_demo": "功能演示镜头",
        "function": "功能演示镜头",
        "close_up": "细节特写镜头",
        "closeup": "细节特写镜头",
        "detail": "细节特写镜头",
        "wide": "全景镜头",
        "overview": "全景镜头",
        "before_after": "前后对比镜头",
        "result": "结果展示镜头",
        "action": "动作过程镜头",
        "process": "过程记录镜头",
    }
    role_labels = {
        "hook": "开场镜头",
        "process": "过程记录镜头",
        "result": "结果展示镜头",
    }
    facts = []
    seen = set()

    def admit(segment: dict[str, Any], text: Any, kind: str, field: str) -> None:
        clean = _clean_text(text, 72).strip(" ，。；、")
        if len(clean) < 2 or clean.casefold() in seen or len(facts) >= 16:
            return
        seen.add(clean.casefold())
        reference = _clean_text(
            segment.get("evidence_ref") or segment.get("segment_id"), 96
        )
        facts.append(
            {
                "factId": f"material-fact-{len(facts) + 1}",
                "text": clean,
                "kind": kind,
                "role": _clean_text(segment.get("role"), 24) or "process",
                "timelineStartMs": max(
                    0, int(segment.get("timeline_start_ms") or 0)
                ),
                "qualityScore": float(segment.get("quality_score") or 0.0),
                "evidenceRefs": [
                    f"{reference}:{field}" if reference else f"material:{field}"
                ],
            }
        )

    for segment in timeline.get("selected_segments") or []:
        if not isinstance(segment, dict):
            continue
        admit(segment, segment.get("verifiable_text"), "verifiable_text", "text")
        admit(segment, segment.get("description"), "visual", "description")
        tags = [
            _clean_text(item, 24).strip(" ，。；、")
            for item in segment.get("tags") or []
            if _clean_text(item, 24).strip(" ，。；、")
        ]
        if tags:
            admit(segment, "、".join(tags[:3]), "structured", "tags")
        shot_type = _clean_text(
            segment.get("shot_type") or segment.get("source_tag"), 40
        ).casefold()
        label = next(
            (value for token, value in shot_labels.items() if token in shot_type),
            "",
        )
        if label:
            admit(segment, label, "structured", "shot_type")
        elif not any(
            fact.get("timelineStartMs")
            == max(0, int(segment.get("timeline_start_ms") or 0))
            for fact in facts
        ):
            admit(
                segment,
                role_labels.get(str(segment.get("role") or ""), ""),
                "structured",
                "role",
            )
    return _normalized_evidence_facts(facts)


def build_grounded_text_tracks(
    *,
    title: str,
    copy_framework: str,
    evidence_facts: Iterable[dict[str, Any]] | None = None,
    generation: int = 1,
) -> dict[str, Any]:
    """Use the framework as structure while speaking only material-backed facts."""
    safe_title = _clean_text(title, 100)
    safe_framework = _clean_text(copy_framework, 2_400)
    _contract(bool(safe_title), "auto_mix_title_missing", "请填写视频标题。")
    _contract(
        bool(safe_framework),
        "auto_mix_copy_framework_missing",
        "请填写文案框架。",
    )
    facts = _normalized_evidence_facts(evidence_facts)
    _contract(
        bool(facts),
        "auto_mix_material_facts_insufficient",
        "所选素材没有足够的可核验事实，无法生成可信口播。",
    )
    generation = max(1, int(generation or 1))
    ordered_facts = list(facts)
    if generation > 1 and len(ordered_facts) > 1:
        offset = (generation - 1) % len(ordered_facts)
        ordered_facts = ordered_facts[offset:] + ordered_facts[:offset]
    variants = {
        "verifiable_text": ("素材中提到{fact}", "这一段提到{fact}"),
        "visual": ("画面记录了{fact}", "现场可以看到{fact}"),
        "structured": ("素材包含{fact}", "这段是{fact}"),
    }
    spoken = []
    for fact in ordered_facts[:12]:
        templates = variants.get(fact["kind"], variants["visual"])
        rendered = templates[(generation - 1) % len(templates)].format(
            fact=fact["text"]
        )
        for phrase_text in _split_spoken_text(rendered):
            spoken.append(
                {
                    "phraseId": f"phrase-{len(spoken) + 1}",
                    "text": phrase_text,
                    "evidenceRefs": fact["evidenceRefs"],
                }
            )
    _contract(bool(spoken), "auto_mix_text_invalid", "没有可合成的事实口播。")
    hook_text = _split_spoken_text(safe_title)[0]
    visual = [{"textItemId": "visual-hook", "type": "hook", "text": hook_text}]
    for fact in ordered_facts[:4]:
        callout = _split_spoken_text(fact["text"])[0]
        visual.append(
            {
                "textItemId": f"visual-callout-{len(visual)}",
                "type": "callout",
                "text": callout,
                "evidenceRefs": fact["evidenceRefs"],
            }
        )
    wants_details = any(
        token in safe_framework for token in ("咨询", "了解", "详情", "联系")
    )
    cta_options = (
        ("了解素材详情", "查看真实素材")
        if wants_details
        else ("继续看真实现场", "回看素材重点")
    )
    visual.append(
        {
            "textItemId": "visual-cta",
            "type": "cta",
            "text": cta_options[(generation - 1) % len(cta_options)],
        }
    )
    return {
        "spoken_phrases": spoken,
        "visual_text_items": visual,
        "evidence_facts": facts,
    }


def normalize_text_tracks(value: Any) -> dict[str, Any]:
    _contract(isinstance(value, dict), "auto_mix_text_invalid", "文案结果格式无效。")
    spoken = []
    for raw in value.get("spokenPhrases") or value.get("spoken_phrases") or []:
        if not isinstance(raw, dict):
            continue
        refs = [
            _clean_text(item, 128)
            for item in raw.get("evidenceRefs") or raw.get("evidence_refs") or []
            if _clean_text(item, 128)
        ]
        for text in _split_spoken_text(raw.get("text")):
            spoken.append(
                {
                    "phraseId": f"phrase-{len(spoken) + 1}",
                    "text": text,
                    "evidenceRefs": refs[:AUTO_MIX_MAX_EVIDENCE_REFS],
                }
            )
    _contract(bool(spoken), "auto_mix_text_invalid", "没有可合成的口播短语。")

    visual = []
    for raw in value.get("visualTextItems") or value.get("visual_text_items") or []:
        if not isinstance(raw, dict):
            continue
        item_type = str(raw.get("type") or "").strip()
        text = _clean_text(raw.get("text"), 48)
        _contract(
            item_type in VISUAL_TEXT_TYPES,
            "auto_mix_visual_text_type_invalid",
            "画面文字只允许钩子、卖点和行动提示。",
        )
        if text:
            item = {
                "textItemId": f"visual-{len(visual) + 1}",
                "type": item_type,
                "text": text,
            }
            refs = [
                _clean_text(reference, 128)
                for reference in raw.get("evidenceRefs")
                or raw.get("evidence_refs")
                or []
                if _clean_text(reference, 128)
            ]
            if refs:
                item["evidenceRefs"] = refs[:AUTO_MIX_MAX_EVIDENCE_REFS]
            visual.append(item)
    _contract(bool(visual), "auto_mix_visual_text_missing", "没有可用的画面文字。")
    return {"spoken_phrases": spoken, "visual_text_items": visual}


def build_speech_captions(
    phrases: list[dict[str, Any]],
    durations_ms: Iterable[int],
    *,
    pause_ms: int = 160,
) -> list[dict[str, Any]]:
    durations = list(durations_ms)
    _contract(
        len(phrases) == len(durations),
        "auto_mix_voice_timing_invalid",
        "口播短语和音频时长数量不一致。",
    )
    pause_ms = max(0, min(1_000, int(pause_ms)))
    cursor = 0
    captions = []
    for index, (phrase, raw_duration) in enumerate(zip(phrases, durations)):
        duration_ms = int(raw_duration)
        text = re.sub(r"\s+", " ", str(phrase.get("text") or "")).strip()
        _contract(
            0 < len(text) <= 2400 and 0 < duration_ms <= 120_000,
            "auto_mix_voice_timing_invalid",
            "口播短语的真实音频时长无效。",
        )
        captions.append(
            {
                "captionId": str(phrase.get("phraseId") or f"phrase-{index + 1}"),
                "start_ms": cursor,
                "end_ms": cursor + duration_ms,
                "text": text,
                "caption_source": "tts_voiceover",
                "timing": "audio_measured",
            }
        )
        cursor += duration_ms + (pause_ms if index < len(phrases) - 1 else 0)
    return captions


def _normalize_spoken_phrase_text(value: Any) -> str:
    return "".join(
        character.casefold()
        for character in unicodedata.normalize("NFKC", str(value or ""))
        if character.isalnum() or "\u4e00" <= character <= "\u9fff"
    )


def matching_spoken_critical_terms(
    expected_text: Any, critical_terms: Any = ()
) -> tuple[str, ...]:
    expected = _normalize_spoken_phrase_text(expected_text)
    terms = critical_terms if isinstance(critical_terms, (list, tuple)) else ()
    matching = set()
    for term in terms:
        normalized_term = _normalize_spoken_phrase_text(term)
        if 2 <= len(normalized_term) <= 100 and normalized_term in expected:
            matching.add(normalized_term)
    return tuple(sorted(matching))


def verify_spoken_phrase(
    expected_text: Any,
    recognized_text: Any,
    *,
    title: Any = "",
    critical_terms: Any = (),
) -> dict[str, Any]:
    """Check ASR wording while keeping brands and numbers fail-closed."""

    expected = _normalize_spoken_phrase_text(expected_text)
    recognized = _normalize_spoken_phrase_text(recognized_text)
    _contract(
        bool(expected) and bool(recognized),
        "auto_mix_voice_verification_invalid",
        "配音回听没有得到可核对的文字。",
    )
    critical = {
        _normalize_spoken_phrase_text(token)
        for token in re.findall(r"\d+(?:\.\d+)?%?", str(expected_text or ""))
        if _normalize_spoken_phrase_text(token)
    }
    safe_title = _normalize_spoken_phrase_text(title)
    if 2 <= len(safe_title) <= 24 and safe_title in expected:
        critical.add(safe_title)
    critical.update(matching_spoken_critical_terms(expected_text, critical_terms))
    missing = sorted(token for token in critical if token not in recognized)
    matcher = SequenceMatcher(None, expected, recognized)
    similarity = matcher.ratio()
    # Mandarin ASR cannot distinguish a small number of same-sound characters
    # (for example, 闸机 / 炸鸡). Keep brands and numbers fail-closed, but do
    # not reject a short, otherwise anchored sentence solely for that ambiguity.
    short_phrase_anchor = max(5, len(expected) - 3)
    short_asr_homophone_match = (
        not missing
        and 8 <= len(expected) <= 14
        and len(expected) == len(recognized)
        and similarity >= short_phrase_anchor / len(expected)
        and matcher.find_longest_match(
            0, len(expected), 0, len(recognized)
        ).size >= short_phrase_anchor
    )
    return {
        "matched": not missing and (
            similarity >= 0.72 or short_asr_homophone_match
        ),
        "similarity": round(similarity, 4),
        "missingCriticalTokens": missing,
        "criticalTokenCount": len(critical),
    }


def _usable_interval(asset: dict[str, Any], raw: dict[str, Any]) -> dict[str, Any] | None:
    if raw.get("usable") is False:
        return None
    metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    if any(
        bool(raw.get(field) or metadata.get(field))
        for field in ("black_screen", "severe_blur", "frozen", "meaningless")
    ):
        return None
    start_ms = max(0, int(raw.get("start_ms") or 0))
    end_ms = max(start_ms, int(raw.get("end_ms") or 0))
    if end_ms <= start_ms:
        return None
    quality = float(raw.get("quality_score") or 0)
    if not math.isfinite(quality) or quality < 0.35:
        return None
    return {
        "asset_id": str(asset.get("asset_id") or ""),
        "media_kind": str(asset.get("media_kind") or "video"),
        "start_ms": start_ms,
        "end_ms": end_ms,
        "quality_score": min(1.0, max(0.0, quality)),
        "role": _clean_text(raw.get("role") or "process", 24) or "process",
        "source_tag": _clean_text(raw.get("source_tag") or raw.get("shot_type"), 40),
        "shot_type": _clean_text(raw.get("shot_type"), 40),
        "description": _clean_text(raw.get("description"), 240),
        "verifiable_text": _clean_text(raw.get("verifiable_text"), 240),
        "tags": [
            _clean_text(item, 40)
            for item in raw.get("tags") or []
            if _clean_text(item, 40)
        ][:12],
        "evidence_ref": _clean_text(raw.get("evidence_ref"), 96),
        "content_signature": _clean_text(raw.get("content_signature"), 128),
    }


def build_material_timeline(
    assets: list[dict[str, Any]], *, ceiling_ms: int = AUTO_MIX_MAX_DURATION_MS
) -> dict[str, Any]:
    ceiling_ms = max(1_000, min(AUTO_MIX_MAX_DURATION_MS, int(ceiling_ms)))
    candidates = []
    for asset in assets or []:
        if not isinstance(asset, dict) or not _SAFE_ID.fullmatch(
            str(asset.get("asset_id") or "")
        ):
            continue
        raw_intervals = asset.get("usable_intervals") or []
        if not raw_intervals and asset.get("media_kind") == "image":
            raw_intervals = [
                {
                    "start_ms": 0,
                    "end_ms": AUTO_MIX_IMAGE_DURATION_MS,
                    "quality_score": float(asset.get("quality_score") or 0.7),
                    "role": "process",
                }
            ]
        for raw in raw_intervals:
            if not isinstance(raw, dict):
                continue
            interval = _usable_interval(asset, raw)
            if interval is None:
                continue
            candidates.append(interval)
    # Analysis providers may emit overlapping semantic windows. Prefer the
    # strongest one and admit each source millisecond at most once. Content
    # signatures apply across assets so duplicate footage is not selected
    # merely because it was imported twice.
    intervals = []
    seen_signatures = set()
    accepted_ranges: dict[str, list[tuple[int, int]]] = {}
    for interval in sorted(
        candidates,
        key=lambda item: (
            -item["quality_score"],
            item["asset_id"],
            item["start_ms"],
            item["end_ms"],
        ),
    ):
        signature = interval["content_signature"]
        if signature and signature in seen_signatures:
            continue
        ranges = accepted_ranges.setdefault(interval["asset_id"], [])
        if any(
            interval["start_ms"] < end_ms and start_ms < interval["end_ms"]
            for start_ms, end_ms in ranges
        ):
            continue
        ranges.append((interval["start_ms"], interval["end_ms"]))
        if signature:
            seen_signatures.add(signature)
        intervals.append(interval)
    intervals.sort(
        key=lambda item: (
            {"hook": 0, "process": 1, "result": 2}.get(item["role"], 1),
            -item["quality_score"],
            item["asset_id"],
            item["start_ms"],
        )
    )
    usable_duration = sum(item["end_ms"] - item["start_ms"] for item in intervals)
    selected = []
    cursor = 0
    for interval in intervals:
        source_cursor = interval["start_ms"]
        while source_cursor < interval["end_ms"] and cursor < ceiling_ms:
            length = min(
                AUTO_MIX_MAX_SHOT_MS,
                interval["end_ms"] - source_cursor,
                ceiling_ms - cursor,
            )
            if length <= 0:
                break
            selected.append(
                {
                    "segment_id": f"segment-{len(selected) + 1}",
                    "asset_id": interval["asset_id"],
                    "media_kind": interval["media_kind"],
                    "source_start_ms": source_cursor,
                    "source_end_ms": source_cursor + length,
                    "timeline_start_ms": cursor,
                    "timeline_end_ms": cursor + length,
                    "target_duration_ms": length,
                    "role": interval["role"],
                    "source_tag": interval["source_tag"],
                    "shot_type": interval["shot_type"],
                    "description": interval["description"],
                    "verifiable_text": interval["verifiable_text"],
                    "tags": interval["tags"],
                    "evidence_ref": interval["evidence_ref"],
                    "quality_score": interval["quality_score"],
                }
            )
            source_cursor += length
            cursor += length
    return {
        "usable_material_duration_ms": usable_duration,
        "selected_duration_ms": cursor,
        "estimated_duration_range_ms": {
            "min": min(cursor, max(1_000, int(cursor * 0.65))) if cursor else 0,
            "max": cursor,
        },
        "selected_segments": selected,
        "shortened_to_ceiling": usable_duration > ceiling_ms,
        "padded": False,
        "looped": False,
    }


def align_material_timeline_to_captions(
    timeline: dict[str, Any],
    phrases: Iterable[dict[str, Any]],
    captions: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Arrange non-repeating source ranges around measured evidence windows."""

    phrase_items = [dict(item) for item in phrases or [] if isinstance(item, dict)]
    caption_items = [dict(item) for item in captions or [] if isinstance(item, dict)]
    _contract(
        bool(phrase_items) and len(phrase_items) == len(caption_items),
        "auto_mix_voice_timing_invalid",
        "口播短语和真实字幕边界数量不一致。",
    )
    source_segments = [
        dict(item)
        for item in timeline.get("selected_segments") or []
        if isinstance(item, dict) and int(item.get("target_duration_ms") or 0) > 0
    ]
    _contract(
        bool(source_segments),
        "auto_mix_material_too_short",
        "没有合格素材可承载真实配音。",
    )

    canonical_for_key: dict[str, str] = {}
    pools: dict[str, list[int]] = {}
    capacities: dict[str, int] = {}
    for index, segment in enumerate(source_segments):
        segment_id = _clean_text(segment.get("segment_id"), 128)
        canonical = _clean_text(segment.get("evidence_ref"), 128) or segment_id
        if not canonical:
            continue
        aliases = {canonical, segment_id}
        for alias in aliases:
            if alias:
                canonical_for_key[alias] = canonical
        pools.setdefault(canonical, []).append(index)
        capacities[canonical] = capacities.get(canonical, 0) + int(
            segment["target_duration_ms"]
        )

    speech_requests: list[dict[str, Any]] = []
    cursor = 0
    for phrase, caption in zip(phrase_items, caption_items):
        start_ms = int(caption.get("start_ms") or 0)
        end_ms = int(caption.get("end_ms") or 0)
        _contract(
            str(caption.get("timing") or "") == "audio_measured"
            and start_ms >= cursor
            and end_ms > start_ms,
            "auto_mix_voice_timing_invalid",
            "正式口播必须使用按真实音频测量且单调递增的字幕边界。",
        )
        speech_duration = end_ms - start_ms
        roots = []
        for reference in phrase.get("evidenceRefs") or phrase.get("evidence_refs") or []:
            raw_key = _clean_text(reference, 128).split(":", 1)[0]
            canonical = canonical_for_key.get(raw_key, "")
            if canonical and canonical not in roots:
                roots.append(canonical)
        _contract(
            bool(roots),
            "auto_mix_material_evidence_missing",
            "口播短语没有可用于对应真实字幕窗口的素材镜头。",
        )
        speech_requests.append(
            {
                "roots": roots,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "duration_ms": speech_duration,
            }
        )
        cursor = end_ms

    remaining_capacities = dict(capacities)
    speech_assignments = ["" for _item in speech_requests]
    failed_assignment_states: set[tuple[Any, ...]] = set()
    capacity_keys = tuple(pools)

    def assign_speech_roots(pending: tuple[int, ...]) -> bool:
        if not pending:
            return True
        state = (
            pending,
            tuple(remaining_capacities.get(root, 0) for root in capacity_keys),
        )
        if state in failed_assignment_states:
            return False
        feasible_by_index = {
            index: [
                root
                for root in speech_requests[index]["roots"]
                if int(remaining_capacities.get(root) or 0)
                >= int(speech_requests[index]["duration_ms"])
            ]
            for index in pending
        }
        if any(not roots for roots in feasible_by_index.values()):
            failed_assignment_states.add(state)
            return False
        selected_index = min(
            pending,
            key=lambda index: (len(feasible_by_index[index]), index),
        )
        next_pending = tuple(index for index in pending if index != selected_index)
        duration_ms = int(speech_requests[selected_index]["duration_ms"])
        for root in feasible_by_index[selected_index]:
            remaining_capacities[root] -= duration_ms
            speech_assignments[selected_index] = root
            if assign_speech_roots(next_pending):
                return True
            speech_assignments[selected_index] = ""
            remaining_capacities[root] += duration_ms
        failed_assignment_states.add(state)
        return False

    assigned = assign_speech_roots(tuple(range(len(speech_requests))))
    _contract(
        assigned,
        "auto_mix_material_evidence_too_short",
        "引用素材不足以覆盖对应口播的真实时间窗口。",
    )
    speech_blocks = [
        {
            "evidence_key": speech_assignments[index],
            "start_ms": request["start_ms"],
            "end_ms": request["end_ms"],
            "duration_ms": request["duration_ms"],
        }
        for index, request in enumerate(speech_requests)
    ]

    _contract(
        int(timeline.get("selected_duration_ms") or 0) >= cursor,
        "auto_mix_material_too_short",
        "合格素材不足以承载实际配音时长。",
    )

    blocks: list[dict[str, Any]] = []

    def append_block(evidence_key: str, start_ms: int, end_ms: int) -> None:
        duration_ms = end_ms - start_ms
        if duration_ms <= 0:
            return
        if (
            blocks
            and blocks[-1]["evidence_key"] == evidence_key
            and blocks[-1]["end_ms"] == start_ms
        ):
            blocks[-1]["end_ms"] = end_ms
            blocks[-1]["duration_ms"] += duration_ms
        else:
            blocks.append(
                {
                    "evidence_key": evidence_key,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "duration_ms": duration_ms,
                }
            )

    cursor = 0
    previous_speech_root = ""
    for speech_block in speech_blocks:
        gap_remaining = int(speech_block["start_ms"]) - cursor
        current_speech_root = str(speech_block["evidence_key"])
        gap_roots = []
        for root in (previous_speech_root, current_speech_root, *pools):
            if root and root not in gap_roots:
                gap_roots.append(root)
        for root in gap_roots:
            if gap_remaining <= 0:
                break
            available = int(remaining_capacities.get(root) or 0)
            if available <= 0:
                continue
            length = min(available, gap_remaining)
            append_block(root, cursor, cursor + length)
            remaining_capacities[root] -= length
            cursor += length
            gap_remaining -= length
        _contract(
            gap_remaining == 0,
            "auto_mix_material_too_short",
            "合格素材不足以承载实际配音时长。",
        )
        append_block(
            current_speech_root,
            int(speech_block["start_ms"]),
            int(speech_block["end_ms"]),
        )
        cursor = int(speech_block["end_ms"])
        previous_speech_root = current_speech_root

    consumed = [0 for _item in source_segments]
    part_counts: dict[str, int] = {}
    output = []
    timeline_cursor = 0
    for block in blocks:
        remaining = int(block["duration_ms"])
        for source_index in pools.get(block["evidence_key"], []):
            if remaining <= 0:
                break
            source = source_segments[source_index]
            capacity = int(source["target_duration_ms"]) - consumed[source_index]
            if capacity <= 0:
                continue
            length = min(capacity, remaining)
            item = dict(source)
            source_start = int(source["source_start_ms"]) + consumed[source_index]
            item["source_start_ms"] = source_start
            item["source_end_ms"] = source_start + length
            item["timeline_start_ms"] = timeline_cursor
            item["timeline_end_ms"] = timeline_cursor + length
            item["target_duration_ms"] = length
            item["evidence_ref"] = block["evidence_key"]
            base_segment_id = _clean_text(source.get("segment_id"), 128) or "segment"
            part_counts[base_segment_id] = part_counts.get(base_segment_id, 0) + 1
            if part_counts[base_segment_id] > 1:
                item["segment_id"] = (
                    f"{base_segment_id}-aligned-{part_counts[base_segment_id]}"
                )
            output.append(item)
            consumed[source_index] += length
            timeline_cursor += length
            remaining -= length
        _contract(
            remaining == 0,
            "auto_mix_material_too_short",
            "引用素材不足以覆盖对应口播的真实时间窗口。",
        )

    return {
        **timeline,
        "selected_duration_ms": timeline_cursor,
        "selected_segments": output,
        "spoken_evidence_refs": [
            {
                "phrase_id": _clean_text(
                    phrase.get("phraseId"), 128
                )
                or f"phrase-{index + 1}",
                "evidence_ref": speech_assignments[index],
            }
            for index, phrase in enumerate(phrase_items)
        ],
        "padded": False,
        "looped": False,
    }


def build_music_brief(
    *,
    title: str,
    copy_framework: str,
    transition_points_ms: Iterable[int],
    material_signals: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    text = f"{title} {copy_framework}".casefold()
    if any(token in text for token in ("激情", "澎湃", "冲击", "速度", "热血")):
        energy = 0.82
        bpm_range = [112, 138]
        moods = ["energetic", "driving"]
        instruments = ["drums", "bass", "synth"]
    elif any(token in text for token in ("舒缓", "温柔", "治愈", "放松", "平静")):
        energy = 0.34
        bpm_range = [72, 96]
        moods = ["calm", "warm"]
        instruments = ["piano", "soft_pad", "light_percussion"]
    else:
        energy = 0.56
        bpm_range = [92, 116]
        moods = ["steady", "credible"]
        instruments = ["light_drums", "bass", "clean_synth"]
    transitions = sorted(
        {
            max(0, min(AUTO_MIX_MAX_DURATION_MS, int(value)))
            for value in transition_points_ms
        }
    )[:32]
    signals = [item for item in material_signals or [] if isinstance(item, dict)]
    duration_ms = max(
        [1, *transitions, *[int(item.get("timeline_end_ms") or 0) for item in signals]]
    )
    role_adjustment = {"hook": 0.08, "process": 0.0, "result": 0.1}
    energetic_tokens = ("action", "motion", "dynamic", "speed", "运动", "动作", "冲击")
    calm_tokens = ("close", "detail", "static", "细节", "静态", "特写")
    curve = []
    role_counts: dict[str, int] = {}
    shot_types = []
    signal_tags = []
    qualities = []
    energetic_signal_count = 0
    for item in signals:
        role = _clean_text(item.get("role"), 24) or "process"
        shot_type = _clean_text(
            item.get("shot_type") or item.get("source_tag"), 40
        ).casefold()
        tags = [
            _clean_text(tag, 32).casefold()
            for tag in item.get("tags") or []
            if _clean_text(tag, 32)
        ]
        combined = " ".join([shot_type, *tags])
        adjustment = role_adjustment.get(role, 0.0)
        if any(token in combined for token in energetic_tokens):
            adjustment += 0.12
            energetic_signal_count += 1
        if any(token in combined for token in calm_tokens):
            adjustment -= 0.08
        quality = min(1.0, max(0.0, float(item.get("quality_score") or 0.0)))
        adjustment += (quality - 0.65) * 0.12
        role_counts[role] = role_counts.get(role, 0) + 1
        if shot_type:
            shot_types.append(shot_type)
        signal_tags.extend(tags)
        qualities.append(quality)
        curve.append(
            {
                "position": round(
                    min(1.0, max(0.0, int(item.get("timeline_start_ms") or 0) / duration_ms)),
                    4,
                ),
                "energy": round(min(0.95, max(0.12, energy + adjustment)), 3),
            }
        )
    if curve:
        curve.sort(key=lambda item: item["position"])
        if curve[0]["position"] > 0:
            curve.insert(0, {"position": 0.0, "energy": curve[0]["energy"]})
        terminal = max(0.2, curve[-1]["energy"] - 0.06)
        curve.append({"position": 1.0, "energy": round(terminal, 3)})
        # Retain structural turns without letting very long source lists make
        # the public plan or selector unbounded.
        if len(curve) > 14:
            step = (len(curve) - 1) / 13
            curve = [curve[round(index * step)] for index in range(14)]
    else:
        curve = [
            {"position": 0.0, "energy": max(0.1, energy - 0.12)},
            {"position": 0.55, "energy": energy},
            {"position": 1.0, "energy": max(0.2, energy - 0.08)},
        ]
    curve_energy = sum(item["energy"] for item in curve) / len(curve)
    transition_density = len([value for value in transitions if value > 0]) / max(
        1.0, duration_ms / 10_000
    )
    if energetic_signal_count or transition_density >= 2.0:
        bpm_range = [max(bpm_range[0], 106), max(bpm_range[1], 126)]
        moods = ["energetic", "driving"]
        instruments = ["drums", "bass", "synth"]
    elif curve_energy <= 0.43:
        bpm_range = [min(bpm_range[0], 78), min(bpm_range[1], 98)]
        moods = ["calm", "warm"]
        instruments = ["piano", "soft_pad", "light_percussion"]
    target_energy = round(min(0.95, max(0.15, curve_energy)), 3)
    section_hints = [{"type": "intro", "atMs": 0}]
    for point in transitions[1:9]:
        section_hints.append({"type": "accent", "atMs": point})
    if duration_ms > 4_000:
        section_hints.append({"type": "cta", "atMs": max(0, duration_ms - 4_000)})
    return {
        "moods": moods,
        "energyCurve": curve,
        "targetEnergy": target_energy,
        "bpmRange": bpm_range,
        "instrumentPreferences": instruments,
        "transitionPointsMs": transitions,
        "introDelayMs": 900 if target_energy < 0.7 else 0,
        "musicSectionHints": section_hints,
        "materialSignals": {
            "roles": role_counts,
            "shotTypes": sorted(set(shot_types))[:12],
            "tags": sorted(set(signal_tags))[:16],
            "averageQuality": round(sum(qualities) / len(qualities), 3)
            if qualities
            else 0.0,
            "transitionDensity": round(transition_density, 3),
        },
    }


def _parse_utc(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def public_music_track(track: dict[str, Any]) -> dict[str, Any]:
    return {
        "trackId": str(track.get("track_id") or ""),
        "displayName": _clean_text(track.get("display_name"), 160),
        "source": _clean_text(track.get("source"), 160),
        "licenseSummary": {
            "status": str(track.get("license_status") or "unknown"),
            "commercialScope": _clean_text(track.get("commercial_scope"), 160),
            "commercialUseAllowed": bool(track.get("commercial_use_allowed")),
            "expiresAt": str(track.get("expires_at") or "") or None,
            "evidencePresent": bool(track.get("evidence_present")),
        },
        "bpm": int(track.get("bpm") or 0) or None,
        "moods": [
            _clean_text(item, 40)
            for item in track.get("moods") or []
            if _clean_text(item, 40)
        ][:12],
        "energy": float(track.get("energy") or 0),
    }


def select_licensed_music(
    tracks: Iterable[dict[str, Any]],
    brief: dict[str, Any],
    *,
    required_duration_ms: int,
    now: datetime | None = None,
    allowed_track_ids: Iterable[str] | None = None,
    prefer_unused_track_ids: Iterable[str] | None = None,
) -> dict[str, Any] | None:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    bpm_min, bpm_max = [int(item) for item in brief.get("bpmRange") or (0, 999)]
    target_energy = float(brief.get("targetEnergy") or 0.5)
    target_moods = _canonical_music_moods(brief.get("moods") or [])
    energy_curve = [
        float(item.get("energy"))
        for item in brief.get("energyCurve") or []
        if isinstance(item, dict) and item.get("energy") is not None
    ]
    curve_mean = (
        sum(energy_curve) / len(energy_curve) if energy_curve else target_energy
    )
    curve_peak = max(energy_curve) if energy_curve else target_energy
    transitions = [
        int(value)
        for value in brief.get("transitionPointsMs") or []
        if int(value) > 0
    ]
    candidates = []
    allowed = set(allowed_track_ids) if allowed_track_ids is not None else None
    used = set(prefer_unused_track_ids or [])
    for track in tracks:
        if not isinstance(track, dict):
            continue
        if allowed is not None and track.get("track_id") not in allowed:
            continue
        expires_at = _parse_utc(track.get("expires_at"))
        loop_start = int(track.get("loop_start_ms") or 0)
        loop_end = int(track.get("loop_end_ms") or 0)
        duration_ms = int(track.get("duration_ms") or 0)
        has_duration = duration_ms >= int(required_duration_ms)
        has_loop = 0 <= loop_start < loop_end <= duration_ms
        if (
            track.get("license_status") != "valid"
            # Non-commercial local recordings require explicit batch selection.
            or (track.get("commercial_use_allowed") is not True and allowed is None)
            or not bool(track.get("evidence_present"))
            or (expires_at is not None and expires_at <= now)
            or track.get("analysis_status") != "ready"
            or not (has_duration or has_loop)
        ):
            continue
        bpm = int(track.get("bpm") or 0)
        energy = float(track.get("energy") or 0)
        moods = _canonical_music_moods(track.get("moods") or [])
        bpm_distance = 0 if bpm_min <= bpm <= bpm_max else min(
            abs(bpm - bpm_min), abs(bpm - bpm_max)
        )
        beat_alignment = 0.5
        if bpm > 0 and transitions:
            beat_ms = 60_000 / bpm
            alignments = []
            for transition in transitions:
                phase = transition % beat_ms
                distance = min(phase, beat_ms - phase)
                alignments.append(max(0.0, 1.0 - (2.0 * distance / beat_ms)))
            beat_alignment = sum(alignments) / len(alignments)
        curve_distance = 0.65 * abs(energy - curve_mean) + 0.35 * abs(
            energy - curve_peak
        )
        score = (
            50
            + min(24, 8 * len(moods & target_moods))
            + max(0, 18 - 32 * curve_distance)
            + max(0, 8 - bpm_distance / 3)
            + 10 * beat_alignment
        )
        candidates.append(
            {
                **track,
                "selection_score": round(score, 3),
                "public": public_music_track(track),
            }
        )
    if not candidates:
        return None
    # Rotate only among suitable tracks; a very poor mood match should not win
    # merely because it has not played in this batch yet.
    if used:
        best_score = max(float(item["selection_score"]) for item in candidates)
        fresh = [item for item in candidates if item.get("track_id") not in used
                 and float(item["selection_score"]) >= best_score - 12]
        if fresh:
            candidates = fresh
    return max(
        candidates,
        key=lambda item: (
            float(item["selection_score"]),
            str(item.get("track_id") or ""),
        ),
    )


def invalidated_stages_for_layer(layer: str) -> tuple[str, ...]:
    value = str(layer or "").strip()
    _contract(
        value in REGENERATION_LAYERS,
        "invalid_auto_mix_layer",
        "局部重做只支持文字、声音或音乐。",
    )
    if value == "text":
        return ("text", "tts", "voice_alignment", "mix", "render", "quality_check")
    if value == "voice":
        return ("tts", "voice_alignment", "mix", "render", "quality_check")
    return ("music_selection", "mix", "render", "quality_check")


def validate_formal_recipe(recipe: Any) -> dict[str, Any]:
    _contract(isinstance(recipe, dict), "auto_mix_recipe_invalid", "成片配方无效。")
    _contract(
        recipe.get("product_workflow") == "one_click_v2",
        "auto_mix_recipe_invalid",
        "正式 V2 成片必须使用 V2 配方。",
    )
    for caption in recipe.get("captions") or []:
        _contract(
            isinstance(caption, dict)
            and caption.get("timing")
            in {"audio_measured", "asr_aligned", "forced_aligned"},
            "auto_mix_caption_estimated",
            "正式 V2 成片不得使用估算字幕时间。",
        )
    packaging = recipe.get("packaging") if isinstance(recipe.get("packaging"), dict) else {}
    visual = packaging.get("visualRenderer") or packaging.get("visual_renderer") or {}
    _contract(
        visual.get("requestedEngine") == "remotion"
        and visual.get("actualEngine") == "remotion"
        and visual.get("allowFallback") is False,
        "auto_mix_remotion_required",
        "正式 V2 成片必须由 Remotion 完成文字动画。",
    )
    _contract(
        bool(recipe.get("voice_audio_path")),
        "auto_mix_voice_required",
        "正式 V2 成片必须包含已验证的 TTS 人声。",
    )
    _contract(
        bool(recipe.get("licensed_music_relative_path")),
        "auto_mix_music_required",
        "正式 V2 成片必须包含有效授权音乐。",
    )
    return recipe


def validate_quality_report(value: Any) -> dict[str, Any]:
    _contract(isinstance(value, dict), "auto_mix_quality_invalid", "音频质量报告无效。")
    try:
        integrated = float(value.get("integrated_lufs"))
        true_peak = float(value.get("true_peak_dbtp"))
        margin = float(value.get("speech_music_margin_lu"))
    except (TypeError, ValueError) as error:
        raise AutoMixV2ContractError(
            "auto_mix_quality_invalid", "音频质量报告缺少必要指标。"
        ) from error
    _contract(
        all(math.isfinite(item) for item in (integrated, true_peak, margin)),
        "auto_mix_quality_invalid",
        "音频质量指标不是有限数值。",
    )
    _contract(
        -16.0 <= integrated <= -14.0,
        "auto_mix_loudness_failed",
        "成片综合响度未达到 -16 到 -14 LUFS。",
    )
    _contract(
        true_peak <= -1.0,
        "auto_mix_true_peak_failed",
        "成片 True Peak 高于 -1 dBTP。",
    )
    _contract(
        8.0 <= margin <= 12.0,
        "auto_mix_voice_music_margin_failed",
        "说话窗口的人声与音乐余量未达到 8 到 12 LU。",
    )
    return {
        "passed": True,
        "integratedLufs": integrated,
        "truePeakDbtp": true_peak,
        "speechMusicMarginLu": margin,
    }


def public_auto_mix_plan(value: Any) -> dict[str, Any]:
    _contract(isinstance(value, dict), "auto_mix_run_invalid", "V2 运行记录无效。")
    state = str(value.get("status") or "failed")
    _contract(state in AUTO_MIX_STATES, "auto_mix_state_invalid", "V2 状态无效。")
    source = value.get("public_plan") if isinstance(value.get("public_plan"), dict) else {}
    plan = {
        key: json.loads(json.dumps(source[key], ensure_ascii=False, allow_nan=False))
        for key in _PUBLIC_PLAN_FIELDS
        if key in source
    }
    plan.setdefault("outputCount", 1)
    input_asset_ids = []
    raw_input_asset_ids = value.get("input_asset_ids")
    if isinstance(raw_input_asset_ids, list):
        for item in raw_input_asset_ids[:120]:
            candidate = str(item or "").strip()
            if _SAFE_ID.fullmatch(candidate) and candidate not in input_asset_ids:
                input_asset_ids.append(candidate)
    return {
        "specVersion": str(value.get("spec_version") or AUTO_MIX_SPEC_VERSION),
        "runId": str(value.get("run_id") or value.get("id") or ""),
        "projectId": str(value.get("project_id") or ""),
        "taskId": str(value.get("task_id") or "") or None,
        "parentRunId": str(value.get("parent_run_id") or "") or None,
        "generation": max(1, int(value.get("generation") or 1)),
        "state": state,
        **plan,
        "inputAssetIds": input_asset_ids,
    }
