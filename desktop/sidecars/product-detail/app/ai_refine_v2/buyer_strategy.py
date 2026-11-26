"""One paid buyer-strategy response; local, deterministic page compilation.

The model does not write page prompts. A fact owns multiple customer routes;
the existing selector caps/deduplicates routes before render instructions exist.
"""
import copy
import json
from prompt_ref import prompt_ref

VERSION = "fact-routes-v1"
SYSTEM_PROMPT = (prompt_ref("detail.strategy.system.head") + prompt_ref("detail.strategy.system.tail"))


def demand_first_prompt():
    from .demand_first import METHOD
    # Keep the renderer contract; replace the fact-first instruction, not layer
    # another competing procedure on top of it. Old policy prompts stay stable.
    return (
        prompt_ref("detail.strategy.demand_first.intro")
        + METHOD +
        prompt_ref("detail.strategy.demand_first.rules")
        # The output-format half of the strategy prompt, stored separately so this needs no slicing of the wording.
        + prompt_ref("detail.strategy.system.tail")
    )


def compile_strategy(strategy, *, buyer_copy=False):
    """Flatten fact-owned routes without inventing audience, benefit or facts."""
    if strategy.get("strategy_version") != VERSION:
        raise ValueError("新策划必须先按事实展开客户需求，不能直接返回参数页面")
    result = copy.deepcopy(strategy)
    groups = result.get("advantages")
    if not isinstance(groups, list):
        raise ValueError("advantages必须为数组")
    points, screens, review = [], [], []
    cover = result.get("cover")
    if not isinstance(cover, dict):
        raise ValueError("缺产品封面定位")
    screens.append({**cover, "idx": 1, "role": "hero", "selling_point_id": None})
    for number, group in enumerate(groups, 1):
        if not isinstance(group, dict) or not isinstance(group.get("fact"), str) or not group["fact"].strip():
            raise ValueError("优势必须有实际用途说明")
        evidence, routes = group.get("evidence"), group.get("routes")
        if not isinstance(evidence, list) or not evidence or not all(isinstance(e, str) and e.strip() for e in evidence):
            raise ValueError("优势缺少原文依据")
        if not isinstance(routes, list):
            raise ValueError("每项优势必须先展开routes")
        group["id"] = f"f{number}"
        for route in routes:
            if not isinstance(route, dict) or not all(
                isinstance(route.get(k), str) and route[k].strip()
                for k in ("audience", "scenario", "need", "benefit", "value_bridge", "outcome_key", "title")
            ):
                raise ValueError("需求分支缺少客户工作、收益或事实连接")
            pid = f"p{len(points) + 1}"
            route["point_id"] = pid
            points.append({k: route[k] for k in ("audience", "scenario", "need", "benefit", "value_bridge", "outcome_key")})
            points[-1].update(id=pid, text=route["title"], evidence=list(evidence), fact_id=group["id"])
            brief = route.get("visual_brief")
            if not isinstance(brief, dict):
                raise ValueError("需求分支缺少画面意图")
            screens.append({"idx": len(screens) + 1, "role": "scenario" if brief.get("product_presentation") == "working_scene" else "feature_wall",
                            "title": route["title"], "subtitle": route.get("subtitle", ""),
                            "selling_point_id": pid, "evidence": list(evidence), "visual_brief": brief})
            if buyer_copy:
                from .buyer_copy import copy_fields
                fields = copy_fields(route, evidence)
                screens[-1].update(fields, subtitle="")
                points[-1].update(fields)
            review.append({"audience": route["audience"], "need": route["need"], "decision": "covered",
                           "point_id": pid, "reason": route["value_bridge"]})
    specs = result.get("specifications")
    if not isinstance(specs, list):
        raise ValueError("specifications必须为数组")
    if specs:
        screens.append({"idx": len(screens) + 1, "role": "spec_table", "title": "产品参数", "subtitle": "",
                        "selling_point_id": None, "evidence": [s.get("evidence", "") for s in specs if isinstance(s, dict)],
                        "visual_brief": {"product_presentation": "diagram_only", "scene": "统一配色信息底图",
                                         "framing": "平面参数表", "product_action": "只展示原始规格，不画结构",
                                         "visual_evidence": "准确的名称、数值、范围与配置条件",
                                         "layout": "表格为主体，标题居上，留足边距"}})
    result.update(planning_version="selling-points-v1", buying_point_version="buying-points-v1",
                  demand_analysis_version="demand-analysis-v1", visual_strategy_version="selling-point-evidence-v1",
                  selling_points=points, deferred_buying_points=[], demand_review=review or [
                      {"audience": "使用者", "need": "核对规格", "decision": "spec_only", "point_id": None, "reason": "无独立使用需求"}],
                  screens=screens, screen_count=len(screens),
                  primary_demonstration_id=(points[0]["id"] if points and screens[1]["visual_brief"].get("product_presentation") == "working_scene" else None))
    return result


def render_screen_prompts(plan):
    """Called after shortlisting; never pays a model or changes customer copy."""
    for screen in plan["screens"]:
        captions = {"title": screen["title"], "subtitle": screen.get("subtitle", "")}
        if "body" in screen:
            captions.update(body=screen["body"], technical_support=screen["technical_support"])
        if screen["role"] == "spec_table":
            captions["specifications"] = [{k: item[k] for k in ("name", "value")} for item in plan["specifications"]]
        screen["prompt"] = (
            prompt_ref("detail.strategy.screen.intro")
            + json.dumps(screen["visual_brief"], ensure_ascii=False)
            + "。整套风格：" + json.dumps(plan.get("style_dna", {}), ensure_ascii=False)
            + "。新增画面文字仅限以下JSON内容，不打印字段名：" + json.dumps(captions, ensure_ascii=False)
            + (prompt_ref("detail.strategy.screen.layers")
               if "body" in screen else "")
            + prompt_ref("detail.strategy.screen.rules")
        )
