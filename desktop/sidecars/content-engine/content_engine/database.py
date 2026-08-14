from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Callable
import time


Migration = Callable[[sqlite3.Connection], None]


def _migration_001_initial_schema(connection: sqlite3.Connection) -> None:
    statements = (
        """
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            full_fingerprint TEXT,
            media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'image')),
            extension TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            display_name TEXT NOT NULL,
            rights_status TEXT NOT NULL DEFAULT 'unknown',
            archived_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS asset_locations (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            absolute_path TEXT NOT NULL UNIQUE,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            modified_ns INTEGER NOT NULL,
            is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS content_tasks (
            id TEXT PRIMARY KEY,
            task_type TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
                status IN (
                    'queued',
                    'analyzing',
                    'ready_for_review',
                    'rendering',
                    'completed',
                    'failed',
                    'cancelled',
                    'paused'
                )
            ),
            resume_from_status TEXT,
            payload_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT,
            progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
            error_code TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS finished_videos (
            id TEXT PRIMARY KEY,
            task_id TEXT REFERENCES content_tasks(id) ON DELETE SET NULL,
            output_path TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            title TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_asset_locations_asset ON asset_locations(asset_id)",
        "CREATE INDEX IF NOT EXISTS idx_assets_fingerprint ON assets(fingerprint, size_bytes)",
        "CREATE INDEX IF NOT EXISTS idx_assets_archived ON assets(archived_at)",
        "CREATE INDEX IF NOT EXISTS idx_content_tasks_status ON content_tasks(status)",
        "CREATE INDEX IF NOT EXISTS idx_finished_videos_created ON finished_videos(created_at)",
    )
    for statement in statements:
        connection.execute(statement)


def _migration_002_asset_probe_metadata(connection: sqlite3.Connection) -> None:
    existing_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(assets)")
    }
    columns = (
        (
            "probe_status",
            "TEXT NOT NULL DEFAULT 'pending' "
            "CHECK (probe_status IN ('pending', 'ok', 'unavailable', 'failed'))",
        ),
        (
            "duration_ms",
            "INTEGER CHECK (duration_ms IS NULL OR "
            "(duration_ms >= 0 AND duration_ms <= 2678400000))",
        ),
        (
            "width",
            "INTEGER CHECK (width IS NULL OR (width >= 1 AND width <= 32768))",
        ),
        (
            "height",
            "INTEGER CHECK (height IS NULL OR (height >= 1 AND height <= 32768))",
        ),
        (
            "fps",
            "REAL CHECK (fps IS NULL OR (fps > 0 AND fps <= 1000))",
        ),
        (
            "has_audio",
            "INTEGER CHECK (has_audio IS NULL OR has_audio IN (0, 1))",
        ),
        ("probe_error_code", "TEXT"),
        ("probed_at", "TEXT"),
    )
    for name, definition in columns:
        if name not in existing_columns:
            connection.execute(f"ALTER TABLE assets ADD COLUMN {name} {definition}")


def _migration_003_rights_status_scope(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        UPDATE assets
        SET rights_status = 'unknown'
        WHERE lower(trim(rights_status)) = 'consented'
        """
    )


def _migration_004_mix_engine_domain(connection: sqlite3.Connection) -> None:
    statements = (
        """
        CREATE TABLE IF NOT EXISTS mix_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            constraints_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS scene_slots (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES mix_projects(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0),
            name TEXT NOT NULL,
            required INTEGER NOT NULL CHECK (required IN (0, 1)),
            fixed_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
            min_duration_ms INTEGER CHECK (
                min_duration_ms IS NULL OR min_duration_ms >= 0
            ),
            max_duration_ms INTEGER CHECK (
                max_duration_ms IS NULL OR max_duration_ms >= 0
            ),
            UNIQUE(project_id, position)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS scene_slot_assets (
            slot_id TEXT NOT NULL REFERENCES scene_slots(id) ON DELETE CASCADE,
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
            position INTEGER NOT NULL CHECK (position >= 0),
            PRIMARY KEY(slot_id, asset_id),
            UNIQUE(slot_id, position)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS mix_candidates (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES mix_projects(id) ON DELETE CASCADE,
            seed TEXT NOT NULL,
            selection_signature TEXT NOT NULL,
            selection_json TEXT NOT NULL,
            duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
            score_json TEXT NOT NULL,
            review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
                review_status IN ('pending', 'approved', 'rejected')
            ),
            review_note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, seed, selection_signature)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS publish_queue_items (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE
                REFERENCES mix_candidates(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'queued' CHECK (
                status IN ('queued', 'processing', 'published', 'failed', 'cancelled')
            ),
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_scene_slots_project ON scene_slots(project_id, position)",
        "CREATE INDEX IF NOT EXISTS idx_mix_candidates_project ON mix_candidates(project_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_mix_candidates_review ON mix_candidates(review_status)",
        "CREATE INDEX IF NOT EXISTS idx_publish_queue_status ON publish_queue_items(status, created_at)",
    )
    for statement in statements:
        connection.execute(statement)


def _migration_005_mix_export_packages(connection: sqlite3.Connection) -> None:
    scene_slot_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(scene_slots)")
    }
    if "target_duration_ms" not in scene_slot_columns:
        connection.execute(
            """
            ALTER TABLE scene_slots ADD COLUMN target_duration_ms INTEGER
            CHECK (target_duration_ms IS NULL OR target_duration_ms >= 0)
            """
        )
        connection.execute(
            """
            UPDATE scene_slots
            SET target_duration_ms = CASE
                    WHEN min_duration_ms IS NOT NULL AND max_duration_ms IS NOT NULL
                        THEN CAST((min_duration_ms + max_duration_ms) / 2 AS INTEGER)
                    ELSE COALESCE(min_duration_ms, max_duration_ms)
                END,
                min_duration_ms = NULL,
                max_duration_ms = NULL
            WHERE min_duration_ms IS NOT NULL OR max_duration_ms IS NOT NULL
            """
        )

    connection.execute(
        """
        CREATE TABLE publish_queue_items_v5 (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE
                REFERENCES mix_candidates(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'queued' CHECK (
                status IN (
                    'queued', 'processing', 'exported', 'published', 'failed',
                    'cancelled'
                )
            ),
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        INSERT INTO publish_queue_items_v5(
            id, candidate_id, status, error_message, created_at, updated_at
        )
        SELECT id, candidate_id, status, error_message, created_at, updated_at
        FROM publish_queue_items
        """
    )
    connection.execute("DROP TABLE publish_queue_items")
    connection.execute(
        "ALTER TABLE publish_queue_items_v5 RENAME TO publish_queue_items"
    )
    connection.execute(
        """
        CREATE TABLE export_packages (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL REFERENCES mix_candidates(id) ON DELETE CASCADE,
            queue_item_id TEXT NOT NULL REFERENCES publish_queue_items(id) ON DELETE CASCADE,
            output_directory TEXT NOT NULL UNIQUE,
            platforms_json TEXT NOT NULL,
            outputs_json TEXT NOT NULL,
            cover_name TEXT NOT NULL,
            manifest_name TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "CREATE INDEX idx_publish_queue_status ON publish_queue_items(status, created_at)"
    )
    connection.execute(
        "CREATE INDEX idx_export_packages_candidate ON export_packages(candidate_id, created_at)"
    )


def _migration_006_creative_workbench(connection: sqlite3.Connection) -> None:
    statements = (
        """
        CREATE TABLE IF NOT EXISTS asset_derivatives (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            derivative_kind TEXT NOT NULL CHECK (
                derivative_kind IN ('proxy', 'audio', 'keyframe', 'thumbnail', 'srt')
            ),
            ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
            config_hash TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ready' CHECK (
                status IN ('pending', 'ready', 'failed')
            ),
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(asset_id, derivative_kind, ordinal, config_hash)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS media_segments (
            id TEXT PRIMARY KEY,
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
            end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
            transcript_text TEXT NOT NULL DEFAULT '',
            speaker TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'general' CHECK (
                role IN ('hook', 'process', 'result', 'general')
            ),
            shot_type TEXT NOT NULL DEFAULT 'unknown',
            tags_json TEXT NOT NULL DEFAULT '[]',
            quality_score REAL NOT NULL DEFAULT 0 CHECK (
                quality_score >= 0 AND quality_score <= 1
            ),
            thumbnail_derivative_id TEXT REFERENCES asset_derivatives(id) ON DELETE SET NULL,
            analysis_version TEXT NOT NULL,
            provider TEXT NOT NULL DEFAULT 'local',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(asset_id, start_ms, end_ms, analysis_version)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS creative_projects (
            id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK (mode IN ('course', 'mix')),
            name TEXT NOT NULL,
            theme TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'queued' CHECK (
                status IN (
                    'queued', 'analyzing', 'rendering', 'completed', 'failed',
                    'paused', 'cancelled'
                )
            ),
            settings_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS generated_videos (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES creative_projects(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES content_tasks(id) ON DELETE SET NULL,
            kind TEXT NOT NULL CHECK (kind IN ('course', 'mix')),
            status TEXT NOT NULL DEFAULT 'queued' CHECK (
                status IN ('queued', 'rendering', 'completed', 'failed', 'rejected')
            ),
            generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
            selection_signature TEXT NOT NULL,
            recipe_json TEXT NOT NULL,
            score_json TEXT NOT NULL DEFAULT '{}',
            title TEXT NOT NULL DEFAULT '',
            duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
            recommended INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0, 1)),
            output_path TEXT,
            thumbnail_path TEXT,
            error_code TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(project_id, selection_signature, generation)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS generated_publish_queue (
            id TEXT PRIMARY KEY,
            generated_video_id TEXT NOT NULL REFERENCES generated_videos(id) ON DELETE CASCADE,
            channel TEXT NOT NULL CHECK (
                channel IN ('wechat', 'douyin', 'kuaishou', 'internal')
            ),
            status TEXT NOT NULL DEFAULT 'queued' CHECK (
                status IN ('queued', 'processing', 'published', 'failed', 'cancelled')
            ),
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(generated_video_id, channel)
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_asset_derivatives_asset ON asset_derivatives(asset_id, derivative_kind)",
        "CREATE INDEX IF NOT EXISTS idx_media_segments_asset ON media_segments(asset_id, start_ms)",
        "CREATE INDEX IF NOT EXISTS idx_media_segments_role ON media_segments(role, quality_score)",
        "CREATE INDEX IF NOT EXISTS idx_creative_projects_updated ON creative_projects(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_generated_videos_project ON generated_videos(project_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_generated_queue_status ON generated_publish_queue(status, created_at)",
    )
    for statement in statements:
        connection.execute(statement)


MIGRATIONS: tuple[tuple[int, str, Migration], ...] = (
    (1, "initial_content_engine_schema", _migration_001_initial_schema),
    (2, "asset_probe_metadata", _migration_002_asset_probe_metadata),
    (3, "rights_status_scope", _migration_003_rights_status_scope),
    (4, "mix_engine_domain", _migration_004_mix_engine_domain),
    (5, "mix_export_packages", _migration_005_mix_export_packages),
    (6, "creative_workbench", _migration_006_creative_workbench),
)

def _retry_when_locked(operation, timeout_seconds: float = 5):
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            return operation()
        except sqlite3.OperationalError as error:
            message = str(error).casefold()
            if (
                "locked" not in message
                and "busy" not in message
            ) or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)



class Database:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.db_path = self.data_dir / "content-engine.sqlite3"
        self.connection: sqlite3.Connection | None = None

    def open(self) -> "Database":
        if self.connection is not None:
            return self
        self.data_dir.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            self.db_path,
            timeout=5,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        self.connection = connection
        try:
            _retry_when_locked(
                lambda: connection.execute("PRAGMA journal_mode = WAL").fetchone()
            )
            connection.execute("PRAGMA synchronous = NORMAL")
            _retry_when_locked(self._apply_migrations)
            return self
        except Exception:
            self.close()
            raise

    def _apply_migrations(self) -> None:
        connection = self._require_connection()
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (
                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                )
            )
            """
        )
        for version, name, migration in MIGRATIONS:
            connection.execute("BEGIN IMMEDIATE")
            try:
                applied = connection.execute(
                    "SELECT 1 FROM schema_migrations WHERE version = ?", (version,)
                ).fetchone()
                if applied is None:
                    migration(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name) VALUES (?, ?)",
                        (version, name),
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def transaction(self):
        return _Transaction(self._require_connection())

    def _require_connection(self) -> sqlite3.Connection:
        if self.connection is None:
            raise RuntimeError("database is not open")
        return self.connection

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None


class _Transaction:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def __enter__(self) -> sqlite3.Connection:
        self.connection.execute("BEGIN IMMEDIATE")
        return self.connection

    def __exit__(self, exc_type, exc, traceback) -> bool:
        self.connection.execute("ROLLBACK" if exc_type else "COMMIT")
        return False
