from __future__ import annotations

import hashlib
import heapq
import itertools
import json
import math
from pathlib import Path
import re
from typing import Any, Iterable

from .database import Database
from .errors import ContentEngineError
from .public_data import redact_text, sanitize_public_value


CREATIVE_TASK_TYPES = frozenset(
    {
        "creative_analysis",
        "course_generation",
        "mix_generation",
        "creative_regeneration",
    }
)
CREATIVE_CHANNELS = frozenset({"wechat", "douyin", "kuaishou", "internal"})
ROLE_ORDER = ("hook", "process", "result")
MAX_MIX_OUTPUTS = 300
MAX_COMBINATION_INSPECTION = 250_000
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


def _stable_id(prefix: str, *parts: Any) -> str:
    digest = hashlib.sha256(
        "\x1f".join(str(part) for part in parts).encode("utf-8")
    ).hexdigest()
    return f"{prefix}_{digest[:32]}"


class CreativeDomain:
    def __init__(self, database: Database, *, new_id, now, analyzer, renderer):
        self.database = database
        self.connection = database._require_connection()
        self.data_dir = database.data_dir.resolve()
        self._new_id = new_id
        self._now = now
        self.analyzer = analyzer
        self.renderer = renderer

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
        }
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
        project_id = self._new_id("creative_project")
        settings = {
            "asset_ids": safe_ids,
            "voice_asset_id": voice_asset_id,
            "target_count": target_count,
            "voice_mode": "lecturer_original",
            "required_roles": list(ROLE_ORDER),
            "quality_threshold": 0.55,
            "internal_only": True,
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
            if task["task_type"] == "creative_analysis":
                result = self._run_analysis(task_id, payload)
            elif task["task_type"] == "course_generation":
                result = self._run_course(task_id, payload)
            elif task["task_type"] == "mix_generation":
                result = self._run_mix(task_id, payload)
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

    def _run_analysis(self, task_id, payload):
        asset_ids = self._validate_asset_ids(payload.get("asset_ids"))
        profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
        analyzed = 0
        for index, asset_id in enumerate(asset_ids):
            if self._should_stop(task_id):
                break
            if not self._analyze_asset(task_id, asset_id, profile):
                break
            analyzed += 1
            self._set_task(
                task_id,
                "analyzing",
                progress=(index + 1) / max(1, len(asset_ids)),
            )
        return {
            "analyzed_count": analyzed,
            "requested_count": len(asset_ids),
            "provider": self.analyzer.capability.get("provider", "local"),
            "cloud_configured": bool(
                self.analyzer.capability.get("cloud_configured", False)
            ),
        }

    def _analyze_asset(self, task_id, asset_id, profile=None):
        asset = self._asset_row(asset_id)
        source = self._resolve_asset_path(asset_id)
        outcome = self.analyzer.analyze(
            asset=asset,
            source_path=source,
            task_id=task_id,
            profile=profile or {},
            should_stop=lambda: self._should_stop(task_id),
        )
        if outcome.get("stopped") or self._should_stop(task_id):
            return False
        version = str(outcome.get("analysis_version") or "")
        if not version:
            raise ContentEngineError("analysis_failed", "Analysis version is missing.")
        existing_count = self.connection.execute(
            "SELECT COUNT(*) FROM media_segments WHERE asset_id = ? AND analysis_version = ?",
            (asset_id, version),
        ).fetchone()[0]
        if outcome.get("reuse_existing") and existing_count:
            self.connection.execute(
                "UPDATE media_segments SET updated_at = ? WHERE asset_id = ? AND analysis_version = ?",
                (self._now(), asset_id, version),
            )
            return True
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
        return not self._should_stop(task_id)

    def _run_course(self, task_id, payload):
        project_id = payload["project_id"]
        self._update_project(project_id, "analyzing")
        self._reconcile_project_rendering(project_id)
        asset_id = payload["asset_ids"][0]
        if not self._analyze_asset(task_id, asset_id):
            return {"project_id": project_id, "generated_count": self._completed_count(project_id)}
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
        )
        if not windows:
            raise ContentEngineError("qualified_segments_missing", "没有找到满足时长与完整性要求的课程片段。")
        self._update_project(project_id, "rendering")
        self._set_task(task_id, "rendering", progress=0.45)
        video_ids = []
        for index, window in enumerate(windows):
            if self._should_stop(task_id):
                break
            recipe = self._course_recipe(
                asset_id,
                window,
                subtitle_font_size=int(payload.get("subtitle_font_size") or 48),
                subtitle_margin_bottom=int(payload.get("subtitle_margin_bottom") or 170),
            )
            video_id = self._insert_generated(
                project_id,
                task_id,
                "course",
                recipe,
                window["score"],
                self._course_title(window, index),
                window["duration_ms"],
                recommended=index < min(2, len(windows)),
            )
            rendered = self._render_generated(video_id, task_id=task_id)
            if not rendered:
                break
            video_ids.append(video_id)
            self._set_task(
                task_id,
                "rendering",
                progress=0.45 + 0.5 * (index + 1) / len(windows),
            )
        completed = self._completed_count(project_id)
        return {
            "project_id": project_id,
            "generated_count": completed,
            "requested_count": int(payload["count"]),
            "recommended_count": min(2, completed),
            "generated_video_ids": video_ids,
        }

    def _run_mix(self, task_id, payload):
        project_id = payload["project_id"]
        asset_ids = payload["asset_ids"]
        self._update_project(project_id, "analyzing")
        self._reconcile_project_rendering(project_id)
        for index, asset_id in enumerate(asset_ids):
            if self._should_stop(task_id):
                break
            if not self._analyze_asset(task_id, asset_id):
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
        if missing_roles:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, missing_roles),
            )
            raise ContentEngineError(
                "qualified_segments_missing",
                f"合格素材不足，缺少：{', '.join(missing_roles)}。",
            )
        voice_segments = self._segments_for_assets(
            [payload["voice_asset_id"]], transcript_only=True
        )
        if not voice_segments:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, ["teacher_voice"]),
            )
            raise ContentEngineError(
                "transcript_required",
                "老师原声混剪需要带时间戳的语音转写，请先配置百炼后重新分析。",
            )
        target = int(payload["target_count"])
        backbone_count = max(3, math.ceil(target / 20))
        backbones = self._course_windows(voice_segments, 30_000, 90_000, backbone_count)
        if not backbones:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(0, True, ["teacher_voice"]),
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
                if asset_choice[0] == asset_choice[1] or asset_choice[1] == asset_choice[2]:
                    continue
                maximum += 1
                signature = "|".join(item["segment_id"] for item in choice)
                rank = hashlib.sha256(
                    f"{project_theme}:{signature}".encode("utf-8")
                ).digest()
                yield rank, signature, choice

        selected = heapq.nsmallest(target, qualified_choices(), key=lambda item: item[:2])
        count_is_exact = raw_count <= MAX_COMBINATION_INSPECTION
        if not selected:
            self._update_project(
                project_id,
                "failed",
                result=self._capacity_result(maximum, count_is_exact, []),
            )
            raise ContentEngineError(
                "qualified_segments_missing", "当前素材没有满足镜头连续性要求的三段式组合。"
            )
        self._update_project(project_id, "rendering")
        self._set_task(task_id, "rendering", progress=0.4)
        generated_ids = []
        for index, (_, signature, choice) in enumerate(selected):
            if self._should_stop(task_id):
                break
            backbone = backbones[index % len(backbones)]
            recipe = self._mix_recipe(backbone, choice)
            score = self._mix_score(choice, backbone)
            video_id = self._insert_generated(
                project_id,
                task_id,
                "mix",
                recipe,
                score,
                f"{self._project_theme(project_id)}·混剪{index + 1}",
                backbone["duration_ms"],
                recommended=False,
                signature=f"{backbone['signature']}|{signature}",
            )
            rendered = self._render_generated(video_id, task_id=task_id)
            if not rendered:
                break
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
            "missing_roles": [],
            "required_roles": list(ROLE_ORDER),
            "voice_backbone_count": len(backbones),
            "generated_video_ids": generated_ids,
        }

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
            "target_count": settings.get("target_count", settings.get("count")),
            "generated_count": self._completed_count(row["id"]),
            "maximum_qualified_count": result.get("maximum_qualified_count"),
            "count_is_exact": result.get("count_is_exact"),
            "missing_roles": result.get("missing_roles", []),
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
        return {"items": [self._public_generated(row) for row in rows]}

    def create_regeneration_task(self, generated_video_id):
        row = self._generated_row(generated_video_id)
        if row["status"] not in {"completed", "failed", "rejected"}:
            raise ContentEngineError(
                "generated_video_not_ready",
                "Only a finished candidate can be regenerated.",
            )
        recipe = json.loads(row["recipe_json"])
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

    def _course_windows(self, segments, minimum, maximum, count, *, theme=None):
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
        ranker = getattr(self.analyzer, "rank_course_windows", None)
        if theme and callable(ranker) and shortlist:
            try:
                rankings = ranker(shortlist, theme)
            except ContentEngineError as error:
                raise ContentEngineError(
                    "course_editor_unavailable",
                    "百炼内容主编暂时不可用，本次没有用本地规则冒充 AI 推荐；请稍后重试。",
                ) from error
            ranking_by_id = {
                str(item.get("id") or ""): item
                for item in rankings
                if isinstance(item, dict)
            }
            for item in shortlist:
                ranking = ranking_by_id.get(item["signature"])
                if not ranking:
                    continue
                score = item["score"]
                opening = float(ranking.get("opening_hook", score["opening_hook"]))
                standalone = float(
                    ranking.get("standalone_value", score["standalone_value"])
                )
                completeness = float(
                    ranking.get("content_completeness", score["content_completeness"])
                )
                language = float(
                    ranking.get("language_quality", score["transcript_quality"])
                )
                relevance = float(ranking.get("theme_relevance", 0.5))
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
            windows.sort(key=lambda item: (-item["score"]["total"], item["start_ms"]))
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
    ):
        return {
            "kind": "course",
            "layout": "auto_portrait",
            "subtitle_style": {
                "preset": "dynamic_clean",
                "font_size": subtitle_font_size,
                "margin_bottom": subtitle_margin_bottom,
                "max_chars": 12,
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
                {
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "text": item["transcript_text"],
                }
                for item in window["segments"]
            ],
        }

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

    def _mix_recipe(self, backbone, choice):
        duration = backbone["duration_ms"]
        allocations = (round(duration * 0.2), round(duration * 0.6))
        targets = (allocations[0], allocations[1], duration - sum(allocations))
        voice_asset_id = backbone["segments"][0]["asset_id"]
        return {
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
                {
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "text": item["transcript_text"],
                }
                for item in backbone["segments"]
            ],
        }

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
            if generation != 1:
                raise ContentEngineError(
                    "generated_video_conflict", "The regenerated candidate already exists."
                )
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
        return video_id

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
            rendered = self.renderer.render(
                video_id=video_id,
                recipe=json.loads(row["recipe_json"]),
                output_dir=output_dir,
                resolve_asset_path=self._resolve_asset_path,
            )
            video_path = self._validate_generated_path(rendered["video_path"])
            thumbnail_path = self._validate_generated_path(rendered["thumbnail_path"])
            if task_id and self._should_stop(task_id):
                self.connection.execute(
                    """
                    UPDATE generated_videos
                    SET status = 'completed', output_path = ?, thumbnail_path = ?,
                        error_code = NULL, error_message = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (str(video_path), str(thumbnail_path), self._now(), video_id),
                )
                return False
            self.connection.execute(
                """
                UPDATE generated_videos
                SET status = 'completed', output_path = ?, thumbnail_path = ?,
                    error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ?
                """,
                (str(video_path), str(thumbnail_path), self._now(), video_id),
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

    def _public_generated(self, row):
        score = json.loads(row["score_json"])
        recipe = json.loads(row["recipe_json"])
        voice = recipe.get("voice_segment") or {}
        return {
            "generated_video_id": row["id"],
            "project_id": row["project_id"],
            "task_id": row["task_id"],
            "kind": row["kind"],
            "status": row["status"],
            "generation": row["generation"],
            "selection_signature": row["selection_signature"],
            "title": row["title"],
            "duration_ms": row["duration_ms"],
            "recommended": bool(row["recommended"]),
            "score": sanitize_public_value(score),
            "source_start_ms": voice.get("start_ms"),
            "source_end_ms": voice.get("end_ms"),
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
    def _capacity_result(maximum, count_is_exact, missing_roles):
        return {
            "maximum_qualified_count": int(maximum),
            "count_is_exact": bool(count_is_exact),
            "missing_roles": list(missing_roles),
            "required_roles": list(ROLE_ORDER),
        }

    def _public_task(self, row):
        return {
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

    def _asset_row(self, asset_id):
        row = self.connection.execute(
            "SELECT * FROM assets WHERE id = ? AND archived_at IS NULL", (asset_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("asset_not_found", "The selected asset was not found.")
        return row

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
