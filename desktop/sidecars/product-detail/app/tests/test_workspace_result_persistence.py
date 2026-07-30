from __future__ import annotations

import shutil
import unittest
import uuid
from pathlib import Path
from unittest import mock

from app import BASE_DIR, STATIC_OUTPUTS, app, db
from ai_refine_v2.tests.conftest import cleanup_user
from models import User


REPO = Path(__file__).resolve().parent.parent
WORKSPACE_HTML = REPO / "templates" / "workspace.html"


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _make_authed_client(test_case: unittest.TestCase):
    username = _uid("workspace_result_user")
    client = app.test_client()
    with app.app_context():
        user = User(username=username, is_approved=True, is_paid=True)
        user.set_password("x")
        db.session.add(user)
        db.session.commit()
        uid = user.id
        test_case.addCleanup(cleanup_user, username)
    with client.session_transaction() as sess:
        sess["_user_id"] = str(uid)
    return client, uid


class TestWorkspaceAiResultPersistence(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_save_completed_ai_refine_result_and_restore_latest(self):
        client, uid = _make_authed_client(self)
        task_id = f"v2_{uuid.uuid4().hex[:10]}"
        task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "assembled.png").write_bytes(b"fake png")
        self.addCleanup(lambda: shutil.rmtree(task_dir, ignore_errors=True))

        history_file = STATIC_OUTPUTS / str(uid) / "workspace_results.json"
        self.addCleanup(lambda: history_file.unlink(missing_ok=True))

        state = {
            "task_id": task_id,
            "user_id": uid,
            "status": "success",
            "mode": "real",
            "blocks": [{"id": "hero"}, {"id": "specs"}],
            "assembled_url": f"/static/ai_refine_v2/{task_id}/assembled.png",
            "elapsed_s": 12.4,
            "cost_rmb": 3.21,
        }
        with mock.patch("ai_refine_v2.pipeline_runner.get_task_status", return_value=state):
            resp = client.post(
                f"/api/workspace-results/ai-refine-v2/{task_id}",
                json={"product_category": "设备类", "product_title": "T300"},
            )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        saved = resp.get_json()["result"]
        self.assertEqual(saved["task_id"], task_id)
        self.assertEqual(saved["image_url"], state["assembled_url"])
        self.assertEqual(saved["blocks_count"], 2)

        latest = client.get("/api/workspace-results/latest?kind=ai_refine_v2")
        self.assertEqual(latest.status_code, 200, latest.get_data(as_text=True))
        body = latest.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["result"]["task_id"], task_id)
        self.assertEqual(body["result"]["image_url"], state["assembled_url"])


class TestWorkspaceFrontendPersistenceHooks:
    def test_frontend_saves_and_restores_latest_ai_refine_result(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "rememberAiRefineResult(taskId" in content
        assert "/api/workspace-results/ai-refine-v2/" in content
        assert "restoreLatestAiResult()" in content
        assert "/api/workspace-results/latest?kind=ai_refine_v2" in content

    def test_frontend_passes_current_category_to_v2_execute(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "product_category:" in content
        assert "currentProductType" in content
