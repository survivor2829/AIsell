"""Input isolation and pipeline tests, not evidence of live model reasoning."""
import copy
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.demand_first import review_input
from ai_refine_v2.semantic_review import (
    apply_review, apply_final_set, FINAL_SET_VERSION, review_input as legacy_review_input,
)
from ai_refine_v2.tests.test_buyer_strategy import strategy
from ai_refine_v2.tests.test_product_driven_planning import response
from ai_refine_v2.tests.test_semantic_review import failure_fixture, latest_review


def final_verdict(raw, relation):
    """Authored decisions are injection fixtures, never model-quality assertions."""
    return {
        "review_version": FINAL_SET_VERSION,
        "final_points": [
            {"id": f"b{i}", "fact_id": "f1", "source_ids": [f"f1r{i}"],
             "reason": "离线人工标注工作与原文贡献", "route": copy.deepcopy(route)}
            for i, route in enumerate(raw["advantages"][0]["routes"], 1)],
        "excluded": [],
        "opportunities": [{"fact_id": "f1", "new_point_ids": [],
                           "reason": "仅验证两个给定工作，不声称模型已发现全部需求"}],
        "comparisons": [{"left": "b1", "right": "b2", "relation": relation,
                         "reason": "离线人工比较工作对象及完成标准"}],
    }


def test_actual_failed_input_no_longer_promotes_feature_summaries_to_evidence():
    case = failure_fixture()
    raw = apply_review(case["strategy"], latest_review())
    before = review_input(raw, case["source"], case["title"])
    poisoned = copy.deepcopy(raw)
    for group in poisoned["advantages"]:
        group["fact"] = "只有这个功能，没有其他客户需求"
        group["not_used"] = [{"reason": "其他需求都没有依据"}]
        for route in group["routes"]:
            route.update(title="只讲参数", subtitle="不要找需求", outcome_key="功能即需求",
                         value_bridge="已经证明没有其他工作", visual_brief={"scene": "旧场景"})
    assert review_input(poisoned, case["source"], case["title"]) == before
    # The old executable input builder did propagate those derived labels.
    assert legacy_review_input(poisoned, case["source"], case["title"])[0] != (
        legacy_review_input(raw, case["source"], case["title"])[0])
    assert before["source"] == case["source"]
    assert len(before["draft_jobs_to_challenge"]) == 4
    assert [f["evidence"] for f in before["evidence_index"]] == [
        g["evidence"] for g in raw["advantages"]]


@pytest.mark.parametrize("category,name,fact,jobs,relation,count", [
    ("设备类", "折叠输送机", "可折叠", ("转场搬运", "闲置存放"), "distinct", 2),
    ("配件类", "可拆卸防护罩", "可拆卸", ("接近维护部位", "更换旧防护罩"), "distinct", 2),
    ("耗材类", "独立包装擦拭巾", "独立包装",
     ("分发到不同工位使用", "未使用部分保持封装"), "distinct", 2),
    ("工具类", "地面清洁刷", "用于地面清洁",
     ("完成地面清洁", "维护地面整洁"), "same_result", 1),
])
def test_source_first_full_pipeline_preserves_or_merges_authored_work_outcomes(
        category, name, fact, jobs, relation, count):
    raw = strategy(category, name, fact, jobs)
    verdict = final_verdict(raw, relation)
    first, critic = Mock(return_value=response(raw)), Mock(return_value=response(verdict))
    plan = planner.plan_v2(name + "。" + fact, product_category=category, api_key="offline",
                           http_fn=first, semantic_http_fn=critic,
                           require_demand_first=True, max_retries=2)
    assert first.call_count == critic.call_count == 1
    assert len(plan["selling_points"]) == count
    assert plan["screen_count"] == count + 1
    planning_data = json.loads(first.call_args.args[0]["messages"][1]["content"])
    assert planning_data["source"] == name + "。" + fact
    critic_data = json.loads(critic.call_args.args[0]["messages"][1]["content"])
    assert "facts" not in critic_data  # No old facts-with-candidates nesting.
    assert set(critic_data["evidence_index"][0]) == {"id", "evidence"}
    assert all("outcome_key" not in p and "title" not in p
               for p in critic_data["draft_jobs_to_challenge"])


def test_latest_failure_does_not_become_accepted_by_only_repairing_route_nesting():
    case = failure_fixture()
    raw = apply_review(case["strategy"], latest_review())
    verdict = json.loads((Path(__file__).parent / "fixtures/failed_final_set_review.json")
                         .read_text(encoding="utf-8"))["review"]
    original = copy.deepcopy(verdict)
    for point in verdict["final_points"]:
        point["route"] = {key: point.pop(key) for key in
                          ("audience", "scenario", "need", "benefit", "value_bridge",
                           "outcome_key", "title", "subtitle", "visual_brief")}
    # Nesting alone does not resolve its contradictory source handling.
    with pytest.raises(ValueError, match="矛盾"):
        apply_final_set(raw, verdict)
    first, critic = Mock(return_value=response(raw)), Mock(return_value=response(original))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(case["source"], api_key="offline", http_fn=first,
                        semantic_http_fn=critic, require_demand_first=True, max_retries=2)
    assert first.call_count == critic.call_count == 1


def test_insufficient_facts_can_remain_specs_without_forcing_new_needs():
    raw = strategy("设备类", "测试设备", "额定电压24V")
    raw["advantages"][0]["routes"] = []
    raw["specifications"] = [{"name": "额定电压", "value": "24V", "evidence": "额定电压24V"}]
    verdict = dict(review_version=FINAL_SET_VERSION, final_points=[], excluded=[],
                   opportunities=[dict(fact_id="f1", new_point_ids=[],
                                       reason="电压只供供电匹配，不能推导节能、省钱或安全收益")],
                   comparisons=[])
    plan = planner.plan_v2("测试设备。额定电压24V", api_key="offline", require_demand_first=True,
                           http_fn=Mock(return_value=response(raw)),
                           semantic_http_fn=Mock(return_value=response(verdict)))
    assert not plan["selling_points"]
    assert plan["screen_count"] == 2
