"""One-time cleanup of terminal failed content production records.

Run without --apply to preview. Requires the content app to be closed for --apply.
Only production rows and their task links are removed; assets, projects, finished
videos, generated videos, provider usage and diagnostic records are preserved.
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecars" / "content-engine"))
from content_engine.production_summary import ProductionSummary  # noqa: E402


def open_database(path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def eligible(connection):
    groups = ProductionSummary(connection)._groups()
    completed_ids = {item["production_id"] for item in groups if item["state"] == "completed"}
    result = []
    for item in groups:
        if item["state"] != "failed":
            continue
        task_ids = [step["id"] for step in item["steps"]]
        if task_ids:
            marks = ",".join("?" for _ in task_ids)
            finished = connection.execute(
                f"SELECT COUNT(*) FROM finished_videos WHERE task_id IN ({marks})", task_ids
            ).fetchone()[0]
            if finished:
                raise RuntimeError(f"Failed production references finished videos: {item['production_id']}")
        if item["batch_id"]:
            row = connection.execute("SELECT state_json FROM narrated_batches_v1 WHERE id = ?", (item["batch_id"],)).fetchone()
            batch = json.loads(row[0]) if row else {}
            if any(isinstance(candidate, dict) and candidate.get("status") == "completed"
                   for candidate in batch.get("candidates", [])):
                raise RuntimeError(f"Failed batch contains completed work: {item['production_id']}")
        result.append((item, task_ids))
    return result, completed_ids


def remove_group(connection, item, task_ids):
    if item["kind"] == "narrated_batch":
        connection.execute("DELETE FROM narrated_history_v1 WHERE batch_id = ?", (item["batch_id"],))
        connection.execute("DELETE FROM narrated_batches_v1 WHERE id = ?", (item["batch_id"],))
    elif item["kind"] == "guided_session":
        session_id = item["session_id"]
        runs = [dict(row) for row in connection.execute(
            "SELECT id, parent_run_id, task_id, private_state_json FROM auto_mix_runs_v2"
        )]
        owned = {row["id"] for row in runs if json.loads(row["private_state_json"] or "{}").get("guided_session_id") == session_id
                 or row["task_id"] in task_ids}
        while True:
            next_owned = owned | {row["id"] for row in runs if row["parent_run_id"] in owned}
            if next_owned == owned:
                break
            owned = next_owned
        while owned:
            leaves = {run_id for run_id in owned if not any(row["parent_run_id"] == run_id and row["id"] in owned for row in runs)}
            if not leaves:
                raise RuntimeError(f"Run relationship cycle for {session_id}")
            for run_id in leaves:
                connection.execute("DELETE FROM auto_mix_runs_v2 WHERE id = ?", (run_id,))
            owned -= leaves
        connection.execute("DELETE FROM guided_auto_mix_sessions_v1 WHERE id = ?", (session_id,))
    elif item["kind"] != "task":
        raise RuntimeError(f"Unsupported failed production kind: {item['kind']}")
    for task_id in task_ids:
        connection.execute("DELETE FROM content_tasks WHERE id = ?", (task_id,))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="Exact content-engine.sqlite3 path")
    parser.add_argument("--apply", action="store_true", help="Back up and remove eligible records")
    args = parser.parse_args()
    db_path = args.db.resolve(strict=True)
    if db_path.name != "content-engine.sqlite3":
        parser.error("--db must name content-engine.sqlite3")
    connection = open_database(db_path)
    try:
        targets, completed_before = eligible(connection)
        print(json.dumps({"database": str(db_path), "failed_productions": [
            {"id": item["production_id"], "kind": item["kind"], "tasks": task_ids}
            for item, task_ids in targets], "completed_preserved": len(completed_before)}, ensure_ascii=False, indent=2))
        if not args.apply or not targets:
            return
        backup_path = db_path.with_name(f"content-engine.before-failed-cleanup-{datetime.now():%Y%m%d-%H%M%S}.sqlite3")
        backup = sqlite3.connect(backup_path)
        try:
            connection.backup(backup)
        finally:
            backup.close()
        print(f"Backup: {backup_path}")
        connection.execute("BEGIN IMMEDIATE")
        current, completed_now = eligible(connection)
        if [item["production_id"] for item, _ in current] != [item["production_id"] for item, _ in targets] or completed_now != completed_before:
            raise RuntimeError("Production data changed after backup; no records were removed")
        for item, task_ids in current:
            remove_group(connection, item, task_ids)
        remaining, completed_after = eligible(connection)
        if remaining or completed_after != completed_before:
            raise RuntimeError("Cleanup validation failed; no changes committed")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("Foreign key validation failed; no changes committed")
        connection.commit()
        print(f"Removed {len(current)} failed production records; completed productions preserved.")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    main()
