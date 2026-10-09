"""Quotes must guard the real entry, not merely label a finished paid result."""
import json
import time
from unittest.mock import Mock

import pytest

from ai_refine_v2 import pipeline_runner as runner, pricing, refine_planner


def quote():
    return {"version": 1, "checked_at": time.time(), "image_unit_cny": 1.6872,
            "image_model": "gpt-image-2", "image_resolution": "1K",
            "planner_per_million_cny": {"input": 2, "cache": .04, "output": 8}}


@pytest.mark.parametrize("age,valid", [(0, True), (-10, True), (3601, False), (-301, False), (None, False)])
def test_gateway_price_requires_current_quote_without_customer_proxy(monkeypatch, age, valid):
    import provider_transport
    from unittest.mock import MagicMock
    gateway = "https://gateway.invalid"
    source = "https://apimart.ai/api/pricing/model?model=gpt-image-2.5-ext"
    monkeypatch.setenv("XIAOXI_PROVIDER_GATEWAY_ORIGIN", gateway)
    monkeypatch.setenv("REFINE_API_BASE_URL", gateway + "/v1/provider-gateway/apimart")
    monkeypatch.setenv("REFINE_API_KEY", "session-test")
    payload = {"success": True, "data": {"model_name": "gpt-image-2.5-ext"}}
    result = {"ok": True, "apimart_pricing": {"source": source, "checked_at": time.time() - age, "payload": payload}} if age is not None else {"ok": True, "capabilities": {"apimart": True}}
    response = MagicMock(status=200)
    response.read.return_value = json.dumps(result).encode()
    response.__enter__.return_value = response
    opener = Mock()
    opener.open.return_value = response
    factory = Mock(return_value=opener)
    monkeypatch.setattr(provider_transport, "build_provider_opener", factory)
    if valid:
        assert json.loads(pricing._read(source)) == payload
    else:
        with pytest.raises(ValueError, match="unavailable"):
            pricing._read(source)
    target = gateway + "/v1/provider-gateway/capabilities?price_model=gpt-image-2.5-ext"
    factory.assert_called_once_with(target, proxies={})
    request = opener.open.call_args.args[0]
    assert request.full_url == target
    assert request.get_header("Authorization") == "Bearer session-test"


def test_actual_screen_count_and_missing_quote_stop_before_image_post(tmp_path, monkeypatch):
    from ai_refine_v2 import refine_generator
    calls = Mock()
    monkeypatch.setattr(refine_generator, "generate_v2", calls)
    monkeypatch.setattr(pricing, "read_quote", lambda **kw: quote())
    monkeypatch.setattr("pricing_config.MAX_REFINE_COST_PER_RUN", 5)
    planning = {"screens": [{}, {}, {}]}
    with pytest.raises(pricing.PricingRequired, match="后台单任务上限"):
        runner._run_real_generator_v2(planning, "unused", "key", tmp_path, lambda *a: None)
    calls.assert_not_called()
    costs = pricing.CostJournal(tmp_path).summary()
    assert costs["estimated_cny"] == 5.0616
    assert costs["actual_cny"] is None
    assert costs["reserved_cny"] == 0


def test_planner_timeout_cannot_be_reposted_after_restart(tmp_path, monkeypatch):
    remote = Mock(side_effect=TimeoutError())
    monkeypatch.setattr(refine_planner, "_http_post_deepseek", remote)
    payload = {"messages": [{"role": "user", "content": "清洁机"}], "max_tokens": 2000}
    for _ in range(2):
        with pytest.raises(pricing.RequestOutcomeUnknown):
            pricing.CostJournal(tmp_path).planner_call(quote(), payload, "never-log")
    assert remote.call_count == 1
    state = pricing.CostJournal(tmp_path).summary()
    assert state["reserved_cny"] > 0 and state["actual_cny"] is None
    assert "never-log" not in (tmp_path / "_costs.json").read_text()


def test_planner_usage_and_images_are_estimates_not_bills(tmp_path, monkeypatch):
    monkeypatch.setattr(refine_planner, "_http_post_deepseek", lambda *a: {
        "id": "req-1", "usage": {"prompt_tokens": 100, "completion_tokens": 500},
        "choices": [{"message": {"content": "{}"}}]})
    ledger = pricing.CostJournal(tmp_path)
    ledger.planner_call(quote(), {"messages": [], "max_tokens": 600}, "key")
    ledger.set_plan(quote(), 2)
    ledger.image_call(quote(), lambda *a, **kw: "https://result.invalid/image", "prompt")
    summary = ledger.summary()
    assert summary["pending_bill_cny"] > 1.6872
    assert summary["actual_cny"] is None and summary["reserved_cny"] == 0
    assert ledger.load()["operations"]["planner"]["usage"]["completion_tokens"] == 500


@pytest.mark.parametrize("case,stage,http_status", [
    ("invalid_reference", "reference_prepare", None),
    ("upload_rejected", "reference_upload", 401),
    ("upload_unavailable", "reference_upload", 503),
    ("submit_rejected", "submit", 403),
    ("submit_unavailable", "submit", 503),
    ("submit_timeout", "submit", None),
    ("poll_timeout", "poll", None),
])
def test_image_journal_preserves_submission_boundary_and_safe_diagnostic(tmp_path, monkeypatch, case, stage, http_status):
    import ai_image_apimart as adapter
    secret = "never-log-this-key-or-response"
    with adapter._UPLOAD_CACHE_LOCK:
        adapter._UPLOAD_CACHE.clear()
    monkeypatch.setenv("REFINE_API_BASE_URL", "https://provider.invalid/v1")
    monkeypatch.setattr(adapter, "_MAX_CONSECUTIVE_POLL_ERRORS", 1)
    monkeypatch.setattr(adapter.time, "sleep", lambda _: None)
    monkeypatch.setattr(adapter, "_http_post_image_upload", lambda *a, **kw:
                        (401 if case == "upload_rejected" else 503, {"message": secret}) if case.startswith("upload_") else (200, {"url": "https://cdn.invalid/ref"}))
    def submit(*a, **kw):
        if case == "submit_timeout":
            raise TimeoutError(secret)
        if case == "submit_unavailable":
            return 503, {"message": secret}
        return (403, {"message": secret}) if case == "submit_rejected" else (200, {"data": [{"task_id": "original-task"}]})
    post = Mock(side_effect=submit)
    monkeypatch.setattr(adapter, "_http_post_json", post)
    monkeypatch.setattr(adapter, "_http_get_json", Mock(side_effect=TimeoutError(secret)))
    reference = "data:image/png;base64,YQ==" if case.startswith("upload_") else "https://cdn.invalid/ref"
    if case == "invalid_reference":
        reference = "data:image/png;base64,invalid!"
    ledger = pricing.CostJournal(tmp_path)
    ledger.set_plan(quote(), 2)
    with pytest.raises(Exception):
        ledger.image_call(quote(), adapter.default_api_call, "prompt", reference, secret, block_id="hero")
    operation = ledger.load()["operations"]["image:1"]
    known_unsubmitted = case in {"invalid_reference", "upload_rejected", "upload_unavailable", "submit_rejected"}
    assert operation["status"] == ("failed" if known_unsubmitted else "outcome_unknown")
    assert operation.get("not_submitted", False) is known_unsubmitted
    assert operation["diagnostic"]["stage"] == stage
    assert operation["diagnostic"].get("http_status") == http_status
    assert ledger.summary()["reserved_cny"] == (0 if known_unsubmitted else quote()["image_unit_cny"])
    assert ledger.summary()["pending_bill_cny"] == 0
    assert secret not in ledger.path.read_text(encoding="utf-8")
    assert "https://cdn.invalid" not in json.dumps(operation.get("diagnostic"))
    assert bool(operation.get("provider_task_id")) is (case == "poll_timeout")
    assert post.call_count == (0 if case in {"invalid_reference", "upload_rejected", "upload_unavailable"} else 1)
    # Reopening the journal must not silently buy another image after either outcome.
    again = Mock()
    with pytest.raises(Exception):
        pricing.CostJournal(tmp_path).image_call(quote(), again, "prompt")
    again.assert_not_called()


def test_untyped_local_exception_is_not_assumed_free(tmp_path):
    ledger = pricing.CostJournal(tmp_path)
    ledger.set_plan(quote(), 1)
    with pytest.raises(pricing.RequestOutcomeUnknown):
        ledger.image_call(quote(), Mock(side_effect=TypeError("sensitive request content")))
    operation = ledger.load()["operations"]["image:1"]
    assert operation["status"] == "outcome_unknown"
    assert operation.get("not_submitted") is not True
    assert operation["diagnostic"] == {"error_type": "TypeError", "stage": "unknown"}
    assert "sensitive request content" not in ledger.path.read_text(encoding="utf-8")


def test_missing_quote_preserves_input_and_stops_planner(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    task = "noquote"
    runner._TASKS[task] = runner.TaskState(task_id=task, user_id=3)
    planner = Mock()
    monkeypatch.setattr(refine_planner, "plan_v2", planner)
    monkeypatch.setattr(pricing, "read_quote", Mock(side_effect=pricing.PricingRequired("报价不可用")))
    runner._worker_v2(task, "产品资料", "product.png", "产品", "key", "key")
    planner.assert_not_called()
    runner._TASKS.pop(task)
    state = runner.get_task_status(task)
    assert state["status"] == "pricing_required" and state["user_id"] == 3
    assert json.loads((tmp_path / task / "_input.json").read_text(encoding="utf-8"))["product_text"] == "产品资料"


def test_resuming_preserved_plan_does_not_pay_planner_again(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    task = "priced-plan"
    directory = tmp_path / task
    directory.mkdir()
    planning = {"planning_version": refine_planner.PLANNING_VERSION, "screens": [{"title": "卖点"}]}
    (directory / "_planning.json").write_text(json.dumps(planning))
    runner._TASKS[task] = runner.TaskState(task_id=task, user_id=1)
    planner = Mock()
    monkeypatch.setattr(refine_planner, "plan_v2", planner)
    images = Mock(side_effect=pricing.PricingRequired("still unavailable"))
    monkeypatch.setattr(runner, "_run_real_generator_v2", images)
    runner._worker_v2(task, "资料", "image.png", "产品", "key", "key")
    planner.assert_not_called()
    assert images.call_args.args[0] == planning


def test_supplier_table_matches_model_column_and_peak_price():
    document = '<table><tr><td colspan="3">模型</td><td>deepseek-flash<sup>(1)</sup></td><td>other-model</td></tr>'
    for label, idle, peak in (("百万tokens输入（缓存命中）", ".02", ".04"),
                              ("百万tokens输入（缓存未命中）", "1", "2"),
                              ("百万tokens输出", "4", "8")):
        document += f'<tr><td rowspan="2">{label}</td><td>空闲时段</td><td>{idle}元</td><td>90元</td></tr>'
        document += f'<tr><td>高峰时段</td><td>{peak}元</td><td>99元</td></tr>'
    document += '</table>旧模型名 deepseek-v4-flash 按 Flash 价格计费'
    assert pricing.parse_planner_prices(document, "deepseek-v4-flash") == {"cache": .04, "input": 2, "output": 8}
    with pytest.raises(ValueError):
        pricing.parse_planner_prices(document, "unpriced-model")
