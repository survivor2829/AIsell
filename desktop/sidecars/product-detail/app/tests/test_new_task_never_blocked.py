"""A customer who asks for new pictures gets them; an earlier task never blocks that.

Field case 2026-11-03: the page stopped watching a task after ten minutes, the
customer clicked again, and was told the old task was still running.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]

CODE = r'''
import json, os, re, time
from pathlib import Path
import desktop_entry

os.environ["DEEPSEEK_API_KEY"] = "test-deepseek-key"
os.environ["REFINE_API_KEY"] = "test-apimart-key"
os.environ["REFINE_API_BASE_URL"] = "https://provider.invalid/v1"
config = desktop_entry.DesktopConfig(host="127.0.0.1", port=0, data_dir=Path(os.environ["TEST_DATA_DIR"]),
                                     bootstrap_token="bootstrap-" + "a" * 48, control_token="control-" + "b" * 48)
flask_app, _ = desktop_entry.create_desktop_application(config, shutdown_callback=lambda: None)
assert flask_app.test_client().get("/desktop/bootstrap", query_string={"token": config.bootstrap_token}).status_code == 302
with flask_app.app_context():
    user_id = __import__("app").User.query.filter_by(username="xiaoxi-desktop").one().id
client = flask_app.test_client()
with client.session_transaction() as session:
    session["_user_id"] = str(user_id)
    session["_fresh"] = True
csrf = re.search(rb'<meta name="csrf-token" content="([^"]+)"', client.get("/").data).group(1).decode()

from ai_refine_v2 import pipeline_runner
started = []
pipeline_runner.start_task = lambda **kwargs: started.append(kwargs) or f"task-{len(started)}"
pipeline_runner._apply_safety_valve = lambda deepseek, image: (deepseek, image)
pipeline_runner._detect_mode = lambda deepseek, image: "real"
tasks = {}
pipeline_runner.get_task_status = lambda tid: dict(tasks[tid]) if tid in tasks else None

def generate(title):
    response = client.post("/api/ai-refine-v2/execute", headers={"X-CSRFToken": csrf}, json={
        "product_text": "商用清洁机器人，清洁宽度500mm", "product_image_url": "https://example.invalid/p.png",
        "product_title": title, "schema_mode": "v2"})
    return response.status_code, response.get_json()

def running(tid, quiet_seconds):
    tasks[tid] = {"task_id": tid, "user_id": user_id, "status": "running_generator",
                  "updated_at": time.time() - quiet_seconds}

result = {}
result["first"] = generate("高仙S1pro")
running("task-1", quiet_seconds=10)
result["double_click"] = generate("高仙S1pro")
running("task-1", quiet_seconds=15 * 60)
result["after_stall"] = generate("高仙S1pro")
running("task-2", quiet_seconds=10)
result["other_product"] = generate("另一款产品")
tasks["task-3"] = {"task_id": "task-3", "user_id": user_id, "status": "outcome_unknown"}
result["after_unknown"] = generate("另一款产品")
result["starts"] = len(started)
archive = json.loads((config.data_dir / "database" / "desktop-ai-refine-archive.json").read_text(encoding="utf-8"))
result["archived"] = sorted(archive)
print(json.dumps(result, ensure_ascii=False))
'''


def test_new_generation_is_never_blocked_by_an_earlier_task(tmp_path):
    env = os.environ.copy()
    env.update(TEST_DATA_DIR=str(tmp_path / "data"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    for name in ("SECRET_KEY", "FLASK_ENV", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(name, None)
    completed = subprocess.run([sys.executable, "-c", CODE], cwd=APP_ROOT, env=env, capture_output=True,
                               text=True, encoding="utf-8", timeout=60, check=False)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    assert result["first"] == [200, result["first"][1]] and result["first"][1]["task_id"] == "task-1"
    # Same pictures asked twice while the first is working: show it, pay once.
    assert result["double_click"][0] == 200
    assert result["double_click"][1]["task_id"] == "task-1" and result["double_click"][1]["attached"] is True
    # A stuck task, another product, an unknown outcome: each click starts new pictures.
    assert result["after_stall"][1]["task_id"] == "task-2"
    assert result["other_product"][1]["task_id"] == "task-3"
    assert result["after_unknown"][1]["task_id"] == "task-4"
    assert result["starts"] == 4
    # Earlier tasks stay on record with their receipts.
    assert {"task-1", "task-2", "task-3"} <= set(result["archived"])
