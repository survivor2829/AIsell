"""Process exits between journal and pipeline writes must not lose paid work."""
from types import SimpleNamespace
from unittest.mock import Mock

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
    assert state["user_id"] == 73
    assert images.call_count == 1
    assert images.call_args.args[0]["screens"] == sample()["screens"]
    remote.assert_not_called()
    assert list(ledger.load()["operations"]) == ["planner"]


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
    poll = Mock(return_value="https://example.invalid/paid-image.jpg")
    monkeypatch.setattr(ai_image_apimart, "poll_image_task", poll)
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
    assert poll.call_args.args[0] == "paid-original" and poll.call_count == 1
    assert ledger.load()["operations"]["image:1"]["status"] == "completed"


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
    state = runner._recover_task(task.name, "image-key")
    assert state["status"] == "outcome_unknown"
    assert state["user_id"] == 73
    poll.assert_not_called()


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
