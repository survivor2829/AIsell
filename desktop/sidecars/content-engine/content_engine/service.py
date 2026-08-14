from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import threading
from typing import Any, Iterable
import uuid

from .creative_analysis import FFmpegCreativeAnalyzer
from .creative_domain import CREATIVE_TASK_TYPES, CreativeDomain
from .creative_render import FFmpegCreativeRenderer
from .database import Database
from .errors import ContentEngineError
from .identity import stable_full_sha256, stable_sampled_sha256
from .instance_lock import InstanceLock
from .public_data import redact_text, sanitize_public_value
from .media_config import VIDEO_EXTENSIONS, classify_media
from .media_probe import FFprobeAdapter, ProbeOutcome
from .mix_domain import MixDomain
from .render_mix import FFmpegMixRenderer


FILE_ATTRIBUTE_REPARSE_POINT = 0x0400
RIGHTS_STATUSES = frozenset(
    {"unknown", "owned", "licensed", "restricted", "expired"}
)
PROBE_PENDING_LIMIT = 10
ACTIVE_TASK_STATES = ("analyzing", "rendering")
TASK_STATES = frozenset(
    {
        "queued",
        "analyzing",
        "ready_for_review",
        "rendering",
        "completed",
        "failed",
        "cancelled",
        "paused",
    }
)
TASK_TRANSITIONS = {
    "queued": {"analyzing", "paused", "cancelled"},
    "analyzing": {"ready_for_review", "completed", "paused", "failed", "cancelled"},
    "ready_for_review": {"rendering", "paused", "cancelled"},
    "rendering": {"completed", "paused", "failed", "cancelled"},
    "paused": {"queued", "analyzing", "ready_for_review", "rendering", "cancelled"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def is_unsafe_link(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        return bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)
    except (FileNotFoundError, OSError):
        return True


def has_unsafe_component(path: Path) -> bool:
    current = path
    while True:
        if is_unsafe_link(current):
            return True
        if current.parent == current:
            return False
        current = current.parent


def _public_asset_row(row) -> dict[str, Any]:
    return {
        "asset_id": row["id"],
        "display_name": row["display_name"],
        "media_kind": row["media_kind"],
        "extension": row["extension"],
        "size_bytes": row["size_bytes"],
        "rights_status": row["rights_status"],
        "probe_status": row["probe_status"],
        "duration_ms": row["duration_ms"],
        "width": row["width"],
        "height": row["height"],
        "fps": row["fps"],
        "has_audio": (
            None if row["has_audio"] is None else bool(row["has_audio"])
        ),
        "probe_error_code": row["probe_error_code"],
        "probed_at": row["probed_at"],
        "archived": row["archived_at"] is not None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "location_count": row["location_count"] if "location_count" in row.keys() else 0,
        "available_location_count": (
            row["available_location_count"]
            if "available_location_count" in row.keys()
            else 0
        ),
    }


class _CreativeJobWorker:
    def __init__(self, data_dir: Path, *, analyzer, renderer):
        self.data_dir = Path(data_dir)
        self.analyzer = analyzer
        self.renderer = renderer
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(
            target=self._run,
            name="xiaoxi-creative-jobs",
            daemon=True,
        )
        self._started = False

    def start(self) -> None:
        if not self._started:
            self._started = True
            self._thread.start()

    def enqueue(self, task_id: str) -> None:
        self._queue.put(task_id)

    def close(self) -> None:
        if not self._started:
            return
        self._queue.put(None)
        self._thread.join()

    def _run(self) -> None:
        database = Database(self.data_dir).open()
        domain = CreativeDomain(
            database,
            new_id=_new_id,
            now=utc_now,
            analyzer=self.analyzer,
            renderer=self.renderer,
        )
        try:
            while True:
                task_id = self._queue.get()
                try:
                    if task_id is None:
                        return
                    domain.run_task(task_id)
                finally:
                    self._queue.task_done()
        finally:
            database.close()


class ContentEngineService:
    def __init__(
        self,
        data_dir: Path,
        *,
        media_probe: FFprobeAdapter | None = None,
        mix_renderer=None,
        creative_analyzer=None,
        creative_renderer=None,
        start_background_jobs: bool = True,
    ):
        data_dir = Path(data_dir)
        self.media_probe = media_probe if media_probe is not None else FFprobeAdapter()
        self.instance_lock = InstanceLock(data_dir / "content-engine.lock")
        self.instance_lock.acquire()
        try:
            self.database = Database(data_dir).open()
            self.mix_renderer = mix_renderer or FFmpegMixRenderer(data_dir)
            self.mix_domain = MixDomain(
                self.database,
                new_id=_new_id,
                now=utc_now,
                renderer=self.mix_renderer,
            )
            self.creative_analyzer = creative_analyzer or FFmpegCreativeAnalyzer(data_dir)
            self.creative_renderer = creative_renderer or FFmpegCreativeRenderer(data_dir)
            self.creative_domain = CreativeDomain(
                self.database,
                new_id=_new_id,
                now=utc_now,
                analyzer=self.creative_analyzer,
                renderer=self.creative_renderer,
            )
            self._creative_jobs = (
                _CreativeJobWorker(
                    data_dir,
                    analyzer=self.creative_analyzer,
                    renderer=self.creative_renderer,
                )
                if start_background_jobs
                else None
            )
            self._recover_inflight_tasks()
            if self._creative_jobs is not None:
                self._creative_jobs.start()
                self._enqueue_recovered_creative_tasks()
        except Exception:
            self.instance_lock.release()
            raise

    @property
    def connection(self):
        return self.database._require_connection()

    def close(self) -> None:
        if self._creative_jobs is not None:
            self._pause_creative_tasks_for_shutdown()
            self._creative_jobs.close()
        self.database.close()
        self.instance_lock.release()

    def _pause_creative_tasks_for_shutdown(self) -> int:
        now = utc_now()
        placeholders = ",".join("?" for _ in CREATIVE_TASK_TYPES)
        with self.database.transaction() as connection:
            rows = connection.execute(
                f"""
                SELECT payload_json FROM content_tasks
                WHERE task_type IN ({placeholders})
                  AND status IN ('queued', 'analyzing', 'rendering')
                """,
                tuple(CREATIVE_TASK_TYPES),
            ).fetchall()
            cursor = connection.execute(
                f"""
                UPDATE content_tasks
                SET resume_from_status = status,
                    status = 'paused',
                    error_code = 'application_shutdown',
                    error_message = '任务因应用关闭而暂停，可在下次启动后继续。',
                    updated_at = ?
                WHERE task_type IN ({placeholders})
                  AND status IN ('queued', 'analyzing', 'rendering')
                """,
                (now, *CREATIVE_TASK_TYPES),
            )
            for row in rows:
                payload = json.loads(row["payload_json"])
                project_id = payload.get("project_id") if isinstance(payload, dict) else None
                if project_id:
                    connection.execute(
                        "UPDATE creative_projects SET status = 'paused', updated_at = ? WHERE id = ?",
                        (now, project_id),
                    )
        return cursor.rowcount

    def _enqueue_recovered_creative_tasks(self) -> int:
        if self._creative_jobs is None:
            return 0
        placeholders = ",".join("?" for _ in CREATIVE_TASK_TYPES)
        rows = self.connection.execute(
            f"""
            SELECT id FROM content_tasks
            WHERE task_type IN ({placeholders}) AND status = 'queued'
            ORDER BY created_at, rowid
            """,
            tuple(CREATIVE_TASK_TYPES),
        ).fetchall()
        for row in rows:
            self._creative_jobs.enqueue(row["id"])
        return len(rows)

    def _recover_inflight_tasks(self) -> int:
        now = utc_now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE content_tasks
                SET resume_from_status = status,
                    status = 'paused',
                    error_code = 'application_restarted',
                    error_message = '任务因应用重启而暂停，可检查后继续。',
                    updated_at = ?
                WHERE status IN ('analyzing', 'rendering')
                """,
                (now,),
            )
        return cursor.rowcount

    def health(self) -> dict[str, Any]:
        migration_count = self.connection.execute(
            "SELECT COUNT(*) FROM schema_migrations"
        ).fetchone()[0]
        return {
            "status": "ok",
            "schema_migrations": migration_count,
            "storage": "sqlite",
            "media_probe": "available" if self.media_probe.available else "unavailable",
            "mix_render": self.mix_renderer.capability,
            "creative_analysis": self.creative_analyzer.capability,
            "creative_render": self.creative_renderer.capability,
        }

    def _enqueue_creative_task(self, task: dict[str, Any]) -> dict[str, Any]:
        if self._creative_jobs is not None:
            self._creative_jobs.enqueue(task["task_id"])
        return task

    def analyze_assets(
        self, asset_ids: Iterable[str], profile: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_analysis_task(asset_ids, profile)
        )

    def list_media_segments(
        self,
        *,
        asset_id: str | None = None,
        role: str | None = None,
        limit: int = 2_000,
    ) -> dict[str, Any]:
        return self.creative_domain.list_segments(
            asset_id=asset_id, role=role, limit=limit
        )

    def generate_course_cuts(
        self,
        asset_id: str,
        *,
        min_duration_ms: int = 30_000,
        max_duration_ms: int = 90_000,
        count: int = 5,
        theme: str = "培训现场价值",
        subtitle_font_size: int = 48,
        subtitle_margin_bottom: int = 170,
        experiment_mode: str = "standard",
        subtitle_preset: str = "dynamic_clean",
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_course_task(
                asset_id,
                min_duration_ms=min_duration_ms,
                max_duration_ms=max_duration_ms,
                count=count,
                theme=theme,
                subtitle_font_size=subtitle_font_size,
                subtitle_margin_bottom=subtitle_margin_bottom,
                experiment_mode=experiment_mode,
                subtitle_preset=subtitle_preset,
            )
        )

    def generate_mix_batch(
        self,
        asset_ids: Iterable[str],
        *,
        theme: str = "培训现场价值",
        target_count: int = 30,
        voice_asset_id: str | None = None,
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_mix_task(
                asset_ids,
                theme=theme,
                target_count=target_count,
                voice_asset_id=voice_asset_id,
            )
        )

    def run_creative_task(self, task_id: str) -> dict[str, Any]:
        return self.creative_domain.run_task(task_id)

    def resume_creative_task(self, task_id: str) -> dict[str, Any]:
        task = self._get_public_task(task_id)
        if task["task_type"] not in CREATIVE_TASK_TYPES:
            raise ContentEngineError("invalid_task_type", "This is not a creative task.")
        if task["status"] != "paused":
            raise ContentEngineError("invalid_transition", "Only paused tasks can resume.")
        task = self.update_task(task_id, "queued")
        return self._enqueue_creative_task(task)

    def get_creative_project(self, project_id: str) -> dict[str, Any]:
        return self.creative_domain.get_project(project_id)

    def list_generated_videos(
        self,
        *,
        project_id: str | None = None,
        status: str | None = None,
        limit: int = 500,
    ) -> dict[str, Any]:
        return self.creative_domain.list_generated(
            project_id=project_id, status=status, limit=limit
        )

    def regenerate_video(self, candidate_id: str) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_regeneration_task(candidate_id)
        )

    def reject_generated_video(self, candidate_id: str) -> dict[str, Any]:
        return self.creative_domain.reject_generated(candidate_id)

    def queue_generated_videos(
        self, candidate_ids: Iterable[str], channel: str
    ) -> dict[str, Any]:
        return self.creative_domain.queue_generated(candidate_ids, channel)

    def resolve_generated_video_path(
        self, candidate_id: str, variant: str = "video"
    ) -> dict[str, Any]:
        return self.creative_domain.resolve_generated_path(candidate_id, variant)

    def create_mix_project(
        self,
        name: str,
        slots: list[dict[str, Any]],
        constraints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.mix_domain.create_project(name, slots, constraints)

    def update_mix_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        slots: list[dict[str, Any]] | None = None,
        constraints: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.mix_domain.update_project(
            project_id, name=name, slots=slots, constraints=constraints
        )

    def get_mix_project(self, project_id: str) -> dict[str, Any]:
        return self.mix_domain.get_project(project_id)

    def list_mix_projects(self, *, limit: int = 500) -> dict[str, Any]:
        return self.mix_domain.list_projects(limit=limit)

    def calculate_mix_combinations(self, project_id: str) -> dict[str, Any]:
        return self.mix_domain.calculate_combinations(project_id)

    def generate_mix_candidates(
        self,
        project_id: str,
        *,
        limit: int = 20,
        seed: str | int | None = None,
    ) -> dict[str, Any]:
        return self.mix_domain.generate_candidates(project_id, limit=limit, seed=seed)

    def list_mix_candidates(
        self,
        *,
        project_id: str | None = None,
        review_status: str | None = None,
        limit: int = 500,
    ) -> dict[str, Any]:
        return self.mix_domain.list_candidates(
            project_id=project_id, review_status=review_status, limit=limit
        )

    def review_mix_candidate(
        self, candidate_id: str, review_status: str, review_note: str | None = None
    ) -> dict[str, Any]:
        return self.mix_domain.review_candidate(
            candidate_id, review_status, review_note
        )

    def list_publish_queue(
        self, *, status: str | None = None, limit: int = 500
    ) -> dict[str, Any]:
        return self.mix_domain.list_publish_queue(status=status, limit=limit)

    def update_publish_queue_item(
        self,
        queue_item_id: str,
        status: str,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        return self.mix_domain.update_publish_queue_item(
            queue_item_id, status, error_message
        )

    def render_mix_candidate(
        self,
        candidate_id: str,
        *,
        platforms: list[str] | None = None,
        title: str | None = None,
        description: str | None = None,
    ) -> dict[str, Any]:
        return self.mix_domain.render_candidate(
            candidate_id,
            platforms=platforms,
            title=title,
            description=description,
        )

    def list_export_packages(
        self, *, candidate_id: str | None = None, limit: int = 500
    ) -> dict[str, Any]:
        return self.mix_domain.list_export_packages(
            candidate_id=candidate_id, limit=limit
        )

    def resolve_export_package_path(self, package_id: str) -> dict[str, Any]:
        return self.mix_domain.resolve_export_package_path(package_id)

    def _validate_file_path(self, raw_path: str, *, video_only: bool = False) -> Path:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ContentEngineError("invalid_path", "A non-empty absolute path is required.")
        path = Path(raw_path)
        if not path.is_absolute():
            raise ContentEngineError("invalid_path", "An absolute path is required.")
        if not path.exists():
            raise ContentEngineError("path_not_found", "The selected path does not exist.")
        if has_unsafe_component(path):
            raise ContentEngineError(
                "unsafe_path", "Symbolic links and junctions are not accepted."
            )
        if not path.is_file():
            raise ContentEngineError("invalid_path", "The selected path is not a file.")
        media_kind = classify_media(path)
        if media_kind is None or (video_only and path.suffix.lower() not in VIDEO_EXTENSIONS):
            raise ContentEngineError(
                "unsupported_media", "The selected file type is not supported."
            )
        return path.resolve(strict=True)

    def _validate_folder_path(self, raw_path: str) -> Path:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise ContentEngineError("invalid_path", "A non-empty absolute path is required.")
        path = Path(raw_path)
        if not path.is_absolute():
            raise ContentEngineError("invalid_path", "An absolute path is required.")
        if not path.exists():
            raise ContentEngineError("path_not_found", "The selected path does not exist.")
        if has_unsafe_component(path):
            raise ContentEngineError(
                "unsafe_path", "Symbolic links and junctions are not accepted."
            )
        if not path.is_dir():
            raise ContentEngineError("invalid_path", "The selected path is not a folder.")
        return path.resolve(strict=True)

    def import_files(self, paths: Iterable[str]) -> dict[str, Any]:
        if isinstance(paths, (str, bytes)) or not isinstance(paths, Iterable):
            raise ContentEngineError("invalid_request", "paths must be a list.")

        created_assets = 0
        created_locations = 0
        skipped: list[dict[str, Any]] = []
        imported: list[dict[str, Any]] = []

        for index, raw_path in enumerate(paths):
            try:
                path = self._validate_file_path(raw_path)
            except ContentEngineError as error:
                if error.code in {"unsupported_media", "unsafe_path"}:
                    skipped.append({"index": index, "reason": error.code})
                    continue
                raise
            item, asset_created, location_created = self._import_file(path)
            imported.append(item)
            created_assets += int(asset_created)
            created_locations += int(location_created)

        return {
            "items": imported,
            "created_assets": created_assets,
            "created_locations": created_locations,
            "skipped_count": len(skipped),
            "skipped": skipped,
        }

    def import_folder(
        self, path: str, *, recursive: bool = True, batch_size: int = 200
    ) -> dict[str, Any]:
        root = self._validate_folder_path(path)
        if not isinstance(recursive, bool):
            raise ContentEngineError("invalid_request", "recursive must be a boolean.")
        batch_size = _validate_batch_size(batch_size)
        task = self.create_task(
            "asset_import", {"root": str(root), "recursive": recursive}
        )
        return self.resume_import_folder(task["task_id"], batch_size=batch_size)

    def resume_import_folder(
        self, task_id: str, *, batch_size: int = 200
    ) -> dict[str, Any]:
        _validate_id(task_id, "task_id")
        batch_size = _validate_batch_size(batch_size)
        row = self.connection.execute(
            """
            SELECT task_type, status, payload_json, result_json
            FROM content_tasks WHERE id = ?
            """,
            (task_id,),
        ).fetchone()
        if row is None or row["task_type"] != "asset_import":
            raise ContentEngineError("import_task_not_found", "The import task was not found.")
        state = json.loads(row["result_json"] or "{}")
        if row["status"] == "completed":
            return self._public_import_result(task_id, state, [], False)
        if row["status"] not in {"queued", "analyzing", "paused"}:
            raise ContentEngineError(
                "import_task_not_resumable", "The import task cannot be resumed."
            )
        if row["status"] != "analyzing":
            self.update_task(task_id, "analyzing")

        payload = json.loads(row["payload_json"])
        root = self._validate_folder_path(payload["root"])
        checkpoint_token = str(state.get("checkpoint_token", ""))
        imported = []
        processed_in_batch = 0
        has_more = False
        state.setdefault("created_assets", 0)
        state.setdefault("created_locations", 0)
        state.setdefault("skipped_count", 0)
        state.setdefault("processed_entries", 0)

        for token, candidate, skip_reason in self._iter_folder_entries(
            root, recursive=bool(payload.get("recursive", True))
        ):
            if token <= checkpoint_token:
                continue
            if processed_in_batch >= batch_size:
                has_more = True
                break
            processed_in_batch += 1
            if skip_reason:
                state = self._advance_import_state(
                    task_id, state, token, skipped_count=1
                )
                continue

            def write_progress(connection, asset_created, location_created):
                return self._advance_import_state(
                    task_id,
                    state,
                    token,
                    created_assets=int(asset_created),
                    created_locations=int(location_created),
                    connection=connection,
                )

            try:
                item, _asset_created, _location_created, next_state = self._import_file(
                    candidate, progress_writer=write_progress
                )
            except (ContentEngineError, OSError):
                state = self._advance_import_state(
                    task_id, state, token, skipped_count=1
                )
                continue
            state = next_state
            imported.append(item)

        next_status = "analyzing" if has_more else "completed"
        self.update_task(
            task_id,
            next_status,
            progress=0 if has_more else 1,
            result=state,
        )
        return self._public_import_result(task_id, state, imported, has_more)

    def _advance_import_state(
        self,
        task_id: str,
        state: dict[str, Any],
        token: str,
        *,
        created_assets: int = 0,
        created_locations: int = 0,
        skipped_count: int = 0,
        connection=None,
    ) -> dict[str, Any]:
        next_state = dict(state)
        next_state["checkpoint_token"] = token
        next_state["processed_entries"] = int(state.get("processed_entries", 0)) + 1
        next_state["created_assets"] = int(state.get("created_assets", 0)) + created_assets
        next_state["created_locations"] = (
            int(state.get("created_locations", 0)) + created_locations
        )
        next_state["skipped_count"] = int(state.get("skipped_count", 0)) + skipped_count
        encoded = json.dumps(
            next_state, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        if connection is None:
            with self.database.transaction() as active_connection:
                active_connection.execute(
                    "UPDATE content_tasks SET result_json = ?, updated_at = ? WHERE id = ?",
                    (encoded, utc_now(), task_id),
                )
        else:
            connection.execute(
                "UPDATE content_tasks SET result_json = ?, updated_at = ? WHERE id = ?",
                (encoded, utc_now(), task_id),
            )
        return next_state

    def _iter_folder_entries(self, root: Path, *, recursive: bool):
        yield from self._walk_folder_entries(root, root, recursive=recursive)

    def _walk_folder_entries(self, root: Path, current: Path, *, recursive: bool):
        try:
            entries = sorted(
                os.scandir(current), key=lambda entry: (entry.name.casefold(), entry.name)
            )
        except OSError:
            return
        for entry in entries:
            candidate = Path(entry.path)
            relative_parts = candidate.relative_to(root).parts
            token = "\0".join(
                value
                for part in relative_parts
                for value in (part.casefold(), part)
            )
            if is_unsafe_link(candidate):
                yield token, None, "unsafe_path"
            elif entry.is_dir(follow_symlinks=False):
                if recursive:
                    yield from self._walk_folder_entries(
                        root, candidate, recursive=recursive
                    )
            elif entry.is_file(follow_symlinks=False):
                if classify_media(candidate) is None:
                    yield token, None, "unsupported_media"
                else:
                    yield token, candidate, None
            else:
                yield token, None, "unsupported_media"
    @staticmethod
    def _public_import_result(
        task_id: str, state: dict[str, Any], items: list[dict[str, Any]], has_more: bool
    ) -> dict[str, Any]:
        return {
            "task_id": task_id,
            "status": "analyzing" if has_more else "completed",
            "has_more": has_more,
            "items": items,
            "created_assets": int(state.get("created_assets", 0)),
            "created_locations": int(state.get("created_locations", 0)),
            "skipped_count": int(state.get("skipped_count", 0)),
            "processed_entries": int(state.get("processed_entries", 0)),
        }

    def _import_file(self, path: Path, *, progress_writer=None):
        file_stat = path.stat()
        normalized_path = os.path.normcase(str(path))
        existing_location = self.connection.execute(
            """
            SELECT l.id, l.asset_id, l.size_bytes, l.modified_ns
            FROM asset_locations l
            WHERE l.absolute_path = ?
            """,
            (normalized_path,),
        ).fetchone()
        if (
            existing_location
            and existing_location["size_bytes"] == file_stat.st_size
            and existing_location["modified_ns"] == file_stat.st_mtime_ns
        ):
            with self.database.transaction() as connection:
                connection.execute(
                    "UPDATE asset_locations SET is_available = 1, last_seen_at = ? WHERE id = ?",
                    (utc_now(), existing_location["id"]),
                )
                progress_state = (
                    progress_writer(connection, False, False)
                    if progress_writer
                    else None
                )
            item = self._get_public_asset(existing_location["asset_id"])
            if progress_writer:
                return item, False, False, progress_state
            return item, False, False

        fingerprint, stable_metadata = stable_sampled_sha256(path)
        file_stat = path.stat()
        if stable_metadata != (file_stat.st_size, file_stat.st_mtime_ns):
            raise ContentEngineError(
                "file_changed", "The media file changed while it was being indexed."
            )
        now = utc_now()
        media_kind = classify_media(path)
        asset_created = False
        location_created = False
        asset_row, full_fingerprint = self._find_matching_asset(
            path, normalized_path, fingerprint, file_stat.st_size, media_kind
        )

        progress_state = None
        with self.database.transaction() as connection:
            if asset_row is None:
                asset_id = _new_id("asset")
                connection.execute(
                    """
                    INSERT INTO assets(
                        id, fingerprint, full_fingerprint, media_kind, extension,
                        size_bytes, display_name, rights_status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
                    """,
                    (
                        asset_id,
                        fingerprint,
                        full_fingerprint,
                        media_kind,
                        path.suffix.lower(),
                        file_stat.st_size,
                        path.name,
                        now,
                        now,
                    ),
                )
                asset_created = True
            else:
                asset_id = asset_row["id"]
                connection.execute(
                    "UPDATE assets SET updated_at = ? WHERE id = ?", (now, asset_id)
                )

            location_row = connection.execute(
                "SELECT id FROM asset_locations WHERE absolute_path = ?",
                (normalized_path,),
            ).fetchone()
            if location_row is None:
                connection.execute(
                    """
                    INSERT INTO asset_locations(
                        id, asset_id, absolute_path, size_bytes, modified_ns,
                        is_available, created_at, last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        _new_id("location"),
                        asset_id,
                        normalized_path,
                        file_stat.st_size,
                        file_stat.st_mtime_ns,
                        now,
                        now,
                    ),
                )
                location_created = True
            else:
                connection.execute(
                    """
                    UPDATE asset_locations
                    SET asset_id = ?, size_bytes = ?, modified_ns = ?,
                        is_available = 1, last_seen_at = ?
                    WHERE id = ?
                    """,
                    (
                        asset_id,
                        file_stat.st_size,
                        file_stat.st_mtime_ns,
                        now,
                        location_row["id"],
                    ),
                )
            if progress_writer:
                progress_state = progress_writer(
                    connection, asset_created, location_created
                )
        item = self._get_public_asset(asset_id)
        if progress_writer:
            return item, asset_created, location_created, progress_state
        return item, asset_created, location_created

    def _find_matching_asset(
        self,
        path: Path,
        normalized_path: str,
        fingerprint: str,
        size_bytes: int,
        media_kind: str,
    ):
        candidates = self.connection.execute(
            """
            SELECT * FROM assets
            WHERE fingerprint = ? AND size_bytes = ? AND media_kind = ?
            ORDER BY created_at
            """,
            (fingerprint, size_bytes, media_kind),
        ).fetchall()
        if not candidates:
            return None, None

        incoming_full = stable_full_sha256(path)
        for candidate in candidates:
            candidate_full = candidate["full_fingerprint"]
            if candidate_full is None:
                locations = self.connection.execute(
                    """
                    SELECT id, absolute_path FROM asset_locations
                    WHERE asset_id = ? AND absolute_path <> ? AND is_available = 1
                    ORDER BY last_seen_at DESC
                    """,
                    (candidate["id"], normalized_path),
                ).fetchall()
                for location in locations:
                    candidate_path = Path(location["absolute_path"])
                    if not candidate_path.is_file() or has_unsafe_component(candidate_path):
                        continue
                    try:
                        candidate_full = stable_full_sha256(candidate_path)
                    except (ContentEngineError, OSError):
                        continue
                    with self.database.transaction() as connection:
                        connection.execute(
                            "UPDATE assets SET full_fingerprint = ? WHERE id = ?",
                            (candidate_full, candidate["id"]),
                        )
                    break
            if candidate_full == incoming_full:
                return candidate, incoming_full
        return None, incoming_full

    def _get_public_asset(self, asset_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            """
            SELECT a.*,
                   COUNT(l.id) AS location_count,
                   COALESCE(SUM(l.is_available), 0) AS available_location_count
            FROM assets a
            LEFT JOIN asset_locations l ON l.asset_id = a.id
            WHERE a.id = ?
            GROUP BY a.id
            """,
            (asset_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError("asset_not_found", "The asset was not found.")
        return _public_asset_row(row)

    def list_assets(
        self, *, include_archived: bool = False, limit: int = 500
    ) -> dict[str, Any]:
        limit = _validate_limit(limit)
        where = "" if include_archived else "WHERE a.archived_at IS NULL"

        def load_rows():
            return self.connection.execute(
                f"""
                SELECT a.*,
                       COUNT(l.id) AS location_count,
                       COALESCE(SUM(l.is_available), 0) AS available_location_count
                FROM assets a
                LEFT JOIN asset_locations l ON l.asset_id = a.id
                {where}
                GROUP BY a.id
                ORDER BY a.created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        rows = load_rows()
        if self._refresh_latest_asset_locations([row["id"] for row in rows]):
            rows = load_rows()
        return {"items": [_public_asset_row(row) for row in rows]}

    def _refresh_latest_asset_locations(self, asset_ids: list[str]) -> int:
        if not asset_ids:
            return 0
        placeholders = ",".join("?" for _ in asset_ids)
        locations = self.connection.execute(
            f"""
            WITH ranked_locations AS (
                SELECT id, asset_id, absolute_path, size_bytes, modified_ns,
                       ROW_NUMBER() OVER (
                           PARTITION BY asset_id ORDER BY last_seen_at DESC, id
                       ) AS location_rank
                FROM asset_locations
                WHERE is_available = 1 AND asset_id IN ({placeholders})
            )
            SELECT id, absolute_path, size_bytes, modified_ns
            FROM ranked_locations
            WHERE location_rank = 1
            """,
            tuple(asset_ids),
        ).fetchall()
        unavailable_ids = []
        for location in locations:
            path = Path(location["absolute_path"])
            try:
                if (
                    not path.is_absolute()
                    or not path.is_file()
                    or has_unsafe_component(path)
                ):
                    unavailable_ids.append(location["id"])
                    continue
                file_stat = path.stat()
                if (
                    file_stat.st_size != location["size_bytes"]
                    or file_stat.st_mtime_ns != location["modified_ns"]
                ):
                    unavailable_ids.append(location["id"])
            except (OSError, RuntimeError):
                unavailable_ids.append(location["id"])
        if unavailable_ids:
            with self.database.transaction() as connection:
                connection.executemany(
                    "UPDATE asset_locations SET is_available = 0 WHERE id = ?",
                    ((location_id,) for location_id in unavailable_ids),
                )
        return len(unavailable_ids)

    def update_asset_rights(
        self, asset_id: str, rights_status: str
    ) -> dict[str, Any]:
        _validate_id(asset_id, "asset_id")
        if not isinstance(rights_status, str):
            raise ContentEngineError(
                "invalid_rights_status", "rights_status must be an allowed value."
            )
        normalized_status = rights_status.strip().lower()
        if normalized_status not in RIGHTS_STATUSES:
            raise ContentEngineError(
                "invalid_rights_status", "rights_status must be an allowed value."
            )
        now = utc_now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                "UPDATE assets SET rights_status = ?, updated_at = ? WHERE id = ?",
                (normalized_status, now, asset_id),
            )
        if cursor.rowcount == 0:
            raise ContentEngineError("asset_not_found", "The asset was not found.")
        return self._get_public_asset(asset_id)

    def probe_asset(self, asset_id: str) -> dict[str, Any]:
        _validate_id(asset_id, "asset_id")
        self._require_media_probe()
        asset_row = self.connection.execute(
            "SELECT id, media_kind FROM assets WHERE id = ?", (asset_id,)
        ).fetchone()
        if asset_row is None:
            raise ContentEngineError("asset_not_found", "The asset was not found.")

        locations = self.connection.execute(
            """
            SELECT id, absolute_path, size_bytes, modified_ns
            FROM asset_locations
            WHERE asset_id = ? AND is_available = 1
            ORDER BY last_seen_at DESC
            """,
            (asset_id,),
        ).fetchall()
        selected_path = None
        unavailable_location_ids = []
        unavailable_reason = "asset_file_unavailable"
        for location in locations:
            path = Path(location["absolute_path"])
            try:
                if (
                    not path.is_absolute()
                    or not path.is_file()
                    or has_unsafe_component(path)
                ):
                    unavailable_location_ids.append(location["id"])
                    continue
                file_stat = path.stat()
                if (
                    file_stat.st_size != location["size_bytes"]
                    or file_stat.st_mtime_ns != location["modified_ns"]
                ):
                    unavailable_location_ids.append(location["id"])
                    unavailable_reason = "asset_file_changed"
                    continue
                selected_path = path.resolve(strict=True)
                break
            except (OSError, RuntimeError):
                unavailable_location_ids.append(location["id"])

        if unavailable_location_ids:
            with self.database.transaction() as connection:
                connection.executemany(
                    "UPDATE asset_locations SET is_available = 0 WHERE id = ?",
                    ((location_id,) for location_id in unavailable_location_ids),
                )

        if selected_path is None:
            outcome = ProbeOutcome.unavailable(unavailable_reason)
        else:
            outcome = self.media_probe.probe(selected_path, asset_row["media_kind"])
            if outcome.error_code == "ffprobe_unavailable":
                raise ContentEngineError(
                    "capability_unavailable",
                    "The media probe capability is unavailable.",
                )
        return self._store_probe_outcome(asset_id, outcome)

    def probe_pending(self, *, limit: int = PROBE_PENDING_LIMIT) -> dict[str, Any]:
        limit = _validate_probe_limit(limit)
        self._require_media_probe()
        rows = self.connection.execute(
            """
            SELECT id FROM assets
            WHERE probe_status = 'pending' AND archived_at IS NULL
            ORDER BY created_at
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        items = [self.probe_asset(row["id"]) for row in rows]
        remaining_count = self.connection.execute(
            """
            SELECT COUNT(*) FROM assets
            WHERE probe_status = 'pending' AND archived_at IS NULL
            """
        ).fetchone()[0]
        return {
            "items": items,
            "processed_count": len(items),
            "remaining_count": remaining_count,
        }

    def _require_media_probe(self) -> None:
        if not self.media_probe.available:
            raise ContentEngineError(
                "capability_unavailable",
                "The media probe capability is unavailable.",
            )

    def _store_probe_outcome(
        self, asset_id: str, outcome: ProbeOutcome
    ) -> dict[str, Any]:
        if outcome.status not in {"ok", "unavailable", "failed"}:
            outcome = ProbeOutcome.failed("probe_failed")
        error_codes = {
            "asset_file_unavailable",
            "asset_file_changed",
            "ffprobe_unavailable",
            "ffprobe_timeout",
            "ffprobe_error",
            "ffprobe_execution_error",
            "ffprobe_invalid_output",
            "unsupported_media_kind",
            "video_stream_missing",
            "probe_failed",
        }
        error_code = outcome.error_code if outcome.error_code in error_codes else None
        is_ok = outcome.status == "ok"
        now = utc_now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE assets
                SET probe_status = ?, duration_ms = ?, width = ?, height = ?,
                    fps = ?, has_audio = ?, probe_error_code = ?,
                    probed_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    outcome.status,
                    outcome.duration_ms if is_ok else None,
                    outcome.width if is_ok else None,
                    outcome.height if is_ok else None,
                    outcome.fps if is_ok else None,
                    (
                        int(outcome.has_audio)
                        if is_ok and outcome.has_audio is not None
                        else None
                    ),
                    error_code,
                    now,
                    now,
                    asset_id,
                ),
            )
        if cursor.rowcount == 0:
            raise ContentEngineError("asset_not_found", "The asset was not found.")
        return self._get_public_asset(asset_id)

    def archive_asset(self, asset_id: str) -> dict[str, Any]:
        _validate_id(asset_id, "asset_id")
        now = utc_now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE assets
                SET archived_at = COALESCE(archived_at, ?), updated_at = ?
                WHERE id = ?
                """,
                (now, now, asset_id),
            )
        if cursor.rowcount == 0:
            raise ContentEngineError("asset_not_found", "The asset was not found.")
        item = self._get_public_asset(asset_id)
        item["archived"] = True
        return item

    def reveal_asset(self, asset_id: str) -> dict[str, Any]:
        _validate_id(asset_id, "asset_id")
        row = self.connection.execute(
            """
            SELECT a.id AS asset_id, a.display_name, l.id AS location_id,
                   l.absolute_path, l.is_available
            FROM assets a
            LEFT JOIN asset_locations l ON l.asset_id = a.id
            WHERE a.id = ?
            ORDER BY l.is_available DESC, l.last_seen_at DESC
            LIMIT 1
            """,
            (asset_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError("asset_not_found", "The asset was not found.")
        available = bool(
            row["location_id"]
            and row["is_available"]
            and Path(row["absolute_path"]).is_file()
        )
        parent_label = (
            Path(row["absolute_path"]).parent.name if row["absolute_path"] else None
        )
        return {
            "asset_id": row["asset_id"],
            "display_name": row["display_name"],
            "location_id": row["location_id"],
            "available": available,
            "parent_label": parent_label,
        }


    def resolve_asset_path(self, asset_id: str) -> dict[str, Any]:
        """Main-process-only path resolution; never expose this DTO to renderer."""
        _validate_id(asset_id, "asset_id")
        row = self.connection.execute(
            """
            SELECT l.absolute_path
            FROM asset_locations l
            WHERE l.asset_id = ? AND l.is_available = 1
            ORDER BY l.last_seen_at DESC
            LIMIT 1
            """,
            (asset_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError("asset_path_unavailable", "No asset file is available.")
        path = Path(row["absolute_path"])
        if not path.is_file() or has_unsafe_component(path):
            raise ContentEngineError("asset_path_unavailable", "No asset file is available.")
        return {"asset_id": asset_id, "absolute_path": str(path.resolve(strict=True))}

    def create_task(
        self, task_type: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if not isinstance(task_type, str) or not task_type.strip():
            raise ContentEngineError("invalid_task_type", "task_type is required.")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ContentEngineError("invalid_payload", "payload must be an object.")
        task_id = _new_id("task")
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO content_tasks(
                    id, task_type, status, payload_json, created_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?, ?)
                """,
                (
                    task_id,
                    task_type.strip(),
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    now,
                    now,
                ),
            )
        return self._get_public_task(task_id)

    def update_task(
        self,
        task_id: str,
        status: str,
        *,
        progress: float | None = None,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        _validate_id(task_id, "task_id")
        if status not in TASK_STATES:
            raise ContentEngineError("invalid_status", "The task status is invalid.")
        row = self.connection.execute(
            """
            SELECT status, resume_from_status, error_code, error_message,
                   task_type, payload_json
            FROM content_tasks WHERE id = ?
            """,
            (task_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError("task_not_found", "The task was not found.")
        if status != row["status"] and status not in TASK_TRANSITIONS[row["status"]]:
            raise ContentEngineError(
                "invalid_transition",
                f"The transition from {row['status']} to {status} is not allowed.",
            )
        if progress is not None and (
            isinstance(progress, bool)
            or not isinstance(progress, (int, float))
            or not 0 <= progress <= 1
        ):
            raise ContentEngineError(
                "invalid_progress", "progress must be between 0 and 1."
            )
        if result is not None and not isinstance(result, dict):
            raise ContentEngineError("invalid_result", "result must be an object.")

        if error_code is not None and not isinstance(error_code, str):
            raise ContentEngineError("invalid_error", "error_code must be text.")
        if error_message is not None and not isinstance(error_message, str):
            raise ContentEngineError("invalid_error", "error_message must be text.")
        if status == "paused":
            resume_from_status = (
                row["resume_from_status"]
                if row["status"] == "paused"
                else row["status"]
            )
            next_error_code = redact_text(error_code) if error_code else row["error_code"]
            next_error_message = (
                redact_text(error_message)
                if error_message is not None
                else row["error_message"]
            )
        elif status == "failed":
            resume_from_status = None
            next_error_code = redact_text(error_code) if error_code else None
            next_error_message = (
                redact_text(error_message) if error_message is not None else None
            )
        else:
            resume_from_status = None
            next_error_code = None
            next_error_message = None

        result_json = (
            json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            if result is not None
            else None
        )
        assignments = [
            "status = ?",
            "resume_from_status = ?",
            "error_code = ?",
            "error_message = ?",
            "updated_at = ?",
        ]
        parameters: list[Any] = [
            status,
            resume_from_status,
            next_error_code,
            next_error_message,
            utc_now(),
        ]
        if progress is not None:
            assignments.append("progress = ?")
            parameters.append(progress)
        if result_json is not None:
            assignments.append("result_json = ?")
            parameters.append(result_json)
        parameters.append(task_id)
        with self.database.transaction() as connection:
            connection.execute(
                f"UPDATE content_tasks SET {', '.join(assignments)} WHERE id = ?",
                parameters,
            )
            if row["task_type"] in CREATIVE_TASK_TYPES and status in {
                "queued",
                "paused",
                "cancelled",
            }:
                payload = json.loads(row["payload_json"])
                project_id = payload.get("project_id") if isinstance(payload, dict) else None
                if project_id:
                    connection.execute(
                        "UPDATE creative_projects SET status = ?, updated_at = ? WHERE id = ?",
                        (status, utc_now(), project_id),
                    )
        return self._get_public_task(task_id)

    def _get_public_task(self, task_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM content_tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("task_not_found", "The task was not found.")
        return _public_task_row(row)

    def list_tasks(
        self, *, status: str | None = None, limit: int = 500
    ) -> dict[str, Any]:
        limit = _validate_limit(limit)
        parameters: list[Any] = []
        where = ""
        if status is not None:
            if status not in TASK_STATES:
                raise ContentEngineError("invalid_status", "The task status is invalid.")
            where = "WHERE status = ?"
            parameters.append(status)
        parameters.append(limit)
        rows = self.connection.execute(
            f"""
            SELECT * FROM content_tasks
            {where}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            parameters,
        ).fetchall()
        return {"items": [_public_task_row(row) for row in rows]}

    def register_finished(
        self,
        output_path: str,
        *,
        title: str | None = None,
        task_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        path = self._validate_file_path(output_path, video_only=True)
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            raise ContentEngineError("invalid_metadata", "metadata must be an object.")
        if task_id is not None:
            _validate_id(task_id, "task_id")
            task = self.connection.execute(
                "SELECT status FROM content_tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if task is None:
                raise ContentEngineError("task_not_found", "The task was not found.")
            if task["status"] != "completed":
                raise ContentEngineError(
                    "task_not_completed",
                    "Only a completed task can register a finished video.",
                )

        normalized_path = os.path.normcase(str(path))
        existing = self.connection.execute(
            "SELECT id FROM finished_videos WHERE output_path = ?",
            (normalized_path,),
        ).fetchone()
        finished_id = existing["id"] if existing else _new_id("finished")
        file_stat = path.stat()
        safe_title = redact_text(title.strip()) if isinstance(title, str) and title.strip() else path.stem
        metadata_json = json.dumps(
            sanitize_public_value(metadata), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        with self.database.transaction() as connection:
            if existing:
                connection.execute(
                    """
                    UPDATE finished_videos
                    SET task_id = ?, display_name = ?, title = ?, size_bytes = ?,
                        metadata_json = ?
                    WHERE id = ?
                    """,
                    (
                        task_id,
                        path.name,
                        safe_title,
                        file_stat.st_size,
                        metadata_json,
                        finished_id,
                    ),
                )
            else:
                connection.execute(
                    """
                    INSERT INTO finished_videos(
                        id, task_id, output_path, display_name, title, size_bytes,
                        metadata_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        finished_id,
                        task_id,
                        normalized_path,
                        path.name,
                        safe_title,
                        file_stat.st_size,
                        metadata_json,
                        utc_now(),
                    ),
                )
        return self._get_public_finished(finished_id)

    def _get_public_finished(self, finished_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM finished_videos WHERE id = ?", (finished_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "finished_video_not_found", "The finished video was not found."
            )
        return _public_finished_row(row)

    def list_finished(self, *, limit: int = 500) -> dict[str, Any]:
        rows = self.connection.execute(
            """
            SELECT * FROM finished_videos
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (_validate_limit(limit),),
        ).fetchall()
        return {"items": [_public_finished_row(row) for row in rows]}


    def resolve_finished_path(self, finished_video_id: str) -> dict[str, Any]:
        """Main-process-only path resolution; never expose this DTO to renderer."""
        _validate_id(finished_video_id, "finished_video_id")
        row = self.connection.execute(
            "SELECT output_path FROM finished_videos WHERE id = ?",
            (finished_video_id,),
        ).fetchone()
        if row is None:
            raise ContentEngineError(
                "finished_video_not_found", "The finished video was not found."
            )
        path = Path(row["output_path"])
        if not path.is_file() or has_unsafe_component(path):
            raise ContentEngineError(
                "finished_path_unavailable", "The finished video file is unavailable."
            )
        return {
            "finished_video_id": finished_video_id,
            "absolute_path": str(path.resolve(strict=True)),
        }

    def get_setting(self, key: str, default: Any = None) -> dict[str, Any]:
        _validate_setting_key(key)
        row = self.connection.execute(
            "SELECT value_json FROM settings WHERE key = ?", (key,)
        ).fetchone()
        value = json.loads(row["value_json"]) if row else default
        return {"key": key, "value": sanitize_public_value(value)}

    def set_setting(self, key: str, value: Any) -> dict[str, Any]:
        _validate_setting_key(key)
        try:
            encoded = json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
        except (TypeError, ValueError) as error:
            raise ContentEngineError(
                "invalid_setting", "The setting value must be valid JSON."
            ) from error
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (key, encoded, now),
            )
        return {"key": key, "value": sanitize_public_value(value)}


def _public_task_row(row) -> dict[str, Any]:
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


def _public_finished_row(row) -> dict[str, Any]:
    return {
        "finished_video_id": row["id"],
        "task_id": row["task_id"],
        "display_name": row["display_name"],
        "title": row["title"],
        "size_bytes": row["size_bytes"],
        "metadata": sanitize_public_value(json.loads(row["metadata_json"])),
        "created_at": row["created_at"],
    }


def _validate_id(value: str, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ContentEngineError("invalid_id", f"{field} is required.")


def _validate_limit(limit: int) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 2_000:
        raise ContentEngineError("invalid_limit", "limit must be between 1 and 2000.")
    return limit


def _validate_probe_limit(limit: int) -> int:
    if (
        isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= PROBE_PENDING_LIMIT
    ):
        raise ContentEngineError(
            "invalid_limit",
            f"probe limit must be between 1 and {PROBE_PENDING_LIMIT}.",
        )
    return limit


def _validate_setting_key(key: str) -> None:
    if not isinstance(key, str) or not key.strip() or len(key) > 128:
        raise ContentEngineError("invalid_setting_key", "A valid setting key is required.")


def _validate_batch_size(batch_size: int) -> int:
    if (
        isinstance(batch_size, bool)
        or not isinstance(batch_size, int)
        or not 1 <= batch_size <= 1_000
    ):
        raise ContentEngineError(
            "invalid_batch_size", "batch_size must be between 1 and 1000."
        )
    return batch_size
