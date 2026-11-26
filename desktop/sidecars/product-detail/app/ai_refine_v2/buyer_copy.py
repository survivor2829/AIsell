"""The approved three-layer copy and grounded 8–15 screen contract."""
import re
import copy
from prompt_ref import prompt_ref

VERSION = "benefit-explanation-proof-v1"
MIN_BUYING_POINTS = 8

RULES = prompt_ref("detail.buyer_copy.rules")


def screen_budget(source, has_specs):
    # Conservative eligibility, not a semantic quality score. A model cannot
    # call a rich input "sparse" merely because it found few routes.
    units = [s.strip() for s in re.split(r"[，,。；;\n]+", source) if s.strip()]
    sparse = len(units) <= 2 and len(re.findall(r"[:：]", source)) <= 2 and len(source) <= 160
    return {"minimum_buying_points": MIN_BUYING_POINTS,
            "maximum_buying_points": 15 - 1 - int(has_specs),
            "maximum_total_screens": 15, "sparse_exception_eligible": sparse}


def copy_fields(route, evidence):
    body, proof = route.get("body"), route.get("technical_support")
    if not isinstance(body, str) or not body.strip() or len(body) > 120:
        raise ValueError("买点缺少120字内的大白话解释")
    if not isinstance(proof, list) or not 1 <= len(proof) <= 3 or not all(
        isinstance(item, str) and item.strip()
        and any(item.strip() == quote.strip() for quote in evidence) for item in proof
    ):
        raise ValueError("技术支撑必须为1至3条对应事实的原文摘录，不能编造参数")
    return {"body": body, "technical_support": list(proof)}


def include_spec_evidence(strategy, *, source=None):
    """Expose provided capabilities omitted by the first draft, without inventing facts."""
    result = copy.deepcopy(strategy)
    quotes = {q for group in result["advantages"] for q in group["evidence"]}
    for spec in result["specifications"]:
        quote = spec.get("evidence")
        if isinstance(quote, str) and quote.strip() and quote not in quotes:
            result["advantages"].append(
                {"fact": spec["name"], "evidence": [quote], "routes": [], "not_used": []})
            quotes.add(quote)
    if source is not None:
        # Recovery must not trap the critic inside the failed draft's chosen
        # parameters. Also index omitted original purpose/material statements.
        for fragment in re.split(r"(?<=[。；;\n])", source):
            quote = fragment.strip()
            if quote and not any(quote in existing for existing in quotes):
                result["advantages"].append(
                    {"fact": quote, "evidence": [quote], "routes": [], "not_used": []})
                quotes.add(quote)
    return result


def validate_quantity(plan, source):
    budget = screen_budget(source, bool(plan.get("specifications")))
    assessment = (plan.get("semantic_review") or {}).get("material_assessment")
    if not isinstance(assessment, dict) or assessment.get("level") not in ("normal", "sparse") or not (
        isinstance(assessment.get("reason"), str) and assessment["reason"].strip()
    ):
        raise ValueError("缺少资料充分度判断，不能默认按资料稀少放行")
    sparse = assessment["level"] == "sparse"
    if sparse and not budget["sparse_exception_eligible"]:
        raise ValueError("原文不属于明显稀少资料，不能借此跳过8个买点要求")
    count = len(plan["selling_points"])
    if count < MIN_BUYING_POINTS and not sparse:
        raise ValueError(f"正常资料去重后只有{count}个买点，未达到8个；尚未提交生图，不自动重试")
    if not count:
        raise ValueError("没有有效买点，不能用封面和参数表代替买点图")
    plan["buyer_copy_version"] = VERSION
    plan["quantity_review"] = {"buying_point_count": count, "total_screens": plan["screen_count"],
                              "sparse_exception": sparse, "reason": assessment["reason"]}
