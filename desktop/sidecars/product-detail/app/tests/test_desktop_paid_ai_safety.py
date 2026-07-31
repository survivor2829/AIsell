from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
ENTRY = APP_ROOT / "desktop_entry.py"


def test_paid_ai_ledger_is_fail_closed_atomic_and_preserves_poll_shape(tmp_path):
    data_dir = tmp_path / "desktop-paid-ai"
    code = r'''
import json
import os
import re
import threading
from pathlib import Path

import desktop_entry

os.environ["DEEPSEEK_API_KEY"] = "test-deepseek-key"
os.environ["REFINE_API_KEY"] = "test-apimart-key"
os.environ["REFINE_API_BASE_URL"] = "https://provider.invalid/v1"
config = desktop_entry.DesktopConfig(
    host="127.0.0.1",
    port=0,
    data_dir=Path(os.environ["TEST_DATA_DIR"]),
    bootstrap_token="bootstrap-" + "a" * 48,
    control_token="control-" + "b" * 48,
)
flask_app, _ = desktop_entry.create_desktop_application(
    config,
    shutdown_callback=lambda: None,
)
flask_app.config["PROPAGATE_EXCEPTIONS"] = False
bootstrap_client = flask_app.test_client()
bootstrap = bootstrap_client.get(
    "/desktop/bootstrap",
    query_string={"token": config.bootstrap_token},
)
assert bootstrap.status_code == 302

app_module = __import__("app")
with flask_app.app_context():
    user = app_module.User.query.filter_by(username="xiaoxi-desktop").one()
    user_id = user.id


def authenticated_client():
    client = flask_app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = str(user_id)
        session["_fresh"] = True
    body = client.get("/").data
    match = re.search(rb'<meta name="csrf-token" content="([^"]+)"', body)
    assert match is not None
    return client, match.group(1).decode("utf-8")


def post(client, token, path, payload):
    return client.post(
        path,
        json=payload,
        headers={"X-CSRFToken": token},
    )


def confirmation_token(client):
    response = client.get("/desktop/ai-refine-v2/estimate")
    assert response.status_code == 200, response.data
    token = response.get_json().get("confirmation_token")
    assert token
    return token


client_one, csrf_one = authenticated_client()
client_two, csrf_two = authenticated_client()
ledger_path = config.data_dir / "database" / "desktop-ai-refine-ledger.json"
from ai_refine_v2 import pipeline_runner

start_calls = []
pipeline_runner.start_task = lambda **kwargs: start_calls.append(kwargs) or "must-not-start"
pipeline_runner._apply_safety_valve = lambda deepseek, image: (deepseek, image)
pipeline_runner._detect_mode = lambda deepseek, image: "real"
payload = {
    "product_text": "测试商品参数",
    "product_image_url": "https://example.invalid/product.png",
    "product_title": "测试商品",
    "schema_mode": "v2",
}

# Corrupt/unreadable ledgers fail closed. They never silently become an empty ledger.
ledger_path.parent.mkdir(parents=True, exist_ok=True)
ledger_path.write_text("{broken", encoding="utf-8")
corrupt = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert corrupt.status_code == 409, corrupt.data
assert corrupt.get_json()["code"] == "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
assert start_calls == []
resolved = post(
    client_one,
    csrf_one,
    "/desktop/ai-refine-v2/resolve-unknown",
    {"confirm_new_task": True},
)
assert resolved.status_code == 200, resolved.data

missing_confirmation = post(
    client_one, csrf_one, "/api/ai-refine-v2/execute", payload
)
assert missing_confirmation.status_code == 428, missing_confirmation.data
assert (
    missing_confirmation.get_json()["code"]
    == "DESKTOP_AI_REFINE_CONFIRMATION_REQUIRED"
)
assert start_calls == []

payload_one = {
    **payload,
    "confirmation_token": confirmation_token(client_one),
}
payload_two = {
    **payload,
    "confirmation_token": confirmation_token(client_two),
}

# The check + pending write is atomic: while request one is admitted, request two is blocked.
entered = threading.Event()
release = threading.Event()

def slow_start(**kwargs):
    start_calls.append(kwargs)
    entered.set()
    assert release.wait(5)
    return "task-atomic-1"

pipeline_runner.start_task = slow_start
first_result = {}

def run_first():
    first_result["response"] = post(
        client_one, csrf_one, "/api/ai-refine-v2/execute", payload_one
    )

thread = threading.Thread(target=run_first)
thread.start()
assert entered.wait(5)
second = post(client_two, csrf_two, "/api/ai-refine-v2/execute", payload_two)
assert second.status_code == 409, second.data
assert second.get_json()["code"] == "DESKTOP_AI_REFINE_ALREADY_RUNNING"
release.set()
thread.join(5)
assert not thread.is_alive()
first = first_result["response"]
assert first.status_code == 200, first.data
assert first.get_json()["task_id"] == "task-atomic-1"
assert len(start_calls) == 1

# Poll responses keep task_id/status at the top level and terminal status closes the ledger.
def running_state(task_id):
    return {
        "task_id": task_id,
        "user_id": user_id,
        "status": "running_generator",
        "progress_pct": 50,
    }

pipeline_runner.get_task_status = running_state
poll = client_one.get("/api/ai-refine-v2/status/task-atomic-1")
assert poll.status_code == 200, poll.data
assert poll.get_json()["task_id"] == "task-atomic-1"
assert poll.get_json()["status"] == "running_generator"

pipeline_runner.get_task_status = lambda task_id: {
    "task_id": task_id,
    "user_id": user_id,
    "status": "outcome_unknown",
    "progress_pct": 50,
    "error": "provider outcome unknown",
}
unknown_poll = client_one.get("/api/ai-refine-v2/status/task-atomic-1")
assert unknown_poll.status_code == 200, unknown_poll.data
assert unknown_poll.get_json()["task_id"] == "task-atomic-1"
assert unknown_poll.get_json()["status"] == "outcome_unknown"
assert json.loads(ledger_path.read_text(encoding="utf-8"))["state"] == "outcome_unknown"
resolved_again = post(
    client_one,
    csrf_one,
    "/desktop/ai-refine-v2/resolve-unknown",
    {"confirm_new_task": True},
)
assert resolved_again.status_code == 200, resolved_again.data

replayed = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload_one)
assert replayed.status_code == 428, replayed.data
assert replayed.get_json()["code"] == "DESKTOP_AI_REFINE_CONFIRMATION_REQUIRED"
assert len(start_calls) == 1

# A server failure after admission is outcome_unknown, never safe-to-retry.
server_calls = []
def crash_after_admission(**kwargs):
    server_calls.append(kwargs)
    raise RuntimeError("synthetic post-admission failure")

pipeline_runner.start_task = crash_after_admission
crash_payload = {
    **payload,
    "confirmation_token": confirmation_token(client_one),
}
failed = post(client_one, csrf_one, "/api/ai-refine-v2/execute", crash_payload)
assert failed.status_code == 500, failed.data
ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
assert ledger["state"] == "outcome_unknown"
assert ledger["reason"] == "server_error_after_admission"
blocked = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert blocked.status_code == 409, blocked.data
assert blocked.get_json()["code"] == "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
assert len(server_calls) == 1

print(json.dumps({
    "corrupt": corrupt.status_code,
    "missing_confirmation": missing_confirmation.status_code,
    "concurrent": second.status_code,
    "replay": replayed.status_code,
    "poll_task_id": poll.get_json()["task_id"],
    "poll_status": poll.get_json()["status"],
    "post_admission": failed.status_code,
    "final_ledger": ledger["state"],
}))
'''
    env = os.environ.copy()
    env.update(
        {
            "TEST_DATA_DIR": str(data_dir),
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "HTTP_PROXY": "",
            "HTTPS_PROXY": "",
            "ALL_PROXY": "",
            "http_proxy": "",
            "https_proxy": "",
            "all_proxy": "",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=APP_ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.strip().splitlines()[-1])
    assert result == {
        "corrupt": 409,
        "missing_confirmation": 428,
        "concurrent": 409,
        "replay": 428,
        "poll_task_id": "task-atomic-1",
        "poll_status": "running_generator",
        "post_admission": 500,
        "final_ledger": "outcome_unknown",
    }
