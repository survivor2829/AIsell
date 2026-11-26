"""Prompt assembly paths that adjust stored wording in code (replace, variants, concatenation).

test_prompt_tokens.py builds each one twice: with the wording (repository) and with tokens (as on a customer
computer, then expanded the way the gateway does). Both must send the same text. Add new paths here when migrating.
"""
from __future__ import annotations

import json

CATEGORIES = ("设备类", "配件类", "耗材类", "工具类")


def builders():
    from ai_refine_v2 import visual_merchandising as vm
    from ai_refine_v2.prompts import planner
    from prompt_ref import prompt_ref

    out = {}
    for mode, kwargs in (("plain", {}), ("buyer", {"buyer_value": True}), ("auto", {"automatic": True})):
        out[f"vm.prompt.{mode}"] = lambda kwargs=kwargs: vm.prompt(**kwargs)
        for category in CATEGORIES:
            out[f"vm.fit.{mode}.{category}"] = (lambda kwargs=kwargs, category=category:
                                                vm.fit_category(vm.prompt(**kwargs), category) + vm.category_rule(category))
            out[f"vm.fit.editorial.{mode}.{category}"] = (lambda kwargs=kwargs, category=category:
                                                          vm.fit_category(vm.prompt(**kwargs) + vm.AUTO_REVIEW, category))
    out["vm.outline"] = vm.outline_prompt
    user = dict(product_text='"产品资料"', product_title_hint='"标题"', product_image_hint="有参考图")
    out["planner.user_v2"] = lambda: planner.USER_PROMPT_TEMPLATE_V2.format(**user)
    out["planner.user_v2.strategy"] = lambda: planner.USER_PROMPT_TEMPLATE_V2.format(**user).replace(
        prompt_ref("detail.planner.user_v2.p4"), prompt_ref("detail.planner.user_v2.p4_strategy"))
    out["planner.user_v1"] = lambda: planner.USER_PROMPT_TEMPLATE.format(
        product_text='"资料"', product_image_hint="无", force_vs="否", force_scenes="否", force_specs="是")
    out["planner.system_v2"] = lambda: planner.SYSTEM_PROMPT_V2
    return out


if __name__ == "__main__":
    print(json.dumps({name: build() for name, build in builders().items()}, ensure_ascii=False))
