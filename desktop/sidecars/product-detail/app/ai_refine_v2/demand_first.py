"""Source-first demand discovery shared by planning and independent review.

No product lookup table and no local claim of semantic understanding. Draft
marketing classifications are deliberately not promoted to evidence.
"""
import json
from prompt_ref import prompt_ref

METHOD = prompt_ref("detail.demand.method")


def review_input(strategy, source, title):
    """Evidence first; isolate old jobs from their model-authored feature framing."""
    facts, drafts = [], []
    for i, group in enumerate(strategy["advantages"], 1):
        fid = f"f{i}"
        facts.append({"id": fid, "evidence": group["evidence"]})
        for j, route in enumerate(group["routes"], 1):
            drafts.append({"id": f"{fid}r{j}", "fact_id": fid,
                           **{key: route.get(key) for key in
                              ("audience", "scenario", "need", "benefit")}})
    return {"source": source, "title": title, "evidence_index": facts,
            "draft_jobs_to_challenge": drafts}


ROUTE = {
    "audience": "具体工作承担者", "scenario": "触发这个工作的处境",
    "need": "不依赖产品名称而存在的客户工作", "benefit": "产品有依据的贡献",
    "value_bridge": "原文能力如何支持这个工作，不重复功能",
    "outcome_key": "工作对象与完成结果", "title": "客户收益标题", "subtitle": "有据的支撑",
    "visual_brief": {"product_presentation": "diagram_only", "scene": "相容处境",
                     "framing": "平面图解", "product_action": "有据动作",
                     "visual_evidence": "该工作结果的示意，不画未知结构", "layout": "图文布局"},
}

REVIEW_PROMPT = (
    prompt_ref("detail.demand.review_intro")
    + METHOD +
    prompt_ref("detail.demand.review_steps")
    + json.dumps({
        "review_version": "semantic-final-set-v1",
        "final_points": [{"id": "b1", "fact_id": "f1", "source_ids": ["f1r1"],
                          "reason": "客户工作与产品贡献的因果依据", "route": ROUTE}],
        "excluded": [],
        "opportunities": [{"fact_id": "f1", "new_point_ids": [],
                           "reason": "实际探索的其他工作及成立或不成立的具体原因"}],
        "comparisons": [],
    }, ensure_ascii=False)
    + "\n示例只有一项所以comparisons为空；多项时必须给齐全部两两比较。"
)
