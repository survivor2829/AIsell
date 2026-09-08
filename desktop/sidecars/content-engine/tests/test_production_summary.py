from __future__ import annotations

import json
from pathlib import Path
import sys
import sqlite3
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content_engine.database import Database
from content_engine.production_summary import ProductionSummary


class ProductionSummaryTests(unittest.TestCase):
    def setUp(self):
        self.database = Database(Path("unused-memory-fixture"))
        self.database.connection = sqlite3.connect(":memory:", isolation_level=None)
        self.database.connection.row_factory = sqlite3.Row
        self.database.connection.execute("PRAGMA foreign_keys = ON")
        self.database._apply_migrations()
        self.db = self.database.connection
        self.summary = ProductionSummary(self.db)
        self.db.execute("INSERT INTO creative_projects(id,mode,name,created_at,updated_at) VALUES('project_one','mix','shared project','2026-01-01','2026-01-01')")

    def tearDown(self):
        self.database.close()

    def task(self, identifier, kind="narrated_batch", status="completed", payload=None, date="2026-01-01", error=None):
        self.db.execute("INSERT INTO content_tasks(id,task_type,status,payload_json,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                        (identifier, kind, status, json.dumps(payload or {}), error, date, date))

    def batch(self, identifier, task_id, status="completed", archived=False, **extra):
        state = {"task_id": task_id, "status": status, "title": identifier, "candidates": [], **extra}
        if archived:
            state["_archived_at"] = "2026-02-01"
        self.db.execute("INSERT INTO narrated_batches_v1 VALUES(?,?,?,?)", (identifier, "project_one", json.dumps(state), "2026-02-01"))

    def insert_run(self, identifier, task_id, parent=None, session=None, status="completed", date="2026-02-01"):
        self.db.execute("""INSERT INTO auto_mix_runs_v2(id,project_id,task_id,parent_run_id,spec_version,input_hash,status,asset_ids_json,title,copy_framework,private_state_json,created_at,updated_at)
            VALUES(?,'project_one',?,?,'v2',?,?,'[]',?,'',?,?,?)""",
            (identifier, task_id, parent, identifier, status, identifier, json.dumps({"guided_session_id": session} if session else {}), date, date))

    def test_all_rows_are_grouped_before_pagination_and_old_failures_are_not_pending(self):
        for index in range(550):
            self.task(f"internal_{index}", "creative_analysis", "failed")
        self.task("previous", status="failed", payload={"batch_id": "done"}, date="2026-03-01")
        self.task("latest", payload={"batch_id": "done"})
        self.batch("done", "latest")
        self.task("archived_task", status="failed", payload={"batch_id": "archived"})
        self.batch("archived", "archived_task", "needs_attention", archived=True)
        for index in range(61):
            self.task(f"current_{index}", status="queued", payload={"batch_id": f"batch_{index}"})
            self.batch(f"batch_{index}", f"current_{index}", "planning")
        self.assertEqual(self.summary.summary(), {"active": 61, "needs_attention": 0, "history": 1, "archived": 1, "pending": 61, "total": 63})
        page = self.summary.list(offset=60, limit=20)
        self.assertEqual((page["total"], len(page["items"]), page["has_more"]), (61, 1, False))
        historical = self.summary.list(view="history")["items"][0]
        self.assertEqual(historical["step_count"], 2)
        self.assertIsNone(historical["error_message"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM content_tasks").fetchone()[0], 614)

    def test_explicit_run_families_stay_separate_under_the_same_project(self):
        self.task("old", "auto_mix_v2_generation", "failed", {"run_id": "run_a"})
        self.task("retry", "auto_mix_v2_regeneration", payload={"run_id": "run_a_child"}, date="2026-02-02")
        self.task("independent", "auto_mix_v2_generation", "paused", {"run_id": "run_b"})
        self.insert_run("run_a", "old", status="failed")
        self.insert_run("run_a_child", "retry", parent="run_a", date="2026-02-02")
        self.insert_run("run_b", "independent", status="needs_attention")
        self.task("legacy_a", "mix_generation", payload={"project_id": "project_one"})
        self.task("legacy_b", "mix_generation", payload={"project_id": "project_one"})
        items = self.summary.list(view="all")["items"]
        self.assertEqual(len(items), 4)
        family = next(item for item in items if item["production_id"] == "auto_mix_v2:run_a")
        self.assertEqual((family["task_id"], family["run_id"], family["category"], family["step_count"]), ("retry", "run_a_child", "history", 2))
        self.assertEqual(self.summary.summary()["pending"], 1)

    def test_narrated_progress_counts_completed_videos_not_finished_internal_tasks(self):
        self.task("review", payload={"batch_id": "batch"})
        self.db.execute("UPDATE content_tasks SET progress=1 WHERE id='review'")
        self.batch("batch", "review", "completed_with_errors", target_count=1)
        base = json.loads(self.db.execute("SELECT state_json FROM narrated_batches_v1 WHERE id='batch'").fetchone()[0])
        for target, statuses, expected, archived in (
            (1, ["failed"], 0, False),
            (2, ["completed", "failed"], 0.5, False),
            (2, ["completed", "completed"], 1, False),
            (0, ["completed"], 0, False),
            (None, ["completed"], 0, False),
            (1, ["failed"], 0, True),
        ):
            with self.subTest(target=target, statuses=statuses, archived=archived):
                batch = {**base, "target_count": target, "candidates": [{"status": status} for status in statuses]}
                if archived:
                    batch["_archived_at"] = "2026-02-01"
                self.db.execute("UPDATE narrated_batches_v1 SET state_json=? WHERE id='batch'", (json.dumps(batch),))
                production = self.summary.list(view="all")["items"][0]
                self.assertEqual(production["progress"], expected)
                self.assertEqual(production["steps"][0]["progress"], 1, "Inner task progress remains visible only as its own step")
                self.assertEqual(production["archived"], archived)
                if archived:
                    self.assertEqual(production["category"], "archived")

    def test_guided_and_batch_runs_belong_to_their_business_owner_without_private_payloads(self):
        self.task("analysis", "guided_auto_mix_analysis", "failed", {"session_id": "session"}, error="failed C:\\private\\secret.mp4")
        self.task("draft", "guided_auto_mix_draft", payload={"session_id": "session"})
        self.db.execute("""INSERT INTO guided_auto_mix_sessions_v1(id,analysis_task_id,draft_task_id,status,asset_ids_json,asset_snapshot_json,analysis_profile_json,created_at,updated_at)
                          VALUES('session','analysis','draft','ready_for_render','[]','[]','{}','2026-01-01','2026-02-01')""")
        self.task("render", "auto_mix_v2_generation", payload={"run_id": "guided_run"})
        self.insert_run("guided_run", "render", session="session")
        self.task("batch_render", payload={"batch_id": "batch"})
        self.insert_run("batch_run", "batch_render")
        self.batch("batch", "batch_render", candidates=[{"_run_id": "batch_run"}])
        result = self.summary.list(view="all")
        self.assertEqual(result["total"], 2)
        self.assertEqual({item["kind"] for item in result["items"]}, {"guided_session", "narrated_batch"})
        guided = next(item for item in result["items"] if item["session_id"])
        self.assertEqual((guided["run_id"], guided["task_id"], guided["category"]), ("guided_run", "render", "history"))
        encoded = json.dumps(result)
        self.assertNotIn("payload_json", encoded)
        self.assertNotIn("private_state_json", encoded)
        self.assertNotIn("secret.mp4", encoded)
        # A later draft attempt is current work, not the previous completed video.
        self.db.execute("UPDATE guided_auto_mix_sessions_v1 SET status='failed',updated_at='2026-03-01' WHERE id='session'")
        self.db.execute("UPDATE content_tasks SET status='failed',updated_at='2026-03-01' WHERE id='draft'")
        pending = self.summary.list()["items"][0]
        self.assertEqual((pending["task_id"], pending["run_id"], pending["category"]), ("draft", None, "needs_attention"))


if __name__ == "__main__":
    unittest.main()
