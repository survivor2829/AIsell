"""Offline wiring assertions; authored outcomes do not prove model copy quality."""
import copy
import json
from itertools import combinations
from unittest.mock import Mock

import pytest
from PIL import Image

from ai_refine_v2 import refine_planner as planner, refine_generator as generator, pipeline_runner as runner
from ai_refine_v2.buyer_copy import include_spec_evidence, copy_fields
from ai_refine_v2.tests.test_buyer_strategy import strategy
from ai_refine_v2.tests.test_product_driven_planning import response
from ai_refine_v2.tests.test_demand_first import final_verdict


def case(count=8, *, sparse=False):
    raw = strategy()
    seed = raw["advantages"][0]["routes"][0]
    raw["advantages"][0]["routes"] = [
        {**copy.deepcopy(seed), "need": f"工作对象{chr(0x7532+i)}",
         "benefit": f"帮助处理工作{chr(0x7532+i)}", "title": f"工作帮助{chr(0x7532+i)}",
         "body": "收起工具后再移动，现场携带有帮助。",
         "technical_support": ["可折叠"], "outcome_key": f"工作结果{chr(0x7532+i)}"}
        for i in range(count)]
    verdict = final_verdict(raw, "distinct")
    verdict["comparisons"] = [
        dict(left=a["id"], right=b["id"], relation="distinct", reason="人工注入用于检查编排，不代表模型语义通过")
        for a, b in combinations(verdict["final_points"], 2)]
    verdict["material_assessment"] = dict(level="sparse" if sparse else "normal",
                                        reason="仅给一种功能" if sparse else "已有明确用途及功能资料")
    return raw, verdict


def run(raw, verdict, source="折叠手推车。可折叠。用于现场搬运与仓库存放。"):
    first, critic = Mock(return_value=response(raw)), Mock(return_value=response(verdict))
    result = planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=critic,
                             require_buyer_copy=True, max_retries=2)
    assert first.call_count == critic.call_count == 1
    return result


def test_eight_buying_screens_reach_final_image_text_authority(tmp_path):
    plan = run(*case())
    assert len(plan["selling_points"]) == 8
    assert plan["screen_count"] == 9  # Hero is not counted toward eight.
    reference = tmp_path / "reference.png"
    Image.new("RGB", (40, 40), "white").save(reference)
    received = []
    def image_call(prompt, *args, **kwargs):
        received.append(prompt)
        return "https://example.invalid/offline.png"
    result = generator.generate_v2(plan, str(reference), api_key="offline", api_call_fn=image_call,
                                    cutout_whitelist=[], concurrency=1)
    assert len(result.blocks) == 9
    for prompt in received[1:]:
        authority = prompt.split("FINAL FACT AND TEXT AUTHORITY:")[-1]
        assert "收起工具后再移动" in authority
        assert '"technical_support": ["可折叠"]' in authority
        assert "three layers" in authority


@pytest.mark.parametrize("fault", ["too_few", "duplicate", "fake_sparse", "missing_body", "fake_proof"])
def test_invalid_normal_copy_stops_without_retry(fault):
    raw, verdict = case(7 if fault in ("too_few", "fake_sparse") else 8)
    if fault == "duplicate":
        verdict["comparisons"][0]["relation"] = "same_result"
    elif fault == "fake_sparse":
        verdict["material_assessment"]["level"] = "sparse"
    elif fault == "missing_body":
        del verdict["final_points"][0]["route"]["body"]
    elif fault == "fake_proof":
        verdict["final_points"][0]["route"]["technical_support"] = ["承重100公斤"]
    first, critic = Mock(return_value=response(raw)), Mock(return_value=response(verdict))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2("折叠手推车。可折叠。用于现场搬运与仓库存放。", api_key="offline",
                        http_fn=first, semantic_http_fn=critic, require_buyer_copy=True, max_retries=2)
    assert first.call_count == critic.call_count == 1


def test_sparse_exception_is_explicit_and_does_not_invent_pages():
    plan = run(*case(2, sparse=True), source="折叠手推车，可折叠")
    assert plan["screen_count"] == 3
    assert plan["quantity_review"]["sparse_exception"] is True


def test_fifteen_total_limit_is_applied_before_any_image_request():
    raw, verdict = case(15)
    raw["specifications"] = [{"name": "功能", "value": "可折叠", "evidence": "可折叠"}]
    plan = run(raw, verdict)
    assert plan["screen_count"] == 15
    assert len(plan["selling_points"]) == 13
    assert len(plan["deferred_buying_points"]) == 2
    assert all("prompt" not in p for p in plan["deferred_buying_points"])


def test_unused_original_specs_remain_available_for_review():
    raw, _ = case()
    raw["specifications"] = [{"name": "承重", "value": "100kg", "evidence": "额定承重100kg"}]
    before = copy.deepcopy(raw)
    expanded = include_spec_evidence(raw)
    assert raw == before
    assert expanded["advantages"][-1]["evidence"] == ["额定承重100kg"]
    assert not expanded["advantages"][-1]["routes"]  # Evidence is not auto-created buying copy.


def test_parameter_support_cannot_drop_maximum_qualifier():
    with pytest.raises(ValueError, match="技术支撑"):
        copy_fields({"body": "设备参与刷洗。", "technical_support": ["270 RPM"]},
                    ["刷盘转速最高270 RPM"])


@pytest.mark.parametrize("fault", ["short_points", "missing_screen"])
def test_recovered_short_plan_stops_before_quote_or_image_submission(tmp_path, monkeypatch, fault):
    plan = run(*case())
    if fault == "short_points":
        plan["selling_points"].pop()
    else:
        plan["screens"].pop()
        plan["screen_count"] -= 1
    runner._atomic_write_json(tmp_path / "_quality_policy.json", {"version": 7})
    quote = Mock(side_effect=AssertionError("must stop before quote"))
    monkeypatch.setattr("ai_refine_v2.pricing.read_quote", quote)
    with pytest.raises(ValueError, match="未达到8|图片队列不一致"):
        runner._run_real_generator_v2(plan, "reference.png", "offline", tmp_path, None)
    quote.assert_not_called()
