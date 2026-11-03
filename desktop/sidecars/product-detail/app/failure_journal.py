"""Local journal of product-detail failures, read by the desktop's failure reports.

A failed or uncertain generation is otherwise only shown on this service's own
page; the desktop never learns of it, so no failure report reaches us. Same
record format as the content engine's journal.
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


def journal_file() -> Path | None:
    data_dir = os.environ.get("XIAOXI_PRODUCT_DETAIL_DATA_DIR", "").strip()
    return Path(data_dir) / "logs" / "failures.jsonl" if data_dir else None


def record(error: BaseException | None, *, where: str, code: str = "", message: str = "",
           task_id: str = "", context: dict | None = None) -> None:
    """Append one failure. Never raises: journaling must not change the outcome."""
    file = journal_file()
    if file is None:
        return
    try:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "where": str(where)[:120],
            "code": str(code or getattr(error, "code", "") or "internal_error")[:120],
            "type": type(error).__name__ if error is not None else "",
            "message": str(message or (error if error is not None else ""))[:2000],
            "details": getattr(error, "details", None) or {},
            "task_id": str(task_id or "")[:120],
            "context": context or {},
            "traceback": "".join(traceback.format_exception(type(error), error, error.__traceback__))[-12000:]
            if error is not None else "",
        }
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with _lock:
            file.parent.mkdir(parents=True, exist_ok=True)
            if file.exists() and file.stat().st_size > MAX_BYTES:
                os.replace(file, file.with_name("failures.1.jsonl"))
            with file.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
    except Exception:
        pass
