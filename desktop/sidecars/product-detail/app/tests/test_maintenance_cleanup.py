from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.maintenance_cleanup import apply_cleanup_plan, collect_cleanup_plan


NOW = datetime(2026, 5, 14, tzinfo=timezone.utc)


def _write_file(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _age(path: Path, days: int) -> None:
    ts = (NOW - timedelta(days=days)).timestamp()
    os.utime(path, (ts, ts))


def _candidate_paths(plan: dict) -> set[str]:
    return {item["path"] for item in plan["candidates"]}


def test_collect_cleanup_plan_is_dry_run_for_ai_bg_cache(tmp_path):
    old_cache = _write_file(tmp_path / "static" / "cache" / "ai_bg" / "old.png")
    recent_cache = _write_file(tmp_path / "static" / "cache" / "ai_bg" / "recent.png")
    _age(old_cache, 3)
    _age(recent_cache, 0)

    plan = collect_cleanup_plan(tmp_path, now=NOW, ai_bg_days=1)

    assert str(old_cache.resolve()) in _candidate_paths(plan)
    assert str(recent_cache.resolve()) not in _candidate_paths(plan)
    assert old_cache.exists(), "collect_cleanup_plan must never delete files"


def test_cleanup_skips_ai_refine_dir_referenced_by_workspace_history(tmp_path):
    keep_dir = tmp_path / "static" / "ai_refine_v2" / "v2_keep"
    keep_img = _write_file(keep_dir / "assembled.png")
    delete_dir = tmp_path / "static" / "ai_refine_v2" / "v2_delete"
    delete_img = _write_file(delete_dir / "assembled.png")
    _age(keep_img, 30)
    _age(delete_img, 30)
    _age(keep_dir, 30)
    _age(delete_dir, 30)

    history = tmp_path / "static" / "outputs" / "42" / "workspace_results.json"
    history.parent.mkdir(parents=True, exist_ok=True)
    history.write_text(
        json.dumps({
            "results": [
                {
                    "kind": "ai_refine_v2",
                    "image_url": "/static/ai_refine_v2/v2_keep/assembled.png",
                }
            ]
        }),
        encoding="utf-8",
    )

    plan = collect_cleanup_plan(tmp_path, now=NOW, ai_refine_days=7)
    paths = _candidate_paths(plan)

    assert str(delete_dir.resolve()) in paths
    assert str(keep_dir.resolve()) not in paths

    result = apply_cleanup_plan(plan, tmp_path)
    assert result["deleted_count"] == 1
    assert keep_img.exists()
    assert not delete_dir.exists()
