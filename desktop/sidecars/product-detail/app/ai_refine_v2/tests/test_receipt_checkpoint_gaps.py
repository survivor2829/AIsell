"""Process exits between journal and pipeline writes must not lose paid work."""
from types import SimpleNamespace
from unittest.mock import Mock
import io
import json
import urllib.error

import pytest
from PIL import Image

from ai_refine_v2 import pipeline_runner as runner, pricing, refine_planner
from ai_refine_v2.tests.test_product_driven_planning import TEXT, sample, response
from ai_refine_v2.tests.test_pricing_boundary import quote


@pytest.fixture
def task(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(runner, "_TASKS", {})
    monkeypatch.setattr(runner, "_RECOVERY_TASK_IDS", set())
    monkeypatch.setenv("V2_ALLOW_REAL_API", "true")
    directory = tmp_path / "interrupted"
    directory.mkdir()
    runner._atomic_write_json(directory / "_input.json", {
        "product_text": TEXT, "product_title": "清洁机器人", "product_image_url": "",
        "schema_mode": "v2", "user_id": 73,
    })
    return directory


@pytest.mark.parametrize("saved", ["response", "response_before_finish", "plan"])
def test_resume_paid_planner_without_rebuying_or_losing_owner(task, monkeypatch, saved):
    import ai_image_apimart as adapter
    upload = Mock(side_effect=AssertionError("existing paid task must not preflight/upload again"))
    monkeypatch.setattr(adapter, "upload_data_url", upload)
    monkeypatch.setattr(runner.threading, "Thread", lambda *, target, args, **kw:
                        SimpleNamespace(start=lambda: target(*args)))
    ledger = pricing.CostJournal(task)
    ledger.begin("planner", quote(), .03)
    runner._atomic_write_json(task / ("_planning.json" if saved == "plan" else "_planner_response.json"),
                              sample() if saved == "plan" else response(sample()))
    if saved != "response_before_finish":
        ledger.finish("planner", "completed")
    remote = Mock(side_effect=AssertionError("must not purchase planner again"))
    monkeypatch.setattr(refine_planner, "_http_post_deepseek", remote)
    images = Mock(side_effect=pricing.PricingRequired("image quote unavailable"))
    monkeypatch.setattr(runner, "_run_real_generator_v2", images)
    assert runner.get_task_status(task.name)["user_id"] == 73
    # Exercise the actual endpoint: outcome_unknown supplies no planner key.
    import app as application
    monkeypatch.setattr(application, "current_user", SimpleNamespace(id=73, is_admin=False))
    monkeypatch.setattr(application, "_get_gpt_image_key", lambda user: ("image-key", "fixture"))
    planner_key = Mock(side_effect=AssertionError("saved response needs no planner credentials"))
    monkeypatch.setattr(application, "_get_deepseek_key", planner_key)
    with application.app.test_request_context(method="POST"):
        _, status = application.ai_refine_v2_recover.__wrapped__(task.name)
    assert status == 202
    planner_key.assert_not_called()
    state = runner.get_task_status(task.name)
    assert state["status"] == "pricing_required"
    assert state["mode"] == "real"
    assert state["user_id"] == 73
    assert images.call_count == 1
    assert images.call_args.args[0]["screens"] == sample()["screens"]
    remote.assert_not_called()
    assert list(ledger.load()["operations"]) == ["planner"]
    upload.assert_not_called()


@pytest.mark.parametrize("schema", ["v1", "v2"])
@pytest.mark.parametrize("paid", [True, False])
def test_saved_plan_mode_tracks_receipt_not_current_planner_key(task, monkeypatch, schema, paid):
    plan = sample() if schema == "v2" else {"product_meta": {"name": "产品"}, "planning": {"block_order": ["hero"]}}
    runner._atomic_write_json(task / "_planning.json", plan)
    if paid:
        ledger = pricing.CostJournal(task)
        ledger.begin("planner", quote(), .03)
        ledger.finish("planner", "completed")
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73)
    remote = Mock(side_effect=AssertionError("saved plan must not repurchase planner"))
    monkeypatch.setattr(refine_planner, "_http_post_deepseek", remote)
    count = len(plan.get("screens") or ["hero"])
    blocks = [{"block_id": str(i), "success": True, "raw_url": "https://example.invalid/image.jpg"} for i in range(count)]
    def assemble(directory, *_):
        Image.effect_noise((600, 800), 40).convert("RGB").save(directory / "assembled.png")
        return "/static/ai_refine_v2/interrupted/assembled.png"
    monkeypatch.setattr(runner, "_run_real_generator_v2" if schema == "v2" else "_run_real_generator", lambda *_: (blocks, .3))
    monkeypatch.setattr(runner, "_run_assembler_v2" if schema == "v2" else "_run_assembler", assemble)
    # A cached mock plan remains mock even if a planner key becomes available later.
    runner._worker(task.name, TEXT, "", "产品", "" if paid else "planner-key", "image-key", mode=schema)
    state = runner.get_task_status(task.name)
    assert state["status"] == "success", state.get("error")
    assert state["mode"] == ("real" if paid else "partial-mock")
    assert runner._read_json(task / "_summary.json")["mode"] == state["mode"]
    remote.assert_not_called()


def test_recover_endpoint_still_rejects_another_owner(task, monkeypatch):
    import app as application
    from werkzeug.exceptions import Forbidden
    pricing.CostJournal(task).begin("planner", quote(), .03)
    runner._atomic_write_json(task / "_planner_response.json", response(sample()))
    monkeypatch.setattr(application, "current_user", SimpleNamespace(id=74, is_admin=False))
    recover = Mock()
    monkeypatch.setattr(runner, "start_task_recovery", recover)
    with application.app.test_request_context(method="POST"), pytest.raises(Forbidden):
        application.ai_refine_v2_recover.__wrapped__(task.name)
    recover.assert_not_called()


def test_reference_upload_503_stays_known_unsubmitted_after_restart(task, monkeypatch):
    import ai_image_apimart as adapter
    monkeypatch.setenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "https://gateway.invalid")
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://gateway.invalid/v1/provider-gateway/apimart")
    monkeypatch.setattr("pricing_config.MAX_REFINE_COST_PER_RUN", 30)
    monkeypatch.setattr(pricing, "read_quote", lambda **kw: quote())
    monkeypatch.setattr(adapter.time, "sleep", lambda _: None)
    monkeypatch.setattr(adapter, "_http_post_image_upload", lambda *a, **kw: (503, {"error": "provider_unavailable"}))
    post = Mock(side_effect=AssertionError("upload failed: generation must never be submitted"))
    monkeypatch.setattr(adapter, "_http_post_json", post)
    with adapter._UPLOAD_CACHE_LOCK:
        adapter._UPLOAD_CACHE.clear()
    runner._atomic_write_json(task / "_planning.json", sample())
    ledger = pricing.CostJournal(task)
    ledger.begin("planner", quote(), .03)
    ledger.finish("planner", "completed")
    reference = task / "reference.png"
    Image.new("RGB", (80, 80), "#78ab12").save(reference)
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73)
    runner._worker_v2(task.name, TEXT, str(reference), "产品", "", "image-key")
    assert runner.get_task_status(task.name)["status"] == "failed"
    runner._TASKS.clear()
    assert runner.get_task_status(task.name)["status"] == "failed"
    with pytest.raises(ValueError):
        runner.start_task_recovery(task.name, "image-key")
    post.assert_not_called()
    assert ledger.load()["operations"]["image:1"]["not_submitted"] is True
    assert ledger.load()["operations"]["image:1"]["gateway_operation_id"]
    assert ledger.summary()["reserved_cny"] == 0
    assert ledger.summary()["pending_bill_cny"] == .03


def checkpoint(task):
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73, mode="real")
    runner._make_provider_checkpoint(task, [{"block_id": "hero", "is_hero": True}], 1, schema_mode="v2")
    runner._TASKS.clear()


def test_image_receipt_survives_exit_before_pipeline_checkpoint(task, monkeypatch):
    import ai_image_apimart
    checkpoint(task)
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    class ProcessExit(BaseException):
        pass
    def post(*args, lifecycle_callback, **kwargs):
        lifecycle_callback({"event": "submitted", "provider_task_id": "paid-original"})
        pytest.fail("simulated process must have exited")
    def crash(event):
        raise ProcessExit()
    with pytest.raises(ProcessExit):
        ledger.image_call(quote(), post, block_id="hero", lifecycle_callback=crash)
    assert runner._read_json(task / "_recovery.json")["blocks"][0]["provider_task_id"] == ""
    poll = Mock(return_value={"data": {
        "status": "completed", "cost": .014, "credits_cost": .14,
        "usage": {"output_tokens": 123},
        "result": {"images": [{"url": ["https://example.invalid/paid-image.jpg"]}]},
    }})
    monkeypatch.setattr(ai_image_apimart, "_http_get_json", poll)
    def download(url, destination, **kwargs):
        Image.effect_noise((600, 800), 40).convert("RGB").save(destination)
        return "system"
    monkeypatch.setattr(runner, "_download_image", download)
    def assemble(directory, blocks):
        download("", directory / "assembled.png")
        return "/static/ai_refine_v2/interrupted/assembled.png"
    monkeypatch.setattr(runner, "_run_assembler_v2", assemble)
    state = runner._recover_task(task.name, "image-key")
    assert state["status"] == "success", state.get("error")
    assert state["user_id"] == 73
    assert "/tasks/paid-original?" in poll.call_args.args[0] and poll.call_count == 1
    operation = ledger.load()["operations"]["image:1"]
    assert operation["status"] == "completed"
    assert operation["provider_receipt"]["cost"] == .014
    assert operation["provider_receipt"]["credits_cost"] == .14
    assert operation["provider_receipt"]["usage"]["output_tokens"] == 123
    assert ledger.summary()["actual_cny"] is None


@pytest.mark.parametrize("block_id,provider_id", [("hero", ""), ("", "unmatched-paid-id"), ("wrong-block", "paid-id")])
def test_unmatched_or_missing_receipt_never_becomes_terminal(task, monkeypatch, block_id, provider_id):
    import ai_image_apimart
    checkpoint(task)
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    ledger.begin("image:1", quote(), quote()["image_unit_cny"])
    ledger.finish("image:1", "submitting", block_id=block_id, provider_task_id=provider_id)
    poll = Mock(side_effect=AssertionError("no reliable receipt mapping"))
    monkeypatch.setattr(ai_image_apimart, "poll_image_task", poll)
    lookup = Mock(side_effect=AssertionError("legacy receipts have no gateway operation ID"))
    monkeypatch.setattr(ai_image_apimart, "recover_gateway_task_id", lookup)
    state = runner._recover_task(task.name, "image-key")
    assert state["status"] == "outcome_unknown"
    assert state["user_id"] == 73
    poll.assert_not_called()
    lookup.assert_not_called()
    assert "gateway_operation_id" not in ledger.load()["operations"]["image:1"]


def test_legacy_receipt_matches_provider_id_without_guessing_order(task):
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    ledger.begin("image:1", quote(), quote()["image_unit_cny"])
    ledger.finish("image:1", "submitting", provider_task_id="old-task", raw_url="https://example.invalid/old.jpg")
    blocks = [{"block_id": "hero", "provider_task_id": "old-task"}]
    assert ledger.restore_receipts(blocks) == []
    assert blocks[0]["raw_url"].endswith("/old.jpg")


def test_generator_journals_stable_block_identity_before_post(task, monkeypatch):
    from ai_refine_v2 import refine_generator
    reference = task / "product.jpg"
    Image.new("RGB", (100, 100), "#55ad81").save(reference)
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73)
    def post(*args, lifecycle_callback, **kwargs):
        operations = pricing.CostJournal(task).load()["operations"]
        assert all(op.get("block_id") for op in operations.values())
        lifecycle_callback({"event": "submitted", "provider_task_id": str(len(operations))})
        return "https://example.invalid/image.jpg"
    monkeypatch.setattr(refine_generator, "_default_api_call", post)
    monkeypatch.setattr(runner, "_download_generation_results", lambda blocks, *a, **kw: list(blocks))
    runner._run_real_generator_v2(sample(), str(reference), "fake", task, lambda *a: None)
    operations = pricing.CostJournal(task).load()["operations"]
    assert {op["block_id"] for op in operations.values()} == {
        block["block_id"] for block in refine_generator._build_blocks_v2(sample())
    }


@pytest.mark.parametrize("receipt_status", [200, 202, 404, 409, 503])
def test_restart_finds_gateway_receipt_without_reupload_or_resubmit(task, monkeypatch, receipt_status):
    import ai_image_apimart as adapter
    monkeypatch.setenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "https://gateway.invalid")
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://gateway.invalid/v1/provider-gateway/apimart")
    checkpoint(task)
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    requests = []
    class ProcessExit(BaseException):
        pass
    def crash_after_submit(request, **kwargs):
        requests.append(request)
        assert request.method == "POST"
        operation = pricing.CostJournal(task).load()["operations"]["image:1"]
        assert request.get_header("X-xiaoxi-operation-id") == operation["gateway_operation_id"]
        raise ProcessExit()
    monkeypatch.setattr(adapter, "_open_apimart", crash_after_submit)
    upload = Mock(return_value=("https://example.invalid/reference.png", False))
    monkeypatch.setattr(adapter, "_upload_data_url_for_route", upload)
    with pytest.raises(ProcessExit):
        ledger.image_call(quote(), adapter.default_api_call, "prompt", "data:image/png;base64,YQ==", "secret", block_id="hero")
    original_id = ledger.load()["operations"]["image:1"]["gateway_operation_id"]
    runner._TASKS.clear()
    def receipt(request, **kwargs):
        requests.append(request)
        assert request.method == "GET"
        assert request.full_url == f"https://gateway.invalid/v1/provider-gateway/operations/{original_id}"
        if receipt_status >= 400:
            raise urllib.error.HTTPError(request.full_url, receipt_status, "fixture", {}, io.BytesIO(b'{}'))
        body = {"data": [{"task_id": "paid-original"}]} if receipt_status == 200 else {"status": "pending"}
        result = io.BytesIO(json.dumps(body).encode())
        result.status = receipt_status
        return result
    monkeypatch.setattr(adapter, "_open_apimart", receipt)
    poll = Mock(return_value="https://example.invalid/paid.jpg")
    monkeypatch.setattr(adapter, "poll_image_task", poll)
    def download(url, destination, **kwargs):
        Image.effect_noise((600, 800), 40).convert("RGB").save(destination)
        return "system"
    monkeypatch.setattr(runner, "_download_image", download)
    def assemble(directory, blocks):
        download("", directory / "assembled.png")
        return "/static/assembled.png"
    monkeypatch.setattr(runner, "_run_assembler_v2", assemble)
    state = runner._recover_task(task.name, "secret")
    assert state["status"] == ("success" if receipt_status == 200 else "outcome_unknown")
    assert [request.method for request in requests] == ["POST", "GET"]
    assert upload.call_count == 1
    operation = ledger.load()["operations"]["image:1"]
    assert operation["gateway_operation_id"] == original_id
    assert poll.call_count == (1 if receipt_status == 200 else 0)
    assert ledger.summary()["reserved_cny"] == (0 if receipt_status == 200 else quote()["image_unit_cny"])


@pytest.mark.parametrize("gateway", [False, True])
def test_submit_disconnect_looks_up_only_its_durable_gateway_operation(task, monkeypatch, gateway):
    import ai_image_apimart as adapter
    monkeypatch.setenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "https://gateway.invalid")
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://gateway.invalid/v1/provider-gateway/apimart" if gateway else "https://api.apimart.ai/v1")
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    requests = []
    def transport(request, **kwargs):
        requests.append(request)
        operation = ledger.load()["operations"]["image:1"]
        if request.method == "POST":
            assert bool(request.get_header("X-xiaoxi-operation-id")) is gateway
            assert bool(operation.get("gateway_operation_id")) is gateway
            raise TimeoutError("response lost")
        result = io.BytesIO(b'{"data":[{"task_id":"paid-original"}]}')
        result.status = 200
        return result
    monkeypatch.setattr(adapter, "_open_apimart", transport)
    monkeypatch.setattr(adapter, "poll_image_task", lambda task_id, *_a, **_k: "https://example.invalid/paid.jpg")
    if gateway:
        assert ledger.image_call(quote(), adapter.default_api_call, "prompt", None, "secret", block_id="hero").endswith("paid.jpg")
    else:
        with pytest.raises(pricing.RequestOutcomeUnknown):
            ledger.image_call(quote(), adapter.default_api_call, "prompt", None, "secret", block_id="hero")
    assert [request.method for request in requests] == (["POST", "GET"] if gateway else ["POST"])


def test_bad_system_proxy_cannot_strand_original_gateway_receipt_and_poll(task, monkeypatch):
    import ai_image_apimart as adapter
    monkeypatch.setenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "https://gateway.invalid")
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://gateway.invalid/v1/provider-gateway/apimart")
    monkeypatch.setattr(adapter, "_APIMART_PROXY_SETTINGS", {"https": "http://broken.invalid:7890"})
    monkeypatch.setattr(adapter, "_MAX_CONSECUTIVE_POLL_ERRORS", 1)
    upload = Mock(return_value=("https://example.invalid/reference.png", True))
    monkeypatch.setattr(adapter, "_upload_data_url_for_route", upload)
    requests = []
    def transport(request, *, timeout, direct=False):
        requests.append((request.method, request.full_url, direct))
        if request.method == "POST":
            assert direct is True
            raise TimeoutError("original POST response lost")
        if not direct:
            raise urllib.error.URLError("system proxy unavailable")
        body = ({"data": [{"task_id": "paid-original"}]} if "/operations/" in request.full_url
                else {"data": {"status": "completed", "result": {"images": [{"url": "https://example.invalid/paid.jpg"}]}}})
        result = io.BytesIO(json.dumps(body).encode())
        result.status = 200
        return result
    monkeypatch.setattr(adapter, "_open_apimart", transport)
    ledger = pricing.CostJournal(task)
    ledger.set_plan(quote(), 1)
    assert ledger.image_call(quote(), adapter.default_api_call, "prompt", "data:image/png;base64,YQ==", "secret", block_id="hero").endswith("paid.jpg")
    assert sum(method == "POST" for method, _, _ in requests) == 1
    assert upload.call_count == 1
    for route in ("/operations/", "/tasks/paid-original"):
        assert [direct for method, url, direct in requests if route in url] == [False, True]
    assert ledger.load()["operations"]["image:1"]["status"] == "completed"


@pytest.mark.parametrize("schema", ["v1", "v2"])
@pytest.mark.parametrize("connected", [False, True])
def test_new_paid_planner_requires_fresh_reference_upload_first(task, monkeypatch, schema, connected):
    import ai_image_apimart as adapter
    # start_task creates only in-memory state; worker owns the first saved input.
    (task / "_input.json").unlink()
    reference = task / "reference.png"
    Image.new("RGB", (80, 80), "#7bad12").save(reference)
    events = []
    def read_quote(**kwargs):
        events.append("quote")
        return quote()
    monkeypatch.setattr(pricing, "read_quote", read_quote)
    def upload(data_url, key, *, force_refresh=False):
        assert data_url.startswith("data:image/png;base64,")
        assert force_refresh is True
        events.append("upload")
        if not connected:
            raise adapter.APIMartNotSubmitted("secret upstream body", stage="reference_upload", http_status=503)
        return "https://example.invalid/reference.png"
    monkeypatch.setattr(adapter, "upload_data_url", upload)
    def planner(*args, **kwargs):
        events.append("planner")
        raise pricing.PricingRequired("fixture stops before any real purchase")
    monkeypatch.setattr(refine_planner, "plan" if schema == "v1" else "plan_v2", planner)
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73)
    runner._worker(task.name, TEXT, str(reference), "产品", "planner-key", "image-key", mode=schema)
    assert events == (["quote", "upload", "planner"] if connected else ["quote", "upload"])
    assert pricing.CostJournal(task).load()["operations"] == {}
    runner._TASKS.clear()
    state = runner.get_task_status(task.name)
    assert state["user_id"] == 73
    if not connected:
        assert state["status"] == "failed"
        assert "生图通道未连通，未购买策划" in state["error"]
        saved = (task / "_recovery.json").read_text(encoding="utf-8")
        assert "secret upstream body" not in saved
        assert json.loads(saved)["diagnostic"]["http_status"] == 503


def test_repricing_new_task_still_uploads_reference_before_buying_planner(task, monkeypatch):
    import ai_image_apimart as adapter
    (task / "_input.json").unlink()
    reference = task / "reference.png"
    Image.new("RGB", (80, 80), "#7bad12").save(reference)
    events = []
    def read_quote(**kwargs):
        events.append("quote")
        if len(events) == 1:
            raise pricing.PricingRequired("temporary quote failure")
        return quote()
    def upload(*args, force_refresh=False):
        assert force_refresh is True
        events.append("upload")
        return "https://example.invalid/reference.png"
    def planner(*args, **kwargs):
        events.append("planner")
        raise pricing.PricingRequired("fixture stops before purchase")
    monkeypatch.setattr(pricing, "read_quote", read_quote)
    monkeypatch.setattr(adapter, "upload_data_url", upload)
    monkeypatch.setattr(refine_planner, "plan_v2", planner)
    runner._TASKS[task.name] = runner.TaskState(task_id=task.name, user_id=73)
    runner._worker(task.name, TEXT, str(reference), "产品", "planner-key", "image-key", mode="v2")
    assert runner.get_task_status(task.name)["status"] == "pricing_required"
    runner._TASKS.clear()
    monkeypatch.setattr(runner.threading, "Thread", lambda *, target, args, **kwargs:
                        SimpleNamespace(start=lambda: target(*args)))
    runner.start_task_recovery(task.name, "image-key", "planner-key")
    assert events == ["quote", "quote", "upload", "planner"]
    assert not runner._read_json(task / "_input.json").get("reference_preflight_required")
    assert pricing.CostJournal(task).load()["operations"] == {}
