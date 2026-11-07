"""A paid final draft delivers its provable part instead of failing the whole order.

Field case 2026-11-06 (1.2.66, 坦虎八座电动观光车H800XL): the editor quoted
"续驶里程>70KM" for the source "续驶里程:>70KM" on two pages, and the category
proof "八座半封闭电动观光车" for "八座半封闭". Each single mismatch failed the
whole order, and a retry replayed the same saved replies into the same error.
"""
import copy
import json
from unittest.mock import Mock

import pytest

from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.tests.test_product_driven_planning import response
from ai_refine_v2.tests.test_visual_merchandising import fixture
from ai_refine_v2.visual_merchandising import (detail_screens, final_source_quote, normalize_quotes,
                                               source_quote)

TITLE = "坦虎八座电动观光车H800XL"
SOURCE = ("电控:国标新能源交流电控电池:免维护180AH电池·8只/48V电机:国标新能\n"
          "源交流电机7.5KW充电器:车载智能充电机:48V/25A整车尺寸\n"
          "4100x1525x2050续驶里程:>70KM\n\n"
          "1.景区文旅:自然/人文景区、主题乐园、乡村旅游的观\n光与接驳\n"
          "2.城市园区:城市公园、工业园区、高校、体育会展中心\n的内部通勤\n"
          "八座半封闭/整车尺寸:4100x1525x2050")


def cart_draft():
    _, data = fixture()
    brief = data["cover"]["visual_brief"]
    data["category_check"] = {"category": "设备类", "evidence": ["八座半封闭电动观光车"]}
    data["product_meta"].update(name=TITLE)
    data["cover"].update(title="八座电动观光车 景区园区接驳", evidence=["八座半封闭"])
    facts = [("景区接驳八人", ["八座半封闭", "景区文旅：自然/人文景区、主题乐园、乡村旅游的观光与接驳"], []),
             ("园区内部通勤", ["城市园区：城市公园、工业园区、高校、体育会展中心的内部通勤"], ["续驶里程>70KM"]),
             ("续航够跑一天", ["八座半封闭"], ["续驶里程>70KM"]),
             ("免维护电池", ["电池:免维护180AH电池·8只/48V"], ["电池:免维护180AH电池·8只/48V"]),
             ("智能充电", ["充电器:车载智能充电机:48V/25A"], ["充电器:车载智能充电机:48V/25A"]),
             ("交流电机", ["电机:国标新能源交流电机7.5KW"], ["电机:国标新能源交流电机7.5KW"]),
             ("整车尺寸", ["整车尺寸4100x1525x2050"], ["整车尺寸4100x1525x2050"])]
    data["pages"] = [{"kind": "display", "role": "scenario", "title": title, "body": "",
                      "evidence": evidence, "technical_support": support,
                      "visual_brief": dict(brief, scene=title)}
                     for title, evidence, support in facts]
    data["specifications"] = [
        {"name": "续驶里程", "value": ">70KM", "evidence": "续驶里程>70KM"},
        {"name": "电机", "value": "国标新能源交流电机7.5KW", "evidence": "电机:国标新能源交流电机7.5KW"}]
    return data


def plan(first, final, **extra):
    http, review = Mock(return_value=response(first)), Mock(return_value=response(final))
    result = planner.plan_v2(SOURCE, product_title=TITLE, product_category="设备类", api_key="offline",
                             http_fn=http, semantic_http_fn=review, require_buyer_value=True,
                             require_automatic_visual=True, allow_visual_advisories=True,
                             repair_unsupported_captions=True, **extra)
    assert http.call_count == review.call_count == 1  # Nothing bought again.
    return result, review


def test_field_case_delivers_every_page_instead_of_failing():
    data = cart_draft()
    with pytest.raises(ValueError, match="原文引用内容不匹配"):
        normalize_quotes(data, SOURCE)  # The 1.2.66 final pass.
    result, review = plan(data, data)
    titles = [s["title"] for s in detail_screens(result)]
    assert titles[1:8] == [p["title"] for p in data["pages"]]
    assert titles[-1] == "产品参数" and not result.get("dropped_pages")
    commute = next(s for s in result["screens"] if s["title"] == "园区内部通勤")
    assert commute["technical_support"] == ["续驶里程:>70KM"]  # The exact source text.
    assert [r["quote"] for r in result["quote_repairs"]] == ["八座半封闭电动观光车"]
    assert result["specifications"][0]["evidence"] == "续驶里程:>70KM"
    # The first-draft checks stay strict, so the saved review request (and a
    # retry's replay hash) is unchanged.
    sent = json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert "原文" in sent["local_issues_to_correct"]


def test_final_quote_tolerates_format_only():
    assert final_source_quote("续驶里程>70KM", SOURCE) == "续驶里程:>70KM"
    assert final_source_quote("整车尺寸：4100x1525x2050", SOURCE) == "整车尺寸\n4100x1525x2050"
    assert final_source_quote("参数（标准）,可调", "参数(标准)，可调") == "参数(标准)，可调"
    for fake in ("续驶里程>80KM", "续驶里程>70KM以上", "国标交流电机7.5KW", "免维护200AH电池"):
        with pytest.raises(ValueError):
            final_source_quote(fake, SOURCE)
    with pytest.raises(ValueError):
        final_source_quote("容量33L", "容量:3 3L")  # Separated digits never join.
    with pytest.raises(ValueError):
        final_source_quote("比例12", "比例1:2")
    with pytest.raises(ValueError):
        source_quote("续驶里程>70KM", SOURCE)  # The first-draft check is unchanged.


def test_unprovable_page_and_parameter_row_are_dropped_not_the_order():
    data = cart_draft()
    data["pages"][2]["evidence"] = ["续航120公里"]
    data["pages"][2]["technical_support"] = []
    data["specifications"].append({"name": "最高车速", "value": "30km/h", "evidence": "最高车速30km/h"})
    result, _ = plan(data, data)
    titles = [s["title"] for s in result["screens"]]
    assert "续航够跑一天" not in titles and "园区内部通勤" in titles
    assert [d["title"] for d in result["dropped_pages"]] == ["续航够跑一天"]
    assert [s["name"] for s in result["specifications"]] == ["续驶里程", "电机"]
    assert all("120" not in s["prompt"] and "30km/h" not in s["prompt"] for s in result["screens"])


def test_unparseable_final_reply_uses_the_paid_first_draft():
    data = cart_draft()
    http, review = Mock(return_value=response(data)), Mock(return_value={
        "choices": [{"finish_reason": "stop", "message": {"content": '{"cover": {"title": "x"}, {'}}]})
    result = planner.plan_v2(SOURCE, product_title=TITLE, product_category="设备类", api_key="offline",
                             http_fn=http, semantic_http_fn=review, require_buyer_value=True,
                             require_automatic_visual=True, allow_visual_advisories=True,
                             repair_unsupported_captions=True)
    assert http.call_count == review.call_count == 1
    assert result["planning_source"] == "first_draft_salvaged"
    assert len(detail_screens(result)) == 9


def test_cover_and_table_problems_no_longer_fail_the_order():
    data = cart_draft()
    data["cover"]["title"] = "200AH大电池 景区首选"  # A value the source never gives.
    data["specifications"] = [{"name": "电机", "value": "7.5KW 大功率", "evidence": "电机:国标新能源交流电机7.5KW"}]
    result, _ = plan(data, data)
    assert result["screens"][0]["title"] == TITLE
    assert "200AH" not in result["screens"][0]["prompt"]


def test_real_input_conflicts_still_stop():
    data = cart_draft()
    data["category_check"]["category"] = "耗材类"
    with pytest.raises(planner.ProductInputError):
        plan(data, data)
    nothing = copy.deepcopy(data)
    nothing["category_check"]["category"] = "设备类"
    for page in nothing["pages"]:
        page["evidence"], page["technical_support"] = ["完全虚构的卖点"], []
    nothing["specifications"] = []
    with pytest.raises(planner.PlannerError):
        plan(nothing, nothing)  # No provable page left: too thin to deliver.
