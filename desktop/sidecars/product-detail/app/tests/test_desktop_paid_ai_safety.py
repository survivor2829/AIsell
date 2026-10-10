from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
ENTRY = APP_ROOT / "desktop_entry.py"


def test_unknown_archive_preserves_new_inputs_and_survives_process_and_port_change(tmp_path):
    code = r'''
import hashlib
import json
import os
import shutil
import threading
from pathlib import Path
from urllib.parse import urlsplit
from PIL import Image
from playwright.sync_api import sync_playwright, expect
from werkzeug.serving import make_server
import desktop_entry

os.environ["DEEPSEEK_API_KEY"] = "test-only"
os.environ["REFINE_API_KEY"] = "test-only"
os.environ["REFINE_API_BASE_URL"] = "https://provider.invalid/v1"
root = Path(os.environ["TEST_DATA_DIR"])
config = desktop_entry.DesktopConfig(host="127.0.0.1", port=0, data_dir=root,
    bootstrap_token="bootstrap-" + "a" * 48, control_token="control-" + "b" * 48)
app, _ = desktop_entry.create_desktop_application(config, shutdown_callback=lambda: None)
# This harness visits the workbench directly rather than Electron's file:// iframe.
app.config.update(SESSION_COOKIE_SECURE=False, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_PARTITIONED=False)
client = app.test_client()
client.get("/desktop/bootstrap", query_string={"token": config.bootstrap_token})
from ai_refine_v2 import pipeline_runner
from app import User
with app.app_context():
    uid = User.query.filter_by(username="xiaoxi-desktop").one().id
task_id = "old-unknown"
task_dir = pipeline_runner._OUTPUT_BASE / task_id
ledger = root / "database" / "desktop-ai-refine-ledger.json"
phase = os.environ["TEST_PHASE"]
if phase == "archive":
    task_dir.mkdir(parents=True, exist_ok=True)
    source = os.environ.get("REFINE_REPRO_TASK_DIR")
    if source:
        for name in ("_input.json", "_recovery.json", "_costs.json"):
            shutil.copyfile(Path(source) / name, task_dir / name)
    else:
        (task_dir / "_input.json").write_text(json.dumps({"user_id": uid,
            "product_title": "旧产品", "product_text": "旧资料"}), encoding="utf-8")
        (task_dir / "_recovery.json").write_text(json.dumps({"user_id": uid,
            "status": "outcome_unknown", "error": "提交响应不明且没有 provider_task_id",
            "blocks": [], "planned_count": 13}), encoding="utf-8")
        (task_dir / "_costs.json").write_text(json.dumps({"operations": {
            "image:1": {"status": "outcome_unknown", "reserved_cny": 0.14}}}), encoding="utf-8")
    ledger.write_text(json.dumps({"state": "outcome_unknown", "task_id": task_id}), encoding="utf-8")
before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in task_dir.iterdir()}
starts = []
pipeline_runner._apply_safety_valve = lambda a, b: (a, b)
pipeline_runner._detect_mode = lambda a, b: "real"
pipeline_runner.start_task = lambda **kwargs: starts.append(kwargs) or "new-confirmed-task"
original_status = pipeline_runner.get_task_status
pipeline_runner.get_task_status = lambda tid: ({"task_id": tid, "user_id": uid,
    "status": "failed", "error": "test stops before any provider call"}
    if tid == "new-confirmed-task" else original_status(tid))
server = make_server("127.0.0.1", 0, app, threaded=True)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = f"http://127.0.0.1:{server.server_port}"
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=os.environ.get("XIAOXI_PRODUCT_DETAIL_BROWSER_PATH") or None)
    context = browser.new_context(viewport={"width": 1400, "height": 1000})
    cookie_name = app.config["SESSION_COOKIE_NAME"]
    context.add_cookies([{"name": cookie_name, "value": client.get_cookie(cookie_name).value,
                         "url": origin}])
    context.route("**/*", lambda route: route.continue_() if
        urlsplit(route.request.url).hostname in ("127.0.0.1", "localhost") else route.abort())
    if phase == "restart":
        context.add_init_script("localStorage.setItem('xiaoxi.ai-refine-v2.active-task.v1', "
            "JSON.stringify({task_id:'old-unknown',status:'outcome_unknown'}));")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(origin + "/")
    if phase == "archive":
        expect(page.get_by_role("button", name="核对后归档并解除阻塞")).to_be_visible()
    else:
        assert "new-confirmed-task" not in page.locator("#ai_img_results").inner_text()
        assert page.evaluate("loadPersistedAiRefineTask()") is None
        assert not page.get_by_role("button", name="核对后归档并解除阻塞").count()
    page.locator("#product_title_input").fill("全新产品")
    page.locator("#text_input").fill("全新产品资料，清洁宽度500mm")
    image = root / "new-product.png"
    Image.new("RGB", (40, 40), "green").save(image)
    page.locator('#upload_product input[type="file"]').set_input_files(str(image))
    page.wait_for_function("productImageUrl !== ''")
    image_url = page.evaluate("productImageUrl")
    page.locator("#btn_ai_html_v2").click()
    page.get_by_role("button", name="开始付费生成", exact=True).click()
    if phase == "archive":
        expect(page.locator("#ai_img_results")).to_contain_text("新任务尚未提交")
        expect(page.locator("#ai_img_results")).to_contain_text(task_id)
        old_title = json.loads((task_dir / "_input.json").read_text(encoding="utf-8"))["product_title"]
        expect(page.locator("#ai_img_results")).to_contain_text(old_title)
        assert starts == []
        page.screenshot(path=str(root / "blocked.png"))
        page.get_by_role("button", name="核对后归档并解除阻塞").click()
        page.screenshot(path=str(root / "confirmation.png"))
        page.get_by_role("button", name="我已核对，归档并解除阻塞", exact=True).click()
        expect(page.locator("#ai_img_results")).to_contain_text("旧任务已归档")
        assert starts == []
        assert page.evaluate("productImageUrl") == image_url
        expect(page.locator("#product_title_input")).to_have_value("全新产品")
        expect(page.locator("#text_input")).to_have_value("全新产品资料，清洁宽度500mm")
        page.screenshot(path=str(root / "archived.png"))
    else:
        expect(page.locator("#ai_img_results")).to_contain_text("AI 精修没有完成")
        assert len(starts) == 1
        assert starts[0]["product_title"] == "全新产品"
        assert starts[0]["product_text"] == "全新产品资料，清洁宽度500mm"
    assert not errors, errors
    browser.close()
server.shutdown()
assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in task_dir.iterdir()}
archive = json.loads(ledger.with_name("desktop-ai-refine-archive.json").read_text(encoding="utf-8"))
assert archive[task_id]["state"] == "outcome_unknown"
print(json.dumps({"phase": phase, "port": server.server_port, "starts": len(starts)}))
'''
    results = []
    for phase in ("archive", "restart"):
        completed = subprocess.run(
            [sys.executable, "-c", code], cwd=APP_ROOT,
            env={**os.environ, "TEST_DATA_DIR": str(tmp_path), "TEST_PHASE": phase,
                 "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, encoding="utf-8", timeout=90,
        )
        assert completed.returncode == 0, completed.stderr
        results.append(json.loads(completed.stdout.strip().splitlines()[-1]))
    assert results[0]["starts"] == 0 and results[1]["starts"] == 1
    assert results[0]["port"] != results[1]["port"]


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

payload_one = dict(payload)
payload_two = dict(payload)

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

# If the sidecar loses task files after recording this exact unknown task, status
# must enter the existing manual APIMart verification flow. A different/missing
# task remains an ordinary 404 and can never unlock the ledger.
pipeline_runner.get_task_status = lambda task_id: None
lost_unknown = client_one.get("/api/ai-refine-v2/status/task-atomic-1")
assert lost_unknown.status_code == 409, lost_unknown.data
assert lost_unknown.get_json()["code"] == "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
assert lost_unknown.get_json()["task_id"] == "task-atomic-1"
ordinary_missing = client_one.get("/api/ai-refine-v2/status/task-not-in-ledger")
assert ordinary_missing.status_code == 404, ordinary_missing.data
assert ordinary_missing.get_json().get("code") != "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
blocked_unknown = post(
    client_one, csrf_one, "/api/ai-refine-v2/execute", payload
)
assert blocked_unknown.status_code == 409, blocked_unknown.data
assert blocked_unknown.get_json()["code"] == "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
assert len(start_calls) == 1
stale_resolve = post(client_one, csrf_one, "/desktop/ai-refine-v2/resolve-unknown",
                     {"confirm_new_task": True, "task_id": "different-old-task"})
assert stale_resolve.status_code == 409
resolved_again = post(
    client_one,
    csrf_one,
    "/desktop/ai-refine-v2/resolve-unknown",
    {"confirm_new_task": True, "task_id": "task-atomic-1"},
)
assert resolved_again.status_code == 200, resolved_again.data
archive_path = ledger_path.with_name("desktop-ai-refine-archive.json")
archive = json.loads(archive_path.read_text(encoding="utf-8"))
assert archive["task-atomic-1"]["state"] == "outcome_unknown"
assert len(start_calls) == 1  # Archiving never starts a paid request.
pipeline_runner.get_task_status = lambda task_id: {"task_id": task_id,
    "user_id": user_id, "status": "outcome_unknown"}
archived_poll = client_one.get("/api/ai-refine-v2/status/task-atomic-1")
assert archived_poll.get_json()["archived"] is True
assert json.loads(ledger_path.read_text(encoding="utf-8"))["state"] == "resolved_unknown"
archived_recover = post(client_one, csrf_one, "/api/ai-refine-v2/recover/task-atomic-1", {})
assert archived_recover.status_code == 409
pipeline_runner.get_task_status = lambda task_id: None
resolved_missing = client_one.get("/api/ai-refine-v2/status/task-atomic-1")
assert resolved_missing.status_code == 404, resolved_missing.data
assert resolved_missing.get_json().get("code") != "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"

pipeline_runner.start_task = lambda **kwargs: start_calls.append(kwargs) or "task-direct-2"
direct_after_resolve = post(
    client_one, csrf_one, "/api/ai-refine-v2/execute", payload
)
assert direct_after_resolve.status_code == 200, direct_after_resolve.data
assert direct_after_resolve.get_json()["task_id"] == "task-direct-2"
assert len(start_calls) == 2

pipeline_runner.get_task_status = lambda task_id: {
    "task_id": task_id,
    "user_id": user_id,
    "status": "failed",
    "progress_pct": 100,
    "error": "synthetic completed failure",
}
closed = client_one.get("/api/ai-refine-v2/status/task-direct-2")
assert closed.status_code == 200, closed.data
assert closed.get_json()["status"] == "failed"
assert json.loads(archive_path.read_text(encoding="utf-8"))["task-direct-2"]["state"] == "failed"

# Partial success is terminal: it closes pending so a later confirmed job is admissible.
pipeline_runner.start_task = lambda **kwargs: start_calls.append(kwargs) or "task-partial-3"
partial_started = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert partial_started.status_code == 200, partial_started.data
pipeline_runner.get_task_status = lambda task_id: {
    "task_id": task_id,
    "user_id": user_id,
    "status": "partial_success",
    "progress_pct": 100,
    "planned_count": 10,
    "success_count": 8,
    "failed_count": 2,
    "assembled_url": f"/static/ai_refine_v2/{task_id}/assembled.png",
}
partial_poll = client_one.get("/api/ai-refine-v2/status/task-partial-3")
assert partial_poll.status_code == 200, partial_poll.data
assert partial_poll.get_json()["status"] == "partial_success"
assert json.loads(ledger_path.read_text(encoding="utf-8"))["state"] == "partial_success"

# A server failure after admission is outcome_unknown, never safe-to-retry.
server_calls = []
def crash_after_admission(**kwargs):
    server_calls.append(kwargs)
    raise RuntimeError("synthetic post-admission failure")

pipeline_runner.start_task = crash_after_admission
failed = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert failed.status_code == 500, failed.data
ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
assert ledger["state"] == "outcome_unknown"
assert ledger["reason"] == "server_error_after_admission"
blocked = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert blocked.status_code == 409, blocked.data
assert blocked.get_json()["code"] == "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN"
assert len(server_calls) == 1

# Recovery-required keeps the original paid task locked and never starts a replacement.
resolved_after_crash = post(
    client_one,
    csrf_one,
    "/desktop/ai-refine-v2/resolve-unknown",
    {"confirm_new_task": True},
)
assert resolved_after_crash.status_code == 200, resolved_after_crash.data
pipeline_runner.start_task = lambda **kwargs: start_calls.append(kwargs) or "task-recovery-4"
recovery_started = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert recovery_started.status_code == 200, recovery_started.data
pipeline_runner.get_task_status = lambda task_id: {
    "task_id": task_id,
    "user_id": user_id,
    "status": "recovery_required",
    "progress_pct": 90,
    "planned_count": 10,
    "success_count": 8,
    "failed_count": 2,
    "error": "synthetic local assembly failure",
    "raw_urls": ["https://provider.invalid/result-1.png"],
}
recovery_poll = client_one.get("/api/ai-refine-v2/status/task-recovery-4")
assert recovery_poll.status_code == 200, recovery_poll.data
assert recovery_poll.get_json()["status"] == "recovery_required"
blocked_recovery = post(
    client_one, csrf_one, "/api/ai-refine-v2/execute", payload
)
assert blocked_recovery.status_code == 409, blocked_recovery.data
assert blocked_recovery.get_json()["task_id"] == "task-recovery-4"
assert len(start_calls) == 4

# A preserved unpriced plan blocks replacement orders; its existing recovery
# endpoint resumes the same task. Once resumed, update quiescence sees it busy.
current_pricing_state = {"task_id": "task-recovery-4", "user_id": user_id,
                         "status": "pricing_required", "error": "quote unavailable"}
pipeline_runner.get_task_status = lambda task_id: dict(current_pricing_state)
pricing_poll = client_one.get("/api/ai-refine-v2/status/task-recovery-4")
assert pricing_poll.status_code == 200 and pricing_poll.get_json()["status"] == "pricing_required"
blocked_pricing = post(client_one, csrf_one, "/api/ai-refine-v2/execute", payload)
assert blocked_pricing.status_code == 409
assert len(start_calls) == 4
resumes = []
def resume_pricing(task_id, image_key, planner_key):
    resumes.append(task_id)
    current_pricing_state["status"] = "running_generator"
    return dict(current_pricing_state)
pipeline_runner.start_task_recovery = resume_pricing
continued = post(client_one, csrf_one, "/api/ai-refine-v2/recover/task-recovery-4", {})
assert continued.status_code == 202 and resumes == ["task-recovery-4"]
updating = client_one.post("/internal/update-state", json={"hold": False},
                          headers={"x-xiaoxi-control-token": config.control_token})
assert updating.status_code == 200 and updating.get_json()["busy"] is True

print(json.dumps({
    "corrupt": corrupt.status_code,
    "concurrent": second.status_code,
    "blocked_unknown": blocked_unknown.status_code,
    "direct_after_resolve": direct_after_resolve.status_code,
    "poll_task_id": poll.get_json()["task_id"],
    "poll_status": poll.get_json()["status"],
    "lost_unknown": lost_unknown.status_code,
    "ordinary_missing": ordinary_missing.status_code,
    "partial_status": partial_poll.get_json()["status"],
    "partial_ledger": "partial_success",
    "post_admission": failed.status_code,
    "recovery_status": recovery_poll.get_json()["status"],
    "recovery_blocked": blocked_recovery.status_code,
    "recovery_task_id": blocked_recovery.get_json()["task_id"],
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
        "concurrent": 409,
        "blocked_unknown": 409,
        "direct_after_resolve": 200,
        "poll_task_id": "task-atomic-1",
        "poll_status": "running_generator",
        "lost_unknown": 409,
        "ordinary_missing": 404,
        "partial_status": "partial_success",
        "partial_ledger": "partial_success",
        "post_admission": 500,
        "recovery_status": "recovery_required",
        "recovery_blocked": 409,
        "recovery_task_id": "task-recovery-4",
    }
