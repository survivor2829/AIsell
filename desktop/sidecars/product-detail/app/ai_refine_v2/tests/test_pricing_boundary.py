"""Quotes must guard the real entry, not merely label a finished paid result."""
import json
import time
from unittest.mock import Mock

import pytest

from ai_refine_v2 import pipeline_runner as runner, pricing, refine_planner


def quote():
    return {"version": 1, "checked_at": time.time(), "image_unit_cny": 1.6872,
            "planner_per_million_cny": {"input": 2, "cache": .04, "output": 8}}


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
