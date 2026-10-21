"""Contract checks, not a substitute for real picture acceptance."""
import copy
import json
from unittest.mock import Mock

import pytest
from PIL import Image

from ai_refine_v2 import refine_generator as generator, refine_planner as planner, pipeline_runner as runner
from ai_refine_v2.visual_merchandising import compile_plan, validate
from ai_refine_v2.tests.test_product_driven_planning import response


def test_json_mode_is_explicit_for_both_planning_policies():
    from ai_refine_v2.visual_merchandising import prompt
    for buyer_value in (False, True):
        assert "json" in prompt(buyer_value).lower()


def fixture(category="设备类"):
    source = f"{category}测试产品。清水箱容积：18L。外壳电泳喷塑，防锈耐腐蚀。最大爬坡：25%。"
    brief = {"product_presentation": "whole_product", "scene": "产品展示",
             "framing": "主体突出", "product_action": "静态展示",
             "visual_evidence": "原文用途", "layout": "大标题与产品"}
    data = {
        "category_check": {"category": category, "evidence": [f"{category}测试产品"]},
        "product_meta": {"name": "测试产品", "category": category, "primary_color": "原图",
                         "key_visual_parts": ["按原图"]},
        "style_dna": {"color_palette": "产品本色", "lighting": "柔光", "composition_style": "多样布局",
                      "mood": "专业", "typography_hint": "大字", "unified_visual_treatment": "统一图文风格"},
        "cover": {"title": "测试产品", "evidence": [f"{category}测试产品"], "visual_brief": brief},
        "pages": [
            {"kind": "display", "role": "detail_zoom", "title": "18L清水箱",
             "component": "清水箱", "technical_support": ["清水箱容积：18L。"],
             "evidence": ["清水箱容积：18L。"],
             "visual_brief": {**brief, "product_presentation": "concept_detail", "framing": "部件独占画面"}},
            {"kind": "benefit", "role": "feature_wall", "title": "防锈耐腐蚀",
             "body": "电泳喷塑外壳，为日常使用提供防护。",
             "evidence": ["外壳电泳喷塑，防锈耐腐蚀。"],
             "technical_support": ["外壳电泳喷塑，防锈耐腐蚀。"],
             "visual_brief": {**brief, "product_presentation": "visible_detail"}},
        ],
        "specifications": [{"name": "清水箱容积", "value": "18L", "evidence": "清水箱容积：18L。"}],
    }
    return source, data


def test_optional_prose_mixed_pages_and_component_reach_actual_image_request(tmp_path):
    source, data = fixture()
    first, reviewer = Mock(return_value=response(data)), Mock(return_value=response(data))
    plan = planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=reviewer,
                           require_visual_merchandising=True, product_category="设备类")
    assert first.call_count == reviewer.call_count == 1
    assert plan["screen_count"] == 4 and len(plan["selling_points"]) == 1
    assert plan["screens"][1]["selling_point_id"] is None and plan["screens"][1]["body"] == ""
    image = tmp_path / "source.png"
    Image.new("RGB", (40, 40), "white").save(image)
    received = []
    def image_call(prompt, *args, **kwargs):
        received.append(prompt)
        return "https://example.invalid/offline.png"
    generator.generate_v2(plan, str(image), api_key="offline", api_call_fn=image_call,
                          cutout_whitelist=[], concurrency=1)
    component_prompt = received[1]
    assert '本页部件主体（不是印刷文字）："清水箱"' in component_prompt
    assert '"body": ""' in component_prompt
    assert "photorealistic illustrative" in component_prompt
    assert "show all three layers" not in component_prompt
    assert "Do not create hidden/internal" not in component_prompt


@pytest.mark.parametrize("category", ["设备类", "配件类", "耗材类", "工具类"])
def test_four_categories_remain_isolated(category):
    source, data = fixture(category)
    if category != "设备类":
        names = {"配件类": ("替换滤芯", "滤芯", "滤芯长度", "100mm"),
                 "耗材类": ("清洁液", "清洁液", "净容量", "5L"),
                 "工具类": ("手动刮水器", "刮条", "刮条宽度", "600mm")}
        name, component, label, value = names[category]
        identity, quote = f"{category}{name}", f"{label}：{value}。"
        source = identity + "。" + quote
        data["category_check"]["evidence"] = [identity]
        data["product_meta"]["name"] = name
        data["cover"].update(title=name, evidence=[identity])
        data["pages"] = [{**data["pages"][0], "title": label + value,
                          "component": component, "evidence": [identity, quote],
                          "technical_support": [quote]}]
        data["specifications"] = [{"name": label, "value": value, "evidence": quote}]
    plan = compile_plan(data, source, "测试产品", category)
    assert plan["category_check"]["category"] == category
    other = "工具类" if category != "工具类" else "设备类"
    with pytest.raises(planner.ProductInputError):
        compile_plan(data, source, "测试产品", other)


def test_more_than_fifteen_text_pages_are_selected_without_image_calls():
    source, data = fixture()
    data["pages"] = [{**copy.deepcopy(data["pages"][0]), "title": f"部件展示{i}"} for i in range(20)]
    plan = compile_plan(data, source, "测试产品", "设备类")
    assert plan["screen_count"] == 15
    assert len(plan["deferred_pages"]) == 7
    assert all("prompt" not in p for p in plan["deferred_pages"])


@pytest.mark.parametrize("fault", ["unit", "component", "body", "mapping"])
def test_invalid_preview_stops_before_image_quote(tmp_path, monkeypatch, fault):
    source, data = fixture()
    plan = compile_plan(data, source, "测试产品", "设备类")
    if fault == "unit":
        plan["screens"][1]["title"] = "最大爬坡25度"
    elif fault == "component":
        plan["screens"][1]["component"] = "方向盘"
    elif fault == "body":
        plan["screens"][1]["body"] = "正文" * 30
    else:
        plan["screens"][2]["selling_point_id"] = None
    runner._atomic_write_json(tmp_path / "_quality_policy.json", {"version": 10})
    quote = Mock(side_effect=AssertionError("no charge"))
    monkeypatch.setattr("ai_refine_v2.pricing.read_quote", quote)
    with pytest.raises(ValueError):
        runner._run_real_generator_v2(plan, "reference.png", "offline", tmp_path, None)
    quote.assert_not_called()


def test_failed_review_is_not_retried():
    source, data = fixture()
    first, review = Mock(return_value=response(data)), Mock(return_value=response({"pages": []}))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=review,
                        require_visual_merchandising=True, max_retries=2)
    assert first.call_count == review.call_count == 1


def test_malformed_draft_reuses_existing_editor_without_rebuying_planning():
    source, data = fixture()
    malformed = response(data)
    malformed["choices"][0]["message"]["content"] = '{"pages":[{"title":"原始草稿",}'
    first, review = Mock(return_value=malformed), Mock(return_value=response(data))
    plan = planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=review,
                          require_visual_merchandising=True, product_category="设备类")
    sent = json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert sent["draft_to_edit"]["unparsed_model_draft"] == malformed["choices"][0]["message"]["content"]
    assert first.call_count == review.call_count == 1
    assert plan["screen_count"] == 4


def test_same_whole_product_for_every_page_is_not_accepted():
    source, data = fixture()
    data["pages"] = [{**copy.deepcopy(data["pages"][0]), "title": f"展示{i}"} for i in range(3)]
    for page in data["pages"]:
        page["visual_brief"]["product_presentation"] = "whole_product"
    with pytest.raises(ValueError, match="重复整机"):
        compile_plan(data, source, "测试产品", "设备类")


def buyer_draft(category="设备类"):
    source, data = fixture(category)
    # Contract fixture only, not evidence that a model can produce good copy.
    data["pages"] = [{**copy.deepcopy(data["pages"][0]), "title": title}
                     for title in ("清水供给", "箱体容量", "部件展示", "装置关系", "技术核对", "使用说明")]
    return source, data


@pytest.mark.parametrize("category", ["设备类", "配件类", "耗材类", "工具类"])
def test_buyer_policy_eight_total_pages_and_existing_two_operations(category):
    source, data = buyer_draft(category)
    short = copy.deepcopy(data)
    short["pages"] = short["pages"][:2]
    first, review = Mock(return_value=response(short)), Mock(return_value=response(data))
    plan = planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=review,
                          require_buyer_value=True, product_category=category)
    sent = json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert sent["screen_budget"]["minimum_total_screens"] == 8
    assert "至少8屏" in sent["local_issues_to_correct"]
    assert plan["screen_count"] == 8 and plan["selling_points"] == []
    assert plan["buyer_value_version"] == "buyer-value-v1"
    assert first.call_count == review.call_count == 1
    assert "买家实际答案" in review.call_args.args[0]["messages"][0]["content"]


def test_buyer_minimum_does_not_change_old_policy_or_reject_body_presence_of_machine():
    source, data = fixture()
    assert compile_plan(data, source, "", "设备类")["screen_count"] == 4
    with pytest.raises(ValueError, match="至少8屏"):
        compile_plan(data, source, "", "设备类", buyer_value=True)
    source, data = buyer_draft()
    for page in data["pages"]:
        page["visual_brief"]["product_presentation"] = "whole_product"
    assert compile_plan(data, source, "", "设备类", buyer_value=True)["screen_count"] == 8


@pytest.mark.parametrize("claim", ["自动加水", "夜间自主作业", "一箱水可连续作业2-6h"])
def test_buyer_unbacked_promises_still_stop(claim):
    source, data = buyer_draft()
    source += "平均续航时间：2-6h。"
    data["pages"][0]["title"] = claim
    with pytest.raises(ValueError, match="自动能力或耗材容量"):
        compile_plan(data, source, "", "设备类", buyer_value=True)


def test_unconfirmed_automation_is_not_positive_evidence():
    from ai_refine_v2.planning_quality import check_plan_quality
    plan = {"buyer_value_version": "buyer-value-v1", "screens": [{"title": "自动补水"}]}
    assert check_plan_quality(plan, "含工作站，未证实自动补水。", grounded_copy=True)
    assert not check_plan_quality(plan, "支持自动补水。", grounded_copy=True)


def test_buyer_sparse_exception_and_queue_version_gate(tmp_path, monkeypatch):
    from ai_refine_v2.visual_merchandising import screen_budget
    assert screen_budget("工具类刮条，宽度600mm。")["minimum_total_screens"] == 1
    source, data = fixture()
    old = compile_plan(data, source, "", "设备类")
    runner._atomic_write_json(tmp_path / "_quality_policy.json", {"version": 11})
    quote = Mock(side_effect=AssertionError("must stop before pricing"))
    monkeypatch.setattr("ai_refine_v2.pricing.read_quote", quote)
    with pytest.raises(ValueError, match="买方收益策划版本"):
        runner._run_real_generator_v2(old, "", "", tmp_path, None)
    quote.assert_not_called()


def test_outline_then_pages_uses_only_two_operations_without_page_draft_anchoring():
    from ai_refine_v2.visual_merchandising import OUTLINE_VERSION
    source, final = buyer_draft()
    outline = {"category_check": final["category_check"], "purchase_reasons": [{
        "buyer_task": "储存作业用水", "help": "箱体储存清水", "mechanism": "清水箱容纳作业用水",
        "evidence": ["清水箱容积：18L。"], "limits": "不由容量推断连续作业时长",
        "visual_options": ["箱体示意"]}], "supporting_displays": []}
    first, review = Mock(return_value=response(outline)), Mock(return_value=response(final))
    plan = planner.plan_v2(source, api_key="offline", http_fn=first, semantic_http_fn=review,
                          require_buyer_outline=True, product_category="设备类")
    first_system = first.call_args.args[0]["messages"][0]["content"]
    second_input = json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert '"pages"' not in first_system and "JSON" in first_system
    assert second_input["use_analysis_to_verify"] == outline
    assert "draft_to_edit" not in second_input
    assert first.call_count == review.call_count == 1
    assert plan["buyer_outline_version"] == OUTLINE_VERSION
    assert plan["screen_count"] == 8


def test_misplaced_evidenced_component_moves_without_losing_pages():
    source, data = buyer_draft()
    data["pages"][0]["visual_brief"]["component"] = data["pages"][0].pop("component")
    plan = compile_plan(data, source, "", "设备类", buyer_value=True, buyer_outline=True)
    assert plan["screen_count"] == 8
    assert plan["screens"][1]["component"] == "清水箱"
    assert "component" not in plan["screens"][1]["visual_brief"]
    assert "component" in data["pages"][0]["visual_brief"]  # keep the raw reply


@pytest.mark.parametrize("nested", ["未知部件", "污水箱"])
def test_component_normalization_never_invents_or_resolves_conflicting_subject(nested):
    source, data = buyer_draft()
    data["pages"][0]["visual_brief"]["component"] = nested
    with pytest.raises(ValueError, match="部件字段"):
        compile_plan(data, source, "", "设备类", buyer_value=True, buyer_outline=True)


def test_outline_policy_cannot_generate_from_old_buyer_plan(tmp_path, monkeypatch):
    source, data = buyer_draft()
    plan = compile_plan(data, source, "", "设备类", buyer_value=True)
    runner._atomic_write_json(tmp_path / "_quality_policy.json", {"version": 12})
    quote = Mock(side_effect=AssertionError("no image purchase"))
    monkeypatch.setattr("ai_refine_v2.pricing.read_quote", quote)
    with pytest.raises(ValueError, match="实际作用编排版本"):
        runner._run_real_generator_v2(plan, "", "", tmp_path, None)
    quote.assert_not_called()


def test_outline_category_label_can_be_corrected_by_existing_second_call():
    source, final = buyer_draft()
    raw = {"category_check": {"category": "清洁产品", "evidence": [source]},
           "purchase_reasons": [], "supporting_displays": []}
    first, review = Mock(return_value=response(raw)), Mock(return_value=response(final))
    result = planner.plan_v2(source, api_key="offline", product_category="设备类",
                            http_fn=first, semantic_http_fn=review, require_buyer_outline=True)
    sent = json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert json.loads(sent["use_analysis_to_verify"]["unparsed_analysis"]) == raw
    assert first.call_count == review.call_count == 1 and result["screen_count"] == 8
    raw["category_check"]["category"] = "耗材类"
    first, review = Mock(return_value=response(raw)), Mock()
    with pytest.raises(planner.ProductInputError):
        planner.plan_v2(source, api_key="offline", product_category="设备类",
                        http_fn=first, semantic_http_fn=review, require_buyer_outline=True)
    review.assert_not_called()


def test_copy_only_keeps_visuals_facts_and_order_with_two_calls():
    from ai_refine_v2.visual_merchandising import COPY_VERSION, apply_copy_edits
    source, draft = buyer_draft()
    edits = {"edits": [{"screen": 2, "title": "清水用来洗", "body": "清水箱储存清洗用水。"}]}
    modified = apply_copy_edits(draft, json.dumps(edits, ensure_ascii=False))
    for before, after in zip([draft["cover"], *draft["pages"]],
                             [modified["cover"], *modified["pages"]]):
        assert {k: v for k, v in before.items() if k not in ("title", "body")} == {
            k: v for k, v in after.items() if k not in ("title", "body")}
    first, review = Mock(return_value=response(draft)), Mock(return_value=response(edits))
    plan = planner.plan_v2(source, product_category="设备类", api_key="offline",
                          http_fn=first, semantic_http_fn=review, require_copy_edit=True)
    assert plan["copy_edit_version"] == COPY_VERSION
    assert plan["screen_count"] == 8
    assert plan["screens"][1]["title"] == "清水用来洗"
    assert plan["specifications"] == draft["specifications"]
    assert first.call_count == review.call_count == 1
    assert "copy_targets" in json.loads(review.call_args.args[0]["messages"][1]["content"])
    assert "purchase_reasons" not in first.call_args.args[0]["messages"][0]["content"]


@pytest.mark.parametrize("edits", [
    {"edits": [{"screen": 2, "title": "标题", "body": "", "visual_brief": {}}]},
    {"edits": [{"screen": 2, "title": "标题", "body": ""},
               {"screen": 2, "title": "覆盖", "body": ""}]},
    {"pages": []},
])
def test_copy_only_rejects_scope_changes_without_retry(edits):
    source, draft = buyer_draft()
    first, review = Mock(return_value=response(draft)), Mock(return_value=response(edits))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(source, product_category="设备类", api_key="offline",
                        http_fn=first, semantic_http_fn=review, require_copy_edit=True)
    assert first.call_count == review.call_count == 1


def test_copy_only_still_rejects_unbacked_promises():
    source, draft = buyer_draft()
    first = Mock(return_value=response(draft))
    review = Mock(return_value=response({"edits": [{"screen": 2, "title": "自动补水", "body": ""}]}))
    with pytest.raises(planner.PlannerError, match="自动能力"):
        planner.plan_v2(source, product_category="设备类", api_key="offline",
                        http_fn=first, semantic_http_fn=review, require_copy_edit=True)
    assert first.call_count == review.call_count == 1


def test_copy_policy_needs_its_marker_and_does_not_offer_broken_draft_replay(tmp_path, monkeypatch):
    source, draft = buyer_draft()
    runner._atomic_write_json(tmp_path / "_quality_policy.json", {"version": 13})
    assert not runner._can_replay_failed_planner(tmp_path, {
        "status": "failed", "code": "AI_REFINE_PLANNER_FORMAT_ERROR"})
    old = compile_plan(draft, source, "", "设备类", buyer_value=True)
    quote = Mock(side_effect=AssertionError("no image purchase"))
    monkeypatch.setattr("ai_refine_v2.pricing.read_quote", quote)
    with pytest.raises(ValueError, match="保留画面"):
        runner._run_real_generator_v2(old, "", "", tmp_path, None)
    quote.assert_not_called()


@pytest.mark.parametrize("component,valid", [
    ("污水箱、清水箱", True), ("污水箱 + 清水箱", True),
    ("污水箱、未知部件", False), ("污水箱、", False),
])
def test_each_combined_component_requires_its_own_evidence(component, valid):
    source, draft = buyer_draft()
    source += "污水箱容积：24L。"
    page = draft["pages"][0]
    page.pop("component")
    page["visual_brief"]["component"] = component
    page["evidence"].append("污水箱容积：24L。")
    if valid:
        result = compile_plan(draft, source, "", "设备类", buyer_value=True, buyer_outline=True)
        assert result["screens"][1]["component"] == component
        assert result["screen_count"] == 8
    else:
        with pytest.raises(ValueError, match="部件字段"):
            compile_plan(draft, source, "", "设备类", buyer_value=True, buyer_outline=True)


def test_copy_editor_can_fix_caption_before_final_check_but_not_bypass_visual_check():
    source, draft = buyer_draft()
    draft["pages"][0]["title"] = "自动补水"
    edits = {"edits": [{"screen": 2, "title": "清水用来洗", "body": ""}]}
    first, second = Mock(return_value=response(draft)), Mock(return_value=response(edits))
    plan = planner.plan_v2(source, product_category="设备类", api_key="offline",
                          http_fn=first, semantic_http_fn=second, require_copy_edit=True)
    assert first.call_count == second.call_count == 1
    assert plan["screens"][1]["title"] == "清水用来洗"
    assert plan["screens"][1]["visual_brief"] == draft["pages"][0]["visual_brief"]
    # Visual facts remain subject to the final check, even after caption repair.
    draft["cover"]["visual_brief"]["visual_evidence"] = "展示整机和工作站外观"
    first, second = Mock(return_value=response(draft)), Mock(return_value=response(edits))
    with pytest.raises(planner.PlannerError, match="配套设备"):
        planner.plan_v2(source, product_category="设备类", api_key="offline",
                        http_fn=first, semantic_http_fn=second, require_copy_edit=True)
    assert first.call_count == second.call_count == 1


def test_copy_editor_does_not_purchase_copy_for_unfixable_component():
    source, draft = buyer_draft()
    draft["pages"][0]["component"] = "未知部件"
    first, second = Mock(return_value=response(draft)), Mock()
    with pytest.raises(planner.PlannerError, match="部件字段"):
        planner.plan_v2(source, product_category="设备类", api_key="offline",
                        http_fn=first, semantic_http_fn=second, require_copy_edit=True)
    second.assert_not_called()


def test_automatic_editor_repairs_visual_and_caption_in_existing_two_calls():
    from ai_refine_v2.visual_merchandising import AUTO_VERSION
    source, final = buyer_draft()
    broken = copy.deepcopy(final)
    broken['pages'][0]['component'] = '未知配套部件'
    broken['pages'][0]['title'] = '自动补水，无需人工'
    first, second = Mock(return_value=response(broken)), Mock(return_value=response(final))
    plan = planner.plan_v2(source, product_category='设备类', api_key='offline',
                          http_fn=first, semantic_http_fn=second, require_automatic_visual=True)
    assert first.call_count == second.call_count == 1
    sent = json.loads(second.call_args.args[0]['messages'][1]['content'])
    assert json.loads(sent['draft_to_edit']['unparsed_model_draft']) == broken
    assert '部件' in sent['local_issues_to_correct']
    assert plan['automatic_planning_version'] == AUTO_VERSION
    assert plan['screens'][1]['component'] == '清水箱'
    assert plan['screens'][1]['title'] == final['pages'][0]['title']
    assert '独立部件不要复制整机' in generator._build_blocks_v2(plan)[1]['prompt']
    # Invalid final model output must fail, never fall back to this good draft.
    first, second = Mock(return_value=response(final)), Mock(return_value=response(broken))
    with pytest.raises(planner.PlannerError):
        planner.plan_v2(source, product_category='设备类', api_key='offline',
                        http_fn=first, semantic_http_fn=second, require_automatic_visual=True,
                        max_retries=5)
    assert first.call_count == second.call_count == 1


@pytest.mark.parametrize('category,name,fact,component', [
    ('设备类', '包装机', '封口温度可调。', '封口机构'),
    ('配件类', '替换喷嘴', '喷嘴口径：2mm。', '喷嘴'),
    ('耗材类', '擦拭布', '擦拭布尺寸：30cm。', '擦拭布'),
    ('工具类', '棘轮扳手', '棘轮支持往复拧紧。', '棘轮'),
])
def test_automatic_transport_uses_current_product_only(category, name, fact, component):
    # Short inputs intentionally qualify for the sparse-material exception.
    # These canned responses verify plumbing, NOT model reasoning quality.
    _, data = fixture(category)
    source = f'{category}{name}（{component}）。{fact}'
    data['category_check'] = dict(category=category, evidence=[source])
    data['product_meta'].update(name=name, category=category, key_visual_parts=[component])
    data['cover'].update(title=name, evidence=[source])
    page = data['pages'][0]
    page.update(title=name+'使用说明', component=component, evidence=[source], technical_support=[])
    page['visual_brief'].update(scene=component+'功能示意', visual_evidence=fact)
    data['pages'] = [page]
    data['specifications'] = []
    first, second = Mock(return_value=response(data)), Mock(return_value=response(data))
    plan = planner.plan_v2(source, product_title=name, product_category=category, api_key='offline',
                          http_fn=first, semantic_http_fn=second, require_automatic_visual=True,
                          allow_visual_advisories=True)
    for transport in (first, second):
        payload = json.loads(transport.call_args.args[0]['messages'][1]['content'])
        assert payload['source'] == source and payload['selected_category'] == category
        assert 'copy_targets' not in payload
    assert plan['product_meta']['name'] == name
    assert plan['screens'][1]['component'] == component
    data['category_check']['category'] = '设备类' if category != '设备类' else '工具类'
    second.reset_mock()
    with pytest.raises(planner.ProductInputError):
        planner.plan_v2(source, product_category=category, api_key='offline',
                        http_fn=Mock(return_value=response(data)), semantic_http_fn=second,
                        require_automatic_visual=True, allow_visual_advisories=True)
    second.assert_not_called()


def test_automatic_policy_refuses_previous_manual_sample_before_image_quote(tmp_path, monkeypatch):
    source, draft = buyer_draft()
    old_plan = compile_plan(draft, source, '', '设备类', buyer_value=True)
    runner._atomic_write_json(tmp_path / '_quality_policy.json', {'version': 14})
    quote = Mock(side_effect=AssertionError('no charge'))
    monkeypatch.setattr('ai_refine_v2.pricing.read_quote', quote)
    with pytest.raises(ValueError, match='自动用途与画面'):
        runner._run_real_generator_v2(old_plan, '', '', tmp_path, None)
    quote.assert_not_called()
    assert not runner._can_replay_failed_planner(tmp_path, {'status': 'failed'})


def test_delivery_normalizes_quotes_and_time_without_changing_model_copy():
    from ai_refine_v2.visual_merchandising import read_draft, source_quote
    source, draft = buyer_draft()
    source += '\n配套充电桩充满时长 2h\n用途：\n室内使用。'
    page = draft['pages'][1]
    page.update(title='2小时充满', body='', technical_support=['2h'],
                evidence=['配套充电桩充满时长  2h', '用途： 室内使用。'])
    page['visual_brief']['product_presentation'] = 'diagram_only'
    page.pop('component', None)
    raw = json.dumps(draft, ensure_ascii=False)
    normalized = read_draft(raw, source, delivery=True)
    assert normalized['pages'][1]['title'] == draft['pages'][1]['title']
    assert normalized['pages'][1]['evidence'] == ['配套充电桩充满时长 2h', '用途：\n室内使用。']
    assert normalized['pages'][1]['technical_support'] == ['配套充电桩充满时长 2h']
    plan = compile_plan(normalized, source, '', '设备类', buyer_value=True, delivery=True)
    assert plan['screen_count'] == 8
    assert json.loads(raw) == draft
    for claim in ('22h', '20h', '自动充电'):
        with pytest.raises(ValueError):
            source_quote(claim, source)
    with pytest.raises(ValueError):
        source_quote('33L', '3 3L')
    assert source_quote('适配地面：沥青、水泥', '适配地面\n沥青、水泥') == '适配地面\n沥青、水泥'
    assert source_quote('适配地面:沥青、水泥', '适配地面：沥青、水泥') == '适配地面：沥青、水泥'
    for quote, original in [('容量：33L', '容量\n3 3L'), ('坡度：10°', '坡度\n10%')]:
        with pytest.raises(ValueError):
            source_quote(quote, original)


def test_delivery_companion_is_advisory_only_when_named_in_source(tmp_path, monkeypatch):
    from ai_refine_v2.visual_merchandising import AUTO_VERSION, DELIVERY_VERSION
    source, draft = buyer_draft()
    source += '含充电桩。'
    draft['cover']['visual_brief']['scene'] = '展示充电桩与产品的配套关系'
    plan = compile_plan(draft, source, '', '设备类', buyer_value=True, delivery=True)
    assert any(a['code'] == 'unverified_companion' for a in plan['planning_advisories'])
    # Generation admission runs the real validation, then reaches the quote.
    plan['automatic_planning_version'] = AUTO_VERSION
    runner._atomic_write_json(tmp_path / '_quality_policy.json', {'version': 15})
    quote = Mock(side_effect=RuntimeError('offline quote boundary'))
    monkeypatch.setattr('ai_refine_v2.pricing.read_quote', quote)
    with pytest.raises(RuntimeError, match='offline quote boundary'):
        runner._run_real_generator_v2(plan, '', '', tmp_path, None)
    quote.assert_called_once()
    for fault in ('capacity', 'function', 'category', 'count', 'companion'):
        bad = copy.deepcopy(plan)
        if fault == 'capacity': bad['screens'][1]['title'] = '999L清水箱'
        elif fault == 'function': bad['screens'][1]['title'] = '自动加水'
        elif fault == 'category': bad['category_check']['category'] = '工具类'
        elif fault == 'count': bad['screen_count'] = 16
        else: bad['screens'][0]['visual_brief']['scene'] = '展示工作站'
        quote.reset_mock()
        with pytest.raises((ValueError, planner.ProductInputError)):
            runner._run_real_generator_v2(bad, '', '', tmp_path, None)
        quote.assert_not_called()
    draft['visual_delivery_version'] = DELIVERY_VERSION
    with pytest.raises(ValueError, match='配套'):
        compile_plan(draft, source, '', '设备类')  # historical policy stays strict


def test_delivery_unmanned_wording_does_not_invent_capability():
    from ai_refine_v2.planning_quality import check_plan_quality
    plan = {'visual_delivery_version': 'grounded-visual-delivery-v1',
            'buyer_value_version':'buyer-value-v1', 'merchandising_version':'visual-merchandising-v1',
            'screens':[{'idx':1,'title':'无人值守时段开展作业'}]}
    assert check_plan_quality(plan, '支持夜间全自动无人清扫。')
    assert not check_plan_quality(plan, '支持夜间无人值守。')
    assert check_plan_quality(plan, '不支持无人清扫。')
    assert check_plan_quality(plan, '含充电桩。')
    assert check_plan_quality(plan, '支持无人清扫，仍需人员现场监控。')
    assert check_plan_quality(plan, '支持全自动无人清扫，仍需人员现场监控。')
    assert check_plan_quality(plan, '支持无人清扫。')


@pytest.mark.parametrize('category,name,fact', [
    ('设备类', '包装机', '封口宽度：200mm'),
    ('配件类', '替换滤芯', '过滤精度：5μm'),
    ('耗材类', '擦拭布', '尺寸：30cm'),
    ('工具类', '棘轮扳手', '长度：200mm'),
])
def test_caption_repair_keeps_every_page_and_visual(category, name, fact):
    from ai_refine_v2.visual_merchandising import repair_captions
    source, draft = fixture(category)
    source = category + name + '。' + fact
    draft['pages'] = [draft['pages'][0]]
    row = draft['pages'][0]
    row.update(title=fact+'，操作更快', body='覆盖全天保洁',
               evidence=[fact], technical_support=[fact])
    original = copy.deepcopy(draft)
    repaired = repair_captions(draft, source)
    assert draft == original
    assert repaired['pages'][0]['title'] == fact
    assert repaired['pages'][0]['body'] == ''
    assert len(repaired['pages']) == len(draft['pages'])
    assert repaired['pages'][0]['visual_brief'] == row['visual_brief']
    assert repaired['specifications'] == draft['specifications']
    assert len(repaired['caption_repairs']) == 2


def test_caption_repair_uses_complete_fact_and_keeps_final_guards():
    from ai_refine_v2.visual_merchandising import repair_captions
    source, draft = buyer_draft()
    row = draft['pages'][0]
    source += '充电时长8h。'
    row.update(title='续航8h，覆盖全天保洁', evidence=['充电时长8h。'],
               technical_support=['充电时长8h。'])
    row['visual_brief']['product_presentation'] = 'diagram_only'
    repaired = repair_captions(draft, source)
    assert repaired['pages'][0]['title'] == '充电时长8h'
    compile_plan(repaired, source, '', '设备类', buyer_value=True, delivery=True)
    # No unknown feature or visual is made valid by caption repair.
    row['title'] = '自动补水'
    with pytest.raises(ValueError):
        compile_plan(repair_captions(draft, source), source, '', '设备类', buyer_value=True, delivery=True)
    row['title'] = '充电时长8h'
    row['visual_brief'].update(product_presentation='concept_detail')
    row['component'] = '未知配套部件'
    with pytest.raises(ValueError):
        compile_plan(repair_captions(draft, source), source, '', '设备类', buyer_value=True, delivery=True)


def test_availability_rule_only_applies_to_new_policy():
    from ai_refine_v2.planning_quality import check_plan_quality
    from ai_refine_v2.visual_merchandising import CAPTION_REPAIR_VERSION
    plan = {'buyer_value_version':'buyer-value-v1', 'merchandising_version':'visual-merchandising-v1',
            'screens':[{'idx':1,'title':'覆盖全天保洁'}]}
    assert not check_plan_quality(plan, '续航8h', grounded_copy=True)
    plan['caption_repair_version'] = CAPTION_REPAIR_VERSION
    assert any(i['code'] == 'unbacked_availability'
               for i in check_plan_quality(plan, '续航8h', grounded_copy=True))


def test_source_rhetoric_is_tempered_in_all_printed_copy_without_changing_facts():
    from ai_refine_v2.visual_merchandising import repair_captions, render
    source, draft = fixture()
    quote = '风机功率1800W，杜绝扬尘扩散。IP55，全天候室外作业。'
    source += quote
    row = draft['pages'][0]
    row.update(title='杜绝扬尘扩散', body='全天候室外作业',
               evidence=[quote], technical_support=[quote])
    row['visual_brief']['product_presentation'] = 'diagram_only'
    draft['specifications'].append({'name': '防护', 'value': 'IP55，全天候室外作业',
                                     'evidence': quote})
    original = copy.deepcopy(draft)
    repaired = repair_captions(draft, source)
    assert repaired['pages'][0]['title'] == '减少扬尘扩散'
    assert repaired['pages'][0]['body'] == '室外作业'
    plan = compile_plan(repaired, source, '', '设备类', delivery=True, repair_copy=True)
    assert len(plan['screens']) == 4
    assert plan['screens'][1]['visual_brief'] == original['pages'][0]['visual_brief']
    assert plan['screens'][1]['technical_support'] == [quote]
    assert plan['specifications'] == original['specifications']
    assert draft == original
    printed = plan['screens'][1]['prompt'].split('只印以下文案，不印字段名，不自行添加小字：')[1]
    assert '杜绝' not in printed and '全天候' not in printed
    assert '1800W' in printed and 'IP55' in printed
    assert '全天候' not in plan['screens'][-1]['prompt']
    snapshot = copy.deepcopy(plan)
    render(plan)
    assert plan == snapshot  # Rendering again cannot accumulate repair records.


@pytest.mark.parametrize('text,expected', [
    ('彻底消除异味', '减少异味'),
    ('完全杜绝泄漏', '减少泄漏'),
    ('全天候户外运行', '户外运行'),
    ('无法杜绝故障', '无法杜绝故障'),
    ('不能完全消除异味', '不能完全消除异味'),
    ('未彻底消除异味', '未彻底消除异味'),
    ('不支持全天候室外作业', '不支持全天候室外作业'),
    ('不能保证完全消除异味', '不能保证完全消除异味'),
    ('不能浸水，全天候室外作业', '不能浸水，室外作业'),
    ('最大爬坡10°，过滤率99%，续航8~9h，防护IP55',
     '最大爬坡10°，过滤率99%，续航8~9h，防护IP55'),
])
def test_rhetoric_edit_is_generic_and_preserves_limits(text, expected):
    from ai_refine_v2.visual_merchandising import _temper_caption
    assert _temper_caption(text) == expected
