"""Real malformed receipt; authored corrections are explicitly not model QA."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.candidate_plan import parse
from ai_refine_v2.planning_quality import unsupported_outcome_claims
from ai_refine_v2.tests.test_semantic_review import failure_fixture
from ai_refine_v2.tests.test_product_driven_planning import response

FIXTURES = Path(__file__).parent / "fixtures"


def raw_failure():
    return (FIXTURES / "failed_three_layer_planner.txt").read_text(encoding="utf-8")


def expected_review():
    return json.loads((FIXTURES / "authored_three_layer_repair.json").read_text(encoding="utf-8"))["review"]


def replay(review, raw=None):
    case = failure_fixture()
    first = Mock(return_value={"choices": [{"finish_reason": "stop",
                                          "message": {"content": raw if raw is not None else raw_failure()}}]})
    result = planner.plan_v2(case["source"], product_title=case["title"], api_key="offline",
                             http_fn=first, semantic_http_fn=review,
                             require_grounded_copy=True, max_retries=2)
    assert first.call_count == 1
    return result


def test_real_broken_receipt_recovers_all_text_without_guessing_or_rewriting():
    raw, source = raw_failure(), failure_fixture()["source"]
    with pytest.raises(json.JSONDecodeError):
        planner._extract_json(raw)
    restored = parse(raw, source)
    routes = [r for g in restored["advantages"] for r in g["routes"]]
    assert len(routes) == 10
    assert restored["draft_transport"]["recovered_structure"]
    assert all(r["body"] in raw for r in routes)
    assert any("更快恢复通行" in r["body"] for r in routes)  # Not silently cleaned.
    battery = next(s for s in restored["specifications"] if s["name"] == "电池容量")
    assert "未说明配置与续航的对应关系" in battery["value"]


def test_new_flat_transport_uses_same_real_pipeline_without_recovery():
    restored = parse(raw_failure(), failure_fixture()["source"])
    flat = {k: restored[k] for k in ("category_check", "product_meta", "specifications", "style_dna", "cover")}
    flat.update(strategy_version="buyer-candidates-v1",
                candidates=[r for group in restored["advantages"] for r in group["routes"]])
    plan = replay(Mock(return_value=response(expected_review())), json.dumps(flat, ensure_ascii=False))
    assert not plan["draft_transport"]["recovered_structure"]
    assert len(plan["selling_points"]) == 8


@pytest.mark.parametrize("fault", ["missing_root", "unknown_proof", "truncated_route"])
def test_ambiguous_recovery_stops_instead_of_dropping_data(fault):
    raw = raw_failure()
    if fault == "missing_root":
        raw = raw.replace('"cover":', '"missing_cover":')
    elif fault == "unknown_proof":
        raw = raw.replace('"technical_support":["清洗宽度：500mm。"', '"technical_support":["清洗宽度：999mm。"')
    else:
        raw = raw[:raw.index('"title":"局部污渍现场刷洗"') + 12]
    with pytest.raises((ValueError, KeyError)):
        parse(raw, failure_fixture()["source"])


def test_final_reviewer_sees_actual_copy_and_local_claim_findings():
    critic = Mock(return_value=response(expected_review()))
    plan = replay(critic)
    assert critic.call_count == 1
    data = json.loads(critic.call_args.args[0]["messages"][1]["content"])
    risky = next(p for p in data["draft_jobs_to_challenge"] if p["id"] == "f2r1")
    assert "更快恢复通行" in risky["printed_copy_to_audit"]["body"]
    assert any(x["code"] == "unbacked_comparison" for x in risky["known_claim_warnings"])
    assert len(plan["selling_points"]) == 8
    assert plan["screen_count"] == 10
    assert all(s["body"] and s["technical_support"] for s in plan["screens"] if s.get("selling_point_id"))


def test_complete_fields_and_distinct_labels_do_not_override_unsupported_body():
    verdict = expected_review()
    verdict["final_points"][0]["route"]["body"] = "设备让地面更快恢复通行。"
    with pytest.raises(planner.PlannerError, match="unbacked_comparison"):
        replay(Mock(return_value=response(verdict)))


def test_scene_relabels_cannot_restore_the_eight_point_floor_after_merging():
    verdict = expected_review()
    verdict["comparisons"][0].update(relation="same_result", reason="去掉职业与场所后是同一结果")
    with pytest.raises(planner.PlannerError, match="未达到8"):
        replay(Mock(return_value=response(verdict)))


def test_claim_guard_is_not_a_product_lookup_and_allows_actual_source_evidence():
    assert unsupported_outcome_claims("动力更强，现场插座随便接。", "额定电压36V，电机功率500W")
    assert not unsupported_outcome_claims("在所列测试条件下处理更快。", "在所列测试条件下处理更快。")
    assert unsupported_outcome_claims("处理更快。", "未证明处理更快。")
    assert unsupported_outcome_claims("地面更快恢复通行。", "充电更快。")
    assert unsupported_outcome_claims("地面更快恢复通行。", "资料不能证明地面更快恢复通行。")
    assert not unsupported_outcome_claims("机械刷洗为人员提供帮助。", "配置机械刷盘")
