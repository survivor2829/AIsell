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


MIGRATIONS: tuple[tuple[int, str, Migration], ...] = (
    (1, "initial_content_engine_schema", _migration_001_initial_schema),
    (2, "asset_probe_metadata", _migration_002_asset_probe_metadata),
    (3, "rights_status_scope", _migration_003_rights_status_scope),
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
