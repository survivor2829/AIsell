from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import threading
from typing import Any, Iterable
import uuid

from .apimart_cover import APIMartCoverClient
from .creative_analysis import FFmpegCreativeAnalyzer
from .creative_domain import CREATIVE_TASK_TYPES, CreativeDomain
from .creative_render import HybridCreativeRenderer
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
    def __init__(self, data_dir: Path, *, analyzer, renderer, cover_client):
        self.data_dir = Path(data_dir)
        self.analyzer = analyzer
        self.renderer = renderer
        self.cover_client = cover_client
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(
            target=self._run,
            name="xiaoxi-creative-jobs",
            daemon=True,
        )
        self._started = False
        self._closing = threading.Event()
        self._active_lock = threading.Lock()
        self._active_task_id: str | None = None

    def start(self) -> None:
        if not self._started:
            self._started = True
            self._thread.start()

    def enqueue(self, task_id: str) -> None:
        if self._closing.is_set():
            return
        self._queue.put(task_id)

    def close(self) -> None:
        if not self._started:
            return
        self._closing.set()
        self._queue.put(None)
        self._thread.join()

    def cancel_task(self, task_id: str) -> None:
        with self._active_lock:
            is_active = self._active_task_id == task_id
        if not is_active:
            return
        cancel = getattr(self.renderer, "cancel", None)
        if callable(cancel):
            cancel()

    def _run(self) -> None:
        database = Database(self.data_dir).open()
        domain = CreativeDomain(
            database,
            new_id=_new_id,
            now=utc_now,
            analyzer=self.analyzer,
            renderer=self.renderer,
            cover_client=self.cover_client,
        )
        try:
            while True:
                task_id = self._queue.get()
                try:
                    if task_id is None:
                        return
                    if self._closing.is_set():
                        continue
                    begin_task = getattr(self.renderer, "begin_task", None)
                    if callable(begin_task):
                        begin_task()
                    with self._active_lock:
                        self._active_task_id = task_id
                    try:
                        domain.run_task(task_id)
                    finally:
                        with self._active_lock:
                            self._active_task_id = None
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
        creative_cover_client=None,
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
            self.creative_renderer = creative_renderer or HybridCreativeRenderer(data_dir)
            self.creative_cover_client = creative_cover_client or APIMartCoverClient()
            self.creative_domain = CreativeDomain(
                self.database,
                new_id=_new_id,
                now=utc_now,
                analyzer=self.creative_analyzer,
                renderer=self.creative_renderer,
                cover_client=self.creative_cover_client,
            )
            self._creative_jobs = (
                _CreativeJobWorker(
                    data_dir,
                    analyzer=self.creative_analyzer,
                    renderer=self.creative_renderer,
                    cover_client=self.creative_cover_client,
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
            cancel = getattr(self.creative_renderer, "cancel", None)
            if callable(cancel):
                cancel()
            self._creative_jobs.close()
        previews = getattr(self, "_asset_preview_executor", None)
        if previews is not None:
            previews.shutdown(wait=False, cancel_futures=True)
        close_renderer = getattr(self.creative_renderer, "close", None)
        if callable(close_renderer):
            close_renderer(timeout_seconds=3.0)
        self.database.close()
        self.instance_lock.release()

    def _pause_creative_tasks_for_shutdown(self) -> int:
        now = utc_now()
        placeholders = ",".join("?" for _ in CREATIVE_TASK_TYPES)
        with self.database.transaction() as connection:
            rows = connection.execute(
                f"""
                SELECT id, task_type, status, payload_json FROM content_tasks
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
                self._sync_guided_task_interruption(
                    connection, row, "paused", now
                )
                project_id = payload.get("project_id") if isinstance(payload, dict) else None
                if project_id:
                    connection.execute(
                        "UPDATE creative_projects SET status = 'paused', updated_at = ? WHERE id = ?",
                        (now, project_id),
                    )
        return cursor.rowcount

    @staticmethod
    def _guided_session_id_from_task_payload(row) -> str:
        try:
            payload = json.loads(row["payload_json"])
        except (KeyError, TypeError, ValueError):
            return ""
        if not isinstance(payload, dict):
            return ""
        return str(payload.get("session_id") or "").strip()

    def _sync_guided_task_interruption(self, connection, row, next_status, now) -> None:
        """Keep a guided session in the same transaction as a stopped task.

        A draft can have crossed the external AI request boundary.  Once its
        worker is stopped, a later completion must not turn that unknown result
        into a new usable script.  Queued tasks have not crossed that boundary,
        so cancelling them returns the user to the preceding local step.
        """
        task_type = str(row["task_type"] or "")
        if task_type == "guided_auto_mix_supplemental_image":
            try:
                payload = json.loads(row["payload_json"])
            except (KeyError, TypeError, ValueError):
                return
            operation_id = (
                str(payload.get("operation_id") or "").strip()
                if isinstance(payload, dict)
                else ""
            )
            if not operation_id:
                return
            operation = connection.execute(
                """
                SELECT status, external_task_id
                FROM guided_auto_mix_supplemental_images_v1
                WHERE id = ?
                """,
                (operation_id,),
            ).fetchone()
            if operation is None:
                return
            # A planned operation has not crossed the provider boundary.  A
            # submitted one with a provider ID can resume by polling only.
            # The tiny durable-admission window without an ID is ambiguous and
            # must never be sent again automatically.
            if next_status == "cancelled" and operation["status"] == "planned":
                connection.execute(
                    """
                    UPDATE guided_auto_mix_supplemental_images_v1
                    SET status = 'cancelled', error_code = 'task_cancelled', updated_at = ?
                    WHERE id = ? AND status = 'planned'
                    """,
                    (now, operation_id),
                )
            elif (
                str(row["status"] or "") in {"analyzing", "rendering"}
                and operation["status"] == "submitted"
                and not str(operation["external_task_id"] or "").strip()
            ):
                connection.execute(
                    """
                    UPDATE guided_auto_mix_supplemental_images_v1
                    SET status = 'outcome_unknown', error_code = 'submission_interrupted', updated_at = ?
                    WHERE id = ? AND status = 'submitted' AND (external_task_id IS NULL OR external_task_id = '')
                    """,
                    (now, operation_id),
                )
            return
        if task_type not in {"guided_auto_mix_analysis", "guided_auto_mix_draft"}:
            return
        session_id = self._guided_session_id_from_task_payload(row)
        if not session_id:
            return
        previous_status = str(row["status"] or "")
        if previous_status in {"analyzing", "rendering"}:
            session_status = "outcome_unknown"
        elif next_status == "cancelled" and task_type == "guided_auto_mix_draft":
            session_status = "ready_for_answers"
        elif next_status == "cancelled" and task_type == "guided_auto_mix_analysis":
            session_status = "failed"
        else:
            return
        task_column = (
            "analysis_task_id"
            if task_type == "guided_auto_mix_analysis"
            else "draft_task_id"
        )
        expected_session_status = (
            "analyzing"
            if task_type == "guided_auto_mix_analysis"
            else "drafting"
        )
        connection.execute(
            f"""
            UPDATE guided_auto_mix_sessions_v1
            SET status = ?, updated_at = ?
            WHERE id = ? AND {task_column} = ? AND status = ?
            """,
            (
                session_status,
                now,
                session_id,
                row["id"],
                expected_session_status,
            ),
        )

    def _complete_paused_guided_task(self, task_id: str) -> dict[str, Any]:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE content_tasks
                SET status = 'completed', progress = 1, resume_from_status = NULL,
                    error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ? AND status = 'paused'
                  AND task_type IN ('guided_auto_mix_analysis', 'guided_auto_mix_draft')
                """,
                (utc_now(), task_id),
            )
        return self._get_public_task(task_id)

    def _complete_paused_guided_supplemental_image_task(self, task_id: str) -> dict[str, Any]:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE content_tasks
                SET status = 'completed', progress = 1, resume_from_status = NULL,
                    error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ? AND status = 'paused'
                  AND task_type = 'guided_auto_mix_supplemental_image'
                """,
                (utc_now(), task_id),
            )
        return self._get_public_task(task_id)

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
            rows = connection.execute(
                """
                SELECT id, task_type, status, payload_json FROM content_tasks
                WHERE status IN ('analyzing', 'rendering')
                """
            ).fetchall()
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
            for row in rows:
                self._sync_guided_task_interruption(connection, row, "paused", now)
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
            "creative_cover": {
                "available": bool(self.creative_cover_client.configured),
                "provider": "apimart_gpt_image_2",
            },
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
        packaging_mode: str = "auto",
        packaging_preset_id: str | None = None,
        brand_profile_id: str | None = None,
        cover_mode: str = "auto",
        visual_renderer: dict[str, Any] | None = None,
        confirm_paid_calls: bool = False,
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
                packaging_mode=packaging_mode,
                packaging_preset_id=packaging_preset_id,
                brand_profile_id=brand_profile_id,
                cover_mode=cover_mode,
                visual_renderer=visual_renderer,
                confirm_paid_calls=confirm_paid_calls,
            )
        )

    def generate_mix_batch(
        self,
        asset_ids: Iterable[str],
        *,
        theme: str = "培训现场价值",
        target_count: int = 30,
        voice_asset_id: str | None = None,
        pilot_mode: bool = False,
        packaging_mode: str = "auto",
        packaging_preset_id: str | None = None,
        brand_profile_id: str | None = None,
        cover_mode: str = "auto",
        visual_renderer: dict[str, Any] | None = None,
        confirm_paid_calls: bool = False,
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_mix_task(
                asset_ids,
                theme=theme,
                target_count=target_count,
                voice_asset_id=voice_asset_id,
                pilot_mode=pilot_mode,
                packaging_mode=packaging_mode,
                packaging_preset_id=packaging_preset_id,
                brand_profile_id=brand_profile_id,
                cover_mode=cover_mode,
                visual_renderer=visual_renderer,
                confirm_paid_calls=confirm_paid_calls,
            )
        )

    def create_one_click_project(self, name, asset_ids, options=None):
        options = options if isinstance(options, dict) else {}
        return self.creative_domain.create_one_click_project(
            name,
            asset_ids,
            brief=options.get("brief"),
            ratio=options.get("ratio", "9:16"),
            duration_ms=options.get("duration_ms", 75_000),
            target_count=options.get("target_count", 3),
            cover_mode=options.get("cover_mode", "ai_generate"),
            bgm_asset_id=options.get("bgm_asset_id"),
        )

    def create_auto_mix_v2(self, request):
        task = self.creative_domain.create_auto_mix_v2(request)
        self._enqueue_creative_task(task)
        return self.creative_domain.get_auto_mix_plan_v2(
            run_id=task["run_id"]
        )

    def _narrated_batches(self):
        from .narrated_batch import NarratedBatchDomain
        return NarratedBatchDomain(self.creative_domain)

    def list_asset_collections(self):
        return self._narrated_batches().collections()

    def save_asset_collection(self, request):
        return self._narrated_batches().save_collection(request)

    def list_narrated_batches(self):
        return self._narrated_batches().list_batches()

    def archive_narrated_batch(self, batch_id):
        return self._narrated_batches().archive(batch_id)

    def save_narrated_batch(self, request):
        return self._narrated_batches().save(request)

    def get_narrated_batch(self, batch_id):
        return self._narrated_batches().get(batch_id)

    def get_narrated_batch_status(self, batch_id):
        return self._narrated_batches().status(batch_id)

    def get_narrated_output_directory(self, batch_id):
        return self._narrated_batches().output_directory(batch_id)

    def update_narrated_candidate(self, request):
        return self._narrated_batches().update_candidate(request)

    def _start_narrated_batch(self, batch_id, action):
        domain = self._narrated_batches()
        batch = domain._load(batch_id)
        domain._idle(batch)
        # Newly imported files have not necessarily visited the library's probe
        # action. Resolve their metadata before pinning duration-dependent plans.
        if action in {"scripts", "recommend", "samples"}:
            asset_ids = dict.fromkeys(asset_id for group in batch["groups"].values() for asset_id in group)
            for asset_id in asset_ids:
                if domain.d._asset_row(asset_id)["probe_status"] != "ok":
                    asset = self.probe_asset(asset_id)
                    if asset["probe_status"] != "ok":
                        raise ContentEngineError("media_metadata_unavailable", "无法读取素材基础信息，请检查文件是否可访问、视频是否完整。")
        result = domain.start(batch_id, action)
        self._enqueue_creative_task({"task_id": result["task_id"]})
        return result

    def recommend_narrated_batch(self, batch_id):
        return self._start_narrated_batch(batch_id, "recommend")

    def prepare_narrated_scripts(self, batch_id):
        return self._start_narrated_batch(batch_id, "scripts")

    def confirm_narrated_script(self, request):
        result = self._narrated_batches().confirm_script(request)
        self._enqueue_creative_task({"task_id": result["task_id"]})
        return result

    def resolve_narrated_planning_outcome(self, request):
        result = self._narrated_batches().resolve_planning_outcome(request)
        self._enqueue_creative_task({"task_id": result["task_id"]})
        return result

    def generate_narrated_samples(self, batch_id):
        return self._start_narrated_batch(batch_id, "samples")

    def continue_narrated_batch(self, batch_id):
        domain = self._narrated_batches()
        batch = domain.get(batch_id)
        if ((batch.get("settings") or {}).get("workflow_version") == 2
                and batch.get("task_status") == "paused"):
            state = domain._load(batch_id)
            if state.get("_planning_inflight") or batch.get("status") == "outcome_unknown":
                raise ContentEngineError("narrated_planning_outcome_unknown", "外部请求结果未知，请先核对服务记录。")
            if not batch.get("script_confirmation"):
                raise ContentEngineError("narrated_script_confirmation_required", "请先完成文案选择并确认。")
            state["_retry_local_failures_task_id"] = batch["task_id"]
            domain._store(state)
            self.resume_creative_task(batch["task_id"])
            return domain.get(batch_id)
        return self._start_narrated_batch(batch_id, "continue")

    def resolve_asset_preview(self, asset_id, variant="thumbnail"):
        import subprocess
        from .auto_mix_v2 import canonical_hash
        if variant not in {"thumbnail", "preview"}:
            raise ContentEngineError("invalid_asset_preview", "素材预览类型无效。")
        source = Path(self.resolve_asset_path(asset_id)["absolute_path"])
        asset = self.creative_domain._asset_row(asset_id)
        # Native supported files are served only through main's controlled
        # protocol. Other formats use a local cached proxy, never cloud upload.
        if (source.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
                or variant == "preview" and source.suffix.lower() == ".webm"):
            import mimetypes
            return {"asset_id": asset_id, "variant": variant, "absolute_path": str(source),
                    "mime_type": mimetypes.guess_type(source.name)[0] or "application/octet-stream"}
        ffmpeg = getattr(self.creative_analyzer, "ffmpeg_path", None)
        if not ffmpeg:
            raise ContentEngineError("ffmpeg_unavailable", "本地媒体工具不可用。")
        directory = self.database.data_dir / "asset-previews"
        if has_unsafe_component(directory if directory.exists() else directory.parent):
            raise ContentEngineError("asset_path_unavailable", "素材缓存目录不可用。")
        directory.mkdir(parents=True, exist_ok=True)
        if has_unsafe_component(directory):
            raise ContentEngineError("asset_path_unavailable", "素材缓存目录不可用。")
        digest = canonical_hash([asset_id, source.stat().st_size, source.stat().st_mtime_ns, variant])
        extension = ".jpg" if variant == "thumbnail" or asset["media_kind"] == "image" else ".mp4"
        destination = directory / (digest + extension)
        if destination.exists() and has_unsafe_component(destination):
            raise ContentEngineError("asset_path_unavailable", "素材预览缓存不可用。")
        if not destination.is_file():
            temporary = directory / (digest + ".part" + extension)
            if temporary.exists() and has_unsafe_component(temporary):
                raise ContentEngineError("asset_path_unavailable", "素材预览缓存不可用。")
            command = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
            if extension == ".jpg":
                command += ["-frames:v", "1", "-vf", "scale=480:480:force_original_aspect_ratio=decrease", "-q:v", "3"]
            else:
                command += ["-vf", "scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2",
                            "-c:v", "h264_mf", "-rate_control", "quality", "-quality", "50",
                            "-scenario", "archive", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]
            command.append(str(temporary))
            if not hasattr(self, "_asset_preview_executor"):
                from concurrent.futures import ThreadPoolExecutor
                self._asset_preview_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="asset-preview")
                self._asset_preview_jobs = {}
            job = self._asset_preview_jobs.get(digest)
            if job is None:
                def generate():
                    try:
                        completed = subprocess.run(command, capture_output=True, timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                        if completed.returncode or not temporary.is_file():
                            raise ContentEngineError("asset_preview_failed", "无法生成该素材的预览。")
                        temporary.replace(destination)
                    except subprocess.TimeoutExpired as error:
                        raise ContentEngineError("asset_preview_failed", "素材预览耗时较长，请稍后重试。") from error
                job = self._asset_preview_executor.submit(generate)
                self._asset_preview_jobs[digest] = job
            if not job.done():
                return {"asset_id": asset_id, "variant": variant, "pending": True}
            self._asset_preview_jobs.pop(digest, None)
            job.result()
        elif hasattr(self, "_asset_preview_jobs"):
            self._asset_preview_jobs.pop(digest, None)
        return {"asset_id": asset_id, "variant": variant, "absolute_path": str(destination.resolve()),
                "mime_type": "image/jpeg" if extension == ".jpg" else "video/mp4"}

    def prepare_guided_auto_mix_v2(self, asset_ids):
        session = self.creative_domain.prepare_guided_auto_mix_v2(asset_ids)
        task = session.get("analysis_task") or {}
        if task.get("task_id"):
            self._enqueue_creative_task(task)
        return session

    def get_guided_auto_mix_session_v2(self, *, session_id=None, task_id=None):
        return self.creative_domain.get_guided_auto_mix_session_v2(
            session_id=session_id, task_id=task_id
        )

    def generate_guided_auto_mix_script_v2(self, session_id, title, answers):
        session = self.creative_domain.generate_guided_auto_mix_script_v2(
            session_id, title, answers
        )
        task = session.get("draft_task") or {}
        if task.get("task_id"):
            self._enqueue_creative_task(task)
        return session

    def get_guided_auto_mix_supplemental_image_v2(self, session_id, script_revision):
        return self.creative_domain.get_guided_auto_mix_supplemental_image(
            session_id, script_revision
        )

    def create_guided_auto_mix_supplemental_image_v2(
        self, session_id, script_revision, draft_hash, *, confirm_paid_calls=False
    ):
        task = self.creative_domain.create_guided_auto_mix_supplemental_image(
            session_id,
            script_revision,
            draft_hash,
            confirm_paid_calls,
        )
        return self._enqueue_creative_task(task)

    def resolve_guided_auto_mix_supplemental_image_path(self, operation_id):
        result = self.creative_domain.resolve_guided_auto_mix_supplemental_image_path(
            operation_id
        )
        return {**result, "variant": "image"}

    def get_auto_mix_plan_v2(self, *, project_id=None, run_id=None):
        return self.creative_domain.get_auto_mix_plan_v2(
            project_id=project_id, run_id=run_id
        )

    def regenerate_auto_mix_layer(self, project_id, layer, *, expected_run_id=None):
        task = self.creative_domain.regenerate_auto_mix_layer(
            project_id,
            layer,
            expected_run_id=expected_run_id,
        )
        self._enqueue_creative_task(task)
        return self.creative_domain.get_auto_mix_plan_v2(
            run_id=task["run_id"]
        )

    def import_music_catalog_track(self, request):
        return self.creative_domain.import_music_catalog_track(request)

    def list_music_catalog_tracks(self):
        return self.creative_domain.list_music_catalog_tracks()

    def preview_music_catalog_track(self, track_id):
        return self.creative_domain.preview_music_catalog_track(track_id)

    def list_auto_mix_voice_personas(self):
        return self.creative_domain.list_auto_mix_voice_personas()

    def design_auto_mix_voice_persona(self, voice_persona_id):
        return self.creative_domain.design_auto_mix_voice_persona(
            voice_persona_id
        )

    def preview_auto_mix_voice_persona(self, voice_persona_id):
        return self.creative_domain.preview_auto_mix_voice_persona(
            voice_persona_id
        )

    def approve_auto_mix_voice_persona(self, voice_persona_id):
        return self.creative_domain.approve_auto_mix_voice_persona(
            voice_persona_id
        )

    def analyze_product_assets(self, project_id):
        return self._enqueue_creative_task(
            self.creative_domain.create_product_asset_analysis_task(project_id)
        )

    def generate_product_copy(self, project_id, brief=None):
        return self._enqueue_creative_task(
            self.creative_domain.create_product_copy_task(project_id, brief)
        )

    def generate_product_voice(self, project_id, script_id=None):
        return self._enqueue_creative_task(
            self.creative_domain.create_product_voice_task(project_id, script_id)
        )

    def generate_one_click_candidates(self, project_id, options=None):
        return self._enqueue_creative_task(
            self.creative_domain.create_product_generation_task(project_id, options)
        )

    def list_one_click_candidates(self, project_id, limit=20):
        project = self.creative_domain._product_project_settings(project_id)
        result = self.creative_domain.list_generated(project_id=project_id, limit=limit)
        result["workflow"] = "product_one_click"
        return result

    def list_packaging_presets(self, kind: str | None = None) -> dict[str, Any]:
        return self.creative_domain.list_packaging_presets(kind)

    def list_brand_profiles(self) -> dict[str, Any]:
        return self.creative_domain.list_brand_profiles()

    def save_brand_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        return self.creative_domain.save_brand_profile(profile)

    def package_generated_videos(
        self, candidate_ids: Iterable[str], options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_packaging_task(
                list(candidate_ids) if candidate_ids is not None else None, options
            )
        )

    def repackage_video(
        self, candidate_id: str, options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_repackage_task(candidate_id, options)
        )

    def preflight_visual_comparison(self, candidate_id: str) -> dict[str, Any]:
        return self.creative_domain.preflight_visual_comparison(candidate_id)

    def create_visual_comparison_task(self, candidate_id: str) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.create_visual_comparison_task(candidate_id)
        )

    def get_packaging_cost_estimate(
        self,
        candidate_ids: Iterable[str],
        *,
        cover_mode: str = "auto",
        planned_count: int | None = None,
        asset_ids: Iterable[str] | None = None,
        generation_kind: str | None = None,
    ) -> dict[str, Any]:
        return self.creative_domain.get_packaging_cost_estimate(
            list(candidate_ids) if candidate_ids is not None else None,
            cover_mode=cover_mode,
            planned_count=planned_count,
            asset_ids=list(asset_ids) if asset_ids is not None else None,
            generation_kind=generation_kind,
        )

    def record_media_review(
        self,
        candidate_id: str,
        *,
        device: str = "phone",
        verdict: str = "pass",
        reason: str = "",
        reviewer: str = "",
    ) -> dict[str, Any]:
        return self.creative_domain.record_media_review(
            candidate_id,
            device=device,
            verdict=verdict,
            reason=reason,
            reviewer=reviewer,
        )

    def list_media_reviews(self, candidate_id: str) -> dict[str, Any]:
        return self.creative_domain.list_media_reviews(candidate_id)

    def regenerate_cover(self, candidate_id: str) -> dict[str, Any]:
        return self._enqueue_creative_task(
            self.creative_domain.regenerate_cover(candidate_id)
        )

    def update_cover_operation(
        self,
        operation_id: str,
        status: str,
        *,
        external_task_id: str | None = None,
        error_code: str | None = None,
    ) -> dict[str, Any]:
        return self.creative_domain.update_cover_operation(
            operation_id,
            status,
            external_task_id=external_task_id,
            error_code=error_code,
        )

    def run_creative_task(self, task_id: str) -> dict[str, Any]:
        begin_task = getattr(self.creative_renderer, "begin_task", None)
        if callable(begin_task):
            begin_task()
        return self.creative_domain.run_task(task_id)

    def resume_creative_task(self, task_id: str) -> dict[str, Any]:
        task = self._get_public_task(task_id)
        if task["task_type"] not in CREATIVE_TASK_TYPES:
            raise ContentEngineError("invalid_task_type", "This is not a creative task.")
        if task["status"] != "paused":
            raise ContentEngineError("invalid_transition", "Only paused tasks can resume.")
        if task["task_type"] in {
            "guided_auto_mix_analysis",
            "guided_auto_mix_draft",
        }:
            session = self.creative_domain.get_guided_auto_mix_session_v2(
                task_id=task_id
            )
            session_status = session["status"]
            if session_status == "outcome_unknown":
                raise ContentEngineError(
                    "guided_auto_mix_outcome_unknown",
                    "引导任务的外部结果暂时无法确认，不能自动重新提交。请重新解析素材后再继续。",
                )
            if session_status in {"ready_for_answers", "ready_for_render"}:
                return self._complete_paused_guided_task(task_id)
            expected_status = (
                "analyzing"
                if task["task_type"] == "guided_auto_mix_analysis"
                else "drafting"
            )
            if session_status != expected_status:
                raise ContentEngineError(
                    "guided_auto_mix_task_stale",
                    "这次引导任务已不是可继续状态，请重新解析素材后再操作。",
                )
        if task["task_type"] == "guided_auto_mix_supplemental_image":
            raw_task = self.creative_domain._task_row(task_id)
            try:
                payload = json.loads(raw_task["payload_json"])
            except (TypeError, ValueError) as error:
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_task_invalid",
                    "AI 补图任务记录无效。",
                ) from error
            operation_id = str(payload.get("operation_id") or "")
            operation = self.creative_domain._guided_auto_mix_supplemental_image_operation_row(
                operation_id
            )
            status = str(operation["status"] or "")
            if status == "completed":
                return self._complete_paused_guided_supplemental_image_task(task_id)
            if status == "outcome_unknown":
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_outcome_unknown",
                    "本次 AI 补图结果暂时无法确认，系统不会自动重复提交。",
                )
            if status in {"failed", "cancelled"}:
                raise ContentEngineError(
                    f"guided_auto_mix_supplemental_image_{status}",
                    "这次 AI 补图已结束，请重新生成脚本后再创建新的补图。",
                )
            if status != "planned" and not str(operation["external_task_id"] or "").strip():
                raise ContentEngineError(
                    "guided_auto_mix_supplemental_image_outcome_unknown",
                    "AI 补图可能已提交，但没有可恢复的服务任务标识。",
                )
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
        result_json = (
            json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            if result is not None
            else None
        )
        with self.database.transaction() as connection:
            row = connection.execute(
                """
                SELECT id, status, resume_from_status, error_code, error_message,
                       task_type, payload_json
                FROM content_tasks WHERE id = ?
                """,
                (task_id,),
            ).fetchone()
            if row is None:
                raise ContentEngineError("task_not_found", "The task was not found.")
            requested_status = status
            payload = json.loads(row["payload_json"])
            if (
                requested_status == "cancelled"
                and row["task_type"] in CREATIVE_TASK_TYPES
                and self._task_has_submitted_cover(
                    connection, task_id, row["task_type"], payload
                )
            ):
                status = "paused"
                error_code = error_code or "cover_submission_inflight"
                error_message = error_message or (
                    "补图已提交到 APIMart；任务已暂停并保留原任务编号，继续时只会查询原任务。"
                    if row["task_type"] == "guided_auto_mix_supplemental_image"
                    else "封面已提交到 APIMart；任务已暂停并保留原任务编号，继续时不会重复提交。"
                )
            if status != row["status"] and status not in TASK_TRANSITIONS[row["status"]]:
                raise ContentEngineError(
                    "invalid_transition",
                    f"The transition from {row['status']} to {status} is not allowed.",
                )
            if status == "paused":
                resume_from_status = (
                    row["resume_from_status"]
                    if row["status"] == "paused"
                    else row["status"]
                )
                next_error_code = (
                    redact_text(error_code) if error_code else row["error_code"]
                )
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
            updated_at = utc_now()
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
                updated_at,
            ]
            if progress is not None:
                assignments.append("progress = ?")
                parameters.append(progress)
            if result_json is not None:
                assignments.append("result_json = ?")
                parameters.append(result_json)
            parameters.append(task_id)
            connection.execute(
                f"UPDATE content_tasks SET {', '.join(assignments)} WHERE id = ?",
                parameters,
            )
            if status in {"paused", "cancelled"}:
                self._sync_guided_task_interruption(
                    connection, row, status, updated_at
                )
            if row["task_type"] in CREATIVE_TASK_TYPES and status in {
                "queued",
                "paused",
                "cancelled",
            }:
                project_id = payload.get("project_id") if isinstance(payload, dict) else None
                if project_id:
                    connection.execute(
                        "UPDATE creative_projects SET status = ?, updated_at = ? WHERE id = ?",
                        (status, utc_now(), project_id),
                    )
        if row["task_type"] in CREATIVE_TASK_TYPES and status in {
            "paused",
            "cancelled",
        }:
            cancel_task = getattr(self._creative_jobs, "cancel_task", None)
            if callable(cancel_task):
                cancel_task(task_id)
        return self._get_public_task(task_id)

    @staticmethod
    def _task_has_submitted_cover(connection, task_id, task_type, payload) -> bool:
        if task_type == "guided_auto_mix_supplemental_image":
            operation_id = (
                payload.get("operation_id") if isinstance(payload, dict) else None
            )
            if not operation_id:
                return False
            row = connection.execute(
                """
                SELECT 1 FROM guided_auto_mix_supplemental_images_v1
                WHERE id = ? AND status = 'submitted'
                """,
                (operation_id,),
            ).fetchone()
            return row is not None
        if task_type == "creative_cover":
            operation_id = (
                payload.get("cover_operation_id")
                if isinstance(payload, dict)
                else None
            )
            if not operation_id:
                return False
            row = connection.execute(
                "SELECT 1 FROM cover_generation_ledger WHERE id = ? AND status = 'submitted'",
                (operation_id,),
            ).fetchone()
            return row is not None
        row = connection.execute(
            """
            SELECT 1
            FROM cover_generation_ledger ledger
            JOIN generated_videos video
              ON video.id = ledger.generated_video_id
            WHERE video.task_id = ? AND ledger.status = 'submitted'
            LIMIT 1
            """,
            (task_id,),
        ).fetchone()
        return row is not None

    def _get_public_task(self, task_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM content_tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            raise ContentEngineError("task_not_found", "The task was not found.")
        if row["task_type"] in CREATIVE_TASK_TYPES:
            return self.creative_domain._public_task(row)
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
        visual_capability = self.creative_domain._visual_comparison_capability_snapshot()
        candidate_lookup = self.creative_domain._comparison_candidate_lookup(rows)
        return {
            "items": [
                self.creative_domain._public_task(
                    row,
                    capability=visual_capability,
                    candidate_lookup=candidate_lookup,
                )
                if row["task_type"] in CREATIVE_TASK_TYPES
                else _public_task_row(row)
                for row in rows
            ]
        }

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
        path = Path(row["output_path"])
        return _public_finished_row(
            row,
            available=path.is_file() and not has_unsafe_component(path),
        )

    def list_finished(self, *, limit: int = 500) -> dict[str, Any]:
        rows = self.connection.execute(
            """
            SELECT * FROM finished_videos
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (_validate_limit(limit),),
        ).fetchall()
        items = []
        for row in rows:
            path = Path(row["output_path"])
            items.append(
                _public_finished_row(
                    row,
                    available=path.is_file() and not has_unsafe_component(path),
                )
            )
        return {"items": items}


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


def _public_finished_row(row, *, available: bool = True) -> dict[str, Any]:
    return {
        "finished_video_id": row["id"],
        "task_id": row["task_id"],
        "display_name": row["display_name"],
        "title": row["title"],
        "size_bytes": row["size_bytes"],
        "metadata": sanitize_public_value(json.loads(row["metadata_json"])),
        "available": bool(available),
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
