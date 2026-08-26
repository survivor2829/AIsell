"""Deterministic planning helpers for the 商品展示一键成片 workflow.

The model may suggest copy and semantic intent, but this module owns the
bounded shot plan.  In particular it never asks a source clip to fill an
unbounded duration: every video interval is finite and every still receives a
short motion window.  This keeps product montages useful even when the upload
is only a handful of unrelated images/videos.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from typing import Any


PRODUCT_TAGS = (
    "product_closeup",
    "product_detail",
    "use_scene",
    "function_demo",
    "before_after",
    "factory_environment",
    "result",
    "outro",
)

PRODUCT_CONTEXT_LIMITS = {
    "industry": 80,
    "brand_name": 80,
    "product_name": 100,
    "selling_points": 240,
    "must_include": 160,
    "avoid": 160,
    "target_customer": 120,
}

_PRODUCT_FAMILY_RULES = {
    "cleaning_robot": {
        "positive": ("扫地机器人", "清洁机器人", "清扫机器人", "洗地机器人", "无人清洁"),
        "conflicts": ("洗碗机", "餐具", "碗碟", "厨房洗涤"),
    },
    "dishwasher": {
        "positive": ("洗碗机", "餐具清洗", "厨房洗涤"),
        "conflicts": ("扫地机器人", "清洁机器人", "洗地机器人"),
    },
}


# A product candidate has one spoken bottom-caption lane.  Only text that is
# actually audible is admitted here.  Product descriptions, hooks and CTAs
# belong to ``visual_labels`` so the visual layer can place them as cards.
_CAPTION_SOURCE_PRIORITY = {
    "source_transcript": 2,
    "tts_voiceover": 1,
}


_PRODUCT_MIN_OUTPUT_MS = 30_000
_PRODUCT_MAX_VIDEO_SHOT_MS = 6_500
_PRODUCT_IMAGE_SHOT_MS = 4_500
_PRODUCT_MIN_VIDEO_WINDOW_MS = 2_000
_PRODUCT_MAX_ASSET_SHARE = 0.35


def _safe_text(value: Any, limit: int = 120) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _single_caption_lane(
    captions: list[dict[str, Any]], *, duration_ms: int
) -> list[dict[str, Any]]:
    """Return a bounded, non-overlapping lane of audible speech captions."""
    candidates = []
    for item in captions:
        if not isinstance(item, dict):
            continue
        text = _safe_text(item.get("text"), 80)
        if not text:
            continue
        source = str(item.get("caption_source") or "")
        if source not in _CAPTION_SOURCE_PRIORITY:
            continue
        start_ms = max(0, min(int(duration_ms), int(item.get("start_ms") or 0)))
        end_ms = max(start_ms, min(int(duration_ms), int(item.get("end_ms") or start_ms)))
        if end_ms <= start_ms:
            continue
        candidate = {
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": text,
            "caption_source": source,
            "_priority": _CAPTION_SOURCE_PRIORITY[source],
        }
        if source == "tts_voiceover":
            candidate["timing"] = "estimated"
        candidates.append(candidate)
    accepted = []
    for item in sorted(
        candidates,
        key=lambda value: (
            -int(value["_priority"]),
            int(value["start_ms"]),
            int(value["end_ms"]),
            str(value["text"]),
        ),
    ):
        if any(
            item["start_ms"] < current["end_ms"]
            and current["start_ms"] < item["end_ms"]
            for current in accepted
        ):
            continue
        accepted.append(item)
    return [
        {key: value for key, value in item.items() if key != "_priority"}
        for item in sorted(
            accepted,
            key=lambda value: (int(value["start_ms"]), int(value["end_ms"])),
        )
    ]


def _voiceover_caption_chunks(value: Any, limit: int = 22) -> list[str]:
    """Split synthesized copy into readable caption-sized phrases."""
    text = _safe_text(value, 2_400)
    if not text:
        return []
    sentences = [
        item.strip()
        for item in re.split(r"(?<=[。！？!?；;])\s*|\n+", text)
        if item.strip()
    ]
    chunks: list[str] = []
    for sentence in sentences:
        remaining = sentence
        while len(remaining) > limit:
            boundary = max(
                remaining.rfind(mark, 0, limit + 1)
                for mark in ("，", ",", "、", "：", ":")
            )
            cut = boundary + 1 if boundary >= max(6, limit // 2) else limit
            chunks.append(remaining[:cut].strip())
            remaining = remaining[cut:].strip()
        if remaining:
            chunks.append(remaining)
    return chunks


def _estimated_voiceover_captions(
    value: Any, *, duration_ms: int
) -> list[dict[str, Any]]:
    """Build deterministic estimated cues when TTS exposes no word timings."""
    chunks = _voiceover_caption_chunks(value)
    if not chunks or duration_ms <= 0:
        return []
    weights = [
        max(1, len(re.sub(r"[\s，,。！？!?；;、：:]", "", text)))
        for text in chunks
    ]
    total_weight = sum(weights)
    estimated_spoken_ms = min(
        int(duration_ms),
        max(len(chunks) * 900, total_weight * 230),
    )
    captions = []
    consumed = 0
    for index, (text, weight) in enumerate(zip(chunks, weights)):
        start_ms = round(estimated_spoken_ms * consumed / total_weight)
        consumed += weight
        end_ms = (
            estimated_spoken_ms
            if index == len(chunks) - 1
            else round(estimated_spoken_ms * consumed / total_weight)
        )
        if end_ms > start_ms:
            captions.append({
                "start_ms": start_ms,
                "end_ms": end_ms,
                "text": text,
                "caption_source": "tts_voiceover",
                "timing": "estimated",
            })
    return captions


def normalize_product_context(value: dict[str, Any] | None) -> dict[str, str]:
    source = dict(value) if isinstance(value, dict) else {}
    if not source.get("product_name") and source.get("product"):
        source["product_name"] = source["product"]
    return {
        field: text
        for field, limit in PRODUCT_CONTEXT_LIMITS.items()
        if (text := _safe_text(source.get(field), limit))
    }


def infer_product_family(brief: dict[str, Any] | None) -> str:
    text = " ".join(
        _safe_text((brief or {}).get(field), 160).casefold()
        for field in ("product_name", "product", "industry", "selling_points")
    )
    for family, rules in _PRODUCT_FAMILY_RULES.items():
        if any(token.casefold() in text for token in rules["positive"]):
            return family
    return "generic"


def product_script_mismatch_reason(
    script: dict[str, Any] | None, brief: dict[str, Any] | None
) -> str | None:
    """Return a stable error code when generated copy contradicts the brief."""
    family = infer_product_family(brief)
    if family == "generic" or not isinstance(script, dict):
        return None
    text = json.dumps(script, ensure_ascii=False, separators=(",", ":")).casefold()
    rules = _PRODUCT_FAMILY_RULES[family]
    return "product_category_mismatch" if any(
        token.casefold() in text for token in rules["conflicts"]
    ) else None


def classify_assets(
    assets: list[dict[str, Any]], product_context: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Assign useful product roles without forcing manual upper/middle/lower slots."""
    output: list[dict[str, Any]] = []
    for index, asset in enumerate(assets):
        name = _safe_text(asset.get("display_name"), 160).casefold()
        kind = str(asset.get("media_kind") or "video")
        existing = [
            _safe_text(tag, 40)
            for tag in (asset.get("tags") or [])
            if _safe_text(tag, 40)
        ]
        if existing:
            tags = [tag for tag in existing if tag in PRODUCT_TAGS] or existing[:3]
        elif any(marker in name for marker in ("工厂", "车间", "环境", "场景")):
            tags = ["factory_environment"]
        elif any(marker in name for marker in ("细节", "特写", "close", "detail")):
            tags = ["product_detail"]
        elif any(marker in name for marker in ("效果", "结果", "对比", "before", "after")):
            tags = ["result", "before_after"]
        elif kind == "image":
            tags = ["product_closeup"]
        else:
            tags = ["function_demo" if index % 2 else "use_scene"]
        output.append(
            {
                "asset_id": str(asset.get("asset_id") or ""),
                "display_name": _safe_text(asset.get("display_name"), 160),
                "media_kind": kind if kind in {"image", "video"} else "video",
                "duration_ms": max(0, int(asset.get("duration_ms") or 0)),
                "has_audio": bool(asset.get("has_audio")),
                "tags": list(dict.fromkeys(tags))[:3],
                "classification_source": "provided" if existing else "local_rules",
                "product_family": infer_product_family(product_context),
                "audio_mode": str(asset.get("audio_mode") or "")[:40] or None,
                "speech_status": str(asset.get("speech_status") or "")[:40] or None,
                "visual_evidence": [
                    _safe_text(item, 240)
                    for item in (asset.get("visual_evidence") or [])[:8]
                    if _safe_text(item, 240)
                ],
                "transcript_evidence": [
                    _safe_text(item, 240)
                    for item in (asset.get("transcript_evidence") or [])[:8]
                    if _safe_text(item, 240)
                ],
                "transcript_segments": [
                    {
                        "start_ms": max(0, int(item.get("start_ms") or 0)),
                        "end_ms": max(0, int(item.get("end_ms") or 0)),
                        "text": _safe_text(item.get("text"), 240),
                    }
                    for item in (asset.get("transcript_segments") or [])[:24]
                    if isinstance(item, dict)
                    and int(item.get("end_ms") or 0) > int(item.get("start_ms") or 0)
                    and _safe_text(item.get("text"), 240)
                ],
            }
        )
    return [item for item in output if item["asset_id"]]


def build_local_copy(brief: dict[str, Any], assets: list[dict[str, Any]], count: int = 3) -> dict[str, Any]:
    """Safe local copy fallback used only when the cloud editor is unavailable."""
    product = _safe_text(brief.get("product_name") or brief.get("product") or "产品", 80)
    brand = _safe_text(brief.get("brand_name") or brief.get("store_name") or "", 80)
    selling = _safe_text(brief.get("selling_points") or brief.get("key_points") or "", 180)
    industry = _safe_text(brief.get("industry") or "产品展示", 60)
    target = _safe_text(brief.get("target_customer") or "正在寻找更高效方案的人", 80)
    must = _safe_text(brief.get("must_include") or "", 100)
    cta = must or f"想了解{product}，欢迎联系我们"
    opening = f"{product}，把{industry}里最关键的一步做得更简单。"
    body = f"{selling}。从外观细节，到实际使用场景，{product}让{target}更容易看见真实效果。"
    if brand:
        body = f"{brand}带来的{product}，{body}"
    voiceover = f"{opening}{body}{cta}。"
    titles = [
        f"{product}，真实使用效果一次看懂",
        f"为什么越来越多人关注{product}",
        f"{product}从细节到结果的完整展示",
    ][: max(1, min(3, count))]
    shots = []
    for index, asset in enumerate(assets):
        tags = asset.get("tags") or ["product_closeup"]
        shots.append(
            {
                "shot_id": f"shot_{index + 1}",
                "asset_id": asset["asset_id"],
                "asset_tags": tags,
                "caption": _safe_text(tags[0].replace("_", " "), 48),
                "action": "slow_push" if asset["media_kind"] == "image" else "cut_to_detail",
            }
        )
    return {
        "schema_version": 1,
        "provider": "local_fallback",
        "title_candidates": titles,
        "hook": opening,
        "voiceover": voiceover,
        "shots": shots,
        "cta": cta,
        "bgm_mood": "clean_tech_product",
        "target_customer": target,
        "voice_mode": "tts",
    }


def build_visual_only_copy(
    assets: list[dict[str, Any]], product_context: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Build a visual-only plan without inventing a product story or voice track."""
    shots = []
    for index, asset in enumerate(assets):
        shots.append(
            {
                "shot_id": f"shot_{index + 1}",
                "asset_id": asset["asset_id"],
                "asset_tags": asset.get("tags") or [],
                "caption": "",
                "action": "slow_push" if asset["media_kind"] == "image" else "cut_to_detail",
            }
        )
    return {
        "schema_version": 1,
        "provider": "local_visual_only",
        "voice_mode": "none",
        "title_candidates": [],
        "hook": "",
        "voiceover": "",
        "shots": shots,
        "cta": "",
        "bgm_mood": "source_or_selected_bgm",
        "product_family": infer_product_family(product_context),
    }


def build_product_recipes(
    assets: list[dict[str, Any]],
    script: dict[str, Any],
    *,
    output_count: int = 3,
    duration_ms: int = 75_000,
    product_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build non-repeating, capacity-bounded product montage recipes.

    The requested duration is a ceiling, not a mandate to replay footage.  A
    candidate is shortened to the largest duration that can be assembled from
    non-overlapping source windows while keeping every source asset at or below
    35 percent of the result.  Less than 30 seconds of balanced source capacity
    is reported by returning no recipe.
    """
    safe_assets = [item for item in assets if item.get("asset_id")]
    if not safe_assets:
        return []
    by_id = {str(item["asset_id"]): item for item in safe_assets}
    planned_shots = [
        {**item, "_planned_shot_index": index}
        for index, item in enumerate(script.get("shots") or [])
        if isinstance(item, dict) and str(item.get("asset_id") or "") in by_id
    ]
    planned_by_asset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    ordered_asset_ids = []
    for item in planned_shots:
        asset_id = str(item["asset_id"])
        planned_by_asset[asset_id].append(item)
        if asset_id not in ordered_asset_ids:
            ordered_asset_ids.append(asset_id)
    ordered_asset_ids.extend(
        asset_id for asset_id in by_id if asset_id not in ordered_asset_ids
    )
    target = max(60_000, min(90_000, int(duration_ms)))

    capacities: dict[str, int] = {}
    for asset_id in ordered_asset_ids:
        asset = by_id[asset_id]
        if asset.get("media_kind") == "image":
            capacities[asset_id] = _PRODUCT_IMAGE_SHOT_MS
            continue
        source_duration = max(0, int(asset.get("duration_ms") or 0))
        capacities[asset_id] = (
            min(source_duration, target)
            if source_duration >= _PRODUCT_MIN_VIDEO_WINDOW_MS
            else 0
        )
    capacities = {key: value for key, value in capacities.items() if value > 0}
    if len(capacities) < 3:
        return []

    # Find the largest feasible duration.  At duration T, each asset may
    # contribute at most floor(0.35*T); if those bounded contributions cannot
    # sum to T, reduce T to the available bounded capacity and try again.
    available_duration = min(target, sum(capacities.values()))
    for _attempt in range(64):
        per_asset_limit = int(available_duration * _PRODUCT_MAX_ASSET_SHARE)
        bounded_capacity = sum(
            min(capacity, per_asset_limit) for capacity in capacities.values()
        )
        if bounded_capacity >= available_duration:
            break
        available_duration = bounded_capacity
    if available_duration < _PRODUCT_MIN_OUTPUT_MS:
        return []

    per_asset_limit = int(available_duration * _PRODUCT_MAX_ASSET_SHARE)
    quotas = {
        asset_id: min(capacity, per_asset_limit)
        for asset_id, capacity in capacities.items()
    }

    def source_windows(asset_id: str, candidate_index: int) -> list[tuple[int, int]]:
        asset = by_id[asset_id]
        quota = quotas[asset_id]
        if asset.get("media_kind") == "image":
            return [(0, quota)]
        source_duration = int(asset.get("duration_ms") or 0)
        span_start = (
            0
            if candidate_index % 3 == 0
            else source_duration - quota
            if candidate_index % 3 == 1
            else (source_duration - quota) // 2
        )
        count = max(1, math.ceil(quota / _PRODUCT_MAX_VIDEO_SHOT_MS))
        base, extra = divmod(quota, count)
        cursor = span_start
        windows = []
        for index in range(count):
            length = base + (1 if index < extra else 0)
            windows.append((cursor, cursor + length))
            cursor += length
        if candidate_index % 3 == 1:
            windows.reverse()
        elif candidate_index % 3 == 2 and len(windows) > 1:
            pivot = len(windows) // 2
            windows = windows[pivot:] + windows[:pivot]
        return windows

    recipes = []
    for candidate_index in range(max(1, min(3, int(output_count)))):
        asset_order = [
            asset_id
            for asset_id in (
                ordered_asset_ids[candidate_index % len(ordered_asset_ids):]
                + ordered_asset_ids[:candidate_index % len(ordered_asset_ids)]
            )
            if asset_id in quotas
        ]
        queues: dict[str, list[dict[str, Any]]] = {}
        omitted_planned_shot_ids = []
        for asset_id in asset_order:
            plans = planned_by_asset.get(asset_id) or []
            windows = source_windows(asset_id, candidate_index)
            queue = []
            for window_index, (start, end) in enumerate(windows):
                planned = plans[window_index] if window_index < len(plans) else {}
                queue.append(
                    {
                        "asset": by_id[asset_id],
                        "planned": planned,
                        "start_ms": start,
                        "end_ms": end,
                    }
                )
            for planned in plans[len(windows):]:
                omitted_planned_shot_ids.append(
                    str(
                        planned.get("shot_id")
                        or f"script_shot_{int(planned['_planned_shot_index']) + 1}"
                    )
                )
            queues[asset_id] = queue

        shots: list[dict[str, Any]] = []
        elapsed = 0
        while elapsed < available_duration and any(queues.values()):
            progressed = False
            for asset_id in asset_order:
                if elapsed >= available_duration:
                    break
                if not queues[asset_id]:
                    continue
                unit = queues[asset_id].pop(0)
                asset = unit["asset"]
                planned = unit["planned"]
                start = int(unit["start_ms"])
                source_length = int(unit["end_ms"]) - start
                segment_ms = min(source_length, available_duration - elapsed)
                if segment_ms <= 0:
                    continue
                end = start + segment_ms
                planned_index = planned.get("_planned_shot_index")
                planned_id = (
                    str(planned.get("shot_id") or f"script_shot_{int(planned_index) + 1}")
                    if planned_index is not None
                    else None
                )
                shots.append(
                    {
                        "role": "process",
                        "asset_id": asset["asset_id"],
                        "start_ms": start,
                        "end_ms": end,
                        "target_duration_ms": segment_ms,
                        "media_kind": asset["media_kind"],
                        "source_tag": _safe_text(
                            (
                                planned.get("asset_tags")
                                or asset.get("tags")
                                or ["product_detail"]
                            )[0],
                            40,
                        ),
                        "shot_index": len(shots),
                        "planned_shot_id": planned_id,
                        "planned_shot_index": planned_index,
                        "planned_caption": _safe_text(planned.get("caption"), 80),
                        "planned_action": _safe_text(planned.get("action"), 80),
                    }
                )
                elapsed += segment_ms
                progressed = True
            if not progressed:
                break
        if elapsed < _PRODUCT_MIN_OUTPUT_MS:
            continue
        shots[0]["role"] = "hook"
        shots[-1]["role"] = "result"
        usage = {
            asset_id: sum(
                int(shot["target_duration_ms"])
                for shot in shots
                if str(shot["asset_id"]) == asset_id
            )
            for asset_id in asset_order
        }
        if any(value / elapsed > _PRODUCT_MAX_ASSET_SHARE for value in usage.values()):
            continue
        recipe = {
            "kind": "mix",
            "layout": "product_showcase",
            # Visual-only projects keep the source audio/BGM. Voice projects
            # replace it with the explicit TTS track once it is available.
            "audio_mode": (
                "visual_montage"
                if script.get("voice_mode") in {"none", "source_voice", "source_audio"}
                else "voiceover"
            ),
            "product_workflow": "one_click_v1",
            "product_context": normalize_product_context(product_context),
            "voice_segment": {
                "asset_id": shots[0]["asset_id"],
                "start_ms": 0,
                "end_ms": elapsed,
            },
            "visual_segments": shots,
            "captions": [],
            "visual_labels": [],
            "product_script": script,
            "capacity_report": {
                "requested_duration_ms": target,
                "actual_duration_ms": elapsed,
                "shortened": elapsed < target,
                "reason": "unique_source_capacity" if elapsed < target else None,
                "max_asset_share": _PRODUCT_MAX_ASSET_SHARE,
                "asset_usage_ms": usage,
                "omitted_planned_shot_ids": omitted_planned_shot_ids,
            },
            "skeleton_id": "product_skeleton_" + hashlib.sha256(
                json.dumps(shots, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()[:32],
        }
        caption_candidates = []
        visual_labels = []
        cursor = 0
        for shot in shots:
            text = _safe_text(shot.get("planned_caption") or "", 80)
            transcript_captions = []
            if script.get("voice_mode") == "source_voice":
                source_asset = by_id.get(str(shot["asset_id"]), {})
                shot_start = int(shot.get("start_ms") or 0)
                shot_end = int(shot.get("end_ms") or 0)
                for transcript in source_asset.get("transcript_segments") or []:
                    overlap_start = max(shot_start, int(transcript.get("start_ms") or 0))
                    overlap_end = min(shot_end, int(transcript.get("end_ms") or 0))
                    if overlap_end <= overlap_start:
                        continue
                    transcript_text = _safe_text(transcript.get("text"), 80)
                    if transcript_text:
                        transcript_captions.append(
                            {
                                "start_ms": cursor + overlap_start - shot_start,
                                "end_ms": cursor + overlap_end - shot_start,
                                "text": transcript_text,
                                "caption_source": "source_transcript",
                            }
                        )
            # When a source narrator is actually speaking in this visual
            # window, their words own the single bottom-caption lane.  A
            # generic visual label would otherwise be burned at the same
            # time, which is what caused the observed double subtitles.
            if transcript_captions:
                caption_candidates.extend(transcript_captions)
            if text:
                visual_labels.append({
                    "start_ms": cursor,
                    "end_ms": min(
                        elapsed, cursor + int(shot["target_duration_ms"])
                    ),
                    "text": text,
                    "label_source": "planned_caption",
                    "role": str(shot.get("role") or "process"),
                    "planned_shot_id": shot.get("planned_shot_id"),
                })
            cursor += int(shot["target_duration_ms"])
        hook = _safe_text(script.get("hook"), 80)
        cta = _safe_text(script.get("cta"), 80)
        if hook:
            visual_labels.append({
                "start_ms": 0,
                "end_ms": min(elapsed, 4_500),
                "text": hook,
                "label_source": "hook",
                "role": "hook",
            })
        if cta:
            visual_labels.append({
                "start_ms": max(0, elapsed - 5_000),
                "end_ms": elapsed,
                "text": cta,
                "label_source": "cta",
                "role": "result",
            })
        if script.get("voice_mode") == "tts":
            caption_candidates.extend(
                _estimated_voiceover_captions(
                    script.get("voiceover"), duration_ms=elapsed
                )
            )
        recipe["captions"] = _single_caption_lane(
            caption_candidates, duration_ms=elapsed
        )
        recipe["visual_labels"] = visual_labels
        # ``has_audio`` only proves that an audio stream exists.  It does not
        # prove that the stream is music: it may be sparse speech, machinery
        # noise or an ASR failure.  Never promote it to a reusable music bed.
        # Explicit user-selected BGM is attached later by the domain layer;
        # a future classifier may set source_bgm_asset_id only when it has a
        # dedicated, trustworthy music classification.
        recipes.append(recipe)
    return recipes
