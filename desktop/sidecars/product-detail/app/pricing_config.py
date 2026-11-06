"""Administrative cap and read-only preplanning estimate, never an actual bill."""
from __future__ import annotations
import math
import os

try:
    # 15 detail screens + 3 square e-commerce images at the 2K price stay under this ceiling.
    MAX_REFINE_COST_PER_RUN = float(os.environ.get("MAX_REFINE_COST_PER_RUN", "7.0"))
    if not math.isfinite(MAX_REFINE_COST_PER_RUN) or MAX_REFINE_COST_PER_RUN <= 0:
        raise ValueError("invalid cap")
except (TypeError, ValueError):
    MAX_REFINE_COST_PER_RUN = 7.0


def compute_estimate(product_count: int) -> dict:
    from ai_refine_v2.pricing import PricingRequired, money, read_quote
    from ai_refine_v2 import refine_planner
    from ai_refine_v2.image_profile import DEFAULT_PROFILE
    from ai_refine_v2.prompts.planner import SYSTEM_PROMPT_V2, USER_PROMPT_TEMPLATE_V2
    count = max(0, int(product_count))
    result = {"count": count, "api_calls": None, "est_cost_yuan": None,
              "est_minutes": None, "zones_per_product": None,
              "ready": False, "actual_cost_yuan": None,
              "note": "策划后按实际张数核算；策划前按最多15张详情图加3张1:1电商图预留"}
    if not count:
        return {**result, "ready": True, "est_cost_yuan": 0, "maximum_cost_yuan": 0}
    try:
        quote = read_quote(image_profile=DEFAULT_PROFILE)
    except PricingRequired as exc:
        return {**result, "error": str(exc)}
    input_bound = 4 * (refine_planner.MAX_PRODUCT_TEXT_CHARS + refine_planner.MAX_PRODUCT_TITLE_CHARS)
    input_bound += len((SYSTEM_PROMPT_V2 + USER_PROMPT_TEMPLATE_V2).encode("utf-8")) + 4096
    rates = quote["planner_per_million_cny"]
    planner_max = money((input_bound * rates["input"] + refine_planner._MAX_TOKENS_V2 * rates["output"]) / 1_000_000)
    from ai_refine_v2.visual_merchandising import PLANNED_SCREEN_LIMIT, SQUARE_KINDS
    images = PLANNED_SCREEN_LIMIT + len(SQUARE_KINDS)
    maximum = money(count * (images * quote["image_unit_cny"] + planner_max))
    return {**result, "ready": True, "minimum_cost_yuan": money(count * 2 * quote["image_unit_cny"]),
            "maximum_cost_yuan": maximum, "est_cost_yuan": maximum,
            "unit_price_yuan": quote["image_unit_cny"], "quote": quote}
