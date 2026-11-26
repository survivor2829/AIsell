"""Discover customer work before commissioning any advertising copy.

The first operation supplies an editorial brief, not a near-finished advert for
the second operation to defend. Evidence grouping is only a compiler adapter.
"""
import copy
import json
from prompt_ref import prompt_ref

VERSION = "customer-work-v1"
ROOTS = ("category_check", "product_meta", "specifications", "style_dna", "cover")
WORK_FIELDS = ("audience", "scenario", "need", "completion_test", "stakes",
               "benefit", "value_bridge")

METHOD = prompt_ref("detail.customer_work.method")


def prompt():
    return (
        prompt_ref("detail.customer_work.stage1_intro")
        + METHOD +
        prompt_ref("detail.customer_work.stage1_rules") + json.dumps({
            "strategy_version": VERSION,
            "category_check": {"category": "实际品类", "evidence": ["原文"]},
            "product_meta": {"name": "原产品名", "category": "实际品类",
                             "primary_color": "Image 1 authoritative",
                             "key_visual_parts": ["follow reference image only"]},
            "jobs": [{**{k: k for k in WORK_FIELDS}, "evidence": ["完整原文"]}],
            "specifications": [{"name": "原参数名", "value": "原值含限定", "evidence": "完整原文"}],
            "style_dna": {"color_palette": "统一配色", "lighting": "光照",
                          "composition_style": "清晰层级", "mood": "专业",
                          "typography_hint": "手机可读", "unified_visual_treatment": "统一图解"},
            "cover": {"title": "产品定位", "subtitle": "", "evidence": ["原产品名"],
                      "visual_brief": {"product_presentation": "diagram_only",
                                       "scene": "产品定位", "framing": "平面图解",
                                       "product_action": "无", "visual_evidence": "原文用途",
                                       "layout": "图文布局"}},
        }, ensure_ascii=False))


def parse(raw, source):
    from .refine_planner import _extract_json
    data = _extract_json(raw)
    if data.get("strategy_version") != VERSION:
        raise ValueError("第一阶段必须交付客户工作简报，不能用功能广告稿代替")
    result = {k: copy.deepcopy(data[k]) for k in ROOTS}
    # The editor only rewrites jobs. Reject uneditable layout metadata before
    # paying it, rather than discovering a broken cover after the second call.
    for key in ("category_check", "product_meta", "style_dna", "cover"):
        if not isinstance(result[key], dict):
            raise ValueError(f"{key}必须为对象，尚未提交需求编辑")
    required_text = {
        "product_meta": ("name", "category"),
        "style_dna": ("color_palette", "lighting", "composition_style", "mood",
                      "typography_hint", "unified_visual_treatment"),
        "cover": ("title",),
    }
    for key, fields in required_text.items():
        if not all(isinstance(result[key].get(k), str) and result[key][k].strip() for k in fields):
            raise ValueError(f"{key}缺少排版所需内容")
    cover = result["cover"]
    if not isinstance(cover.get("visual_brief"), dict) or not all(
        isinstance(cover["visual_brief"].get(k), str) and cover["visual_brief"][k].strip()
        for k in ("product_presentation", "scene", "framing", "product_action", "visual_evidence", "layout")
    ):
        raise ValueError("封面缺少完整画面意图")
    if not isinstance(cover.get("evidence"), list) or not cover["evidence"] or not all(
        isinstance(q, str) and q.strip() and q in source for q in cover["evidence"]
    ):
        raise ValueError("封面原文依据无效")
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not 1 <= len(jobs) <= 30:
        raise ValueError("客户工作简报须为1至30项")
    result.update(strategy_version="fact-routes-v1", customer_work_version=VERSION, advantages=[])
    for job in jobs:
        if not isinstance(job, dict) or not all(
            isinstance(job.get(k), str) and job[k].strip() for k in WORK_FIELDS
        ):
            raise ValueError("工作简报缺少客户完成标准或购买意义")
        if any(k in job for k in ("title", "body", "visual_brief")):
            raise ValueError("客户工作简报不能混入预写广告稿")
        proof = job.get("evidence")
        if not isinstance(proof, list) or not 1 <= len(proof) <= 3 or not all(
            isinstance(q, str) and q.strip() and q in source for q in proof
        ):
            raise ValueError("客户工作贡献的原文依据无效")
        # One brief owns one route; no parameter-based merging before review.
        result["advantages"].append({
            "fact": "；".join(proof), "evidence": list(proof),
            "routes": [{k: job[k] for k in WORK_FIELDS}], "not_used": [],
        })
    if not isinstance(result["specifications"], list):
        raise ValueError("缺少完整规格列表")
    for spec in result["specifications"]:
        if not isinstance(spec, dict) or not all(
            isinstance(spec.get(k), str) and spec[k].strip() for k in ("name", "value", "evidence")
        ) or spec["evidence"] not in source or spec["value"] not in spec["evidence"]:
            raise ValueError("规格原值或依据无效")
    from .candidate_plan import restore_spec_values
    restore_spec_values(result["specifications"], source)
    return result


def editorial_input(strategy, source, title):
    """Customer obligations lead the input; evidence is a reference appendix."""
    jobs, evidence = [], []
    for i, group in enumerate(strategy["advantages"], 1):
        fid = f"f{i}"
        evidence.append({"id": fid, "evidence": group["evidence"]})
        for j, route in enumerate(group["routes"], 1):
            jobs.append({"id": f"{fid}r{j}", "fact_id": fid,
                         **{k: route[k] for k in WORK_FIELDS}})
    return {"source": source, "title": title, "customer_jobs_to_edit": jobs,
            "evidence_index": evidence}


def review_prompt():
    from .demand_first import ROUTE
    from .buyer_copy import RULES
    return (
        prompt_ref("detail.customer_work.stage2_intro")
        + METHOD +
        prompt_ref("detail.customer_work.stage2_rules")
        + RULES +
        prompt_ref("detail.customer_work.stage2_keys")
        + json.dumps({
            "review_version": "semantic-final-set-v1",
            "final_points": [{"id": "b1", "fact_id": "f1", "source_ids": ["f1r1"],
                              "reason": "客户责任、完成标准与产品贡献",
                              "route": {**ROUTE, "body": "先说客户得到的帮助",
                                        "technical_support": ["完整原文"]}}],
            "excluded": [{"id": "未被承接的原简报id", "reason": "具体原因"}],
            "opportunities": [{"fact_id": "f1", "new_point_ids": [], "reason": "实际探索结论"}],
            "comparisons": [{"left": "最终idA", "right": "最终idB", "relation": "distinct",
                             "reason": "A完成而B仍未完成的具体情形；反向也核对"}],
            "material_assessment": {"level": "normal", "reason": "原始资料是否特别少"},
        }, ensure_ascii=False)
    )
