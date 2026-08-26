from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from .errors import ContentEngineError


PACKAGING_SCHEMA_VERSION = 1
COVER_PROMPT_VERSION = "content_specific_neutral_v1"
MOTION_EVENT_TYPES = frozenset(
    {"hook", "keyword", "emphasis", "step", "scene", "result", "warning", "quote"}
)
MOTION_ZONE_ORDER = (
    "top_banner",
    "upper_left",
    "upper_right",
    "middle_left",
    "middle_right",
)
MOTION_LAYOUT_ZONES = frozenset(MOTION_ZONE_ORDER)
MOTION_EVENT_SIZES = frozenset({"hero", "card", "chip"})


def _preset(
    preset_id: str,
    kind: str,
    display_name: str,
    *,
    subtitle: dict[str, Any],
    effects: dict[str, Any],
    audio: dict[str, Any],
) -> dict[str, Any]:
    return {
        "preset_id": preset_id,
        "version": PACKAGING_SCHEMA_VERSION,
        "kind": kind,
        "display_name": display_name,
        "subtitle": subtitle,
        "effects": effects,
        "audio": audio,
        "cover": {
            "layout": "portrait_title",
            "aspect_ratio": "9:16",
            "prompt_profile": "content_specific_neutral",
            "prompt_version": COVER_PROMPT_VERSION,
        },
    }


PACKAGING_PRESETS = {
    "knowledge_focus": _preset(
        "knowledge_focus",
        "course",
        "知识观点",
        subtitle={"preset": "knowledge_course", "font_size": 44, "margin_bottom": 150, "max_chars": 14},
        effects={"title_card": True, "keyword_card": True, "gentle_push": True, "sticker_budget": 0},
        audio={"profile": "course_clean", "bgm": False, "cue_budget": 2},
    ),
    "slide_teacher": _preset(
        "slide_teacher",
        "course",
        "课件讲解",
        subtitle={"preset": "knowledge_course", "font_size": 42, "margin_bottom": 145, "max_chars": 14},
        effects={"title_card": True, "slide_focus": True, "teacher_pip": True, "gentle_push": False, "sticker_budget": 0},
        audio={"profile": "course_clean", "bgm": False, "cue_budget": 2},
    ),
    "classroom_value": _preset(
        "classroom_value",
        "course",
        "课堂价值",
        subtitle={"preset": "knowledge_course", "font_size": 43, "margin_bottom": 150, "max_chars": 14},
        effects={"title_card": True, "classroom_broll": True, "gentle_push": True, "sticker_budget": 0},
        audio={"profile": "course_clean", "bgm": False, "cue_budget": 2},
    ),
    "hook_impact": _preset(
        "hook_impact",
        "mix",
        "开场冲击",
        subtitle={"preset": "energetic_talking", "font_size": 48, "margin_bottom": 145, "max_chars": 12},
        effects={"title_card": True, "hook_punch": True, "gentle_push": True, "sticker_budget": 2},
        audio={"profile": "mix_rhythm", "bgm": True, "bgm_gain_db": -24, "cue_budget": 4},
    ),
    "process_rhythm": _preset(
        "process_rhythm",
        "mix",
        "过程节奏",
        subtitle={"preset": "energetic_talking", "font_size": 46, "margin_bottom": 145, "max_chars": 12},
        effects={"title_card": True, "step_cards": True, "gentle_push": False, "sticker_budget": 2},
        audio={"profile": "mix_rhythm", "bgm": True, "bgm_gain_db": -24, "cue_budget": 4},
    ),
    "result_close": _preset(
        "result_close",
        "mix",
        "结果收束",
        subtitle={"preset": "energetic_talking", "font_size": 46, "margin_bottom": 150, "max_chars": 12},
        effects={"title_card": True, "result_card": True, "gentle_push": True, "sticker_budget": 1},
        audio={"profile": "mix_rhythm", "bgm": True, "bgm_gain_db": -24, "cue_budget": 3},
    ),
}

PRESET_ORDER = {
    "course": ("knowledge_focus", "slide_teacher", "classroom_value"),
    "mix": ("hook_impact", "process_rhythm", "result_close"),
}


def list_presets(kind: str | None = None) -> list[dict[str, Any]]:
    if kind is not None and kind not in PRESET_ORDER:
        raise ContentEngineError("invalid_packaging_kind", "The packaging kind is invalid.")
    identifiers = (
        PRESET_ORDER[kind]
        if kind
        else (*PRESET_ORDER["course"], *PRESET_ORDER["mix"])
    )
    return [deepcopy(PACKAGING_PRESETS[preset_id]) for preset_id in identifiers]


def preset_display_name(kind: str, preset_id: str | None) -> str | None:
    preset = PACKAGING_PRESETS.get(str(preset_id or ""))
    if preset is None or preset["kind"] != kind:
        return None
    return str(preset["display_name"])


def resolve_preset(kind: str, mode: str, preset_id: str | None, index: int) -> dict[str, Any] | None:
    mode = str(mode or "auto").strip()
    if mode not in {"auto", "preset", "none"}:
        raise ContentEngineError("invalid_packaging_mode", "The packaging mode is invalid.")
    if mode == "none":
        return None
    if kind not in PRESET_ORDER:
        raise ContentEngineError("invalid_packaging_kind", "The packaging kind is invalid.")
    if mode == "preset":
        selected_id = str(preset_id or "").strip()
        if not selected_id:
            raise ContentEngineError("packaging_preset_required", "Select a packaging preset.")
    else:
        selected_id = PRESET_ORDER[kind][max(0, int(index)) % len(PRESET_ORDER[kind])]
    preset = PACKAGING_PRESETS.get(selected_id)
    if preset is None or preset["kind"] != kind:
        raise ContentEngineError("invalid_packaging_preset", "The packaging preset is incompatible.")
    return deepcopy(preset)


def build_events(recipe: dict[str, Any], preset: dict[str, Any]) -> list[dict[str, Any]]:
    voice = recipe.get("voice_segment") or {}
    base = int(voice.get("start_ms") or 0)
    duration = max(1, int(voice.get("end_ms") or base + 1) - base)
    events: list[dict[str, Any]] = [
        {"type": "title", "start_ms": 0, "end_ms": min(duration, 2_400)},
        {"type": "hook", "start_ms": 0, "end_ms": min(duration, 3_000)},
    ]
    for caption in (recipe.get("captions") or [])[:3]:
        start = max(0, int(caption.get("start_ms") or base) - base)
        end = min(duration, max(start + 1, int(caption.get("end_ms") or base) - base))
        if start < duration:
            events.append({"type": "keyword", "start_ms": start, "end_ms": end})
    if preset["kind"] == "course":
        for segment in recipe.get("visual_segments") or []:
            if segment.get("frame_mode") == "slide_with_teacher_pip":
                events.append(
                    {
                        "type": "slide_focus",
                        "start_ms": max(0, int(segment.get("start_ms") or base) - base),
                        "end_ms": min(duration, int(segment.get("end_ms") or base) - base),
                    }
                )
    else:
        elapsed = 0
        for segment in recipe.get("visual_segments") or []:
            length = max(1, int(segment.get("target_duration_ms") or 1))
            events.append(
                {
                    "type": str(segment.get("role") or "process"),
                    "start_ms": elapsed,
                    "end_ms": min(duration, elapsed + length),
                }
            )
            elapsed += length
    events.append({"type": "close", "start_ms": max(0, duration - 1_200), "end_ms": duration})
    return [event for event in events if event["end_ms"] > event["start_ms"]]


def build_packaging(
    recipe: dict[str, Any],
    *,
    kind: str,
    title: str,
    mode: str,
    preset_id: str | None,
    index: int,
    brand: dict[str, Any] | None,
    cover_mode: str,
) -> dict[str, Any] | None:
    preset = resolve_preset(kind, mode, preset_id, index)
    if preset is None:
        return None
    if cover_mode not in {"auto", "local_frame", "ai_generate", "none", "reuse"}:
        raise ContentEngineError("invalid_cover_mode", "The cover mode is invalid.")
    # Keep the historical engine-level default stable for persisted recipes and
    # non-desktop callers. The desktop product now sends ai_generate explicitly.
    effective_cover_mode = "local_frame" if cover_mode == "auto" else cover_mode
    packaging = {
        "version": PACKAGING_SCHEMA_VERSION,
        "preset_id": preset["preset_id"],
        "preset_version": preset["version"],
        "title": str(title or "")[:60],
        "subtitle": deepcopy(preset["subtitle"]),
        "effects": deepcopy(preset["effects"]),
        "audio": deepcopy(preset["audio"]),
        "events": build_events(recipe, preset),
        "brand_profile_id": brand.get("brand_profile_id") if brand else None,
        "brand": deepcopy(brand) if brand else None,
        "cover": {
            **deepcopy(preset["cover"]),
            "mode": effective_cover_mode,
            "status": (
                "planned"
                if effective_cover_mode == "ai_generate"
                else "none"
                if effective_cover_mode == "none"
                else "local"
            ),
            "revision": 0,
        },
    }
    motion_plan = recipe.get("motion_director")
    return apply_motion_plan(packaging, motion_plan) if motion_plan else packaging


def apply_motion_plan(
    packaging: dict[str, Any], motion_plan: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(motion_plan, dict):
        raise ContentEngineError("cloud_motion_plan_invalid", "The motion plan is invalid.")
    provider = str(motion_plan.get("provider") or "").strip()[:24]
    model = str(motion_plan.get("model") or "").strip()[:64] or None
    try:
        version = max(1, int(motion_plan.get("version") or 1))
    except (TypeError, ValueError) as error:
        raise ContentEngineError("cloud_motion_plan_invalid", "The motion plan version is invalid.") from error
    events = []
    for item in (motion_plan.get("events") or [])[:12]:
        if not isinstance(item, dict):
            continue
        event_type = str(item.get("type") or "").strip()
        text = str(item.get("text") or "").strip()[:48]
        zone = str(item.get("zone") or "").strip()
        size = str(item.get("size") or "").strip()
        try:
            start_ms = max(0, int(item.get("start_ms")))
            end_ms = max(0, int(item.get("end_ms")))
            priority = max(1, min(3, int(item.get("priority"))))
        except (TypeError, ValueError):
            continue
        if (
            event_type not in MOTION_EVENT_TYPES
            or not text
            or zone not in MOTION_LAYOUT_ZONES
            or size not in MOTION_EVENT_SIZES
            or end_ms <= start_ms
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
    events = _resolve_motion_event_collisions(events)
    if not provider or not events:
        raise ContentEngineError(
            "cloud_motion_plan_invalid", "The motion plan has no safe semantic events."
        )
    structural = [
        deepcopy(event)
        for event in packaging.get("events") or []
        if str(event.get("type") or "") in {"slide_focus", "close"}
    ]
    packaging["director"] = {
        "version": version,
        "provider": provider,
        "model": model,
    }
    packaging["events"] = [*events, *structural]
    return packaging


def _resolve_motion_event_collisions(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    ordered = sorted(
        events,
        key=lambda event: (
            -event["priority"],
            event["start_ms"],
            -(event["end_ms"] - event["start_ms"]),
        ),
    )
    for event in ordered:
        overlapping = [
            current
            for current in accepted
            if event["start_ms"] < current["end_ms"]
            and current["start_ms"] < event["end_ms"]
        ]
        text_key = "".join(
            character
            for character in event["text"].casefold()
            if character.isalnum()
        )
        if any(
            text_key
            == "".join(
                character
                for character in current["text"].casefold()
                if character.isalnum()
            )
            for current in overlapping
        ):
            continue
        if len(overlapping) >= 2:
            continue
        used_zones = {current["zone"] for current in overlapping}
        if event["zone"] in used_zones:
            available_zone = next(
                (zone for zone in MOTION_ZONE_ORDER if zone not in used_zones), None
            )
            if available_zone is None:
                continue
            event = {**event, "zone": available_zone}
        accepted.append(event)
    return sorted(accepted, key=lambda event: (event["start_ms"], -event["priority"]))


def with_virality_dimensions(score: dict[str, Any], kind: str) -> dict[str, Any]:
    result = deepcopy(score)
    if all(
        isinstance(result.get(name), (int, float))
        and not isinstance(result.get(name), bool)
        and math.isfinite(float(result[name]))
        for name in ("hook", "engagement", "value", "shareability")
    ):
        result["virality_total"] = round(
            sum(max(0.0, min(25.0, float(result[name]))) for name in ("hook", "engagement", "value", "shareability")),
            3,
        )
        return result
    opening = max(0.0, min(1.0, float(result.get("opening_hook") or 0.55)))
    completeness = max(0.0, min(1.0, float(result.get("content_completeness") or 0.75)))
    transcript = max(0.0, min(1.0, float(result.get("transcript_quality") or 0.75)))
    standalone = max(0.0, min(1.0, float(result.get("standalone_value") or completeness)))
    diversity = max(0.0, min(1.0, float(result.get("diversity") or 0.7)))
    visual = max(0.0, min(1.0, float(result.get("visual_quality") or 0.7)))
    hook = 25 * opening
    engagement = 25 * (0.35 * opening + 0.35 * transcript + 0.3 * visual)
    value = 25 * standalone
    shareability = 25 * (0.45 * standalone + 0.25 * completeness + 0.15 * diversity + 0.15 * visual)
    result.update(
        {
            "hook": round(hook, 3),
            "engagement": round(engagement, 3),
            "value": round(value, 3),
            "shareability": round(shareability, 3),
            "virality_total": round(hook + engagement + value + shareability, 3),
            "virality_engine": "derived_from_editor_signals" if kind == "course" else "derived_from_mix_signals",
        }
    )
    return result
