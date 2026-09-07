from __future__ import annotations

import hashlib
import heapq
import itertools
import json
import math
from pathlib import Path
import re
import shutil
from typing import Any
import wave

from .apimart_cover import (
    APIMartError,
    APIMartOutcomeUnknown,
    APIMartPollingStopped,
    APIMartTaskFailed,
)
from .auto_mix_v2 import (
    AUTO_MIX_CAPTION_CHARS,
    AUTO_MIX_SPEC_VERSION,
    align_material_timeline_to_captions,
    build_grounded_text_tracks,
    build_material_evidence_facts,
    build_material_timeline,
    build_music_brief,
    build_speech_captions,
    canonical_hash as auto_mix_canonical_hash,
    guided_script_audience_copy_issue,
    invalidated_stages_for_layer,
    matching_spoken_critical_terms,
    normalize_text_tracks,
    public_auto_mix_plan,
    public_music_track,
    select_licensed_music,
    validate_create_auto_mix_v2,
    validate_formal_recipe,
    validate_music_catalog_track_v1,
    validate_quality_report,
    verify_spoken_phrase,
)
from .auto_mix_resources import (
    AUTO_MIX_TTS_MODEL,
    BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES,
    MAX_VOICE_PREVIEW_BYTES,
    VOICE_PERSONA_ID,
    VOICE_PREFIX,
    VOICE_PREVIEW_SAMPLE,
    auto_select_voice_persona_ids,
    configured_voice_personas,
    normalize_voice_preview,
    voice_preview_cache_key,
    voice_preview_data_url,
    voice_preview_ffmpeg,
    voice_preview_sample,
)
from .narration_alignment import align_narration, attach_narration_alignment, sentence_shot_budgets, aligned_binding_spans
from .database import Database
from .errors import ContentEngineError
from .hashing import canonical_json_sha256
from .packaging import (
    COVER_PROMPT_VERSION,
    MOTION_EVENT_SIZES,
    MOTION_EVENT_TYPES,
    MOTION_LAYOUT_ZONES,
    apply_motion_plan,
    build_packaging,
    list_presets,
    preset_display_name,
    resolve_preset,
    with_virality_dimensions,
)
from .public_data import redact_text, sanitize_public_value
from .product_pipeline import (
    build_local_copy,
    build_product_recipes,
    build_visual_only_copy,
    classify_assets,
    infer_product_family,
    normalize_product_context,
    product_script_mismatch_reason,
)


CREATIVE_TASK_TYPES = frozenset(
    {
        "creative_analysis",
        "course_generation",
        "mix_generation",
        "creative_regeneration",
        "creative_packaging",
        "creative_cover",
        "creative_visual_comparison",
        "product_asset_analysis",
        "product_copy",
        "product_voice",
        "product_generation",
        "auto_mix_v2_generation",
        "auto_mix_v2_regeneration",
        "guided_auto_mix_analysis",
        "guided_auto_mix_draft",
        "guided_auto_mix_supplemental_image",
        "narrated_batch_v1",
    }
)
AUTO_MIX_REUSE_SELECTED_VOICE_RECOVERY_CODES = frozenset(
    {
        "auto_mix_voice_timing_invalid",
        "auto_mix_voice_verification_failed",
    }
)
AUTO_MIX_LEGACY_ALIGNMENT_CODE = "auto_mix_material_too_short"
AUTO_MIX_LEGACY_ALIGNMENT_MESSAGE = "引用素材不足以覆盖对应口播的真实时间窗口。"
CREATIVE_CHANNELS = frozenset({"wechat", "douyin", "kuaishou", "internal"})
ROLE_ORDER = ("hook", "process", "result")
SKIPPABLE_ANALYSIS_ERRORS = frozenset(
    {
        # These failures belong to one source's media/response and must not
        # prevent other selected sources from being analyzed.
        "cloud_response_invalid",
        "cloud_transcription_failed",
        "cloud_transcription_timeout",
        "analysis_failed",
        "analysis_timeout",
    }
)
# Product one-click is deliberately more forgiving only after the provider
# request has exhausted its bounded timeout. Course/mix workflows keep the
# stricter contract so a missing voice backbone cannot silently become a
# different kind of edit.
PRODUCT_SKIPPABLE_ANALYSIS_ERRORS = SKIPPABLE_ANALYSIS_ERRORS | {
    "cloud_request_failed"
}
MAX_MIX_OUTPUTS = 300
MAX_COMBINATION_INSPECTION = 250_000
AUTO_MIX_MAX_TTS_PHRASES = 40
GUIDED_AUTO_MIX_MIN_DURATION_MS = 8_000
GUIDED_AUTO_MIX_MAX_TARGET_DURATION_MS = 60_000
GUIDED_AUTO_MIX_SOURCE_HEADROOM_RATIO = 0.92
GUIDED_AUTO_MIX_TARGET_MIN_RATIO = 0.85
GUIDED_AUTO_MIX_ESTIMATED_CHAR_MS = 260
GUIDED_AUTO_MIX_ESTIMATED_PAUSE_MS = 160
MAX_MUSIC_AUDIO_BYTES = 512 * 1024 * 1024
MAX_MUSIC_EVIDENCE_BYTES = 32 * 1024 * 1024
COVER_OPERATION_TRANSITIONS = {
    "planned": {"submitted", "failed", "outcome_unknown", "cancelled"},
    "submitted": {"completed", "failed", "outcome_unknown", "cancelled"},
    "completed": set(),
    "failed": set(),
    "outcome_unknown": set(),
    "cancelled": set(),
}
GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_TRANSITIONS = {
    "planned": {"submitted", "failed", "outcome_unknown", "cancelled"},
    "submitted": {"completed", "failed", "outcome_unknown", "cancelled"},
    "completed": set(),
    "failed": set(),
    "outcome_unknown": set(),
    "cancelled": set(),
}
GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROVIDER = "apimart_gpt_image_2"
GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROMPT_VERSION = "scene_atmosphere_v1"
GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024
RECOVERABLE_COVER_ERROR_CODES = frozenset(
    {
        "cover_poll_failed",
        "cover_poll_interrupted",
        "cover_download_failed",
        "cover_composition_failed",
        # A guided supplemental image is admitted to the provider only once.
        # These failures retain a provider task ID (or are still inside its
        # durable admission window), so a resumed task can only poll/download;
        # it can never submit a second paid image request.
        "guided_auto_mix_supplemental_image_poll_failed",
        "guided_auto_mix_supplemental_image_poll_interrupted",
        "guided_auto_mix_supplemental_image_download_failed",
        "guided_auto_mix_supplemental_image_submission_inflight",
    }
)
PRODUCT_NON_BLOCKING_COVER_ERROR_CODES = frozenset(
    {
        "cover_outcome_unknown",
        "cover_submit_failed",
        "cover_provider_failed",
        "cover_poll_failed",
        "cover_download_failed",
        "cover_composition_failed",
    }
)
PRODUCT_COVER_PROMPT_VERSION = "product_reference_v2"
PRODUCT_COVER_SELECTOR_VERSION = "analyzed_keyframe_v1"
COURSE_HOOK_MARKERS = (
    "为什么", "怎么", "问题", "区别", "相比", "不是", "而是", "但是",
    "关键", "核心", "一定", "不能", "必须", "如果", "结果", "意味着",
)
COURSE_ACTION_MARKERS = (
    "需要", "应该", "可以", "先", "再", "选择", "判断", "根据", "适合", "避免",
)
COURSE_LEADING_FILLERS = re.compile(
    r"^(?:(?:嗯+|呃+|啊+|这个|那个|然后|那么|就是说|其实|接下来)\s*[，,、。]?\s*)+"
)
VISUAL_COMPARISON_STYLE_IDS = (
    "social_pop",
    "neo_editorial",
    "tech_motion",
)
VISUAL_STYLE_VERSION = 1
VISUAL_LAYOUT_POLICY_VERSION = "motion-zones-v1"
RECOVERABLE_COMPARISON_ERROR_CODES = frozenset(
    {
        "comparison_runtime_hash_unavailable",
        "comparison_runtime_hash_mismatch",
        "comparison_bundle_hash_unavailable",
        "comparison_bundle_hash_mismatch",
    }
)
_SAFE_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
SOURCE_NARRATION_MIN_COVERAGE = 0.70


def _source_speech_summary(assets):
    """Measure recognized speech without treating one sentence as a full narration.

    The copy phase does not have a candidate timeline yet, so this is a
    conservative source-level estimate over selected video durations.  The
    intervals are clamped and unioned per asset to avoid double-counting
    overlapping ASR sentences.
    """
    source_media_ms = 0
    recognized_speech_ms = 0
    recognized_asset_count = 0
    unknown_audio_count = 0
    for asset in assets or []:
        if not isinstance(asset, dict) or asset.get("media_kind") != "video":
            continue
        duration_ms = max(0, int(asset.get("duration_ms") or 0))
        source_media_ms += duration_ms
        if (
            str(asset.get("audio_mode") or "") == "source_audio_unclassified"
            and str(asset.get("speech_status") or "")
            in {"failed", "unknown", "not_requested"}
        ):
            unknown_audio_count += 1
        intervals = []
        for segment in asset.get("transcript_segments") or []:
            if not isinstance(segment, dict) or not str(segment.get("text") or "").strip():
                continue
            start_ms = max(0, min(duration_ms, int(segment.get("start_ms") or 0)))
            end_ms = max(start_ms, min(duration_ms, int(segment.get("end_ms") or 0)))
            if end_ms > start_ms:
                intervals.append((start_ms, end_ms))
        merged = []
        for start_ms, end_ms in sorted(intervals):
            if merged and start_ms <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end_ms))
            else:
                merged.append((start_ms, end_ms))
        asset_speech_ms = sum(end_ms - start_ms for start_ms, end_ms in merged)
        if asset_speech_ms:
            recognized_asset_count += 1
            recognized_speech_ms += asset_speech_ms
    source_coverage = (
        recognized_speech_ms / source_media_ms if source_media_ms > 0 else 0.0
    )
    return {
        "recognized_speech_ms": recognized_speech_ms,
        "source_media_ms": source_media_ms,
        "source_coverage": source_coverage,
        "source_coverage_threshold": SOURCE_NARRATION_MIN_COVERAGE,
        "recognized_asset_count": recognized_asset_count,
        "unknown_audio_count": unknown_audio_count,
    }


def _canonical_hash(value: Any) -> str:
    return canonical_json_sha256(value)


def _opaque_capability_value(value: Any) -> str | None:
    candidate = str(value or "").strip()
    return candidate if _SAFE_OPAQUE_ID.fullmatch(candidate) else None


def _stable_id(prefix: str, *parts: Any) -> str:
    digest = hashlib.sha256(
        "\x1f".join(str(part) for part in parts).encode("utf-8")
    ).hexdigest()
    return f"{prefix}_{digest[:32]}"


def _supported_image_mime_type(path: Path) -> str | None:
    """Recognize only the small image set the supplemental-image flow serves.

    The provider download client validates transport and response bounds.  This
    local signature check makes the managed file type explicit before a custom
    scheme can ever serve it, without trusting an extension or HTTP header.
    """
    try:
        with Path(path).open("rb") as stream:
            header = stream.read(16)
    except OSError:
        return None
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "image/webp"
    return None


class CreativeDomain:
    def __init__(
        self, database: Database, *, new_id, now, analyzer, renderer, cover_client=None
    ):
        self.database = database
        self.connection = database._require_connection()
        self.data_dir = database.data_dir.resolve()
        self._new_id = new_id
        self._now = now
        self.analyzer = analyzer
        self.renderer = renderer
        self.cover_client = cover_client
        self._visual_capability_snapshot = self._unavailable_visual_capability()
        self._sync_configured_voice_persona()

    def create_analysis_task(self, asset_ids, profile=None):
        safe_ids = self._validate_asset_ids(asset_ids)
        safe_profile = profile if isinstance(profile, dict) else {}
        return self._create_task(
            "creative_analysis",
            {"asset_ids": safe_ids, "profile": sanitize_public_value(safe_profile)},
        )

    def create_course_task(
        self,
        asset_id,
        *,
        min_duration_ms=30_000,
        max_duration_ms=90_000,
        count=5,
        theme="培训现场价值",
        subtitle_font_size=48,
        subtitle_margin_bottom=170,
        experiment_mode=None,
        subtitle_preset="dynamic_clean",
        packaging_mode="auto",
        packaging_preset_id=None,
        brand_profile_id=None,
        cover_mode="auto",
        visual_renderer=None,
        confirm_paid_calls=False,
    ):
        asset_id = self._validate_asset_ids([asset_id], require_audio=True)[0]
        minimum, maximum = self._duration_range(min_duration_ms, max_duration_ms)
        count = self._validate_count(count, maximum=20)
        theme = self._validate_text(theme, "theme", 100)
        subtitle_font_size = self._bounded_integer(
            subtitle_font_size, "subtitle_font_size", 36, 64
        )
        subtitle_margin_bottom = self._bounded_integer(
            subtitle_margin_bottom, "subtitle_margin_bottom", 120, 360
        )
        experiment_mode = str(experiment_mode or "").strip() or None
        if experiment_mode not in {None, "standard", "supoclip_bailian_v1"}:
            raise ContentEngineError("invalid_experiment_mode", "不支持的课程剪辑实验模式。")
        if experiment_mode == "standard":
            experiment_mode = None
        subtitle_preset = str(subtitle_preset or "dynamic_clean").strip()
        if experiment_mode == "supoclip_bailian_v1":
            if count != 5:
                raise ContentEngineError(
                    "invalid_experiment_count", "百炼 × SupoClip 对照实验固定生成 5 条候选。"
                )
            if subtitle_preset not in {"knowledge_course", "energetic_talking"}:
                raise ContentEngineError("invalid_subtitle_preset", "不支持的动态字幕模板。")
        else:
            subtitle_preset = "dynamic_clean"
        packaging = self._validate_packaging_options(
            "course",
            packaging_mode=packaging_mode,
            packaging_preset_id=packaging_preset_id,
            brand_profile_id=brand_profile_id,
            cover_mode=cover_mode,
            visual_renderer=visual_renderer,
        )
        if (
            isinstance(packaging.get("visual_renderer"), dict)
            and packaging["visual_renderer"].get("allowFallback") is False
            and confirm_paid_calls is not True
        ):
            raise ContentEngineError(
                "paid_calls_confirmation_required",
                "Remotion-only 首条验收需要先确认云端调用预估。",
            )
        project_id = self._new_id("creative_project")
        settings = {
            "asset_ids": [asset_id],
            "min_duration_ms": minimum,
            "max_duration_ms": maximum,
            "count": count,
            "recommended_count": min(2, count),
            "subtitle_font_size": subtitle_font_size,
            "subtitle_margin_bottom": subtitle_margin_bottom,
            "internal_only": True,
            "paid_call_confirmation": bool(confirm_paid_calls),
            **packaging,
        }
        if experiment_mode:
            settings.update(
                {
                    "experiment_mode": experiment_mode,
                    "subtitle_preset": subtitle_preset,
                }
            )
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO creative_projects(
                    id, mode, name, theme, settings_json, created_at, updated_at
                ) VALUES (?, 'course', ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    f"{theme}·长课程精剪",
                    theme,
                    self._json(settings),
                    now,
                    now,
                ),
            )
        task = self._create_task(
            "course_generation", {"project_id": project_id, **settings}
        )
        return {**task, "project_id": project_id}

    def create_mix_task(
        self,
        asset_ids,
        *,
        theme="培训现场价值",
        target_count=30,
        voice_asset_id=None,
        pilot_mode=False,
        packaging_mode="auto",
        packaging_preset_id=None,
        brand_profile_id=None,
        cover_mode="auto",
        visual_renderer=None,
        confirm_paid_calls=False,
    ):
        safe_ids = self._validate_asset_ids(asset_ids)
        voice_asset_id = voice_asset_id or safe_ids[0]
        if voice_asset_id not in safe_ids:
            raise ContentEngineError(
                "invalid_voice_asset", "The voice asset must be part of the selected material."
            )
        self._validate_asset_ids([voice_asset_id], require_audio=True)
        target_count = self._validate_count(target_count, maximum=MAX_MIX_OUTPUTS)
        theme = self._validate_text(theme, "theme", 100)
        packaging = self._validate_packaging_options(
            "mix",
            packaging_mode=packaging_mode,
            packaging_preset_id=packaging_preset_id,
            brand_profile_id=brand_profile_id,
            cover_mode=cover_mode,
            visual_renderer=visual_renderer,
        )
        if (
            isinstance(packaging.get("visual_renderer"), dict)
            and packaging["visual_renderer"].get("allowFallback") is False
            and confirm_paid_calls is not True
        ):
            raise ContentEngineError(
                "paid_calls_confirmation_required",
                "Remotion-only 首条验收需要先确认云端调用预估。",
            )
        project_id = self._new_id("creative_project")
        settings = {
            "asset_ids": safe_ids,
            "voice_asset_id": voice_asset_id,
            "pilot_mode": bool(pilot_mode),
            "target_count": target_count,
            "voice_mode": "lecturer_original",
            "required_roles": list(ROLE_ORDER),
            "quality_threshold": 0.55,
            "internal_only": True,
            "paid_call_confirmation": bool(confirm_paid_calls),
            **packaging,
        }
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO creative_projects(
                    id, mode, name, theme, settings_json, created_at, updated_at
                ) VALUES (?, 'mix', ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    f"{theme}·AI批量混剪",
                    theme,
                    self._json(settings),
                    now,
                    now,
                ),
            )
        task = self._create_task("mix_generation", {"project_id": project_id, **settings})
        return {**task, "project_id": project_id}

    # ------------------------------------------------------------------
    # 素材驱动“一键混剪” V2
    # ------------------------------------------------------------------
    def _sync_configured_voice_persona(self):
        now = self._now()
        personas = configured_voice_personas()
        with self.database.transaction():
            self._sync_configured_voice_persona_rows(now, personas)

    def _sync_configured_voice_persona_rows(self, now, personas):
        configured_ids = {persona["persona_id"] for persona in personas}
        retired_ids = [
            row["id"]
            for row in self.connection.execute(
                "SELECT id FROM voice_personas_v1 WHERE catalog_source = 'configured'"
            ).fetchall()
            if row["id"] not in configured_ids
        ]
        for persona_id in retired_ids:
            self.connection.execute(
                """
                UPDATE voice_personas_v1
                SET active = 0, approved_at = NULL, updated_at = ?
                WHERE id = ? AND catalog_source = 'configured'
                """,
                (now, persona_id),
            )
            self.connection.execute(
                """
                DELETE FROM auto_mix_voice_previews_v1
                WHERE persona_id = ?
                  AND status NOT IN ('submitted', 'outcome_unknown')
                """,
                (persona_id,),
            )
            self.connection.execute(
                """
                DELETE FROM auto_mix_voice_designs_v1
                WHERE persona_id = ?
                  AND status NOT IN ('submitted', 'outcome_unknown')
                """,
                (persona_id,),
            )
        for persona in personas:
            provider = persona.get("provider") or "bailian"
            provider_model = persona.get("provider_model") or AUTO_MIX_TTS_MODEL
            version = int(persona["persona_id"].rsplit("@", 1)[1])
            # Catalog configuration can register a private provider voice, but
            # it cannot stand in for the user's preview-and-approve action.
            approved_at = None
            previous = self.connection.execute(
                """
                SELECT catalog_version, provider, provider_model,
                       provider_voice_id, instruction, voice_prompt,
                       voice_prefix, catalog_source
                FROM voice_personas_v1 WHERE id = ?
                """,
                (persona["persona_id"],),
            ).fetchone()
            configured_provider_voice_id = str(
                persona["provider_voice_id"] or ""
            )
            private_configuration_changed = previous is not None and (
                str(previous["catalog_version"] or "")
                != str(persona["catalog_version"] or "")
                or str(previous["catalog_source"] or "") != "configured"
                or str(previous["provider"] or "") != provider
                or str(previous["provider_model"] or "")
                != provider_model
                or (
                    bool(configured_provider_voice_id)
                    and str(previous["provider_voice_id"] or "")
                    != configured_provider_voice_id
                )
                or str(previous["instruction"] or "")
                != str(persona["instruction"] or "")
                or str(previous["voice_prompt"] or "")
                != str(persona.get("voice_prompt") or "")
                or str(previous["voice_prefix"] or "")
                != str(persona.get("voice_prefix") or "")
            )
            provider_voice_id = configured_provider_voice_id
            if (
                not provider_voice_id
                and previous is not None
                and not private_configuration_changed
            ):
                provider_voice_id = str(previous["provider_voice_id"] or "")
            self.connection.execute(
                """
                INSERT INTO voice_personas_v1(
                    id, version, display_name, style, catalog_version, provider,
                    provider_model, provider_voice_id, instruction, voice_prompt,
                    voice_prefix, catalog_source, approved_at, active, created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, 1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    version = excluded.version,
                    display_name = excluded.display_name,
                    style = excluded.style,
                    catalog_version = excluded.catalog_version,
                    provider = excluded.provider,
                    provider_model = excluded.provider_model,
                    provider_voice_id = excluded.provider_voice_id,
                    instruction = excluded.instruction,
                    voice_prompt = excluded.voice_prompt,
                    voice_prefix = excluded.voice_prefix,
                    catalog_source = 'configured',
                    approved_at = COALESCE(voice_personas_v1.approved_at, excluded.approved_at),
                    active = 1,
                    updated_at = excluded.updated_at
                """,
                (
                    persona["persona_id"],
                    version,
                    persona["display_name"],
                    persona["style"],
                    persona["catalog_version"],
                    provider,
                    provider_model,
                    provider_voice_id,
                    persona["instruction"],
                    persona.get("voice_prompt") or "",
                    persona.get("voice_prefix") or "",
                    approved_at,
                    now,
                    now,
                ),
            )
            if private_configuration_changed:
                # Approval and the preview both bind to the private provider
                # configuration. Reusing either after an in-place catalog
                # change would approve a voice the user never heard.
                self.connection.execute(
                    "UPDATE voice_personas_v1 SET approved_at = NULL WHERE id = ?",
                    (persona["persona_id"],),
                )
                self.connection.execute(
                    """
                    DELETE FROM auto_mix_voice_previews_v1
                    WHERE persona_id = ?
                      AND status NOT IN ('submitted', 'outcome_unknown')
                    """,
                    (persona["persona_id"],),
                )
                self.connection.execute(
                    """
                    DELETE FROM auto_mix_voice_designs_v1
                    WHERE persona_id = ?
                      AND status NOT IN ('submitted', 'outcome_unknown')
                    """,
                    (persona["persona_id"],),
                )

    def _auto_mix_voice_persona_row(self, voice_persona_id):
        persona_id = str(voice_persona_id or "").strip()
        if not VOICE_PERSONA_ID.fullmatch(persona_id):
            raise ContentEngineError(
                "invalid_voice_persona_id", "声音人格标识无效。"
            )
        row = self.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = ? AND active = 1",
            (persona_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "auto_mix_voice_persona_not_found", "声音目录中没有该人格。"
            )
        return row

    def list_auto_mix_voice_personas(self):
        rows = self.connection.execute(
            """
            SELECT p.*, COALESCE(v.status, 'not_ready') AS preview_status,
                   d.status AS design_status
            FROM voice_personas_v1 p
            LEFT JOIN auto_mix_voice_previews_v1 v ON v.persona_id = p.id
            LEFT JOIN auto_mix_voice_designs_v1 d ON d.persona_id = p.id
            WHERE p.active = 1 AND ((p.provider = 'bailian' AND p.provider_model = ?)
                OR (p.provider = 'volcengine' AND p.provider_model IN ('seed-tts-1.0', 'seed-tts-2.0')))
            ORDER BY p.approved_at IS NULL, p.updated_at DESC, p.id
            """,
            (AUTO_MIX_TTS_MODEL,),
        ).fetchall()
        return {"items": [self._public_voice_persona(row) for row in rows]}

    def design_auto_mix_voice_persona(self, voice_persona_id):
        persona = self._auto_mix_voice_persona_row(voice_persona_id)
        if str(persona["provider_voice_id"] or "").strip():
            return self._public_voice_persona(persona)

        voice_prompt = re.sub(
            r"\s+", " ", str(persona["voice_prompt"] or "")
        ).strip()
        voice_prefix = str(persona["voice_prefix"] or "").strip()
        if not voice_prompt or not VOICE_PREFIX.fullmatch(voice_prefix):
            raise ContentEngineError(
                "auto_mix_voice_design_unavailable",
                "当前声音没有可用的设计模板。",
            )

        design_key = auto_mix_canonical_hash(
            {
                "stage": "auto_mix_voice_design",
                "persona_id": persona["id"],
                "catalog_version": persona["catalog_version"],
                "provider_model": persona["provider_model"],
                "voice_prompt": voice_prompt,
                "voice_prefix": voice_prefix,
                "preview_sample": VOICE_PREVIEW_SAMPLE,
            }
        )
        previous = self.connection.execute(
            "SELECT * FROM auto_mix_voice_designs_v1 WHERE persona_id = ?",
            (persona["id"],),
        ).fetchone()
        if previous is not None and previous["status"] in {
            "submitted",
            "outcome_unknown",
        }:
            reconciled = self._reconcile_auto_mix_voice_persona(persona)
            if reconciled.get("status") == "recovered":
                return reconciled["persona"]
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "上次声音设计结果仍无法确认；为避免重复创建，不会自动重提。",
            )
        if (
            previous is not None
            and previous["design_key"] == design_key
            and previous["status"] == "completed"
        ):
            # A completed design without its private provider identifier is an
            # inconsistent local record. Creating another remote voice would
            # be unsafe, so recovery remains fail-closed.
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "声音设计记录不完整；为避免重复创建，不会自动重提。",
            )

        relative = Path("auto-mix-cache") / "voice-designs" / f"{design_key}.wav"
        output = (self.data_dir / relative).resolve()
        if self.data_dir not in output.parents:
            raise ContentEngineError(
                "auto_mix_voice_design_unavailable", "声音设计缓存位置无效。"
            )
        now = self._now()
        self.connection.execute(
            """
            INSERT INTO auto_mix_voice_designs_v1(
                persona_id, design_key, status, managed_relative_path,
                audio_digest, error_code, created_at, updated_at
            ) VALUES (?, ?, 'submitted', NULL, NULL, NULL, ?, ?)
            ON CONFLICT(persona_id) DO UPDATE SET
                design_key = excluded.design_key,
                status = 'submitted',
                managed_relative_path = NULL,
                audio_digest = NULL,
                error_code = NULL,
                updated_at = excluded.updated_at
            """,
            (persona["id"], design_key, now, now),
        )

        design = getattr(self.analyzer, "design_auto_mix_voice", None)
        if not callable(design):
            self._set_auto_mix_voice_design_failure(
                persona["id"], "failed", "auto_mix_voice_design_unavailable"
            )
            raise ContentEngineError(
                "auto_mix_voice_design_unavailable",
                "当前内容引擎不支持声音设计。",
            )

        try:
            output.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            self._set_auto_mix_voice_design_failure(
                persona["id"], "failed", "auto_mix_voice_design_unavailable"
            )
            raise ContentEngineError(
                "auto_mix_voice_design_unavailable",
                "无法准备声音设计的本地缓存。",
            ) from error
        try:
            result = design(
                output,
                {
                    "provider": persona["provider"],
                    "provider_model": persona["provider_model"],
                    "voice_prompt": voice_prompt,
                    "voice_prefix": voice_prefix,
                },
            )
        except ContentEngineError as error:
            status = (
                "outcome_unknown"
                if error.code == "auto_mix_voice_design_outcome_unknown"
                else "failed"
            )
            self._set_auto_mix_voice_design_failure(
                persona["id"], status, error.code
            )
            if status == "outcome_unknown":
                reconciled = self._reconcile_auto_mix_voice_persona(persona)
                if reconciled.get("status") == "recovered":
                    return reconciled["persona"]
            raise
        except Exception as error:
            self._set_auto_mix_voice_design_failure(
                persona["id"],
                "outcome_unknown",
                "auto_mix_voice_design_outcome_unknown",
            )
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "声音设计提交结果不明；为避免重复创建，不会自动重提。",
            ) from error

        try:
            if not isinstance(result, dict):
                raise ContentEngineError(
                    "auto_mix_voice_design_outcome_unknown",
                    "声音设计返回结果无效。",
                )
            private_voice_id = str(result.get("provider_voice_id") or "").strip()
            if (
                not private_voice_id
                or len(private_voice_id) > 300
                or any(character.isspace() for character in private_voice_id)
            ):
                raise ContentEngineError(
                    "auto_mix_voice_design_outcome_unknown",
                    "声音设计返回的私有音色无效。",
                )
            self._wav_duration_ms(output)
            preview_size = output.stat().st_size
            if not 0 < preview_size <= MAX_VOICE_PREVIEW_BYTES:
                raise ContentEngineError(
                    "auto_mix_voice_design_outcome_unknown",
                    "声音设计试听文件大小不符合安全限制。",
                )
            audio_digest = self._sha256_file(output)
        except (ContentEngineError, OSError, TypeError, ValueError) as error:
            self._set_auto_mix_voice_design_failure(
                persona["id"],
                "outcome_unknown",
                "auto_mix_voice_design_outcome_unknown",
            )
            if isinstance(error, ContentEngineError) and (
                error.code == "auto_mix_voice_design_outcome_unknown"
            ):
                raise
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "声音设计已提交，但本地结果无法确认；不会自动重提。",
            ) from error

        cache_key = voice_preview_cache_key(persona)
        completed_at = self._now()
        try:
            with self.database.transaction() as connection:
                persona_update = connection.execute(
                    """
                    UPDATE voice_personas_v1
                    SET provider_voice_id = ?, approved_at = NULL, updated_at = ?
                    WHERE id = ? AND active = 1
                    """,
                    (private_voice_id, completed_at, persona["id"]),
                )
                design_update = connection.execute(
                    """
                    UPDATE auto_mix_voice_designs_v1
                    SET status = 'completed', managed_relative_path = ?,
                        audio_digest = ?, error_code = NULL, updated_at = ?
                    WHERE persona_id = ? AND design_key = ?
                    """,
                    (
                        str(relative),
                        audio_digest,
                        completed_at,
                        persona["id"],
                        design_key,
                    ),
                )
                if persona_update.rowcount != 1 or design_update.rowcount != 1:
                    raise RuntimeError("voice design state changed during completion")
                connection.execute(
                    """
                    INSERT INTO auto_mix_voice_previews_v1(
                        persona_id, cache_key, status, managed_relative_path,
                        audio_digest, error_code, created_at, updated_at
                    ) VALUES (?, ?, 'completed', ?, ?, NULL, ?, ?)
                    ON CONFLICT(persona_id) DO UPDATE SET
                        cache_key = excluded.cache_key,
                        status = 'completed',
                        managed_relative_path = excluded.managed_relative_path,
                        audio_digest = excluded.audio_digest,
                        error_code = NULL,
                        updated_at = excluded.updated_at
                    """,
                    (
                        persona["id"],
                        cache_key,
                        str(relative),
                        audio_digest,
                        completed_at,
                        completed_at,
                    ),
                )
        except Exception as error:
            # The provider has already returned a private voice. If durable
            # local completion fails, another create request could duplicate it.
            try:
                self._set_auto_mix_voice_design_failure(
                    persona["id"],
                    "outcome_unknown",
                    "auto_mix_voice_design_outcome_unknown",
                )
            except Exception:
                pass
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown",
                "声音已经设计完成，但本地状态无法确认；不会自动重提。",
            ) from error
        designed = self._auto_mix_voice_persona_row(persona["id"])
        public = self._public_voice_persona(designed)
        public["previewStatus"] = "completed"
        return public

    def _reconcile_auto_mix_voice_persona(self, persona):
        reconcile = getattr(self.analyzer, "reconcile_auto_mix_voice_design", None)
        if not callable(reconcile):
            return {"status": "unavailable"}
        try:
            result = reconcile(
                {
                    "provider": persona["provider"],
                    "provider_model": persona["provider_model"],
                    "voice_prompt": persona["voice_prompt"],
                    "voice_prefix": persona["voice_prefix"],
                }
            )
        except ContentEngineError as error:
            return {"status": "unavailable", "error": error}
        if not isinstance(result, dict):
            return {"status": "unavailable"}
        status = str(result.get("status") or "").strip().casefold()
        if status != "recovered":
            return {"status": status or "unavailable"}
        private_voice_id = str(result.get("provider_voice_id") or "").strip()
        if (
            not private_voice_id
            or len(private_voice_id) > 300
            or any(character.isspace() for character in private_voice_id)
        ):
            return {"status": "ambiguous"}
        completed_at = self._now()
        try:
            with self.database.transaction() as connection:
                design_update = connection.execute(
                    """
                    UPDATE auto_mix_voice_designs_v1
                    SET status = 'completed', managed_relative_path = NULL,
                        audio_digest = NULL, error_code = NULL, updated_at = ?
                    WHERE persona_id = ?
                      AND status IN ('submitted', 'outcome_unknown')
                    """,
                    (completed_at, persona["id"]),
                )
                persona_update = connection.execute(
                    """
                    UPDATE voice_personas_v1
                    SET provider_voice_id = ?, approved_at = NULL, updated_at = ?
                    WHERE id = ? AND active = 1 AND provider_voice_id = ''
                    """,
                    (private_voice_id, completed_at, persona["id"]),
                )
                if design_update.rowcount != 1 or persona_update.rowcount != 1:
                    raise RuntimeError("voice reconciliation state changed")
        except Exception:
            return {"status": "ambiguous"}
        recovered = self._auto_mix_voice_persona_row(persona["id"])
        return {
            "status": "recovered",
            "persona": self._public_voice_persona(recovered),
        }

    def _reconcile_unknown_auto_mix_voices(self):
        rows = self.connection.execute(
            """
            SELECT p.*
            FROM voice_personas_v1 p
            JOIN auto_mix_voice_designs_v1 d ON d.persona_id = p.id
            WHERE p.active = 1 AND p.provider_model = ?
              AND p.provider_voice_id = ''
              AND d.status IN ('submitted', 'outcome_unknown')
            ORDER BY d.updated_at DESC, p.id
            """,
            (AUTO_MIX_TTS_MODEL,),
        ).fetchall()
        by_id = {str(row["id"]): row for row in rows}
        ordered = [
            by_id.pop(persona_id)
            for persona_id in auto_select_voice_persona_ids()
            if persona_id in by_id
        ]
        ordered.extend(by_id.values())
        retry_allowed = False
        unresolved = False
        unavailable_error = None
        for persona in ordered:
            result = self._reconcile_auto_mix_voice_persona(persona)
            status = result.get("status")
            if status == "recovered":
                self.preview_auto_mix_voice_persona(persona["id"])
                self.approve_auto_mix_voice_persona(persona["id"])
                return {"status": "recovered"}
            if status == "not_found":
                updated = self.connection.execute(
                    """
                    UPDATE auto_mix_voice_designs_v1
                    SET status = 'failed', error_code = 'auto_mix_voice_design_not_found',
                        updated_at = ?
                    WHERE persona_id = ?
                      AND status IN ('submitted', 'outcome_unknown')
                      AND (julianday(?) - julianday(updated_at)) * 86400 >= 600
                    """,
                    (self._now(), persona["id"], self._now()),
                )
                if updated.rowcount == 1:
                    retry_allowed = True
                else:
                    unresolved = True
            elif status == "rejected":
                updated = self.connection.execute(
                    """
                    UPDATE auto_mix_voice_designs_v1
                    SET status = 'failed', error_code = 'auto_mix_voice_design_rejected',
                        updated_at = ?
                    WHERE persona_id = ?
                      AND status IN ('submitted', 'outcome_unknown')
                    """,
                    (self._now(), persona["id"]),
                )
                if updated.rowcount == 1:
                    retry_allowed = True
                else:
                    unresolved = True
            elif status == "unavailable":
                unavailable_error = unavailable_error or result.get("error")
                unresolved = True
            else:
                unresolved = True
        if retry_allowed and not unresolved:
            return {"status": "retry_allowed"}
        if unavailable_error is not None:
            raise unavailable_error
        return {"status": "unresolved"}

    def _set_auto_mix_voice_design_failure(self, persona_id, status, error_code):
        self.connection.execute(
            """
            UPDATE auto_mix_voice_designs_v1
            SET status = ?, error_code = ?, updated_at = ?
            WHERE persona_id = ?
            """,
            (status, error_code, self._now(), persona_id),
        )

    def preview_auto_mix_voice_persona(self, voice_persona_id):
        persona = self._auto_mix_voice_persona_row(voice_persona_id)
        sample = voice_preview_sample(persona)
        if not str(persona["provider_voice_id"] or "").strip():
            raise ContentEngineError(
                "auto_mix_voice_design_required", "请先生成当前声音，再进行试听。"
            )
        cache_key = voice_preview_cache_key(persona)
        relative = Path("auto-mix-cache") / "voice-previews" / f"{cache_key}.wav"
        output = (self.data_dir / relative).resolve()
        if self.data_dir not in output.parents:
            raise ContentEngineError(
                "auto_mix_voice_preview_unavailable", "声音试听缓存位置无效。"
            )
        previous = self.connection.execute(
            "SELECT * FROM auto_mix_voice_previews_v1 WHERE persona_id = ?",
            (persona["id"],),
        ).fetchone()
        if previous is not None and previous["status"] in {
            "submitted",
            "outcome_unknown",
        }:
            raise ContentEngineError(
                "auto_mix_voice_preview_outcome_unknown",
                "上次声音试听结果仍无法确认；为避免重复计费，不会自动重提。",
            )
        if previous is not None and previous["cache_key"] == cache_key:
            previous_relative = str(
                previous["managed_relative_path"] or ""
            ).strip()
            previous_output = (
                (self.data_dir / previous_relative).resolve()
                if previous_relative
                else output
            )
            if (
                previous["status"] == "completed"
                and self.data_dir in previous_output.parents
                and previous_output.is_file()
                and self._valid_voice_preview(
                    previous_output, previous["audio_digest"]
                )
            ):
                public = self._public_voice_persona(persona)
                public["previewStatus"] = "completed"
                return {
                    "voicePersona": public,
                    "previewStatus": "completed",
                    "audioDataUrl": voice_preview_data_url(previous_output),
                    "cacheHit": True,
                }
        normalize_executable = None
        if persona["provider"] == "volcengine":
            from .volcengine_tts import VolcengineTTSProvider
            if not VolcengineTTSProvider().configured:
                raise ContentEngineError("volcengine_tts_not_configured", "请先在声音设置中配置火山语音 API Key。")
            normalize_executable = voice_preview_ffmpeg()
        reuse_generated = bool(previous is not None and previous["cache_key"] == cache_key
                               and previous["status"] == "failed"
                               and previous["error_code"] in {"auto_mix_voice_preview_normalization_pending", "auto_mix_voice_preview_normalization_failed"}
                               and self._valid_voice_preview(output, previous["audio_digest"]))
        now = self._now()
        if not reuse_generated:
            self.connection.execute(
                """
                INSERT INTO auto_mix_voice_previews_v1(
                persona_id, cache_key, status, managed_relative_path,
                audio_digest, error_code, created_at, updated_at
            ) VALUES (?, ?, 'submitted', NULL, NULL, NULL, ?, ?)
            ON CONFLICT(persona_id) DO UPDATE SET
                cache_key = excluded.cache_key,
                status = 'submitted',
                managed_relative_path = NULL,
                audio_digest = NULL,
                error_code = NULL,
                updated_at = excluded.updated_at
                """,
                (persona["id"], cache_key, now, now),
            )
        synthesize = getattr(self.analyzer, "synthesize_auto_mix_phrase", None)
        if not callable(synthesize):
            self.connection.execute(
                """
                UPDATE auto_mix_voice_previews_v1
                SET status = 'failed', error_code = ?, updated_at = ?
                WHERE persona_id = ?
                """,
                ("auto_mix_voice_unavailable", self._now(), persona["id"]),
            )
            raise ContentEngineError(
                "auto_mix_voice_unavailable", "当前内容引擎不支持声音试听。"
            )
        output.parent.mkdir(parents=True, exist_ok=True)
        try:
            if not reuse_generated:
                synthesize(
                    sample,
                    output,
                    {
                        "provider": persona["provider"],
                        "provider_model": persona["provider_model"],
                        "provider_voice_id": persona["provider_voice_id"],
                        "instruction": persona["instruction"],
                    },
                )
                if normalize_executable:
                    self._wav_duration_ms(output)
                    self.connection.execute(
                        "UPDATE auto_mix_voice_previews_v1 SET status='failed', error_code='auto_mix_voice_preview_normalization_pending', managed_relative_path=?, audio_digest=?, updated_at=? WHERE persona_id=?",
                        (str(relative), hashlib.sha256(output.read_bytes()).hexdigest(), self._now(), persona["id"]))
            if normalize_executable:
                normalize_voice_preview(output, normalize_executable)
            self._wav_duration_ms(output)
            try:
                preview_size = output.stat().st_size
            except OSError as error:
                raise ContentEngineError(
                    "auto_mix_voice_preview_unavailable",
                    "声音试听文件不可用。",
                ) from error
            if not 0 < preview_size <= MAX_VOICE_PREVIEW_BYTES:
                raise ContentEngineError(
                    "auto_mix_voice_preview_unavailable",
                    "声音试听文件大小不符合安全限制。",
                )
            try:
                preview_bytes = output.read_bytes()
            except OSError as error:
                raise ContentEngineError(
                    "auto_mix_voice_preview_unavailable",
                    "声音试听文件不可用。",
                ) from error
            audio_digest = hashlib.sha256(preview_bytes).hexdigest()
        except ContentEngineError as error:
            status = (
                "outcome_unknown"
                if error.code == "auto_mix_voice_outcome_unknown"
                else "failed"
            )
            self.connection.execute(
                """
                UPDATE auto_mix_voice_previews_v1
                SET status = ?, error_code = ?, updated_at = ?
                WHERE persona_id = ?
                """,
                (status, error.code, self._now(), persona["id"]),
            )
            if status == "outcome_unknown":
                raise ContentEngineError(
                    "auto_mix_voice_preview_outcome_unknown",
                    "声音试听提交结果不明；为避免重复计费，不会自动重提。",
                ) from None
            raise
        self.connection.execute(
            """
            UPDATE auto_mix_voice_previews_v1
            SET status = 'completed', managed_relative_path = ?,
                audio_digest = ?, error_code = NULL, updated_at = ?
            WHERE persona_id = ? AND cache_key = ?
            """,
            (str(relative), audio_digest, self._now(), persona["id"], cache_key),
        )
        public = self._public_voice_persona(persona)
        public["previewStatus"] = "completed"
        return {
            "voicePersona": public,
            "previewStatus": "completed",
            "audioDataUrl": voice_preview_data_url(output),
            "cacheHit": False,
        }

    def approve_auto_mix_voice_persona(self, voice_persona_id):
        persona = self._auto_mix_voice_persona_row(voice_persona_id)
        cache_key = voice_preview_cache_key(persona)
        preview = self.connection.execute(
            """
            SELECT * FROM auto_mix_voice_previews_v1
            WHERE persona_id = ? AND cache_key = ? AND status = 'completed'
            """,
            (persona["id"], cache_key),
        ).fetchone()
        relative = str(preview["managed_relative_path"] or "") if preview else ""
        preview_path = (self.data_dir / relative).resolve() if relative else None
        if (
            preview is None
            or preview_path is None
            or self.data_dir not in preview_path.parents
            or not preview_path.is_file()
            or not self._valid_voice_preview(
                preview_path, preview["audio_digest"] if preview else ""
            )
        ):
            raise ContentEngineError(
                "auto_mix_voice_preview_required", "请先试听当前版本，再批准该声音。"
            )
        self.connection.execute(
            "UPDATE voice_personas_v1 SET approved_at = ?, updated_at = ? WHERE id = ?",
            (self._now(), self._now(), persona["id"]),
        )
        approved = self._auto_mix_voice_persona_row(persona["id"])
        public = self._public_voice_persona(approved)
        public["previewStatus"] = "completed"
        return public

    def _auto_mix_v2_analysis_profile(self):
        return {
            "provider": self.analyzer.capability.get("provider", "local"),
            "workflow": "auto_mix_v2",
        }

    def _auto_mix_asset_snapshots(self, asset_ids):
        snapshots = []
        for asset_id in self._validate_asset_ids(asset_ids):
            row = self._asset_row(asset_id)
            if row["media_kind"] not in {"image", "video"}:
                raise ContentEngineError(
                    "invalid_auto_mix_assets", "V2 只接受图片或视频素材。"
                )
            snapshots.append(
                {
                    "asset_id": asset_id,
                    "fingerprint": str(
                        row["full_fingerprint"] or row["fingerprint"] or ""
                    ),
                    "duration_ms": int(row["duration_ms"] or 0),
                    "media_kind": str(row["media_kind"]),
                }
            )
        return snapshots

    def _guided_auto_mix_session_row(self, session_id):
        row = self.connection.execute(
            "SELECT * FROM guided_auto_mix_sessions_v1 WHERE id = ?",
            (str(session_id or ""),),
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "guided_auto_mix_session_not_found", "没有找到这次素材解析，请重新开始。"
            )
        return row

    def _restore_known_guided_auto_mix_draft_failure(self, session_id):
        """Reopen legacy sessions whose completed draft failure was misclassified."""
        if not session_id:
            return False
        with self.database.transaction() as connection:
            session = connection.execute(
                """
                SELECT draft_task_id FROM guided_auto_mix_sessions_v1
                WHERE id = ? AND status = 'outcome_unknown'
                """,
                (str(session_id),),
            ).fetchone()
            if session is None or not session["draft_task_id"]:
                return False
            task = connection.execute(
                """
                SELECT task_type, status, error_code FROM content_tasks
                WHERE id = ?
                """,
                (str(session["draft_task_id"]),),
            ).fetchone()
            if (
                task is None
                or task["task_type"] != "guided_auto_mix_draft"
                or task["status"] != "failed"
                or task["error_code"] != "product_copy_invalid"
            ):
                return False
            cursor = connection.execute(
                """
                UPDATE guided_auto_mix_sessions_v1
                SET status = 'ready_for_answers', updated_at = ?
                WHERE id = ? AND draft_task_id = ? AND status = 'outcome_unknown'
                """,
                (self._now(), str(session_id), str(session["draft_task_id"])),
            )
        return bool(cursor.rowcount)

    def _guided_auto_mix_asset_ids(self, row):
        return self._validate_asset_ids(self._json_array(row["asset_ids_json"]))

    def _guided_auto_mix_current_snapshots(self, row):
        return self._auto_mix_asset_snapshots(self._guided_auto_mix_asset_ids(row))

    def _guided_auto_mix_snapshot_matches(self, row):
        expected = self._json_array(row["asset_snapshot_json"])
        try:
            current = self._guided_auto_mix_current_snapshots(row)
        except ContentEngineError:
            return False
        return auto_mix_canonical_hash(expected) == auto_mix_canonical_hash(current)

    def _guided_auto_mix_analysis_versions(self, asset_ids, profile):
        versions = {}
        version_for = getattr(self.analyzer, "analysis_version_for", None)
        for asset_id in asset_ids:
            version = ""
            asset = self._asset_row(asset_id)
            if callable(version_for):
                try:
                    version = str(version_for(asset, profile) or "")
                except (ContentEngineError, TypeError, ValueError, RuntimeError):
                    version = ""
            if not version:
                row = self.connection.execute(
                    """
                    SELECT analysis_version FROM media_segments
                    WHERE asset_id = ?
                    ORDER BY rowid DESC LIMIT 1
                    """,
                    (asset_id,),
                ).fetchone()
                version = str(row["analysis_version"] or "") if row else ""
            versions[asset_id] = version
        return versions

    def _guided_auto_mix_summary(self, asset_ids, analysis_versions):
        cards = self._auto_mix_asset_cards(
            asset_ids, analysis_versions=analysis_versions
        )
        timeline = build_material_timeline(cards)
        if not timeline.get("selected_segments"):
            raise ContentEngineError(
                "auto_mix_material_unavailable",
                "没有分析出可用的画面片段，请更换素材后重新解析。",
            )
        facts = build_material_evidence_facts(timeline)
        if not facts:
            raise ContentEngineError(
                "auto_mix_material_facts_insufficient",
                "素材没有足够的可核验画面信息，暂时不能生成可信脚本。",
            )
        return {
            "usable_material_duration_ms": int(
                timeline.get("usable_material_duration_ms") or 0
            ),
            "selected_duration_ms": int(timeline.get("selected_duration_ms") or 0),
            "selected_segment_count": len(timeline.get("selected_segments") or []),
            "duration_plan": self._guided_auto_mix_duration_plan(timeline),
            "material_timeline": timeline,
            "evidence_facts": facts,
        }

    @staticmethod
    def _guided_auto_mix_prefill(analysis):
        """Build editable suggestions only from this session's material facts.

        These values are deliberately kept separate from ``answers_json``.  The
        latter represents what the user has confirmed for the script, while a
        prefill is only a convenience suggestion that the renderer may show and
        the user may edit before submitting.
        """
        facts = analysis.get("evidence_facts") if isinstance(analysis, dict) else []
        normalized_facts = []
        for item in facts if isinstance(facts, list) else []:
            if not isinstance(item, dict):
                continue
            text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
            if text:
                normalized_facts.append((text, str(item.get("kind") or "")))

        corpus = " ".join(text for text, _kind in normalized_facts).lower()

        def has_any(*terms):
            return any(term in corpus for term in terms)

        has_robot = has_any("机器人", "robot", "autonomous vehicle")
        has_cleaning = has_any("清洁", "清扫", "洗涤", "洗地", "clean")
        has_automation = has_any("自动", "无人", "自主", "autonomous")
        if has_robot and has_cleaning:
            product_name = "自动清洁机器人" if has_automation else "清洁机器人"
        elif has_robot:
            product_name = "机器人"
        elif has_cleaning:
            product_name = "清洁设备"
        else:
            product_name = ""

        scene_rules = (
            (("工厂", "factory", "industrial"), "工厂现场"),
            (("车间", "workshop"), "生产车间"),
            (("仓库", "warehouse"), "仓库"),
            (("公共场所", "public place"), "公共场所"),
            (("室内", "indoor"), "室内环境"),
            (("户外", "outdoor"), "户外"),
            (("通道", "corridor"), "通道"),
        )
        scenes = []
        for terms, label in scene_rules:
            if has_any(*terms) and label not in scenes:
                scenes.append(label)
        target_scene = "、".join(scenes[:3])

        company_name = ""
        company_pattern = re.compile(
            r"(?:公司|品牌|厂家|企业|出品|制造商)(?:名称)?\s*(?:是|为|[:：])\s*"
            r"([A-Za-z0-9\u4e00-\u9fff·]{2,24})"
        )
        for text, kind in normalized_facts:
            if kind not in {"verifiable_text", "ocr", "transcript"}:
                continue
            matched = company_pattern.search(text)
            if matched:
                company_name = matched.group(1)
                break

        title = ""
        if product_name:
            location = scenes[0] if scenes else "现场"
            action = "自动作业" if has_automation else "展示"
            title = f"{location}{product_name}{action}"

        key_message = ""
        if product_name and has_cleaning and has_automation:
            key_message = f"{product_name}自动完成清洁作业"
        elif product_name and has_cleaning:
            key_message = f"{product_name}的现场清洁过程"
        elif product_name:
            key_message = f"{product_name}现场展示"

        return {
            "title": title[:100],
            "answers": {
                "companyName": company_name[:80],
                "productName": product_name[:100],
                "targetScene": target_scene[:180],
                "keyMessage": key_message[:300],
                "extraNotes": (
                    "仅使用素材中已出现的场景和能力，不补写参数、效果或未展示信息。"
                    if normalized_facts else ""
                )[:240],
            },
        }

    @staticmethod
    def _guided_auto_mix_answers(value):
        if not isinstance(value, dict):
            raise ContentEngineError(
                "invalid_guided_auto_mix_answers", "请按引导填写产品信息。"
            )
        allowed = {
            "companyName": 80,
            "productName": 100,
            "targetScene": 180,
            "keyMessage": 300,
            "extraNotes": 240,
        }
        if set(value) - set(allowed):
            raise ContentEngineError(
                "invalid_guided_auto_mix_answers", "引导问题中包含不支持的字段。"
            )
        answers = {}
        for key, limit in allowed.items():
            raw = value.get(key, "")
            if raw is None:
                raw = ""
            if not isinstance(raw, str) or len(raw) > limit:
                raise ContentEngineError(
                    "invalid_guided_auto_mix_answers", "引导问题的填写内容无效。"
                )
            answers[key] = re.sub(r"\s+", " ", raw).strip()
        if not answers["productName"]:
            raise ContentEngineError(
                "guided_auto_mix_product_missing", "请填写要介绍的产品或服务。"
            )
        return answers

    @classmethod
    def _guided_auto_mix_public_draft(cls, value):
        draft = value if isinstance(value, dict) else {}
        script = draft.get("script") if isinstance(draft.get("script"), dict) else {}
        return {
            "scriptRevision": max(0, int(draft.get("revision") or 0)),
            "title": str(draft.get("title") or "")[:100],
            "provider": str(script.get("provider") or "")[:64] or None,
            "hook": str(script.get("hook") or "")[:80],
            "voiceover": str(script.get("voiceover") or "")[:2_400],
            "cta": str(script.get("cta") or "")[:80],
            "spokenPhrases": [
                {"text": str(item.get("text") or "")[:80]}
                for item in script.get("spokenPhrases") or []
                if isinstance(item, dict) and str(item.get("text") or "").strip()
            ][:80],
            "visualTextItems": [
                {
                    "type": str(item.get("type") or "")[:24],
                    "text": str(item.get("text") or "")[:80],
                }
                for item in script.get("visualTextItems") or []
                if isinstance(item, dict) and str(item.get("text") or "").strip()
            ][:16],
            "durationPlan": cls._guided_auto_mix_public_duration_plan(
                draft.get("duration_plan")
            ),
        }

    def _public_guided_auto_mix_session(self, row):
        analysis = self._json_object(row["analysis_summary_json"])
        draft = self._json_object(row["draft_json"])
        task_value = None
        draft_task_value = None
        if row["analysis_task_id"]:
            try:
                task_value = self._public_task(self._task_row(row["analysis_task_id"]))
            except ContentEngineError:
                task_value = None
        if row["draft_task_id"]:
            try:
                draft_task_value = self._public_task(self._task_row(row["draft_task_id"]))
            except ContentEngineError:
                draft_task_value = None
        return {
            "session_id": str(row["id"]),
            "status": str(row["status"]),
            "asset_ids": self._json_array(row["asset_ids_json"]),
            "analysis_task": task_value,
            "draft_task": draft_task_value,
            "analysis": {
                "usable_material_duration_ms": int(
                    analysis.get("usable_material_duration_ms") or 0
                ),
                "selected_duration_ms": int(
                    analysis.get("selected_duration_ms") or 0
                ),
                "selected_segment_count": int(
                    analysis.get("selected_segment_count") or 0
                ),
                "durationPlan": self._guided_auto_mix_public_duration_plan(
                    analysis.get("duration_plan")
                ),
                "material_facts": [
                    {
                        "text": str(item.get("text") or "")[:72],
                        "kind": str(item.get("kind") or "")[:32],
                    }
                    for item in analysis.get("evidence_facts") or []
                    if isinstance(item, dict) and str(item.get("text") or "").strip()
                ][:8],
            },
            "answers": sanitize_public_value(
                self._json_object(row["answers_json"])
            ),
            "prefill": sanitize_public_value(
                self._guided_auto_mix_prefill(analysis)
            ),
            "draft": {
                **self._guided_auto_mix_public_draft(draft),
                # This is an integrity/version token, not user-entered copy.
                # The paid supplemental-image request must name the exact
                # confirmed draft it is allowed to use.
                "draftHash": str(row["draft_hash"] or "") or None,
            },
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def prepare_guided_auto_mix_v2(self, asset_ids):
        safe_ids = self._validate_asset_ids(asset_ids)
        snapshots = self._auto_mix_asset_snapshots(safe_ids)
        session_id = self._new_id("guided_auto_mix_session")
        task_id = self._new_id("task")
        profile = self._auto_mix_v2_analysis_profile()
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'guided_auto_mix_analysis', 'queued', ?, ?, ?)
                """,
                (
                    task_id,
                    self._json(
                        {
                            "session_id": session_id,
                            "asset_ids": safe_ids,
                            "profile": profile,
                        }
                    ),
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO guided_auto_mix_sessions_v1(
                    id, analysis_task_id, status, asset_ids_json,
                    asset_snapshot_json, analysis_profile_json,
                    created_at, updated_at
                ) VALUES (?, ?, 'analyzing', ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    task_id,
                    self._json(safe_ids),
                    self._json(snapshots),
                    self._json(profile),
                    now,
                    now,
                ),
            )
        return self._public_guided_auto_mix_session(
            self._guided_auto_mix_session_row(session_id)
        )

    def get_guided_auto_mix_session_v2(self, *, session_id=None, task_id=None):
        if bool(session_id) == bool(task_id):
            raise ContentEngineError(
                "guided_auto_mix_lookup_invalid", "请提供一次素材解析或任务标识。"
            )
        if task_id:
            row = self.connection.execute(
                """
                SELECT * FROM guided_auto_mix_sessions_v1
                WHERE analysis_task_id = ? OR draft_task_id = ?
                ORDER BY updated_at DESC, rowid DESC LIMIT 1
                """,
                (str(task_id), str(task_id)),
            ).fetchone()
            if row is None:
                try:
                    task = self._task_row(str(task_id))
                    payload = self._json_object(task["payload_json"])
                except ContentEngineError:
                    task = None
                    payload = {}
                if (
                    task is not None
                    and task["task_type"] == "guided_auto_mix_supplemental_image"
                ):
                    row = self.connection.execute(
                        """
                        SELECT * FROM guided_auto_mix_sessions_v1
                        WHERE id = ?
                        """,
                        (str(payload.get("session_id") or ""),),
                    ).fetchone()
            if row is None:
                raise ContentEngineError(
                    "guided_auto_mix_session_not_found", "没有找到对应的引导任务。"
                )
        else:
            row = self._guided_auto_mix_session_row(session_id)
        if row["status"] == "outcome_unknown":
            self._restore_known_guided_auto_mix_draft_failure(row["id"])
            row = self._guided_auto_mix_session_row(row["id"])
        return self._public_guided_auto_mix_session(row)

    def mark_guided_auto_mix_draft_outcome_unknown(self, task_id):
        """Fail closed when an in-flight external script request is interrupted."""
        task = self._task_row(task_id)
        if task["task_type"] != "guided_auto_mix_draft":
            return False
        payload = self._json_object(task["payload_json"])
        session_id = str(payload.get("session_id") or "").strip()
        if not session_id:
            return False
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE guided_auto_mix_sessions_v1
                SET status = 'outcome_unknown', updated_at = ?
                WHERE id = ? AND status = 'drafting'
                """,
                (self._now(), session_id),
            )
        return bool(cursor.rowcount)

    def generate_guided_auto_mix_script_v2(self, session_id, title, answers):
        row = self._guided_auto_mix_session_row(session_id)
        if row["status"] == "outcome_unknown":
            self._restore_known_guided_auto_mix_draft_failure(row["id"])
            row = self._guided_auto_mix_session_row(row["id"])
        if row["status"] == "outcome_unknown":
            raise ContentEngineError(
                "guided_auto_mix_outcome_unknown",
                "上次 AI 脚本请求结果未知；请先查询当前结果，避免重复调用。",
            )
        if row["status"] not in {"ready_for_answers", "ready_for_render"}:
            raise ContentEngineError(
                "guided_auto_mix_not_ready", "请先等待素材解析完成。"
            )
        if not self._guided_auto_mix_snapshot_matches(row):
            self._mark_guided_auto_mix_session_failed(
                row["id"], "guided_auto_mix_assets_changed"
            )
            raise ContentEngineError(
                "guided_auto_mix_assets_changed", "素材已变更，请重新解析后再生成脚本。"
            )
        safe_title = self._validate_text(title, "guided_auto_mix_title", 100)
        safe_answers = self._guided_auto_mix_answers(answers)
        task_id = self._new_id("task")
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'guided_auto_mix_draft', 'queued', ?, ?, ?)
                """,
                (
                    task_id,
                    self._json(
                        {
                            "session_id": row["id"],
                            "title": safe_title,
                            "answers": safe_answers,
                        }
                    ),
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                UPDATE guided_auto_mix_sessions_v1
                SET draft_task_id = ?, status = 'drafting', answers_json = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (task_id, self._json(safe_answers), now, row["id"]),
            )
        return self._public_guided_auto_mix_session(
            self._guided_auto_mix_session_row(row["id"])
        )

    def _mark_guided_auto_mix_session_failed(self, session_id, error_code):
        if not session_id:
            return False
        cursor = self.connection.execute(
            """
            UPDATE guided_auto_mix_sessions_v1
            SET status = 'failed', updated_at = ?
            WHERE id = ? AND status <> 'outcome_unknown'
            """,
            (self._now(), str(session_id)),
        )
        return bool(cursor.rowcount)

    def _mark_guided_auto_mix_session_outcome_unknown(self, session_id):
        if not session_id:
            return False
        cursor = self.connection.execute(
            """
            UPDATE guided_auto_mix_sessions_v1
            SET status = 'outcome_unknown', updated_at = ?
            WHERE id = ?
            """,
            (self._now(), str(session_id)),
        )
        return bool(cursor.rowcount)

    def _transition_guided_auto_mix_task_session(
        self, task_id, task_type, session_id, status
    ):
        if task_type == "guided_auto_mix_analysis":
            task_column = "analysis_task_id"
            expected_status = "analyzing"
        elif task_type == "guided_auto_mix_draft":
            task_column = "draft_task_id"
            expected_status = "drafting"
        else:
            return False
        allowed_statuses = {"failed", "outcome_unknown"}
        if task_type == "guided_auto_mix_draft":
            allowed_statuses.add("ready_for_answers")
        if status not in allowed_statuses or not session_id:
            return False
        cursor = self.connection.execute(
            f"""
            UPDATE guided_auto_mix_sessions_v1
            SET status = ?, updated_at = ?
            WHERE id = ? AND {task_column} = ? AND status = ?
            """,
            (
                status,
                self._now(),
                str(session_id),
                str(task_id),
                expected_status,
            ),
        )
        return bool(cursor.rowcount)

    @staticmethod
    def _guided_auto_mix_script_revision(value):
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ContentEngineError(
                "invalid_guided_auto_mix_script_revision",
                "请选择当前已确认的脚本版本。",
            )
        return value

    @staticmethod
    def _guided_auto_mix_draft_hash(value):
        digest = str(value or "").strip().casefold()
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ContentEngineError(
                "invalid_guided_auto_mix_draft_hash",
                "脚本版本校验信息无效，请重新打开当前脚本。",
            )
        return digest

    def _validated_guided_auto_mix_supplemental_context(
        self,
        session_id,
        script_revision,
        draft_hash,
        *,
        require_snapshot=False,
    ):
        session = self._guided_auto_mix_session_row(session_id)
        revision = self._guided_auto_mix_script_revision(script_revision)
        digest = self._guided_auto_mix_draft_hash(draft_hash)
        if session["status"] == "outcome_unknown":
            raise ContentEngineError(
                "guided_auto_mix_outcome_unknown",
                "当前引导任务结果未知，请重新解析素材后再继续。",
            )
        if session["status"] != "ready_for_render":
            raise ContentEngineError(
                "guided_auto_mix_script_not_ready",
                "请先完成 AI 脚本生成并确认当前版本。",
            )
        draft = self._json_object(session["draft_json"])
        if (
            int(draft.get("revision") or 0) != revision
            or str(session["draft_hash"] or "").casefold() != digest
        ):
            raise ContentEngineError(
                "guided_auto_mix_script_stale",
                "脚本已更新，请使用最新脚本版本继续。",
            )
        if require_snapshot and not self._guided_auto_mix_snapshot_matches(session):
            raise ContentEngineError(
                "guided_auto_mix_assets_changed",
                "素材已变更，请重新解析后再生成补图。",
            )
        return session, draft, digest

    @staticmethod
    def _guided_auto_mix_supplemental_image_prompt(session, draft):
        """Build an explicitly non-factual decorative-image prompt.

        The confirmed script and source facts are used only as semantic
        atmosphere cues.  No reference file is supplied: a reference-derived
        image would invite the provider to invent unverified product details.
        """
        analysis = CreativeDomain._json_object(session["analysis_summary_json"])
        script = draft.get("script") if isinstance(draft.get("script"), dict) else {}
        script_context = []
        for value in (
            draft.get("title"),
            script.get("hook"),
            script.get("voiceover"),
            script.get("cta"),
        ):
            normalized = re.sub(r"\s+", " ", str(value or "")).strip()
            if normalized:
                script_context.append(normalized[:180])
        fact_context = []
        for item in analysis.get("evidence_facts") or []:
            if not isinstance(item, dict):
                continue
            normalized = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
            if normalized and normalized not in fact_context:
                fact_context.append(normalized[:160])
            if len(fact_context) >= 4:
                break
        return "\n".join(
            (
                "Create one vertical 9:16 supplemental visual for a Chinese short-video transition.",
                "It is a scene-and-atmosphere illustration only, never documentary evidence.",
                "Use restrained professional lighting, clean depth, and safe empty space for later captions.",
                "Do not include text, Chinese characters, English letters, logos, brand marks, numbers, charts, UI, labels, or watermarks.",
                "Do not show fabricated product features, specifications, performance outcomes, certifications, customer claims, people, or faces.",
                "Do not recreate a specific product unless it is unmistakably visible in the material notes; when uncertain, prefer an abstract environmental scene.",
                "Confirmed script context, for atmosphere only and never as rendered copy: "
                + ("；".join(script_context) or "clean professional product communication"),
                "Visible material notes, for scene mood only and not for factual claims: "
                + ("；".join(fact_context) or "neutral clean indoor environment"),
            )
        )[:4_800]

    @staticmethod
    def _guided_auto_mix_supplemental_image_request_key(
        session_id, script_revision, draft_hash
    ):
        return _stable_id(
            "guided_auto_mix_supplemental_image_request",
            session_id,
            script_revision,
            draft_hash,
            GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROVIDER,
            GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROMPT_VERSION,
        )

    def _guided_auto_mix_supplemental_image_operation_row(self, operation_id):
        row = self.connection.execute(
            "SELECT * FROM guided_auto_mix_supplemental_images_v1 WHERE id = ?",
            (str(operation_id or ""),),
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_not_found",
                "没有找到这张 AI 补图任务。",
            )
        return row

    def _guided_auto_mix_supplemental_image_operation_for_request(
        self, session_id, script_revision, draft_hash
    ):
        return self.connection.execute(
            """
            SELECT * FROM guided_auto_mix_supplemental_images_v1
            WHERE request_key = ?
            """,
            (
                self._guided_auto_mix_supplemental_image_request_key(
                    session_id, script_revision, draft_hash
                ),
            ),
        ).fetchone()

    def _guided_auto_mix_supplemental_image_managed_path(self, row):
        relative = str(row["managed_relative_path"] or "").strip()
        expected_digest = str(row["image_digest"] or "").strip().casefold()
        expected_mime = str(row["mime_type"] or "").strip().casefold()
        if (
            not relative
            or expected_mime
            not in GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MIME_EXTENSIONS
            or not re.fullmatch(r"[a-f0-9]{64}", expected_digest)
            or not _SAFE_OPAQUE_ID.fullmatch(str(row["id"] or ""))
        ):
            return None
        managed_root = (self.data_dir / "guided_auto_mix_supplemental_images").resolve()
        operation_root = (managed_root / str(row["id"])).resolve()
        if self.data_dir not in managed_root.parents or managed_root not in operation_root.parents:
            return None
        try:
            path = (self.data_dir / relative).resolve(strict=True)
            size = path.stat().st_size
        except (OSError, RuntimeError):
            return None
        if (
            operation_root not in path.parents
            or not path.is_file()
            or not 0 < size <= GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MAX_BYTES
            or _supported_image_mime_type(path) != expected_mime
            or not self._file_digest_matches(path, expected_digest)
        ):
            return None
        return path

    def _public_guided_auto_mix_supplemental_image(self, row):
        managed_path = (
            self._guided_auto_mix_supplemental_image_managed_path(row)
            if row["status"] == "completed"
            else None
        )
        status = str(row["status"])
        phase = status
        if status == "submitted":
            phase = "polling" if row["external_task_id"] else "submitting"
        return {
            "operationId": row["id"],
            "sessionId": row["guided_session_id"],
            "scriptRevision": int(row["script_revision"]),
            "draftHash": str(row["draft_hash"]),
            "provider": row["provider"],
            "status": status,
            "phase": phase,
            "errorCode": row["error_code"],
            "estimatedImageCalls": int(row["estimated_calls"]),
            "paidCallPerformed": status
            in {"submitted", "completed", "outcome_unknown"},
            "managedImageId": (
                f"guided_auto_mix_supplemental_image:{row['id']}"
                if managed_path is not None
                else None
            ),
            "imageDigest": row["image_digest"] if managed_path is not None else None,
            "imageMimeType": row["mime_type"] if managed_path is not None else None,
            "imageReady": managed_path is not None,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def _update_guided_auto_mix_supplemental_image_operation(
        self,
        operation_id,
        status,
        *,
        external_task_id=None,
        error_code=None,
        managed_relative_path=None,
        image_digest=None,
        mime_type=None,
    ):
        row = self._guided_auto_mix_supplemental_image_operation_row(operation_id)
        next_status = str(status or "").strip()
        same_status = next_status == row["status"]
        if not same_status and next_status not in (
            GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_TRANSITIONS.get(row["status"], set())
        ):
            raise ContentEngineError(
                "invalid_guided_auto_mix_supplemental_image_transition",
                "AI 补图任务不能切换到该状态。",
            )
        provider_task_id = (
            str(external_task_id or "").strip()[:255]
            or row["external_task_id"]
        )
        safe_error_code = str(error_code or "").strip()[:64] or None
        relative = str(managed_relative_path or "").strip() or None
        digest = str(image_digest or "").strip().casefold() or None
        safe_mime_type = str(mime_type or "").strip().casefold() or None
        if next_status == "completed":
            relative = relative or row["managed_relative_path"]
            digest = digest or row["image_digest"]
            safe_mime_type = safe_mime_type or row["mime_type"]
            if (
                not relative
                or not re.fullmatch(r"[a-f0-9]{64}", str(digest or ""))
                or safe_mime_type
                not in GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MIME_EXTENSIONS
            ):
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_invalid_output",
                    "AI 补图文件校验失败，未将其作为可用结果。",
                )
        else:
            relative = row["managed_relative_path"]
            digest = row["image_digest"]
            safe_mime_type = row["mime_type"]
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE guided_auto_mix_supplemental_images_v1
                SET status = ?, external_task_id = ?, error_code = ?,
                    managed_relative_path = ?, image_digest = ?, mime_type = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    next_status,
                    provider_task_id,
                    safe_error_code,
                    relative,
                    digest,
                    safe_mime_type,
                    self._now(),
                    row["id"],
                ),
            )
        return self._public_guided_auto_mix_supplemental_image(
            self._guided_auto_mix_supplemental_image_operation_row(row["id"])
        )

    def _admit_guided_auto_mix_supplemental_image_submission(self, operation_id):
        """Atomically cross the one-way paid-call boundary exactly once."""
        operation = self._guided_auto_mix_supplemental_image_operation_row(
            operation_id
        )
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE guided_auto_mix_supplemental_images_v1
                SET status = 'submitted', error_code = NULL, updated_at = ?
                WHERE id = ? AND status = 'planned'
                """,
                (self._now(), operation["id"]),
            )
            current = connection.execute(
                """
                SELECT * FROM guided_auto_mix_supplemental_images_v1
                WHERE id = ?
                """,
                (operation["id"],),
            ).fetchone()
        return current, bool(cursor.rowcount)

    def estimate_guided_auto_mix_supplemental_image(
        self, session_id, script_revision, draft_hash
    ):
        """Read the exact paid-image state without admitting a provider call."""
        session, draft, digest = self._validated_guided_auto_mix_supplemental_context(
            session_id, script_revision, draft_hash
        )
        # Building the current prompt during estimation keeps the request-key
        # identity aligned with create, while remaining entirely local/read-only.
        self._guided_auto_mix_supplemental_image_prompt(session, draft)
        operation = self._guided_auto_mix_supplemental_image_operation_for_request(
            session["id"], script_revision, digest
        )
        return {
            "sessionId": session["id"],
            "scriptRevision": script_revision,
            "draftHash": digest,
            "status": operation["status"] if operation is not None else "not_requested",
            "estimatedImageCalls": 1,
            "provider": GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROVIDER,
            "providerConfigured": bool(
                self.cover_client is not None
                and getattr(self.cover_client, "configured", False)
            ),
            "confirmationRequired": True,
            "currentOperation": (
                self._public_guided_auto_mix_supplemental_image(operation)
                if operation is not None
                else None
            ),
        }

    def create_guided_auto_mix_supplemental_image(
        self, session_id, script_revision, draft_hash, confirm_paid_calls
    ):
        if confirm_paid_calls is not True:
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_confirmation_required",
                "请确认本次将调用 1 次 AI 图片服务后再生成补图。",
            )
        if self.cover_client is None or not getattr(self.cover_client, "configured", False):
            raise ContentEngineError(
                "apimart_not_configured", "请先配置 AI 图片服务后再生成补图。"
            )
        session, draft, digest = self._validated_guided_auto_mix_supplemental_context(
            session_id,
            script_revision,
            draft_hash,
            require_snapshot=True,
        )
        prompt = self._guided_auto_mix_supplemental_image_prompt(session, draft)
        request_key = self._guided_auto_mix_supplemental_image_request_key(
            session["id"], script_revision, digest
        )
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO guided_auto_mix_supplemental_images_v1(
                    id, guided_session_id, script_revision, draft_hash,
                    request_key, provider, prompt_version, prompt_hash,
                    prompt_text, status, estimated_calls, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?)
                """,
                (
                    self._new_id("guided_auto_mix_supplemental_image"),
                    session["id"],
                    script_revision,
                    digest,
                    request_key,
                    GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROVIDER,
                    GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_PROMPT_VERSION,
                    _canonical_hash(prompt),
                    prompt,
                    now,
                    now,
                ),
            )
            operation = connection.execute(
                """
                SELECT * FROM guided_auto_mix_supplemental_images_v1
                WHERE request_key = ?
                """,
                (request_key,),
            ).fetchone()
            task_id = _stable_id(
                "task_guided_auto_mix_supplemental_image", operation["id"]
            )
            payload = {
                "operation_id": operation["id"],
                "session_id": session["id"],
                "script_revision": script_revision,
                "draft_hash": digest,
            }
            connection.execute(
                """
                INSERT OR IGNORE INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'guided_auto_mix_supplemental_image', 'queued', ?, ?, ?)
                """,
                (task_id, self._json(payload), now, now),
            )
            task = connection.execute(
                "SELECT * FROM content_tasks WHERE id = ?", (task_id,)
            ).fetchone()
            # A local polling/download interruption can be safely retried with
            # the same provider task ID.  Terminal or unknown admissions never
            # get requeued, so this path can never resubmit a paid request.
            if (
                operation["status"] in {"planned", "submitted"}
                and task["status"] in {"paused", "failed", "cancelled"}
            ):
                connection.execute(
                    """
                    UPDATE content_tasks
                    SET status = 'queued', progress = 0, result_json = NULL,
                        error_code = NULL, error_message = NULL,
                        resume_from_status = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (now, task_id),
                )
        operation = self._guided_auto_mix_supplemental_image_operation_for_request(
            session["id"], script_revision, digest
        )
        task = self._task_row(task_id)
        return {
            **self._public_task(task),
            "operationId": operation["id"],
            "operation": self._public_guided_auto_mix_supplemental_image(operation),
        }

    def get_guided_auto_mix_supplemental_image(self, session_id, script_revision):
        session = self._guided_auto_mix_session_row(session_id)
        revision = self._guided_auto_mix_script_revision(script_revision)
        operation = self.connection.execute(
            """
            SELECT * FROM guided_auto_mix_supplemental_images_v1
            WHERE guided_session_id = ? AND script_revision = ?
            ORDER BY updated_at DESC, rowid DESC LIMIT 1
            """,
            (session["id"], revision),
        ).fetchone()
        return {
            "sessionId": session["id"],
            "scriptRevision": revision,
            "status": operation["status"] if operation is not None else "not_requested",
            "operation": (
                self._public_guided_auto_mix_supplemental_image(operation)
                if operation is not None
                else None
            ),
        }

    def completed_guided_auto_mix_supplemental_image_for_draft(
        self, session_id, script_revision, draft_hash
    ):
        """Return a verified opaque image reference for a future V2 recipe.

        The renderer must resolve this identifier through the dedicated path
        resolver below; it is intentionally not promoted to an imported asset
        or material-evidence record.
        """
        session, _draft, digest = self._validated_guided_auto_mix_supplemental_context(
            session_id, script_revision, draft_hash
        )
        row = self.connection.execute(
            """
            SELECT * FROM guided_auto_mix_supplemental_images_v1
            WHERE guided_session_id = ?
              AND script_revision = ?
              AND draft_hash = ?
              AND status = 'completed'
            ORDER BY updated_at DESC, rowid DESC LIMIT 1
            """,
            (session["id"], script_revision, digest),
        ).fetchone()
        if row is None or self._guided_auto_mix_supplemental_image_managed_path(row) is None:
            return None
        return {
            "operation_id": row["id"],
            "managed_image_id": f"guided_auto_mix_supplemental_image:{row['id']}",
            "image_digest": row["image_digest"],
            "mime_type": row["mime_type"],
            "script_revision": int(row["script_revision"]),
        }

    def resolve_guided_auto_mix_supplemental_image_path(self, operation_id):
        row = self._guided_auto_mix_supplemental_image_operation_row(operation_id)
        if row["status"] != "completed":
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_not_ready",
                "AI 补图尚未准备完成。",
            )
        path = self._guided_auto_mix_supplemental_image_managed_path(row)
        if path is None:
            self._update_guided_auto_mix_supplemental_image_operation(
                row["id"], "completed", error_code="managed_image_invalid"
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_invalid_output",
                "AI 补图文件无法通过完整性校验。",
            )
        return {
            "operation_id": row["id"],
            "absolute_path": str(path),
            "mime_type": row["mime_type"],
        }

    def _run_guided_auto_mix_supplemental_image_task(self, task_id, payload):
        operation_id = str(payload.get("operation_id") or "").strip()
        if not operation_id:
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_task_invalid",
                "AI 补图任务缺少操作标识。",
            )
        self._set_task(task_id, "rendering", progress=0.1)
        result = self.run_guided_auto_mix_supplemental_image(
            operation_id,
            should_stop=lambda: self._should_stop(task_id),
        )
        self._set_task(task_id, "rendering", progress=0.95)
        return result

    def run_guided_auto_mix_supplemental_image(self, operation_id, should_stop=None):
        operation = self._guided_auto_mix_supplemental_image_operation_row(operation_id)
        if operation["status"] == "completed":
            # A completed record is reusable only if its exact managed bytes
            # still validate.  It is never sent to the provider a second time.
            self.resolve_guided_auto_mix_supplemental_image_path(operation["id"])
            return self._public_guided_auto_mix_supplemental_image(operation)
        if operation["status"] in {"failed", "outcome_unknown", "cancelled"}:
            raise ContentEngineError(
                f"guided_auto_mix_supplemental_image_{operation['status']}",
                "AI 补图任务已结束，不能自动再次提交。",
            )
        if self.cover_client is None or not getattr(self.cover_client, "configured", False):
            raise ContentEngineError(
                "apimart_not_configured", "请先配置 AI 图片服务后再生成补图。"
            )
        if operation["status"] == "planned":
            try:
                self._validated_guided_auto_mix_supplemental_context(
                    operation["guided_session_id"],
                    int(operation["script_revision"]),
                    operation["draft_hash"],
                    require_snapshot=True,
                )
            except ContentEngineError as error:
                self._update_guided_auto_mix_supplemental_image_operation(
                    operation["id"], "cancelled", error_code=error.code
                )
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_stale",
                    "脚本或素材已更新，本次 AI 补图未提交。",
                ) from error
            if should_stop is not None and should_stop():
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_interrupted",
                    "AI 补图尚未提交，可在需要时继续当前请求。",
                )
            # Persist this one-way admission before issuing the paid call.  A
            # competing worker that lost this compare-and-set may only poll a
            # provider task already recorded by the winner; it can never call
            # submit itself.
            operation, admitted = (
                self._admit_guided_auto_mix_supplemental_image_submission(
                    operation["id"]
                )
            )
            if not admitted:
                if operation["status"] == "completed":
                    self.resolve_guided_auto_mix_supplemental_image_path(
                        operation["id"]
                    )
                    return self._public_guided_auto_mix_supplemental_image(operation)
                if (
                    operation["status"] == "submitted"
                    and not str(operation["external_task_id"] or "").strip()
                ):
                    raise ContentEngineError(
                        "guided_auto_mix_supplemental_image_submission_inflight",
                        "AI 补图正在提交中；系统不会重复提交。",
                    )
                if operation["status"] != "submitted":
                    raise ContentEngineError(
                        f"guided_auto_mix_supplemental_image_{operation['status']}",
                        "AI 补图任务已结束，不能自动再次提交。",
                    )
            else:
                try:
                    provider_task_id = self.cover_client.submit(
                        str(operation["prompt_text"]), reference_path=None
                    )
                except APIMartOutcomeUnknown as error:
                    self._update_guided_auto_mix_supplemental_image_operation(
                        operation["id"],
                        "outcome_unknown",
                        external_task_id=error.task_id,
                        error_code="submit_outcome_unknown",
                    )
                    raise ContentEngineError(
                        "guided_auto_mix_supplemental_image_outcome_unknown",
                        "AI 补图提交结果未知，系统不会自动重复提交。",
                    ) from error
                except APIMartError as error:
                    self._update_guided_auto_mix_supplemental_image_operation(
                        operation["id"], "failed", error_code="submit_rejected"
                    )
                    raise ContentEngineError(
                        "guided_auto_mix_supplemental_image_submit_failed", str(error)
                    ) from error
                except Exception as error:
                    self._update_guided_auto_mix_supplemental_image_operation(
                        operation["id"], "outcome_unknown", error_code="submit_exception"
                    )
                    raise ContentEngineError(
                        "guided_auto_mix_supplemental_image_outcome_unknown",
                        "AI 补图提交结果未知，系统不会自动重复提交。",
                    ) from error
                self._update_guided_auto_mix_supplemental_image_operation(
                    operation["id"], "submitted", external_task_id=provider_task_id
                )
                operation = self._guided_auto_mix_supplemental_image_operation_row(
                    operation["id"]
                )
        provider_task_id = str(operation["external_task_id"] or "").strip()
        if not provider_task_id:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"], "outcome_unknown", error_code="provider_task_id_missing"
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_outcome_unknown",
                "AI 补图可能已提交，但没有可恢复的服务任务标识。",
            )
        try:
            image_url = self.cover_client.poll(
                provider_task_id, should_stop=should_stop
            )
        except APIMartPollingStopped as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"], "submitted", error_code="poll_interrupted"
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_poll_interrupted",
                "AI 补图查询已在本机停止；再次继续时只会查询原任务。",
            ) from error
        except APIMartOutcomeUnknown as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "outcome_unknown",
                external_task_id=provider_task_id,
                error_code="poll_outcome_unknown",
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_outcome_unknown",
                "AI 补图查询结果未知，系统不会自动重复提交。",
            ) from error
        except APIMartTaskFailed as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "failed",
                external_task_id=provider_task_id,
                error_code="provider_failed",
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_provider_failed", str(error)
            ) from error
        except APIMartError as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "submitted",
                external_task_id=provider_task_id,
                error_code="poll_failed",
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_poll_failed", str(error)
            ) from error
        except Exception as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "outcome_unknown",
                external_task_id=provider_task_id,
                error_code="poll_exception",
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_outcome_unknown",
                "AI 补图查询结果未知，系统不会自动重复提交。",
            ) from error
        if not _SAFE_OPAQUE_ID.fullmatch(str(operation["id"] or "")):
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"], "outcome_unknown", error_code="operation_id_invalid"
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_invalid_output",
                "AI 补图操作标识无效。",
            )
        managed_root = (self.data_dir / "guided_auto_mix_supplemental_images").resolve()
        operation_root = (managed_root / str(operation["id"])).resolve()
        if (
            self.data_dir not in managed_root.parents
            or managed_root not in operation_root.parents
        ):
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"], "outcome_unknown", error_code="managed_path_invalid"
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_invalid_output",
                "AI 补图保存位置校验失败。",
            )
        operation_root.mkdir(parents=True, exist_ok=True)
        downloaded = operation_root / "image.download"
        try:
            self.cover_client.download(image_url, downloaded)
            size = downloaded.stat().st_size
            mime_type = _supported_image_mime_type(downloaded)
            if (
                not 0 < size <= GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MAX_BYTES
                or mime_type not in GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MIME_EXTENSIONS
            ):
                raise ValueError("downloaded supplemental image type is invalid")
            target = operation_root / (
                "image" + GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_MIME_EXTENSIONS[mime_type]
            )
            downloaded.replace(target)
            digest = self._sha256_file(target)
            relative = str(target.relative_to(self.data_dir))
            completed = self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "completed",
                external_task_id=provider_task_id,
                managed_relative_path=relative,
                image_digest=digest,
                mime_type=mime_type,
            )
            # Validate after persistence as well.  This is the same verifier
            # the media-serving resolver uses, so a public completed state
            # cannot silently stand in for a tampered output file.
            self.resolve_guided_auto_mix_supplemental_image_path(operation["id"])
            return completed
        except ContentEngineError:
            raise
        except Exception as error:
            self._update_guided_auto_mix_supplemental_image_operation(
                operation["id"],
                "submitted",
                external_task_id=provider_task_id,
                error_code="download_failed",
            )
            raise ContentEngineError(
                "guided_auto_mix_supplemental_image_download_failed",
                "AI 补图已完成但下载或文件校验失败；再次继续时只会查询原任务。",
            ) from error
        finally:
            downloaded.unlink(missing_ok=True)

    def create_auto_mix_v2(self, request):
        contract = validate_create_auto_mix_v2(request)
        guided_session = None
        guided_supplemental_image = None
        initial_private_state = {}
        if contract["mode"] == "guided":
            guided_session = self._guided_auto_mix_session_row(
                contract["guided_session_id"]
            )
            if guided_session["status"] != "ready_for_render":
                raise ContentEngineError(
                    "guided_auto_mix_script_not_ready",
                    "请先完成 AI 脚本生成并确认当前版本。",
                )
            if not self._guided_auto_mix_snapshot_matches(guided_session):
                self._mark_guided_auto_mix_session_failed(
                    guided_session["id"], "guided_auto_mix_assets_changed"
                )
                raise ContentEngineError(
                    "guided_auto_mix_assets_changed",
                    "素材已变更，请重新解析后再生成成片。",
                )
            draft = self._json_object(guided_session["draft_json"])
            if int(draft.get("revision") or 0) != int(contract["script_revision"]):
                raise ContentEngineError(
                    "guided_auto_mix_script_stale",
                    "脚本已更新，请使用最新脚本版本生成成片。",
                )
            safe_ids = self._guided_auto_mix_asset_ids(guided_session)
            snapshots = self._guided_auto_mix_current_snapshots(guided_session)
            title = self._validate_text(
                str(draft.get("title") or ""), "guided_auto_mix_title", 100
            )
            tracks = normalize_text_tracks(draft.get("text_tracks"))
            duration_plan = self._guided_auto_mix_duration_plan_value(
                draft.get("duration_plan")
            )
            answers = self._json_object(guided_session["answers_json"])
            copy_framework = "；".join(
                str(answers.get(key) or "").strip()
                for key in ("targetScene", "keyMessage", "extraNotes")
                if str(answers.get(key) or "").strip()
            )[:2_400] or "AI 引导脚本"
            initial_private_state = {
                "guided_session_id": guided_session["id"],
                "guided_script_revision": int(contract["script_revision"]),
                "guided_draft_hash": str(guided_session["draft_hash"] or ""),
                "guided_critical_terms": [
                    str(answers.get(key) or "").strip()
                    for key in ("companyName", "productName")
                    if str(answers.get(key) or "").strip()
                ],
                "text_tracks": tracks,
                "duration_plan": duration_plan,
            }
            guided_supplemental_image = (
                self.completed_guided_auto_mix_supplemental_image_for_draft(
                    guided_session["id"],
                    int(contract["script_revision"]),
                    str(guided_session["draft_hash"] or ""),
                )
            )
            if guided_supplemental_image is not None:
                initial_private_state["guided_supplemental_image"] = (
                    guided_supplemental_image
                )
        else:
            safe_ids = self._validate_asset_ids(contract["asset_ids"])
            snapshots = self._auto_mix_asset_snapshots(safe_ids)
            title = contract["title"]
            copy_framework = contract["copy_framework"]
        input_hash = auto_mix_canonical_hash(
            {
                "spec_version": contract["spec_version"],
                "assets": snapshots,
                "title": title,
                "copy_framework": copy_framework,
                "guided_session_id": (
                    str(guided_session["id"]) if guided_session is not None else ""
                ),
                "guided_draft_hash": (
                    str(guided_session["draft_hash"] or "")
                    if guided_session is not None
                    else ""
                ),
                "guided_supplemental_image_digest": (
                    str(guided_supplemental_image.get("image_digest") or "")
                    if guided_supplemental_image is not None
                    else ""
                ),
            }
        )
        existing = self.connection.execute(
            """
            SELECT * FROM auto_mix_runs_v2
            WHERE input_hash = ? AND generation = 1
            ORDER BY created_at, rowid LIMIT 1
            """,
            (input_hash,),
        ).fetchone()
        if existing is not None:
            task = self._public_task(self._task_row(existing["task_id"]))
            return {
                **task,
                "project_id": existing["project_id"],
                "run_id": existing["id"],
                "spec_version": existing["spec_version"],
            }

        project_id = self._new_id("creative_project")
        task_id = self._new_id("task")
        run_id = self._new_id("auto_mix_run")
        now = self._now()
        settings = {
            "workflow": "auto_mix_v2",
            "spec_version": AUTO_MIX_SPEC_VERSION,
            "asset_ids": safe_ids,
            "duration_policy": "guided_auto" if guided_session is not None else "fit_materials",
            "copy_policy": contract["copy_policy"],
            "voice_policy": "tts_only",
            "music_policy": "licensed_auto",
            "output_count": 1,
            "ratio": "9:16",
        }
        if guided_session is not None:
            settings["duration_plan"] = duration_plan
        public_plan = {
            "outputCount": 1,
            "qualityWarnings": [],
            "cache": {"inputHashMatched": False},
            "supplementalImage": {
                "used": bool(guided_supplemental_image),
                "kind": "ai_scene_assist" if guided_supplemental_image else None,
            },
        }
        if guided_session is not None:
            public_plan["durationPlan"] = self._guided_auto_mix_public_duration_plan(
                duration_plan
            )
        payload = {
            "project_id": project_id,
            "run_id": run_id,
            "regeneration_layer": None,
        }
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO creative_projects(
                    id, mode, name, theme, status, settings_json, result_json,
                    created_at, updated_at
                ) VALUES (?, 'mix', ?, ?, 'queued', ?, '{}', ?, ?)
                """,
                (
                    project_id,
                    title,
                    title,
                    self._json(settings),
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'auto_mix_v2_generation', 'queued', ?, ?, ?)
                """,
                (task_id, self._json(payload), now, now),
            )
            connection.execute(
                """
                INSERT INTO auto_mix_runs_v2(
                    id, project_id, task_id, generation, spec_version,
                    input_hash, status, asset_ids_json, title, copy_framework,
                    public_plan_json, private_state_json,
                    quality_warnings_json, created_at, updated_at
                ) VALUES (
                    ?, ?, ?, 1, ?, ?, 'analyzing', ?, ?, ?, ?, ?, '[]', ?, ?
                )
                """,
                (
                    run_id,
                    project_id,
                    task_id,
                    AUTO_MIX_SPEC_VERSION,
                    input_hash,
                    self._json(safe_ids),
                    title,
                    copy_framework,
                    self._json(public_plan),
                    self._json(initial_private_state),
                    now,
                    now,
                ),
            )
        return {
            **self._public_task(self._task_row(task_id)),
            "project_id": project_id,
            "run_id": run_id,
            "spec_version": AUTO_MIX_SPEC_VERSION,
        }

    def get_auto_mix_plan_v2(self, *, project_id=None, run_id=None):
        row = self._auto_mix_run_row(project_id=project_id, run_id=run_id)
        return public_auto_mix_plan(self._auto_mix_run_value(row))

    def _restore_legacy_guided_critical_terms(self, private_state):
        guided_session_id = str(private_state.get("guided_session_id") or "")
        if not guided_session_id or "guided_critical_terms" in private_state:
            return
        guided_session = self.connection.execute(
            """
            SELECT answers_json, draft_json, draft_hash, asset_snapshot_json
            FROM guided_auto_mix_sessions_v1 WHERE id = ?
            """,
            (guided_session_id,),
        ).fetchone()
        locked_hash = str(private_state.get("guided_draft_hash") or "")
        locked_revision = int(private_state.get("guided_script_revision") or 0)
        if guided_session is not None:
            draft = self._json_object(guided_session["draft_json"])
            answers = self._json_object(guided_session["answers_json"])
            confirmed_hash = auto_mix_canonical_hash(
                {
                    "title": draft.get("title"),
                    "answers": answers,
                    "snapshots": self._json_array(
                        guided_session["asset_snapshot_json"]
                    ),
                    "tracks": draft.get("text_tracks"),
                    "duration_plan": draft.get("duration_plan"),
                    "revision": draft.get("revision"),
                }
            )
            if (
                str(guided_session["draft_hash"] or "") == locked_hash
                and int(draft.get("revision") or 0) == locked_revision
                and confirmed_hash == locked_hash
            ):
                private_state["guided_critical_terms"] = [
                    str(answers.get(key) or "").strip()
                    for key in ("companyName", "productName")
                    if str(answers.get(key) or "").strip()
                ]
                return
        raise ContentEngineError(
            "auto_mix_guided_script_required",
            "原确认的公司或产品信息已变化，请返回脚本步骤重新确认后再生成成片。",
        )

    def regenerate_auto_mix_layer(self, project_id, layer, *, expected_run_id=None):
        current = self._auto_mix_run_row(project_id=project_id)
        if expected_run_id is not None and str(expected_run_id) != str(current["id"]):
            raise ContentEngineError(
                "auto_mix_run_stale",
                "任务已有新的处理结果，请刷新到最新步骤后再继续。",
            )
        invalidated = invalidated_stages_for_layer(layer)
        current_plan = self._json_object(current["public_plan_json"])
        current_private = self._json_object(current["private_state_json"])
        self._restore_legacy_guided_critical_terms(current_private)
        attention = current_plan.get("attention")
        recommended_layer = (
            str(attention.get("layer") or "")
            if isinstance(attention, dict)
            else ""
        )
        attention_code = (
            str(attention.get("code") or "")
            if isinstance(attention, dict)
            else ""
        )
        attention_message = (
            str(attention.get("message") or "")
            if isinstance(attention, dict)
            else ""
        )
        legacy_alignment_recovery = bool(
            current["status"] in {"needs_attention", "failed"}
            and recommended_layer == "text"
            and attention_code == AUTO_MIX_LEGACY_ALIGNMENT_CODE
            and attention_message == AUTO_MIX_LEGACY_ALIGNMENT_MESSAGE
        )
        if legacy_alignment_recovery and layer == "text":
            layer = "voice"
            invalidated = invalidated_stages_for_layer(layer)
        reuse_selected_voice = (
            (
                current["status"] in {"needs_attention", "failed"}
                and recommended_layer == "voice"
                and attention_code in AUTO_MIX_REUSE_SELECTED_VOICE_RECOVERY_CODES
                and not bool(current_private.get("voice_recheck_used"))
            )
            or legacy_alignment_recovery
        ) and bool(current["selected_voice_persona_id"])
        if current["status"] == "outcome_unknown":
            if layer != "voice" or recommended_layer != "voice":
                raise ContentEngineError(
                    "auto_mix_outcome_unknown",
                    "上次外部调用结果未知；为避免重复扣费，系统不会自动重提。",
                )
            reconciliation = self._reconcile_unknown_auto_mix_voices()
            alternate = self._approved_auto_mix_voice_persona(
                excluded_id=str(current["selected_voice_persona_id"] or "")
            )
            if alternate is None and reconciliation["status"] != "retry_allowed":
                raise ContentEngineError(
                    "auto_mix_alternate_voice_required",
                    "尚未查到唯一可用的配音结果，请稍后再查询。",
                )
        if current["status"] not in {"completed", "needs_attention", "failed"}:
            if current["status"] != "outcome_unknown":
                raise ContentEngineError(
                    "auto_mix_regeneration_unavailable",
                    "当前一键混剪仍在运行，不能同时创建局部重做任务。",
                )
        if (
            current["status"] != "completed"
            and recommended_layer
            and recommended_layer != layer
            and not legacy_alignment_recovery
        ):
            raise ContentEngineError(
                "auto_mix_recovery_layer_mismatch",
                "请按当前质量提示恢复对应内容层。",
            )
        next_generation = int(current["generation"]) + 1
        task_id = self._new_id("task")
        run_id = self._new_id("auto_mix_run")
        now = self._now()
        if layer == "text" and current_private.get("guided_session_id"):
            raise ContentEngineError(
                "auto_mix_guided_script_required",
                "这条成片使用了已确认的引导脚本，请返回脚本步骤重新生成后再成片。",
            )
        public_plan = json.loads(self._json(current_plan))
        private_state = json.loads(self._json(current_private))
        next_voice_persona_id = current["selected_voice_persona_id"]
        next_music_track_id = current["selected_music_track_id"]
        for field in ("qualityReport", "generatedVideoId", "attention"):
            public_plan.pop(field, None)
        if layer == "text":
            for field in ("spokenPhrases", "speechCaptions", "visualTextItems"):
                public_plan.pop(field, None)
            for field in (
                "text_tracks",
                "phrase_audio",
                "voice_audio_path",
                "voice_audio_digest",
            ):
                private_state.pop(field, None)
            next_state = "planned"
        elif layer == "voice":
            public_plan.pop("speechCaptions", None)
            public_plan.pop("voicePersona", None)
            for field in ("phrase_audio", "voice_audio_path", "voice_audio_digest"):
                private_state.pop(field, None)
            if reuse_selected_voice:
                private_state.pop("excluded_voice_persona_id", None)
                private_state["voice_recheck_used"] = True
            else:
                private_state["excluded_voice_persona_id"] = str(
                    current["selected_voice_persona_id"] or ""
                )
                next_voice_persona_id = None
            next_state = "synthesizing"
        else:
            public_plan.pop("music", None)
            for field in ("music_track", "licensed_music_relative_path"):
                private_state.pop(field, None)
            private_state["excluded_music_track_id"] = str(
                current["selected_music_track_id"] or ""
            )
            next_music_track_id = None
            next_state = "selecting_music"
        public_plan["cache"] = {
            **(
                public_plan.get("cache")
                if isinstance(public_plan.get("cache"), dict)
                else {}
            ),
            "regeneratedLayer": layer,
            "invalidatedStages": list(invalidated),
        }
        payload = {
            "project_id": project_id,
            "run_id": run_id,
            "regeneration_layer": layer,
        }
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'auto_mix_v2_regeneration', 'queued', ?, ?, ?)
                """,
                (task_id, self._json(payload), now, now),
            )
            connection.execute(
                """
                INSERT INTO auto_mix_runs_v2(
                    id, project_id, task_id, parent_run_id, generation,
                    spec_version, input_hash, status, asset_ids_json, title,
                    copy_framework, public_plan_json, private_state_json,
                    quality_warnings_json, selected_voice_persona_id,
                    selected_music_track_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    project_id,
                    task_id,
                    current["id"],
                    next_generation,
                    current["spec_version"],
                    current["input_hash"],
                    next_state,
                    current["asset_ids_json"],
                    current["title"],
                    current["copy_framework"],
                    self._json(public_plan),
                    self._json(private_state),
                    current["quality_warnings_json"],
                    next_voice_persona_id,
                    next_music_track_id,
                    now,
                    now,
                ),
            )
            for artifact in connection.execute(
                """
                SELECT * FROM auto_mix_stage_artifacts_v2
                WHERE run_id = ? AND status = 'completed'
                ORDER BY created_at, rowid
                """,
                (current["id"],),
            ).fetchall():
                if artifact["stage"] in invalidated:
                    continue
                connection.execute(
                    """
                    INSERT INTO auto_mix_stage_artifacts_v2(
                        id, run_id, stage, cache_key, status, relative_path,
                        public_metadata_json, private_metadata_json,
                        external_task_id, revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        self._new_id("auto_mix_artifact"),
                        run_id,
                        artifact["stage"],
                        artifact["cache_key"],
                        artifact["relative_path"],
                        artifact["public_metadata_json"],
                        artifact["private_metadata_json"],
                        artifact["external_task_id"],
                        artifact["revision"],
                        now,
                        now,
                    ),
                )
        return {
            **self._public_task(self._task_row(task_id)),
            "project_id": project_id,
            "run_id": run_id,
            "spec_version": current["spec_version"],
        }

    def _auto_mix_run_row(self, *, project_id=None, run_id=None):
        if run_id:
            row = self.connection.execute(
                "SELECT * FROM auto_mix_runs_v2 WHERE id = ?", (str(run_id),)
            ).fetchone()
        elif project_id:
            self._project_row(str(project_id))
            row = self.connection.execute(
                """
                SELECT * FROM auto_mix_runs_v2
                WHERE project_id = ?
                ORDER BY generation DESC, created_at DESC, rowid DESC LIMIT 1
                """,
                (str(project_id),),
            ).fetchone()
        else:
            raise ContentEngineError(
                "auto_mix_run_id_required", "请提供 V2 项目或运行标识。"
            )
        if row is None:
            raise ContentEngineError(
                "auto_mix_run_not_found", "没有找到对应的一键混剪 V2 运行记录。"
            )
        return row

    @staticmethod
    def _json_object(value):
        try:
            parsed = json.loads(value or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _json_array(value):
        try:
            parsed = json.loads(value or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        return parsed if isinstance(parsed, list) else []

    def _auto_mix_run_value(self, row):
        plan = self._json_object(row["public_plan_json"])
        warnings = []
        try:
            parsed = json.loads(row["quality_warnings_json"] or "[]")
            warnings = parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            warnings = []
        plan.setdefault("qualityWarnings", sanitize_public_value(warnings))
        return {
            "run_id": row["id"],
            "project_id": row["project_id"],
            "task_id": row["task_id"],
            "parent_run_id": row["parent_run_id"],
            "generation": row["generation"],
            "spec_version": row["spec_version"],
            "status": row["status"],
            "input_asset_ids": self._json_array(row["asset_ids_json"]),
            "public_plan": plan,
            "private_state": self._json_object(row["private_state_json"]),
        }

    def _save_auto_mix_run(
        self,
        run_id,
        *,
        status=None,
        public_plan=None,
        private_state=None,
        warnings=None,
        voice_persona_id=None,
        music_track_id=None,
        generated_video_id=None,
    ):
        assignments = ["updated_at = ?"]
        values = [self._now()]
        if status is not None:
            assignments.append("status = ?")
            values.append(status)
        if public_plan is not None:
            assignments.append("public_plan_json = ?")
            values.append(self._json(public_plan))
        if private_state is not None:
            assignments.append("private_state_json = ?")
            values.append(self._json(private_state))
        if warnings is not None:
            assignments.append("quality_warnings_json = ?")
            values.append(self._json(warnings))
        if voice_persona_id is not None:
            assignments.append("selected_voice_persona_id = ?")
            values.append(voice_persona_id or None)
        if music_track_id is not None:
            assignments.append("selected_music_track_id = ?")
            values.append(music_track_id or None)
        if generated_video_id is not None:
            assignments.append("generated_video_id = ?")
            values.append(generated_video_id or None)
        values.append(run_id)
        self.connection.execute(
            f"UPDATE auto_mix_runs_v2 SET {', '.join(assignments)} WHERE id = ?",
            values,
        )
        if status is not None:
            row = self._auto_mix_run_row(run_id=run_id)
            project_status = (
                "completed"
                if status == "completed"
                else "failed"
                if status == "failed"
                else "paused"
                if status in {"needs_attention", "outcome_unknown"}
                else "rendering"
                if status in {"rendering", "quality_check"}
                else "analyzing"
            )
            self._update_project(row["project_id"], project_status)

    def _fail_auto_mix_run(self, run_id, error_code):
        if not run_id:
            return
        try:
            row = self._auto_mix_run_row(run_id=run_id)
        except ContentEngineError:
            return
        if row["status"] in {"completed", "needs_attention", "outcome_unknown"}:
            return
        public_plan = self._json_object(row["public_plan_json"])
        safe_code = str(error_code or "auto_mix_failed")[:64]
        public_plan["attention"] = {
            "code": safe_code,
            "message": "一键混剪未通过正式成片闸门。",
            "layer": self._auto_mix_attention_layer(safe_code),
        }
        self._save_auto_mix_run(
            run_id, status="failed", public_plan=public_plan
        )

    def _pause_auto_mix(
        self, task_id, run_id, *, state, code, message, public_plan, private_state
    ):
        safe_code = str(code)[:64]
        public_plan["attention"] = {
            "code": safe_code,
            "message": str(message)[:240],
            "layer": self._auto_mix_attention_layer(safe_code),
        }
        self._save_auto_mix_run(
            run_id,
            status=state,
            public_plan=public_plan,
            private_state=private_state,
        )
        self.connection.execute(
            """
            UPDATE content_tasks
            SET resume_from_status = status, status = 'paused',
                error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
            """,
            (safe_code, redact_text(str(message))[:500], self._now(), task_id),
        )
        return public_auto_mix_plan(
            self._auto_mix_run_value(self._auto_mix_run_row(run_id=run_id))
        )

    @staticmethod
    def _auto_mix_attention_layer(error_code):
        code = str(error_code or "").lower()
        if any(
            token in code
            for token in ("music", "license", "loudness", "true_peak")
        ):
            return "music"
        if any(token in code for token in ("voice", "tts", "transcription", "asr")):
            return "voice"
        if any(token in code for token in ("text", "copy", "caption")):
            return "text"
        if code in {
            "auto_mix_material_too_short",
            "auto_mix_material_evidence_too_short",
            "auto_mix_material_facts_insufficient",
        }:
            return "text"
        return None

    def _run_auto_mix_v2(self, task_id, payload):
        run_id = str(payload.get("run_id") or "")
        row = self._auto_mix_run_row(run_id=run_id)
        if row["task_id"] != task_id:
            raise ContentEngineError(
                "auto_mix_task_mismatch", "V2 运行记录与任务不一致。"
            )
        public_plan = self._json_object(row["public_plan_json"])
        private_state = self._json_object(row["private_state_json"])
        if row["status"] == "completed":
            return public_auto_mix_plan(self._auto_mix_run_value(row))
        if row["status"] == "outcome_unknown":
            previous_attention = public_plan.get("attention")
            previous_code = (
                str(previous_attention.get("code") or "")
                if isinstance(previous_attention, dict)
                else ""
            )
            previous_message = (
                str(previous_attention.get("message") or "")
                if isinstance(previous_attention, dict)
                else ""
            )
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="outcome_unknown",
                code=previous_code or "auto_mix_outcome_unknown",
                message=previous_message
                or "上次外部调用结果未知；系统不会自动重复提交。",
                public_plan=public_plan,
                private_state=private_state,
            )

        public_plan, private_state = self._ensure_auto_mix_planned(
            task_id, row, public_plan, private_state
        )
        if not self._auto_mix_analysis_timeline(public_plan, private_state):
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="auto_mix_material_unavailable",
                message="没有足够的合格素材区间可用于成片。",
                public_plan=public_plan,
                private_state=private_state,
            )
        if not (
            (private_state.get("text_tracks") or {}).get("spoken_phrases")
        ):
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="auto_mix_material_facts_insufficient",
                message="所选素材缺少可核验的画面说明、标签、镜头类型或文本，无法生成可信口播。",
                public_plan=public_plan,
                private_state=private_state,
            )

        excluded_persona_id = str(
            private_state.get("excluded_voice_persona_id") or ""
        )
        persona = self._approved_auto_mix_voice_persona(
            selected_id=row["selected_voice_persona_id"],
            excluded_id=excluded_persona_id,
        )
        if persona is None:
            try:
                persona = self._auto_prepare_default_voice_persona(
                    selected_id=row["selected_voice_persona_id"],
                    excluded_id=excluded_persona_id,
                )
            except ContentEngineError as error:
                unknown = error.code in {
                    "auto_mix_voice_design_outcome_unknown",
                    "auto_mix_voice_preview_outcome_unknown",
                }
                return self._pause_auto_mix(
                    task_id,
                    run_id,
                    state="outcome_unknown" if unknown else "needs_attention",
                    code=error.code,
                    message=error.message,
                    public_plan=public_plan,
                    private_state=private_state,
                )
        if persona is None:
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="auto_mix_voice_persona_approval_required",
                message="请先试听并批准一个 CosyVoice 3.5 Plus 人声模板。",
                public_plan=public_plan,
                private_state=private_state,
            )
        public_plan["voicePersona"] = self._public_voice_persona(persona)
        self._save_auto_mix_run(
            run_id,
            status="synthesizing",
            public_plan=public_plan,
            private_state=private_state,
            voice_persona_id=persona["id"],
        )

        try:
            voice_bundle = self._auto_mix_voice_bundle(
                task_id, row, persona, public_plan, private_state
            )
        except ContentEngineError as error:
            if error.code == "auto_mix_voice_outcome_unknown":
                return self._pause_auto_mix(
                    task_id,
                    run_id,
                    state="outcome_unknown",
                    code=error.code,
                    message=error.message,
                    public_plan=public_plan,
                    private_state=private_state,
                )
            if error.code in {
                "auto_mix_material_evidence_missing",
                "auto_mix_voice_verification_unavailable",
                "auto_mix_voice_verification_failed",
                "auto_mix_material_too_short",
                "auto_mix_material_evidence_too_short",
            }:
                return self._pause_auto_mix(
                    task_id,
                    run_id,
                    state="needs_attention",
                    code=error.code,
                    message=error.message,
                    public_plan=public_plan,
                    private_state=private_state,
                )
            raise

        if private_state.get("narrated_batch_v1"):
            from .narrated_batch import NarratedBatchDomain
            NarratedBatchDomain(self).validate_actual_timeline(private_state, voice_bundle["timeline"])
        public_plan.update(
            {
                "spokenPhrases": voice_bundle["phrases"],
                "speechCaptions": voice_bundle["captions"],
                "selectedDurationMs": voice_bundle["duration_ms"],
                "selectedSegments": voice_bundle["timeline"]["selected_segments"],
                "visualTextItems": voice_bundle["text_tracks"][
                    "visual_text_items"
                ],
            }
        )
        final_transitions = [
            item.get("timeline_start_ms")
            for item in voice_bundle["timeline"].get("selected_segments") or []
        ]
        public_plan["musicBrief"] = build_music_brief(
            title=row["title"],
            copy_framework=row["copy_framework"],
            transition_points_ms=final_transitions,
            material_signals=voice_bundle["timeline"].get("selected_segments")
            or [],
        )
        private_state.update(
            {
                "phrase_audio": voice_bundle["phrase_audio"],
                "voice_audio_path": voice_bundle["relative_path"],
                "voice_audio_digest": voice_bundle["audio_digest"],
                "material_timeline": voice_bundle["timeline"],
                "text_tracks": voice_bundle["text_tracks"],
                "evidence_facts": voice_bundle["text_tracks"][
                    "evidence_facts"
                ],
            }
        )
        self._save_auto_mix_run(
            run_id,
            status="selecting_music",
            public_plan=public_plan,
            private_state=private_state,
        )

        music = self._reusable_auto_mix_music(
            private_state,
            public_plan.get("musicBrief") or {},
            required_duration_ms=voice_bundle["duration_ms"],
        )
        music_reused = music is not None
        if music is None:
            music = self._select_auto_mix_music(
                public_plan.get("musicBrief") or {},
                required_duration_ms=voice_bundle["duration_ms"],
                excluded_id=str(private_state.get("excluded_music_track_id") or ""),
                allowed_track_ids=private_state.get("music_track_ids"),
                prefer_unused_track_ids=private_state.get("used_music_track_ids") or [],
            )
        if music is None:
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="narrated_music_pool_empty" if private_state.get("music_track_ids") == [] else "auto_mix_licensed_music_required",
                message="请先试听并选入至少一首可导出的配乐。" if private_state.get("music_track_ids") == [] else "选定配乐库中没有授权有效且适配本条时长的音乐。",
                public_plan=public_plan,
                private_state=private_state,
            )
        public_plan["music"] = music["public"]
        private_state["music_track"] = {
            "track_id": music["track_id"],
            "managed_relative_path": music["managed_relative_path"],
            "integrated_lufs": music.get("integrated_lufs"),
            "true_peak_dbtp": music.get("true_peak_dbtp"),
            "loop_start_ms": music.get("loop_start_ms"),
            "loop_end_ms": music.get("loop_end_ms"),
        }
        selection_key = auto_mix_canonical_hash(
            {
                "stage": "music_selection",
                "brief": public_plan.get("musicBrief") or {},
                "required_duration_ms": voice_bundle["duration_ms"],
                "track_id": music["track_id"],
            }
        )
        self._record_auto_mix_artifact(
            run_id,
            "music_selection",
            selection_key,
            "completed",
            public_metadata={
                "track": music["public"],
                "cacheHit": music_reused,
            },
            private_metadata={
                "managed_relative_path": music["managed_relative_path"]
            },
        )
        public_plan["cache"] = {
            **(
                public_plan.get("cache")
                if isinstance(public_plan.get("cache"), dict)
                else {}
            ),
            "musicReused": music_reused,
        }
        recipe = self._auto_mix_recipe(
            row,
            public_plan,
            private_state,
            persona=persona,
            music=music,
        )
        signature = auto_mix_canonical_hash(
            {
                "run": row["input_hash"],
                "generation": row["generation"],
                "recipe": recipe,
            }
        )
        generated_id = self._insert_generated(
            row["project_id"],
            task_id,
            "mix",
            recipe,
            {
                "total": round(
                    100
                    * sum(
                        float(item.get("quality_score") or 0)
                        for item in voice_bundle["timeline"]["selected_segments"]
                    )
                    / max(1, len(voice_bundle["timeline"]["selected_segments"])),
                    3,
                ),
                "contract": "auto_mix_v2",
            },
            row["title"],
            voice_bundle["duration_ms"],
            recommended=True,
            signature=signature,
            generation=int(row["generation"]),
        )
        public_plan["generatedVideoId"] = generated_id
        self._save_auto_mix_run(
            run_id,
            status="rendering",
            public_plan=public_plan,
            private_state=private_state,
            music_track_id=music["track_id"],
            generated_video_id=generated_id,
        )
        self._set_task(task_id, "rendering", progress=0.86)
        rendered = self._render_generated(generated_id, task_id=task_id)
        if not rendered:
            return public_auto_mix_plan(
                self._auto_mix_run_value(self._auto_mix_run_row(run_id=run_id))
            )
        self._save_auto_mix_run(run_id, status="quality_check")
        if not self._valid_managed_wav(
            voice_bundle["relative_path"],
            voice_bundle["audio_digest"],
            expected_duration_ms=voice_bundle["duration_ms"],
        ):
            self.connection.execute(
                """
                UPDATE generated_videos
                SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    "auto_mix_voice_cache_changed",
                    "已核验的配音在正式完成前发生变化。",
                    self._now(),
                    generated_id,
                ),
            )
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="auto_mix_voice_cache_changed",
                message="已核验的配音发生变化，请重新生成声音。",
                public_plan=public_plan,
                private_state=private_state,
            )
        current_music = self._reusable_auto_mix_music(
            private_state,
            public_plan.get("musicBrief") or {},
            required_duration_ms=voice_bundle["duration_ms"],
        )
        if current_music is None or current_music["track_id"] != music["track_id"]:
            self.connection.execute(
                """
                UPDATE generated_videos
                SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    "auto_mix_music_authorization_changed",
                    "授权音乐在正式完成前已失效。",
                    self._now(),
                    generated_id,
                ),
            )
            return self._pause_auto_mix(
                task_id,
                run_id,
                state="needs_attention",
                code="auto_mix_music_authorization_changed",
                message="授权音乐在正式完成前已失效，请重新选择音乐。",
                public_plan=public_plan,
                private_state=private_state,
            )
        generated = self._generated_row(generated_id)
        persisted_recipe = self._json_object(generated["recipe_json"])
        validate_formal_recipe(persisted_recipe)
        quality_report = validate_quality_report(
            persisted_recipe.get("audio_quality_report")
        )
        public_plan["qualityReport"] = quality_report
        public_plan.pop("attention", None)
        public_plan["cache"] = {
            **(
                public_plan.get("cache")
                if isinstance(public_plan.get("cache"), dict)
                else {}
            ),
            "analysisReused": bool(private_state.get("analysis_reused")),
            "ttsPhraseCount": len(voice_bundle["phrase_audio"]),
        }
        self._save_auto_mix_run(
            run_id,
            status="completed",
            public_plan=public_plan,
            private_state=private_state,
        )
        return public_auto_mix_plan(
            self._auto_mix_run_value(self._auto_mix_run_row(run_id=run_id))
        )

    @staticmethod
    def _auto_mix_analysis_timeline(public_plan, private_state):
        analysis_timeline = private_state.get("analysis_material_timeline")
        if isinstance(analysis_timeline, dict):
            return analysis_timeline
        legacy_timeline = private_state.get("material_timeline")
        if not isinstance(legacy_timeline, dict):
            return None
        cache = (
            public_plan.get("cache")
            if isinstance(public_plan.get("cache"), dict)
            else {}
        )
        legacy_may_be_aligned = bool(
            private_state.get("voice_audio_path")
            or public_plan.get("speechCaptions")
            or cache.get("regeneratedLayer")
        )
        if legacy_may_be_aligned:
            return None
        private_state["analysis_material_timeline"] = legacy_timeline
        return legacy_timeline

    @staticmethod
    def _invalidate_auto_mix_after_analysis_drift(public_plan, private_state):
        for field in (
            "analysis_material_timeline",
            "material_timeline",
            "evidence_facts",
            "text_tracks",
            "phrase_audio",
            "voice_audio_path",
            "voice_audio_digest",
            "music_track",
            "licensed_music_relative_path",
            "analysis_reused",
        ):
            private_state.pop(field, None)
        for field in (
            "usableMaterialDurationMs",
            "estimatedDurationRangeMs",
            "selectedDurationMs",
            "selectedSegments",
            "spokenPhrases",
            "speechCaptions",
            "visualTextItems",
            "musicBrief",
            "voicePersona",
            "music",
            "qualityReport",
            "generatedVideoId",
            "attention",
        ):
            public_plan.pop(field, None)
        cache = (
            dict(public_plan.get("cache"))
            if isinstance(public_plan.get("cache"), dict)
            else {}
        )
        for field in ("analysisReused", "ttsPhraseCount", "musicReused"):
            cache.pop(field, None)
        public_plan["cache"] = cache

    def _ensure_auto_mix_planned(
        self, task_id, row, public_plan, private_state
    ):
        if private_state.get("narrated_batch_v1"):
            from .narrated_batch import NarratedBatchDomain
            NarratedBatchDomain(self).validate_pinned_plan(private_state)
            return public_plan, private_state
        warnings = list(public_plan.get("qualityWarnings") or [])
        asset_ids = json.loads(row["asset_ids_json"] or "[]")
        analysis_profile = self._auto_mix_v2_analysis_profile()
        asset_rows = {asset_id: self._asset_row(asset_id) for asset_id in asset_ids}
        analysis_inputs = [
            {
                "asset_id": asset_id,
                "fingerprint": str(
                    asset_rows[asset_id]["full_fingerprint"]
                    or asset_rows[asset_id]["fingerprint"]
                    or ""
                ),
                "duration_ms": int(asset_rows[asset_id]["duration_ms"] or 0),
                "media_kind": str(asset_rows[asset_id]["media_kind"] or ""),
            }
            for asset_id in asset_ids
        ]
        version_for = getattr(self.analyzer, "analysis_version_for", None)
        current_versions = {}
        unresolved_versions = set()
        for asset_id in asset_ids:
            expected_version = ""
            if callable(version_for):
                try:
                    expected_version = str(
                        version_for(asset_rows[asset_id], analysis_profile) or ""
                    )
                except (ContentEngineError, TypeError, ValueError, RuntimeError):
                    expected_version = ""
            current_versions[asset_id] = expected_version
            if not expected_version:
                unresolved_versions.add(asset_id)
        stored_versions = (
            private_state.get("analysis_versions")
            if isinstance(private_state.get("analysis_versions"), dict)
            else {}
        )
        stored_versions = {
            str(asset_id): str(version or "")
            for asset_id, version in stored_versions.items()
        }
        expected_config_hash = auto_mix_canonical_hash(
            {
                "assets": analysis_inputs,
                "profile": analysis_profile,
                "analysis_versions": current_versions,
            }
        )
        timeline = self._auto_mix_analysis_timeline(public_plan, private_state)
        timeline_is_current = (
            isinstance(timeline, dict)
            and not unresolved_versions
            and stored_versions == current_versions
            and str(private_state.get("analysis_config_hash") or "")
            == expected_config_hash
        )
        rebuild_timeline = not timeline_is_current
        force_analysis = set(unresolved_versions)
        if isinstance(timeline, dict) and not timeline_is_current:
            force_analysis.update(asset_ids)
            self._invalidate_auto_mix_after_analysis_drift(
                public_plan, private_state
            )
            timeline = None
        if rebuild_timeline:
            stale_warning_codes = {
                "auto_mix_assets_skipped",
                "auto_mix_material_facts_insufficient",
                "auto_mix_copy_shortened_to_materials",
                "auto_mix_copy_shortened_before_tts",
                "auto_mix_copy_shortened_after_tts",
            }
            warnings = [
                item
                for item in warnings
                if not isinstance(item, dict)
                or item.get("code") not in stale_warning_codes
            ]
            skipped = []
            analysis_reused = True
            analysis_versions = {}
            for index, asset_id in enumerate(asset_ids):
                expected_version = current_versions[asset_id]
                analysis_versions[asset_id] = expected_version
                segment_count = (
                    self.connection.execute(
                        """
                        SELECT COUNT(*) FROM media_segments
                        WHERE asset_id = ? AND analysis_version = ?
                        """,
                        (asset_id, expected_version),
                    ).fetchone()[0]
                    if expected_version and asset_id not in force_analysis
                    else 0
                )
                if asset_id in force_analysis or not segment_count:
                    analysis_reused = False
                    try:
                        analyzed_version = self._analyze_asset(
                            task_id,
                            asset_id,
                            analysis_profile,
                            return_analysis_version=True,
                        )
                        if not analyzed_version:
                            raise ContentEngineError(
                                "analysis_failed",
                                "素材分析没有返回明确的分析版本。",
                            )
                        analyzed_version = str(analyzed_version)
                        if expected_version and analyzed_version != expected_version:
                            raise ContentEngineError(
                                "analysis_failed",
                                "素材分析返回版本与当前配置不一致。",
                            )
                        analysis_versions[asset_id] = analyzed_version
                        segment_count = self.connection.execute(
                            """
                            SELECT COUNT(*) FROM media_segments
                            WHERE asset_id = ? AND analysis_version = ?
                            """,
                            (asset_id, analyzed_version),
                        ).fetchone()[0]
                        if not segment_count:
                            raise ContentEngineError(
                                "analysis_failed",
                                "素材分析没有生成当前版本的可用片段。",
                            )
                    except ContentEngineError as error:
                        analysis_versions[asset_id] = ""
                        if error.code not in PRODUCT_SKIPPABLE_ANALYSIS_ERRORS:
                            raise
                        skipped.append(
                            {
                                "assetId": asset_id,
                                "errorCode": error.code,
                            }
                        )
                self._set_task(
                    task_id,
                    "analyzing",
                    progress=0.35 * (index + 1) / max(1, len(asset_ids)),
                )
            cards = self._auto_mix_asset_cards(
                asset_ids, analysis_versions=analysis_versions
            )
            timeline = build_material_timeline(cards)
            private_state["analysis_material_timeline"] = timeline
            private_state["material_timeline"] = timeline
            private_state["analysis_reused"] = analysis_reused
            private_state["analysis_versions"] = analysis_versions
            private_state["analysis_config_hash"] = auto_mix_canonical_hash(
                {
                    "assets": analysis_inputs,
                    "profile": analysis_profile,
                    "analysis_versions": analysis_versions,
                }
            )
            self._record_auto_mix_artifact(
                row["id"],
                "analysis",
                auto_mix_canonical_hash(
                    {
                        "assets": asset_ids,
                        "analysis_versions": analysis_versions,
                        "analysis_config_hash": private_state[
                            "analysis_config_hash"
                        ],
                        "timeline": timeline,
                    }
                ),
                "completed",
                public_metadata={
                    "reused": analysis_reused,
                    "usableMaterialDurationMs": int(
                        timeline.get("usable_material_duration_ms") or 0
                    ),
                },
            )
            if skipped:
                warnings.append(
                    {
                        "code": "auto_mix_assets_skipped",
                        "count": len(skipped),
                    }
                )
        evidence_facts = private_state.get("evidence_facts")
        if not isinstance(evidence_facts, list):
            evidence_facts = build_material_evidence_facts(timeline)
            private_state["evidence_facts"] = evidence_facts
        text_tracks = private_state.get("text_tracks")
        legacy_framework_track = isinstance(text_tracks, dict) and any(
            "copyFramework" in (item.get("evidenceRefs") or [])
            for item in text_tracks.get("spoken_phrases") or []
            if isinstance(item, dict)
        )
        if not isinstance(text_tracks, dict) or legacy_framework_track:
            if evidence_facts:
                text_tracks = build_grounded_text_tracks(
                    title=row["title"],
                    copy_framework=row["copy_framework"],
                    evidence_facts=evidence_facts,
                    generation=int(row["generation"] or 1),
                )
            else:
                text_tracks = {
                    "spoken_phrases": [],
                    "visual_text_items": [],
                    "evidence_facts": [],
                }
                warnings.append(
                    {"code": "auto_mix_material_facts_insufficient"}
                )
            phrases = []
            estimate = 0
            material_ms = int(timeline.get("selected_duration_ms") or 0)
            for phrase in text_tracks["spoken_phrases"]:
                phrase_estimate = max(650, len(phrase["text"]) * 260)
                extra = phrase_estimate + (160 if phrases else 0)
                if phrases and estimate + extra > material_ms:
                    break
                phrases.append(phrase)
                estimate += extra
            if phrases:
                if len(phrases) < len(text_tracks["spoken_phrases"]):
                    warnings.append(
                        {"code": "auto_mix_copy_shortened_to_materials"}
                    )
                text_tracks["spoken_phrases"] = phrases
            private_state["text_tracks"] = text_tracks
            self._record_auto_mix_artifact(
                row["id"],
                "text",
                auto_mix_canonical_hash(
                    {
                        "title": row["title"],
                        "framework_structure": row["copy_framework"],
                        "evidence_facts": evidence_facts,
                        "generation": int(row["generation"] or 1),
                        "tracks": text_tracks,
                    }
                ),
                "completed",
                public_metadata={
                    "spokenPhraseCount": len(
                        text_tracks.get("spoken_phrases") or []
                    )
                },
            )
        transitions = [
            item.get("timeline_start_ms")
            for item in timeline.get("selected_segments") or []
        ]
        public_plan.update(
            {
                "usableMaterialDurationMs": int(
                    timeline.get("usable_material_duration_ms") or 0
                ),
                "estimatedDurationRangeMs": timeline.get(
                    "estimated_duration_range_ms"
                )
                or {"min": 0, "max": 0},
                "selectedDurationMs": int(
                    timeline.get("selected_duration_ms") or 0
                ),
                "selectedSegments": timeline.get("selected_segments") or [],
                "spokenPhrases": text_tracks.get("spoken_phrases") or [],
                "speechCaptions": public_plan.get("speechCaptions") or [],
                "visualTextItems": text_tracks.get("visual_text_items") or [],
                "musicBrief": build_music_brief(
                    title=row["title"],
                    copy_framework=row["copy_framework"],
                    transition_points_ms=transitions,
                    material_signals=timeline.get("selected_segments") or [],
                ),
                "qualityWarnings": warnings,
                "outputCount": 1,
            }
        )
        public_plan.pop("attention", None)
        self._save_auto_mix_run(
            row["id"],
            status="planned",
            public_plan=public_plan,
            private_state=private_state,
            warnings=warnings,
        )
        return public_plan, private_state

    def _auto_mix_asset_cards(self, asset_ids, *, analysis_versions=None):
        cards = []
        versions = analysis_versions if isinstance(analysis_versions, dict) else {}
        for asset_id in asset_ids:
            asset = self._asset_row(asset_id)
            intervals = []
            expected_version = str(versions.get(asset_id) or "")
            if expected_version:
                rows = self.connection.execute(
                    """
                    SELECT * FROM media_segments
                    WHERE asset_id = ? AND analysis_version = ?
                    ORDER BY start_ms, end_ms
                    """,
                    (asset_id, expected_version),
                ).fetchall()
            else:
                rows = []
            for segment in rows:
                metadata = self._json_object(segment["metadata_json"])
                try:
                    tags = json.loads(segment["tags_json"] or "[]")
                except (TypeError, ValueError):
                    tags = []
                if not isinstance(tags, list):
                    tags = []
                role = str(segment["role"] or "process")
                if role not in ROLE_ORDER:
                    role = "process"
                visual_signal_status = str(
                    metadata.get("visual_signal_status") or ""
                ).strip()
                # An explicit null signature means the measured window did not
                # have enough evidence for a stable sequence signature.  Do not
                # turn a single perceptual hash into a cross-asset duplicate key.
                if "content_signature" in metadata:
                    signature_seed = metadata.get("content_signature") or ""
                else:
                    signature_seed = (
                        metadata.get("perceptual_hash")
                        or metadata.get("frame_digest")
                        or ""
                    )

                def visual_state(key):
                    value = metadata.get(key)
                    return value if isinstance(value, bool) else None

                intervals.append(
                    {
                        "usable": visual_signal_status == "measured",
                        "start_ms": max(0, int(segment["start_ms"] or 0)),
                        "end_ms": min(
                            int(asset["duration_ms"] or segment["end_ms"] or 0),
                            int(segment["end_ms"] or 0),
                        ),
                        "quality_score": float(segment["quality_score"] or 0),
                        "role": role,
                        "shot_type": str(segment["shot_type"] or ""),
                        "tags": [str(item) for item in tags if str(item).strip()][:12],
                        "description": next(
                            (
                                str(metadata.get(key) or "").strip()
                                for key in (
                                    "visual_caption",
                                    "description",
                                    "caption",
                                    "summary",
                                )
                                if str(metadata.get(key) or "").strip()
                            ),
                            "",
                        ),
                        "verifiable_text": str(
                            segment["transcript_text"]
                            or metadata.get("verified_text")
                            or metadata.get("ocr_text")
                            or metadata.get("visual_text")
                            or ""
                        ).strip(),
                        "evidence_ref": str(segment["id"] or ""),
                        "content_signature": str(signature_seed)[:128],
                        "metadata": {
                            "visual_signal_status": visual_signal_status
                            or "unavailable",
                            **{
                                key: visual_state(key)
                                for key in (
                                    "black_screen",
                                    "severe_blur",
                                    "frozen",
                                    "meaningless",
                                )
                            },
                        },
                    }
                )
            cards.append(
                {
                    "asset_id": asset_id,
                    "media_kind": asset["media_kind"] if intervals else "unavailable",
                    "quality_score": 0.7,
                    "usable_intervals": intervals,
                }
            )
        return cards

    def _approved_auto_mix_voice_persona(self, *, selected_id=None, excluded_id=""):
        values = [AUTO_MIX_TTS_MODEL]
        clauses = [
            "active = 1",
            "approved_at IS NOT NULL",
            "provider_voice_id <> ''",
            "((provider = 'bailian' AND provider_model = ?) OR (provider = 'volcengine' AND provider_model IN ('seed-tts-1.0', 'seed-tts-2.0')))",
        ]
        if selected_id:
            clauses.append("id = ?")
            values.append(selected_id)
        if excluded_id:
            clauses.append("id <> ?")
            values.append(excluded_id)
        rows = self.connection.execute(
            f"""
            SELECT * FROM voice_personas_v1
            WHERE {' AND '.join(clauses)}
            ORDER BY updated_at DESC, id
            """,
            values,
        ).fetchall()
        return self._preferred_auto_mix_voice_persona(rows)

    @staticmethod
    def _preferred_auto_mix_voice_persona(rows, *, catalog_only=False):
        by_id = {str(row["id"]): row for row in rows}
        for persona_id in auto_select_voice_persona_ids():
            if persona_id in by_id:
                return by_id[persona_id]
        if catalog_only or not rows:
            return None
        return rows[0]

    def _auto_prepare_default_voice_persona(
        self, *, selected_id=None, excluded_id=""
    ):
        values = [AUTO_MIX_TTS_MODEL]
        clauses = [
            "active = 1",
            "catalog_source = 'configured'",
            "provider_model = ?",
            "(provider_voice_id <> '' OR (voice_prompt <> '' AND voice_prefix <> ''))",
        ]
        if selected_id:
            clauses.append("id = ?")
            values.append(selected_id)
        if excluded_id:
            clauses.append("id <> ?")
            values.append(excluded_id)
        rows = self.connection.execute(
            f"""
            SELECT * FROM voice_personas_v1
            WHERE {' AND '.join(clauses)}
            ORDER BY updated_at DESC, id
            """,
            values,
        ).fetchall()
        persona = self._preferred_auto_mix_voice_persona(
            rows, catalog_only=True
        )
        if persona is None:
            return None
        if not str(persona["provider_voice_id"] or "").strip():
            self.design_auto_mix_voice_persona(persona["id"])
        self.preview_auto_mix_voice_persona(persona["id"])
        self.approve_auto_mix_voice_persona(persona["id"])
        return self._auto_mix_voice_persona_row(persona["id"])

    @staticmethod
    def _public_voice_persona(row):
        keys = set(row.keys()) if hasattr(row, "keys") else set()
        preview_status = (
            str(row["preview_status"] or "not_ready")
            if "preview_status" in keys
            else "not_ready"
        )
        design_status = (
            str(row["design_status"] or "")
            if "design_status" in keys
            else ""
        )
        if str(row["provider_voice_id"] or "").strip():
            provisioning_status = "ready"
        elif design_status in {"submitted", "outcome_unknown"}:
            provisioning_status = "outcome_unknown"
        elif design_status == "failed":
            provisioning_status = "failed"
        else:
            provisioning_status = "not_created"
        configured = next((item for item in configured_voice_personas() if item["persona_id"] == row["id"]), {})
        return {
            "voicePersonaId": row["id"],
            "displayName": row["display_name"],
            "style": row["style"],
            "category": row["style"],
            "version": int(row["version"]),
            "catalogVersion": row["catalog_version"],
            "approvalStatus": "approved" if row["approved_at"] else "pending",
            "previewStatus": preview_status,
            "provisioningStatus": provisioning_status,
            "provider": row["provider"],
            "previewText": voice_preview_sample(row),
            "sourceUrl": configured.get("source_url", ""),
            "recommendationUrl": configured.get("recommendation_url", ""),
            "researchDate": configured.get("research_date", ""),
            "evidenceNote": configured.get("evidence_note", ""),
        }

    def _auto_mix_voice_bundle(
        self, task_id, run, persona, public_plan, private_state
    ):
        analysis_timeline = self._auto_mix_analysis_timeline(
            public_plan, private_state
        )
        if not isinstance(analysis_timeline, dict):
            raise ContentEngineError(
                "auto_mix_material_unavailable",
                "没有足够的合格素材区间可用于成片。",
            )

        def evidence_references(phrases):
            references = []
            for phrase in phrases:
                for reference in phrase.get("evidenceRefs") or []:
                    value = str(reference or "").strip()
                    if value and value not in references:
                        references.append(value)
            return references

        def finalized_text_tracks(phrases, captions, timeline):
            final_timeline_refs = {
                str(item.get("evidence_ref") or item.get("segment_id") or "")
                for item in timeline.get("selected_segments") or []
            }
            captions_by_phrase = {
                str(item.get("captionId") or ""): item
                for item in captions or []
                if isinstance(item, dict) and str(item.get("captionId") or "").strip()
            }
            assigned_refs = {
                str(item.get("phrase_id") or ""): str(
                    item.get("evidence_ref") or ""
                )
                for item in timeline.get("spoken_evidence_refs") or []
                if isinstance(item, dict)
                and str(item.get("phrase_id") or "").strip()
                and str(item.get("evidence_ref") or "").strip()
            }
            resolved_phrases = []
            for index, phrase in enumerate(phrases):
                phrase_id = str(phrase.get("phraseId") or f"phrase-{index + 1}")
                evidence_ref = assigned_refs.get(phrase_id)
                full_evidence_refs = [
                    str(reference or "").strip()
                    for reference in phrase.get("evidenceRefs") or []
                    if str(reference or "").strip()
                ]
                candidate_refs = {
                    reference.split(":", 1)[0]
                    for reference in full_evidence_refs
                }
                caption = captions_by_phrase.get(phrase_id)
                if (
                    not evidence_ref
                    or evidence_ref not in candidate_refs
                    or evidence_ref not in final_timeline_refs
                    or not isinstance(caption, dict)
                ):
                    raise ContentEngineError(
                        "auto_mix_material_evidence_missing",
                        "口播短语没有对应的最终素材镜头。",
                    )
                cursor = int(caption.get("start_ms") or 0)
                caption_end = int(caption.get("end_ms") or 0)
                for segment in timeline.get("selected_segments") or []:
                    allowed_refs = candidate_refs if preserve_shots else {evidence_ref}
                    if str(segment.get("evidence_ref") or "") not in allowed_refs:
                        continue
                    segment_start = int(segment.get("timeline_start_ms") or 0)
                    segment_end = int(segment.get("timeline_end_ms") or 0)
                    if segment_end <= cursor:
                        continue
                    if segment_start > cursor:
                        break
                    cursor = max(cursor, segment_end)
                    if cursor >= caption_end:
                        break
                if caption_end <= int(caption.get("start_ms") or 0) or cursor < caption_end:
                    raise ContentEngineError(
                        "auto_mix_material_evidence_missing",
                        "口播短语没有被最终素材时间轴完整覆盖。",
                    )
                resolved_phrases.append(
                    {
                        **phrase,
                        "evidenceRefs": [
                            reference
                            for reference in full_evidence_refs
                            if preserve_shots or reference.split(":", 1)[0] == evidence_ref
                        ],
                    }
                )
            references = evidence_references(resolved_phrases)
            if not references:
                raise ContentEngineError(
                    "auto_mix_material_evidence_missing",
                    "口播短语缺少可追溯的素材事实引用。",
                )
            reference_keys = {
                reference.split(":", 1)[0] for reference in references
            }
            source_tracks = private_state.get("text_tracks") or {}
            facts = [
                fact
                for fact in build_material_evidence_facts(timeline)
                if any(
                    str(reference or "").split(":", 1)[0] in reference_keys
                    for reference in fact.get("evidenceRefs") or []
                )
            ]
            visual_items = []
            for item in source_tracks.get("visual_text_items") or []:
                if item.get("type") != "callout":
                    visual_items.append(item)
                    continue
                if any(
                    str(reference or "").split(":", 1)[0] in reference_keys
                    for reference in item.get("evidenceRefs") or []
                ):
                    resolved_refs = [
                        str(reference)
                        for reference in item.get("evidenceRefs") or []
                        if str(reference or "").split(":", 1)[0]
                        in final_timeline_refs
                    ]
                    if resolved_refs:
                        visual_items.append(
                            {
                                **item,
                                "evidenceRefs": resolved_refs[:1],
                            }
                        )
            if not reference_keys.issubset(final_timeline_refs):
                raise ContentEngineError(
                    "auto_mix_material_evidence_missing",
                    "最终时间轴没有覆盖全部口播事实素材。",
                )
            return {
                "spoken_phrases": resolved_phrases,
                "visual_text_items": visual_items,
                "evidence_facts": facts,
            }

        existing_relative = str(private_state.get("voice_audio_path") or "")
        existing_digest = str(private_state.get("voice_audio_digest") or "")
        existing_captions = public_plan.get("speechCaptions") or []
        existing_phrase_audio = private_state.get("phrase_audio") or []
        phrase_text = {p.get("phraseId"): p.get("text", "") for p in public_plan.get("spokenPhrases") or []}
        for item in existing_phrase_audio:
            self._refresh_cached_narration_alignment(item.get("verification") or {},
                phrase_text.get(item.get("phrase_id"), ""), item.get("duration_ms", 0), item.get("audio_digest"))
        preserve_shots = bool(private_state.get("narrated_preserve_shot_duration"))
        def full_shot_timeline(phrases, audio):
            segments = [dict(s) for s in analysis_timeline["selected_segments"]]
            cursor = 0
            position = 0
            for index, (phrase, item) in enumerate(zip(phrases, audio)):
                refs = phrase.get("evidenceRefs") or []
                group = segments[position:position + len(refs)]
                if not refs or refs != [s["evidence_ref"] for s in group]:
                    raise ContentEngineError("narrated_voice_mapping", "口播与镜头顺序不匹配。")
                available = sum(int(s["target_duration_ms"]) for s in group)
                speech = int(item["duration_ms"])
                if speech > available:
                    raise ContentEngineError("narrated_copy_too_long", "实际配音超过对应画面的可用时长。")
                pause = min(160, available - speech) if index < len(phrases) - 1 else 0
                budget = speech + pause
                observed_budgets = sentence_shot_budgets(phrase, item, group, pause)
                item["shot_timing_source"] = "asr_sentences" if observed_budgets else "phrase"
                item["sentence_shots"] = [
                    {**sentence, "evidenceRefs": binding["evidenceRefs"]}
                    for binding, sentence in zip(phrase.get("sentenceBindings") or [],
                        aligned_binding_spans(phrase, item))
                ] if observed_budgets else []
                accumulated = 0
                allocated = 0
                for shot_index, s in enumerate(group):
                    original = int(s["target_duration_ms"])
                    accumulated += original
                    boundary = round(budget * accumulated / available)
                    duration = observed_budgets[shot_index] if observed_budgets else boundary - allocated
                    if duration <= 0 or duration > original:
                        raise ContentEngineError("narrated_voice_mapping", "口播过短，无法完整展示选定镜头。")
                    # Keep a real central interval at normal playback speed;
                    # narration sets the edit length, not silence padding.
                    s["source_start_ms"] += (original - duration) // 2
                    s["source_end_ms"] = s["source_start_ms"] + duration
                    s.update(target_duration_ms=duration, timeline_start_ms=cursor,
                             timeline_end_ms=cursor + duration)
                    cursor += duration
                    allocated = boundary
                item["tail_silence_ms"] = pause
                position += len(group)
            if position != len(segments):
                raise ContentEngineError("narrated_voice_mapping", "口播没有覆盖全部镜头。")
            minimum_ms = int(private_state.get("narrated_minimum_duration_ms") or 0)
            if minimum_ms and sum(int(item["duration_ms"]) for item in audio) < minimum_ms + 100:
                raise ContentEngineError("narrated_duration_too_short",
                                         f"实际口播不足 {minimum_ms // 1000} 秒，需要补充内容和相关镜头后再制作。")
            return {**analysis_timeline, "selected_segments": segments, "selected_duration_ms": cursor,
                    "spoken_evidence_refs": [
                {"phrase_id": phrase.get("phraseId") or f"phrase-{index + 1}",
                 "evidence_ref": (phrase.get("evidenceRefs") or [""])[0]}
                for index, phrase in enumerate(phrases)
            ]}
        try:
            existing_duration_ms = int(existing_captions[-1]["end_ms"])
        except (IndexError, KeyError, TypeError, ValueError):
            existing_duration_ms = 0
        phrase_cache_valid = bool(existing_phrase_audio) and all(
            isinstance(item, dict)
            and isinstance(item.get("verification"), dict)
            and item["verification"].get("matched") is True
            and self._valid_managed_wav(
                item.get("relative_path"),
                item.get("audio_digest"),
                expected_duration_ms=item.get("duration_ms"),
            )
            for item in existing_phrase_audio
        )
        if (
            existing_relative
            and existing_digest
            and existing_duration_ms > 0
            and existing_captions
            and [re.sub(r"\s+", " ", str(c.get("text") or "")).strip() for c in existing_captions]
                == [re.sub(r"\s+", " ", str(p.get("text") or "")).strip()
                    for p in public_plan.get("spokenPhrases") or []]
            and phrase_cache_valid
            and self._valid_managed_wav(
                existing_relative,
                existing_digest,
                expected_duration_ms=existing_duration_ms,
            )
        ):
            phrases = public_plan.get("spokenPhrases") or []
            timeline = full_shot_timeline(phrases, existing_phrase_audio) if preserve_shots else align_material_timeline_to_captions(
                analysis_timeline,
                phrases,
                existing_captions,
            )
            attach_narration_alignment(existing_captions, existing_phrase_audio)
            text_tracks = finalized_text_tracks(
                phrases, existing_captions, timeline
            )
            return {
                "phrases": phrases,
                "captions": existing_captions,
                "phrase_audio": existing_phrase_audio,
                "relative_path": existing_relative,
                "audio_digest": existing_digest,
                "duration_ms": existing_duration_ms,
                "timeline": timeline,
                "text_tracks": text_tracks,
            }
        phrases = list((private_state.get("text_tracks") or {}).get("spoken_phrases") or [])
        if not phrases:
            raise ContentEngineError(
                "auto_mix_text_invalid", "没有可合成的口播短语。"
            )
        available_ms = int(
            analysis_timeline.get(
                "selected_duration_ms"
            )
            or 0
        )
        raw_duration_plan = private_state.get("duration_plan")
        guided_duration_plan = (
            self._guided_auto_mix_duration_plan_value(raw_duration_plan)
            if raw_duration_plan is not None
            else None
        )
        bounded_phrases = []
        estimated_ms = 0
        for phrase in phrases[:AUTO_MIX_MAX_TTS_PHRASES]:
            estimate = max(600, min(4_500, len(str(phrase.get("text") or "")) * 230))
            next_estimate = estimated_ms + (160 if bounded_phrases else 0) + estimate
            if bounded_phrases and available_ms > 0 and next_estimate > available_ms + 1_000:
                break
            bounded_phrases.append(phrase)
            estimated_ms = next_estimate
        if len(bounded_phrases) < len(phrases):
            if private_state.get("narrated_batch_v1"):
                raise ContentEngineError("narrated_copy_too_long", "解说无法完整对应镜头，请缩短后重做这一条。")
            if guided_duration_plan is not None:
                raise ContentEngineError(
                    "guided_auto_mix_script_duration_invalid",
                    "AI 脚本超过本次真实素材可承载的配音时长；请重新生成 AI 脚本。",
                )
            phrases = bounded_phrases
            warnings = list(public_plan.get("qualityWarnings") or [])
            warnings.append({"code": "auto_mix_copy_shortened_before_tts"})
            public_plan["qualityWarnings"] = warnings
        phrase_audio = []
        critical_terms = [
            str(term).strip()[:100]
            for term in private_state.get("guided_critical_terms") or []
            if str(term).strip()
        ]
        self._save_auto_mix_run(run["id"], status="synthesizing")
        for phrase in phrases:
            phrase_critical_terms = matching_spoken_critical_terms(
                phrase.get("text"), critical_terms
            )
            item = self._synthesize_and_verify_auto_mix_phrase(
                task_id,
                run,
                persona,
                phrase,
                critical_terms=phrase_critical_terms,
            )
            phrase_audio.append(item)
        durations = [int(item["duration_ms"]) for item in phrase_audio]
        captions = build_speech_captions(phrases, durations, pause_ms=160)
        if preserve_shots:
            fitted_timeline = full_shot_timeline(phrases, phrase_audio)
            segments = fitted_timeline["selected_segments"]
            cursor = 0
            for phrase, item, caption in zip(phrases, phrase_audio, captions):
                refs = phrase.get("evidenceRefs") or []
                group = segments[cursor:cursor + len(refs)]
                if not refs or refs != [segment["evidence_ref"] for segment in group]:
                    raise ContentEngineError("narrated_voice_mapping", "口播与镜头顺序不匹配，已停止制作。")
                available = sum(segment["target_duration_ms"] for segment in group)
                if item["duration_ms"] > available:
                    raise ContentEngineError("narrated_copy_too_long", "实际配音无法在对应镜头内完整播放，请调整口播。")
                caption["start_ms"] = group[0]["timeline_start_ms"]
                caption["end_ms"] = caption["start_ms"] + item["duration_ms"]
                cursor += len(group)
            if cursor != len(segments):
                raise ContentEngineError("narrated_voice_mapping", "口播没有覆盖全部镜头，已停止制作。")
        accepted = 0
        for caption in captions:
            if int(caption["end_ms"]) <= available_ms:
                accepted += 1
            else:
                break
        if accepted == 0:
            raise ContentEngineError(
                "auto_mix_material_too_short",
                "合格素材不足以承载第一句真实配音，请缩短文案或补充素材。",
            )
        if accepted < len(phrases):
            if private_state.get("narrated_batch_v1"):
                raise ContentEngineError("narrated_copy_too_long", "实际配音过长，已停止本条制作；请缩短解说。")
            if guided_duration_plan is not None:
                raise ContentEngineError(
                    "guided_auto_mix_script_duration_invalid",
                    "实际配音超过本次真实素材可承载的时长；请重新生成 AI 脚本。",
                )
            phrases = phrases[:accepted]
            phrase_audio = phrase_audio[:accepted]
            durations = durations[:accepted]
            captions = build_speech_captions(phrases, durations, pause_ms=160)
            warnings = list(public_plan.get("qualityWarnings") or [])
            warnings.append({"code": "auto_mix_copy_shortened_after_tts"})
            public_plan["qualityWarnings"] = warnings
        relative_path = self._concat_auto_mix_phrases(
            run["id"], phrase_audio, pause_ms=160
        )
        voice_audio_digest = self._sha256_file(self.data_dir / relative_path)
        duration_ms = int(captions[-1]["end_ms"])
        actual_duration = self._wav_duration_ms(self.data_dir / relative_path)
        if abs(actual_duration - duration_ms) > 30:
            raise ContentEngineError(
                "auto_mix_voice_timing_invalid",
                "拼接配音的真实时长与字幕边界不一致。",
            )
        timeline = fitted_timeline if preserve_shots else align_material_timeline_to_captions(
            analysis_timeline,
            phrases,
            captions,
        )
        attach_narration_alignment(captions, phrase_audio)
        text_tracks = finalized_text_tracks(phrases, captions, timeline)
        return {
            "phrases": phrases,
            "captions": captions,
            "phrase_audio": phrase_audio,
            "relative_path": relative_path,
            "audio_digest": voice_audio_digest,
            "duration_ms": duration_ms,
            "timeline": timeline,
            "text_tracks": text_tracks,
        }

    def _refresh_cached_narration_alignment(self, verification, text, duration_ms, audio_digest):
        if not verification.get("matched") or (verification.get("alignment") or {}).get("version", 0) >= 2:
            return
        row = self.connection.execute(
            "SELECT private_metadata_json FROM auto_mix_stage_artifacts_v2 "
            "WHERE stage='voice_alignment' AND status='completed' "
            "AND json_extract(private_metadata_json, '$.audio_digest')=? "
            "AND json_extract(private_metadata_json, '$.expected_text')=? ORDER BY updated_at DESC LIMIT 1",
            (audio_digest, text)).fetchone()
        if row:
            metadata = self._json_object(row["private_metadata_json"])
            if metadata.get("recognized_segments"):
                verification["alignment"] = align_narration(text, metadata["recognized_segments"], duration_ms)

    def _synthesize_and_verify_auto_mix_phrase(
        self, task_id, run, persona, phrase, *, critical_terms=()
    ):
        synthesize = getattr(self.analyzer, "synthesize_auto_mix_phrase", None)
        cloud = getattr(self.analyzer, "cloud_client", None)
        transcribe = getattr(cloud, "transcribe", None)
        if not callable(synthesize):
            raise ContentEngineError(
                "auto_mix_voice_unavailable",
                "当前内容引擎不支持 CosyVoice 3.5 Plus 短语配音。",
            )
        if not callable(transcribe) or not getattr(cloud, "configured", False):
            raise ContentEngineError(
                "auto_mix_voice_verification_unavailable",
                "正式成片需要使用 ASR 回听核对每个配音短语。",
            )
        persona_private = {
            "provider": persona["provider"],
            "provider_model": persona["provider_model"],
            "provider_voice_id": persona["provider_voice_id"],
            "instruction": persona["instruction"],
        }
        for attempt in range(1):
            cache_key = auto_mix_canonical_hash(
                {
                    "stage": "tts",
                    "text": phrase["text"],
                    "persona": persona["id"],
                    "catalog": persona["catalog_version"],
                    "provider_model": persona["provider_model"],
                    "provider_voice_id": persona["provider_voice_id"],
                    "instruction": persona["instruction"],
                    "attempt": attempt,
                }
            )
            relative = Path("auto-mix-cache") / "tts" / f"{cache_key}.wav"
            output = self.data_dir / relative
            cached = self._cached_auto_mix_artifact("tts", cache_key)
            if cached is not None:
                relative = Path(cached["relative_path"])
                output = self.data_dir / relative
                cached_private = self._json_object(cached["private_metadata_json"])
                audio_digest = str(cached_private.get("audio_digest") or "")
                duration_ms = self._wav_duration_ms(output)
                self._record_auto_mix_artifact(
                    run["id"],
                    "tts",
                    cache_key,
                    "completed",
                    relative_path=str(relative),
                    public_metadata={"cacheHit": True},
                    private_metadata={
                        "audio_digest": audio_digest,
                        "duration_ms": duration_ms,
                    },
                    revision=attempt + 1,
                )
            else:
                if self._has_unresolved_auto_mix_artifact("tts", cache_key):
                    raise ContentEngineError(
                        "auto_mix_voice_outcome_unknown",
                        "该短语已有结果不明的配音请求；为避免重复计费，已停止自动重提。",
                    )
                self._record_auto_mix_artifact(
                    run["id"],
                    "tts",
                    cache_key,
                    "submitted",
                    revision=attempt + 1,
                )
                output.parent.mkdir(parents=True, exist_ok=True)
                try:
                    metadata = synthesize(
                        phrase["text"], output, persona_private
                    )
                    duration_ms = self._wav_duration_ms(output)
                    audio_digest = self._sha256_file(output)
                except ContentEngineError as error:
                    status = (
                        "outcome_unknown"
                        if error.code == "auto_mix_voice_outcome_unknown"
                        else "failed"
                    )
                    self._record_auto_mix_artifact(
                        run["id"],
                        "tts",
                        cache_key,
                        status,
                        revision=attempt + 1,
                    )
                    raise
                except OSError as error:
                    self._record_auto_mix_artifact(
                        run["id"],
                        "tts",
                        cache_key,
                        "failed",
                        revision=attempt + 1,
                    )
                    raise ContentEngineError(
                        "auto_mix_voice_invalid", "配音缓存文件不可用。"
                    ) from error
                private_metadata = (
                    dict(metadata) if isinstance(metadata, dict) else {}
                )
                private_metadata.update(
                    {
                        "audio_digest": audio_digest,
                        "duration_ms": duration_ms,
                    }
                )
                self._record_auto_mix_artifact(
                    run["id"],
                    "tts",
                    cache_key,
                    "completed",
                    relative_path=str(relative),
                    public_metadata={"cacheHit": False},
                    private_metadata=private_metadata,
                    revision=attempt + 1,
                )
            alignment_input = {
                "stage": "voice_alignment",
                "tts": cache_key,
                "audio_digest": audio_digest,
                "text": phrase["text"],
                "title": run["title"],
            }
            if critical_terms:
                alignment_input["critical_terms"] = list(critical_terms)
            alignment_key = auto_mix_canonical_hash(alignment_input)
            cached_verification = self._completed_auto_mix_artifact_metadata(
                "voice_alignment", alignment_key
            )
            if cached_verification.get("matched") is True:
                self._refresh_cached_narration_alignment(cached_verification, phrase["text"], duration_ms, audio_digest)
                return {
                    "phrase_id": phrase["phraseId"],
                    "relative_path": str(relative),
                    "audio_digest": audio_digest,
                    "duration_ms": duration_ms,
                    "verification": cached_verification,
                    "attempts": attempt + 1,
                }
            if self._has_unresolved_auto_mix_artifact(
                "voice_alignment", alignment_key
            ):
                raise ContentEngineError(
                    "auto_mix_voice_outcome_unknown",
                    "该短语已有结果不明的回听请求；为避免重复提交，已停止自动重试。",
                )
            self._record_auto_mix_artifact(
                run["id"],
                "voice_alignment",
                alignment_key,
                "submitted",
                revision=attempt + 1,
            )
            try:
                recognized_segments = transcribe(
                    output, lambda: self._should_stop(task_id)
                )
            except ContentEngineError as error:
                known_failure = error.code in {
                    "cloud_upload_failed",
                    "cloud_transcription_failed",
                    "cloud_transcription_too_large",
                    "cloud_transcription_url_invalid",
                }
                self._record_auto_mix_artifact(
                    run["id"],
                    "voice_alignment",
                    alignment_key,
                    "failed" if known_failure else "outcome_unknown",
                    revision=attempt + 1,
                )
                if not known_failure:
                    raise ContentEngineError(
                        "auto_mix_voice_outcome_unknown",
                        "配音回听请求结果不明；为避免重复提交，已停止自动重试。",
                    ) from None
                raise ContentEngineError(
                    "auto_mix_voice_verification_unavailable",
                    "配音回听服务不可用，正式成片已停止。",
                ) from None
            recognized = "".join(
                str(item.get("transcript") or item.get("text") or "")
                for item in recognized_segments or []
                if isinstance(item, dict)
            )
            verification = verify_spoken_phrase(
                phrase["text"],
                recognized,
                title=run["title"],
                critical_terms=critical_terms,
            )
            verification["alignment"] = align_narration(phrase["text"], recognized_segments, duration_ms)
            self._record_auto_mix_artifact(
                run["id"],
                "voice_alignment",
                alignment_key,
                "completed" if verification["matched"] else "failed",
                public_metadata=verification,
                private_metadata={
                    "audio_digest": audio_digest,
                    # Keep the actual ASR comparison private but durable.  A
                    # failed validation must be diagnosable from evidence, not
                    # by loosening the gate or inventing replacement copy.
                    "expected_text": phrase["text"],
                    "recognized_text": recognized,
                    "recognized_segments": recognized_segments,
                },
                revision=attempt + 1,
            )
            if verification["matched"]:
                return {
                    "phrase_id": phrase["phraseId"],
                    "relative_path": str(relative),
                    "audio_digest": audio_digest,
                    "duration_ms": duration_ms,
                    "verification": verification,
                    "attempts": attempt + 1,
                }
        raise ContentEngineError(
            "auto_mix_voice_verification_failed",
            "配音回听与当前口播差异过大，或关键品牌词、数字不一致；已停止当前短语。",
        )

    def _cached_auto_mix_artifact(self, stage, cache_key):
        rows = self.connection.execute(
            """
            SELECT * FROM auto_mix_stage_artifacts_v2
            WHERE stage = ? AND cache_key = ? AND status = 'completed'
              AND relative_path IS NOT NULL
            ORDER BY updated_at DESC, rowid DESC
            """,
            (stage, cache_key),
        ).fetchall()
        for row in rows:
            private_metadata = self._json_object(row["private_metadata_json"])
            if self._valid_managed_wav(
                row["relative_path"],
                private_metadata.get("audio_digest"),
                expected_duration_ms=private_metadata.get("duration_ms"),
            ):
                return row
            self.connection.execute(
                """
                UPDATE auto_mix_stage_artifacts_v2
                SET status = 'invalidated', updated_at = ?
                WHERE id = ? AND status = 'completed'
                """,
                (self._now(), row["id"]),
            )
        return None

    def _has_unresolved_auto_mix_artifact(self, stage, cache_key):
        return self.connection.execute(
            """
            SELECT 1 FROM auto_mix_stage_artifacts_v2
            WHERE stage = ? AND cache_key = ?
              AND status IN ('submitted', 'outcome_unknown')
            LIMIT 1
            """,
            (stage, cache_key),
        ).fetchone() is not None

    def _completed_auto_mix_artifact_metadata(self, stage, cache_key):
        row = self.connection.execute(
            """
            SELECT public_metadata_json FROM auto_mix_stage_artifacts_v2
            WHERE stage = ? AND cache_key = ? AND status = 'completed'
            ORDER BY updated_at DESC, rowid DESC LIMIT 1
            """,
            (stage, cache_key),
        ).fetchone()
        return self._json_object(row["public_metadata_json"]) if row else {}

    def _record_auto_mix_artifact(
        self,
        run_id,
        stage,
        cache_key,
        status,
        *,
        relative_path=None,
        public_metadata=None,
        private_metadata=None,
        revision=1,
    ):
        now = self._now()
        self.connection.execute(
            """
            INSERT INTO auto_mix_stage_artifacts_v2(
                id, run_id, stage, cache_key, status, relative_path,
                public_metadata_json, private_metadata_json, revision,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, stage, cache_key, revision) DO UPDATE SET
                status = excluded.status,
                relative_path = excluded.relative_path,
                public_metadata_json = excluded.public_metadata_json,
                private_metadata_json = excluded.private_metadata_json,
                updated_at = excluded.updated_at
            """,
            (
                self._new_id("auto_mix_artifact"),
                run_id,
                stage,
                cache_key,
                status,
                relative_path,
                self._json(sanitize_public_value(public_metadata or {})),
                self._json(private_metadata or {}),
                max(1, int(revision)),
                now,
                now,
            ),
        )

    @staticmethod
    def _wav_duration_details(path):
        try:
            with Path(path).open("rb") as source:
                header = source.read(44)
            with wave.open(str(path), "rb") as stream:
                declared_frames = stream.getnframes()
                rate = stream.getframerate()
                bytes_per_frame = stream.getnchannels() * stream.getsampwidth()
                frame_bytes = 0
                while True:
                    chunk = stream.readframes(65_536)
                    if not chunk:
                        break
                    frame_bytes += len(chunk)
                if (
                    declared_frames <= 0
                    or rate <= 0
                    or bytes_per_frame <= 0
                    or frame_bytes <= 0
                    or frame_bytes % bytes_per_frame
                ):
                    raise ValueError("empty wave")
                actual_frames = frame_bytes // bytes_per_frame
                streaming_placeholder = (
                    actual_frames != declared_frames
                    and len(header) == 44
                    and header[:4] == b"RIFF"
                    and header[8:12] == b"WAVE"
                    and header[36:40] == b"data"
                    and (
                        int.from_bytes(header[4:8], "little"),
                        int.from_bytes(header[40:44], "little"),
                    )
                    == BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES
                )
                if actual_frames != declared_frames and not streaming_placeholder:
                    raise ValueError("wave frame count does not match its payload")
                return {
                    "duration_ms": round(actual_frames * 1000 / rate),
                    "declared_duration_ms": round(declared_frames * 1000 / rate),
                    "streaming_placeholder": streaming_placeholder,
                }
        except (OSError, EOFError, wave.Error, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_voice_invalid", "配音文件不是有效的 WAV 音频。"
            ) from error

    @staticmethod
    def _wav_duration_ms(path):
        return int(CreativeDomain._wav_duration_details(path)["duration_ms"])

    def _valid_managed_wav(
        self, relative_path, expected_digest, *, expected_duration_ms=None
    ):
        relative = str(relative_path or "").strip()
        if not self._managed_file_digest_matches(relative, expected_digest):
            return False
        path = (self.data_dir / relative).resolve()
        try:
            details = self._wav_duration_details(path)
            duration_ms = int(details["duration_ms"])
            if expected_duration_ms is not None:
                expected_duration_ms = int(expected_duration_ms)
                if abs(duration_ms - expected_duration_ms) > 30 and not (
                    details["streaming_placeholder"]
                    and abs(
                        int(details["declared_duration_ms"])
                        - expected_duration_ms
                    )
                    <= 30
                ):
                    return False
        except (ContentEngineError, TypeError, ValueError):
            return False
        return True

    def _validate_auto_mix_v2_runtime_resources(self, recipe):
        if recipe.get("product_workflow") != "one_click_v2":
            return
        captions = recipe.get("captions") or []
        try:
            expected_duration_ms = int(captions[-1]["end_ms"])
        except (IndexError, KeyError, TypeError, ValueError) as error:
            raise ContentEngineError(
                "auto_mix_voice_timing_invalid",
                "一键混剪 V2 缺少可核验的真实配音时长。",
            ) from error
        if expected_duration_ms <= 0:
            raise ContentEngineError(
                "auto_mix_voice_timing_invalid",
                "一键混剪 V2 的真实配音时长无效。",
            )
        if recipe.get("narrated_preserve_shot_duration"):
            expected_duration_ms = sum(int(s["target_duration_ms"]) for s in recipe["visual_segments"])
        if not self._valid_managed_wav(
            recipe.get("voice_audio_path"),
            recipe.get("voice_audio_digest"),
            expected_duration_ms=expected_duration_ms,
        ):
            raise ContentEngineError(
                "auto_mix_voice_cache_changed",
                "已核验的配音发生变化，请使用 voice 声音层重做。",
            )

        track_id = str(recipe.get("music_track_id") or "").strip()
        relative_path = str(
            recipe.get("licensed_music_relative_path") or ""
        ).strip()
        if not track_id or not relative_path:
            raise ContentEngineError(
                "auto_mix_music_authorization_changed",
                "授权音乐已撤权、过期或摘要不一致，请使用 music 音乐层重做。",
            )
        matching = self._music_catalog_rows(track_id=track_id)
        current = select_licensed_music(
            matching,
            {"bpmRange": [0, 999]},
            required_duration_ms=expected_duration_ms,
            allowed_track_ids=recipe.get("music_track_ids"),
        )
        if (
            current is None
            or current.get("managed_relative_path") != relative_path
        ):
            raise ContentEngineError(
                "auto_mix_music_authorization_changed",
                "授权音乐已撤权、过期或摘要不一致，请使用 music 音乐层重做。",
            )
        supplemental_image = recipe.get("supplemental_image")
        if supplemental_image is not None:
            if not isinstance(supplemental_image, dict):
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_invalid_output",
                    "AI 补图记录无效，请重新生成成片。",
                )
            operation_id = str(supplemental_image.get("operation_id") or "")
            asset_id = str(supplemental_image.get("asset_id") or "")
            digest = str(supplemental_image.get("image_digest") or "")
            if (
                not re.fullmatch(
                    r"guided_auto_mix_supplemental_image_[a-f0-9]{32}", operation_id
                )
                or asset_id
                != f"guided_auto_mix_supplemental_image:{operation_id}"
                or not re.fullmatch(r"[a-f0-9]{64}", digest)
            ):
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_invalid_output",
                    "AI 补图引用无效，请重新生成成片。",
                )
            operation = self._guided_auto_mix_supplemental_image_operation_row(
                operation_id
            )
            if (
                operation["status"] != "completed"
                or str(operation["image_digest"] or "") != digest
            ):
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_invalid_output",
                    "AI 补图已变化或不可用，请重新生成成片。",
                )
            # This resolver performs the managed-root, MIME and digest checks
            # before FFmpeg/Remotion can ever open the file.
            self.resolve_guided_auto_mix_supplemental_image_path(operation_id)

    def _concat_auto_mix_phrases(self, run_id, phrase_audio, *, pause_ms):
        cache_key = auto_mix_canonical_hash(
            {
                "stage": "voice_concat",
                "phrases": [
                    {
                        "path": item["relative_path"],
                        "duration_ms": item["duration_ms"],
                        "audio_digest": item.get("audio_digest"),
                        **({"tail_silence_ms": item["tail_silence_ms"]} if "tail_silence_ms" in item else {}),
                    }
                    for item in phrase_audio
                ],
                "pause_ms": pause_ms,
            }
        )
        relative = Path("auto-mix-cache") / "voice" / f"{cache_key}.wav"
        output = self.data_dir / relative
        cached = self._cached_auto_mix_artifact("tts", cache_key)
        if cached is not None:
            return str(cached["relative_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(".writing.wav")
        parameters = None
        sources = []
        for item in phrase_audio:
            source = (self.data_dir / item["relative_path"]).resolve()
            if not self._valid_managed_wav(
                item.get("relative_path"),
                item.get("audio_digest"),
                expected_duration_ms=item.get("duration_ms"),
            ):
                raise ContentEngineError(
                    "auto_mix_voice_invalid", "配音短语缓存不可用。"
                )
            with wave.open(str(source), "rb") as stream:
                current = (
                    stream.getnchannels(),
                    stream.getsampwidth(),
                    stream.getframerate(),
                    stream.getcomptype(),
                    stream.getcompname(),
                )
                if parameters is None:
                    parameters = current
                elif parameters != current:
                    raise ContentEngineError(
                        "auto_mix_voice_format_mismatch",
                        "配音短语的音频格式不一致。",
                    )
            sources.append(source)
        if not parameters:
            raise ContentEngineError("auto_mix_voice_invalid", "没有可拼接的配音短语。")
        channels, sample_width, frame_rate, compression, compression_name = parameters
        silence_frames = round(frame_rate * max(0, int(pause_ms)) / 1000)
        silence = b"\x00" * silence_frames * channels * sample_width
        try:
            with wave.open(str(temporary), "wb") as stream:
                stream.setnchannels(channels)
                stream.setsampwidth(sample_width)
                stream.setframerate(frame_rate)
                stream.setcomptype(compression, compression_name)
                for index, source in enumerate(sources):
                    with wave.open(str(source), "rb") as phrase_stream:
                        while True:
                            chunk = phrase_stream.readframes(65_536)
                            if not chunk:
                                break
                            stream.writeframesraw(chunk)
                    if "tail_silence_ms" in phrase_audio[index]:
                        frames = round(frame_rate * max(0, int(phrase_audio[index]["tail_silence_ms"])) / 1000)
                        stream.writeframesraw(b"\x00" * frames * channels * sample_width)
                    elif index < len(sources) - 1:
                        stream.writeframesraw(silence)
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
        duration_ms = self._wav_duration_ms(output)
        audio_digest = self._sha256_file(output)
        self._record_auto_mix_artifact(
            run_id,
            "tts",
            cache_key,
            "completed",
            relative_path=str(relative),
            public_metadata={"kind": "concatenated_voice"},
            private_metadata={
                "audio_digest": audio_digest,
                "duration_ms": duration_ms,
            },
        )
        return str(relative)

    def _music_catalog_rows(self, *, track_id=None):
        output = []
        query = "SELECT * FROM music_catalog_tracks_v1"
        values = ()
        if track_id is not None:
            query += " WHERE id = ?"
            values = (str(track_id),)
        query += " ORDER BY updated_at DESC, id"
        for row in self.connection.execute(query, values).fetchall():
            managed_audio_valid = self._managed_file_digest_matches(
                row["managed_relative_path"], row["fingerprint"]
            )
            try:
                moods = json.loads(row["moods_json"] or "[]")
            except (TypeError, ValueError, json.JSONDecodeError):
                moods = []
            output.append(
                {
                    "track_id": row["id"],
                    "display_name": row["display_name"],
                    "managed_relative_path": row["managed_relative_path"],
                    "source": row["source"],
                    "commercial_scope": row["commercial_scope"],
                    "commercial_use_allowed": bool(row["commercial_use_allowed"]),
                    "license_status": row["license_status"],
                    "expires_at": row["expires_at"],
                    "evidence_present": bool(
                        row["credential_reference"]
                        and self._managed_file_digest_matches(
                            row["managed_evidence_relative_path"],
                            row["evidence_digest"],
                        )
                    ),
                    "duration_ms": row["duration_ms"],
                    "bpm": row["bpm"],
                    "moods": moods if isinstance(moods, list) else [],
                    "energy": row["energy"],
                    "integrated_lufs": row["integrated_lufs"],
                    "true_peak_dbtp": row["true_peak_dbtp"],
                    "loop_start_ms": row["loop_start_ms"],
                    "loop_end_ms": row["loop_end_ms"],
                    "analysis_status": (
                        row["analysis_status"] if managed_audio_valid else "failed"
                    ),
                }
            )
        return output

    def import_music_catalog_track(self, request):
        contract = validate_music_catalog_track_v1(request)
        try:
            source = Path(contract["source_path"]).resolve(strict=True)
            evidence = (
                Path(contract["evidence_path"]).resolve(strict=True)
                if contract["evidence_path"]
                else None
            )
        except (OSError, RuntimeError) as error:
            raise ContentEngineError(
                "music_import_file_unavailable", "音乐文件或授权证据不可用。"
            ) from error
        if not source.is_file() or source.suffix.casefold() not in {
            ".wav",
            ".mp3",
            ".m4a",
            ".aac",
            ".flac",
            ".ogg",
        }:
            raise ContentEngineError(
                "music_import_format_unsupported", "请选择受支持的真实音频文件。"
            )
        if contract["license_status"] == "valid" and (
            evidence is None or not evidence.is_file()
        ):
            raise ContentEngineError(
                "music_license_evidence_missing", "有效商用音乐的授权证据不可用。"
            )
        try:
            source_size = source.stat().st_size
            evidence_size = evidence.stat().st_size if evidence else 0
        except OSError as error:
            raise ContentEngineError(
                "music_import_file_unavailable", "音乐文件或授权证据不可用。"
            ) from error
        if source_size <= 0 or source_size > MAX_MUSIC_AUDIO_BYTES:
            raise ContentEngineError(
                "music_import_file_too_large", "音乐文件为空或超过 512 MB。"
            )
        if evidence is not None and evidence_size <= 0:
            raise ContentEngineError(
                "music_license_evidence_missing", "授权证据文件为空。"
            )
        if evidence_size > MAX_MUSIC_EVIDENCE_BYTES:
            raise ContentEngineError(
                "music_license_evidence_too_large", "授权证据超过 32 MB。"
            )
        fingerprint = self._sha256_file(source)
        evidence_digest = self._sha256_file(evidence) if evidence else ""
        relative = Path("music-catalog") / f"{fingerprint}{source.suffix.casefold()}"
        managed = (self.data_dir / relative).resolve()
        if self.data_dir not in managed.parents:
            raise ContentEngineError(
                "music_import_file_unavailable", "音乐受管目录无效。"
            )
        managed.parent.mkdir(parents=True, exist_ok=True)
        if not self._file_digest_matches(managed, fingerprint):
            temporary = managed.with_suffix(managed.suffix + ".importing")
            try:
                shutil.copyfile(source, temporary)
                if self._sha256_file(temporary) != fingerprint:
                    raise ContentEngineError(
                        "music_import_digest_mismatch", "音乐导入校验失败。"
                    )
                temporary.replace(managed)
            finally:
                temporary.unlink(missing_ok=True)
        evidence_relative = (
            Path("music-catalog") / "evidence" / f"{evidence_digest}.proof"
            if evidence
            else None
        )
        managed_evidence = (
            (self.data_dir / evidence_relative).resolve()
            if evidence_relative is not None
            else None
        )
        if managed_evidence is not None:
            if self.data_dir not in managed_evidence.parents:
                raise ContentEngineError(
                    "music_import_file_unavailable", "授权证据受管目录无效。"
                )
            managed_evidence.parent.mkdir(parents=True, exist_ok=True)
            if not self._file_digest_matches(managed_evidence, evidence_digest):
                evidence_temporary = managed_evidence.with_suffix(
                    managed_evidence.suffix + ".importing"
                )
                try:
                    shutil.copyfile(evidence, evidence_temporary)
                    if self._sha256_file(evidence_temporary) != evidence_digest:
                        raise ContentEngineError(
                            "music_import_digest_mismatch", "授权证据导入校验失败。"
                        )
                    evidence_temporary.replace(managed_evidence)
                finally:
                    evidence_temporary.unlink(missing_ok=True)
        audio_renderer = getattr(self.renderer, "ffmpeg_renderer", self.renderer)
        probe_duration = getattr(audio_renderer, "probe_audio_duration_ms", None)
        measure_quality = getattr(audio_renderer, "measure_audio_quality", None)
        duration_ms = 0
        report = {}
        analysis_status = "ready"
        analysis_error_code = None
        try:
            if not callable(probe_duration) or not callable(measure_quality):
                raise ContentEngineError(
                    "music_analysis_unavailable", "授权音乐分析运行时不可用。"
                )
            duration_ms = int(probe_duration(managed))
            report = measure_quality(managed)
            if duration_ms <= 0:
                raise ContentEngineError(
                    "music_analysis_failed", "授权音乐时长无效。"
                )
            loop_start = contract["loop_start_ms"]
            loop_end = contract["loop_end_ms"]
            if loop_end is not None and int(loop_end) > duration_ms:
                raise ContentEngineError(
                    "music_loop_invalid", "音乐循环点超出真实音频时长。"
                )
        except ContentEngineError as error:
            analysis_status = "failed"
            analysis_error_code = str(error.code or "music_analysis_failed")[:64]
            duration_ms = max(0, duration_ms)
            report = {}
        track_id = _stable_id("music_track", fingerprint)
        now = self._now()
        self.connection.execute(
            """
            INSERT INTO music_catalog_tracks_v1(
                id, display_name, managed_relative_path, fingerprint, source,
                commercial_scope, commercial_use_allowed, license_status, expires_at,
                credential_reference, evidence_digest,
                managed_evidence_relative_path, duration_ms, bpm,
                moods_json, energy, integrated_lufs, true_peak_dbtp,
                loop_start_ms, loop_end_ms, analysis_status,
                analysis_error_code, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                display_name = excluded.display_name,
                source = excluded.source,
                commercial_scope = excluded.commercial_scope,
                commercial_use_allowed = excluded.commercial_use_allowed,
                license_status = excluded.license_status,
                expires_at = excluded.expires_at,
                credential_reference = excluded.credential_reference,
                evidence_digest = excluded.evidence_digest,
                managed_evidence_relative_path = excluded.managed_evidence_relative_path,
                duration_ms = excluded.duration_ms,
                bpm = excluded.bpm,
                moods_json = excluded.moods_json,
                energy = excluded.energy,
                integrated_lufs = excluded.integrated_lufs,
                true_peak_dbtp = excluded.true_peak_dbtp,
                loop_start_ms = excluded.loop_start_ms,
                loop_end_ms = excluded.loop_end_ms,
                analysis_status = excluded.analysis_status,
                analysis_error_code = excluded.analysis_error_code,
                updated_at = excluded.updated_at
            """,
            (
                track_id,
                contract["display_name"],
                str(relative),
                fingerprint,
                contract["source"],
                contract["commercial_scope"],
                int(contract["commercial_use_allowed"]),
                contract["license_status"],
                contract["expires_at"],
                contract["credential_reference"],
                evidence_digest,
                str(evidence_relative) if evidence_relative is not None else None,
                duration_ms,
                contract["bpm"],
                self._json(contract["moods"]),
                contract["energy"],
                report.get("integrated_lufs"),
                report.get("true_peak_dbtp"),
                contract["loop_start_ms"],
                contract["loop_end_ms"],
                analysis_status,
                analysis_error_code,
                now,
                now,
            ),
        )
        row = self.connection.execute(
            "SELECT * FROM music_catalog_tracks_v1 WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        return self._public_music_catalog_row(row)

    def preview_music_catalog_track(self, track_id):
        from .music_preview import preview_music_catalog_track
        return preview_music_catalog_track(self, track_id)

    def list_music_catalog_tracks(self):
        rows = self.connection.execute(
            "SELECT * FROM music_catalog_tracks_v1 ORDER BY updated_at DESC, id"
        ).fetchall()
        return {"items": [self._public_music_catalog_row(row) for row in rows]}

    def _public_music_catalog_row(self, row):
        managed_audio_valid = self._managed_file_digest_matches(
            row["managed_relative_path"], row["fingerprint"]
        )
        try:
            moods = json.loads(row["moods_json"] or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            moods = []
        result = public_music_track(
            {
                "track_id": row["id"],
                "display_name": row["display_name"],
                "source": row["source"],
                "commercial_scope": row["commercial_scope"],
                "commercial_use_allowed": bool(row["commercial_use_allowed"]),
                "license_status": row["license_status"],
                "expires_at": row["expires_at"],
                "evidence_present": bool(
                    row["credential_reference"]
                    and self._managed_file_digest_matches(
                        row["managed_evidence_relative_path"],
                        row["evidence_digest"],
                    )
                ),
                "bpm": row["bpm"],
                "moods": moods if isinstance(moods, list) else [],
                "energy": row["energy"],
            }
        )
        result.update(
            {
                "durationMs": int(row["duration_ms"] or 0),
                "integratedLufs": row["integrated_lufs"],
                "truePeakDbtp": row["true_peak_dbtp"],
                "loop": (
                    {
                        "startMs": row["loop_start_ms"],
                        "endMs": row["loop_end_ms"],
                    }
                    if row["loop_start_ms"] is not None
                    and row["loop_end_ms"] is not None
                    else None
                ),
                "analysisStatus": (
                    row["analysis_status"] if managed_audio_valid else "failed"
                ),
                "analysisErrorCode": (
                    row["analysis_error_code"]
                    if managed_audio_valid
                    else "music_managed_audio_invalid"
                ),
            }
        )
        return result

    def _select_auto_mix_music(self, brief, *, required_duration_ms, excluded_id="",
                               allowed_track_ids=None, prefer_unused_track_ids=()):
        tracks = [
            item
            for item in self._music_catalog_rows()
            if not excluded_id or item["track_id"] != excluded_id
        ]
        selected = select_licensed_music(
            tracks, brief, required_duration_ms=required_duration_ms,
            allowed_track_ids=allowed_track_ids, prefer_unused_track_ids=prefer_unused_track_ids,
        )
        if selected is None:
            return None
        path = (self.data_dir / selected["managed_relative_path"]).resolve()
        if self.data_dir not in path.parents or not path.is_file():
            return None
        return selected

    def _reusable_auto_mix_music(self, private_state, brief, *, required_duration_ms):
        previous = private_state.get("music_track")
        if not isinstance(previous, dict):
            return None
        track_id = str(previous.get("track_id") or "")
        allowed_ids = private_state.get("music_track_ids")
        if (not track_id or private_state.get("excluded_music_track_id") == track_id
                or (allowed_ids is not None and track_id not in allowed_ids)):
            return None
        matching = [
            item for item in self._music_catalog_rows() if item["track_id"] == track_id
        ]
        selected = select_licensed_music(
            matching, brief, required_duration_ms=required_duration_ms,
            allowed_track_ids=allowed_ids,
        )
        if selected is None:
            return None
        path = (self.data_dir / selected["managed_relative_path"]).resolve()
        if self.data_dir not in path.parents or not path.is_file():
            return None
        return selected

    @staticmethod
    def _auto_mix_visual_events(items, duration_ms, *, timeline=None):
        duration_ms = max(1, int(duration_ms))
        events = []
        callouts = [
            item for item in items or [] if str(item.get("type") or "") == "callout"
        ]
        evidence_intervals = {}
        for segment in (
            timeline.get("selected_segments") or []
            if isinstance(timeline, dict)
            else []
        ):
            if not isinstance(segment, dict):
                continue
            start_ms = max(0, int(segment.get("timeline_start_ms") or 0))
            end_ms = min(
                duration_ms, int(segment.get("timeline_end_ms") or 0)
            )
            if end_ms <= start_ms:
                continue
            keys = {
                str(segment.get("evidence_ref") or "").strip(),
                str(segment.get("segment_id") or "").strip(),
            }
            for key in keys:
                if key:
                    evidence_intervals.setdefault(key, []).append((start_ms, end_ms))
        resolved_callouts = []
        callout_totals = {}
        for item in callouts:
            references = [
                str(reference or "").strip()
                for reference in item.get("evidenceRefs")
                or item.get("evidence_refs")
                or []
                if str(reference or "").strip()
            ]
            keys = []
            for reference in references:
                key = reference.split(":", 1)[0]
                if key and key not in keys:
                    keys.append(key)
            evidence_key = next(
                (key for key in keys if evidence_intervals.get(key)), ""
            )
            if not evidence_key:
                raise ContentEngineError(
                    "auto_mix_material_evidence_missing",
                    "画面卖点文字没有对应的最终素材镜头。",
                )
            resolved_callouts.append((evidence_key, references))
            callout_totals[evidence_key] = callout_totals.get(evidence_key, 0) + 1
        callout_seen = {}
        callout_index = 0
        for index, item in enumerate(items or []):
            item_type = str(item.get("type") or "")
            if item_type == "hook":
                start, end = 0, duration_ms if duration_ms <= 20_000 else min(duration_ms, 7_000)
                event_type, zone, size, priority = "hook", "top_banner", "hero", 3
            elif item_type == "cta":
                cta_span = min(4_000, max(900, duration_ms // 5))
                start, end = max(0, duration_ms - cta_span), duration_ms
                event_type, zone, size, priority = "result", "middle_right", "card", 3
            else:
                evidence_key, evidence_refs = resolved_callouts[callout_index]
                callout_index += 1
                ordinal = callout_seen.get(evidence_key, 0)
                callout_seen[evidence_key] = ordinal + 1
                intervals = evidence_intervals[evidence_key]
                interval_start, interval_end = intervals[ordinal % len(intervals)]
                base_display_ms = min(
                    2_500, max(700, duration_ms // max(3, len(callouts) + 2))
                )
                display_ms = min(base_display_ms, interval_end - interval_start)
                slot = (ordinal + 1) / max(
                    2, callout_totals[evidence_key] + 1
                )
                center = interval_start + int((interval_end - interval_start) * slot)
                start = min(
                    max(interval_start, center - display_ms // 2),
                    interval_end - display_ms,
                )
                end = start + display_ms
                event_type, zone, size, priority = "keyword", "upper_left", "card", 2
            if end > start:
                event = {
                        "type": event_type,
                        "text": str(item.get("text") or "")[:48],
                        "start_ms": start,
                        "end_ms": end,
                        "zone": zone,
                        "size": size,
                        "priority": priority,
                        "reason": item_type,
                        "ordinal": index + 1,
                    }
                if item_type == "callout":
                    event["evidenceRefs"] = evidence_refs
                events.append(event)
        return events

    @staticmethod
    def _append_guided_supplemental_image_visual(
        visual_segments, supplemental_image, duration_ms
    ):
        """Reserve a small ending beat for one non-evidence 9:16 image.

        The image is optional and never replaces a material segment. We only
        take time from the final real segment when it has enough source window
        left, keeping the total duration and material evidence timing stable.
        """
        if not isinstance(supplemental_image, dict) or not visual_segments:
            return None
        operation_id = str(supplemental_image.get("operation_id") or "")
        managed_image_id = str(supplemental_image.get("managed_image_id") or "")
        image_digest = str(supplemental_image.get("image_digest") or "")
        if (
            not re.fullmatch(
                r"guided_auto_mix_supplemental_image_[a-f0-9]{32}", operation_id
            )
            or managed_image_id
            != f"guided_auto_mix_supplemental_image:{operation_id}"
            or not re.fullmatch(r"[a-f0-9]{64}", image_digest)
        ):
            return None
        final = visual_segments[-1]
        try:
            target_duration_ms = int(final["target_duration_ms"])
            source_start_ms = int(final["start_ms"])
            source_end_ms = int(final["end_ms"])
        except (KeyError, TypeError, ValueError):
            return None
        source_duration_ms = source_end_ms - source_start_ms
        if target_duration_ms < 3_200 or source_duration_ms < 3_200:
            return None
        image_duration_ms = min(3_000, target_duration_ms - 800)
        if image_duration_ms < 1_200:
            return None
        remaining_duration_ms = target_duration_ms - image_duration_ms
        # Keep the original source/target ratio so the bounded clip remains a
        # real material window instead of replaying or stretching a frame.
        remaining_source_ms = max(
            1,
            min(
                source_duration_ms,
                round(source_duration_ms * remaining_duration_ms / target_duration_ms),
            ),
        )
        final["target_duration_ms"] = remaining_duration_ms
        final["end_ms"] = source_start_ms + remaining_source_ms
        visual_segments.append(
            {
                "role": "supplemental",
                "segment_id": f"supplemental:{operation_id}",
                "asset_id": managed_image_id,
                "start_ms": 0,
                "end_ms": 0,
                "target_duration_ms": image_duration_ms,
                "media_kind": "image",
                "non_evidence": True,
            }
        )
        return {
            "operation_id": operation_id,
            "asset_id": managed_image_id,
            "image_digest": image_digest,
            "mime_type": str(supplemental_image.get("mime_type") or ""),
            "duration_ms": image_duration_ms,
            "timeline_start_ms": max(0, int(duration_ms) - image_duration_ms),
        }

    def _auto_mix_recipe(self, run, public_plan, private_state, *, persona, music):
        timeline = private_state["material_timeline"]
        duration_ms = int(public_plan["speechCaptions"][-1]["end_ms"])
        if private_state.get("narrated_preserve_shot_duration"):
            duration_ms = int(timeline["selected_duration_ms"])
        visual_segments = [
            {
                "role": item.get("role") or "process",
                "segment_id": item["segment_id"],
                "asset_id": item["asset_id"],
                "start_ms": item["source_start_ms"],
                "end_ms": item["source_end_ms"],
                "target_duration_ms": item["target_duration_ms"],
                "media_kind": item["media_kind"],
            }
            for item in timeline.get("selected_segments") or []
        ]
        if not visual_segments:
            raise ContentEngineError(
                "auto_mix_material_unavailable", "没有合格的画面区间。"
            )
        supplemental_image = self._append_guided_supplemental_image_visual(
            visual_segments,
            private_state.get("guided_supplemental_image"),
            duration_ms,
        )
        visual_events = self._auto_mix_visual_events(
            public_plan.get("visualTextItems") or [],
            duration_ms,
            timeline=timeline,
        )
        if supplemental_image is not None:
            supplemental_start_ms = supplemental_image["timeline_start_ms"]
            # Callouts require real-material evidence. A generic CTA may be
            # shown over the ending assist image, but a factual callout may not.
            visual_events = [
                {
                    **event,
                    "end_ms": min(int(event["end_ms"]), supplemental_start_ms),
                }
                if event.get("reason") == "callout"
                and int(event.get("end_ms") or 0) > supplemental_start_ms
                else event
                for event in visual_events
            ]
            visual_events = [
                event
                for event in visual_events
                if int(event.get("end_ms") or 0) > int(event.get("start_ms") or 0)
            ]
        music_brief = public_plan.get("musicBrief") or {}
        recipe = {
            "kind": "mix",
            **({"narrated_preserve_shot_duration": True} if private_state.get("narrated_preserve_shot_duration") else {}),
            "layout": "product_showcase",
            "product_workflow": "one_click_v2",
            "spec_version": AUTO_MIX_SPEC_VERSION,
            "audio_mode": "tts_only",
            "voice_audio_path": private_state["voice_audio_path"],
            "voice_audio_digest": private_state["voice_audio_digest"],
            "licensed_music_relative_path": music["managed_relative_path"],
            "licensed_music": {
                "duration_ms": int(music.get("duration_ms") or 0),
                "loop_start_ms": music.get("loop_start_ms"),
                "loop_end_ms": music.get("loop_end_ms"),
            },
            "voice_persona_id": persona["id"],
            "music_track_id": music["track_id"],
            **({"music_track_ids": list(private_state["music_track_ids"])}
               if private_state.get("music_track_ids") is not None else {}),
            "voice_segment": {
                "asset_id": visual_segments[0]["asset_id"],
                "start_ms": 0,
                "end_ms": duration_ms,
            },
            "visual_segments": visual_segments,
            "captions": public_plan["speechCaptions"],
            **({"caption_presentation": "reference_narration"}
               if private_state.get("narrated_reference_captions") else {}),
            "subtitle_style": {
                "preset": "dynamic_clean",
                "font_size": 52,
                "margin_bottom": 220,
                "max_chars": 14,
            },
            "packaging": {
                "mode": "auto",
                "preset_id": "auto_mix_v2",
                "subtitle": {
                    "preset": "dynamic_clean",
                    "font_size": 52,
                    "margin_bottom": 220,
                    "max_chars": 14,
                },
                "effects": {},
                "audio": {
                    "speech_music_margin_lu": 10.0,
                    "intro_delay_ms": int(
                        music_brief.get("introDelayMs") or 0
                    ),
                    "energy_curve": music_brief.get("energyCurve") or [],
                    "transition_points_ms": music_brief.get("transitionPointsMs")
                    or [],
                    "music_section_hints": music_brief.get("musicSectionHints")
                    or [],
                    "bpm_range": music_brief.get("bpmRange") or [],
                },
                "events": visual_events,
                "cover": {"mode": "local_frame", "status": "pending"},
                "visualRenderer": {
                    "requestedEngine": "remotion",
                    "visualStyleId": "social_pop",
                    "requestedStyleVersion": 1,
                    "allowFallback": False,
                },
            },
        }
        if private_state.get("narrated_brand"):
            recipe["packaging"]["brand"] = private_state["narrated_brand"]
            recipe["packaging"]["brand_profile_id"] = private_state["narrated_brand"].get("brand_profile_id")
        if supplemental_image is not None:
            recipe["supplemental_image"] = supplemental_image
        recipe["skeleton_id"] = self._skeleton_id(recipe)
        return recipe

    # ------------------------------------------------------------------
    # 商品展示“一键成片”
    # ------------------------------------------------------------------
    def create_one_click_project(
        self,
        name,
        asset_ids,
        *,
        brief=None,
        ratio="9:16",
        duration_ms=75_000,
        target_count=3,
        cover_mode="ai_generate",
        bgm_asset_id=None,
    ):
        safe_ids = self._validate_asset_ids(asset_ids)
        if not safe_ids:
            raise ContentEngineError("invalid_product_assets", "请至少选择一条商品素材。")
        if any(self._asset_row(asset_id)["media_kind"] not in {"image", "video"} for asset_id in safe_ids):
            raise ContentEngineError("invalid_product_assets", "商品一键成片只接受图片或视频素材。")
        safe_bgm = str(bgm_asset_id or "").strip() or None
        if safe_bgm and self._asset_row(safe_bgm)["media_kind"] != "audio":
            raise ContentEngineError("invalid_product_bgm", "背景音乐必须是音频素材。")
        if str(ratio or "9:16") != "9:16":
            raise ContentEngineError("invalid_product_ratio", "商品一键成片首版只支持 9:16 竖屏。")
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or not 60_000 <= duration_ms <= 90_000:
            raise ContentEngineError("invalid_product_duration", "商品成片时长必须在 60～90 秒之间。")
        target_count = self._validate_count(target_count, maximum=3)
        safe_name = self._validate_text(name or "商品展示一键成片", "product_project_name", 100)
        safe_brief = normalize_product_context(brief)
        # Decide the final audio route after each asset has been analysed:
        # source speech is preserved, while pure material may receive TTS.
        voice_mode = "auto"
        settings = {
            "workflow": "product_one_click",
            "asset_ids": safe_ids,
            "ratio": "9:16",
            "duration_ms": duration_ms,
            "target_count": target_count,
            "cover_mode": str(cover_mode or "ai_generate"),
            "bgm_asset_id": safe_bgm,
            "brief": safe_brief,
            "packaging_mode": "auto",
            "product_assets": [],
            "product_script": None,
            "copy_mode": "ai_auto",
            "voice_mode": voice_mode,
            "voice_status": "pending",
        }
        project_id = self._new_id("creative_project")
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO creative_projects(
                    id, mode, name, theme, settings_json, created_at, updated_at
                ) VALUES (?, 'mix', ?, ?, ?, ?, ?)
                """,
                (project_id, safe_name, str(safe_brief.get("product_name") or safe_name)[:100], self._json(settings), now, now),
            )
        return self.get_project(project_id)

    def create_product_asset_analysis_task(self, project_id):
        project = self._product_project_settings(project_id)
        return self._create_task("product_asset_analysis", {"project_id": project_id, "asset_ids": project["asset_ids"]})

    def create_product_copy_task(self, project_id, brief=None):
        project = self._product_project_settings(project_id)
        return self._create_task(
            "product_copy",
            {"project_id": project_id, "brief": sanitize_public_value(brief if isinstance(brief, dict) else project.get("brief") or {})},
        )

    def create_product_voice_task(self, project_id, script_id=None):
        self._product_project_settings(project_id)
        return self._create_task("product_voice", {"project_id": project_id, "script_id": script_id})

    def create_product_generation_task(self, project_id, options=None):
        project = self._product_project_settings(project_id)
        options = options if isinstance(options, dict) else {}
        duration_ms = int(options.get("duration_ms") or project.get("duration_ms") or 75_000)
        if duration_ms < 60_000 or duration_ms > 90_000:
            raise ContentEngineError("invalid_product_duration", "商品成片时长必须在 60～90 秒之间。")
        target_count = self._validate_count(
            int(options.get("target_count") or project.get("target_count") or 3),
            maximum=3,
        )
        return self._create_task(
            "product_generation",
            {
                "project_id": project_id,
                "target_count": target_count,
                "duration_ms": duration_ms,
                "cover_mode": str(options.get("cover_mode") or project.get("cover_mode") or "ai_generate"),
            },
        )

    def _product_project_settings(self, project_id):
        row = self._project_row(project_id)
        settings = json.loads(row["settings_json"] or "{}")
        if settings.get("workflow") != "product_one_click":
            raise ContentEngineError("invalid_product_project", "这不是商品展示一键成片项目。")
        return settings

    def preflight_visual_comparison(self, source_candidate_id):
        prepared = self._prepare_visual_comparison(source_candidate_id)
        return prepared["public"]

    def create_visual_comparison_task(self, source_candidate_id):
        prepared = self._prepare_visual_comparison(source_candidate_id)
        preflight = prepared["public"]
        if not preflight["eligible"]:
            raise ContentEngineError(
                preflight["reason"], "当前候选不满足三风格对照的本地预检条件。"
            )
        source = prepared["source"]
        source_recipe = prepared["recipe"]
        frozen = prepared["frozen"]
        capability = prepared["capability"]
        task_id = self._new_id("task")
        now = self._now()
        created_ids = []
        entries = []
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'creative_visual_comparison', 'queued', '{}', ?, ?)
                """,
                (task_id, now, now),
            )
            latest = connection.execute(
                """
                SELECT MAX(generation) FROM generated_videos
                WHERE project_id = ? AND selection_signature = ?
                """,
                (source["project_id"], source["selection_signature"]),
            ).fetchone()[0]
            next_generation = max(int(source["generation"]), int(latest or 0)) + 1
            for index, style_id in enumerate(VISUAL_COMPARISON_STYLE_IDS):
                recipe = json.loads(self._json(source_recipe))
                packaging = recipe["packaging"]
                cover = packaging["cover"]
                cover.update(
                    {
                        "mode": "reuse",
                        "status": "reused",
                        "source_generated_video_id": source["id"],
                        "content_digest": frozen["cover_digest"],
                    }
                )
                seed = _canonical_hash(
                    {
                        "comparisonGroupId": task_id,
                        "sourceCandidateId": source["id"],
                        "styleId": style_id,
                    }
                )
                visual = {
                    "requestedEngine": "remotion",
                    "visualStyleId": style_id,
                    "requestedStyleVersion": VISUAL_STYLE_VERSION,
                    "deterministicSeed": seed,
                    "semanticPlanHash": frozen["semantic_plan_hash"],
                    "comparisonGroupId": task_id,
                    "sourceCandidateId": source["id"],
                    "allowFallback": False,
                    "layoutPolicyVersion": VISUAL_LAYOUT_POLICY_VERSION,
                    "layoutHash": frozen["layout_hash"],
                    "styleContractHash": _canonical_hash(
                        {"styleId": style_id, "version": VISUAL_STYLE_VERSION}
                    ),
                    "requestedBundleHash": capability["bundle_hash"],
                    "requestedRuntimeHash": capability["runtime_hash"],
                }
                visual["renderRequestHash"] = self._render_request_hash(visual)
                packaging["visualRenderer"] = visual
                generation = next_generation + index
                video_id = self._insert_generated(
                    source["project_id"],
                    task_id,
                    source["kind"],
                    recipe,
                    json.loads(source["score_json"]),
                    source["title"],
                    source["duration_ms"],
                    recommended=False,
                    signature=source["selection_signature"],
                    generation=generation,
                )
                created_ids.append(video_id)
                entries.append(
                    {
                        "candidate_id": video_id,
                        "source_candidate_id": source["id"],
                        "generation": generation,
                        "order": index,
                        "style_id": style_id,
                        "style_version": VISUAL_STYLE_VERSION,
                        "deterministic_seed": seed,
                        "semantic_plan_hash": frozen["semantic_plan_hash"],
                        "content_snapshot_hash": frozen["content_snapshot_hash"],
                        "cover_digest": frozen["cover_digest"],
                        "layout_hash": frozen["layout_hash"],
                        "style_contract_hash": visual["styleContractHash"],
                        "bundle_hash": capability["bundle_hash"],
                        "runtime_hash": capability["runtime_hash"],
                        "render_request_hash": visual["renderRequestHash"],
                    }
                )
            payload = {
                "version": 1,
                "comparison_group_id": task_id,
                "source_candidate_id": source["id"],
                "source_project_id": source["project_id"],
                "style_order": list(VISUAL_COMPARISON_STYLE_IDS),
                "render_count": 3,
                "bailian_calls": 0,
                "apimart_calls": 0,
                "runtime_hash": capability["runtime_hash"],
                "bundle_hash": capability["bundle_hash"],
                "frozen_content": frozen["content_snapshot"],
                "content_snapshot_hash": frozen["content_snapshot_hash"],
                "entries": entries,
            }
            connection.execute(
                "UPDATE content_tasks SET payload_json = ?, updated_at = ? WHERE id = ?",
                (self._json(payload), now, task_id),
            )
        return {
            **self._public_task(self._task_row(task_id)),
            "generated_video_ids": created_ids,
        }

    def _prepare_visual_comparison(self, source_candidate_id):
        capability = self._visual_comparison_capability()
        public = {
            "eligible": False,
            "reason": "source_candidate_not_found",
            "renderCount": 3,
            "bailianCalls": 0,
            "apimartCalls": 0,
            "remotionAvailable": capability["remotion_available"],
            "visualComparisonAvailable": capability["available"],
        }
        try:
            source = self._generated_row(source_candidate_id)
        except ContentEngineError:
            return {"public": public}
        if source["status"] != "completed":
            public["reason"] = "source_candidate_not_completed"
            return {"public": public}
        try:
            video_path = self._validate_generated_path(source["output_path"])
        except (ContentEngineError, OSError, RuntimeError, TypeError):
            public["reason"] = "source_video_missing"
            return {"public": public}
        if not video_path.is_file():
            public["reason"] = "source_video_missing"
            return {"public": public}
        try:
            cover_path = self._validate_generated_path(source["thumbnail_path"])
        except (ContentEngineError, OSError, RuntimeError, TypeError):
            public["reason"] = "source_cover_missing"
            return {"public": public}
        if not cover_path.is_file():
            public["reason"] = "source_cover_missing"
            return {"public": public}
        cover_operation = self.connection.execute(
            """
            SELECT status, provider, external_task_id
            FROM cover_generation_ledger
            WHERE generated_video_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (source["id"],),
        ).fetchone()
        if (
            cover_operation is None
            or cover_operation["status"] != "completed"
            or str(cover_operation["provider"] or "") != "apimart_gpt_image_2"
            or not str(cover_operation["external_task_id"] or "").strip()
        ):
            public["reason"] = "source_ai_cover_not_verified"
            public["aiCoverVerified"] = False
            return {"public": public}
        public["aiCoverVerified"] = True
        phone_review = self.connection.execute(
            """
            SELECT verdict, media_digest
            FROM creative_media_reviews
            WHERE generated_video_id = ? AND device = 'phone'
            ORDER BY reviewed_at DESC, rowid DESC LIMIT 1
            """,
            (source["id"],),
        ).fetchone()
        if phone_review is None or phone_review["verdict"] != "pass":
            public["reason"] = "phone_review_required"
            public["phoneReviewed"] = False
            return {"public": public}
        try:
            if phone_review["media_digest"] != self._sha256_file(video_path):
                public["reason"] = "phone_review_stale"
                public["phoneReviewed"] = False
                return {"public": public}
        except OSError:
            public["reason"] = "source_video_missing"
            return {"public": public}
        public["phoneReviewed"] = True
        try:
            recipe = json.loads(source["recipe_json"])
        except (TypeError, ValueError):
            public["reason"] = "motion_plan_missing"
            return {"public": public}
        visual = (recipe.get("packaging") or {}).get("visualRenderer")
        if (
            not isinstance(visual, dict)
            or visual.get("requestedEngine") != "remotion"
            or visual.get("allowFallback") is not False
            or visual.get("actualEngine") != "remotion"
        ):
            public["reason"] = "source_remotion_acceptance_required"
            public["remotionAccepted"] = False
            return {"public": public}
        public["remotionAccepted"] = True
        reason = self._validate_comparison_recipe(recipe)
        if reason:
            public["reason"] = reason
            return {"public": public}
        if not capability["remotion_available"]:
            public["reason"] = "remotion_capability_unavailable"
            return {"public": public}
        if not capability["runtime_hash"]:
            public["reason"] = "comparison_runtime_hash_unavailable"
            return {"public": public}
        if not capability["bundle_hash"]:
            public["reason"] = "comparison_bundle_hash_unavailable"
            return {"public": public}
        frozen = self._comparison_frozen_snapshot(recipe, cover_path)
        public.update({"eligible": True, "reason": "ready"})
        return {
            "public": public,
            "source": source,
            "recipe": recipe,
            "capability": capability,
            "frozen": frozen,
        }

    def _visual_comparison_capability(self):
        try:
            capability = self.renderer.capability
        except Exception:
            capability = {}
        capability = capability if isinstance(capability, dict) else {}
        remotion = capability.get("remotion")
        remotion = remotion if isinstance(remotion, dict) else {}

        def first(*keys):
            for container in (remotion, capability):
                for key in keys:
                    if key in container:
                        value = _opaque_capability_value(container.get(key))
                        if value:
                            return value
            return None

        remotion_available = bool(
            capability.get("remotion_packaging_v1") and remotion.get("available")
        )
        runtime_hash = first("runtime_hash", "runtimeHash", "manifest_hash", "manifestHash")
        bundle_hash = first("bundle_hash", "bundleHash")
        runtime_binds_bundle = bool(
            remotion.get("runtime_hash_includes_bundle")
            or capability.get("runtime_hash_includes_bundle")
        )
        if not bundle_hash and runtime_binds_bundle:
            bundle_hash = runtime_hash
        normalized = {
            "available": bool(remotion_available and runtime_hash and bundle_hash),
            "renderer_available": bool(capability.get("available")),
            "remotion_available": remotion_available,
            "runtime_hash": runtime_hash,
            "bundle_hash": bundle_hash,
        }
        self._visual_capability_snapshot = normalized
        return dict(normalized)

    @staticmethod
    def _unavailable_visual_capability():
        return {
            "available": False,
            "renderer_available": False,
            "remotion_available": False,
            "runtime_hash": None,
            "bundle_hash": None,
        }

    def _visual_comparison_capability_snapshot(self):
        return dict(self._visual_capability_snapshot)

    def _validate_comparison_recipe(self, recipe):
        if not isinstance(recipe, dict):
            return "motion_plan_missing"
        voice = recipe.get("voice_segment")
        if not isinstance(voice, dict):
            return "motion_plan_timing_invalid"
        try:
            voice_start = int(voice.get("start_ms"))
            voice_end = int(voice.get("end_ms"))
        except (TypeError, ValueError):
            return "motion_plan_timing_invalid"
        duration = voice_end - voice_start
        if duration <= 0:
            return "motion_plan_timing_invalid"
        plan = recipe.get("motion_director")
        if not isinstance(plan, dict):
            return "motion_plan_missing"
        try:
            plan_version = int(plan.get("version"))
        except (TypeError, ValueError):
            return "motion_plan_version_unsupported"
        if plan_version != 1:
            return "motion_plan_version_unsupported"
        if not str(plan.get("provider") or "").strip():
            return "motion_plan_missing"
        raw_events = plan.get("events")
        if not isinstance(raw_events, list) or not raw_events:
            return "motion_plan_evidence_invalid"
        for event in raw_events:
            if not isinstance(event, dict):
                return "motion_plan_evidence_invalid"
            try:
                start_ms = int(event.get("start_ms"))
                end_ms = int(event.get("end_ms"))
            except (TypeError, ValueError):
                return "motion_plan_timing_invalid"
            if start_ms < 0 or end_ms <= start_ms or end_ms > duration:
                return "motion_plan_timing_invalid"
            if (
                str(event.get("type") or "") not in MOTION_EVENT_TYPES
                or not str(event.get("text") or "").strip()
                or not str(event.get("reason") or "").strip()
            ):
                return "motion_plan_evidence_invalid"
            if (
                str(event.get("zone") or "") not in MOTION_LAYOUT_ZONES
                or str(event.get("size") or "") not in MOTION_EVENT_SIZES
            ):
                return "layout_unavailable"
        captions = recipe.get("captions")
        if not isinstance(captions, list) or not captions:
            return "motion_plan_evidence_invalid"
        for caption in captions:
            try:
                start_ms = int(caption.get("start_ms"))
                end_ms = int(caption.get("end_ms"))
            except (AttributeError, TypeError, ValueError):
                return "motion_plan_timing_invalid"
            if (
                not str(caption.get("text") or "").strip()
                or start_ms < voice_start
                or end_ms <= start_ms
                or end_ms > voice_end
            ):
                return "motion_plan_timing_invalid"
        packaging = recipe.get("packaging")
        if not isinstance(packaging, dict):
            return "layout_unavailable"
        director = packaging.get("director")
        try:
            director_version = int(director.get("version") or 0)
        except (AttributeError, TypeError, ValueError):
            director_version = 0
        if (
            not isinstance(director, dict)
            or director_version != plan_version
            or str(director.get("provider") or "")
            != str(plan.get("provider") or "")
        ):
            return "motion_plan_incompatible"
        laid_out = [
            item
            for item in packaging.get("events") or []
            if isinstance(item, dict) and str(item.get("text") or "").strip()
        ]
        if not laid_out:
            return "layout_unavailable"
        for event in laid_out:
            try:
                start_ms = int(event.get("start_ms"))
                end_ms = int(event.get("end_ms"))
            except (TypeError, ValueError):
                return "layout_unavailable"
            if (
                str(event.get("zone") or "") not in MOTION_LAYOUT_ZONES
                or str(event.get("size") or "") not in MOTION_EVENT_SIZES
                or start_ms < 0
                or end_ms <= start_ms
                or end_ms > duration
            ):
                return "layout_unavailable"
        raw_text = {str(item.get("text") or "").strip() for item in raw_events}
        if not any(str(item.get("text") or "").strip() in raw_text for item in laid_out):
            return "motion_plan_incompatible"
        asset_ids = {
            str(item.get("asset_id") or "")
            for item in recipe.get("visual_segments") or []
            if isinstance(item, dict) and item.get("asset_id")
        }
        if voice.get("asset_id"):
            asset_ids.add(str(voice["asset_id"]))
        if not asset_ids:
            return "source_material_unavailable"
        try:
            for asset_id in asset_ids:
                self._resolve_asset_path(asset_id)
        except ContentEngineError:
            return "source_material_unavailable"
        return None

    @staticmethod
    def _render_request_hash(visual):
        immutable_keys = (
            "requestedEngine",
            "visualStyleId",
            "requestedStyleVersion",
            "deterministicSeed",
            "semanticPlanHash",
            "comparisonGroupId",
            "sourceCandidateId",
            "allowFallback",
            "layoutPolicyVersion",
            "layoutHash",
            "styleContractHash",
            "requestedBundleHash",
            "requestedRuntimeHash",
        )
        return _canonical_hash({key: visual.get(key) for key in immutable_keys})

    def _comparison_frozen_snapshot(self, recipe, cover_path):
        content_snapshot = self._comparison_content_snapshot(recipe)
        packaging = recipe["packaging"]
        layout = {
            "policy_version": VISUAL_LAYOUT_POLICY_VERSION,
            "events": [
                {
                    key: item.get(key)
                    for key in ("type", "start_ms", "end_ms", "zone", "size", "priority")
                }
                for item in packaging.get("events") or []
                if isinstance(item, dict) and item.get("text")
            ],
            "focus_rects": packaging.get("focus_rects") or [],
            "protected_rects": packaging.get("protected_rects") or [],
        }
        semantic_plan = {
            "captions": content_snapshot["captions"],
            "events": content_snapshot["events"],
            "motion_director": content_snapshot["motion_director"],
            "voice_timecodes": content_snapshot["voice_timecodes"],
            "visual_timecodes": content_snapshot["visual_timecodes"],
            "audio": content_snapshot["audio"],
        }
        return {
            "content_snapshot": content_snapshot,
            "content_snapshot_hash": _canonical_hash(content_snapshot),
            "semantic_plan_hash": _canonical_hash(semantic_plan),
            "layout_hash": _canonical_hash(layout),
            "cover_digest": self._sha256_file(cover_path),
        }

    def _comparison_content_snapshot(self, recipe):
        packaging = recipe["packaging"]
        content_snapshot = {
            "captions": json.loads(self._json(recipe.get("captions") or [])),
            "events": json.loads(self._json(packaging.get("events") or [])),
            "motion_director": json.loads(self._json(recipe["motion_director"])),
            "voice_timecodes": json.loads(self._json(recipe.get("voice_segment") or {})),
            "visual_timecodes": json.loads(self._json(recipe.get("visual_segments") or [])),
            "audio": json.loads(self._json(packaging.get("audio") or {})),
            "subtitle": json.loads(self._json(recipe.get("subtitle_style") or {})),
        }
        return content_snapshot

    @staticmethod
    def _sha256_file(path):
        digest = hashlib.sha256()
        with Path(path).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _file_digest_matches(self, path, expected_digest):
        expected = str(expected_digest or "").strip().casefold()
        if not re.fullmatch(r"[a-f0-9]{64}", expected):
            return False
        try:
            return self._sha256_file(path) == expected
        except OSError:
            return False

    def _managed_file_digest_matches(self, relative_path, expected_digest):
        relative = str(relative_path or "").strip()
        if not relative:
            return False
        try:
            managed = (self.data_dir / relative).resolve(strict=True)
        except (OSError, RuntimeError):
            return False
        if self.data_dir not in managed.parents or not managed.is_file():
            return False
        return self._file_digest_matches(managed, expected_digest)

    def _valid_voice_preview(self, path, expected_digest):
        if not self._file_digest_matches(path, expected_digest):
            return False
        try:
            self._wav_duration_ms(path)
            return True
        except ContentEngineError:
            return False

    def run_task(self, task_id):
        task = self._task_row(task_id)
        if task["task_type"] not in CREATIVE_TASK_TYPES:
            raise ContentEngineError("invalid_task_type", "This is not a creative task.")
        if task["status"] in {"completed", "failed", "cancelled"}:
            return self._public_task(task)
        if task["status"] == "paused":
            return self._public_task(task)
        payload = json.loads(task["payload_json"])
        if not self._set_task(
            task_id, "analyzing", progress=max(float(task["progress"]), 0.01)
        ):
            return self._public_task(self._task_row(task_id))
        try:
            if task["task_type"] == "narrated_batch_v1":
                from .narrated_batch import NarratedBatchDomain
                result = NarratedBatchDomain(self).run(task_id, payload)
            elif task["task_type"] == "creative_analysis":
                result = self._run_analysis(task_id, payload)
            elif task["task_type"] == "guided_auto_mix_analysis":
                result = self._run_guided_auto_mix_analysis(task_id, payload)
            elif task["task_type"] == "guided_auto_mix_draft":
                result = self._run_guided_auto_mix_draft(task_id, payload)
            elif task["task_type"] == "guided_auto_mix_supplemental_image":
                result = self._run_guided_auto_mix_supplemental_image_task(
                    task_id, payload
                )
            elif task["task_type"] == "course_generation":
                result = self._run_course(task_id, payload)
            elif task["task_type"] == "mix_generation":
                result = self._run_mix(task_id, payload)
            elif task["task_type"] == "creative_packaging":
                result = self._run_packaging(task_id, payload)
            elif task["task_type"] == "creative_cover":
                result = self._run_cover(task_id, payload)
            elif task["task_type"] == "creative_visual_comparison":
                result = self._run_visual_comparison(task_id, payload)
            elif task["task_type"] == "product_asset_analysis":
                result = self._run_product_asset_analysis(task_id, payload)
            elif task["task_type"] == "product_copy":
                result = self._run_product_copy(task_id, payload)
            elif task["task_type"] == "product_voice":
                result = self._run_product_voice(task_id, payload)
            elif task["task_type"] == "product_generation":
                result = self._run_product_generation(task_id, payload)
            elif task["task_type"] in {
                "auto_mix_v2_generation",
                "auto_mix_v2_regeneration",
            }:
                result = self._run_auto_mix_v2(task_id, payload)
            else:
                result = self._run_regeneration(task_id, payload)
            state = self._task_status(task_id)
            if state in {"paused", "cancelled"}:
                self._sync_stopped_project(payload.get("project_id"), state)
                return self._public_task(self._task_row(task_id))
            if not self._set_task(task_id, "completed", progress=1, result=result):
                state = self._task_status(task_id)
                self._sync_stopped_project(payload.get("project_id"), state)
                return self._public_task(self._task_row(task_id))
            project_id = payload.get("project_id")
            if project_id:
                self._update_project(
                    project_id, "completed", result=sanitize_public_value(result)
                )
                self._register_finished_for_project(project_id, task_id)
            return self._public_task(self._task_row(task_id))
        except ContentEngineError as error:
            state = self._task_status(task_id)
            if task["task_type"] in {
                "auto_mix_v2_generation",
                "auto_mix_v2_regeneration",
            }:
                self._fail_auto_mix_run(payload.get("run_id"), error.code)
            elif task["task_type"] in {
                "guided_auto_mix_analysis",
                "guided_auto_mix_draft",
            } and state not in {"paused", "cancelled"}:
                if error.code in {
                    "cloud_request_failed",
                    "cloud_response_invalid",
                }:
                    self._transition_guided_auto_mix_task_session(
                        task_id,
                        task["task_type"],
                        payload.get("session_id"),
                        "outcome_unknown",
                    )
                elif (
                    task["task_type"] == "guided_auto_mix_draft"
                    and error.code == "product_copy_invalid"
                ):
                    self._transition_guided_auto_mix_task_session(
                        task_id,
                        task["task_type"],
                        payload.get("session_id"),
                        "ready_for_answers",
                    )
                else:
                    self._transition_guided_auto_mix_task_session(
                        task_id,
                        task["task_type"],
                        payload.get("session_id"),
                        "failed",
                    )
            if (
                error.code in RECOVERABLE_COMPARISON_ERROR_CODES
                and state not in {"cancelled", "completed", "failed"}
            ):
                if state != "paused":
                    self._pause_task_for_local_recovery(task_id, error)
                return self._public_task(self._task_row(task_id))
            if (
                error.code in RECOVERABLE_COVER_ERROR_CODES
                and state not in {"cancelled", "completed", "failed"}
            ):
                if state != "paused":
                    self._pause_task_for_cover_recovery(task_id, payload, error)
                else:
                    self._sync_stopped_project(payload.get("project_id"), state)
                return self._public_task(self._task_row(task_id))
            if state not in {"paused", "cancelled"}:
                updated = self._set_task(
                    task_id,
                    "failed",
                    error_code=error.code,
                    error_message=error.message,
                )
                if updated and payload.get("project_id"):
                    self._update_project(
                        payload["project_id"],
                        "failed",
                        result=self._project_failure_result(
                            payload["project_id"], error.code
                        ),
                    )
                elif not updated:
                    self._sync_stopped_project(
                        payload.get("project_id"), self._task_status(task_id)
                    )
            else:
                self._sync_stopped_project(payload.get("project_id"), state)
            return self._public_task(self._task_row(task_id))
        except Exception as error:
            state = self._task_status(task_id)
            if task["task_type"] in {
                "auto_mix_v2_generation",
                "auto_mix_v2_regeneration",
            }:
                self._fail_auto_mix_run(payload.get("run_id"), "creative_task_failed")
            elif task["task_type"] in {
                "guided_auto_mix_analysis",
                "guided_auto_mix_draft",
            } and state not in {"paused", "cancelled"}:
                self._transition_guided_auto_mix_task_session(
                    task_id,
                    task["task_type"],
                    payload.get("session_id"),
                    "failed",
                )
            if state not in {"paused", "cancelled"}:
                updated = self._set_task(
                    task_id,
                    "failed",
                    error_code="creative_task_failed",
                    error_message=redact_text(str(error))[:500],
                )
                if updated and payload.get("project_id"):
                    self._update_project(
                        payload["project_id"],
                        "failed",
                        result=self._project_failure_result(
                            payload["project_id"], "creative_task_failed"
                        ),
                    )
                elif not updated:
                    self._sync_stopped_project(
                        payload.get("project_id"), self._task_status(task_id)
                    )
            else:
                self._sync_stopped_project(payload.get("project_id"), state)
            return self._public_task(self._task_row(task_id))

    def _run_visual_comparison(self, task_id, payload):
        entries = payload.get("entries") if isinstance(payload, dict) else None
        if not isinstance(entries, list) or len(entries) != len(VISUAL_COMPARISON_STYLE_IDS):
            raise ContentEngineError(
                "comparison_contract_invalid", "三风格对照任务清单无效。"
            )
        if [entry.get("style_id") for entry in entries] != list(
            VISUAL_COMPARISON_STYLE_IDS
        ):
            raise ContentEngineError(
                "comparison_contract_invalid", "三风格对照顺序已发生变化。"
            )
        if (
            payload.get("comparison_group_id") != task_id
            or _canonical_hash(payload.get("frozen_content"))
            != payload.get("content_snapshot_hash")
        ):
            raise ContentEngineError(
                "comparison_contract_invalid", "三风格对照冻结内容已发生变化。"
            )
        completed = 0
        for entry in entries:
            if self._should_stop(task_id):
                break
            row = self._generated_row(entry.get("candidate_id"))
            self._validate_comparison_candidate(task_id, payload, entry, row)
            if self._comparison_candidate_complete(row):
                completed += 1
                continue
            self._require_frozen_comparison_runtime(payload)
            self._require_frozen_comparison_cover(payload)
            if not self._set_task(
                task_id, "rendering", progress=completed / len(entries)
            ):
                break
            rendered = self._render_generated(row["id"], task_id=task_id)
            if not rendered:
                if self._generated_row(row["id"])["status"] == "completed":
                    completed += 1
                break
            completed += 1
            self._set_task(
                task_id, "rendering", progress=completed / len(entries)
            )
        return {
            "comparison_group_id": payload.get("comparison_group_id"),
            "source_candidate_id": payload.get("source_candidate_id"),
            "generated_video_ids": [entry.get("candidate_id") for entry in entries],
            "completed_count": completed,
            "render_count": len(entries),
            "bailian_calls": 0,
            "apimart_calls": 0,
        }

    def _require_frozen_comparison_runtime(self, payload):
        capability = self._visual_comparison_capability()
        runtime_hash = _opaque_capability_value(payload.get("runtime_hash"))
        bundle_hash = _opaque_capability_value(payload.get("bundle_hash"))
        if not capability["remotion_available"] or not capability["runtime_hash"]:
            raise ContentEngineError(
                "comparison_runtime_hash_unavailable", "原三风格运行时当前不可用。"
            )
        if capability["runtime_hash"] != runtime_hash:
            raise ContentEngineError(
                "comparison_runtime_hash_mismatch", "运行时版本已变化，任务已暂停。"
            )
        if not capability["bundle_hash"]:
            raise ContentEngineError(
                "comparison_bundle_hash_unavailable", "原三风格模板包当前不可用。"
            )
        if capability["bundle_hash"] != bundle_hash:
            raise ContentEngineError(
                "comparison_bundle_hash_mismatch", "模板包版本已变化，任务已暂停。"
            )

    def _require_frozen_comparison_cover(self, payload):
        source_id = payload.get("source_candidate_id")
        try:
            source = self._generated_row(source_id)
            cover = self._validate_generated_path(source["thumbnail_path"])
            current_digest = self._sha256_file(cover)
        except (ContentEngineError, OSError, RuntimeError, TypeError):
            raise ContentEngineError(
                "comparison_cover_unavailable", "原对照封面当前不可用。"
            ) from None
        expected = {
            entry.get("cover_digest")
            for entry in payload.get("entries") or []
            if isinstance(entry, dict)
        }
        if len(expected) != 1 or current_digest not in expected:
            raise ContentEngineError(
                "comparison_cover_changed", "原对照封面已发生变化。"
            )

    def _validate_comparison_candidate(self, task_id, payload, entry, row):
        if row["task_id"] != task_id:
            raise ContentEngineError(
                "comparison_contract_invalid", "对照候选不属于当前任务。"
            )
        try:
            recipe = json.loads(row["recipe_json"])
            visual = recipe["packaging"]["visualRenderer"]
            content_hash = _canonical_hash(self._comparison_content_snapshot(recipe))
        except (KeyError, TypeError, ValueError):
            raise ContentEngineError(
                "comparison_contract_invalid", "对照候选配方无效。"
            ) from None
        expected = {
            "comparisonGroupId": task_id,
            "sourceCandidateId": payload.get("source_candidate_id"),
            "visualStyleId": entry.get("style_id"),
            "requestedStyleVersion": entry.get("style_version"),
            "renderRequestHash": entry.get("render_request_hash"),
            "requestedRuntimeHash": payload.get("runtime_hash"),
            "requestedBundleHash": payload.get("bundle_hash"),
        }
        if any(visual.get(key) != value for key, value in expected.items()):
            raise ContentEngineError(
                "comparison_contract_invalid", "对照候选不可变渲染意图已变化。"
            )
        if (
            visual.get("allowFallback") is not False
            or self._render_request_hash(visual) != visual.get("renderRequestHash")
            or content_hash != entry.get("content_snapshot_hash")
            or content_hash != payload.get("content_snapshot_hash")
        ):
            raise ContentEngineError(
                "comparison_contract_invalid", "对照候选非视觉内容已发生变化。"
            )

    def _comparison_candidate_complete(self, row):
        if row["status"] != "completed":
            return False
        try:
            video = self._validate_generated_path(row["output_path"])
            cover = self._validate_generated_path(row["thumbnail_path"])
        except (ContentEngineError, OSError, RuntimeError, TypeError):
            return False
        return video.is_file() and cover.is_file()

    def _run_analysis(self, task_id, payload):
        asset_ids = self._validate_asset_ids(payload.get("asset_ids"))
        profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
        skippable_errors = (
            PRODUCT_SKIPPABLE_ANALYSIS_ERRORS
            if profile.get("workflow") == "auto_mix_v2"
            else SKIPPABLE_ANALYSIS_ERRORS
        )
        analyzed = 0
        skipped_assets = []
        for index, asset_id in enumerate(asset_ids):
            if self._should_stop(task_id):
                break
            try:
                completed = self._analyze_asset(task_id, asset_id, profile)
            except ContentEngineError as error:
                if error.code not in skippable_errors:
                    raise
                skipped_assets.append(
                    {
                        "asset_id": asset_id,
                        "error_code": error.code,
                        "message": redact_text(error.message),
                    }
                )
                completed = None
            if completed is False:
                break
            if completed:
                analyzed += 1
            self._set_task(
                task_id,
                "analyzing",
                progress=(index + 1) / max(1, len(asset_ids)),
            )
        if not analyzed and skipped_assets and not self._should_stop(task_id):
            raise ContentEngineError(
                "all_assets_unavailable",
                "所有选中的素材都无法完成分析，请更换素材或检查视频文件。",
            )
        return {
            "analyzed_count": analyzed,
            "requested_count": len(asset_ids),
            "skipped_assets": skipped_assets,
            "provider": self.analyzer.capability.get("provider", "local"),
            "cloud_configured": bool(
                self.analyzer.capability.get("cloud_configured", False)
            ),
        }

    def _run_guided_auto_mix_analysis(self, task_id, payload):
        session = self._guided_auto_mix_session_row(payload.get("session_id"))
        if session["status"] != "analyzing":
            raise ContentEngineError(
                "guided_auto_mix_analysis_stale", "这次素材解析已被新的操作替代。"
            )
        asset_ids = self._guided_auto_mix_asset_ids(session)
        if asset_ids != self._validate_asset_ids(payload.get("asset_ids")):
            raise ContentEngineError(
                "guided_auto_mix_assets_changed", "素材选择已变更，请重新开始解析。"
            )
        if not self._guided_auto_mix_snapshot_matches(session):
            raise ContentEngineError(
                "guided_auto_mix_assets_changed", "素材已变更，请重新开始解析。"
            )
        profile = self._json_object(session["analysis_profile_json"])
        analysis = self._run_analysis(
            task_id, {"asset_ids": asset_ids, "profile": profile}
        )
        if self._should_stop(task_id):
            return analysis
        if not self._guided_auto_mix_snapshot_matches(session):
            raise ContentEngineError(
                "guided_auto_mix_assets_changed", "素材在解析期间发生变化，请重新解析。"
            )
        analysis_versions = self._guided_auto_mix_analysis_versions(asset_ids, profile)
        summary = self._guided_auto_mix_summary(asset_ids, analysis_versions)
        cursor = self.connection.execute(
            """
            UPDATE guided_auto_mix_sessions_v1
            SET status = 'ready_for_answers', analysis_versions_json = ?,
                analysis_summary_json = ?, updated_at = ?
            WHERE id = ? AND status = 'analyzing' AND analysis_task_id = ?
            """,
            (
                self._json(analysis_versions),
                self._json(summary),
                self._now(),
                session["id"],
                task_id,
            ),
        )
        if not cursor.rowcount:
            return analysis
        self._set_task(task_id, "analyzing", progress=0.95)
        return {
            **analysis,
            "session_id": session["id"],
            "selected_duration_ms": int(summary["selected_duration_ms"]),
            "selected_segment_count": int(summary["selected_segment_count"]),
        }

    @staticmethod
    def _guided_auto_mix_script_assets(timeline):
        by_asset = {}
        for segment in timeline.get("selected_segments") or []:
            if not isinstance(segment, dict):
                continue
            asset_id = str(segment.get("asset_id") or "").strip()
            if not asset_id:
                continue
            item = by_asset.setdefault(
                asset_id,
                {
                    "asset_id": asset_id,
                    "media_kind": str(segment.get("media_kind") or "video"),
                    "asset_tags": [],
                    "visual_evidence": [],
                    "transcript_evidence": [],
                },
            )
            for tag in segment.get("tags") or []:
                text = str(tag or "").strip()
                if text and text not in item["asset_tags"]:
                    item["asset_tags"].append(text[:40])
            for key, target in (
                ("description", "visual_evidence"),
                ("verifiable_text", "transcript_evidence"),
            ):
                text = str(segment.get(key) or "").strip()
                if text and text not in item[target]:
                    item[target].append(text[:240])
        return [
            {
                **item,
                "asset_tags": item["asset_tags"][:12],
                "visual_evidence": item["visual_evidence"][:6],
                "transcript_evidence": item["transcript_evidence"][:6],
            }
            for item in by_asset.values()
        ]

    @staticmethod
    def _guided_auto_mix_estimated_voiceover_ms(char_count):
        safe_count = max(0, int(char_count or 0))
        if not safe_count:
            return 0
        phrase_count = max(1, math.ceil(safe_count / AUTO_MIX_CAPTION_CHARS))
        return (
            safe_count * GUIDED_AUTO_MIX_ESTIMATED_CHAR_MS
            + max(0, phrase_count - 1) * GUIDED_AUTO_MIX_ESTIMATED_PAUSE_MS
        )

    @classmethod
    def _guided_auto_mix_duration_plan(cls, timeline):
        material_ms = max(0, int(timeline.get("selected_duration_ms") or 0))
        if material_ms < GUIDED_AUTO_MIX_MIN_DURATION_MS:
            raise ContentEngineError(
                "auto_mix_material_too_short",
                "可用素材不足以承载自然口播，请补充素材后重新生成脚本。",
            )
        # Keep a small real-material margin for natural TTS timing variance.
        # The rendered video must still end with the actual narration; it must
        # never trim sentences or pad the timeline just to meet a target.
        target_duration_ms = min(
            material_ms,
            GUIDED_AUTO_MIX_MAX_TARGET_DURATION_MS,
            max(
                GUIDED_AUTO_MIX_MIN_DURATION_MS,
                int(material_ms * GUIDED_AUTO_MIX_SOURCE_HEADROOM_RATIO),
            ),
        )
        max_chars = max(
            (
                char_count
                for char_count in range(8, 261)
                if cls._guided_auto_mix_estimated_voiceover_ms(char_count)
                <= target_duration_ms
            ),
            default=0,
        )
        if max_chars < 8:
            raise ContentEngineError(
                "auto_mix_material_too_short",
                "可用素材不足以承载一句自然口播，请补充素材后重新生成脚本。",
            )
        minimum_target_ms = int(
            target_duration_ms * GUIDED_AUTO_MIX_TARGET_MIN_RATIO
        )
        min_chars = next(
            (
                char_count
                for char_count in range(8, max_chars + 1)
                if cls._guided_auto_mix_estimated_voiceover_ms(char_count)
                >= minimum_target_ms
            ),
            max_chars,
        )
        return {
            "policy": "auto",
            "material_capacity_ms": material_ms,
            "target_duration_ms": target_duration_ms,
            "minimum_duration_ms": cls._guided_auto_mix_estimated_voiceover_ms(
                min_chars
            ),
            "maximum_duration_ms": cls._guided_auto_mix_estimated_voiceover_ms(
                max_chars
            ),
            "voiceover_min_chars": min_chars,
            "voiceover_max_chars": max_chars,
            "voiceover_min_sentence_count": max(
                2, min(10, math.ceil(target_duration_ms / 6_500))
            ),
        }

    @staticmethod
    def _guided_auto_mix_duration_plan_value(value):
        if not isinstance(value, dict):
            raise ContentEngineError(
                "guided_auto_mix_duration_plan_missing",
                "当前脚本没有自动时长规划，请重新生成 AI 脚本。",
            )
        try:
            material_capacity_ms = int(value.get("material_capacity_ms") or 0)
            target_duration_ms = int(value.get("target_duration_ms") or 0)
            minimum_duration_ms = int(value.get("minimum_duration_ms") or 0)
            maximum_duration_ms = int(value.get("maximum_duration_ms") or 0)
            voiceover_min_chars = int(value.get("voiceover_min_chars") or 0)
            voiceover_max_chars = int(value.get("voiceover_max_chars") or 0)
            voiceover_min_sentence_count = int(
                value.get("voiceover_min_sentence_count") or 0
            )
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "guided_auto_mix_duration_plan_missing",
                "当前脚本的自动时长规划无效，请重新生成 AI 脚本。",
            ) from error
        if not (
            value.get("policy") == "auto"
            and GUIDED_AUTO_MIX_MIN_DURATION_MS
            <= target_duration_ms
            <= GUIDED_AUTO_MIX_MAX_TARGET_DURATION_MS
            and target_duration_ms <= material_capacity_ms
            and 0 < minimum_duration_ms <= maximum_duration_ms <= target_duration_ms
            and 8 <= voiceover_min_chars <= voiceover_max_chars <= 260
            and 2 <= voiceover_min_sentence_count <= 10
        ):
            raise ContentEngineError(
                "guided_auto_mix_duration_plan_missing",
                "当前脚本的自动时长规划无效，请重新生成 AI 脚本。",
            )
        return {
            "policy": "auto",
            "material_capacity_ms": material_capacity_ms,
            "target_duration_ms": target_duration_ms,
            "minimum_duration_ms": minimum_duration_ms,
            "maximum_duration_ms": maximum_duration_ms,
            "voiceover_min_chars": voiceover_min_chars,
            "voiceover_max_chars": voiceover_max_chars,
            "voiceover_min_sentence_count": voiceover_min_sentence_count,
        }

    @classmethod
    def _guided_auto_mix_public_duration_plan(cls, value):
        try:
            plan = cls._guided_auto_mix_duration_plan_value(value)
        except ContentEngineError:
            return None
        return {
            "policy": plan["policy"],
            "material_capacity_ms": plan["material_capacity_ms"],
            "target_duration_ms": plan["target_duration_ms"],
            "minimum_duration_ms": plan["minimum_duration_ms"],
            "maximum_duration_ms": plan["maximum_duration_ms"],
        }

    @classmethod
    def _guided_auto_mix_voiceover_max_chars(cls, timeline):
        return cls._guided_auto_mix_duration_plan(timeline)["voiceover_max_chars"]

    @classmethod
    def _guided_auto_mix_tracks(
        cls, title, script, timeline, evidence_facts, duration_plan
    ):
        references = []
        for segment in timeline.get("selected_segments") or []:
            if not isinstance(segment, dict):
                continue
            value = str(segment.get("evidence_ref") or "").strip()
            if value and value not in references:
                references.append(value)
        if not references:
            for fact in evidence_facts or []:
                if not isinstance(fact, dict):
                    continue
                for reference in fact.get("evidenceRefs") or []:
                    value = str(reference or "").strip()
                    if value and value not in references:
                        references.append(value)
        if not references:
            raise ContentEngineError(
                "auto_mix_material_evidence_missing", "素材缺少可追溯的画面引用。"
            )
        voiceover = re.sub(r"\s+", " ", str(script.get("voiceover") or "")).strip()
        if not voiceover:
            raise ContentEngineError(
                "guided_auto_mix_script_invalid", "AI 脚本缺少可用于配音的正文。"
            )
        compact_voiceover = re.sub(r"\s+", "", voiceover)
        voiceover_chars = len(compact_voiceover)
        sentence_count = len(
            [item for item in re.split(r"[。！？!?；;]+|\n+", voiceover) if item.strip()]
        )
        if voiceover_chars < duration_plan["voiceover_min_chars"] or sentence_count < duration_plan["voiceover_min_sentence_count"]:
            raise ContentEngineError(
                "guided_auto_mix_script_too_short",
                "AI 脚本过短，未达到本次素材的自动时长规划；请重新生成 AI 脚本。",
            )
        if voiceover_chars > duration_plan["voiceover_max_chars"]:
            raise ContentEngineError(
                "guided_auto_mix_script_too_long",
                "脚本超过当前素材可承载的口播时长，请补充素材后重新生成。",
            )
        estimated_ms = cls._guided_auto_mix_estimated_voiceover_ms(voiceover_chars)
        if not (
            duration_plan["minimum_duration_ms"]
            <= estimated_ms
            <= duration_plan["maximum_duration_ms"]
        ):
            raise ContentEngineError(
                "guided_auto_mix_script_duration_invalid",
                "AI 脚本未落在本次素材的自动时长范围内，请重新生成 AI 脚本。",
            )
        hook = re.sub(r"\s+", " ", str(script.get("hook") or "")).strip()[:80]
        cta = re.sub(r"\s+", " ", str(script.get("cta") or "")).strip()[:80]
        audience_issue = guided_script_audience_copy_issue(hook, voiceover, cta)
        if audience_issue:
            raise ContentEngineError(
                "product_copy_invalid", f"百炼脚本不适合直接成片：{audience_issue}。"
            )
        raw_tracks = {
            "spoken_phrases": [{"text": voiceover, "evidence_refs": references}],
            "visual_text_items": [
                {"type": "hook", "text": title},
                {
                    "type": "callout",
                    "text": hook,
                    "evidence_refs": references,
                },
                {"type": "cta", "text": cta},
            ],
        }
        tracks = normalize_text_tracks(raw_tracks)
        if len(tracks["spoken_phrases"]) > AUTO_MIX_MAX_TTS_PHRASES:
            raise ContentEngineError(
                "guided_auto_mix_script_too_long",
                "脚本分段过多，无法在本次成片中稳定合成，请缩短后重新生成。",
            )
        return {
            **tracks,
            "evidence_facts": list(evidence_facts or []),
        }

    def _run_guided_auto_mix_draft(self, task_id, payload):
        session = self._guided_auto_mix_session_row(payload.get("session_id"))
        if session["status"] != "drafting":
            raise ContentEngineError(
                "guided_auto_mix_draft_stale", "这次脚本生成已被新的操作替代。"
            )
        if not self._guided_auto_mix_snapshot_matches(session):
            raise ContentEngineError(
                "guided_auto_mix_assets_changed", "素材已变更，请重新解析后再生成脚本。"
            )
        title = self._validate_text(
            payload.get("title"), "guided_auto_mix_title", 100
        )
        answers = self._guided_auto_mix_answers(payload.get("answers"))
        analysis = self._json_object(session["analysis_summary_json"])
        timeline = analysis.get("material_timeline")
        facts = analysis.get("evidence_facts")
        if not isinstance(timeline, dict) or not isinstance(facts, list):
            raise ContentEngineError(
                "guided_auto_mix_analysis_missing", "素材解析结果不完整，请重新解析。"
            )
        assets = self._guided_auto_mix_script_assets(timeline)
        if not assets:
            raise ContentEngineError(
                "auto_mix_material_unavailable", "没有可用于脚本的素材画面。"
            )
        try:
            duration_plan = self._guided_auto_mix_duration_plan_value(
                analysis.get("duration_plan")
            )
        except ContentEngineError:
            # Sessions created before automatic duration planning still retain
            # their verified timeline, so refresh the plan without requiring a
            # user to upload or analyze the same media again.
            duration_plan = self._guided_auto_mix_duration_plan(timeline)
        brief = {
            "product_name": answers["productName"],
            "brand_name": answers["companyName"],
            "target_customer": answers["targetScene"],
            "selling_points": answers["keyMessage"],
            "must_include": answers["extraNotes"],
            "guided_storyboard": True,
            "voiceover_min_chars": duration_plan["voiceover_min_chars"],
            "voiceover_max_chars": duration_plan["voiceover_max_chars"],
            "voiceover_min_sentence_count": duration_plan[
                "voiceover_min_sentence_count"
            ],
            "target_duration_ms": duration_plan["target_duration_ms"],
            "guided_answer_policy": (
                "company_name、product_name、target_customer、selling_points 和 "
                "must_include 来自用户确认；产品参数、效果和画面事实仍只能写已提供素材。"
            ),
        }
        cloud = getattr(self.analyzer, "cloud_client", None)
        generator = getattr(cloud, "generate_product_script", None)
        if not callable(generator) or not getattr(cloud, "configured", False):
            raise ContentEngineError(
                "cloud_not_configured",
                "一键成片脚本必须由百炼生成，请先配置百炼 API Key 后重试。",
            )
        script = generator(brief, assets, count=1)
        if self._should_stop(task_id):
            return {"session_id": session["id"]}
        if not isinstance(script, dict):
            raise ContentEngineError(
                "product_copy_invalid", "百炼脚本生成结果格式无效，请重新生成。"
            )
        if str(script.get("provider") or "").strip() != "bailian":
            raise ContentEngineError(
                "product_copy_invalid", "百炼没有返回可确认的脚本，请重新生成。"
            )
        mismatch = product_script_mismatch_reason(script, brief)
        if mismatch:
            raise ContentEngineError(
                "product_copy_invalid",
                "百炼脚本与已确认的产品名称不一致，请重新生成或修改产品名称。",
            )
        if self._should_stop(task_id):
            return {"session_id": session["id"]}
        tracks = self._guided_auto_mix_tracks(
            title, script, timeline, facts, duration_plan
        )
        previous = self._json_object(session["draft_json"])
        revision = max(0, int(previous.get("revision") or 0)) + 1
        public_script = {
            "provider": "bailian",
            "hook": str(script.get("hook") or "").strip()[:80],
            "voiceover": "".join(
                str(item.get("text") or "")
                for item in tracks.get("spoken_phrases") or []
            )[:2_400],
            "cta": str(script.get("cta") or "").strip()[:80],
            "spokenPhrases": [
                {"text": str(item.get("text") or "")[:80]}
                for item in tracks.get("spoken_phrases") or []
            ],
            "visualTextItems": [
                {
                    "type": str(item.get("type") or "")[:24],
                    "text": str(item.get("text") or "")[:80],
                }
                for item in tracks.get("visual_text_items") or []
            ],
        }
        draft = {
            "revision": revision,
            "title": title,
            "script": public_script,
            "text_tracks": tracks,
            "duration_plan": duration_plan,
        }
        draft_hash = auto_mix_canonical_hash(
            {
                "title": title,
                "answers": answers,
                "snapshots": self._json_array(session["asset_snapshot_json"]),
                "tracks": tracks,
                "duration_plan": duration_plan,
                "revision": revision,
            }
        )
        cursor = self.connection.execute(
            """
            UPDATE guided_auto_mix_sessions_v1
            SET status = 'ready_for_render', answers_json = ?, draft_json = ?,
                draft_hash = ?, updated_at = ?
            WHERE id = ? AND status = 'drafting' AND draft_task_id = ?
            """,
            (
                self._json(answers),
                self._json(draft),
                draft_hash,
                self._now(),
                session["id"],
                task_id,
            ),
        )
        if not cursor.rowcount:
            return {"session_id": session["id"]}
        self._set_task(task_id, "analyzing", progress=0.95)
        return {
            "session_id": session["id"],
            "script_revision": revision,
            "provider": public_script["provider"],
            "spoken_phrase_count": len(public_script["spokenPhrases"]),
        }

    def _analyze_asset(
        self, task_id, asset_id, profile=None, *, return_analysis_version=False
    ):
        asset = self._asset_row(asset_id)
        source = self._resolve_asset_path(asset_id)
        effective_profile = profile if isinstance(profile, dict) else {}
        if not effective_profile.get("provider"):
            effective_profile = {
                **effective_profile,
                "provider": self.analyzer.capability.get("provider", "local"),
            }
        outcome = self.analyzer.analyze(
            asset=asset,
            source_path=source,
            task_id=task_id,
            profile=effective_profile,
            should_stop=lambda: self._should_stop(task_id),
        )
        if outcome.get("stopped") or self._should_stop(task_id):
            return "" if return_analysis_version else False
        version = str(outcome.get("analysis_version") or "")
        if not version:
            raise ContentEngineError("analysis_failed", "Analysis version is missing.")
        existing_count = self.connection.execute(
            "SELECT COUNT(*) FROM media_segments WHERE asset_id = ? AND analysis_version = ?",
            (asset_id, version),
        ).fetchone()[0]
        has_new_segment = any(
            int(item.get("end_ms") or 0) > int(item.get("start_ms") or 0)
            for item in outcome.get("segments") or []
            if isinstance(item, dict)
        )
        if (
            return_analysis_version
            and not has_new_segment
            and not (outcome.get("reuse_existing") and existing_count)
        ):
            raise ContentEngineError(
                "analysis_failed",
                "素材分析没有生成当前版本的可用片段。",
            )
        if outcome.get("reuse_existing") and existing_count:
            self.connection.execute(
                "UPDATE media_segments SET updated_at = ? WHERE asset_id = ? AND analysis_version = ?",
                (self._now(), asset_id, version),
            )
            return version if return_analysis_version else True
        now = self._now()
        derivative_ids = {}
        with self.database.transaction() as connection:
            for item in outcome.get("derivatives") or []:
                relative_path = self._validate_derivative_path(item.get("relative_path"))
                kind = str(item.get("kind") or "")
                ordinal = int(item.get("ordinal") or 0)
                derivative_id = _stable_id(
                    "derivative", asset_id, kind, ordinal, version
                )
                derivative_ids[(kind, ordinal)] = derivative_id
                connection.execute(
                    """
                    INSERT INTO asset_derivatives(
                        id, asset_id, derivative_kind, ordinal, config_hash,
                        relative_path, status, metadata_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
                    ON CONFLICT(asset_id, derivative_kind, ordinal, config_hash)
                    DO UPDATE SET relative_path = excluded.relative_path,
                                  status = 'ready',
                                  metadata_json = excluded.metadata_json,
                                  updated_at = excluded.updated_at
                    """,
                    (
                        derivative_id,
                        asset_id,
                        kind,
                        ordinal,
                        version,
                        relative_path,
                        self._json(sanitize_public_value(item.get("metadata") or {})),
                        now,
                        now,
                    ),
                )
            for item in outcome.get("segments") or []:
                start = int(item.get("start_ms") or 0)
                end = int(item.get("end_ms") or 0)
                if end <= start:
                    continue
                role = str(item.get("role") or "general")
                if role not in {*ROLE_ORDER, "general"}:
                    role = "general"
                quality = min(1.0, max(0.0, float(item.get("quality_score") or 0)))
                metadata = sanitize_public_value(item.get("metadata") or {})
                thumbnail = derivative_ids.get(
                    ("keyframe", int(metadata.get("keyframe_ordinal") or 0))
                )
                segment_id = _stable_id("segment", asset_id, start, end, version)
                connection.execute(
                    """
                    INSERT INTO media_segments(
                        id, asset_id, start_ms, end_ms, transcript_text, speaker,
                        role, shot_type, tags_json, quality_score,
                        thumbnail_derivative_id, analysis_version, provider,
                        metadata_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(asset_id, start_ms, end_ms, analysis_version)
                    DO UPDATE SET transcript_text = excluded.transcript_text,
                                  speaker = excluded.speaker,
                                  role = excluded.role,
                                  shot_type = excluded.shot_type,
                                  tags_json = excluded.tags_json,
                                  quality_score = excluded.quality_score,
                                  thumbnail_derivative_id = excluded.thumbnail_derivative_id,
                                  provider = excluded.provider,
                                  metadata_json = excluded.metadata_json,
                                  updated_at = excluded.updated_at
                    """,
                    (
                        segment_id,
                        asset_id,
                        start,
                        end,
                        str(item.get("transcript") or "")[:5_000],
                        str(item.get("speaker") or "")[:100],
                        role,
                        str(item.get("shot_type") or "unknown")[:100],
                        self._json([str(tag)[:64] for tag in (item.get("tags") or [])[:20]]),
                        quality,
                        thumbnail,
                        version,
                        str(outcome.get("provider") or "local")[:64],
                        self._json(metadata),
                        now,
                        now,
                    ),
                )
        completed = not self._should_stop(task_id)
        if return_analysis_version:
            return version if completed else ""
        return completed

    def _run_course(self, task_id, payload):
        project_id = payload["project_id"]
        self._update_project(project_id, "analyzing")
        self._reconcile_project_rendering(project_id)
        asset_id = payload["asset_ids"][0]
        packaging_options = self._packaging_options_with_brand(payload)
        plan_rows = self._course_plan_rows(project_id)
        if not plan_rows:
            if not self._analyze_asset(task_id, asset_id):
                return {
                    "project_id": project_id,
                    "generated_count": self._completed_count(project_id),
                }
            segments = self._segments_for_assets([asset_id], transcript_only=True)
            if not segments:
                raise ContentEngineError(
                    "transcript_required",
                    "长课程精剪需要带时间戳的语音转写，请先配置百炼后重新分析。",
                )
            windows = self._course_windows(
                segments,
                int(payload["min_duration_ms"]),
                int(payload["max_duration_ms"]),
                int(payload["count"]),
                theme=self._project_theme(project_id),
                experiment_mode=payload.get("experiment_mode"),
            )
            if not windows:
                raise ContentEngineError(
                    "qualified_segments_missing", "没有找到满足时长与完整性要求的课程片段。"
                )
            requested_count = int(payload["count"])
            if (
                payload.get("experiment_mode") == "supoclip_bailian_v1"
                and len(windows) != requested_count
            ):
                raise ContentEngineError(
                    "insufficient_ai_candidates",
                    f"百炼本次只返回 {len(windows)} 条完整有效候选，需要 {requested_count} 条；本次未用本地评分补足。",
                )
            planned = []
            for index, window in enumerate(windows):
                title = self._course_title(window, index)
                recipe = self._course_recipe(
                    asset_id,
                    window,
                    subtitle_font_size=int(payload.get("subtitle_font_size") or 48),
                    subtitle_margin_bottom=int(
                        payload.get("subtitle_margin_bottom") or 170
                    ),
                    experiment_mode=payload.get("experiment_mode"),
                    subtitle_preset=payload.get("subtitle_preset") or "dynamic_clean",
                    include_word_timestamps=(
                        payload.get("packaging_mode", "auto") != "none"
                    ),
                )
                self._attach_packaging(
                    recipe,
                    kind="course",
                    title=title,
                    index=index,
                    options=packaging_options,
                )
                planned.append((window["signature"], window, title, recipe))
            motion_plans = self._motion_plans_for_recipes(
                task_id,
                payload,
                [(signature, recipe) for signature, _window, _title, recipe in planned],
            )
            for signature, _window, _title, recipe in planned:
                self._apply_recipe_motion_plan(recipe, motion_plans.get(signature))
            if self._should_stop(task_id):
                return {
                    "project_id": project_id,
                    "generated_count": self._completed_count(project_id),
                }

            # Persist content selection and AI direction before rendering. Resume
            # then remains local and cannot repeat either paid request.
            with self.database.transaction():
                for index, (_signature, window, title, recipe) in enumerate(planned):
                    score = with_virality_dimensions(window["score"], "course")
                    self._insert_generated(
                        project_id,
                        task_id,
                        "course",
                        recipe,
                        score,
                        title,
                        window["duration_ms"],
                        recommended=index < min(2, len(windows)),
                    )
            plan_rows = self._course_plan_rows(project_id)

        requested_count = int(payload["count"])
        if (
            payload.get("experiment_mode") == "supoclip_bailian_v1"
            and len(plan_rows) != requested_count
        ):
            raise ContentEngineError(
                "insufficient_ai_candidates",
                f"实验计划只有 {len(plan_rows)} 条，要求 {requested_count} 条；为避免重复扣费，本次不会重新选段。",
            )
        self._update_project(project_id, "rendering")
        self._set_task(task_id, "rendering", progress=0.45)
        for index, row in enumerate(plan_rows):
            if self._should_stop(task_id):
                break
            video_id = row["id"]
            rendered = self._render_generated(video_id, task_id=task_id)
            if not rendered:
                break
            self._execute_pending_cover_for_video(video_id, task_id=task_id)
            self._set_task(
                task_id,
                "rendering",
                progress=0.45 + 0.5 * (index + 1) / len(plan_rows),
            )
        completed = self._completed_count(project_id)
        completed_ids = [
            row["id"]
            for row in self._course_plan_rows(project_id)
            if row["status"] == "completed"
        ]
        return {
            "project_id": project_id,
            "generated_count": completed,
            "requested_count": requested_count,
            "recommended_count": min(2, completed),
            "generated_video_ids": completed_ids,
        }

    def _course_plan_rows(self, project_id):
        return self.connection.execute(
            """
            SELECT id, status FROM generated_videos
            WHERE project_id = ? AND generation = 1
            ORDER BY created_at, rowid
            """,
            (project_id,),
        ).fetchall()

    def _run_mix(self, task_id, payload):
        project_id = payload["project_id"]
        asset_ids = payload["asset_ids"]
        pilot_mode = bool(payload.get("pilot_mode"))
        packaging_options = self._packaging_options_with_brand(payload)
        self._update_project(project_id, "analyzing")
        self._reconcile_project_rendering(project_id)
        skipped_assets = []
        pilot_transcript_fallback = False
        for index, asset_id in enumerate(asset_ids):
            if self._should_stop(task_id):
                break
            try:
                completed = self._analyze_asset(task_id, asset_id)
            except ContentEngineError as error:
                if error.code not in SKIPPABLE_ANALYSIS_ERRORS:
                    raise
                skipped_assets.append(
                    {
                        "asset_id": asset_id,
                        "error_code": error.code,
                        "message": redact_text(error.message),
                    }
                )
                completed = None
            if completed is False:
                break
            self._set_task(
                task_id,
                "analyzing",
                progress=0.35 * (index + 1) / max(1, len(asset_ids)),
            )
        if self._should_stop(task_id):
            return {"project_id": project_id, "generated_count": self._completed_count(project_id)}
        threshold = float(payload.get("quality_threshold") or 0.55)
        pools = {
            role: [
                item
                for item in self._segments_for_assets(asset_ids, role=role)
                if item["quality_score"] >= threshold
            ]
            for role in ROLE_ORDER
        }
        missing_roles = [role for role, items in pools.items() if not items]
        voice_segments = self._segments_for_assets(
            [payload["voice_asset_id"]], transcript_only=True
        )
        if not voice_segments and pilot_mode:
            # A parseable upload may have visual segments but no usable
            # transcript yet. Keep trying for a first sample; strict mode
            # below still requires the normal teacher-voice contract.
            voice_segments = self._segments_for_assets([payload["voice_asset_id"]])
            if not voice_segments:
                voice_segments = self._pilot_asset_segment(payload["voice_asset_id"])
                pilot_transcript_fallback = bool(voice_segments)
        if missing_roles and pilot_mode:
            fallback_pool = self._segments_for_assets(asset_ids)
            known_assets = {item["asset_id"] for item in fallback_pool}
            for asset_id in asset_ids:
                if asset_id not in known_assets:
                    fallback_pool.extend(self._pilot_asset_segment(asset_id))
            fallback_pool = fallback_pool or list(voice_segments)
            for role in missing_roles:
                pools[role] = list(fallback_pool)
        if missing_roles and not pilot_mode:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, missing_roles, skipped_assets),
            )
            raise ContentEngineError(
                "qualified_segments_missing",
                f"合格素材不足，缺少：{', '.join(missing_roles)}。",
            )
        if not voice_segments:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, ["teacher_voice"], skipped_assets),
            )
            raise ContentEngineError(
                "transcript_required",
                "老师原声混剪需要带时间戳的语音转写，请先配置百炼后重新分析。",
            )
        target = int(payload["target_count"])
        backbone_count = max(3, math.ceil(target / 20))
        backbones = self._course_windows(voice_segments, 30_000, 90_000, backbone_count)
        if not backbones and pilot_mode:
            backbones = self._pilot_voice_backbones(
                voice_segments, payload["voice_asset_id"], backbone_count
            )
        if not backbones:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, ["teacher_voice"], skipped_assets),
            )
            raise ContentEngineError("qualified_segments_missing", "没有找到完整的老师原声观点。")
        raw_count = len(pools["hook"]) * len(pools["process"]) * len(pools["result"])
        inspected = 0
        maximum = 0
        project_theme = self._project_theme(project_id)

        def qualified_choices():
            nonlocal inspected, maximum
            for choice in itertools.product(*(pools[role] for role in ROLE_ORDER)):
                if inspected >= MAX_COMBINATION_INSPECTION:
                    return
                inspected += 1
                asset_choice = [item["asset_id"] for item in choice]
                segment_choice = [item["segment_id"] for item in choice]
                if len(set(segment_choice)) < len(segment_choice):
                    continue
                if (
                    not pilot_mode
                    and (asset_choice[0] == asset_choice[1] or asset_choice[1] == asset_choice[2])
                ):
                    continue
                maximum += 1
                signature = "|".join(item["segment_id"] for item in choice)
                rank = hashlib.sha256(
                    f"{project_theme}:{signature}".encode("utf-8")
                ).digest()
                yield rank, signature, choice

        selected = heapq.nsmallest(target, qualified_choices(), key=lambda item: item[:2])
        if not selected and pilot_mode:
            # A single uploaded video cannot satisfy the normal three-source
            # rule. Reuse distinct analyzed segments from that video for one
            # honest pilot candidate instead of failing before rendering.
            fallback_pool = []
            seen_segments = set()
            for role in ROLE_ORDER:
                for item in pools[role]:
                    if item["segment_id"] in seen_segments:
                        continue
                    seen_segments.add(item["segment_id"])
                    fallback_pool.append(item)
            if fallback_pool:
                choice = tuple(
                    fallback_pool[index % len(fallback_pool)] for index in range(3)
                )
                signature = "|".join(item["segment_id"] for item in choice)
                rank = hashlib.sha256(
                    f"{project_theme}:{signature}".encode("utf-8")
                ).digest()
                selected = [(rank, signature, choice)]
        count_is_exact = raw_count <= MAX_COMBINATION_INSPECTION
        if not selected:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(maximum, count_is_exact, [], skipped_assets),
            )
            raise ContentEngineError(
                "qualified_segments_missing", "当前素材没有满足镜头连续性要求的三段式组合。"
            )
        planning_entries = []
        if payload.get("packaging_mode", "auto") != "none":
            for index, backbone in enumerate(backbones):
                representative_choice = selected[index % len(selected)][2]
                planning_entries.append(
                    (
                        backbone["signature"],
                        (
                            self._pilot_broll_recipe(representative_choice)
                            if pilot_transcript_fallback
                            else self._mix_recipe(
                                backbone,
                                representative_choice,
                                include_word_timestamps=True,
                            )
                        ),
                    )
                )
        try:
            motion_plans = self._motion_plans_for_recipes(
                task_id, payload, planning_entries
            )
        except ContentEngineError:
            if not pilot_mode:
                raise
            # A first sample should still be viewable when the optional
            # semantic motion request fails. The local renderer will keep the
            # source audio/frames and simply omit AI event overlays.
            motion_plans = {}
        if self._should_stop(task_id):
            return {
                "project_id": project_id,
                "generated_count": self._completed_count(project_id),
            }
        self._update_project(project_id, "rendering")
        self._set_task(task_id, "rendering", progress=0.4)
        generated_ids = []
        skeleton_ids = set()
        for index, (_, signature, choice) in enumerate(selected):
            if self._should_stop(task_id):
                break
            backbone = backbones[index % len(backbones)]
            recipe = (
                self._pilot_broll_recipe(choice)
                if pilot_transcript_fallback
                else self._mix_recipe(
                    backbone,
                    choice,
                    include_word_timestamps=(
                        payload.get("packaging_mode", "auto") != "none"
                    ),
                )
            )
            title = f"{self._project_theme(project_id)}·混剪{index + 1}"
            self._attach_packaging(
                recipe,
                kind="mix",
                title=title,
                index=index,
                options=packaging_options,
            )
            self._apply_recipe_motion_plan(
                recipe, motion_plans.get(backbone["signature"])
            )
            if recipe.get("skeleton_id"):
                skeleton_ids.add(recipe["skeleton_id"])
            score = with_virality_dimensions(self._mix_score(choice, backbone), "mix")
            video_id = self._insert_generated(
                project_id,
                task_id,
                "mix",
                recipe,
                score,
                title,
                int(recipe["voice_segment"]["end_ms"])
                - int(recipe["voice_segment"].get("start_ms") or 0),
                recommended=False,
                signature=f"{backbone['signature']}|{signature}",
            )
            rendered = self._render_generated(video_id, task_id=task_id)
            if not rendered:
                break
            self._execute_pending_cover_for_video(video_id, task_id=task_id)
            generated_ids.append(video_id)
            self._set_task(
                task_id,
                "rendering",
                progress=0.4 + 0.55 * (index + 1) / max(1, len(selected)),
            )
        completed = self._completed_count(project_id)
        return {
            "project_id": project_id,
            "generated_count": completed,
            "requested_count": target,
            "raw_cartesian_count": raw_count,
            "maximum_qualified_count": maximum,
            "count_is_exact": count_is_exact,
            "missing_roles": missing_roles if pilot_mode else [],
            "pilot_mode": pilot_mode,
            "pilot_notice": (
                (
                    "试跑模式：百炼转写暂不可用，已保留原声先生成样片。"
                    if pilot_transcript_fallback
                    else "试跑模式：部分角色素材不足，已使用可用片段先生成样片。"
                )
                if pilot_mode and (missing_roles or pilot_transcript_fallback)
                else None
            ),
            "required_roles": list(ROLE_ORDER),
            "voice_backbone_count": len(backbones),
            "skeleton_ids": sorted(skeleton_ids),
            "skeleton_count": len(skeleton_ids),
            "generated_video_ids": generated_ids,
            "skipped_assets": skipped_assets,
        }

    def _product_settings(self, project_id):
        row = self._project_row(project_id)
        settings = json.loads(row["settings_json"] or "{}")
        if settings.get("workflow") != "product_one_click":
            raise ContentEngineError("invalid_product_project", "这不是商品展示一键成片项目。")
        return row, settings

    def _save_product_settings(self, project_id, settings):
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE creative_projects SET settings_json = ?, updated_at = ? WHERE id = ?",
                (self._json(settings), self._now(), project_id),
            )

    def _product_asset_cards(self, settings):
        rows = []
        for asset_id in settings.get("asset_ids") or []:
            try:
                row = self._asset_row(asset_id)
            except ContentEngineError:
                continue
            semantic_tags = []
            visual_evidence = []
            transcript_evidence = []
            transcript_segments = []
            audio_modes = []
            speech_statuses = []
            for segment in self.connection.execute(
                "SELECT tags_json, shot_type, role, metadata_json, transcript_text, start_ms, end_ms FROM media_segments WHERE asset_id = ? ORDER BY updated_at DESC LIMIT 80",
                (asset_id,),
            ).fetchall():
                raw_tags = []
                try:
                    raw_tags = json.loads(segment["tags_json"] or "[]")
                except (TypeError, ValueError, json.JSONDecodeError):
                    raw_tags = []
                metadata = {}
                try:
                    metadata = json.loads(segment["metadata_json"] or "{}")
                except (TypeError, ValueError, json.JSONDecodeError):
                    metadata = {}
                raw_tags.extend([segment["shot_type"], segment["role"]])
                for raw in raw_tags:
                    text = str(raw or "").casefold()
                    if any(token in text for token in ("close", "特写")):
                        semantic_tags.append("product_closeup")
                    elif any(token in text for token in ("detail", "细节")):
                        semantic_tags.append("product_detail")
                    elif any(token in text for token in ("scene", "场景", "环境")):
                        semantic_tags.append("use_scene")
                    elif any(token in text for token in ("function", "操作", "process", "过程")):
                        semantic_tags.append("function_demo")
                    elif any(token in text for token in ("result", "结果", "对比")):
                        semantic_tags.append("result")
                caption = str(metadata.get("visual_caption") or "").strip()
                if caption and caption not in visual_evidence:
                    visual_evidence.append(caption[:240])
                transcript = str(segment["transcript_text"] or "").strip()
                if transcript and transcript not in transcript_evidence:
                    transcript_evidence.append(transcript[:240])
                    transcript_segments.append(
                        {
                            "start_ms": max(0, int(segment["start_ms"] or 0)),
                            "end_ms": max(0, int(segment["end_ms"] or 0)),
                            "text": transcript[:240],
                        }
                    )
                audio_mode = str(metadata.get("audio_mode") or "").strip()
                speech_status = str(metadata.get("speech_status") or "").strip()
                if audio_mode:
                    audio_modes.append(audio_mode)
                if speech_status:
                    speech_statuses.append(speech_status)
            if "source_voice" in audio_modes:
                audio_mode = "source_voice"
            elif "source_audio_unclassified" in audio_modes or bool(row["has_audio"]):
                audio_mode = "source_audio_unclassified"
            else:
                audio_mode = "no_audio"
            rows.append(
                {
                    "asset_id": row["id"],
                    "display_name": row["display_name"],
                    "media_kind": row["media_kind"],
                    "duration_ms": row["duration_ms"] or 0,
                    "has_audio": bool(row["has_audio"]),
                    "tags": list(dict.fromkeys(semantic_tags))[:3],
                    "audio_mode": audio_mode,
                    "speech_status": (
                        "recognized"
                        if "recognized" in speech_statuses
                        else speech_statuses[0] if speech_statuses else None
                    ),
                    "visual_evidence": visual_evidence[:8],
                    "transcript_evidence": transcript_evidence[:8],
                    "transcript_segments": transcript_segments[:24],
                }
            )
        cards = classify_assets(rows, settings.get("brief") or {})
        for card in cards:
            speech = _source_speech_summary([card])
            card["recognized_speech_ms"] = speech["recognized_speech_ms"]
            card["source_coverage"] = speech["source_coverage"]
        return cards

    def _run_product_asset_analysis(self, task_id, payload):
        project_id = payload["project_id"]
        _row, settings = self._product_settings(project_id)
        skipped = []
        analyzed = 0
        total = len(settings.get("asset_ids") or [])
        for index, asset_id in enumerate(settings.get("asset_ids") or []):
            if self._should_stop(task_id):
                break
            asset_name = asset_id
            try:
                asset_name = str(self._asset_row(asset_id)["display_name"] or asset_id)
            except ContentEngineError:
                pass
            settings["analysis_context"] = {
                "stage": "asset_analysis",
                "asset_id": asset_id,
                "asset_name": asset_name,
                "asset_index": index + 1,
                "asset_total": total,
            }
            self._save_product_settings(project_id, settings)
            try:
                completed = self._analyze_asset(
                    task_id,
                    asset_id,
                    {
                        "provider": self.analyzer.capability.get("provider", "local"),
                        "workflow": "product_one_click",
                        "product_context": settings.get("brief") or {},
                    },
                )
                if completed is False:
                    break
                if completed:
                    analyzed += 1
            except ContentEngineError as error:
                if error.code not in PRODUCT_SKIPPABLE_ANALYSIS_ERRORS:
                    raise
                skipped.append(
                    {
                        "asset_id": asset_id,
                        "asset_name": asset_name,
                        "stage": "asset_analysis",
                        "error_code": error.code,
                        "message": redact_text(error.message),
                    }
                )
            self._set_task(task_id, "analyzing", progress=0.8 * (index + 1) / max(1, total))
        settings["product_assets"] = self._product_asset_cards(settings)
        settings["analysis_skipped_assets"] = skipped
        settings["analysis_status"] = "partial" if skipped else "completed"
        settings["analysis_context"] = {
            "stage": "asset_analysis_complete",
            "analyzed_count": analyzed,
            "skipped_count": len(skipped),
            "asset_total": total,
        }
        self._save_product_settings(project_id, settings)
        if not analyzed and skipped and not self._should_stop(task_id):
            raise ContentEngineError(
                "all_assets_unavailable",
                "所有选中的素材在延长等待和重试后仍无法完成分析。",
            )
        return {"project_id": project_id, "asset_count": len(settings["product_assets"]), "skipped_assets": skipped}

    def _run_product_copy(self, task_id, payload):
        project_id = payload["project_id"]
        _row, settings = self._product_settings(project_id)
        assets = settings.get("product_assets") or self._product_asset_cards(settings)
        brief = payload.get("brief") if isinstance(payload.get("brief"), dict) else settings.get("brief") or {}
        product_name = str(brief.get("product_name") or "").strip()
        audio_strategy = _source_speech_summary(assets)
        source_audio_unknown = any(
            str(item.get("audio_mode") or "") == "source_audio_unclassified"
            and str(item.get("speech_status") or "") in {"failed", "unknown", "not_requested"}
            for item in assets
        )
        has_visual_evidence = any(
            item.get("visual_evidence") or item.get("transcript_evidence")
            for item in assets
        )
        script = None
        cloud = getattr(self.analyzer, "cloud_client", None)
        generator = getattr(cloud, "generate_product_script", None)
        if (
            callable(generator)
            and getattr(cloud, "configured", False)
            and (product_name or has_visual_evidence)
        ):
            script = generator(brief, assets, count=int(settings.get("target_count") or 3))
            mismatch = product_script_mismatch_reason(script, brief) if product_name else None
            if mismatch:
                guarded_brief = {
                    **brief,
                    "identity_lock": (
                        f"商品只能是{product_name}。禁止出现洗碗机、餐具、厨房洗涤等其他品类。"
                        if "机器人" in product_name or "清洁" in str(brief.get("industry") or "")
                        else f"商品只能是{product_name}，不得改写成其他品类。"
                    ),
                }
                script = generator(guarded_brief, assets, count=int(settings.get("target_count") or 3))
                mismatch = product_script_mismatch_reason(script, brief)
                if mismatch:
                    settings["product_assets"] = assets
                    settings["copy_status"] = "blocked_mismatch"
                    settings["copy_error_code"] = mismatch
                    self._save_product_settings(project_id, settings)
                    raise ContentEngineError(
                        mismatch,
                        "百炼文案与已锁定的商品类别不一致，请确认商品名称后重试。",
                    )
        else:
            script = build_local_copy(brief, assets, int(settings.get("target_count") or 3)) if product_name else build_visual_only_copy(assets, brief)
        if not product_name and not has_visual_evidence:
            # No trustworthy visual evidence means no safe narration. Keep
            # the material playable and let a later analysis retry decide.
            script = build_visual_only_copy(assets, brief)
        trusted_voiceover = bool(str(script.get("voiceover") or "").strip()) and (
            script.get("provider") != "local_visual_only"
        )
        source_voice_dominant = (
            audio_strategy["recognized_speech_ms"] > 0
            and audio_strategy["source_coverage"]
            >= audio_strategy["source_coverage_threshold"]
        )
        if source_voice_dominant:
            script["voice_mode"] = "source_voice"
            # The original speech owns timing. Do not burn AI-generated hook
            # or CTA captions that are not aligned to the source transcript.
            script["voiceover"] = ""
            script["hook"] = ""
            script["cta"] = ""
            audio_strategy["reason"] = "source_narration_dominant"
            audio_strategy["source_audio_policy"] = "preserve"
        elif trusted_voiceover:
            # Sparse recognition is not a usable narration backbone.  A
            # trustworthy script gets a complete TTS track rather than leaving
            # most of a 60–90 second candidate silent.  Unknown source audio is
            # not called speech; the renderer may conservatively duck it.
            script["voice_mode"] = "tts"
            audio_strategy["reason"] = (
                "source_speech_below_threshold"
                if audio_strategy["recognized_speech_ms"] > 0
                else "source_audio_unconfirmed"
                if source_audio_unknown
                else "tts_required"
            )
            audio_strategy["source_audio_policy"] = (
                "duck" if any(item.get("has_audio") for item in assets) else "none"
            )
        elif source_audio_unknown:
            # A failed/unavailable ASR result is not evidence that the source
            # is silent. Without trustworthy copy there is nothing safe to
            # synthesize, so preserve it without claiming it is narration.
            script["voice_mode"] = "source_audio"
            script["voiceover"] = ""
            script["hook"] = ""
            script["cta"] = ""
            script["title_candidates"] = []
            audio_strategy["reason"] = "source_audio_unconfirmed"
            audio_strategy["source_audio_policy"] = "preserve"
        elif script.get("provider") == "local_visual_only":
            script["voice_mode"] = "none"
            audio_strategy["reason"] = "voice_not_requested"
            audio_strategy["source_audio_policy"] = "preserve"
        else:
            script["voice_mode"] = "tts"
            audio_strategy["reason"] = "tts_required"
            audio_strategy["source_audio_policy"] = (
                "duck" if any(item.get("has_audio") for item in assets) else "none"
            )
        settings["product_assets"] = assets
        settings["product_script"] = sanitize_public_value(script)
        settings["audio_strategy"] = sanitize_public_value(audio_strategy)
        settings["voice_mode"] = script["voice_mode"]
        settings["copy_mode"] = "none" if script.get("provider") == "local_visual_only" else "ai"
        settings["copy_status"] = "not_requested" if script.get("provider") == "local_visual_only" else "completed"
        settings["voice_status"] = (
            "not_requested" if script["voice_mode"] in {"none", "source_voice", "source_audio"} else "pending"
        )
        settings["voice_metadata"] = (
            {
                "provider": "source" if script["voice_mode"] in {"source_voice", "source_audio"} else "none",
                "reason": (
                    "source_voice_preserved"
                    if script["voice_mode"] == "source_voice"
                    else "source_audio_preserved_after_asr_failure"
                    if script["voice_mode"] == "source_audio"
                    else "not_requested"
                ),
                "recognized_speech_ms": audio_strategy["recognized_speech_ms"],
                "source_media_ms": audio_strategy["source_media_ms"],
                "source_coverage": audio_strategy["source_coverage"],
            }
            if script["voice_mode"] in {"none", "source_voice", "source_audio"}
            else {
                "provider": "bailian",
                "status": "pending",
                "reason": audio_strategy["reason"],
                "recognized_speech_ms": audio_strategy["recognized_speech_ms"],
                "source_media_ms": audio_strategy["source_media_ms"],
                "source_coverage": audio_strategy["source_coverage"],
            }
        )
        settings["voice_audio_path"] = None
        self._save_product_settings(project_id, settings)
        self._set_task(task_id, "analyzing", progress=0.95)
        return {"project_id": project_id, "provider": script.get("provider"), "script_ready": True}

    def _run_product_voice(self, task_id, payload):
        project_id = payload["project_id"]
        _row, settings = self._product_settings(project_id)
        script = settings.get("product_script") or build_local_copy(settings.get("brief") or {}, settings.get("product_assets") or [])
        voice_mode = str(settings.get("voice_mode") or script.get("voice_mode") or "tts")
        if voice_mode in {"none", "source_voice", "source_audio"}:
            settings["voice_mode"] = voice_mode
            settings["voice_status"] = "not_requested"
            settings["voice_metadata"] = {
                "provider": "source" if voice_mode in {"source_voice", "source_audio"} else "none",
                "reason": (
                    "source_voice_preserved"
                    if voice_mode == "source_voice"
                    else "source_audio_preserved_after_asr_failure"
                    if voice_mode == "source_audio"
                    else "not_requested"
                ),
            }
            settings["voice_audio_path"] = None
            self._save_product_settings(project_id, settings)
            return {
                "project_id": project_id,
                "voice_status": "not_requested",
                "provider": "source" if voice_mode in {"source_voice", "source_audio"} else "none",
            }
        voice_text = str(script.get("voiceover") or "").strip()
        if not voice_text:
            settings["voice_status"] = "failed"
            settings["voice_metadata"] = {
                "provider": "bailian",
                "error_code": "product_voice_text_missing",
                "error_message": "商品配音文案为空，无法生成 AI 配音。",
            }
            settings["voice_audio_path"] = None
            self._save_product_settings(project_id, settings)
            return {
                "project_id": project_id,
                "voice_status": "failed",
                "provider": "bailian",
            }
        voice_dir = self.data_dir / "product-voices"
        voice_dir.mkdir(parents=True, exist_ok=True)
        voice_path = voice_dir / f"{project_id}.wav"
        cloud = getattr(self.analyzer, "cloud_client", None)
        synthesizer = getattr(cloud, "synthesize_product_voice", None)
        status = "failed"
        metadata = {"provider": "none"}
        if callable(synthesizer) and getattr(cloud, "configured", False):
            try:
                metadata = synthesizer(voice_text, voice_path)
                status = "completed"
            except ContentEngineError as error:
                metadata = {
                    "provider": "bailian",
                    "error_code": error.code,
                    "error_message": error.message,
                }
        settings["product_script"] = sanitize_public_value(script)
        settings["voice_status"] = status
        settings["voice_metadata"] = metadata
        settings["voice_audio_path"] = (
            str(voice_path.relative_to(self.data_dir)).replace("\\", "/")
            if status == "completed" and voice_path.is_file()
            else None
        )
        self._save_product_settings(project_id, settings)
        return {"project_id": project_id, "voice_status": status, "provider": metadata.get("provider")}

    def _run_product_generation(self, task_id, payload):
        project_id = payload["project_id"]
        _row, settings = self._product_settings(project_id)
        self._update_project(project_id, "analyzing")
        # This task is intentionally resumable and idempotent: each phase is
        # persisted in project settings before the next phase begins.
        if not settings.get("product_assets"):
            analysis = self._run_product_asset_analysis(task_id, {"project_id": project_id})
            if self._should_stop(task_id):
                return analysis
            _row, settings = self._product_settings(project_id)
        if not settings.get("product_script"):
            copy = self._run_product_copy(task_id, {"project_id": project_id, "brief": settings.get("brief") or {}})
            if self._should_stop(task_id):
                return copy
            _row, settings = self._product_settings(project_id)
        if settings.get("voice_mode") == "tts" and settings.get("voice_status") != "completed":
            self._run_product_voice(task_id, {"project_id": project_id})
            _row, settings = self._product_settings(project_id)
            if settings.get("voice_status") != "completed":
                voice_metadata = settings.get("voice_metadata") or {}
                raise ContentEngineError(
                    str(voice_metadata.get("error_code") or "product_voice_failed"),
                    str(
                        voice_metadata.get("error_message")
                        or "百炼配音未完成，已停止生成，避免把失败配音伪装成成片。"
                    ),
                )
        assets = settings.get("product_assets") or self._product_asset_cards(settings)
        script = settings.get("product_script") or build_local_copy(settings.get("brief") or {}, assets)
        recipes = build_product_recipes(
            assets,
            script,
            output_count=int(payload.get("target_count") or settings.get("target_count") or 3),
            duration_ms=int(payload.get("duration_ms") or settings.get("duration_ms") or 75_000),
            product_context=settings.get("brief") or {},
        )
        if not recipes:
            raise ContentEngineError("product_assets_empty", "没有可用于生成商品成片的素材。")
        self._update_project(project_id, "rendering")
        generated_ids = []
        cover_warnings = []
        for index, recipe in enumerate(recipes):
            if self._should_stop(task_id):
                break
            recipe["voice_audio_path"] = settings.get("voice_audio_path")
            if settings.get("voice_mode") in {"none", "source_audio"}:
                recipe["subtitle_style"] = {"preset": "none"}
            else:
                recipe["subtitle_style"] = {
                    "preset": "dynamic_clean",
                    "font_size": 42,
                    "margin_bottom": 150,
                }
            title_candidates = script.get("title_candidates") or []
            title = str(title_candidates[index % len(title_candidates)] if title_candidates else "")[:80]
            self._attach_packaging(
                recipe,
                kind="mix",
                title=title,
                index=index,
                options={
                    "packaging_mode": "none" if settings.get("voice_mode") == "none" else "auto",
                    "cover_mode": settings.get("cover_mode") or "ai_generate",
                    "visual_renderer": {
                        "requestedEngine": "remotion",
                        "requestedStyleVersion": 1,
                        "allowFallback": True,
                    },
                },
            )
            # The local FFmpeg path is a readability-preserving fallback, not
            # permission to invent generic product labels.  It keeps the
            # grounded title and the one caption lane while Remotion owns the
            # richer cards, stickers and motion when available.
            recipe.setdefault("packaging", {})["fallback_safe_clean"] = True
            recipe.setdefault("packaging", {}).setdefault("cover", {})[
                "prompt_version"
            ] = PRODUCT_COVER_PROMPT_VERSION
            if settings.get("bgm_asset_id"):
                if settings.get("voice_mode") == "none":
                    recipe["selected_bgm_asset_id"] = settings["bgm_asset_id"]
                else:
                    recipe.setdefault("packaging", {}).setdefault("audio", {})[
                        "bgm_asset_id"
                    ] = settings["bgm_asset_id"]
            video_id = self._insert_generated(
                project_id,
                task_id,
                "mix",
                recipe,
                {"total": 80 - index * 3, "selection_engine": "product_script", "product_workflow": "one_click_v1"},
                title,
                int(recipe["voice_segment"]["end_ms"]),
                recommended=index == 0,
                signature=f"product:{index}:{recipe['skeleton_id']}",
            )
            if self._render_generated(video_id, task_id=task_id):
                generated_ids.append(video_id)
            # A missing APIMart key should not destroy a locally playable first
            # sample. The card keeps cover_status=planned and explains the cost.
            if self.cover_client is not None and getattr(self.cover_client, "configured", False):
                try:
                    self._execute_pending_cover_for_video(video_id, task_id=task_id)
                except ContentEngineError as error:
                    if error.code not in PRODUCT_NON_BLOCKING_COVER_ERROR_CODES:
                        raise
                    cover_warnings.append(
                        {
                            "generated_video_id": video_id,
                            "error_code": error.code,
                        }
                    )
            self._set_task(task_id, "rendering", progress=0.35 + 0.6 * (index + 1) / len(recipes))
        cover_status_counts = {}
        admitted_cover_operations = 0
        if generated_ids:
            placeholders = ",".join("?" for _item in generated_ids)
            for row in self.connection.execute(
                f"""
                SELECT status, COUNT(*) AS count
                FROM cover_generation_ledger
                WHERE generated_video_id IN ({placeholders})
                GROUP BY status
                """,
                generated_ids,
            ).fetchall():
                cover_status_counts[row["status"]] = int(row["count"])
            admitted_cover_operations = sum(
                cover_status_counts.get(status, 0)
                for status in {"submitted", "completed", "outcome_unknown"}
            )
        result = {
            "project_id": project_id,
            "generated_count": len(generated_ids),
            "requested_count": len(recipes),
            "generated_video_ids": generated_ids,
            "copy_provider": script.get("provider"),
            "voice_status": settings.get("voice_status"),
            "skipped_assets": settings.get("analysis_skipped_assets") or [],
            "apimart_calls": admitted_cover_operations,
            "cover_status_counts": cover_status_counts,
            "cover_warnings": cover_warnings,
        }
        self._update_project(project_id, "rendering", result=result)
        return result

    def list_packaging_presets(self, kind=None):
        return {"items": list_presets(kind)}

    def save_brand_profile(self, profile):
        if not isinstance(profile, dict):
            raise ContentEngineError("invalid_brand_profile", "A brand profile is required.")
        profile_id = str(profile.get("brand_profile_id") or "").strip()
        if profile_id:
            self._brand_row(profile_id)
        else:
            profile_id = self._new_id("brand_profile")
        name = self._validate_text(profile.get("name"), "brand_name", 80)
        logo_asset_id = self._optional_brand_asset(
            profile.get("logo_asset_id"), image_only=True, field="logo"
        )
        reference_asset_id = self._optional_brand_asset(
            profile.get("reference_portrait_asset_id"),
            image_only=True,
            field="reference_portrait",
        )
        primary = self._validate_hex_color(
            profile.get("primary_color") or "#6D5DFB", "primary_color"
        )
        accent = self._validate_hex_color(
            profile.get("accent_color") or "#FFE45C", "accent_color"
        )
        font_preset = str(profile.get("font_preset") or "microsoft_yahei").strip()
        if font_preset not in {"microsoft_yahei", "source_han_sans", "neutral_sans"}:
            raise ContentEngineError("invalid_font_preset", "The brand font preset is invalid.")
        outro_text = str(profile.get("outro_text") or "").strip()
        if len(outro_text) > 60:
            raise ContentEngineError("invalid_outro_text", "The brand outro text is too long.")
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO brand_profiles(
                    id, name, logo_asset_id, reference_portrait_asset_id,
                    primary_color, accent_color, font_preset, outro_text,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    logo_asset_id = excluded.logo_asset_id,
                    reference_portrait_asset_id = excluded.reference_portrait_asset_id,
                    primary_color = excluded.primary_color,
                    accent_color = excluded.accent_color,
                    font_preset = excluded.font_preset,
                    outro_text = excluded.outro_text,
                    updated_at = excluded.updated_at
                """,
                (
                    profile_id,
                    name,
                    logo_asset_id,
                    reference_asset_id,
                    primary,
                    accent,
                    font_preset,
                    outro_text,
                    now,
                    now,
                ),
            )
        return self._public_brand(self._brand_row(profile_id))

    def list_brand_profiles(self):
        rows = self.connection.execute(
            "SELECT * FROM brand_profiles ORDER BY updated_at DESC, rowid DESC"
        ).fetchall()
        return {"items": [self._public_brand(row) for row in rows]}

    def create_packaging_task(self, generated_video_ids, options=None):
        if not isinstance(generated_video_ids, list) or not generated_video_ids:
            raise ContentEngineError(
                "invalid_generated_video_ids", "Select at least one generated video."
            )
        safe_options = options if isinstance(options, dict) else {}
        reuse_cover = safe_options.get("reuse_cover", True)
        if not isinstance(reuse_cover, bool):
            raise ContentEngineError("invalid_reuse_cover", "reuse_cover must be a boolean.")
        source_rows = [self._generated_row(video_id) for video_id in dict.fromkeys(generated_video_ids)]
        if any(row["status"] != "completed" for row in source_rows):
            raise ContentEngineError(
                "generated_video_not_ready", "Only completed videos can be repackaged."
            )
        created_ids = []
        with self.database.transaction() as connection:
            task_id = self._create_task("creative_packaging", {})["task_id"]
            now = self._now()
            for index, row in enumerate(source_rows):
                validated = self._validate_packaging_options(
                    row["kind"],
                    packaging_mode=safe_options.get("packaging_mode") or (
                        "preset" if safe_options.get("packaging_preset_id") else "auto"
                    ),
                    packaging_preset_id=safe_options.get("packaging_preset_id"),
                    brand_profile_id=safe_options.get("brand_profile_id"),
                    cover_mode="reuse" if reuse_cover else safe_options.get("cover_mode", "auto"),
                )
                recipe = json.loads(row["recipe_json"])
                if validated["packaging_mode"] != "none":
                    self._restore_recipe_word_timestamps(recipe)
                packaging_index = index
                if validated["packaging_mode"] == "auto":
                    compatible_ids = [
                        item["preset_id"] for item in list_presets(row["kind"])
                    ]
                    current_preset = str(
                        (recipe.get("packaging") or {}).get("preset_id") or ""
                    )
                    if current_preset in compatible_ids:
                        packaging_index = (
                            compatible_ids.index(current_preset) + 1 + index
                        ) % len(compatible_ids)
                self._attach_packaging(
                    recipe,
                    kind=row["kind"],
                    title=row["title"],
                    index=packaging_index,
                    options=validated,
                )
                if reuse_cover and recipe.get("packaging"):
                    recipe["packaging"]["cover"].update(
                        {
                            "mode": "reuse",
                            "status": "reused",
                            "source_generated_video_id": row["id"],
                        }
                    )
                latest = connection.execute(
                    """
                    SELECT MAX(generation) FROM generated_videos
                    WHERE project_id = ? AND selection_signature = ?
                    """,
                    (row["project_id"], row["selection_signature"]),
                ).fetchone()[0]
                generation = max(int(row["generation"]) + 1, int(latest or 0) + 1)
                video_id = self._insert_generated(
                    row["project_id"],
                    task_id,
                    row["kind"],
                    recipe,
                    with_virality_dimensions(json.loads(row["score_json"]), row["kind"]),
                    row["title"],
                    row["duration_ms"],
                    recommended=bool(row["recommended"]),
                    signature=row["selection_signature"],
                    generation=generation,
                )
                created_ids.append(video_id)
            payload = {
                "generated_video_ids": created_ids,
                "source_generated_video_ids": [row["id"] for row in source_rows],
            }
            connection.execute(
                "UPDATE content_tasks SET payload_json = ?, updated_at = ? WHERE id = ?",
                (self._json(payload), now, task_id),
            )
        return {
            **self._public_task(self._task_row(task_id)),
            "generated_video_ids": created_ids,
        }

    def create_repackage_task(self, generated_video_id, options=None):
        task = self.create_packaging_task([generated_video_id], options)
        return {**task, "generated_video_id": task["generated_video_ids"][0]}

    def get_packaging_cost_estimate(
        self,
        generated_video_ids,
        *,
        cover_mode="auto",
        planned_count=None,
        asset_ids=None,
        generation_kind=None,
    ):
        if generated_video_ids is None:
            generated_video_ids = []
        if not isinstance(generated_video_ids, list):
            raise ContentEngineError(
                "invalid_generated_video_ids", "The generated video selection is invalid."
            )
        if planned_count is None:
            if not generated_video_ids:
                raise ContentEngineError(
                    "invalid_generated_video_ids", "Select at least one generated video."
                )
            candidate_count = len(dict.fromkeys(generated_video_ids))
        else:
            candidate_count = self._validate_count(planned_count, maximum=300)
            if generated_video_ids:
                candidate_count = len(dict.fromkeys(generated_video_ids))
        if cover_mode not in {"auto", "local_frame", "ai_generate", "none", "reuse"}:
            raise ContentEngineError("invalid_cover_mode", "The cover mode is invalid.")
        safe_asset_ids = []
        if asset_ids is not None:
            if not isinstance(asset_ids, list):
                raise ContentEngineError(
                    "invalid_asset_ids", "The asset selection is invalid."
                )
            safe_asset_ids = list(dict.fromkeys(str(item) for item in asset_ids if item))
            for asset_id in safe_asset_ids:
                self._asset_row(asset_id)
        kind = str(generation_kind or "course").strip().lower()
        if kind not in {"course", "mix", "repackage"}:
            raise ContentEngineError("invalid_generation_kind", "The generation kind is invalid.")
        analysis_cached = 0
        if safe_asset_ids:
            placeholders = ", ".join("?" for _item in safe_asset_ids)
            analysis_cached = int(
                self.connection.execute(
                    f"SELECT COUNT(DISTINCT asset_id) FROM media_segments WHERE asset_id IN ({placeholders})",
                    safe_asset_ids,
                ).fetchone()[0]
            )
        analysis_needed = max(0, len(safe_asset_ids) - analysis_cached)
        bailian_items = []
        if kind != "repackage":
            bailian_items.extend(
                [
                    {
                        "operation": "speech_to_text",
                        "label": "长音频语音识别",
                        "estimated_calls": analysis_needed,
                        "maximum_calls": len(safe_asset_ids),
                        "cacheable": True,
                        "status": "cached" if analysis_needed == 0 else "estimated",
                    },
                    {
                        "operation": "visual_understanding",
                        "label": "关键帧画面理解",
                        "estimated_calls": analysis_needed,
                        "maximum_calls": len(safe_asset_ids),
                        "cacheable": True,
                        "status": "cached" if analysis_needed == 0 else "estimated",
                    },
                ]
            )
            if kind == "course":
                bailian_items.append(
                    {
                        "operation": "selection_scoring",
                        "label": "课程观点选段与评分",
                        "estimated_calls": 1,
                        "maximum_calls": 1,
                        "cacheable": False,
                        "status": "estimated",
                    }
                )
            if safe_asset_ids and cover_mode != "none":
                bailian_items.append(
                    {
                        "operation": "motion_direction",
                        "label": "动效位置与时间编导",
                        "estimated_calls": 1,
                        "maximum_calls": 1,
                        "cacheable": False,
                        "status": "estimated",
                    }
                )
        calls = candidate_count if cover_mode == "ai_generate" else 0
        bailian_calls = sum(int(item["estimated_calls"]) for item in bailian_items)
        return {
            "candidate_count": candidate_count,
            "cover_mode": cover_mode,
            "estimated_image_calls": calls,
            "provider": "apimart_gpt_image_2" if calls else None,
            "provider_configured": bool(
                self.cover_client is not None and self.cover_client.configured
            ),
            "bailian_calls": bailian_calls,
            "bailian_provider_configured": bool(
                (getattr(self.analyzer, "capability", {}) or {}).get("cloud_configured")
            ),
            "bailian_breakdown": bailian_items,
            "apimart_breakdown": [
                {
                    "operation": "ai_cover",
                    "label": "AI 封面",
                    "estimated_calls": calls,
                    "maximum_calls": calls,
                    "cacheable": False,
                    "status": "estimated" if calls else "not_requested",
                }
            ],
            "price_not_guaranteed": bool(calls),
            "confirmation_required": bool(bailian_calls or calls),
        }

    def regenerate_cover(self, generated_video_id):
        row = self._generated_row(generated_video_id)
        if row["status"] != "completed":
            raise ContentEngineError(
                "generated_video_not_ready", "Only completed videos can request a new cover."
            )
        recipe = json.loads(row["recipe_json"])
        reused_operation = False
        with self.database.transaction() as connection:
            operation = connection.execute(
                """
                SELECT * FROM cover_generation_ledger
                WHERE generated_video_id = ?
                  AND status IN ('planned', 'submitted')
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (row["id"],),
            ).fetchone()
            if operation is not None:
                reused_operation = True
            else:
                if not recipe.get("packaging"):
                    self._attach_packaging(
                        recipe,
                        kind=row["kind"],
                        title=row["title"],
                        index=0,
                        options={
                            "packaging_mode": "auto",
                            "packaging_preset_id": None,
                            "brand_profile_id": None,
                            "cover_mode": "ai_generate",
                        },
                    )
                cover = recipe["packaging"]["cover"]
                revision = max(0, int(cover.get("revision") or 0)) + 1
                prompt_version = str(
                    cover.get("prompt_version") or COVER_PROMPT_VERSION
                )[:64]
                cover.update(
                    {
                        "mode": "ai_generate",
                        "status": "planned",
                        "prompt_version": prompt_version,
                        "revision": revision,
                    }
                )
                now = self._now()
                connection.execute(
                    "UPDATE generated_videos SET recipe_json = ?, updated_at = ? WHERE id = ?",
                    (self._json(recipe), now, row["id"]),
                )
                operation = self._reserve_cover_operation(
                    row["id"], recipe, row["generation"]
                )
        task_id = _stable_id("task_cover", operation["id"])
        now = self._now()
        payload = {
            "cover_operation_id": operation["id"],
            "generated_video_id": row["id"],
        }
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'creative_cover', 'queued', ?, ?, ?)
                """,
                (task_id, self._json(payload), now, now),
            )
            persisted_task = self._task_row(task_id)
            if (
                persisted_task["status"] in {
                    "paused", "failed", "cancelled", "completed"
                }
                and operation["status"] in {"planned", "submitted"}
            ):
                connection.execute(
                    """
                    UPDATE content_tasks
                    SET status = 'queued', progress = 0, error_code = NULL,
                        error_message = NULL, resume_from_status = NULL,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (now, task_id),
                )
        return {
            **self._public_task(self._task_row(task_id)),
            "cover_operation_id": operation["id"],
            "cover_status": operation["status"],
            "reused_operation": reused_operation,
        }

    def update_cover_operation(
        self, operation_id, status, *, external_task_id=None, error_code=None
    ):
        row = self.connection.execute(
            "SELECT * FROM cover_generation_ledger WHERE id = ?", (operation_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "cover_operation_not_found", "The cover operation was not found."
            )
        status = str(status or "").strip()
        same_status = status == row["status"]
        if same_status and not external_task_id and not error_code:
            return self._public_cover_operation(row)
        if not same_status and status not in COVER_OPERATION_TRANSITIONS.get(
            row["status"], set()
        ):
            raise ContentEngineError(
                "invalid_cover_operation_transition",
                "The cover operation cannot transition to that status.",
            )
        external_task_id = (
            str(external_task_id or "").strip()[:255]
            or row["external_task_id"]
        )
        error_code = str(error_code or "").strip()[:64] or None
        video_row = self._generated_row(row["generated_video_id"])
        recipe = json.loads(video_row["recipe_json"])
        cover = (recipe.get("packaging") or {}).get("cover") or {}
        cover["status"] = status
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE cover_generation_ledger
                SET status = ?, external_task_id = ?, error_code = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, external_task_id, error_code, now, row["id"]),
            )
            connection.execute(
                "UPDATE generated_videos SET recipe_json = ?, updated_at = ? WHERE id = ?",
                (self._json(recipe), now, video_row["id"]),
            )
        return self._public_cover_operation(
            self.connection.execute(
                "SELECT * FROM cover_generation_ledger WHERE id = ?", (row["id"],)
            ).fetchone()
        )

    def _run_packaging(self, task_id, payload):
        video_ids = payload.get("generated_video_ids") or []
        completed = []
        for index, video_id in enumerate(video_ids):
            if self._should_stop(task_id):
                break
            self._reconcile_generated_rendering(video_id)
            self._set_task(
                task_id,
                "rendering",
                progress=0.1 + 0.85 * index / max(1, len(video_ids)),
            )
            if not self._render_generated(video_id, task_id=task_id):
                break
            self._execute_pending_cover_for_video(video_id, task_id=task_id)
            completed.append(video_id)
        for project_id in {
            self._generated_row(video_id)["project_id"] for video_id in completed
        }:
            self._register_finished_for_project(project_id, task_id)
        return {
            "generated_video_ids": completed,
            "generated_count": len(completed),
            "source_generated_video_ids": payload.get("source_generated_video_ids") or [],
        }

    def _run_cover(self, task_id, payload):
        operation_id = str(payload.get("cover_operation_id") or "")
        self._set_task(task_id, "rendering", progress=0.1)
        operation = self._execute_cover_operation(
            operation_id, should_stop=lambda: self._should_stop(task_id)
        )
        self._set_task(task_id, "rendering", progress=0.95)
        return {
            "cover_operation_id": operation["cover_operation_id"],
            "generated_video_id": operation["generated_video_id"],
            "cover_status": operation["status"],
        }

    def _execute_pending_cover_for_video(self, video_id, *, task_id=None):
        operation = self.connection.execute(
            """
            SELECT * FROM cover_generation_ledger
            WHERE generated_video_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (video_id,),
        ).fetchone()
        if operation is None or operation["status"] == "completed":
            return None
        return self._execute_cover_operation(
            operation["id"],
            should_stop=(lambda: self._should_stop(task_id)) if task_id else None,
        )

    def _execute_cover_operation(self, operation_id, *, should_stop=None):
        operation = self.connection.execute(
            "SELECT * FROM cover_generation_ledger WHERE id = ?", (operation_id,)
        ).fetchone()
        if operation is None:
            raise ContentEngineError(
                "cover_operation_not_found", "The cover operation was not found."
            )
        if operation["status"] == "completed":
            return self._public_cover_operation(operation)
        if operation["status"] in {"failed", "outcome_unknown", "cancelled"}:
            raise ContentEngineError(
                f"cover_{operation['status']}",
                "The cover operation is terminal and cannot be submitted again.",
            )
        if self.cover_client is None or not self.cover_client.configured:
            raise ContentEngineError(
                "apimart_not_configured", "Configure the APIMart cover service first."
            )
        video_row = self._generated_row(operation["generated_video_id"])
        recipe = json.loads(video_row["recipe_json"])
        if operation["status"] == "planned":
            if should_stop is not None and should_stop():
                raise APIMartPollingStopped(
                    "APIMart cover submission was stopped before admission."
                )
            reference_path = self._cover_reference_path(recipe)
            # Freeze the opaque reference selection before the one-way paid
            # admission. A restart can then resume without silently switching
            # to a different source frame.
            self.connection.execute(
                "UPDATE generated_videos SET recipe_json = ?, updated_at = ? WHERE id = ?",
                (self._json(recipe), self._now(), video_row["id"]),
            )
            # Persist the one-way admission before the billable request. If the
            # process stops after this point without a provider ID, recovery
            # marks the outcome unknown instead of risking a second submission.
            self.update_cover_operation(operation["id"], "submitted")
            try:
                provider_task_id = self.cover_client.submit(
                    self._cover_prompt(video_row, recipe),
                    reference_path=reference_path,
                )
            except APIMartOutcomeUnknown as error:
                self.update_cover_operation(
                    operation["id"],
                    "outcome_unknown",
                    external_task_id=error.task_id,
                    error_code="submit_outcome_unknown",
                )
                raise ContentEngineError(
                    "cover_outcome_unknown",
                    "APIMart cover submission outcome is unknown; it will not be resubmitted.",
                ) from error
            except APIMartError as error:
                self.update_cover_operation(
                    operation["id"], "failed", error_code="submit_rejected"
                )
                raise ContentEngineError("cover_submit_failed", str(error)) from error
            self.update_cover_operation(
                operation["id"], "submitted", external_task_id=provider_task_id
            )
            operation = self.connection.execute(
                "SELECT * FROM cover_generation_ledger WHERE id = ?", (operation["id"],)
            ).fetchone()
        provider_task_id = str(operation["external_task_id"] or "")
        if not provider_task_id:
            self.update_cover_operation(
                operation["id"],
                "outcome_unknown",
                error_code="provider_task_id_missing",
            )
            raise ContentEngineError(
                "cover_outcome_unknown",
                "The paid cover may have been submitted without a recoverable provider task ID.",
            )
        try:
            image_url = self.cover_client.poll(
                provider_task_id, should_stop=should_stop
            )
        except APIMartPollingStopped as error:
            raise ContentEngineError(
                "cover_poll_interrupted",
                "APIMart cover polling was paused locally and can be resumed safely.",
            ) from error
        except APIMartOutcomeUnknown as error:
            self.update_cover_operation(
                operation["id"],
                "outcome_unknown",
                external_task_id=provider_task_id,
                error_code="poll_outcome_unknown",
            )
            raise ContentEngineError(
                "cover_outcome_unknown",
                "APIMart cover polling outcome is unknown; it will not be resubmitted.",
            ) from error
        except APIMartTaskFailed as error:
            self.update_cover_operation(
                operation["id"],
                "failed",
                external_task_id=provider_task_id,
                error_code="provider_failed",
            )
            raise ContentEngineError("cover_provider_failed", str(error)) from error
        except APIMartError as error:
            self.update_cover_operation(
                operation["id"],
                "submitted",
                external_task_id=provider_task_id,
                error_code="cover_poll_failed",
            )
            raise ContentEngineError("cover_poll_failed", str(error)) from error
        target = self._validate_generated_path(video_row["thumbnail_path"])
        background = target.with_name(f".{target.stem}.ai-background")
        try:
            try:
                self.cover_client.download(image_url, background)
            except Exception as error:
                self.update_cover_operation(
                    operation["id"],
                    "submitted",
                    external_task_id=provider_task_id,
                    error_code="cover_download_failed",
                )
                raise ContentEngineError(
                    "cover_download_failed",
                    "The completed APIMart cover could not be downloaded locally.",
                ) from error
            try:
                self.renderer.compose_cover(
                    background,
                    target,
                    recipe.get("packaging") or {},
                    resolve_asset_path=self._resolve_asset_path,
                )
            except Exception as error:
                self.update_cover_operation(
                    operation["id"],
                    "submitted",
                    external_task_id=provider_task_id,
                    error_code="cover_composition_failed",
                )
                raise ContentEngineError(
                    "cover_composition_failed",
                    "The AI cover could not be composed locally.",
                ) from error
        except ContentEngineError:
            raise
        except Exception as error:
            raise ContentEngineError(
                "cover_composition_failed", "The AI cover could not be composed locally."
            ) from error
        finally:
            background.unlink(missing_ok=True)
        return self.update_cover_operation(
            operation["id"],
            "completed",
            external_task_id=provider_task_id,
        )

    @staticmethod
    def _cover_prompt(video_row, recipe):
        packaging = recipe.get("packaging") or {}
        brand = packaging.get("brand") or {}
        title = str(video_row["title"] or packaging.get("title") or "")[:80]
        primary = str(brand.get("primary_color") or "neutral violet")[:16]
        accent = str(brand.get("accent_color") or "warm yellow")[:16]
        if recipe.get("product_workflow") == "one_click_v1":
            context = normalize_product_context(recipe.get("product_context"))
            script = recipe.get("product_script") or {}
            product_name = context.get("product_name") or title or "the supplied product"
            brand_name = context.get("brand_name") or ""
            industry = context.get("industry") or "product showcase"
            selling_points = context.get("selling_points") or ""
            target_customer = context.get("target_customer") or ""
            must_include = context.get("must_include") or ""
            avoid = context.get("avoid") or ""
            evidence = []
            for shot in script.get("shots") or []:
                if not isinstance(shot, dict):
                    continue
                value = str(shot.get("caption") or "").strip()
                if value and value not in evidence:
                    evidence.append(value[:120])
                if len(evidence) >= 4:
                    break
            evidence_text = "；".join(evidence) or "use only what is visible in the reference image"
            reference_instruction = (
                "Use the supplied reference image as the primary source of truth. "
                "Preserve the product category, silhouette, proportions, colors, and "
                "visible physical details; improve lighting and composition without "
                "redesigning it. "
                if (packaging.get("cover") or {}).get("reference_derivative_id")
                else "Do not invent unsupported product details. "
            )
            people_instruction = (
                "Include people only when the required-content field explicitly asks for them. "
                if any(token in must_include for token in ("人物", "员工", "客户", "操作员", "人像"))
                else "Do not add people or faces. "
            )
            return (
                "Create a premium vertical 9:16 product-advertising cover background. "
                f"Locked product identity: {product_name}. Industry: {industry}. "
                f"Brand context: {brand_name or 'none supplied'}. Verified scene evidence: "
                f"{evidence_text}. Selling points to express visually: "
                f"{selling_points or 'show the real product clearly'}. Intended audience: "
                f"{target_customer or 'not specified'}. Required visual content: "
                f"{must_include or 'none beyond the supplied product'}. Explicit exclusions: "
                f"{avoid or 'unrelated product categories and unsupported claims'}. "
                f"{reference_instruction}{people_instruction}Use {primary} as the main mood and "
                f"{accent} only as a restrained accent. Keep the product prominent, with "
                "clear depth and clean negative space for a title added later. Do not render "
                "any words, letters, numbers, captions, logos, trademarks, watermarks, UI, "
                "testimonials, performance statistics, or claims not supported by the brief."
            )
        title = title or "training value"
        reference_instruction = (
            " Preserve the identity and facial features from the supplied reference "
            "image; do not add another person."
            if brand.get("reference_portrait_asset_id")
            else " Do not invent a person's face."
        )
        return (
            "Create a premium vertical 9:16 editorial background for a Chinese "
            f"training-video cover about this concept: {title}. Use {primary} as the "
            f"main mood and {accent} only as a restrained accent. Keep a calm, credible "
            "professional classroom atmosphere with clear depth and generous negative "
            "space in the lower-middle area for a title added later. Do not render any "
            "words, letters, numbers, captions, logos, trademarks, watermarks, UI, or "
            f"invented testimonials.{reference_instruction}"
        )

    def _cover_reference_path(self, recipe):
        packaging = recipe.get("packaging") or {}
        brand = packaging.get("brand") or {}
        if recipe.get("product_workflow") == "one_click_v1":
            selected = self._product_cover_reference_path(recipe)
            if selected is not None:
                return selected
        asset_id = str(brand.get("reference_portrait_asset_id") or "").strip()
        if not asset_id:
            return None
        row = self._asset_row(asset_id)
        if row["media_kind"] != "image":
            raise ContentEngineError(
                "invalid_reference_portrait",
                "The APIMart reference portrait must be an imported image asset.",
            )
        return Path(self._resolve_asset_path(asset_id))

    def _product_cover_reference_path(self, recipe):
        visual_segments = [
            item
            for item in (recipe.get("visual_segments") or [])
            if isinstance(item, dict) and item.get("asset_id")
        ]
        asset_ids = list(
            dict.fromkeys(str(item["asset_id"]) for item in visual_segments)
        )
        if not asset_ids:
            return None
        cover = recipe.setdefault("packaging", {}).setdefault("cover", {})
        frozen_id = str(cover.get("reference_derivative_id") or "").strip()
        if frozen_id:
            frozen = self._validated_product_derivative_path(frozen_id, asset_ids)
            if frozen is not None:
                return frozen
            cover.pop("reference_derivative_id", None)
            cover.pop("reference_asset_id", None)
            cover.pop("reference_timestamp_ms", None)
        allowed_asset_ids = set(asset_ids)
        placeholders = ",".join("?" for _item in asset_ids)
        segments = self.connection.execute(
            f"""
            SELECT s.id AS segment_id, s.asset_id, s.start_ms, s.end_ms,
                   s.role, s.shot_type, s.tags_json, s.quality_score,
                   s.analysis_version
            FROM media_segments s
            WHERE s.asset_id IN ({placeholders})
              AND s.analysis_version = (
                  SELECT s2.analysis_version
                  FROM media_segments s2
                  WHERE s2.asset_id = s.asset_id
                  ORDER BY s2.updated_at DESC, s2.rowid DESC
                  LIMIT 1
              )
            """,
            asset_ids,
        ).fetchall()
        frames = self.connection.execute(
            f"""
            SELECT d.id AS derivative_id, d.asset_id, d.ordinal,
                   d.relative_path, d.metadata_json AS derivative_metadata_json,
                   d.config_hash
            FROM asset_derivatives d
            WHERE d.asset_id IN ({placeholders})
              AND d.derivative_kind = 'keyframe'
              AND d.status = 'ready'
              AND d.config_hash = (
                  SELECT s.analysis_version
                  FROM media_segments s
                  WHERE s.asset_id = d.asset_id
                  ORDER BY s.updated_at DESC, s.rowid DESC
                  LIMIT 1
              )
            """,
            asset_ids,
        ).fetchall()
        asset_order = {asset_id: index for index, asset_id in enumerate(asset_ids)}
        # Older analysis manifests may have persisted the sentence ordinal as
        # thumbnail_derivative_id. Re-associate every segment to its nearest
        # keyframe timestamp so existing cached analysis is repaired locally,
        # without another provider call.
        frames_by_asset = {}
        for frame in frames:
            try:
                derivative_metadata = json.loads(
                    frame["derivative_metadata_json"] or "{}"
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                derivative_metadata = {}
            timestamp_ms = max(
                0, int(derivative_metadata.get("timestamp_ms") or 0)
            )
            frames_by_asset.setdefault(frame["asset_id"], []).append(
                (timestamp_ms, frame)
            )
        candidates = []
        tag_weights = {
            "product_closeup": 0.30,
            "product_detail": 0.26,
            "function_demo": 0.20,
            "result": 0.16,
            "use_scene": 0.12,
            "factory_environment": 0.08,
        }
        for segment in segments:
            midpoint = (int(segment["start_ms"]) + int(segment["end_ms"])) // 2
            available_frames = frames_by_asset.get(segment["asset_id"]) or []
            if not available_frames:
                continue
            timestamp_ms, frame = min(
                available_frames,
                key=lambda item: (
                    abs(item[0] - midpoint),
                    int(item[1]["ordinal"] or 0),
                    str(item[1]["derivative_id"]),
                ),
            )
            path = self._validated_product_derivative_row_path(
                frame, allowed_asset_ids
            )
            if path is None:
                continue
            try:
                tags = json.loads(segment["tags_json"] or "[]")
            except (TypeError, ValueError, json.JSONDecodeError):
                tags = []
            semantic = max(
                [tag_weights.get(str(tag), 0.0) for tag in tags] or [0.0]
            )
            shot_type = str(segment["shot_type"] or "").casefold()
            if "close" in shot_type or "特写" in shot_type:
                semantic = max(semantic, 0.28)
            quality = min(
                1.0, max(0.0, float(segment["quality_score"] or 0))
            )
            candidates.append(
                (
                    -(quality * 0.7 + semantic * 0.3),
                    asset_order.get(segment["asset_id"], len(asset_ids)),
                    int(frame["ordinal"] or 0),
                    str(frame["derivative_id"]),
                    path,
                    segment["asset_id"],
                    timestamp_ms,
                )
            )
        if not candidates:
            cover["reference_selector_version"] = PRODUCT_COVER_SELECTOR_VERSION
            cover["reference_status"] = "unavailable"
            return None
        _score, _asset_order, _ordinal, derivative_id, path, asset_id, timestamp_ms = min(
            candidates
        )
        cover.update(
            {
                "reference_selector_version": PRODUCT_COVER_SELECTOR_VERSION,
                "reference_status": "selected",
                "reference_derivative_id": derivative_id,
                "reference_asset_id": asset_id,
                "reference_timestamp_ms": timestamp_ms,
            }
        )
        return path

    def _validated_product_derivative_path(self, derivative_id, asset_ids):
        row = self.connection.execute(
            """
            SELECT id, asset_id, relative_path
            FROM asset_derivatives
            WHERE id = ? AND derivative_kind = 'keyframe' AND status = 'ready'
            """,
            (derivative_id,),
        ).fetchone()
        if row is None:
            return None
        return self._validated_product_derivative_row_path(row, set(asset_ids))

    def _validated_product_derivative_row_path(self, row, allowed_asset_ids):
        if row["asset_id"] not in allowed_asset_ids:
            return None
        try:
            relative = self._validate_derivative_path(row["relative_path"])
            path = (self.data_dir / relative).resolve(strict=True)
        except (ContentEngineError, OSError):
            return None
        if path.suffix.casefold() not in {".jpg", ".jpeg", ".png", ".webp"}:
            return None
        return path if path.is_file() else None

    def list_segments(self, *, asset_id=None, role=None, limit=2_000):
        limit = self._validate_count(limit, maximum=2_000)
        clauses = []
        values = []
        if asset_id is not None:
            self._validate_asset_ids([asset_id])
            clauses.append("asset_id = ?")
            values.append(asset_id)
        if role is not None:
            if role not in {*ROLE_ORDER, "general"}:
                raise ContentEngineError("invalid_role", "The segment role is invalid.")
            clauses.append("role = ?")
            values.append(role)
        where = " AND ".join(clauses) if clauses else "1 = 1"
        rows = self.connection.execute(
            f"""
            SELECT * FROM media_segments s
            WHERE {where}
              AND s.analysis_version = (
                  SELECT latest.analysis_version
                  FROM media_segments latest
                  WHERE latest.asset_id = s.asset_id
                  ORDER BY latest.updated_at DESC, latest.rowid DESC
                  LIMIT 1
              )
            ORDER BY asset_id, start_ms LIMIT ?
            """,
            (*values, limit),
        ).fetchall()
        return {"items": [self._public_segment(row) for row in rows]}

    def get_project(self, project_id):
        row = self._project_row(project_id)
        settings = json.loads(row["settings_json"])
        result = json.loads(row["result_json"])
        return {
            "project_id": row["id"],
            "mode": row["mode"],
            "name": row["name"],
            "theme": row["theme"],
            "status": row["status"],
            "required_roles": settings.get("required_roles", []),
            "target_count": settings.get(
                "target_count", settings.get("count", settings.get("output_count"))
            ),
            "packaging_mode": settings.get("packaging_mode", "none"),
            "packaging_preset_id": settings.get("packaging_preset_id"),
            "brand_profile_id": settings.get("brand_profile_id"),
            "cover_mode": settings.get("cover_mode", "none"),
            "workflow": settings.get("workflow"),
            "ratio": settings.get("ratio", "9:16"),
            "duration_ms": settings.get("duration_ms"),
            "bgm_asset_id": settings.get("bgm_asset_id") if settings.get("workflow") == "product_one_click" else None,
            "product_asset_count": len(settings.get("product_assets") or settings.get("asset_ids") or []),
            "product_assets": sanitize_public_value(settings.get("product_assets") or []),
            "product_brief": sanitize_public_value(settings.get("brief") or {}) if settings.get("workflow") == "product_one_click" else None,
            "copy_status": settings.get("copy_status") if settings.get("workflow") == "product_one_click" else None,
            "voice_status": settings.get("voice_status") if settings.get("workflow") == "product_one_click" else None,
            "copy_mode": settings.get("copy_mode") if settings.get("workflow") == "product_one_click" else None,
            "voice_mode": settings.get("voice_mode") if settings.get("workflow") == "product_one_click" else None,
            "voice_metadata": (
                sanitize_public_value(settings.get("voice_metadata") or {})
                if settings.get("workflow") == "product_one_click"
                else None
            ),
            "audio_strategy": (
                sanitize_public_value(settings.get("audio_strategy") or {})
                if settings.get("workflow") == "product_one_click"
                else None
            ),
            "copy_error_code": settings.get("copy_error_code") if settings.get("workflow") == "product_one_click" else None,
            "analysis_context": (
                sanitize_public_value(settings.get("analysis_context") or {})
                if settings.get("workflow") == "product_one_click"
                else None
            ),
            "analysis_skipped_assets": (
                sanitize_public_value(settings.get("analysis_skipped_assets") or [])
                if settings.get("workflow") == "product_one_click"
                else []
            ),
            "product_family": infer_product_family(settings.get("brief") or {}) if settings.get("workflow") == "product_one_click" else None,
            "pilot_mode": bool(settings.get("pilot_mode", False)),
            "pilot_notice": result.get("pilot_notice"),
            "generated_count": self._completed_count(row["id"]),
            "maximum_qualified_count": result.get("maximum_qualified_count"),
            "count_is_exact": result.get("count_is_exact"),
            "missing_roles": result.get("missing_roles", []),
            "skeleton_ids": result.get("skeleton_ids", []),
            "skeleton_count": result.get("skeleton_count", 0),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_generated(self, *, project_id=None, status=None, limit=500):
        limit = self._validate_count(limit, maximum=2_000)
        clauses = []
        values = []
        if project_id is not None:
            self._project_row(project_id)
            clauses.append("project_id = ?")
            values.append(project_id)
        if status is not None:
            if status not in {"queued", "rendering", "completed", "failed", "rejected"}:
                raise ContentEngineError("invalid_status", "The generated video status is invalid.")
            clauses.append("status = ?")
            values.append(status)
        where = " AND ".join(clauses) if clauses else "1 = 1"
        rows = self.connection.execute(
            f"SELECT * FROM generated_videos WHERE {where} ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (*values, limit),
        ).fetchall()
        capability = self._visual_comparison_capability_snapshot()
        cover_operations = self._latest_cover_operations(
            [row["id"] for row in rows]
        )
        return {
            "items": [
                self._public_generated(
                    row,
                    capability=capability,
                    cover_operation_lookup=cover_operations,
                )
                for row in rows
            ]
        }

    def _latest_cover_operations(self, generated_video_ids):
        latest = {}
        for offset in range(0, len(generated_video_ids), 500):
            batch = generated_video_ids[offset : offset + 500]
            if not batch:
                continue
            placeholders = ",".join("?" for _item in batch)
            rows = self.connection.execute(
                f"""
                SELECT * FROM cover_generation_ledger
                WHERE generated_video_id IN ({placeholders})
                ORDER BY generated_video_id, created_at DESC, rowid DESC
                """,
                batch,
            ).fetchall()
            for row in rows:
                latest.setdefault(row["generated_video_id"], row)
        return latest

    def record_media_review(
        self, generated_video_id, *, device="phone", verdict="pass", reason="", reviewer=""
    ):
        row = self._generated_row(generated_video_id)
        if row["status"] != "completed":
            raise ContentEngineError(
                "generated_video_not_ready", "Only completed candidates can be reviewed."
            )
        device = str(device or "").strip().lower()
        verdict = str(verdict or "").strip().lower()
        if device not in {"desktop", "phone"}:
            raise ContentEngineError("invalid_review_device", "The review device is invalid.")
        if verdict not in {"pass", "fail"}:
            raise ContentEngineError("invalid_review_verdict", "The review verdict is invalid.")
        try:
            media_path = self._validate_generated_path(row["output_path"])
        except (ContentEngineError, OSError, RuntimeError, TypeError):
            raise ContentEngineError("source_video_missing", "The candidate video is unavailable.") from None
        digest = self._sha256_file(media_path)
        review_id = _stable_id("review", generated_video_id, device)
        now = self._now()
        safe_reason = str(reason or "").strip()[:500]
        safe_reviewer = str(reviewer or "").strip()[:120]
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO creative_media_reviews(
                    id, generated_video_id, device, verdict, reason, reviewer,
                    media_digest, reviewed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(generated_video_id, device) DO UPDATE SET
                    verdict = excluded.verdict,
                    reason = excluded.reason,
                    reviewer = excluded.reviewer,
                    media_digest = excluded.media_digest,
                    reviewed_at = excluded.reviewed_at
                """,
                (
                    review_id,
                    generated_video_id,
                    device,
                    verdict,
                    safe_reason,
                    safe_reviewer,
                    digest,
                    now,
                ),
            )
        return self._public_media_review(
            self.connection.execute(
                "SELECT * FROM creative_media_reviews WHERE generated_video_id = ? AND device = ?",
                (generated_video_id, device),
            ).fetchone()
        )

    def list_media_reviews(self, generated_video_id):
        self._generated_row(generated_video_id)
        rows = self.connection.execute(
            "SELECT * FROM creative_media_reviews WHERE generated_video_id = ? ORDER BY reviewed_at DESC, rowid DESC",
            (generated_video_id,),
        ).fetchall()
        return {"items": [self._public_media_review(row) for row in rows]}

    @staticmethod
    def _public_media_review(row):
        return {
            "review_id": row["id"],
            "generated_video_id": row["generated_video_id"],
            "device": row["device"],
            "verdict": row["verdict"],
            "reason": redact_text(row["reason"] or ""),
            "reviewer": redact_text(row["reviewer"] or ""),
            "media_digest": row["media_digest"],
            "reviewed_at": row["reviewed_at"],
        }

    def create_regeneration_task(self, generated_video_id):
        row = self._generated_row(generated_video_id)
        recipe = json.loads(row["recipe_json"])
        if recipe.get("product_workflow") == "one_click_v2":
            raise ContentEngineError(
                "auto_mix_v2_layer_regeneration_required",
                "一键混剪 V2 只能使用 text、voice 或 music 三层局部重做。",
            )
        if row["status"] not in {"completed", "failed", "rejected"}:
            raise ContentEngineError(
                "generated_video_not_ready",
                "Only a finished candidate can be regenerated.",
            )
        task_id = self._new_id("task")
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, 'creative_regeneration', 'queued', '{}', ?, ?)
                """,
                (task_id, now, now),
            )
            latest = connection.execute(
                """
                SELECT MAX(generation) FROM generated_videos
                WHERE project_id = ? AND selection_signature = ?
                """,
                (row["project_id"], row["selection_signature"]),
            ).fetchone()[0]
            generation = max(int(row["generation"]) + 1, int(latest or 0) + 1)
            video_id = self._insert_generated(
                row["project_id"],
                task_id,
                row["kind"],
                recipe,
                json.loads(row["score_json"]),
                row["title"],
                row["duration_ms"],
                recommended=bool(row["recommended"]),
                signature=row["selection_signature"],
                generation=generation,
            )
            payload = {
                "generated_video_id": video_id,
                "source_generated_video_id": row["id"],
            }
            connection.execute(
                """
                UPDATE content_tasks SET payload_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (self._json(payload), now, task_id),
            )
        return {
            **self._public_task(self._task_row(task_id)),
            "generated_video_id": video_id,
        }

    def _run_regeneration(self, task_id, payload):
        video_id = str(payload.get("generated_video_id") or "")
        row = self._generated_row(video_id)
        self._reconcile_generated_rendering(video_id)
        self._set_task(task_id, "rendering", progress=0.1)
        if not self._render_generated(video_id, task_id=task_id):
            return {"generated_video_id": video_id, "status": "queued"}
        self._execute_pending_cover_for_video(video_id, task_id=task_id)
        row = self._generated_row(video_id)
        self._register_finished_for_project(row["project_id"], task_id)
        return {
            "generated_video_id": video_id,
            "project_id": row["project_id"],
            "generation": row["generation"],
            "status": row["status"],
        }

    def reject_generated(self, generated_video_id):
        row = self._generated_row(generated_video_id)
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE generated_videos SET status = 'rejected', updated_at = ? WHERE id = ?",
                (now, row["id"]),
            )
            connection.execute(
                """
                UPDATE generated_publish_queue
                SET status = 'cancelled', updated_at = ?
                WHERE generated_video_id = ? AND status = 'queued'
                """,
                (now, row["id"]),
            )
        return self._public_generated(self._generated_row(row["id"]))

    def queue_generated(self, generated_video_ids, channel):
        if not isinstance(generated_video_ids, list) or not generated_video_ids:
            raise ContentEngineError("invalid_generated_video_ids", "Select at least one video.")
        channel = str(channel or "")
        if channel not in CREATIVE_CHANNELS:
            raise ContentEngineError("invalid_channel", "The publish channel is invalid.")
        now = self._now()
        items = []
        with self.database.transaction() as connection:
            for video_id in dict.fromkeys(generated_video_ids):
                row = self._generated_row(video_id)
                if row["status"] != "completed":
                    raise ContentEngineError("generated_video_not_ready", "Only completed videos can be queued.")
                queue_id = _stable_id("generated_queue", video_id, channel)
                connection.execute(
                    """
                    INSERT OR IGNORE INTO generated_publish_queue(
                        id, generated_video_id, channel, status, created_at, updated_at
                    ) VALUES (?, ?, ?, 'queued', ?, ?)
                    """,
                    (queue_id, video_id, channel, now, now),
                )
                persisted = connection.execute(
                    """
                    SELECT id, generated_video_id, channel, status
                    FROM generated_publish_queue
                    WHERE generated_video_id = ? AND channel = ?
                    """,
                    (video_id, channel),
                ).fetchone()
                items.append(
                    {
                        "queue_item_id": persisted["id"],
                        "generated_video_id": persisted["generated_video_id"],
                        "channel": persisted["channel"],
                        "status": persisted["status"],
                    }
                )
        return {"items": items, "internal_only": True}

    def resolve_generated_path(self, generated_video_id, variant="video"):
        row = self._generated_row(generated_video_id)
        column = "thumbnail_path" if variant == "thumbnail" else "output_path"
        value = row[column]
        if not value:
            raise ContentEngineError("generated_video_path_unavailable", "The generated file is unavailable.")
        path = Path(value).resolve(strict=True)
        root = (self.data_dir / "generated").resolve()
        if root not in path.parents or not path.is_file():
            raise ContentEngineError("generated_video_path_unavailable", "The generated file is unavailable.")
        return {
            "generated_video_id": row["id"],
            "variant": "thumbnail" if variant == "thumbnail" else "video",
            "absolute_path": str(path),
        }

    def _course_windows(
        self,
        segments,
        minimum,
        maximum,
        count,
        *,
        theme=None,
        experiment_mode=None,
    ):
        windows = []
        available_span = max(
            0,
            int(segments[-1]["end_ms"]) - int(segments[0]["start_ms"]),
        ) if segments else 0
        target = min(
            (minimum + maximum) / 2,
            max(minimum, available_span * 0.9 / max(1, count)),
        )
        for start_index in range(len(segments)):
            selected = []
            for segment in segments[start_index:]:
                if selected and segment["start_ms"] - selected[-1]["end_ms"] > 2_000:
                    break
                selected.append(segment)
                duration = selected[-1]["end_ms"] - selected[0]["start_ms"]
                if duration > maximum:
                    break
                if duration < minimum:
                    continue
                complete = bool(selected[-1]["metadata"].get("sentence_complete", True))
                if not complete:
                    continue
                transcript = "".join(
                    str(item.get("transcript_text") or "").strip() for item in selected
                )
                opening_text = str(selected[0].get("transcript_text") or "").strip()
                cleaned_opening = COURSE_LEADING_FILLERS.sub("", opening_text)
                quality = sum(item["quality_score"] for item in selected) / len(selected)
                duration_fit = max(0.0, 1 - abs(duration - target) / max(target, 1))
                starts_with_filler = cleaned_opening != opening_text
                starts_as_continuation = bool(
                    re.match(r"^(?:所以|然后|另外|同时|还有|以及|并且)", cleaned_opening)
                )
                natural_start = 0.35 if starts_as_continuation else 1.0
                natural_end = 1.0 if re.search(r"[。！？!?]$", transcript) else 0.72
                completeness = 0.5 * natural_start + 0.5 * natural_end
                hook_hits = sum(marker in cleaned_opening[:80] for marker in COURSE_HOOK_MARKERS)
                has_number = bool(re.search(r"\d", cleaned_opening[:80]))
                opening = min(
                    1.0,
                    0.28
                    + min(0.48, hook_hits * 0.2)
                    + (0.16 if has_number else 0.0)
                    + (0.08 if re.search(r"[？?]", cleaned_opening[:80]) else 0.0),
                )
                if starts_with_filler:
                    opening = max(0.0, opening - 0.18)
                if len(cleaned_opening) < 8:
                    opening = max(0.0, opening - 0.2)
                signal_hits = sum(marker in transcript for marker in COURSE_HOOK_MARKERS)
                signal_hits += sum(marker in transcript for marker in COURSE_ACTION_MARKERS)
                information_length = min(1.0, len(transcript) / 140)
                content_chars = re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", transcript)
                lexical_variety = min(
                    1.0,
                    len(set(content_chars)) / max(1, len(content_chars)) / 0.42,
                )
                standalone_value = min(
                    1.0,
                    0.38 * information_length
                    + 0.34 * min(1.0, signal_hits / 4)
                    + 0.28 * lexical_variety,
                )
                filler_matches = re.findall(
                    r"嗯+|呃+|啊+|这个|那个|就是说|然后|那么", transcript
                )
                filler_ratio = min(1.0, sum(len(item) for item in filler_matches) / max(1, len(transcript)))
                language_quality = min(1.0, 0.72 * quality + 0.28 * (1 - filler_ratio))
                total = round(
                    100
                    * (
                        0.25 * opening
                        + 0.30 * standalone_value
                        + 0.25 * completeness
                        + 0.15 * language_quality
                        + 0.05 * duration_fit
                    ),
                    3,
                )
                signature = f"{selected[0]['segment_id']}:{selected[-1]['segment_id']}"
                windows.append(
                    {
                        "segments": list(selected),
                        "start_ms": selected[0]["start_ms"],
                        "end_ms": selected[-1]["end_ms"],
                        "duration_ms": duration,
                        "transcript": transcript,
                        "signature": signature,
                        "score": {
                            "total": total,
                            "base_content_score": total,
                            "selection_engine": "local_content_signals",
                            "opening_hook": round(opening, 3),
                            "standalone_value": round(standalone_value, 3),
                            "content_completeness": round(completeness, 3),
                            "boundary_naturalness": round(completeness, 3),
                            "transcript_quality": round(language_quality, 3),
                            "duration_fit": round(duration_fit, 3),
                            "render_stability": 1.0,
                        },
                    }
                )
                # A few different natural endings are useful, but inspecting every
                # possible end produces many near-identical windows.
                if duration >= target:
                    break
        windows.sort(key=lambda item: (-item["score"]["total"], item["start_ms"]))
        shortlist = windows[:48]
        if experiment_mode == "supoclip_bailian_v1":
            diverse_shortlist = []
            for item in shortlist:
                if any(
                    self._course_time_overlap(item, existing) > 0.35
                    or self._course_text_similarity(
                        item.get("transcript") or "",
                        existing.get("transcript") or "",
                    ) > 0.75
                    for existing in diverse_shortlist
                ):
                    continue
                diverse_shortlist.append(item)
                if len(diverse_shortlist) >= 12:
                    break
            shortlist = diverse_shortlist
        ranker = getattr(self.analyzer, "rank_course_windows", None)
        if theme and callable(ranker) and shortlist:
            try:
                if experiment_mode == "supoclip_bailian_v1":
                    rankings = ranker(
                        shortlist,
                        theme,
                        experiment_mode="supoclip_bailian_v1",
                    )
                else:
                    rankings = ranker(shortlist, theme)
            except ContentEngineError as error:
                if error.code == "cloud_scores_incomplete":
                    raise ContentEngineError(
                        "course_editor_scores_incomplete",
                        "百炼没有返回完整的课程候选评分，请稍后重试。",
                    ) from error
                raise ContentEngineError(
                    "course_editor_unavailable",
                    "百炼内容主编暂时不可用，本次没有用本地规则冒充 AI 推荐；请稍后重试。",
                ) from error
            ranking_by_id = {
                str(item.get("id") or ""): item
                for item in rankings
                if isinstance(item, dict)
                and (
                    experiment_mode != "supoclip_bailian_v1"
                    or all(
                        isinstance(item.get(field), (int, float))
                        and not isinstance(item.get(field), bool)
                        and math.isfinite(float(item[field]))
                        for field in ("hook", "engagement", "value", "shareability")
                    )
                )
            }
            standard_score_fields = (
                "opening_hook",
                "standalone_value",
                "content_completeness",
                "language_quality",
                "theme_relevance",
            )
            if experiment_mode != "supoclip_bailian_v1" and (
                set(ranking_by_id) != {item["signature"] for item in shortlist}
                or any(
                    not all(
                        isinstance(ranking.get(field), (int, float))
                        and not isinstance(ranking.get(field), bool)
                        and math.isfinite(float(ranking[field]))
                        for field in standard_score_fields
                    )
                    for ranking in ranking_by_id.values()
                )
            ):
                raise ContentEngineError(
                    "course_editor_scores_incomplete",
                    "百炼没有返回完整的课程候选评分，请稍后重试。",
                )
            if experiment_mode == "supoclip_bailian_v1":
                shortlist = [
                    item for item in shortlist
                    if item["signature"] in ranking_by_id
                ]
                if not shortlist:
                    raise ContentEngineError(
                        "course_editor_unavailable",
                        "百炼内容主编没有返回有效候选，本次未使用本地评分冒充 AI 推荐，请稍后重试。",
                    )
            for item in shortlist:
                ranking = ranking_by_id.get(item["signature"])
                if not ranking:
                    continue
                score = item["score"]
                if experiment_mode == "supoclip_bailian_v1":
                    visual_quality = sum(
                        float(segment.get("quality_score") or 0)
                        for segment in item.get("segments") or []
                    ) / max(1, len(item.get("segments") or []))

                    def dimension(name):
                        return round(max(0.0, min(25.0, float(ranking[name]))), 3)

                    hook = dimension("hook")
                    engagement = dimension("engagement")
                    value = dimension("value")
                    shareability = dimension("shareability")
                    viral_total = round(hook + engagement + value + shareability, 3)
                    score.update(
                        {
                            "total": viral_total,
                            "base_content_score": viral_total,
                            "opening_hook": round(hook / 25, 3),
                            "standalone_value": round(value / 25, 3),
                            "hook": hook,
                            "engagement": engagement,
                            "value": value,
                            "shareability": shareability,
                            "virality_total": viral_total,
                            "visual_quality": round(visual_quality, 3),
                            "selection_engine": "supoclip_bailian_editor",
                            "editor_reason": ranking.get("reason") or [],
                        }
                    )
                    continue
                opening = float(ranking["opening_hook"])
                standalone = float(ranking["standalone_value"])
                completeness = float(ranking["content_completeness"])
                language = float(ranking["language_quality"])
                relevance = float(ranking["theme_relevance"])
                ai_total = round(
                    100
                    * (
                        0.25 * opening
                        + 0.30 * standalone
                        + 0.20 * completeness
                        + 0.10 * language
                        + 0.10 * relevance
                        + 0.05 * score["duration_fit"]
                    ),
                    3,
                )
                score.update(
                    {
                        "total": ai_total,
                        "base_content_score": ai_total,
                        "opening_hook": round(opening, 3),
                        "standalone_value": round(standalone, 3),
                        "content_completeness": round(completeness, 3),
                        "boundary_naturalness": round(completeness, 3),
                        "transcript_quality": round(language, 3),
                        "theme_relevance": round(relevance, 3),
                        "selection_engine": "bailian_editor",
                        "editor_reason": ranking.get("reason") or [],
                    }
                )
            if experiment_mode == "supoclip_bailian_v1":
                # Only candidates actually sent through the isolated editor are
                # eligible for this experiment. If diversity reduces capacity,
                # returning fewer clips is safer than silently mixing engines.
                windows = sorted(
                    shortlist,
                    key=lambda item: (-item["score"]["total"], item["start_ms"]),
                )
            else:
                windows.sort(
                    key=lambda item: (-item["score"]["total"], item["start_ms"])
                )
        selected = []
        signatures = set()
        for item in windows:
            if item["signature"] in signatures:
                continue
            temporal_overlap = max(
                (self._course_time_overlap(item, existing) for existing in selected),
                default=0.0,
            )
            transcript_similarity = max(
                (
                    self._course_text_similarity(
                        item.get("transcript") or "", existing.get("transcript") or ""
                    )
                    for existing in selected
                ),
                default=0.0,
            )
            if temporal_overlap > 0.35 or transcript_similarity > 0.75:
                continue
            diversity = 1 - max(temporal_overlap, transcript_similarity)
            item["score"]["diversity"] = round(diversity, 3)
            item["score"]["total"] = round(
                0.9 * item["score"]["base_content_score"] + 10 * diversity, 3
            )
            reasons = list(item["score"].get("editor_reason") or [])[:3]
            if item["score"]["opening_hook"] >= 0.65:
                reasons.append("开头有吸引力")
            if item["score"]["standalone_value"] >= 0.66:
                reasons.append("观点可独立成立")
            if item["score"]["content_completeness"] >= 0.8:
                reasons.append("起止完整")
            if diversity >= 0.8:
                reasons.append("与其他候选低重复")
            item["score"]["recommendation_reason"] = list(dict.fromkeys(reasons))[:4] or [
                "内容与切点综合较优"
            ]
            selected.append(item)
            signatures.add(item["signature"])
            if len(selected) >= count:
                break
        return selected

    def _pilot_voice_backbones(self, segments, asset_id, count):
        """Build forgiving voice windows for a first real-material run.

        The normal selector requires contiguous, sentence-complete 30–90s
        viewpoints. Newly uploaded classroom recordings often have short ASR
        sentences or small timestamp gaps. Pilot mode keeps the source time
        codes but bridges those gaps inside a bounded local window so a real
        sample can be rendered before the stricter gate is enabled.
        """
        if not segments:
            return []
        row = self._asset_row(asset_id)
        source_duration = int(row["duration_ms"] or 0)
        ordered = sorted(segments, key=lambda item: (item["start_ms"], item["end_ms"]))
        windows = []
        used_ranges = []
        for segment in ordered:
            if len(windows) >= max(1, int(count)):
                break
            start = max(0, int(segment["start_ms"]))
            available_end = source_duration or int(ordered[-1]["end_ms"])
            end = min(available_end, start + 60_000)
            if end <= start:
                continue
            if any(
                max(0, min(end, right) - max(start, left))
                > min(end - start, right - left) * 0.75
                for left, right in used_ranges
            ):
                continue
            selected = [
                item
                for item in ordered
                if int(item["start_ms"]) < end and int(item["end_ms"]) > start
            ] or [segment]
            quality = sum(float(item.get("quality_score") or 0) for item in selected) / len(selected)
            transcript = "".join(
                str(item.get("transcript_text") or "").strip() for item in selected
            )
            windows.append(
                {
                    "start_ms": start,
                    "end_ms": end,
                    "duration_ms": end - start,
                    "segments": selected,
                    "signature": "pilot:" + _canonical_hash(
                        [item["segment_id"] for item in selected]
                    )[:32],
                    "transcript": transcript,
                    "score": {
                        "total": round(50 + quality * 25, 3),
                        "base_content_score": round(50 + quality * 25, 3),
                        "transcript_quality": round(quality, 3),
                        "content_completeness": 0.5,
                        "boundary_naturalness": 0.5,
                        "opening_hook": 0.5,
                        "standalone_value": 0.5,
                        "duration_fit": 0.5,
                        "render_stability": 1.0,
                        "selection_engine": "pilot_local_fallback",
                    },
                }
            )
            used_ranges.append((start, end))
        return windows

    def _pilot_asset_segment(self, asset_id):
        """Return one bounded source segment when ASR failed but probing worked."""
        row = self._asset_row(asset_id)
        if row["media_kind"] != "video" or not row["duration_ms"]:
            return []
        end = max(1, int(row["duration_ms"]))
        return [{
            "segment_id": f"pilot_asset:{asset_id}",
            "asset_id": asset_id,
            "start_ms": 0,
            "end_ms": end,
            "transcript_text": "",
            "speaker": "unknown",
            "role": "general",
            "shot_type": "unknown",
            "tags": [],
            "quality_score": 0.5,
            "metadata": {"sentence_complete": True, "words": []},
            "media_kind": "video",
        }]

    @staticmethod
    def _course_time_overlap(left, right):
        overlap = max(
            0,
            min(int(left["end_ms"]), int(right["end_ms"]))
            - max(int(left["start_ms"]), int(right["start_ms"])),
        )
        shortest = min(int(left["duration_ms"]), int(right["duration_ms"]))
        return overlap / max(1, shortest)

    @staticmethod
    def _course_text_similarity(left, right):
        def grams(value):
            normalized = "".join(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", str(value).lower()))
            return {normalized[index:index + 2] for index in range(max(0, len(normalized) - 1))}

        left_grams = grams(left)
        right_grams = grams(right)
        if not left_grams or not right_grams:
            return 0.0
        return len(left_grams & right_grams) / len(left_grams | right_grams)

    @staticmethod
    def _course_title(window, index):
        candidates = []
        for position, segment in enumerate(window.get("segments") or []):
            text = COURSE_LEADING_FILLERS.sub(
                "", str(segment.get("transcript_text") or "").strip()
            )
            for clause in re.split(r"[。！？!?；;]", text):
                clause = clause.strip(" ，,、：:")
                if len(clause) < 6:
                    continue
                signal = sum(marker in clause for marker in COURSE_HOOK_MARKERS)
                signal += 0.5 * sum(marker in clause for marker in COURSE_ACTION_MARKERS)
                candidates.append((signal, -position, len(clause), clause))
        if not candidates:
            return f"课程观点 {index + 1}"
        clause = max(candidates)[-1]
        return clause if len(clause) <= 22 else f"{clause[:22]}…"

    def _course_recipe(
        self,
        asset_id,
        window,
        *,
        subtitle_font_size=48,
        subtitle_margin_bottom=170,
        experiment_mode=None,
        subtitle_preset="dynamic_clean",
        include_word_timestamps=False,
    ):
        is_supoclip_experiment = experiment_mode == "supoclip_bailian_v1"
        recipe = {
            "kind": "course",
            "layout": "auto_portrait",
            "subtitle_style": {
                "preset": subtitle_preset if is_supoclip_experiment else "dynamic_clean",
                "font_size": subtitle_font_size,
                "margin_bottom": subtitle_margin_bottom,
                "max_chars": 14 if subtitle_preset == "knowledge_course" else 12,
            },
            "voice_segment": {
                "asset_id": asset_id,
                "start_ms": window["start_ms"],
                "end_ms": window["end_ms"],
            },
            "visual_segments": [
                {
                    "segment_id": item["segment_id"],
                    "asset_id": item["asset_id"],
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "target_duration_ms": item["end_ms"] - item["start_ms"],
                    "media_kind": item["media_kind"],
                    "shot_type": item["shot_type"],
                    "tags": item["tags"],
                    "frame_mode": self._course_frame_mode(item),
                }
                for item in window["segments"]
            ],
            "captions": [
                self._course_caption(
                    item,
                    include_words=(
                        is_supoclip_experiment or bool(include_word_timestamps)
                    ),
                )
                for item in window["segments"]
            ],
        }
        if is_supoclip_experiment:
            recipe["experiment_mode"] = "supoclip_bailian_v1"
        return recipe

    @classmethod
    def _course_caption(cls, segment, *, include_words=False):
        caption = {
            "start_ms": segment["start_ms"],
            "end_ms": segment["end_ms"],
            "text": segment["transcript_text"],
        }
        if include_words:
            caption["words"] = cls._course_caption_words(segment)
        return caption

    @staticmethod
    def _course_caption_words(segment):
        segment_start = int(segment["start_ms"])
        segment_end = int(segment["end_ms"])
        speaker = str(segment.get("speaker") or "")[:80]
        normalized = []
        for word in (segment.get("metadata") or {}).get("words") or []:
            if not isinstance(word, dict):
                continue
            text = str(word.get("text") or word.get("word") or "").strip()
            punctuation = str(word.get("punctuation") or "").strip()
            if punctuation and not text.endswith(punctuation):
                text += punctuation
            try:
                start = int(
                    word.get("begin_time")
                    if word.get("begin_time") is not None
                    else word.get("start")
                    if word.get("start") is not None
                    else word.get("start_ms")
                )
                end = int(
                    word.get("end_time")
                    if word.get("end_time") is not None
                    else word.get("end")
                    if word.get("end") is not None
                    else word.get("end_ms")
                )
            except (TypeError, ValueError):
                continue
            if not text or start < segment_start or end > segment_end or end <= start:
                continue
            confidence = word.get("confidence")
            if (
                not isinstance(confidence, (int, float))
                or isinstance(confidence, bool)
                or not math.isfinite(float(confidence))
                or not 0 <= float(confidence) <= 1
            ):
                confidence = None
            else:
                confidence = float(confidence)
            normalized.append(
                {
                    "text": text[:80],
                    "start": start,
                    "end": end,
                    "confidence": confidence,
                    "speaker": str(
                        word.get("speaker") or word.get("speaker_id") or speaker
                    )[:80],
                }
            )
        normalized.sort(key=lambda item: (item["start"], item["end"]))
        return normalized

    @staticmethod
    def _course_frame_mode(segment):
        evidence = {
            str(segment.get("shot_type") or "").casefold(),
            *(str(tag).casefold() for tag in segment.get("tags") or []),
        }
        presentation_markers = {
            "slide", "slides", "screen", "presentation", "deck", "课件", "屏幕", "投影"
        }
        return (
            "slide_with_teacher_pip"
            if evidence & presentation_markers
            else "teacher_focus"
        )

    def _mix_recipe(self, backbone, choice, *, include_word_timestamps=False):
        duration = backbone["duration_ms"]
        allocations = (round(duration * 0.2), round(duration * 0.6))
        targets = (allocations[0], allocations[1], duration - sum(allocations))
        voice_asset_id = backbone["segments"][0]["asset_id"]
        recipe = {
            "kind": "mix",
            "layout": "three_part_story",
            "voice_segment": {
                "asset_id": voice_asset_id,
                "start_ms": backbone["start_ms"],
                "end_ms": backbone["end_ms"],
            },
            "visual_segments": [
                {
                    "role": role,
                    "segment_id": item["segment_id"],
                    "asset_id": item["asset_id"],
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "target_duration_ms": target,
                    "media_kind": item["media_kind"],
                }
                for role, item, target in zip(ROLE_ORDER, choice, targets)
            ],
            "captions": [
                self._course_caption(
                    item, include_words=bool(include_word_timestamps)
                )
                for item in backbone["segments"]
            ],
        }
        recipe["skeleton_id"] = self._skeleton_id(recipe)
        return recipe

    @staticmethod
    def _pilot_broll_recipe(choice):
        """Make a short, non-looping montage from visual-only source clips."""
        visual_segments = []
        total_duration = 0
        for index, item in enumerate(choice):
            source_duration = max(
                1, int(item.get("end_ms") or 0) - int(item.get("start_ms") or 0)
            )
            # Effects-style references work best as a sequence of short
            # shots. Never stretch one source clip to fill the whole video.
            target_duration = min(source_duration, 12_000)
            visual_segments.append(
                {
                    "role": ("hook", "process", "result")[index],
                    "segment_id": item["segment_id"],
                    "asset_id": item["asset_id"],
                    "start_ms": int(item.get("start_ms") or 0),
                    "end_ms": int(item.get("start_ms") or 0) + target_duration,
                    "target_duration_ms": target_duration,
                    "media_kind": item.get("media_kind") or "video",
                }
            )
            total_duration += target_duration
        first = visual_segments[0]
        recipe = {
            "kind": "mix",
            "layout": "visual_montage",
            "audio_mode": "visual_montage",
            "voice_segment": {
                "asset_id": first["asset_id"],
                "start_ms": first["start_ms"],
                "end_ms": first["start_ms"] + total_duration,
            },
            "visual_segments": visual_segments,
            "captions": [],
        }
        recipe["skeleton_id"] = CreativeDomain._skeleton_id(recipe)
        return recipe

    @staticmethod
    def _skeleton_id(recipe):
        """Stable, machine-checkable identity for a three-part visual backbone."""
        parts = []
        for index, item in enumerate(recipe.get("visual_segments") or []):
            if not isinstance(item, dict):
                continue
            parts.append(
                {
                    "order": index,
                    "role": str(item.get("role") or ""),
                    "asset_id": str(item.get("asset_id") or ""),
                    "segment_id": str(item.get("segment_id") or ""),
                    "start_ms": int(item.get("start_ms") or 0),
                    "end_ms": int(item.get("end_ms") or 0),
                    "target_duration_ms": int(item.get("target_duration_ms") or 0),
                }
            )
        return f"skeleton_{_canonical_hash(parts)[:32]}"

    @staticmethod
    def _mix_score(choice, backbone):
        visual_quality = sum(item["quality_score"] for item in choice) / len(choice)
        diversity = len({item["asset_id"] for item in choice}) / len(choice)
        total = round(100 * (0.35 + 0.2 + 0.15 + 0.1 + 0.1 * visual_quality + 0.1 * diversity), 3)
        return {
            "total": total,
            "content_completeness": 1.0,
            "boundary_naturalness": 1.0,
            "transcript_quality": backbone["score"].get("transcript_quality", 0),
            "render_stability": 1.0,
            "visual_quality": round(visual_quality, 3),
            "diversity": round(diversity, 3),
        }

    def _insert_generated(
        self,
        project_id,
        task_id,
        kind,
        recipe,
        score,
        title,
        duration_ms,
        *,
        recommended,
        signature=None,
        generation=1,
    ):
        signature = signature or self._recipe_signature(recipe)
        existing = self.connection.execute(
            """
            SELECT id, status FROM generated_videos
            WHERE project_id = ? AND selection_signature = ? AND generation = ?
            """,
            (project_id, signature, generation),
        ).fetchone()
        if existing is not None:
            if existing["status"] not in {"completed", "rejected"}:
                self.connection.execute(
                    """
                    UPDATE generated_videos
                    SET task_id = ?, recipe_json = ?, score_json = ?, title = ?,
                        duration_ms = ?, recommended = ?, status = 'queued',
                        output_path = NULL, thumbnail_path = NULL,
                        error_code = NULL, error_message = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        task_id,
                        self._json(recipe),
                        self._json(score),
                        title,
                        int(duration_ms),
                        int(recommended),
                        self._now(),
                        existing["id"],
                    ),
                )
            self._reserve_cover_operation(existing["id"], recipe, generation)
            return existing["id"]
        video_id = self._new_id("generated_video")
        now = self._now()
        self.connection.execute(
            """
            INSERT INTO generated_videos(
                id, project_id, task_id, kind, generation, selection_signature,
                recipe_json, score_json, title, duration_ms, recommended,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                video_id,
                project_id,
                task_id,
                kind,
                generation,
                signature,
                self._json(recipe),
                self._json(score),
                title,
                int(duration_ms),
                int(recommended),
                now,
                now,
            ),
        )
        self._reserve_cover_operation(video_id, recipe, generation)
        return video_id

    def _reserve_cover_operation(self, video_id, recipe, generation):
        packaging = recipe.get("packaging") or {}
        cover = packaging.get("cover") or {}
        if cover.get("mode") != "ai_generate":
            return None
        prompt_version = str(cover.get("prompt_version") or COVER_PROMPT_VERSION)[:64]
        revision = max(0, int(cover.get("revision") or 0))
        request_key = _stable_id(
            "cover_request",
            video_id,
            generation,
            "apimart_gpt_image_2",
            prompt_version,
            revision,
        )
        now = self._now()
        self.connection.execute(
            """
            INSERT OR IGNORE INTO cover_generation_ledger(
                id, generated_video_id, request_key, estimated_calls,
                created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?)
            """,
            (self._new_id("cover_operation"), video_id, request_key, now, now),
        )
        return self.connection.execute(
            "SELECT * FROM cover_generation_ledger WHERE request_key = ?",
            (request_key,),
        ).fetchone()

    def _render_generated(self, video_id, *, task_id=None):
        row = self._generated_row(video_id)
        if row["status"] == "rejected":
            return False
        if (
            row["status"] == "completed"
            and row["output_path"]
            and row["thumbnail_path"]
            and Path(row["output_path"]).is_file()
            and Path(row["thumbnail_path"]).is_file()
        ):
            return True
        if task_id and self._should_stop(task_id):
            return False
        self.connection.execute(
            "UPDATE generated_videos SET status = 'rendering', updated_at = ? WHERE id = ?",
            (self._now(), video_id),
        )
        try:
            output_dir = self.data_dir / "generated" / row["project_id"] / video_id
            recipe = json.loads(row["recipe_json"])
            self._validate_auto_mix_v2_runtime_resources(recipe)
            rendered = self.renderer.render(
                video_id=video_id,
                recipe=recipe,
                output_dir=output_dir,
                resolve_asset_path=self._resolve_render_asset_path,
            )
            cover = (recipe.get("packaging") or {}).get("cover") or {}
            if cover.get("mode") == "reuse":
                source_id = str(cover.get("source_generated_video_id") or "")
                source_row = self._generated_row(source_id)
                source_thumbnail = self._validate_generated_path(
                    source_row["thumbnail_path"]
                )
                target_thumbnail = Path(rendered["thumbnail_path"]).resolve(strict=True)
                if source_thumbnail != target_thumbnail:
                    shutil.copyfile(source_thumbnail, target_thumbnail)
            video_path = self._validate_generated_path(rendered["video_path"])
            thumbnail_path = self._validate_generated_path(rendered["thumbnail_path"])
            if cover.get("mode") == "local_frame":
                cover["status"] = "completed"
            if recipe.get("product_workflow") == "one_click_v2":
                report = validate_quality_report(
                    rendered.get("audioQualityReport")
                )
                recipe["audio_quality_report"] = {
                    "integrated_lufs": report["integratedLufs"],
                    "true_peak_dbtp": report["truePeakDbtp"],
                    "speech_music_margin_lu": report["speechMusicMarginLu"],
                }
                validate_formal_recipe(recipe)
            persisted_recipe = self._json(recipe)
            if task_id and self._should_stop(task_id):
                self.connection.execute(
                    """
                    UPDATE generated_videos
                    SET status = 'completed', output_path = ?, thumbnail_path = ?,
                        recipe_json = ?, error_code = NULL, error_message = NULL,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        str(video_path),
                        str(thumbnail_path),
                        persisted_recipe,
                        self._now(),
                        video_id,
                    ),
                )
                return False
            self.connection.execute(
                """
                UPDATE generated_videos
                SET status = 'completed', output_path = ?, thumbnail_path = ?,
                    recipe_json = ?, error_code = NULL, error_message = NULL,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    str(video_path),
                    str(thumbnail_path),
                    persisted_recipe,
                    self._now(),
                    video_id,
                ),
            )
            return True
        except Exception as error:
            code = error.code if isinstance(error, ContentEngineError) else "render_failed"
            self.connection.execute(
                """
                UPDATE generated_videos
                SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                """,
                (code, redact_text(str(error))[:500], self._now(), video_id),
            )
            if isinstance(error, ContentEngineError):
                raise
            raise ContentEngineError("render_failed", "AI 剪辑成片渲染失败。") from error

    def _reconcile_project_rendering(self, project_id):
        self.connection.execute(
            """
            UPDATE generated_videos
            SET status = 'queued', output_path = NULL, thumbnail_path = NULL,
                updated_at = ?
            WHERE project_id = ? AND status = 'rendering'
            """,
            (self._now(), project_id),
        )

    def _reconcile_generated_rendering(self, video_id):
        self.connection.execute(
            """
            UPDATE generated_videos
            SET status = 'queued', output_path = NULL, thumbnail_path = NULL,
                updated_at = ?
            WHERE id = ? AND status = 'rendering'
            """,
            (self._now(), video_id),
        )

    def _register_finished_for_project(self, project_id, task_id):
        rows = self.connection.execute(
            """
            SELECT * FROM generated_videos
            WHERE project_id = ? AND status = 'completed' AND output_path IS NOT NULL
            """,
            (project_id,),
        ).fetchall()
        now = self._now()
        with self.database.transaction() as connection:
            for row in rows:
                path = Path(row["output_path"])
                if not path.is_file():
                    continue
                finished_id = _stable_id("finished", row["id"])
                metadata = {
                    "source": "creative_workbench",
                    "generated_video_id": row["id"],
                    "project_id": project_id,
                    "kind": row["kind"],
                    "recommended": bool(row["recommended"]),
                    "internal_only": True,
                }
                batch_row = connection.execute("SELECT id,state_json FROM narrated_batches_v1 WHERE project_id=?", (project_id,)).fetchone()
                if batch_row:
                    batch_state = self._json_object(batch_row["state_json"])
                    metadata.update(narrated_batch_id=batch_row["id"], batch_title=batch_state.get("title", ""))
                connection.execute(
                    """
                    INSERT OR IGNORE INTO finished_videos(
                        id, task_id, output_path, display_name, title, size_bytes,
                        metadata_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        finished_id,
                        task_id,
                        str(path),
                        path.name,
                        row["title"],
                        path.stat().st_size,
                        self._json(metadata),
                        now,
                    ),
                )

    def _segments_for_assets(self, asset_ids, *, role=None, transcript_only=False):
        if not asset_ids:
            return []
        placeholders = ",".join("?" for _ in asset_ids)
        clauses = [f"s.asset_id IN ({placeholders})"]
        values = list(asset_ids)
        if role:
            clauses.append("s.role = ?")
            values.append(role)
        if transcript_only:
            clauses.append("length(trim(s.transcript_text)) > 0")
        rows = self.connection.execute(
            f"""
            SELECT s.*, a.media_kind, a.display_name
            FROM media_segments s
            JOIN assets a ON a.id = s.asset_id
            WHERE {' AND '.join(clauses)}
              AND s.analysis_version = (
                  SELECT latest.analysis_version
                  FROM media_segments latest
                  WHERE latest.asset_id = s.asset_id
                  ORDER BY latest.updated_at DESC, latest.rowid DESC
                  LIMIT 1
              )
            ORDER BY s.asset_id, s.start_ms
            """,
            values,
        ).fetchall()
        return [self._private_segment(row) for row in rows]

    def _private_segment(self, row):
        return {
            "segment_id": row["id"],
            "asset_id": row["asset_id"],
            "start_ms": row["start_ms"],
            "end_ms": row["end_ms"],
            "transcript_text": row["transcript_text"],
            "speaker": row["speaker"],
            "role": row["role"],
            "shot_type": row["shot_type"],
            "tags": json.loads(row["tags_json"]),
            "quality_score": row["quality_score"],
            "metadata": json.loads(row["metadata_json"]),
            "media_kind": row["media_kind"] if "media_kind" in row.keys() else "video",
        }

    def _public_segment(self, row):
        private = self._private_segment(row)
        return {
            "segment_id": private["segment_id"],
            "asset_id": private["asset_id"],
            "start_ms": private["start_ms"],
            "end_ms": private["end_ms"],
            "transcript": private["transcript_text"][:1_000],
            "speaker": private["speaker"],
            "role": private["role"],
            "shot_type": private["shot_type"],
            "tags": private["tags"],
            "quality_score": private["quality_score"],
            "provider": row["provider"],
            "thumbnail_ready": bool(row["thumbnail_derivative_id"]),
        }

    def _public_generated(
        self, row, *, capability=None, cover_operation_lookup=None
    ):
        score = json.loads(row["score_json"])
        recipe = json.loads(row["recipe_json"])
        voice = recipe.get("voice_segment") or {}
        visual_segments = [
            item
            for item in (recipe.get("visual_segments") or [])
            if isinstance(item, dict) and str(item.get("asset_id") or "").strip()
        ]
        source_asset_count = len(
            {str(item["asset_id"]).strip() for item in visual_segments}
        )
        public_captions = [
            item
            for item in (recipe.get("captions") or [])
            if isinstance(item, dict) and str(item.get("text") or "").strip()
        ]
        caption_sources = {
            str(item.get("caption_source") or "").strip()
            for item in public_captions
            if str(item.get("caption_source") or "").strip()
            in {"tts_voiceover", "source_transcript"}
        }
        if len(caption_sources) == 1:
            caption_source = next(iter(caption_sources))
        elif (
            not caption_sources
            and public_captions
            and str(voice.get("asset_id") or "").strip()
        ):
            # Legacy course/mix recipes predate caption_source but their
            # caption lane follows the persisted voice backbone.
            caption_source = "source_transcript"
        else:
            # Missing or conflicting provenance is not presented as speech.
            caption_source = "none"
        packaging = recipe.get("packaging") or {}
        cover = packaging.get("cover") or {}
        director = packaging.get("director") or {}
        preset = packaging.get("preset_id")
        visual = packaging.get("visualRenderer")
        if not isinstance(visual, dict):
            visual = packaging.get("visual_renderer")
        visual = visual if isinstance(visual, dict) else None
        capability = capability or self._visual_comparison_capability_snapshot()
        phone_review = self.connection.execute(
            """
            SELECT * FROM creative_media_reviews
            WHERE generated_video_id = ? AND device = 'phone'
            ORDER BY reviewed_at DESC, rowid DESC LIMIT 1
            """,
            (row["id"],),
        ).fetchone()
        cover_operation = (
            cover_operation_lookup.get(row["id"])
            if cover_operation_lookup is not None
            else self.connection.execute(
                """
                SELECT * FROM cover_generation_ledger
                WHERE generated_video_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (row["id"],),
            ).fetchone()
        )

        def visual_value(camel, snake=None, default=None):
            if not visual:
                return default
            if camel in visual:
                return visual.get(camel)
            if snake and snake in visual:
                return visual.get(snake)
            return default

        requested_engine = (
            str(visual_value("requestedEngine", "requested_engine", "ffmpeg") or "ffmpeg")
            if visual
            else "ffmpeg"
        )
        actual_engine = (
            str(visual_value("actualEngine", "actual_engine", "") or "") or None
            if visual
            else "ffmpeg"
        )
        cover_status = (
            cover_operation["status"] if cover_operation is not None else cover.get("status")
        )
        public_cover = (
            self._public_cover_operation(cover_operation)
            if cover_operation is not None
            else None
        )
        return {
            "generated_video_id": row["id"],
            "project_id": row["project_id"],
            "task_id": row["task_id"],
            "kind": row["kind"],
            "skeleton_id": recipe.get("skeleton_id"),
            "status": row["status"],
            "generation": row["generation"],
            "selection_signature": row["selection_signature"],
            "title": row["title"],
            "duration_ms": row["duration_ms"],
            "recommended": bool(row["recommended"]),
            "score": sanitize_public_value(score),
            "packaging_preset_id": preset,
            "packaging_preset_name": preset_display_name(row["kind"], preset),
            "packaging_version": packaging.get("version"),
            "brand_profile_id": packaging.get("brand_profile_id"),
            "cover_status": cover_status,
            "cover_phase": (
                public_cover["phase"]
                if public_cover is not None
                else self._cover_phase(None, cover_status)
            ),
            "cover_network_submitted": bool(
                public_cover and public_cover["network_submitted"]
            ),
            "cover_issue_code": (
                public_cover["error_code"] if public_cover is not None else None
            ),
            "phone_review": self._public_media_review(phone_review) if phone_review else None,
            "motion_director_provider": director.get("provider"),
            "motion_event_count": len(
                [event for event in packaging.get("events") or [] if event.get("text")]
            ),
            "requested_engine": requested_engine,
            "requested_style_id": visual_value("visualStyleId", "visual_style_id"),
            "requested_style_version": visual_value(
                "requestedStyleVersion", "requested_style_version"
            ),
            "actual_engine": actual_engine,
            "actual_style_version": visual_value(
                "actualStyleVersion", "actual_style_version"
            ),
            "fallback_code": visual_value("fallbackCode", "fallback_code"),
            "comparison_group_id": visual_value(
                "comparisonGroupId", "comparison_group_id"
            ),
            "comparison_source_candidate_id": (
                visual_value("sourceCandidateId", "source_candidate_id")
                or visual_value("comparisonSourceId", "comparison_source_id")
            ),
            "render_request_hash": visual_value(
                "renderRequestHash", "render_request_hash"
            ),
            "remotion_packaging_capable": capability["remotion_available"],
            "visual_comparison_capable": capability["available"],
            "visual_renderer_legacy": visual is None,
            "source_asset_id": voice.get("asset_id"),
            "source_start_ms": voice.get("start_ms"),
            "source_end_ms": voice.get("end_ms"),
            "source_asset_count": source_asset_count,
            "shot_count": len(visual_segments),
            "caption_source": caption_source,
            "preview_ready": row["status"] == "completed" and bool(row["output_path"]),
            "thumbnail_ready": row["status"] == "completed" and bool(row["thumbnail_path"]),
            "error_code": row["error_code"],
            "error_message": redact_text(row["error_message"]) if row["error_message"] else None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _create_task(self, task_type, payload):
        task_id = self._new_id("task")
        now = self._now()
        self.connection.execute(
            """
            INSERT INTO content_tasks(
                id, task_type, status, payload_json, created_at, updated_at
            ) VALUES (?, ?, 'queued', ?, ?, ?)
            """,
            (task_id, task_type, self._json(payload), now, now),
        )
        return self._public_task(self._task_row(task_id))

    def _set_task(
        self,
        task_id,
        status,
        *,
        progress=None,
        result=None,
        error_code=None,
        error_message=None,
    ):
        assignments = ["status = ?", "updated_at = ?"]
        values = [status, self._now()]
        if progress is not None:
            assignments.append("progress = ?")
            values.append(min(1.0, max(0.0, float(progress))))
        if result is not None:
            assignments.append("result_json = ?")
            values.append(self._json(sanitize_public_value(result)))
        if status == "failed":
            assignments.extend(("error_code = ?", "error_message = ?"))
            values.extend((str(error_code or "creative_task_failed")[:64], redact_text(str(error_message or ""))[:500]))
        elif status not in {"paused"}:
            assignments.extend(("error_code = NULL", "error_message = NULL", "resume_from_status = NULL"))
        values.append(task_id)
        cursor = self.connection.execute(
            f"""
            UPDATE content_tasks SET {', '.join(assignments)}
            WHERE id = ? AND status NOT IN ('paused', 'cancelled')
            """,
            values,
        )
        return cursor.rowcount > 0

    def _pause_task_for_cover_recovery(self, task_id, payload, error):
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE content_tasks
                SET resume_from_status = status,
                    status = 'paused',
                    error_code = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                  AND status IN ('queued', 'analyzing', 'ready_for_review', 'rendering')
                """,
                (
                    str(error.code or "cover_recovery_required")[:64],
                    redact_text(str(error.message or ""))[:500],
                    now,
                    task_id,
                ),
            )
            project_id = payload.get("project_id") if isinstance(payload, dict) else None
            if project_id:
                connection.execute(
                    "UPDATE creative_projects SET status = 'paused', updated_at = ? WHERE id = ?",
                    (now, project_id),
                )

    def _pause_task_for_local_recovery(self, task_id, error):
        self.connection.execute(
            """
            UPDATE content_tasks
            SET resume_from_status = status,
                status = 'paused', error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ?
              AND status IN ('queued', 'analyzing', 'ready_for_review', 'rendering')
            """,
            (
                str(error.code or "comparison_recovery_required")[:64],
                redact_text(str(error.message or ""))[:500],
                self._now(),
                task_id,
            ),
        )

    def _update_project(self, project_id, status, *, result=None):
        assignments = ["status = ?", "updated_at = ?"]
        values = [status, self._now()]
        if result is not None:
            assignments.append("result_json = ?")
            values.append(self._json(result))
        values.append(project_id)
        self.connection.execute(
            f"UPDATE creative_projects SET {', '.join(assignments)} WHERE id = ?", values
        )

    def _sync_stopped_project(self, project_id, status):
        if project_id and status in {"paused", "cancelled"}:
            self._update_project(project_id, status)

    def _project_failure_result(self, project_id, error_code):
        try:
            current = json.loads(self._project_row(project_id)["result_json"])
        except (TypeError, ValueError):
            current = {}
        if not isinstance(current, dict):
            current = {}
        return {**current, "error_code": error_code}

    @staticmethod
    def _capacity_result(maximum, count_is_exact, missing_roles, skipped_assets=None):
        result = {
            "maximum_qualified_count": int(maximum),
            "count_is_exact": bool(count_is_exact),
            "missing_roles": list(missing_roles),
            "required_roles": list(ROLE_ORDER),
        }
        if skipped_assets:
            result["skipped_assets"] = sanitize_public_value(skipped_assets)
        return result

    def _comparison_candidate_lookup(self, rows):
        candidate_ids = []
        seen_candidate_ids = set()
        for row in rows:
            if row["task_type"] != "creative_visual_comparison":
                continue
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, ValueError):
                continue
            for entry in payload.get("entries") or []:
                if not isinstance(entry, dict):
                    continue
                candidate_id = entry.get("candidate_id")
                if candidate_id and candidate_id not in seen_candidate_ids:
                    seen_candidate_ids.add(candidate_id)
                    candidate_ids.append(candidate_id)
        if not candidate_ids:
            return {}
        placeholders = ", ".join("?" for _candidate_id in candidate_ids)
        candidates = self.connection.execute(
            f"SELECT * FROM generated_videos WHERE id IN ({placeholders})",
            candidate_ids,
        ).fetchall()
        return {candidate["id"]: candidate for candidate in candidates}

    def _public_task(self, row, *, capability=None, candidate_lookup=None):
        result = {
            "task_id": row["id"],
            "task_type": row["task_type"],
            "status": row["status"],
            "resume_from_status": row["resume_from_status"],
            "progress": row["progress"],
            "error_code": row["error_code"],
            "error_message": redact_text(row["error_message"]) if row["error_message"] else None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        try:
            task_payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            task_payload = {}
        if isinstance(task_payload, dict) and task_payload.get("project_id"):
            result["project_id"] = str(task_payload["project_id"])
        if (
            row["task_type"] in {
                "auto_mix_v2_generation",
                "auto_mix_v2_regeneration",
            }
            and isinstance(task_payload, dict)
            and task_payload.get("run_id")
        ):
            result["run_id"] = str(task_payload["run_id"])
        if row["task_type"] == "creative_analysis":
            try:
                summary = json.loads(row["result_json"] or "{}")
            except (TypeError, ValueError):
                summary = {}
            if isinstance(summary, dict):
                try:
                    analyzed_count = max(0, int(summary.get("analyzed_count") or 0))
                    requested_count = max(0, int(summary.get("requested_count") or 0))
                except (TypeError, ValueError):
                    analyzed_count = 0
                    requested_count = 0
                result["analysis_summary"] = {
                    "analyzed_count": analyzed_count,
                    "requested_count": requested_count,
                    "provider": str(summary.get("provider") or "local")[:64],
                    "cloud_configured": bool(summary.get("cloud_configured")),
                    "skipped_assets": sanitize_public_value(
                        summary.get("skipped_assets") or []
                    ),
                }
        if row["task_type"] != "creative_visual_comparison":
            return result
        payload = task_payload
        if not isinstance(payload, dict):
            return result
        capability = capability or self._visual_comparison_capability_snapshot()
        safe_entries = []
        for entry in payload.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            try:
                candidate_id = entry.get("candidate_id")
                candidate = (
                    candidate_lookup.get(candidate_id)
                    if candidate_lookup is not None
                    else self._generated_row(candidate_id)
                )
                if candidate is None:
                    raise ContentEngineError(
                        "generated_video_not_found", "The generated video was not found."
                    )
                public_candidate = self._public_generated(
                    candidate, capability=capability
                )
            except ContentEngineError:
                public_candidate = {}
            safe_entries.append(
                {
                    "candidate_id": entry.get("candidate_id"),
                    "status": public_candidate.get("status"),
                    "requested_engine": public_candidate.get("requested_engine", "remotion"),
                    "requested_style_id": entry.get("style_id"),
                    "requested_style_version": entry.get("style_version"),
                    "actual_engine": public_candidate.get("actual_engine"),
                    "actual_style_version": public_candidate.get("actual_style_version"),
                    "fallback_code": public_candidate.get("fallback_code"),
                    "render_request_hash": entry.get("render_request_hash"),
                }
            )
        return {
            **result,
            "comparison_group_id": payload.get("comparison_group_id"),
            "comparison_source_candidate_id": payload.get("source_candidate_id"),
            "style_order": payload.get("style_order") or [],
            "render_count": 3,
            "bailian_calls": 0,
            "apimart_calls": 0,
            "remotion_packaging_capable": capability["remotion_available"],
            "visual_comparison_capable": capability["available"],
            "candidates": safe_entries,
        }

    def _asset_row(self, asset_id):
        row = self.connection.execute(
            "SELECT * FROM assets WHERE id = ? AND archived_at IS NULL", (asset_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("asset_not_found", "The selected asset was not found.")
        return row

    def _brand_row(self, profile_id):
        row = self.connection.execute(
            "SELECT * FROM brand_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("brand_profile_not_found", "The brand profile was not found.")
        return row

    @staticmethod
    def _public_brand(row):
        return {
            "brand_profile_id": row["id"],
            "name": row["name"],
            "logo_asset_id": row["logo_asset_id"],
            "reference_portrait_asset_id": row["reference_portrait_asset_id"],
            "primary_color": row["primary_color"],
            "accent_color": row["accent_color"],
            "font_preset": row["font_preset"],
            "outro_text": row["outro_text"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _public_cover_operation(row):
        return {
            "cover_operation_id": row["id"],
            "generated_video_id": row["generated_video_id"],
            "provider": row["provider"],
            "status": row["status"],
            "phase": CreativeDomain._cover_phase(row, row["status"]),
            "error_code": row["error_code"],
            "estimated_image_calls": row["estimated_calls"],
            "network_submitted": row["status"]
            in {"submitted", "completed", "outcome_unknown"},
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _cover_phase(row, status=None):
        status = str(status or "").strip()
        if status == "submitted":
            if (
                row is not None
                and row["error_code"] in RECOVERABLE_COVER_ERROR_CODES
            ):
                return "recovery_required"
            return "polling" if row is not None and row["external_task_id"] else "submitting"
        if status in {
            "planned",
            "completed",
            "failed",
            "outcome_unknown",
            "cancelled",
            "reused",
        }:
            return status
        return "not_requested" if not status else "unknown"

    def _optional_brand_asset(self, value, *, image_only=False, field="brand_asset"):
        if value is None or value == "":
            return None
        if not isinstance(value, str):
            raise ContentEngineError("invalid_brand_asset", "A brand asset ID is invalid.")
        row = self._asset_row(value)
        if image_only and row["media_kind"] != "image":
            raise ContentEngineError(
                f"invalid_{field}",
                "The selected brand visual must be an imported image asset.",
            )
        return value

    @staticmethod
    def _validate_hex_color(value, field):
        normalized = str(value or "").strip().upper()
        if not re.fullmatch(r"#[0-9A-F]{6}", normalized):
            raise ContentEngineError(f"invalid_{field}", f"{field} must be a hex color.")
        return normalized

    def _validate_packaging_options(
        self,
        kind,
        *,
        packaging_mode="auto",
        packaging_preset_id=None,
        brand_profile_id=None,
        cover_mode="auto",
        visual_renderer=None,
    ):
        packaging_mode = str(packaging_mode or "auto").strip()
        packaging_preset_id = str(packaging_preset_id or "").strip() or None
        resolve_preset(kind, packaging_mode, packaging_preset_id, 0)
        cover_mode = str(cover_mode or "auto").strip()
        if cover_mode not in {"auto", "local_frame", "ai_generate", "none", "reuse"}:
            raise ContentEngineError("invalid_cover_mode", "The cover mode is invalid.")
        brand_profile_id = str(brand_profile_id or "").strip() or None
        if brand_profile_id:
            self._brand_row(brand_profile_id)
        visual_renderer = self._validate_visual_renderer_request(
            visual_renderer, packaging_mode=packaging_mode
        )
        return {
            "packaging_mode": packaging_mode,
            "packaging_preset_id": packaging_preset_id,
            "brand_profile_id": brand_profile_id,
            "cover_mode": cover_mode,
            **({"visual_renderer": visual_renderer} if visual_renderer else {}),
        }

    @staticmethod
    def _validate_visual_renderer_request(value, *, packaging_mode):
        if value is None:
            return None
        allowed = {
            "requestedEngine",
            "visualStyleId",
            "requestedStyleVersion",
            "allowFallback",
        }
        required = {"requestedEngine", "requestedStyleVersion", "allowFallback"}
        if (
            not isinstance(value, dict)
            or set(value) - allowed
            or not required.issubset(value)
            or packaging_mode == "none"
            or value.get("requestedEngine") != "remotion"
            or value.get("requestedStyleVersion") != VISUAL_STYLE_VERSION
            or isinstance(value.get("requestedStyleVersion"), bool)
            or not isinstance(value.get("allowFallback"), bool)
        ):
            raise ContentEngineError(
                "invalid_visual_renderer", "The visual renderer request is invalid."
            )
        style_id = value.get("visualStyleId")
        if style_id is not None and style_id not in VISUAL_COMPARISON_STYLE_IDS:
            raise ContentEngineError(
                "invalid_visual_renderer", "The visual style is invalid."
            )
        return {
            "requestedEngine": "remotion",
            **({"visualStyleId": style_id} if style_id else {}),
            "requestedStyleVersion": VISUAL_STYLE_VERSION,
            "allowFallback": value.get("allowFallback") is True,
        }

    @staticmethod
    def _visual_semantic_plan_hash(recipe):
        packaging = recipe.get("packaging") or {}
        return _canonical_hash(
            {
                "presetId": packaging.get("preset_id"),
                "captions": [
                    {
                        key: item.get(key)
                        for key in ("text", "start_ms", "end_ms")
                    }
                    for item in recipe.get("captions") or []
                    if isinstance(item, dict) and str(item.get("text") or "").strip()
                ],
                "events": [
                    {
                        key: item.get(key)
                        for key in (
                            "type", "text", "start_ms", "end_ms", "zone",
                            "size", "priority",
                        )
                    }
                    for item in packaging.get("events") or []
                    if isinstance(item, dict) and str(item.get("text") or "").strip()
                ],
                "visualLabels": [
                    {
                        key: item.get(key)
                        for key in (
                            "text", "start_ms", "end_ms", "label_source", "role",
                        )
                    }
                    for item in recipe.get("visual_labels") or []
                    if isinstance(item, dict) and str(item.get("text") or "").strip()
                ],
            }
        )

    def _ordinary_visual_renderer(self, recipe, request, index):
        style_id = request.get("visualStyleId") or VISUAL_COMPARISON_STYLE_IDS[
            index % len(VISUAL_COMPARISON_STYLE_IDS)
        ]
        packaging = recipe.get("packaging") or {}
        layout = {
            "events": packaging.get("events") or [],
            "visualLabels": recipe.get("visual_labels") or [],
            "focusRects": packaging.get("focus_rects") or [],
            "protectedRects": packaging.get("protected_rects") or [],
        }
        visual = {
            "requestedEngine": "remotion",
            "visualStyleId": style_id,
            "requestedStyleVersion": VISUAL_STYLE_VERSION,
            "deterministicSeed": _canonical_hash(
                {
                    "kind": recipe.get("kind"),
                    "title": packaging.get("title"),
                    "presetId": packaging.get("preset_id"),
                    "index": index,
                    "voice": recipe.get("voice_segment") or {},
                }
            ),
            "semanticPlanHash": self._visual_semantic_plan_hash(recipe),
            "allowFallback": request.get("allowFallback") is True,
            "layoutPolicyVersion": VISUAL_LAYOUT_POLICY_VERSION,
            "layoutHash": _canonical_hash(layout),
            "styleContractHash": _canonical_hash(
                {"styleId": style_id, "version": VISUAL_STYLE_VERSION}
            ),
        }
        visual["renderRequestHash"] = self._render_request_hash(visual)
        return visual

    def _refresh_ordinary_visual_renderer(self, recipe):
        packaging = recipe.get("packaging") or {}
        visual = packaging.get("visualRenderer")
        if not isinstance(visual, dict) or visual.get("comparisonGroupId"):
            return recipe
        visual["semanticPlanHash"] = self._visual_semantic_plan_hash(recipe)
        visual["layoutHash"] = _canonical_hash(
            {
                "events": packaging.get("events") or [],
                "visualLabels": recipe.get("visual_labels") or [],
                "focusRects": packaging.get("focus_rects") or [],
                "protectedRects": packaging.get("protected_rects") or [],
            }
        )
        visual["renderRequestHash"] = self._render_request_hash(visual)
        return recipe

    def _attach_packaging(self, recipe, *, kind, title, index, options):
        previous_packaging = recipe.get("packaging") or {}
        if not recipe.get("motion_director") and previous_packaging.get("director"):
            recipe["motion_director"] = {
                **previous_packaging["director"],
                "events": [
                    event
                    for event in previous_packaging.get("events") or []
                    if event.get("text") and event.get("zone")
                ],
            }
        brand_profile_id = options.get("brand_profile_id")
        brand = options.get("_brand_snapshot")
        if brand is None and brand_profile_id:
            brand = self._public_brand(self._brand_row(brand_profile_id))
        packaging_mode = options.get("packaging_mode") or "auto"
        cover_mode = options.get("cover_mode") or "auto"
        # Cover generation is independent from in-video packaging. A visual-only
        # product can deliberately disable captions/effects while still asking
        # for an AI or local cover. Build the normal cover contract, then strip
        # every timeline concern so no generic copy or motion leaks into video.
        cover_only = packaging_mode == "none" and cover_mode != "none"
        packaging = build_packaging(
            recipe,
            kind=kind,
            title=title,
            mode="auto" if cover_only else packaging_mode,
            preset_id=options.get("packaging_preset_id"),
            index=index,
            brand=brand,
            cover_mode=cover_mode,
        )
        if packaging is None:
            recipe.pop("packaging", None)
            return recipe
        if cover_only:
            packaging.update(
                {
                    "mode": "cover_only",
                    "subtitle": {"preset": "none"},
                    "effects": {},
                    "audio": {},
                    "events": [],
                }
            )
            packaging.pop("director", None)
            recipe["captions"] = []
        recipe["packaging"] = packaging
        visual_request = options.get("visual_renderer")
        if visual_request and not cover_only:
            packaging["visualRenderer"] = self._ordinary_visual_renderer(
                recipe, visual_request, index
            )
        existing_subtitle = recipe.get("subtitle_style") or {}
        explicit_subtitle_overrides = {
            field: existing_subtitle[field]
            for field in ("font_size", "margin_bottom")
            if field in existing_subtitle
        }
        if recipe.get("experiment_mode") == "supoclip_bailian_v1":
            explicit_subtitle_overrides.update(
                {
                    field: existing_subtitle[field]
                    for field in ("preset", "max_chars")
                    if field in existing_subtitle
                }
            )
        recipe["subtitle_style"] = {
            **packaging["subtitle"],
            **explicit_subtitle_overrides,
        }
        return recipe

    def _motion_plans_for_recipes(self, task_id, payload, entries):
        if payload.get("packaging_mode", "auto") == "none" or not entries:
            return {}
        expected = list(dict.fromkeys(str(key) for key, _recipe in entries))
        cached = payload.get("motion_plans")
        if isinstance(cached, dict) and all(
            isinstance(cached.get(key), dict) for key in expected
        ):
            return {key: cached[key] for key in expected}
        request_state = payload.get("motion_plan_request")
        if (
            isinstance(request_state, dict)
            and request_state.get("status") == "submitted"
        ):
            raise ContentEngineError(
                "cloud_motion_plan_outcome_unknown",
                "上次百炼动效编导请求结果未知；为避免重复扣费，系统不会自动再次提交。",
            )
        planner = getattr(self.analyzer, "plan_motion_events_batch", None)
        if not callable(planner):
            raise ContentEngineError(
                "cloud_motion_director_unavailable",
                "当前内容理解引擎不支持百炼动效编导。",
            )
        recipes_by_key = {str(key): recipe for key, recipe in entries}
        candidates = [
            self._motion_candidate(key, recipes_by_key[key]) for key in expected
        ]
        payload["motion_plan_request"] = {
            "status": "submitted",
            "expected": expected,
        }
        self._persist_task_payload(task_id, payload)
        plans = planner(candidates)
        if not isinstance(plans, dict) or set(plans) != set(expected):
            raise ContentEngineError(
                "cloud_motion_plan_invalid",
                "百炼没有为全部成片返回完整动效编导结果。",
            )
        payload["motion_plans"] = plans
        payload["motion_plan_request"] = {
            "status": "completed",
            "expected": expected,
        }
        self._persist_task_payload(task_id, payload)
        return plans

    def _persist_task_payload(self, task_id, payload):
        self.connection.execute(
            "UPDATE content_tasks SET payload_json = ?, updated_at = ? WHERE id = ?",
            (self._json(payload), self._now(), task_id),
        )

    @staticmethod
    def _motion_candidate(key, recipe):
        voice = recipe.get("voice_segment") or {}
        base = int(voice.get("start_ms") or 0)
        duration = max(1, int(voice.get("end_ms") or base + 1) - base)

        def relative(value):
            try:
                return max(0, min(duration, int(value) - base))
            except (TypeError, ValueError):
                return 0

        captions = []
        for item in recipe.get("captions") or []:
            text = str(item.get("text") or "").strip()
            if text:
                captions.append(
                    {
                        "text": text,
                        "start_ms": relative(item.get("start_ms")),
                        "end_ms": relative(item.get("end_ms")),
                    }
                )
        visual = []
        if recipe.get("kind") == "mix":
            elapsed = 0
            for item in recipe.get("visual_segments") or []:
                length = max(1, int(item.get("target_duration_ms") or 1))
                visual.append(
                    {
                        "start_ms": elapsed,
                        "end_ms": min(duration, elapsed + length),
                        "shot_type": str(item.get("role") or "broll"),
                        "tags": [str(item.get("role") or "process")],
                        "description": str(item.get("role") or "process"),
                    }
                )
                elapsed += length
        else:
            for item in recipe.get("visual_segments") or []:
                visual.append(
                    {
                        "start_ms": relative(item.get("start_ms")),
                        "end_ms": relative(item.get("end_ms")),
                        "shot_type": str(item.get("shot_type") or "unknown"),
                        "tags": item.get("tags") or [],
                        "description": str(item.get("frame_mode") or ""),
                    }
                )
        packaging = recipe.get("packaging") or {}
        return {
            "id": str(key),
            "duration_ms": duration,
            "transcript": "".join(item["text"] for item in captions),
            "captions": captions,
            "visual_context": visual,
            "style_id": str(packaging.get("preset_id") or "auto"),
        }

    def _apply_recipe_motion_plan(self, recipe, plan):
        if not plan:
            return self._refresh_ordinary_visual_renderer(recipe)
        recipe["motion_director"] = plan
        if recipe.get("packaging"):
            recipe["packaging"] = apply_motion_plan(recipe["packaging"], plan)
        return self._refresh_ordinary_visual_renderer(recipe)

    def _packaging_options_with_brand(self, options):
        snapshot = None
        brand_profile_id = options.get("brand_profile_id")
        if brand_profile_id:
            snapshot = self._public_brand(self._brand_row(brand_profile_id))
        return {**options, "_brand_snapshot": snapshot}

    def _restore_recipe_word_timestamps(self, recipe):
        voice_asset_id = str(
            (recipe.get("voice_segment") or {}).get("asset_id") or ""
        )
        if not voice_asset_id:
            return recipe
        for caption in recipe.get("captions") or []:
            if "words" in caption:
                continue
            try:
                start_ms = int(caption.get("start_ms"))
                end_ms = int(caption.get("end_ms"))
            except (TypeError, ValueError):
                caption["words"] = []
                continue
            row = self.connection.execute(
                """
                SELECT start_ms, end_ms, speaker, metadata_json
                FROM media_segments
                WHERE asset_id = ? AND start_ms = ? AND end_ms = ?
                ORDER BY updated_at DESC, rowid DESC LIMIT 1
                """,
                (voice_asset_id, start_ms, end_ms),
            ).fetchone()
            if row is None:
                caption["words"] = []
                continue
            caption["words"] = self._course_caption_words(
                {
                    "start_ms": row["start_ms"],
                    "end_ms": row["end_ms"],
                    "speaker": row["speaker"],
                    "metadata": json.loads(row["metadata_json"]),
                }
            )
        return recipe

    def _resolve_asset_path(self, asset_id):
        row = self.connection.execute(
            """
            SELECT absolute_path FROM asset_locations
            WHERE asset_id = ? AND is_available = 1
            ORDER BY last_seen_at DESC, rowid DESC LIMIT 1
            """,
            (asset_id,),
        ).fetchone()
        if row is None or not Path(row["absolute_path"]).is_file():
            raise ContentEngineError("asset_path_unavailable", "No asset file is available.")
        return row["absolute_path"]

    def _resolve_render_asset_path(self, asset_id):
        value = str(asset_id or "")
        prefix = "guided_auto_mix_supplemental_image:"
        if value.startswith(prefix):
            operation_id = value[len(prefix):]
            if not re.fullmatch(
                r"guided_auto_mix_supplemental_image_[a-f0-9]{32}", operation_id
            ):
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_invalid_output",
                    "AI 补图引用无效。",
                )
            return self.resolve_guided_auto_mix_supplemental_image_path(operation_id)[
                "absolute_path"
            ]
        return self._resolve_asset_path(value)

    def _validate_asset_ids(self, asset_ids, *, require_audio=False):
        if not isinstance(asset_ids, list) or not asset_ids:
            raise ContentEngineError("invalid_asset_ids", "Select at least one asset.")
        safe = []
        for asset_id in dict.fromkeys(asset_ids):
            if not isinstance(asset_id, str) or not asset_id:
                raise ContentEngineError("invalid_asset_id", "asset_id is required.")
            row = self._asset_row(asset_id)
            if row["probe_status"] != "ok":
                raise ContentEngineError("media_metadata_unavailable", "Analyze media metadata first.")
            if require_audio and not bool(row["has_audio"]):
                raise ContentEngineError("audio_required", "The selected asset has no audio track.")
            if row["rights_status"] in {"restricted", "expired"}:
                raise ContentEngineError("asset_rights_restricted", "Restricted assets cannot be generated.")
            self._resolve_asset_path(asset_id)
            safe.append(asset_id)
        return safe

    def _validate_derivative_path(self, value):
        path = Path(str(value or ""))
        if path.is_absolute():
            path = path.resolve(strict=True)
            if self.data_dir not in path.parents:
                raise ContentEngineError("invalid_derivative_path", "Derivative path is outside the cache.")
            relative = path.relative_to(self.data_dir)
        else:
            relative = path
            resolved = (self.data_dir / relative).resolve(strict=True)
            if self.data_dir not in resolved.parents:
                raise ContentEngineError("invalid_derivative_path", "Derivative path is outside the cache.")
        return str(relative)

    def _validate_generated_path(self, value):
        path = Path(value).resolve(strict=True)
        root = (self.data_dir / "generated").resolve()
        if root not in path.parents or not path.is_file():
            raise ContentEngineError("invalid_generated_path", "Renderer returned an unsafe path.")
        return path

    def _task_row(self, task_id):
        row = self.connection.execute(
            "SELECT * FROM content_tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("task_not_found", "The task was not found.")
        return row

    def _project_row(self, project_id):
        row = self.connection.execute(
            "SELECT * FROM creative_projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("creative_project_not_found", "The creative project was not found.")
        return row

    def _generated_row(self, video_id):
        row = self.connection.execute(
            "SELECT * FROM generated_videos WHERE id = ?", (video_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("generated_video_not_found", "The generated video was not found.")
        return row

    def _task_status(self, task_id):
        return self._task_row(task_id)["status"]

    def _should_stop(self, task_id):
        return self._task_status(task_id) in {"paused", "cancelled"}

    def _project_theme(self, project_id):
        return self._project_row(project_id)["theme"]

    def _completed_count(self, project_id):
        return self.connection.execute(
            "SELECT COUNT(*) FROM generated_videos WHERE project_id = ? AND status = 'completed'",
            (project_id,),
        ).fetchone()[0]

    @staticmethod
    def _duration_range(minimum, maximum):
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (minimum, maximum)):
            raise ContentEngineError("invalid_duration", "Durations must be integers.")
        if minimum < 30_000 or maximum > 90_000 or minimum > maximum:
            raise ContentEngineError("invalid_duration_range", "Course clips must be between 30 and 90 seconds.")
        return minimum, maximum

    @staticmethod
    def _validate_count(value, *, maximum):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ContentEngineError("invalid_limit", f"count must be between 1 and {maximum}.")
        return value

    @staticmethod
    def _bounded_integer(value, field, minimum, maximum):
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not minimum <= value <= maximum
        ):
            raise ContentEngineError(
                f"invalid_{field}", f"{field} must be between {minimum} and {maximum}."
            )
        return value

    @staticmethod
    def _validate_text(value, field, maximum):
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ContentEngineError(f"invalid_{field}", f"{field} is invalid.")
        return value.strip()

    @staticmethod
    def _recipe_signature(recipe):
        return hashlib.sha256(
            json.dumps(recipe, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
