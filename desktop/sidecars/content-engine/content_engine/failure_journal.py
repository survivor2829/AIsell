"""Local journal of every failure the engine reports, with its traceback.

The desktop turns each record into a failure capsule. Without it a failure
that a batch absorbs (a job put back to queued, a skipped item) leaves no
trace outside the batch row, and an internal error leaves no traceback at all.
"""
from __future__ import annotations

import json
import os
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

MAX_BYTES = 2 * 1024 * 1024
_lock = threading.Lock()
_directory: Path | None = None


def configure(data_dir) -> None:
    global _directory
    directory = Path(data_dir) / "logs"
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        return
    _directory = directory


def journal_file() -> Path | None:
    return _directory / "failures.jsonl" if _directory else None


def record(error: BaseException, *, where: str, task_id: str = "", context: dict | None = None) -> None:
    """Append one failure. Never raises: journaling must not change the outcome."""
    file = journal_file()
    if file is None:
        return
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "where": str(where)[:120],
            "code": str(getattr(error, "code", "") or "internal_error")[:120],
            "type": type(error).__name__,
            "message": str(getattr(error, "message", "") or error)[:2000],
            "details": getattr(error, "details", None) or {},
            "task_id": str(task_id or "")[:120],
            "context": context or {},
            "traceback": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-12000:],
        }
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with _lock:
            if file.exists() and file.stat().st_size > MAX_BYTES:
                os.replace(file, file.with_name("failures.1.jsonl"))
            with file.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
    except Exception:
        pass
