from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_refine_v2 import pipeline_runner, refine_generator, refine_planner


def test_deepseek_planners_explicitly_disable_thinking():
    captured = []

    def invalid_response(payload, _api_key):
        captured.append(payload)
        return {}

    with pytest.raises(refine_planner.PlannerError):
        refine_planner.plan(
            "产品名称：测试商品",
            api_key="test-key",
            max_retries=0,
            http_fn=invalid_response,
        )
    with pytest.raises(refine_planner.PlannerError):
        refine_planner.plan_v2(
            "产品名称：测试商品",
            api_key="test-key",
            max_retries=0,
            http_fn=invalid_response,
        )

    assert len(captured) == 2
    assert all(payload["thinking"] == {"type": "disabled"} for payload in captured)


def test_outcome_unknown_escapes_both_block_layers_without_retry(monkeypatch):
    class OutcomeUnknown(RuntimeError):
        do_not_retry = True
        outcome_unknown = True

    calls = []

    def uncertain(*_args):
        calls.append(True)
        raise OutcomeUnknown("provider outcome unknown")

    with pytest.raises(OutcomeUnknown):
        refine_generator._generate_one_block_v2(
            block={"block_id": "hero", "visual_type": "hero", "prompt": "测试提示词"},
            image_data_url=None,
            api_key="test-key",
            api_call_fn=uncertain,
            max_retries=3,
            thinking="medium",
            size="1024x1536",
        )
    monkeypatch.setattr(refine_generator, "_render_prompt_for_block", lambda *_args: "prompt")
    with pytest.raises(OutcomeUnknown):
        refine_generator._generate_one_block(
            block={"block_id": "hero", "visual_type": "product_in_scene"},
            planning={},
            product_cutout_url=None,
            api_key="test-key",
            api_call_fn=uncertain,
            max_retries=3,
            thinking="medium",
            size="1024x1536",
        )
    assert len(calls) == 2


def test_explicit_provider_failure_still_stops_without_retry():
    class ExplicitFailure(RuntimeError):
        do_not_retry = True
        outcome_unknown = False

    calls = []

    def failed(*_args):
        calls.append(True)
        raise ExplicitFailure("provider explicitly failed")

    result, cost = refine_generator._generate_one_block_v2(
        block={"block_id": "hero", "visual_type": "hero", "prompt": "测试提示词"},
        image_data_url=None,
        api_key="test-key",
        api_call_fn=failed,
        max_retries=3,
        thinking="medium",
        size="1024x1536",
    )
    assert len(calls) == 1
    assert result.image_url is None
    assert "已停止自动重试" in (result.error or "")
    assert cost == 0.0


def test_outcome_unknown_escapes_sp_thread_pool():
    class OutcomeUnknown(RuntimeError):
        do_not_retry = True
        outcome_unknown = True

    def api_call(prompt, *_args):
        if prompt == "hero prompt":
            return "https://cdn.invalid/hero.png"
        raise OutcomeUnknown("sp outcome unknown")

    planning = {
        "screens": [
            {"idx": 1, "role": "hero", "title": "Hero", "prompt": "hero prompt"},
            {"idx": 2, "role": "feature_wall", "title": "SP", "prompt": "sp prompt"},
        ]
    }
    with pytest.raises(OutcomeUnknown):
        refine_generator.generate_v2(
            planning_v2=planning,
            api_key="test-key",
            api_call_fn=api_call,
            concurrency=1,
            max_retries_hero=0,
            max_retries_sp=2,
        )

def test_pipeline_task_state_preserves_outcome_unknown(tmp_path, monkeypatch):
    class OutcomeUnknown(RuntimeError):
        do_not_retry = True
        outcome_unknown = True

    planning = {
        "product_meta": {"name": "测试商品"},
        "screens": [{"idx": 1, "role": "hero", "title": "Hero", "prompt": "prompt"}],
    }
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(pipeline_runner, "_load_mock_planning_v2", lambda *_args: planning)
    monkeypatch.setattr(refine_planner, "_reorder_lifestyle_to_second", lambda value, _category: value)
    monkeypatch.setattr(refine_planner, "_inject_material_origin", lambda value, _category: value)
    monkeypatch.setattr(pipeline_runner.time, "sleep", lambda _seconds: None)

    def uncertain(*_args, **_kwargs):
        raise OutcomeUnknown("provider outcome unknown")

    monkeypatch.setattr(pipeline_runner, "_run_real_generator_v2", uncertain)
    unknown_task = "task-pipeline-unknown"
    with pipeline_runner._TASKS_LOCK:
        pipeline_runner._TASKS[unknown_task] = pipeline_runner.TaskState(
            task_id=unknown_task, user_id=42
        )
    pipeline_runner._worker_v2(
        unknown_task, "产品", "image.png", "测试商品", "", "image-key"
    )
    unknown_state = pipeline_runner.get_task_status(unknown_task)
    assert unknown_state is not None
    assert unknown_state["status"] == "outcome_unknown"

    def explicit_failure(*_args, **_kwargs):
        raise RuntimeError("provider explicitly failed")

    monkeypatch.setattr(pipeline_runner, "_run_real_generator_v2", explicit_failure)
    failed_task = "task-pipeline-failed"
    with pipeline_runner._TASKS_LOCK:
        pipeline_runner._TASKS[failed_task] = pipeline_runner.TaskState(
            task_id=failed_task, user_id=42
        )
    pipeline_runner._worker_v2(
        failed_task, "产品", "image.png", "测试商品", "", "image-key"
    )
    failed_state = pipeline_runner.get_task_status(failed_task)
    assert failed_state is not None
    assert failed_state["status"] == "failed"

    with pipeline_runner._TASKS_LOCK:
        pipeline_runner._TASKS.pop(unknown_task, None)
        pipeline_runner._TASKS.pop(failed_task, None)

def test_workspace_polling_surfaces_outcome_unknown_code():
    source = (
        Path(__file__).resolve().parents[1] / "templates" / "workspace.html"
    ).read_text(encoding="utf-8")
    assert "state.status === 'outcome_unknown'" in source
    assert "unknown.code = 'DESKTOP_AI_REFINE_OUTCOME_UNKNOWN'" in source
    assert "unknown.taskId = finalState.task_id || taskId" in source

def test_material_origin_injection_never_exceeds_fifteen_screens():
    planning = {
        "product_meta": {
            "materials": [
                {
                    "name": "天然材料",
                    "source_type": "natural",
                    "source_story_hint": "来源可追溯",
                }
            ]
        },
        "screens": [
            {"idx": index, "role": f"role_{index}"}
            for index in range(1, 16)
        ],
        "screen_count": 15,
    }
    result = refine_planner._inject_material_origin(planning, "耗材类")
    assert len(result["screens"]) == 15
    assert result["screen_count"] == 15
    assert all(screen["role"] != "material_origin" for screen in result["screens"])


def test_generate_v2_rejects_sixteen_screens_before_any_api_call():
    calls = []

    def api_call(*_args):
        calls.append(True)
        return "https://cdn.invalid/unexpected.png"

    planning = {
        "screens": [
            {
                "idx": index,
                "role": "hero" if index == 1 else "feature_wall",
                "title": f"screen {index}",
                "prompt": "prompt",
            }
            for index in range(1, 17)
        ]
    }
    with pytest.raises(ValueError, match="最多允许 15 屏"):
        refine_generator.generate_v2(
            planning_v2=planning,
            api_key="test-key",
            api_call_fn=api_call,
        )
    assert calls == []


def test_disk_fallback_restores_persisted_owner(tmp_path, monkeypatch):
    task_id = "task-owner-restored"
    output_dir = tmp_path / task_id
    output_dir.mkdir(parents=True)
    (output_dir / "_summary.json").write_text(
        json.dumps(
            {
                "user_id": 42,
                "mode": "real",
                "total_cost_rmb": 0,
                "blocks": [],
                "raw_urls": [],
            }
        ),
        encoding="utf-8",
    )
    (output_dir / "assembled.png").write_bytes(b"synthetic")
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    with pipeline_runner._TASKS_LOCK:
        pipeline_runner._TASKS.pop(task_id, None)

    restored = pipeline_runner.get_task_status(task_id)
    assert restored is not None
    assert restored["task_id"] == task_id
    assert restored["user_id"] == 42
    assert restored["status"] == "success"
    assert restored["assembled_url"].endswith(f"/{task_id}/assembled.png")
