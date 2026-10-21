"""Offline contract tests; fixtures are authored, not model-quality evidence."""
import copy

import pytest

from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.tests.test_product_driven_planning import sample, response


def strategy(category="工具类", name="折叠手推车", fact="可折叠", jobs=("收工携带", "闲置收纳")):
    brief = dict(product_presentation="diagram_only", scene="需求信息图", framing="平面分区",
                 product_action="只用文字与几何图解", visual_evidence="客户工作的结果",
                 layout="标题居上、说明分组")
    routes = [
        dict(audience=audience, scenario=job + "的工作场景", need=job, benefit=job,
             value_bridge=f"{fact}的形态可用于{job}", outcome_key=job, title=job,
             subtitle="", visual_brief=copy.deepcopy(brief))
        for audience, job in zip(("现场使用者", "管理者"), jobs)
    ]
    return dict(strategy_version="fact-routes-v1",
                category_check=dict(category=category, evidence=[name]),
                product_meta=dict(name=name, category=category, primary_color="Image 1 authoritative",
                                  key_visual_parts=["follow reference image"]),
                advantages=[dict(fact=fact, evidence=[fact], routes=routes, not_used=[])],
                specifications=[], style_dna=sample()["style_dna"],
                cover=dict(title=name, subtitle="", evidence=[name],
                           visual_brief={**brief, "product_presentation": "whole_product"}))


@pytest.mark.parametrize("category,name,fact,jobs", [
    ("设备类", "折叠输送机", "可折叠", ("转场运输", "闲置收纳")),
    ("配件类", "可拆卸防护罩", "可拆卸", ("检修接近", "替换防护件")),
    ("耗材类", "可裁切保护膜", "可裁切", ("按区域铺贴", "边角修整")),
    ("工具类", "折叠手推车", "可折叠", ("收工携带", "闲置收纳")),
])
def test_one_fact_compiles_multiple_customer_results_in_one_call(category, name, fact, jobs):
    raw = strategy(category, name, fact, jobs)
    original = copy.deepcopy(raw)
    calls = []
    def post(body, key):
        calls.append(body)
        return response(raw)
    plan = planner.plan_v2(name + "。" + fact, product_category=category, api_key="offline",
                           http_fn=post, require_strategy=True, max_retries=0)
    assert len(calls) == 1
    assert raw == original
    assert "不负责逐页生图指令" in calls[0]["messages"][0]["content"]
    assert "200–1600" not in calls[0]["messages"][0]["content"]
    assert len(plan["selling_points"]) == 2
    assert {p["fact_id"] for p in plan["selling_points"]} == {"f1"}
    assert {p["outcome_key"] for p in plan["selling_points"]} == set(jobs)
    assert plan["screen_count"] == 3
    assert all(len(s["prompt"]) >= 200 for s in plan["screens"])
    assert planner._validate_schema_v2(plan, name + "。" + fact, require_visual_strategy=True) == []


def test_same_fact_relabelled_audience_does_not_purchase_another_page():
    raw = strategy()
    second = raw["advantages"][0]["routes"][1]
    second.update(audience="另一行业使用者", need="移动收起的车", benefit="收工方便带走",
                  outcome_key="收工携带")
    plan = planner.plan_v2("折叠手推车。可折叠", api_key="offline", max_retries=0,
                           require_strategy=True, http_fn=lambda *args: response(raw))
    assert plan["screen_count"] == 2
    assert len(plan["deferred_buying_points"]) == 1
    assert "prompt" not in plan["deferred_buying_points"][0]
    assert len(plan["advantages"][0]["routes"]) == 2


def test_oversized_strategy_shortlisted_before_prompt_rendering():
    raw = strategy()
    route = raw["advantages"][0]["routes"][0]
    raw["advantages"][0]["routes"] = [
        {**copy.deepcopy(route), "need": f"工作{i}", "benefit": f"结果{i}",
         "outcome_key": f"结果{i}", "title": "用途说明" + chr(0x7532 + i)} for i in range(18)]
    plan = planner.plan_v2("折叠手推车。可折叠", api_key="offline", max_retries=0,
                           require_strategy=True, http_fn=lambda *args: response(raw))
    assert plan["screen_count"] == 15
    assert len(plan["deferred_buying_points"]) == 4
    assert all("prompt" not in p for p in plan["deferred_buying_points"])


def test_new_strategy_replay_rejects_old_flat_reply_without_retry():
    calls = []
    def post(*args):
        calls.append(args)
        return response(sample(), fresh=True)
    with pytest.raises(planner.PlannerError, match="必须先按事实"):
        planner.plan_v2("清洁机器人。自动洗地。自动回充。清洁宽度500mm。",
                        api_key="offline", http_fn=post, max_retries=2,
                        require_visual_strategy=False, require_strategy=True)
    assert len(calls) == 1


def test_invalid_fact_evidence_stops_before_images():
    raw = strategy()
    raw["advantages"][0]["evidence"] = ["自动折叠"]
    with pytest.raises(planner.PlannerError, match="原文"):
        planner.plan_v2("折叠手推车。可折叠", api_key="offline", max_retries=0,
                        require_strategy=True, http_fn=lambda *args: response(raw))
