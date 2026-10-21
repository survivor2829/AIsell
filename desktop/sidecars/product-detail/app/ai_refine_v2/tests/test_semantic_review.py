"""Real failed input, authored expected decisions; never claims model acceptance."""
import copy
import json
from pathlib import Path
from unittest.mock import Mock
from itertools import combinations

import pytest

from ai_refine_v2 import refine_planner as planner, pricing, pipeline_runner as runner
from ai_refine_v2.semantic_review import apply_review, apply_final_set, FINAL_SET_VERSION
from ai_refine_v2.tests.test_buyer_strategy import strategy
from ai_refine_v2.tests.test_product_driven_planning import response
from ai_refine_v2.tests.test_pricing_boundary import quote


def failure_fixture():
    return json.loads((Path(__file__).parent / "fixtures/failed_fact_routes_review.json").read_text(encoding="utf-8"))


def latest_review():
    return json.loads((Path(__file__).parent / "fixtures/failed_semantic_review.json")
                      .read_text(encoding="utf-8"))["review"]


def authored_final_verdict():
    """Actual revised text plus explicitly human-labelled final comparisons/additions."""
    case = failure_fixture()
    reviewed = apply_review(case["strategy"], latest_review())
    source_ids = [["f1r1", "f1r2", "f1r3"], ["f2r1"], ["f2r2"], ["f3r1"]]
    points = []
    for i, group in enumerate(reviewed["advantages"], 1):
        for route in group["routes"]:
            points.append(dict(id=f"b{len(points)+1}", fact_id=f"f{i}",
                               source_ids=source_ids[len(points)], reason="保留真实回执改写后的内容供离线比较",
                               route=copy.deepcopy(route)))
    for addition in case["expected_review"]["additions"]:
        points.append(dict(id=f"b{len(points)+1}", fact_id=addition["fact_id"],
                           source_ids=[], reason=addition["reason"], route=copy.deepcopy(addition["route"])))
    return {
        "review_version": FINAL_SET_VERSION, "final_points": points,
        "excluded": [{"id": d["id"], "reason": d["reason"]} for d in latest_review()["decisions"]
                     if d["action"] in ("spec_only", "unsupported")],
        "opportunities": [
            {"fact_id": f"f{i}", "new_point_ids": ["b5", "b6"] if i == 1 else [],
             "reason": "人工标注候选：观感维护与多场所选型；仅用于验证处理链路" if i == 1
                       else "现有容量、续航或配置不足以支持额外的效率及自动化收益"}
            for i in range(1, 5)],
        "comparisons": [
            {"left": a["id"], "right": b["id"],
             "relation": "same_result" if (a["id"], b["id"]) == ("b2", "b3") else "distinct",
             "reason": "两项改写后均为清水污水分箱承载，操作与管理称呼没有改变结果"
                       if (a["id"], b["id"]) == ("b2", "b3")
                       else f"人工待实测判断：{a['route']['need']}；与{b['route']['need']}比较"}
            for a, b in combinations(points, 2)],
    }


def test_latest_real_review_cannot_pass_final_set_contract():
    case = failure_fixture()
    # It passed the old contract despite two final water-box benefits repeating.
    old = apply_review(case["strategy"], latest_review())
    assert len(old["advantages"][1]["routes"]) == 2
    with pytest.raises(ValueError, match="整套买点"):
        apply_final_set(case["strategy"], latest_review())


def test_final_comparison_catches_rewritten_duplicate_and_retains_added_needs():
    case, verdict = failure_fixture(), authored_final_verdict()
    originals = copy.deepcopy((case, verdict))
    result = apply_final_set(case["strategy"], verdict)
    assert (case, verdict) == originals
    assert sum(len(g["routes"]) for g in result["advantages"]) == 5
    assert len(result["advantages"][0]["routes"]) == 3
    assert len(result["advantages"][1]["routes"]) == 1
    water = result["advantages"][1]["routes"][0]
    assert water["review_point_ids"] == ["b2", "b3"]
    assert water["benefit"] == verdict["final_points"][1]["route"]["benefit"]
    assert result["specifications"] == case["strategy"]["specifications"]


@pytest.mark.parametrize("fault", ["missing_pair", "contradiction", "missing_exploration", "invented_fact"])
def test_final_set_failure_stops_once_without_paid_retry(fault):
    case, verdict = failure_fixture(), authored_final_verdict()
    if fault == "missing_pair":
        verdict["comparisons"].pop()  # Includes the new routes too.
    elif fault == "contradiction":
        verdict["comparisons"][0]["relation"] = "same_result"  # b1=b2=b3, but b1!=b3.
    elif fault == "missing_exploration":
        verdict["opportunities"].pop()
    else:
        verdict["final_points"][-1]["fact_id"] = "f999"
    planning, review = Mock(return_value=response(case["strategy"])), Mock(return_value=response(verdict))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(case["source"], api_key="offline", http_fn=planning,
                        semantic_http_fn=review, require_semantic_final_set=True, max_retries=2)
    assert planning.call_count == review.call_count == 1


def test_distinct_jobs_from_same_fact_remain_without_product_specific_rules():
    raw = strategy()
    for route in raw["advantages"][0]["routes"]:
        route["outcome_key"] = "折叠带来的便利"
    points = [dict(id=f"b{i}", fact_id="f1", source_ids=[f"f1r{i}"], reason="折叠的不同用途", route=r)
              for i, r in enumerate(raw["advantages"][0]["routes"], 1)]
    verdict = dict(review_version=FINAL_SET_VERSION, final_points=points, excluded=[],
                   opportunities=[dict(fact_id="f1", new_point_ids=[], reason="无其他有依据的工作结果")],
                   comparisons=[dict(left="b1", right="b2", relation="distinct",
                                     reason="携带解决移动过程；收纳解决闲置占用")])
    assert len(apply_final_set(raw, verdict)["advantages"][0]["routes"]) == 2
    result = planner.plan_v2("折叠手推车。可折叠", api_key="offline",
                             http_fn=Mock(return_value=response(raw)),
                             semantic_http_fn=Mock(return_value=response(verdict)),
                             require_semantic_final_set=True)
    assert len(result["selling_points"]) == 2
    assert result["screen_count"] == 3
    assert result["deferred_buying_points"] == []


def test_real_failure_through_planner_merges_relabels_and_adds_distinct_needs():
    case = failure_fixture()
    original = copy.deepcopy(case)
    planning = Mock(return_value=response(case["strategy"]))
    review = Mock(return_value=response(case["expected_review"]))
    result = planner.plan_v2(case["source"], product_title=case["title"], product_category="设备类",
                             api_key="offline", http_fn=planning, semantic_http_fn=review,
                             require_semantic_review=True, max_retries=2)
    assert case == original
    assert planning.call_count == review.call_count == 1
    assert len(result["selling_points"]) == 4
    assert result["screen_count"] == 6
    assert len(result["specifications"]) == len(case["strategy"]["specifications"])
    assert [p["fact_id"] for p in result["selling_points"]].count("f1") == 3
    assert all("待确认" not in s.get("subtitle", "") for s in result["screens"])
    assert "semantic_review" in result
    prompt = review.call_args.args[0]["messages"]
    assert "独立" in prompt[0]["content"]
    assert case["source"] in json.loads(prompt[1]["content"])["source"]


@pytest.mark.parametrize("fault", ["missing", "duplicate", "merge_cycle", "invented_fact", "missing_visual"])
def test_invalid_semantic_response_never_retries_planning_or_review(fault):
    case = failure_fixture()
    verdict = copy.deepcopy(case["expected_review"])
    if fault == "missing":
        verdict["decisions"].pop()
    elif fault == "duplicate":
        verdict["decisions"].append(copy.deepcopy(verdict["decisions"][0]))
    elif fault == "merge_cycle":
        verdict["decisions"][1]["target"] = "f1r3"
        verdict["decisions"][2]["target"] = "f1r2"
    elif fault == "invented_fact":
        verdict["additions"][0]["fact_id"] = "f999"
    else:
        del verdict["decisions"][0]["revision"]["visual_brief"]
    planning, review = Mock(return_value=response(case["strategy"])), Mock(return_value=response(verdict))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(case["source"], api_key="offline", http_fn=planning,
                        semantic_http_fn=review, require_semantic_review=True, max_retries=2)
    assert planning.call_count == review.call_count == 1


def test_shared_fact_distinct_results_survive_review_without_forced_merging():
    raw = strategy()
    reviewed = apply_review(raw, {"decisions": [
        {"id": "f1r1", "action": "keep", "reason": "携带解决空车移动"},
        {"id": "f1r2", "action": "keep", "reason": "收纳解决闲置存放，与携带不同"},
    ], "additions": []})
    assert reviewed["advantages"] == raw["advantages"]


def test_semantic_receipt_is_independent_and_reused_after_restart(tmp_path, monkeypatch):
    remote = Mock(side_effect=[{"id": "planning", "choices": []}, {"id": "review", "choices": []}])
    monkeypatch.setattr(planner, "_http_post_deepseek", remote)
    body = {"messages": [], "max_tokens": 100}
    journal = pricing.CostJournal(tmp_path)
    journal.planner_call(quote(), body, "secret")
    journal.planner_call(quote(), body, "secret", operation="semantic_review")
    recovered = pricing.CostJournal(tmp_path)
    assert recovered.planner_call(None, body, "secret", operation="semantic_review")["id"] == "review"
    assert recovered.saved_planner_response()["id"] == "planning"
    assert remote.call_count == 2
    assert set(recovered.load()["operations"]) == {"planner", "semantic_review"}


def test_unknown_semantic_call_cannot_be_submitted_again(tmp_path, monkeypatch):
    remote = Mock(side_effect=TimeoutError())
    monkeypatch.setattr(planner, "_http_post_deepseek", remote)
    body = {"messages": [], "max_tokens": 100}
    for _ in range(2):
        with pytest.raises(pricing.RequestOutcomeUnknown):
            pricing.CostJournal(tmp_path).planner_call(quote(), body, "secret", operation="semantic_review")
    assert remote.call_count == 1
    assert pricing.CostJournal(tmp_path).load()["operations"]["semantic_review"]["status"] == "outcome_unknown"


def test_semantic_replay_is_bound_to_original_inputs(tmp_path, monkeypatch):
    remote = Mock(return_value={"id": "review", "choices": []})
    monkeypatch.setattr(planner, "_http_post_deepseek", remote)
    journal = pricing.CostJournal(tmp_path)
    journal.planner_call(quote(), {"messages": [], "max_tokens": 100}, "secret", operation="semantic_review")
    with pytest.raises(pricing.RequestOutcomeUnknown, match="输入不一致"):
        journal.planner_call(None, {"messages": [{"role": "user", "content": "changed"}], "max_tokens": 100},
                             "secret", operation="semantic_review")
    assert remote.call_count == 1


def test_resume_worker_recovers_review_saved_before_completed_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("V2_ALLOW_REAL_API", "true")
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    task_id = "v2_review_crash"
    directory = tmp_path / task_id
    directory.mkdir()
    journal = pricing.CostJournal(directory)
    journal.begin("semantic_review", quote(), .01)
    runner._atomic_write_json(directory / "_semantic_review_response.json", {"id": "saved-review", "choices": []})
    runner._atomic_write_json(directory / "_input.json",
                              dict(product_text="原文", product_image_url="image", product_title="产品", schema_mode="v2"))
    worker = Mock()
    monkeypatch.setattr(runner, "_worker", worker)
    runner._pricing_resume_worker(task_id, "", "")
    assert journal.load()["operations"]["semantic_review"]["status"] == "completed"
    worker.assert_called_once()


@pytest.mark.parametrize("policy_version", [4, 5, 6, 7, 8, 9, 10, 11])
def test_unsubmitted_review_recovery_needs_live_key_before_any_request(tmp_path, monkeypatch, policy_version):
    task_id = "v2_missing_review_key"
    directory = tmp_path / task_id
    directory.mkdir()
    monkeypatch.setattr(runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(runner, "_TASKS", {task_id: runner.TaskState(task_id=task_id)})
    runner._atomic_write_json(directory / "_quality_policy.json", {"version": policy_version})
    journal = pricing.CostJournal(directory)
    journal.begin("planner", quote(), .01)
    runner._atomic_write_json(directory / "_planner_response.json", {"id": "first-receipt", "choices": []})
    assert runner.needs_semantic_review_key(task_id) is True
    remote = Mock()
    monkeypatch.setattr(planner, "_http_post_deepseek", remote)
    def invoke_review(**kwargs):
        return kwargs["semantic_http_fn"]({"messages": [], "max_tokens": 100}, kwargs["api_key"])
    monkeypatch.setattr(planner, "plan_v2", invoke_review)
    runner._worker_v2(task_id, "原文", "", "产品", "", "")
    remote.assert_not_called()
    assert "semantic_review" not in journal.load()["operations"]
    assert runner._TASKS[task_id].status == "pricing_required"
