"""Offline orchestration checks, explicitly not evidence of model quality."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from ai_refine_v2.customer_work import parse
from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.planning_quality import unsupported_outcome_claims
from ai_refine_v2.tests.test_product_driven_planning import response
from ai_refine_v2.tests.test_semantic_review import failure_fixture

FIXTURES = Path(__file__).parent / "fixtures"


def authored():
    return json.loads((FIXTURES / "customer_work_editorial.json").read_text(encoding="utf-8"))


def replay(brief, review):
    first, editor = Mock(return_value=response(brief)), Mock(return_value=response(review))
    case = failure_fixture()
    plan = planner.plan_v2(case["source"], product_title=case["title"], api_key="offline",
                           http_fn=first, semantic_http_fn=editor,
                           require_customer_work=True, max_retries=2)
    assert first.call_count == editor.call_count == 1
    return plan, first, editor


def test_work_precedes_copy_and_whole_set_editor_receives_customer_completion_tests():
    fixture = authored()
    plan, first, editor = replay(fixture["brief"], fixture["review"])
    data = json.loads(editor.call_args.args[0]["messages"][1]["content"])
    assert "draft_jobs_to_challenge" not in data
    assert all("title" not in j and "body" not in j for j in data["customer_jobs_to_edit"])
    assert all(j["completion_test"] and j["stakes"] for j in data["customer_jobs_to_edit"])
    assert "customer-work-v1" in first.call_args.args[0]["messages"][0]["content"]
    assert len(plan["selling_points"]) == 8 and plan["screen_count"] == 10
    assert plan["screens"][2]["title"] == fixture["review"]["final_points"][1]["route"]["title"]


def test_actual_failed_review_is_not_eight_valid_points_just_because_it_has_all_pairs():
    raw = json.loads((FIXTURES / "failed_work_review.json").read_text(encoding="utf-8"))
    actual = json.loads(raw["choices"][0]["message"]["content"])
    assert len(actual["final_points"]) == 8 and len(actual["comparisons"]) == 28
    # A concrete unsupported printed claim survives its own "distinct" verdict.
    assert unsupported_outcome_claims(
        actual["final_points"][0]["route"]["body"], failure_fixture()["source"])
    fixture = authored()
    fixture["review"]["final_points"][0]["route"]["body"] = actual["final_points"][0]["route"]["body"]
    with pytest.raises(planner.PlannerError, match="unbacked_comparison"):
        replay(fixture["brief"], fixture["review"])


def test_merging_reception_and_delivery_still_enforces_effective_count():
    fixture = authored()
    pair = next(p for p in fixture["review"]["comparisons"]
                if {p["left"], p["right"]} == {"b2", "b3"})
    pair.update(relation="same_result", reason="假设编辑认为二者实际同一结果")
    with pytest.raises(planner.PlannerError, match="未达到8"):
        replay(fixture["brief"], fixture["review"])


def test_reject_preprinted_ad_before_editor_and_preserve_spec_conditions():
    fixture = authored()
    source = failure_fixture()["source"]
    spec = next(s for s in fixture["brief"]["specifications"] if s["name"] == "刷盘转速")
    spec["value"] = "270 RPM"
    parsed = parse(json.dumps(fixture["brief"], ensure_ascii=False), source)
    assert next(s for s in parsed["specifications"] if s["name"] == "刷盘转速")["value"] == "最高270 RPM"
    fixture["brief"]["jobs"][0]["title"] = "预写广告"
    editor = Mock()
    with pytest.raises(planner.PlannerError, match="不能混入预写广告"):
        planner.plan_v2(source, api_key="offline", require_customer_work=True,
                        http_fn=Mock(return_value=response(fixture["brief"])) ,
                        semantic_http_fn=editor)
    editor.assert_not_called()


def test_uneditable_cover_is_rejected_before_second_charge():
    fixture = authored()
    fixture["brief"]["cover"] = None
    editor = Mock()
    with pytest.raises(planner.PlannerError, match="cover必须为对象"):
        planner.plan_v2(failure_fixture()["source"], api_key="offline", require_customer_work=True,
                        http_fn=Mock(return_value=response(fixture["brief"])),
                        semantic_http_fn=editor)
    editor.assert_not_called()
