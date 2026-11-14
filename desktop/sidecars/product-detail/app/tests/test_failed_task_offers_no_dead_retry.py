"""A failed task is archived at once, so the page must not offer a retry that recovery refuses.

Field case 2026-11-14: a 工具类 plan failed, the page said 已完成的部分都保存着、点重试接着做,
and the retry came back 旧任务已归档.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from test_new_task_never_blocked import APP_ROOT, CODE as SETUP

SETUP = SETUP.split("result = {}")[0]
CODE = SETUP + r'''
result = {"start": generate("拾物器")}
tasks["task-1"] = {"task_id": "task-1", "user_id": user_id, "status": "failed",
                   "can_replay_planner": True, "error": "视觉策划未通过"}
from flask import jsonify
flask_app.view_functions["ai_refine_v2_status"] = lambda task_id: jsonify(pipeline_runner.get_task_status(task_id))
first = client.get("/api/ai-refine-v2/status/task-1").get_json()
second = client.get("/api/ai-refine-v2/status/task-1").get_json()
retry = client.post("/api/ai-refine-v2/recover/task-1", headers={"X-CSRFToken": csrf}, json={})
result.update(first=first, second=second, retry=[retry.status_code, retry.get_json()])
print(json.dumps(result, ensure_ascii=False))
'''


def test_failed_task_status_offers_no_retry_that_recovery_refuses(tmp_path):
    env = os.environ.copy()
    env.update(TEST_DATA_DIR=str(tmp_path / "data"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    for name in ("SECRET_KEY", "FLASK_ENV", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(name, None)
    completed = subprocess.run([sys.executable, "-c", CODE], cwd=APP_ROOT, env=env, capture_output=True,
                               text=True, encoding="utf-8", timeout=60, check=False)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    assert result["start"][1]["task_id"] == "task-1"
    first = result["first"]
    # The page must still show the real failure, not "旧任务已归档".
    assert first["status"] == "failed" and "archived" not in first and first["error"] == "视觉策划未通过"
    assert first["can_replay_planner"] is False, "no retry button for a task recovery refuses"
    assert result["second"]["archived"] is True
    assert result["retry"][0] == 409 and result["retry"][1]["code"] == "DESKTOP_AI_REFINE_TASK_ARCHIVED"
