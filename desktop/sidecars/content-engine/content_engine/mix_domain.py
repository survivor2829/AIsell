from __future__ import annotations

from dataclasses import dataclass
import hashlib
import heapq
import itertools
import json
import math
from pathlib import Path
import shutil
from typing import Any, Iterable

from .database import Database
from .errors import ContentEngineError
from .render_mix import DEFAULT_IMAGE_DURATION_MS, PLATFORM_PRESETS


@dataclass(frozen=True)
class SceneSlot:
    slot_id: str
    project_id: str
    position: int
    name: str
    required: bool
    asset_ids: tuple[str, ...]
    fixed_asset_id: str | None = None
    min_duration_ms: int | None = None
    max_duration_ms: int | None = None
    target_duration_ms: int | None = None


@dataclass(frozen=True)
class MixProject:
    project_id: str
    name: str
    slots: tuple[SceneSlot, ...]
    constraints: dict[str, Any]
    created_at: str
    updated_at: str


REVIEW_STATUSES = frozenset({"pending", "approved", "rejected"})
PUBLISH_STATUSES = frozenset(
    {"queued", "processing", "exported", "published", "failed", "cancelled"}
)
PUBLISH_TRANSITIONS = {
    "queued": {"processing", "cancelled"},
    "processing": {"exported", "failed", "cancelled"},
    "exported": {"published", "failed"},
    "failed": {"processing", "cancelled"},
    "published": set(),
    "cancelled": set(),
}
DEFAULT_SCORE_WEIGHTS = {
    "duration_fit": 0.6,
    "diversity": 0.25,
    "freshness": 0.15,
}
SCORE_WEIGHT_KEYS = frozenset(DEFAULT_SCORE_WEIGHTS)
CANDIDATE_BEAM_FACTOR = 8
MAX_COMBINATION_INSPECTION = 250_000


class MixDomain:
    def __init__(self, database: Database, *, new_id, now, renderer):
        self.database = database
        self.connection = database._require_connection()
        self._new_id = new_id
        self._now = now
        self.renderer = renderer

    def create_project(
        self,
        name: str,
        slots: list[dict[str, Any]],
        constraints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        safe_name = self._validate_name(name, "project")
        safe_constraints = self._validate_constraints(constraints)
        safe_slots = self._validate_slots(slots)
        project_id = self._new_id("mix_project")
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO mix_projects(id, name, constraints_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    safe_name,
                    self._json(safe_constraints),
                    now,
                    now,
                ),
            )
            self._insert_slots(connection, project_id, safe_slots)
        return self.get_project(project_id)

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        slots: list[dict[str, Any]] | None = None,
        constraints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        current = self._load_project(project_id)
        safe_name = current.name if name is None else self._validate_name(name, "project")
        safe_constraints = (
            current.constraints
            if constraints is None
            else self._validate_constraints(constraints)
        )
        safe_slots = None if slots is None else self._validate_slots(slots)
        stale_package_ids = []
        if safe_slots is not None or safe_constraints != current.constraints:
            stale_package_ids = [
                row["id"]
                for row in self.connection.execute(
                    """
                    SELECT e.id FROM export_packages e
                    JOIN mix_candidates c ON c.id = e.candidate_id
                    WHERE c.project_id = ?
                    """,
                    (current.project_id,),
                )
            ]
        now = self._now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE mix_projects
                SET name = ?, constraints_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (safe_name, self._json(safe_constraints), now, current.project_id),
            )
            if safe_slots is not None or safe_constraints != current.constraints:
                connection.execute(
                    "DELETE FROM mix_candidates WHERE project_id = ?",
                    (current.project_id,),
                )
            if safe_slots is not None:
                connection.execute(
                    "DELETE FROM scene_slots WHERE project_id = ?",
                    (current.project_id,),
                )
                self._insert_slots(connection, current.project_id, safe_slots)
        for package_id in stale_package_ids:
            self._cleanup_render_attempt(package_id)
        return self.get_project(current.project_id)

    def get_project(self, project_id: str) -> dict[str, Any]:
        return self._public_project(self._load_project(project_id))

    def list_projects(self, *, limit: int = 500) -> dict[str, Any]:
        safe_limit = self._validate_limit(limit)
        ids = self.connection.execute(
            "SELECT id FROM mix_projects ORDER BY updated_at DESC, id LIMIT ?",
            (safe_limit,),
        ).fetchall()
        return {"items": [self.get_project(row["id"]) for row in ids]}

    def calculate_combinations(self, project_id: str) -> dict[str, Any]:
        project = self._load_project(project_id)
        option_sets = self._option_sets(project)
        raw_count = 1
        for options in option_sets:
            raw_count *= len(options)
        count_is_exact = raw_count <= MAX_COMBINATION_INSPECTION
        valid_count = (
            sum(1 for _ in self._valid_combinations(project, option_sets))
            if count_is_exact
            else None
        )
        return {
            "project_id": project.project_id,
            "raw_cartesian_count": raw_count,
            "combination_count": valid_count,
            "count_is_exact": count_is_exact,
            "count_status": "exact" if count_is_exact else "too_large",
            "constraints_applied": {
                "required_slots": sum(slot.required for slot in project.slots),
                "fixed_slots": sum(
                    slot.fixed_asset_id is not None for slot in project.slots
                ),
                "allow_repeated_assets": project.constraints[
                    "allow_repeated_assets"
                ],
                "duration_constrained": any(
                    project.constraints[key] is not None
                    for key in ("min_duration_ms", "max_duration_ms")
                )
                or any(
                    slot.min_duration_ms is not None
                    or slot.max_duration_ms is not None
                    for slot in project.slots
                ),
            },
        }

    def generate_candidates(
        self,
        project_id: str,
        *,
        limit: int = 20,
        seed: str | int | None = None,
    ) -> dict[str, Any]:
        safe_limit = self._validate_limit(limit)
        safe_seed = self._validate_seed(seed)
        project = self._load_project(project_id)
        existing_for_seed = self._candidate_rows(
            "project_id = ? AND seed = ?", (project.project_id, safe_seed), safe_limit
        )
        if len(existing_for_seed) >= safe_limit:
            items = [self._public_candidate(row) for row in existing_for_seed]
            return self._candidate_batch(
                project.project_id,
                safe_seed,
                items,
                generation_stats={
                    "inspected_count": 0,
                    "retained_count": len(items),
                    "beam_capacity": safe_limit * CANDIDATE_BEAM_FACTOR,
                    "source": "persisted",
                },
            )

        beam_capacity = safe_limit * CANDIDATE_BEAM_FACTOR
        remaining, inspected_count = self._stream_candidate_beam(
            project,
            self._option_sets(project),
            safe_seed,
            beam_capacity,
        )
        base_usage = self._asset_usage(project.project_id)
        usage = dict(base_usage)
        selected: list[tuple[str | None, ...]] = []
        while remaining and len(selected) < safe_limit:
            remaining.sort(
                key=lambda choice: self._balance_key(
                    project, choice, usage, safe_seed
                )
            )
            choice = remaining.pop(0)
            selected.append(choice)
            for asset_id in choice:
                if asset_id is not None:
                    usage[asset_id] = usage.get(asset_id, 0) + 1

        now = self._now()
        scoring_usage = dict(base_usage)
        with self.database.transaction() as connection:
            for choice in selected:
                signature = self._selection_signature(project, choice)
                selections = self._selection_payload(project, choice)
                duration_ms = self._combination_duration(project, choice)
                score = self._score(
                    project, choice, duration_ms, usage=scoring_usage
                )
                connection.execute(
                    """
                    INSERT OR IGNORE INTO mix_candidates(
                        id, project_id, seed, selection_signature, selection_json,
                        duration_ms, score_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        self._new_id("mix_candidate"),
                        project.project_id,
                        safe_seed,
                        signature,
                        self._json(selections),
                        duration_ms,
                        self._json(score),
                        now,
                        now,
                    ),
                )
                for asset_id in choice:
                    if asset_id is not None:
                        scoring_usage[asset_id] = scoring_usage.get(asset_id, 0) + 1
        rows = self._candidate_rows(
            "project_id = ? AND seed = ?", (project.project_id, safe_seed), safe_limit
        )
        items = [self._public_candidate(row) for row in rows]
        return self._candidate_batch(
            project.project_id,
            safe_seed,
            items,
            generation_stats={
                "inspected_count": inspected_count,
                "retained_count": min(inspected_count, beam_capacity),
                "beam_capacity": beam_capacity,
                "source": "generated",
            },
        )

    def list_candidates(
        self,
        *,
        project_id: str | None = None,
        review_status: str | None = None,
        limit: int = 500,
    ) -> dict[str, Any]:
        safe_limit = self._validate_limit(limit)
        clauses: list[str] = []
        values: list[Any] = []
        if project_id is not None:
            self._load_project(project_id)
            clauses.append("project_id = ?")
            values.append(project_id)
        if review_status is not None:
            if review_status not in REVIEW_STATUSES:
                raise ContentEngineError(
                    "invalid_review_status", "The review status is not supported."
                )
            clauses.append("review_status = ?")
            values.append(review_status)
        where = " AND ".join(clauses) if clauses else "1 = 1"
        rows = self._candidate_rows(where, tuple(values), safe_limit)
        return {"items": [self._public_candidate(row) for row in rows]}

    def review_candidate(
        self, candidate_id: str, review_status: str, review_note: str | None = None
    ) -> dict[str, Any]:
        row = self._get_candidate_row(candidate_id)
        if review_status not in {"approved", "rejected"}:
            raise ContentEngineError(
                "invalid_review_status", "Candidates may be approved or rejected."
            )
        if review_note is not None and not isinstance(review_note, str):
            raise ContentEngineError("invalid_review_note", "review_note must be text.")
        now = self._now()
        stale_package_ids = []
        if review_status == "rejected":
            stale_package_ids = [
                item["id"]
                for item in self.connection.execute(
                    "SELECT id FROM export_packages WHERE candidate_id = ?",
                    (row["id"],),
                )
            ]
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE mix_candidates
                SET review_status = ?, review_note = ?, updated_at = ?
                WHERE id = ?
                """,
                (review_status, review_note, now, row["id"]),
            )
            if review_status == "approved":
                connection.execute(
                    """
                    INSERT OR IGNORE INTO publish_queue_items(
                        id, candidate_id, status, created_at, updated_at
                    ) VALUES (?, ?, 'queued', ?, ?)
                    """,
                    (self._new_id("publish_queue"), row["id"], now, now),
                )
            else:
                connection.execute(
                    "DELETE FROM publish_queue_items WHERE candidate_id = ?",
                    (row["id"],),
                )
        for package_id in stale_package_ids:
            self._cleanup_render_attempt(package_id)
        return self._public_candidate(self._get_candidate_row(row["id"]))

    def list_publish_queue(
        self, *, status: str | None = None, limit: int = 500
    ) -> dict[str, Any]:
        safe_limit = self._validate_limit(limit)
        if status is not None and status not in PUBLISH_STATUSES:
            raise ContentEngineError(
                "invalid_publish_status", "The publish status is not supported."
            )
        where = "WHERE q.status = ?" if status is not None else ""
        values: tuple[Any, ...] = (status, safe_limit) if status else (safe_limit,)
        rows = self.connection.execute(
            f"""
            SELECT q.*, c.project_id
            FROM publish_queue_items q
            JOIN mix_candidates c ON c.id = q.candidate_id
            {where}
            ORDER BY q.created_at, q.rowid
            LIMIT ?
            """,
            values,
        ).fetchall()
        return {"items": [self._public_queue_item(row) for row in rows]}

    def update_publish_queue_item(
        self,
        queue_item_id: str,
        status: str,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        row = self._get_queue_row(queue_item_id)
        if status not in PUBLISH_STATUSES:
            raise ContentEngineError(
                "invalid_publish_status", "The publish status is not supported."
            )
        if status != row["status"] and status not in PUBLISH_TRANSITIONS[row["status"]]:
            raise ContentEngineError(
                "invalid_publish_transition", "The publish status transition is not allowed."
            )
        if error_message is not None and not isinstance(error_message, str):
            raise ContentEngineError(
                "invalid_error_message", "error_message must be text."
            )
        self.connection.execute(
            """
            UPDATE publish_queue_items
            SET status = ?, error_message = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, error_message, self._now(), row["id"]),
        )
        return self._public_queue_item(self._get_queue_row(row["id"]))

    def render_candidate(
        self,
        candidate_id: str,
        *,
        platforms: list[str] | None = None,
        title: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        candidate = self._get_candidate_row(candidate_id)
        if candidate["review_status"] != "approved":
            raise ContentEngineError(
                "candidate_not_approved", "Only approved candidates can be rendered."
            )
        selected_platforms = self._validate_platforms(platforms)
        safe_title = self._validate_optional_text(title, "title", 200)
        safe_description = self._validate_optional_text(
            description, "description", 2_000
        )
        queue = self.connection.execute(
            "SELECT * FROM publish_queue_items WHERE candidate_id = ?",
            (candidate_id,),
        ).fetchone()
        if queue is None:
            raise ContentEngineError(
                "publish_queue_item_not_found", "The publish queue item was not found."
            )
        if queue["status"] not in {"queued", "failed"}:
            raise ContentEngineError(
                "invalid_publish_transition", "This queue item cannot be rendered."
            )
        package_id = self._new_id("export_package")
        now = self._now()
        self.connection.execute(
            """
            UPDATE publish_queue_items
            SET status = 'processing', error_message = NULL, updated_at = ?
            WHERE id = ?
            """,
            (now, queue["id"]),
        )
        try:
            segments = self._render_segments(candidate)
            rendered = self.renderer.render(
                package_id,
                segments,
                selected_platforms,
                {"title": safe_title, "description": safe_description},
            )
            directory = self._validated_package_directory(rendered["directory"])
            outputs = rendered.get("outputs")
            if not isinstance(outputs, dict) or set(outputs) != set(selected_platforms):
                raise ContentEngineError(
                    "render_failed", "Renderer returned an incomplete platform package."
                )
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO export_packages(
                        id, candidate_id, queue_item_id, output_directory,
                        platforms_json, outputs_json, cover_name, manifest_name,
                        title, description, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        package_id,
                        candidate_id,
                        queue["id"],
                        str(directory),
                        self._json(list(selected_platforms)),
                        self._json(outputs),
                        str(rendered["cover"]),
                        str(rendered["manifest"]),
                        safe_title,
                        safe_description,
                        now,
                    ),
                )
                connection.execute(
                    """
                    UPDATE publish_queue_items
                    SET status = 'exported', error_message = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (self._now(), queue["id"]),
                )
            return self._public_export_package(self._get_export_package(package_id))
        except Exception as error:
            self._cleanup_render_attempt(package_id)
            message = str(error)[:2_000]
            self.connection.execute(
                """
                UPDATE publish_queue_items
                SET status = 'failed', error_message = ?, updated_at = ?
                WHERE id = ?
                """,
                (message, self._now(), queue["id"]),
            )
            if isinstance(error, ContentEngineError):
                raise
            raise ContentEngineError("render_failed", message) from error

    def list_export_packages(
        self, *, candidate_id: str | None = None, limit: int = 500
    ) -> dict[str, Any]:
        safe_limit = self._validate_limit(limit)
        if candidate_id is not None:
            self._get_candidate_row(candidate_id)
        where = "WHERE candidate_id = ?" if candidate_id else ""
        values = (candidate_id, safe_limit) if candidate_id else (safe_limit,)
        rows = self.connection.execute(
            f"""
            SELECT * FROM export_packages {where}
            ORDER BY created_at DESC, rowid DESC LIMIT ?
            """,
            values,
        ).fetchall()
        return {"items": [self._public_export_package(row) for row in rows]}

    def resolve_export_package_path(self, package_id: str) -> dict[str, Any]:
        row = self._get_export_package(package_id)
        directory = self._validated_package_directory(row["output_directory"])
        return {"package_id": row["id"], "absolute_path": str(directory)}

    def _load_project(self, project_id: str) -> MixProject:
        if not isinstance(project_id, str) or not project_id:
            raise ContentEngineError("invalid_project_id", "project_id is required.")
        row = self.connection.execute(
            "SELECT * FROM mix_projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("mix_project_not_found", "The mix project was not found.")
        slot_rows = self.connection.execute(
            "SELECT * FROM scene_slots WHERE project_id = ? ORDER BY position",
            (project_id,),
        ).fetchall()
        slots = tuple(self._slot_from_row(slot) for slot in slot_rows)
        return MixProject(
            project_id=row["id"],
            name=row["name"],
            slots=slots,
            constraints=self._validate_constraints(
                json.loads(row["constraints_json"])
            ),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _slot_from_row(self, row) -> SceneSlot:
        asset_rows = self.connection.execute(
            "SELECT asset_id FROM scene_slot_assets WHERE slot_id = ? ORDER BY position",
            (row["id"],),
        ).fetchall()
        return SceneSlot(
            slot_id=row["id"],
            project_id=row["project_id"],
            position=row["position"],
            name=row["name"],
            required=bool(row["required"]),
            asset_ids=tuple(item["asset_id"] for item in asset_rows),
            fixed_asset_id=row["fixed_asset_id"],
            min_duration_ms=row["min_duration_ms"],
            max_duration_ms=row["max_duration_ms"],
            target_duration_ms=row["target_duration_ms"],
        )

    def _insert_slots(self, connection, project_id: str, slots) -> None:
        for position, slot in enumerate(slots):
            slot_id = self._new_id("scene_slot")
            connection.execute(
                """
                INSERT INTO scene_slots(
                    id, project_id, position, name, required, fixed_asset_id,
                    min_duration_ms, max_duration_ms, target_duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    slot_id,
                    project_id,
                    position,
                    slot["name"],
                    int(slot["required"]),
                    slot["fixed_asset_id"],
                    slot["min_duration_ms"],
                    slot["max_duration_ms"],
                    slot["target_duration_ms"],
                ),
            )
            for asset_position, asset_id in enumerate(slot["asset_ids"]):
                connection.execute(
                    """
                    INSERT INTO scene_slot_assets(slot_id, asset_id, position)
                    VALUES (?, ?, ?)
                    """,
                    (slot_id, asset_id, asset_position),
                )

    def _validate_slots(self, slots):
        if not isinstance(slots, list) or not slots:
            raise ContentEngineError("invalid_slots", "slots must be a non-empty list.")
        validated = []
        for slot in slots:
            if not isinstance(slot, dict):
                raise ContentEngineError("invalid_slot", "Each slot must be an object.")
            name = self._validate_name(slot.get("name"), "slot")
            required = slot.get("required", True)
            if not isinstance(required, bool):
                raise ContentEngineError("invalid_slot", "required must be a boolean.")
            fixed_asset_id = slot.get("fixed_asset_id")
            if fixed_asset_id is not None:
                fixed_asset_id = self._validate_asset_id(fixed_asset_id)
            raw_asset_ids = slot.get("asset_ids", [])
            if not isinstance(raw_asset_ids, list):
                raise ContentEngineError("invalid_slot", "asset_ids must be a list.")
            asset_ids = tuple(dict.fromkeys(
                self._validate_asset_id(asset_id) for asset_id in raw_asset_ids
            ))
            if fixed_asset_id is None and required and not asset_ids:
                raise ContentEngineError(
                    "empty_required_slot", "A required slot needs at least one asset."
                )
            min_duration = self._validate_duration(
                slot.get("min_duration_ms"), "min_duration_ms"
            )
            max_duration = self._validate_duration(
                slot.get("max_duration_ms"), "max_duration_ms"
            )
            target_duration = self._validate_duration(
                slot.get("target_duration_ms"), "target_duration_ms"
            )
            if target_duration == 0:
                target_duration = None
            if min_duration is not None and max_duration is not None and min_duration > max_duration:
                raise ContentEngineError(
                    "invalid_duration_range", "Minimum duration cannot exceed maximum duration."
                )
            validated.append(
                {
                    "name": name,
                    "required": required,
                    "fixed_asset_id": fixed_asset_id,
                    "asset_ids": asset_ids,
                    "min_duration_ms": min_duration,
                    "max_duration_ms": max_duration,
                    "target_duration_ms": target_duration,
                }
            )
        return validated

    def _validate_constraints(self, constraints):
        if constraints is None:
            constraints = {}
        if not isinstance(constraints, dict):
            raise ContentEngineError("invalid_constraints", "constraints must be an object.")
        allow_repeated = constraints.get("allow_repeated_assets", False)
        if not isinstance(allow_repeated, bool):
            raise ContentEngineError(
                "invalid_constraints", "allow_repeated_assets must be a boolean."
            )
        minimum = self._validate_duration(
            constraints.get("min_duration_ms"), "min_duration_ms"
        )
        maximum = self._validate_duration(
            constraints.get("max_duration_ms"), "max_duration_ms"
        )
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ContentEngineError(
                "invalid_duration_range", "Minimum duration cannot exceed maximum duration."
            )
        return {
            "allow_repeated_assets": allow_repeated,
            "min_duration_ms": minimum,
            "max_duration_ms": maximum,
            "score_weights": self._validate_score_weights(
                constraints.get("score_weights")
            ),
        }

    @staticmethod
    def _validate_score_weights(value: Any) -> dict[str, float]:
        if value is None:
            return dict(DEFAULT_SCORE_WEIGHTS)
        if not isinstance(value, dict) or set(value) != SCORE_WEIGHT_KEYS:
            raise ContentEngineError(
                "invalid_score_weights",
                "score_weights must define duration_fit, diversity, and freshness.",
            )
        weights: dict[str, float] = {}
        for key in DEFAULT_SCORE_WEIGHTS:
            weight = value[key]
            if (
                isinstance(weight, bool)
                or not isinstance(weight, (int, float))
                or not math.isfinite(weight)
                or weight < 0
            ):
                raise ContentEngineError(
                    "invalid_score_weights",
                    "Score weights must be finite non-negative numbers.",
                )
            weights[key] = float(weight)
        total = sum(weights.values())
        if total <= 0:
            raise ContentEngineError(
                "invalid_score_weights", "At least one score weight must be positive."
            )
        return {key: weight / total for key, weight in weights.items()}

    def _validate_asset_id(self, asset_id: Any) -> str:
        if not isinstance(asset_id, str) or not asset_id:
            raise ContentEngineError("invalid_asset_id", "asset_id is required.")
        exists = self.connection.execute(
            "SELECT 1 FROM assets WHERE id = ? AND archived_at IS NULL", (asset_id,)
        ).fetchone()
        if exists is None:
            raise ContentEngineError("asset_not_found", "The selected asset was not found.")
        return asset_id

    @staticmethod
    def _validate_name(value: Any, kind: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ContentEngineError("invalid_name", f"A non-empty {kind} name is required.")
        return value.strip()

    @staticmethod
    def _validate_duration(value: Any, field: str) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ContentEngineError("invalid_duration", f"{field} must be a non-negative integer.")
        return value

    @staticmethod
    def _validate_limit(limit: Any) -> int:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ContentEngineError("invalid_limit", "limit must be between 1 and 500.")
        return limit

    @staticmethod
    def _validate_seed(seed: Any) -> str:
        if seed is None:
            return "0"
        if isinstance(seed, bool) or not isinstance(seed, (str, int)):
            raise ContentEngineError("invalid_seed", "seed must be text or an integer.")
        return str(seed)

    def _option_sets(self, project: MixProject) -> list[tuple[str | None, ...]]:
        option_sets = []
        for slot in project.slots:
            if slot.fixed_asset_id is not None:
                options: tuple[str | None, ...] = (slot.fixed_asset_id,)
            else:
                options = slot.asset_ids
                if not slot.required:
                    options = (None, *options)
            option_sets.append(options)
        return option_sets

    def _valid_combinations(
        self, project: MixProject, option_sets: Iterable[tuple[str | None, ...]]
    ):
        durations = self._asset_durations(
            asset_id
            for options in option_sets
            for asset_id in options
            if asset_id is not None
        )
        for choice in itertools.product(*option_sets):
            selected = [asset_id for asset_id in choice if asset_id is not None]
            if (
                not project.constraints["allow_repeated_assets"]
                and len(selected) != len(set(selected))
            ):
                continue
            if any(
                asset_id is not None
                and not self._duration_in_range(durations.get(asset_id), slot)
                for slot, asset_id in zip(project.slots, choice)
            ):
                continue
            total = self._combination_duration(project, choice, durations)
            if not self._total_duration_valid(project, total):
                continue
            yield choice

    def _total_duration_valid(self, project, total):
        minimum = project.constraints["min_duration_ms"]
        maximum = project.constraints["max_duration_ms"]
        if minimum is None and maximum is None:
            return True
        return (minimum is None or total >= minimum) and (
            maximum is None or total <= maximum
        )

    @staticmethod
    def _duration_in_range(duration: int | None, slot: SceneSlot) -> bool:
        if slot.min_duration_ms is None and slot.max_duration_ms is None:
            return True
        if duration is None:
            return False
        return (slot.min_duration_ms is None or duration >= slot.min_duration_ms) and (
            slot.max_duration_ms is None or duration <= slot.max_duration_ms
        )

    def _asset_durations(self, asset_ids: Iterable[str]) -> dict[str, int | None]:
        unique_ids = tuple(dict.fromkeys(asset_ids))
        if not unique_ids:
            return {}
        placeholders = ",".join("?" for _ in unique_ids)
        rows = self.connection.execute(
            f"SELECT id, duration_ms FROM assets WHERE id IN ({placeholders})",
            unique_ids,
        ).fetchall()
        return {row["id"]: row["duration_ms"] for row in rows}

    def _combination_duration(self, project, choice, durations=None) -> int:
        if durations is None:
            durations = self._asset_durations(
                asset_id for asset_id in choice if asset_id is not None
            )
        total = 0
        for slot, asset_id in zip(project.slots, choice):
            if asset_id is None:
                continue
            duration = durations.get(asset_id)
            if duration is None:
                duration = DEFAULT_IMAGE_DURATION_MS
            if slot.target_duration_ms is not None:
                duration = min(duration, slot.target_duration_ms)
            total += duration
        return total

    def _balance_key(self, project, choice, usage, seed):
        selected = [asset_id for asset_id in choice if asset_id is not None]
        projected = [usage.get(asset_id, 0) + 1 for asset_id in selected]
        signature = self._selection_signature(project, choice)
        tie_breaker = hashlib.sha256(f"{seed}:{signature}".encode()).hexdigest()
        return (max(projected, default=0), sum(projected), tie_breaker)

    def _stream_candidate_beam(
        self, project, option_sets, seed, capacity
    ) -> tuple[list[tuple[str | None, ...]], int]:
        heap: list[tuple[int, str, tuple[str | None, ...]]] = []
        inspected_count = 0
        for choice in self._valid_combinations(project, option_sets):
            if inspected_count >= MAX_COMBINATION_INSPECTION:
                break
            inspected_count += 1
            signature = self._selection_signature(project, choice)
            seed_rank = int.from_bytes(
                hashlib.sha256(f"{seed}:{signature}".encode()).digest(), "big"
            )
            entry = (-seed_rank, signature, choice)
            if len(heap) < capacity:
                heapq.heappush(heap, entry)
            elif entry > heap[0]:
                heapq.heapreplace(heap, entry)
        retained = [entry[2] for entry in heap]
        retained.sort(
            key=lambda choice: hashlib.sha256(
                f"{seed}:{self._selection_signature(project, choice)}".encode()
            ).digest()
        )
        return retained, inspected_count

    def _score(self, project, choice, duration_ms, *, usage=None):
        selected = [asset_id for asset_id in choice if asset_id is not None]
        usage = usage if usage is not None else self._asset_usage(project.project_id)
        usage_penalty = sum(usage.get(asset_id, 0) for asset_id in selected)
        average_usage = usage_penalty / len(selected) if selected else 0.0
        freshness = 1 / (1 + average_usage)
        diversity = len(set(selected)) / len(selected) if selected else 0.0
        minimum = project.constraints["min_duration_ms"]
        maximum = project.constraints["max_duration_ms"]
        duration_fit = 1.0
        if minimum is not None and maximum is not None and maximum > minimum:
            midpoint = (minimum + maximum) / 2
            duration_fit = max(0.0, 1 - abs(duration_ms - midpoint) / (maximum - minimum))
        weights = project.constraints["score_weights"]
        components = {
            "duration_fit": round(100 * weights["duration_fit"] * duration_fit, 3),
            "diversity": round(100 * weights["diversity"] * diversity, 3),
            "freshness": round(100 * weights["freshness"] * freshness, 3),
        }
        total = round(sum(components.values()), 3)
        return {
            "total": total,
            "duration_fit": round(duration_fit, 3),
            "diversity": round(diversity, 3),
            "freshness": round(freshness, 3),
            "usage_penalty": usage_penalty,
            "weights": weights,
            "weighted_components": components,
            "explanations": [
                f"时长匹配度 {duration_fit:.3f}，权重 {weights['duration_fit']:.3f}",
                f"素材唯一率 {diversity:.3f}，权重 {weights['diversity']:.3f}",
                f"生成前累计使用次数 {usage_penalty}，新鲜度 {freshness:.3f}，权重 {weights['freshness']:.3f}",
            ],
        }

    def _selection_signature(self, project, choice):
        return "|".join(
            f"{slot.slot_id}:{asset_id or '-'}"
            for slot, asset_id in zip(project.slots, choice)
        )

    @staticmethod
    def _selection_payload(project, choice):
        return [
            {
                "slot_id": slot.slot_id,
                "slot_name": slot.name,
                "asset_id": asset_id,
                "omitted": asset_id is None,
            }
            for slot, asset_id in zip(project.slots, choice)
        ]

    def _asset_usage(self, project_id):
        rows = self.connection.execute(
            "SELECT selection_json FROM mix_candidates WHERE project_id = ?",
            (project_id,),
        ).fetchall()
        usage: dict[str, int] = {}
        for row in rows:
            for selection in json.loads(row["selection_json"]):
                asset_id = selection["asset_id"]
                if asset_id is not None:
                    usage[asset_id] = usage.get(asset_id, 0) + 1
        return usage

    def _candidate_batch(self, project_id, seed, items, *, generation_stats):
        usage: dict[str, int] = {}
        for item in items:
            for selection in item["selections"]:
                asset_id = selection["asset_id"]
                if asset_id is not None:
                    usage[asset_id] = usage.get(asset_id, 0) + 1
        return {
            "project_id": project_id,
            "seed": seed,
            "items": items,
            "asset_usage_counts": usage,
            "generation_stats": generation_stats,
        }

    def _candidate_rows(self, where, values, limit):
        return self.connection.execute(
            f"SELECT * FROM mix_candidates WHERE {where} ORDER BY rowid LIMIT ?",
            (*values, limit),
        ).fetchall()

    def _get_candidate_row(self, candidate_id):
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ContentEngineError("invalid_candidate_id", "candidate_id is required.")
        row = self.connection.execute(
            "SELECT * FROM mix_candidates WHERE id = ?", (candidate_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("mix_candidate_not_found", "The mix candidate was not found.")
        return row

    def _get_queue_row(self, queue_item_id):
        if not isinstance(queue_item_id, str) or not queue_item_id:
            raise ContentEngineError("invalid_queue_item_id", "queue_item_id is required.")
        row = self.connection.execute(
            """
            SELECT q.*, c.project_id
            FROM publish_queue_items q
            JOIN mix_candidates c ON c.id = q.candidate_id
            WHERE q.id = ?
            """,
            (queue_item_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError("publish_queue_item_not_found", "The queue item was not found.")
        return row

    @staticmethod
    def _public_project(project: MixProject):
        return {
            "project_id": project.project_id,
            "name": project.name,
            "constraints": project.constraints,
            "slots": [
                {
                    "slot_id": slot.slot_id,
                    "name": slot.name,
                    "position": slot.position,
                    "required": slot.required,
                    "asset_ids": list(slot.asset_ids),
                    "fixed_asset_id": slot.fixed_asset_id,
                    "min_duration_ms": slot.min_duration_ms,
                    "max_duration_ms": slot.max_duration_ms,
                    "target_duration_ms": slot.target_duration_ms,
                }
                for slot in project.slots
            ],
            "created_at": project.created_at,
            "updated_at": project.updated_at,
        }

    @staticmethod
    def _public_candidate(row):
        return {
            "candidate_id": row["id"],
            "project_id": row["project_id"],
            "seed": row["seed"],
            "selection_signature": row["selection_signature"],
            "selections": json.loads(row["selection_json"]),
            "duration_ms": row["duration_ms"],
            "score": json.loads(row["score_json"]),
            "review_status": row["review_status"],
            "review_note": row["review_note"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _public_queue_item(row):
        return {
            "queue_item_id": row["id"],
            "candidate_id": row["candidate_id"],
            "project_id": row["project_id"],
            "status": row["status"],
            "error_message": row["error_message"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _render_segments(self, candidate):
        selections = json.loads(candidate["selection_json"])
        segments = []
        for selection in selections:
            asset_id = selection.get("asset_id")
            if asset_id is None:
                continue
            row = self.connection.execute(
                """
                SELECT a.media_kind, a.duration_ms, a.has_audio, s.target_duration_ms,
                       l.absolute_path
                FROM assets a
                JOIN scene_slots s ON s.id = ?
                JOIN asset_locations l ON l.asset_id = a.id AND l.is_available = 1
                WHERE a.id = ? AND a.archived_at IS NULL
                ORDER BY l.last_seen_at DESC, l.rowid DESC LIMIT 1
                """,
                (selection["slot_id"], asset_id),
            ).fetchone()
            if row is None or not Path(row["absolute_path"]).is_file():
                raise ContentEngineError(
                    "path_not_found", "A selected source asset is unavailable."
                )
            source_duration = row["duration_ms"]
            target = row["target_duration_ms"]
            if row["media_kind"] == "image":
                target = target if target is not None else DEFAULT_IMAGE_DURATION_MS
            elif source_duration is None:
                raise ContentEngineError(
                    "media_metadata_unavailable",
                    "A selected video has no usable duration metadata.",
                )
            else:
                target = min(source_duration, target or source_duration)
            if not target:
                raise ContentEngineError(
                    "invalid_duration", "Rendered segments require a positive duration."
                )
            segments.append(
                {
                    "asset_id": asset_id,
                    "path": row["absolute_path"],
                    "media_kind": row["media_kind"],
                    "has_audio": bool(row["has_audio"]),
                    "target_duration_ms": target,
                }
            )
        if not segments:
            raise ContentEngineError("invalid_candidate", "Candidate has no renderable media.")
        return segments

    def _validated_package_directory(self, value):
        directory = Path(value).resolve(strict=True)
        export_root = (self.database.data_dir / "exports").resolve()
        if not directory.is_dir() or directory.parent != export_root:
            raise ContentEngineError(
                "invalid_export_path", "The renderer returned an unsafe package path."
            )
        return directory

    def _cleanup_render_attempt(self, package_id):
        cleanup = getattr(self.renderer, "cleanup_package", None)
        if callable(cleanup):
            cleanup(package_id)
        shutil.rmtree(
            self.database.data_dir / "render-temp" / package_id, ignore_errors=True
        )
        shutil.rmtree(
            self.database.data_dir / "exports" / package_id, ignore_errors=True
        )

    def _get_export_package(self, package_id):
        if not isinstance(package_id, str) or not package_id:
            raise ContentEngineError("invalid_package_id", "package_id is required.")
        row = self.connection.execute(
            "SELECT * FROM export_packages WHERE id = ?", (package_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "export_package_not_found", "The export package was not found."
            )
        return row

    @staticmethod
    def _validate_platforms(platforms):
        if platforms is None:
            return tuple(PLATFORM_PRESETS)
        if not isinstance(platforms, list) or not platforms:
            raise ContentEngineError("invalid_platforms", "platforms must be a list.")
        selected = tuple(dict.fromkeys(platforms))
        if any(platform not in PLATFORM_PRESETS for platform in selected):
            raise ContentEngineError("invalid_platforms", "A platform is unsupported.")
        return selected

    @staticmethod
    def _validate_optional_text(value, field, maximum):
        if value is None:
            return ""
        if not isinstance(value, str) or len(value) > maximum:
            raise ContentEngineError(f"invalid_{field}", f"{field} is invalid.")
        return value.strip()

    @staticmethod
    def _public_export_package(row):
        return {
            "package_id": row["id"],
            "candidate_id": row["candidate_id"],
            "queue_item_id": row["queue_item_id"],
            "platforms": json.loads(row["platforms_json"]),
            "outputs": json.loads(row["outputs_json"]),
            "cover_name": row["cover_name"],
            "manifest_name": row["manifest_name"],
            "title": row["title"],
            "description": row["description"],
            "created_at": row["created_at"],
        }

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
