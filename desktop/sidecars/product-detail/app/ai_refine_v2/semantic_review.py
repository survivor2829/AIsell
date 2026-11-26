"""Independent semantic review, with explicit decisions and no retry loop.

Local code validates/apply decisions; it does not pretend string distance is
semantic understanding. HTTP is injected and charged in its own journal entry.
"""
import copy
import json
from itertools import combinations
from prompt_ref import prompt_ref

FINAL_SET_VERSION = "semantic-final-set-v1"

FINAL_SET_PROMPT = prompt_ref("detail.review.final_set")

SYSTEM_PROMPT = prompt_ref("detail.review.system")


def review_input(strategy, source, title):
    facts, routes = [], {}
    for i, group in enumerate(strategy["advantages"], 1):
        fid = f"f{i}"
        candidates = []
        for j, route in enumerate(group["routes"], 1):
            rid = f"{fid}r{j}"
            routes[rid] = (i - 1, route)
            candidates.append({"id": rid, **{k: route.get(k) for k in (
                "audience", "scenario", "need", "benefit", "value_bridge", "outcome_key", "title", "subtitle")}})
        facts.append({"id": fid, "fact": group["fact"], "evidence": group["evidence"], "candidates": candidates})
    return {"source": source, "title": title, "facts": facts}, routes


def apply_review(strategy, review):
    _, routes = review_input(strategy, "", "")
    if not isinstance(review, dict):
        raise ValueError("语义评审必须为JSON对象")
    decisions = review.get("decisions")
    additions = review.get("additions", [])
    if not isinstance(decisions, list) or not isinstance(additions, list):
        raise ValueError("语义评审必须返回逐项结论和补充需求数组")
    by_id = {}
    for decision in decisions:
        if not isinstance(decision, dict):
            raise ValueError("语义结论必须为对象")
        rid = decision.get("id")
        if not isinstance(rid, str) or rid not in routes or rid in by_id:
            raise ValueError("语义评审候选id未知或重复")
        if decision.get("action") not in {"keep", "merge", "revise", "spec_only", "unsupported"}:
            raise ValueError("未知语义处理动作")
        if not isinstance(decision.get("reason"), str) or not decision["reason"].strip():
            raise ValueError("语义结论必须说明需求、收益及依据关系")
        by_id[rid] = decision
    if set(by_id) != set(routes):
        raise ValueError("语义评审遗漏候选，尚未提交生图")
    result = copy.deepcopy(strategy)
    for group in result["advantages"]:
        group["routes"] = []
    retained = {}
    for rid, (index, original) in routes.items():
        decision = by_id[rid]
        action = decision["action"]
        if action in {"keep", "revise"}:
            route = copy.deepcopy(original if action == "keep" else decision.get("revision"))
            if not isinstance(route, dict):
                raise ValueError("改写必须给出完整需求与画面意图")
            result["advantages"][index]["routes"].append(route)
            retained[rid] = route
        else:
            result["advantages"][index].setdefault("not_used", []).append(
                {"audience": original["audience"], "need": original["need"],
                 "reason": decision["reason"], "action": action})
    for rid, decision in by_id.items():
        if decision["action"] == "merge":
            target = decision.get("target")
            if not isinstance(target, str) or target == rid or target not in retained:
                raise ValueError("合并必须指向直接保留的候选，不允许链或环")
            retained[target].setdefault("covered_audiences", []).append(routes[rid][1]["audience"])
    for addition in additions:
        if not isinstance(addition, dict) or not isinstance(addition.get("reason"), str) or not addition["reason"].strip():
            raise ValueError("补充需求必须说明差异及依据")
        facts = {f"f{i + 1}": group for i, group in enumerate(result["advantages"])}
        fid = addition.get("fact_id")
        if not isinstance(fid, str) or fid not in facts or not isinstance(addition.get("route"), dict):
            raise ValueError("补充需求只能引用已有产品事实")
        facts[fid]["routes"].append(copy.deepcopy(addition["route"]))
    # Validate all revisions through the same compiler before any page is made.
    from .buyer_strategy import compile_strategy
    compile_strategy(result)
    result["semantic_review"] = copy.deepcopy(review)
    return result


def apply_final_set(strategy, review):
    """Apply whole-set comparisons after all edits, without semantic regexes."""
    if not isinstance(review, dict) or review.get("review_version") != FINAL_SET_VERSION:
        raise ValueError("复核必须交付改写后的整套买点及最终比较")
    _, original = review_input(strategy, "", "")
    facts = {f"f{i + 1}": i for i in range(len(strategy["advantages"]))}
    points = review.get("final_points")
    if not isinstance(points, list) or len(points) > 15:
        raise ValueError("最终买点必须为最多15项的数组")
    indexed, used_sources, new_ids = {}, set(), set()
    for point in points:
        if not isinstance(point, dict):
            raise ValueError("最终买点必须为对象")
        pid, fid = point.get("id"), point.get("fact_id")
        if not isinstance(pid, str) or not pid.strip() or pid in indexed:
            raise ValueError("最终买点id缺失或重复")
        if not isinstance(fid, str) or fid not in facts or not isinstance(point.get("route"), dict):
            raise ValueError("最终买点必须关联已有事实并给出完整内容")
        sources = point.get("source_ids")
        if not isinstance(sources, list) or any(not isinstance(s, str) or s not in original for s in sources):
            raise ValueError("最终买点引用了未知原候选")
        if not isinstance(point.get("reason"), str) or not point["reason"].strip():
            raise ValueError("最终买点缺少事实与需求说明")
        used_sources.update(sources)
        if not sources:
            new_ids.add(pid)
        indexed[pid] = point
    excluded = review.get("excluded")
    if not isinstance(excluded, list):
        raise ValueError("复核缺少原候选处理记录")
    excluded_ids = set()
    for item in excluded:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item["id"] not in original:
            raise ValueError("排除记录引用未知原候选")
        if item["id"] in excluded_ids or item["id"] in used_sources or not isinstance(item.get("reason"), str) or not item["reason"].strip():
            raise ValueError("原候选处理重复、矛盾或缺少理由")
        excluded_ids.add(item["id"])
    if used_sources | excluded_ids != set(original):
        raise ValueError("整套复核遗漏原候选")
    opportunities = review.get("opportunities")
    if not isinstance(opportunities, list):
        raise ValueError("必须核查各事实遗漏的不同需求")
    checked_facts, accounted_new = set(), set()
    for item in opportunities:
        if not isinstance(item, dict):
            raise ValueError("需求补充记录必须为对象")
        fid, added = item.get("fact_id"), item.get("new_point_ids")
        if not isinstance(fid, str) or fid not in facts or fid in checked_facts:
            raise ValueError("需求探索必须逐项对应已有事实")
        if not isinstance(item.get("reason"), str) or not item["reason"].strip() or not isinstance(added, list):
            raise ValueError("需求探索缺少具体结论")
        if any(not isinstance(pid, str) or pid not in new_ids or indexed[pid]["fact_id"] != fid for pid in added):
            raise ValueError("新增需求与原文事实关联错误")
        accounted_new.update(added)
        checked_facts.add(fid)
    if checked_facts != set(facts) or accounted_new != new_ids:
        raise ValueError("没有完成整套事实的需求补充核查")
    comparisons = review.get("comparisons")
    if not isinstance(comparisons, list):
        raise ValueError("缺少改写后整套买点的逐对比较")
    expected = {frozenset(pair) for pair in combinations(indexed, 2)}
    seen, same, distinct = set(), [], []
    for item in comparisons:
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ("left", "right", "reason")):
            raise ValueError("最终比较必须有两个id和具体理由")
        pair = frozenset((item["left"], item["right"]))
        if pair not in expected or pair in seen or not item["reason"].strip():
            raise ValueError("最终比较缺项、重复或引用非最终买点")
        seen.add(pair)
        if item.get("relation") == "same_result":
            same.append((item["left"], item["right"]))
        elif item.get("relation") == "distinct":
            distinct.append((item["left"], item["right"]))
        else:
            raise ValueError("最终关系只能为distinct或same_result")
    if seen != expected:
        raise ValueError("必须比较改写及补充后的所有买点对")
    parent = {pid: pid for pid in indexed}
    def root(pid):
        while parent[pid] != pid:
            pid = parent[pid]
        return pid
    for left, right in same:
        parent[root(right)] = root(left)
    if any(root(a) == root(b) for a, b in distinct):
        raise ValueError("最终语义判断矛盾，同组结果又被判为不同")
    result = copy.deepcopy(strategy)
    for group in result["advantages"]:
        group["routes"] = []
    groups = {}
    for pid, point in indexed.items():
        groups.setdefault(root(pid), []).append(point)
    for members in groups.values():
        chosen = members[0]  # Highest-ranked original content; no post-review rewrite.
        route = copy.deepcopy(chosen["route"])
        route["covered_audiences"] = [p["route"].get("audience", "") for p in members]
        route["review_point_ids"] = [p["id"] for p in members]
        result["advantages"][facts[chosen["fact_id"]]]["routes"].append(route)
    from .buyer_strategy import compile_strategy
    # Validate excluded-by-merge revisions too: comparison cannot hide malformed content.
    all_points = copy.deepcopy(strategy)
    for group in all_points["advantages"]:
        group["routes"] = []
    for point in points:
        all_points["advantages"][facts[point["fact_id"]]]["routes"].append(point["route"])
    compile_strategy(all_points)
    compile_strategy(result)
    result["semantic_review"] = copy.deepcopy(review)
    return result


def review_strategy(strategy, source, title, api_key, http_fn, *, final_set=False, demand_first=False,
                    buyer_copy=False, grounded_copy=False, customer_work=False):
    from .refine_planner import _MODEL_DEFAULT, _extract_json
    data, _ = review_input(strategy, source, title)
    prompt = FINAL_SET_PROMPT if final_set else SYSTEM_PROMPT
    if demand_first:
        from .demand_first import review_input as source_first_input, REVIEW_PROMPT
        data = source_first_input(strategy, source, title)
        prompt = REVIEW_PROMPT
        final_set = True
    if buyer_copy:
        from .buyer_copy import RULES, screen_budget
        prompt += "\n" + RULES + '\nroute附加字段示意：{"body":"解释客户得到什么帮助","technical_support":["完整原文支撑"]}'
        data["screen_budget"] = screen_budget(source, bool(strategy.get("specifications")))
    if grounded_copy and not customer_work:
        from .planning_quality import unsupported_outcome_claims
        _, routes = review_input(strategy, source, title)
        for draft in data["draft_jobs_to_challenge"]:
            route = routes[draft["id"]][1]
            draft["printed_copy_to_audit"] = {
                k: route.get(k) for k in ("title", "body", "technical_support")}
            draft["known_claim_warnings"] = unsupported_outcome_claims(
                "。".join(str(route.get(k) or "") for k in ("title", "body", "need", "benefit")), source)
        prompt += prompt_ref("detail.review.printed_copy")
    if customer_work:
        from .customer_work import editorial_input, review_prompt
        from .buyer_copy import screen_budget
        data = editorial_input(strategy, source, title)
        data["screen_budget"] = screen_budget(source, bool(strategy.get("specifications")))
        prompt = review_prompt()
        final_set = True
    body = {"model": _MODEL_DEFAULT, "thinking": {"type": "disabled"},
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": json.dumps(data, ensure_ascii=False)}],
            "temperature": 0.2, "max_tokens": 12000 if final_set else 8000, "response_format": {"type": "json_object"}}
    response = http_fn(body, api_key)  # Exactly once; journal owns unknown outcomes.
    if response["choices"][0].get("finish_reason") == "length":
        raise ValueError("语义评审被截断，不重试、不提交生图")
    review = _extract_json(response["choices"][0]["message"]["content"])
    return apply_final_set(strategy, review) if final_set else apply_review(strategy, review)
