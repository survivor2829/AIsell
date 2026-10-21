"""The approved three-layer copy and grounded 8–15 screen contract."""
import re
import copy

VERSION = "benefit-explanation-proof-v1"
MIN_BUYING_POINTS = 8

RULES = """
本轮采用客户已确认的表达：客户收益＋大白话解释＋关键参数/技术支撑。
每个route保留title为客户收益标题；body用1—3句、最多120字解释给谁什么帮助；
technical_support为1—3条原文逐字摘录，保留技术名称、数值、单位、配置或范围条件。
没有数值的卖点可以摘录原文功能/材料说明，不能编造参数。subtitle留空，避免重复正文。
不要把参数全藏起来，也不要把标题写成参数表。每屏只解决一个明确的购买问题。
同一功能可以分别回应操作者的劳动帮助、经营者的环境体验、服务商的交付要求等：
实际责任与期望结果不同就可分开，不能仅因共用参数或同一物理动作而合并。
但换职业名称、场所、同义标题，而实际问题与所得帮助没有变化的，必须合并。
正常资料至少8个有效买点；封面和参数表不抵最低数量，整套最多15张。
先展开候选、完成最终语义比较再精选，避免重复凑数；不要先生成图片再筛选。
每条原文能力都要考虑有据的不同客户收益，不能只围绕旧稿已选功能打转。
仅当screen_budget.sparse_exception_eligible为true且原文确实特别少，
才可输出material_assessment={"level":"sparse","reason":"具体缺少哪些事实，为什么无法展开"}；
其他情况用{"level":"normal","reason":"依据原文探索需求"}。
如果正常资料仍不足8个，保留真实结果，程序将拦截不足，不虚构、不用定位/须知凑数。
最终数量以去重后的有效买点为准。technical_support逐条复制该买点evidence中的完整条目，
不能截掉“最高、额定、范围、配置条件”等限定再冒充普通数值。
"""


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
