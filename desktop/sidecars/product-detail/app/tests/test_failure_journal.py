"""A failed product-detail generation leaves a journal line the desktop can report."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]


def _lines(data_dir: Path) -> list[dict]:
    file = data_dir / "logs" / "failures.jsonl"
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines()] if file.exists() else []


def test_a_failed_refine_task_is_journaled(tmp_path, monkeypatch):
    monkeypatch.setenv("XIAOXI_PRODUCT_DETAIL_DATA_DIR", str(tmp_path))
    from ai_refine_v2 import pipeline_runner
    task_id = "refine_journal_test"
    pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(task_id=task_id)
    task_dir = tmp_path / task_id
    task_dir.mkdir()
    error = RuntimeError("生图通道未连通")
    error.code = "reference_upload"
    error.stage = "reference_upload"
    try:
        raise error
    except RuntimeError as exc:
        pipeline_runner._record_worker_exception(task_id, task_dir, exc, log_prefix="pipeline_v2")
    [entry] = _lines(tmp_path)
    assert entry["where"] == "refine:pipeline_v2"
    assert entry["code"] == "reference_upload"
    assert entry["task_id"] == task_id
    assert entry["context"] == {"status": "failed", "stage": "reference_upload"}
    assert "生图通道未连通" in entry["traceback"]


def test_server_faults_are_journaled_once_and_ordinary_pages_are_not(tmp_path):
    code = r"""
import os
from pathlib import Path
from flask import jsonify
import desktop_entry

config = desktop_entry.DesktopConfig(host="127.0.0.1", port=0, data_dir=Path(os.environ["TEST_DATA_DIR"]),
                                     bootstrap_token="b" * 48, control_token="c" * 48)
flask_app, _ = desktop_entry.create_desktop_application(config, shutdown_callback=lambda: None)
flask_app.config["PROPAGATE_EXCEPTIONS"] = False

@flask_app.route("/__test_boom")
def boom():
    raise ValueError("boom in route")

@flask_app.route("/__test_unavailable")
def unavailable():
    return jsonify({"ok": False, "code": "gateway_down", "error": "网关不可用"}), 503

client = flask_app.test_client()
print(client.get("/__test_boom").status_code, client.get("/__test_unavailable").status_code,
      client.get("/internal/health").status_code)
"""
    env = os.environ.copy()
    env.update(TEST_DATA_DIR=str(tmp_path / "data"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    for name in ("DEEPSEEK_API_KEY", "REFINE_API_KEY", "GPT_IMAGE_API_KEY", "SECRET_KEY", "FLASK_ENV"):
        env.pop(name, None)
    completed = subprocess.run([sys.executable, "-c", code], cwd=APP_ROOT, env=env, capture_output=True,
                               text=True, encoding="utf-8", timeout=60, check=False)
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.split()[:2] == ["500", "503"]
    entries = _lines(tmp_path / "data")
    by_where = {entry["where"]: entry for entry in entries}
    assert len(entries) == 2, entries
    assert "boom in route" in by_where["request:boom"]["traceback"], "the exception keeps its traceback"
    assert by_where["request:unavailable"]["code"] == "gateway_down"
    assert by_where["request:unavailable"]["message"] == "网关不可用"
