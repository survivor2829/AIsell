from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


HISTORY_FILENAME = "workspace_results.json"
DEFAULT_LIMIT = 20
ALLOWED_KINDS = {"ai_refine_v2", "ai_compose", "ai_detail", "ai_images"}


def workspace_history_path(base_dir: Path, user_id: int | str) -> Path:
    return Path(base_dir) / str(user_id) / HISTORY_FILENAME


def public_url_to_path(url: str, repo_root: Path) -> Path | None:
    clean = (url or "").split("?", 1)[0].split("#", 1)[0].strip()
    if clean.startswith("/static/") or clean.startswith("/output/"):
        return Path(repo_root) / clean.lstrip("/")
    return None


def _read_history(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        results = data.get("results", [])
        if isinstance(results, list):
            return [item for item in results if isinstance(item, dict)]
    return []


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _timestamp(now: datetime | None = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _normalize_record(
    user_id: int | str,
    record: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, Any]:
    kind = str(record.get("kind") or "").strip()
    if kind not in ALLOWED_KINDS:
        raise ValueError(f"unsupported workspace result kind: {kind!r}")

    image_url = str(record.get("image_url") or record.get("assembled_url") or "").strip()
    if not image_url:
        raise ValueError("workspace result requires image_url or assembled_url")

    task_id = str(record.get("task_id") or "").strip()
    result = {
        "kind": kind,
        "user_id": int(user_id),
        "task_id": task_id,
        "image_url": image_url,
        "assembled_url": str(record.get("assembled_url") or image_url).strip(),
        "mode": str(record.get("mode") or "").strip(),
        "product_title": str(record.get("product_title") or "").strip(),
        "product_category": str(record.get("product_category") or "").strip(),
        "blocks_count": int(record.get("blocks_count") or 0),
        "elapsed_s": float(record.get("elapsed_s") or 0.0),
        "cost_rmb": float(record.get("cost_rmb") or 0.0),
        "created_at": _timestamp(now),
    }
    return result


def save_workspace_result(
    base_dir: Path,
    user_id: int | str,
    record: Mapping[str, Any],
    *,
    limit: int = DEFAULT_LIMIT,
    now: datetime | None = None,
) -> dict[str, Any]:
    path = workspace_history_path(base_dir, user_id)
    normalized = _normalize_record(user_id, record, now=now)
    existing = _read_history(path)

    def same_result(item: Mapping[str, Any]) -> bool:
        if normalized["task_id"] and item.get("task_id") == normalized["task_id"]:
            return True
        return item.get("image_url") == normalized["image_url"]

    results = [item for item in existing if not same_result(item)]
    results.insert(0, normalized)
    results = results[: max(1, int(limit))]
    _atomic_write_json(path, {"version": 1, "results": results})
    return normalized


def result_asset_exists(record: Mapping[str, Any], repo_root: Path) -> bool:
    image_url = str(record.get("image_url") or record.get("assembled_url") or "")
    path = public_url_to_path(image_url, repo_root)
    return bool(path and path.is_file())


def load_workspace_results(
    base_dir: Path,
    user_id: int | str,
    *,
    kind: str | None = None,
    repo_root: Path | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    path = workspace_history_path(base_dir, user_id)
    results = _read_history(path)
    if kind:
        results = [item for item in results if item.get("kind") == kind]
    if repo_root is not None:
        results = [item for item in results if result_asset_exists(item, repo_root)]
    return results[: max(1, int(limit))]


def load_latest_workspace_result(
    base_dir: Path,
    user_id: int | str,
    *,
    kind: str | None = None,
    repo_root: Path | None = None,
) -> dict[str, Any] | None:
    results = load_workspace_results(
        base_dir,
        user_id,
        kind=kind,
        repo_root=repo_root,
        limit=1,
    )
    return results[0] if results else None
