import copy
import json
import pytest

from ai_refine_v2.planning_quality import check_plan_quality, repair_plan_quality
from ai_refine_v2 import refine_planner as planner
from ai_refine_v2.tests.test_product_driven_planning import sample, response, TEXT


def codes(plan, source=TEXT):
    return {item['code'] for item in check_plan_quality(plan, source)}


@pytest.mark.parametrize('fresh', [True, False])
def test_fresh_quality_failure_does_not_retry_paid_planner(fresh):
    plan = sample()
    plan['screens'][0].update(title='转速可调', subtitle='按地面情况选择')
    calls = []
    def post(*args):
        calls.append(args)
        return response(plan, fresh=True)
    with pytest.raises(planner.PlannerError, match='unsupported_adjustability'):
        planner.plan_v2(TEXT + '刷盘最高270RPM。', api_key='test', max_retries=2,
                        http_fn=post, require_visual_strategy=fresh, enforce_quality=not fresh)
    assert len(calls) == 1


@pytest.mark.parametrize('fresh', [True, False])
def test_known_bad_point_is_omitted_without_another_request(fresh):
    plan = sample()
    plan['screens'][1].update(title='转速可调', subtitle='按地面情况选择')
    original = copy.deepcopy(plan)
    calls = []
    def post(*args):
        calls.append(args)
        return response(plan, fresh=True)
    result = planner.plan_v2(TEXT, api_key='test', max_retries=2, http_fn=post,
                             require_visual_strategy=fresh, enforce_quality=not fresh)
    assert len(calls) == 1
    assert plan == original
    assert result['screen_count'] == 3
    assert [p['id'] for p in result['selling_points']] == ['p2']
    assert result['specifications'] == plan['specifications']
    assert result['deferred_buying_points'][0]['id'] == 'p1'
    assert result['quality_adjustments'][0]['original_screens'][0]['title'] == '转速可调'


def test_repair_preserves_originals_and_safe_visuals_are_idempotent():
    plan = sample()
    plan['screens'][0]['prompt'] = '展示整机与工作站'
    plan['screens'][1]['visual_brief'] = {'product_presentation': 'visible_detail'}
    original = copy.deepcopy(plan)
    repaired = repair_plan_quality(plan, TEXT)
    assert plan == original
    assert not check_plan_quality(repaired, TEXT)
    assert repaired['screens'][0]['visual_brief']['product_presentation'] == 'whole_product'
    assert repaired['screens'][1]['visual_brief']['product_presentation'] == 'diagram_only'
    assert repaired['screens'][1]['role'] == 'feature_wall'
    assert repair_plan_quality(repaired, TEXT) == repaired
    assert planner._validate_schema_v2(repaired, TEXT) == []


@pytest.mark.parametrize('issue', ['duplicate', 'parameter'])
def test_redundant_pages_removed_but_specs_preserved(issue):
    plan = sample()
    if issue == 'duplicate':
        for p in plan['selling_points']:
            p['benefit'] = '日常清洁'
    else:
        plan['screens'][2]['title'] = '清洁宽度500mm'
    repaired = repair_plan_quality(plan, TEXT)
    assert repaired['screen_count'] == 3
    assert repaired['specifications'] == plan['specifications']
    assert [p['id'] for p in repaired['selling_points']] == ['p1']
    assert not check_plan_quality(repaired, TEXT)


def test_capability_must_match_subject_and_negation():
    plan = sample()
    plan['selling_points'][0]['benefit'] = '可调转速，按需作业'
    assert 'unsupported_adjustability' in codes(plan, '温度可调；转速最高270RPM')
    assert 'unsupported_adjustability' in codes(plan, '转速不可调')
    assert 'unsupported_adjustability' not in codes(plan, '转速可调，最高270RPM')
    plan['selling_points'][0]['benefit'] = '请勿宣称转速可调'
    assert 'unsupported_adjustability' not in codes(plan, '转速最高270RPM')
    plan['selling_points'][0]['benefit'] = '不锈钢面板支持调节速度'
    assert 'unsupported_adjustability' in codes(plan, '不锈钢面板')


def test_visual_and_parameter_issues_do_not_mutate_plan():
    plan = sample()
    plan['product_meta']['name'] = '室内设备（含工作站）'
    plan['screens'][0]['prompt'] = '展示整机与工作站。不添加未见配件。'
    plan['screens'][1]['visual_brief'] = {'product_presentation': 'visible_detail'}
    plan['screens'][1]['title'] = '清水18L污水24L'
    plan['selling_points'][0]['benefit'] = '连续作业少中断'
    before = copy.deepcopy(plan)
    assert {'unverified_companion', 'unverified_detail', 'parameter_only_title',
            'unsupported_comparison'} <= codes(plan)
    assert plan == before
    plan['screens'][0]['prompt'] = '用工作站功能图标示意。不展示工作站实物。'
    assert 'unverified_companion' not in codes(plan)
    plan['product_meta']['name'] = '充电桩'
    plan['screens'][0]['prompt'] = '按原图展示充电桩。'
    assert 'unverified_companion' not in codes(plan)


@pytest.mark.parametrize('direction', ['展示工作站且不添加品牌文字',
                                     'Show the docking station beside the robot without logos'])
def test_negative_guard_does_not_hide_positive_visual_instruction(direction):
    plan = sample()
    plan['screens'][0]['prompt'] = direction
    assert 'unverified_companion' in codes(plan)


@pytest.mark.parametrize('title', ['续航8小时', '转速270RPM', '清水18L污水24L'])
def test_parameter_only_title_includes_chinese_units(title):
    plan = sample()
    plan['screens'][1]['title'] = title
    assert 'parameter_only_title' in codes(plan)


def test_distinct_outcomes_may_share_evidence_but_not_repeat_outcome():
    plan = sample()
    for p, benefit in zip(plan['selling_points'], ('作业分工', '环境观感')):
        p.update(evidence=['自动洗地'], benefit=benefit)
    assert 'duplicate_outcome' not in codes(plan)
    plan['selling_points'][1]['benefit'] = '作业分工'
    assert 'duplicate_outcome' in codes(plan)


def test_saved_plan_is_not_rewritten_by_new_quality_rules():
    plan = sample()
    plan['screens'][1]['title'] = '转速可调'
    result = planner.plan_v2(TEXT, api_key='test', max_retries=0,
                            http_fn=lambda *args: response(plan), require_visual_strategy=False)
    assert result['screens'] == plan['screens']


def test_new_policy_requires_demand_analysis_without_retry_and_old_replay_survives():
    old = response(sample(), fresh=True)
    plan = json.loads(old['choices'][0]['message']['content'])
    del plan['demand_analysis_version']
    receipt = response(plan)
    calls = []
    def post(*args):
        calls.append(args)
        return receipt
    with pytest.raises(planner.PlannerError, match='买点推导'):
        planner.plan_v2(TEXT, api_key='test', http_fn=post, max_retries=2,
                        require_visual_strategy=False, require_demand_analysis=True)
    assert len(calls) == 1
    assert planner.plan_v2(TEXT, api_key='test', http_fn=post,
                           require_visual_strategy=False)['screens'] == plan['screens']


@pytest.mark.parametrize('category,name,fact,jobs', [
    ('设备类', '折叠输送机', '可折叠', ('转场运输', '闲置收纳')),
    ('配件类', '可拆卸防护罩', '可拆卸', ('检修接近', '替换防护件')),
    ('耗材类', '可裁切保护膜', '可裁切', ('按区域铺贴', '边角修整')),
    ('工具类', '折叠手推车', '可折叠', ('收工携带', '闲置收纳')),
])
def test_shared_fact_preserves_different_results_across_categories(category, name, fact, jobs):
    plan = sample(with_specs=False)
    source = name + '。' + fact + '。'
    plan['product_meta']['name'] = name
    plan['category_check'] = {'category': category, 'evidence': [name]}
    for point, job in zip(plan['selling_points'], jobs):
        point.update(text=job, need=job, benefit=job, outcome_key=job,
                     value_bridge=f'{fact}形态用于{job}', evidence=[fact])
    for screen in plan['screens']:
        screen.update(title=name if screen['role'] == 'hero' else jobs[screen['idx'] - 2],
                      subtitle='', evidence=[name if screen['role'] == 'hero' else fact])
    result = planner.plan_v2(source, api_key='test', product_category=category,
                             http_fn=lambda *args: response(plan, fresh=True), max_retries=0)
    assert len(result['selling_points']) == 2
    assert result['screen_count'] == 3
    assert result['category_check']['category'] == category


def test_same_outcome_different_audience_and_wording_merges_before_images():
    plan = sample()
    plan['selling_points'][0].update(audience='酒店库管', need='闲置时收起',
                                    benefit='收好空车', outcome_key='闲置收纳')
    plan['selling_points'][1].update(audience='工厂库管', need='不用时存放',
                                    benefit='方便储存', outcome_key='闲置收纳')
    result = planner.plan_v2(TEXT, api_key='test', max_retries=0,
                             http_fn=lambda *args: response(plan, fresh=True))
    assert [p['id'] for p in result['selling_points']] == ['p1']
    assert result['screen_count'] == 3
    assert result['deferred_buying_points'][0]['id'] == 'p2'
    assert len(result['demand_review']) == 2  # Original exploration remains auditable.


def test_demand_links_and_bridge_are_checked():
    from ai_refine_v2.planning_quality import validate_demand_analysis
    plan = json.loads(response(sample(), fresh=True)['choices'][0]['message']['content'])
    plan['demand_review'][0]['point_id'] = 'nonexistent'
    plan['selling_points'][1]['value_bridge'] = ''
    errors = validate_demand_analysis(plan)
    assert any('value_bridge' in error for error in errors)
    assert any('关联实际买点' in error for error in errors)


def test_review_can_reference_model_deferred_candidates():
    from ai_refine_v2.planning_quality import validate_demand_analysis
    plan = json.loads(response(sample(), fresh=True)['choices'][0]['message']['content'])
    deferred = plan['selling_points'].pop()
    plan['deferred_buying_points'] = [{**deferred, 'reason': 'duplicate_need'}]
    assert validate_demand_analysis(plan) == []
    plan['deferred_buying_points'][0]['value_bridge'] = ''
    assert any('value_bridge' in error for error in validate_demand_analysis(plan))


@pytest.mark.parametrize('failure', ['missing_version', 'wrong_category'])
def test_new_receipt_replay_cannot_bypass_version_or_category(failure):
    plan = json.loads(response(sample(), fresh=True)['choices'][0]['message']['content'])
    if failure == 'missing_version':
        del plan['buying_point_version']
    else:
        plan['category_check']['category'] = '耗材类'
    calls = []
    def post(*args):
        calls.append(args)
        return response(plan)
    with pytest.raises((planner.PlannerError, planner.ProductInputError)):
        planner.plan_v2(TEXT, product_category='设备类', api_key='test', http_fn=post,
                        max_retries=2, require_visual_strategy=False, require_demand_analysis=True)
    assert len(calls) == 1
