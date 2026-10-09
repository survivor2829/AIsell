"""Formatting recovery never buys another planner reply or relaxes product facts."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ai_refine_v2 import pipeline_runner as runner, pricing, refine_planner as planner
from ai_refine_v2.tests.test_pricing_boundary import quote
from ai_refine_v2.tests.test_product_driven_planning import TEXT, sample


def test_trailing_commas_preserve_strings_escapes_and_values():
    text = '原样逗号,} 和 ,]、引号 "、反斜杠 \\ 和大括号 {nested}'
    raw = '{"text":' + json.dumps(text, ensure_ascii=False) + ',"items":[1,{"v":"x",},3,],}'
    assert planner._extract_json(raw) == {"text": text, "items": [1, {"v": "x"}, 3]}
    normal = json.dumps({"text": text}, ensure_ascii=False)
    assert planner._without_trailing_json_commas(normal) == normal


def test_trailing_comma_repair_does_not_fill_values_or_fix_truncation():
    for malformed in ('{,}', '{"a":,}', '{"a":1,,}', '{"a":"unterminated',
                      '{"a":1,', '{"a":1} trailing', '{"a":1 #comment}'):
        with pytest.raises(json.JSONDecodeError):
            planner._extract_json(malformed)


@pytest.fixture
def saved_format_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(runner, "_TASKS", {})
    monkeypatch.setattr(runner, "_RECOVERY_TASK_IDS", set())
    monkeypatch.setenv("V2_ALLOW_REAL_API", "true")
    directory = tmp_path / "paid-format"
    directory.mkdir()
    runner._TASKS[directory.name] = runner.TaskState(task_id=directory.name, user_id=73)
    runner._atomic_write_json(directory / "_input.json", {
        "product_text": TEXT, "product_title": "清洁机器人", "product_image_url": "",
        "schema_mode": "v2", "user_id": 73,
    })
    raw = json.dumps(sample(), ensure_ascii=False)
    reply = {"choices": [{"finish_reason": "stop", "message": {"content": raw[:-1] + ',}'}}]}
    runner._atomic_write_json(directory / "_planner_response.json", reply)
    ledger = pricing.CostJournal(directory)
    ledger.begin("planner", quote(), .03)
    ledger.finish("planner", "completed")
    runner._record_worker_exception(directory.name, directory,
        planner.PlannerError("v2 API/解析失败 (重试 0 次后): JSONDecodeError: trailing comma"), log_prefix="test")
    runner._TASKS.clear()
    return directory


def test_failed_format_reply_replays_locally_and_reaches_only_unsubmitted_images(saved_format_failure, monkeypatch):
    directory = saved_format_failure
    original = (directory / "_planner_response.json").read_bytes()
    assert runner.get_task_status(directory.name)["can_replay_planner"] is True
    http = Mock(side_effect=AssertionError("saved planner response must not be purchased again"))
    monkeypatch.setattr(planner, "_http_post_deepseek", http)
    images = Mock(side_effect=pricing.PricingRequired("test stops before images"))
    monkeypatch.setattr(runner, "_run_real_generator_v2", images)
    monkeypatch.setattr(runner.threading, "Thread", lambda *, target, args, **kw:
                        SimpleNamespace(start=lambda: target(*args)))
    runner.start_task_recovery(directory.name, "image-key")
    assert images.call_count == 1
    assert len(images.call_args.args[0]["screens"]) == len(sample()["screens"])
    assert runner.get_task_status(directory.name)["status"] == "pricing_required"
    assert runner.get_task_status(directory.name)["can_replay_planner"] is False
    assert runner.get_task_status(directory.name)["user_id"] == 73
    assert list(pricing.CostJournal(directory).load()["operations"]) == ["planner"]
    assert (directory / "_planner_response.json").read_bytes() == original
    http.assert_not_called()


@pytest.mark.parametrize("case", ["truncated", "invalid_schema", "image_receipt", "uncertain_planner", "other_failure"])
def test_failed_reply_replay_requires_completed_planner_only_and_full_valid_plan(saved_format_failure, case):
    directory = saved_format_failure
    path = directory / "_planner_response.json"
    reply = runner._read_json(path)
    if case == "truncated":
        reply["choices"][0]["finish_reason"] = "length"
    elif case == "invalid_schema":
        value = sample()
        value["specifications"][0]["value"] = "999mm"
        reply["choices"][0]["message"]["content"] = json.dumps(value)
    elif case == "image_receipt":
        ledger = pricing.CostJournal(directory)
        ledger.begin("image:1", quote(), .14)
        ledger.finish("image:1", "completed", provider_task_id="paid-original")
    elif case == "uncertain_planner":
        pricing.CostJournal(directory).finish("planner", "outcome_unknown")
    else:
        record = runner._read_json(directory / "_recovery.json")
        record["error"] = "v2 schema 不合规"
        runner._atomic_write_json(directory / "_recovery.json", record)
    runner._atomic_write_json(path, reply)
    state = runner.get_task_status(directory.name)
    assert state["can_replay_planner"] is False
    with pytest.raises(ValueError, match="不可恢复"):
        runner.start_task_recovery(directory.name, "image-key")
