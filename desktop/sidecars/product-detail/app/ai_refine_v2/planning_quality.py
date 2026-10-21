"""Conservative, local checks; these do not prove arbitrary semantic entailment.

No model calls, inferred customer facts, or product-name exceptions. A text-only
planner cannot certify the visibility of a detail or a companion product.
"""
import copy
import json
import re

DEMAND_ANALYSIS_VERSION = "demand-analysis-v1"


def validate_demand_analysis(plan):
    """Validate the audit contract, not the truth of model-written reasoning."""
    if plan.get('demand_analysis_version') != DEMAND_ANALYSIS_VERSION:
        return ['缺少事实到客户结果的需求分析']
    points = plan.get('selling_points')
    deferred = plan.get('deferred_buying_points', [])
    review = plan.get('demand_review')
    if not isinstance(points, list) or not isinstance(deferred, list) or not isinstance(review, list) or not review:
        return ['需求分析必须记录候选及已考虑的需求方向']
    errors, ids, covered = [], set(), set()
    for point in points + deferred:
        if not isinstance(point, dict):
            return ['买点必须为对象']
        pid = point.get('id')
        if not isinstance(pid, str) or not pid.strip() or pid in ids:
            return ['买点缺少id或候选id重复']
        ids.add(pid)
        for field in ('value_bridge', 'outcome_key'):
            if not isinstance(point.get(field), str) or not point[field].strip():
                errors.append(f'{pid}缺少{field}：需说明事实如何帮助客户，以及去掉人群后的结果')
        if isinstance(point.get('outcome_key'), str) and not re.sub(r'[\W_]+', '', point['outcome_key']):
            errors.append(f'{pid}的工作结果不能仅含标点')
    for item in review:
        if not isinstance(item, dict) or not all(
            isinstance(item.get(key), str) and item[key].strip()
            for key in ('audience', 'need', 'reason')
        ):
            errors.append('需求覆盖记录缺少人群、工作问题或处理理由')
            continue
        decision = item.get('decision')
        if decision in ('covered', 'merged'):
            pid = item.get('point_id')
            if not isinstance(pid, str) or pid not in ids:
                errors.append('覆盖或合并的需求必须关联实际买点')
            else:
                covered.add(pid)
        elif decision not in ('unsupported', 'spec_only'):
            errors.append('需求处理只能是covered、merged、unsupported或spec_only')
        elif item.get('point_id') is not None:
            errors.append('未支持或仅参数的需求不得关联买点')
    if ids - covered:
        errors.append('每个买点必须关联需求覆盖记录')
    return errors


_NEGATIVE = re.compile(r"(?:不要|不得|不可|不能|不支持|不具备|不提供|不展示|不画|不宣称|禁止|勿|未提供|未展示|未知|没有|\b(?:no|not|without)\b)[^，。；;\n]{0,12}$", re.I)
_ADJUSTABLE = re.compile(
    r"(?P<subject>转速|速度|功率|温度|压力|流量|高度|角度|档位)[^，。；;\n]{0,6}(?:可调|调节|调整|选择)"
    r"|(?:可调|调节|调整|选择)[^，。；;\n]{0,6}(?P<reverse>转速|速度|功率|温度|压力|流量|高度|角度|档位)"
)
_COMPARATIVE = re.compile(r"少中断|减少.{0,8}(?:补水|换水|补给|中断)|(?:补水|换水|补给|中断).{0,6}(?:更少|减少)")
_COMPANION = re.compile(r"工作站|充电桩|基站|配套设备|docking station|charging dock|workstation", re.I)
_DRAW = re.compile(r"展示|呈现|绘制|摆放|放置|入画|特写|近景|\b(?:show|render|draw|place|display)\b", re.I)
_SCHEMATIC = re.compile(r"图标|图解|示意|不画实物|\b(?:icon|diagram|schematic)\b", re.I)
_SPEC_TITLE = re.compile(r"(?:[\u4e00-\u9fff]{1,10}\d+(?:\.\d+)?(?:小时|分钟|毫米|厘米|千克|公斤|毫升|转每分|升|米|瓦|伏|度|[a-zA-Z0-9./×%％\-]+))+", re.I)

_OUTCOME_RULES = (
    ("unbacked_comparison", r"更(?:快|宽|强|顺畅)|缩短[^，。；;\n]{0,12}时间|少占用[^，。；;\n]{0,8}时间",
     "参数不能单独证明相对提升或节省时间，需要原文对应效果依据"),
    ("unbacked_interruption", r"减少[^，。；;\n]{0,12}(?:断电|来回|工序)|减少先扫后拖",
     "续航或电机配置不能单独证明中断或工序减少"),
    ("unbacked_debris", r"吸走[^，。；;\n]{0,8}(?:碎屑|粉尘)|(?:同时|一道行进)[^，。；;\n]{0,15}(?:吸走碎屑|先扫后拖)",
     "吸风功率不能证明可回收粉尘碎屑或替代清扫工序"),
    ("unbacked_access", r"顺畅(?:行进|推进|转向)|(?:走廊|通道)[^，。；;\n]{0,8}顺畅",
     "驱动功率不能证明现场可达、转向条件或行进顺畅"),
)


def unsupported_outcome_claims(text, source, *, check_availability=False):
    """Known unsupported inference classes, not a general semantic judge."""
    found = []
    rules = _OUTCOME_RULES + (("unbacked_availability", r"(?:覆盖|满足)全天|全天(?:保洁|不停|不间断)",
                              "单次作业时长不能直接承诺覆盖全天需求"),) if check_availability else _OUTCOME_RULES
    for code, pattern, reason in rules:
        regex = re.compile(pattern)
        for clause in _clauses(text):
            for match in _positive_matches(regex, clause):
                # An explicit source assertion can support that assertion; a
                # number or an unrelated comparative elsewhere cannot.
                if not any(clause.strip() == original_clause.strip()
                           and not re.search(r"未(?:证明|证实)|未经证实|无法证明", original_clause)
                           and match.group() == backed.group()
                           for original_clause in _clauses(source)
                           for backed in _positive_matches(regex, original_clause)):
                    found.append({"code": code, "claim": match.group(), "message": reason})
    electrical = re.compile(r"插座|线路[^，。；;\n]{0,8}(?:负荷|承载)|现场供电|临时改电")
    if not re.search(r"充电(?:器|输入)|输入电压|电源输入|市电|交流输入|插座|线路", source):
        for clause in _clauses(text):
            for match in _positive_matches(electrical, clause):
                found.append({"code": "unbacked_supply_sizing", "claim": match.group(),
                              "message": "设备额定电压/电机功率不等于充电输入与现场配电要求"})
    return found


def _clauses(text):
    return [part for part in re.split(r"[，。；;\n.!?！？]", str(text or "")) if part.strip()]


def _positive_matches(pattern, clause):
    for match in pattern.finditer(clause):
        # Negation following the claim is irrelevant (e.g. show a workstation
        # without adding logos). 不锈钢 is a material, not a negation.
        prefix = clause[:match.start()]
        if not _NEGATIVE.search(prefix) and not _NEGATIVE.search(match.group()):
            yield match


def check_plan_quality(plan, source, *, text_only_reference=True, grounded_copy=False):
    """Return reviewable issues without mutating the saved plan or buying images."""
    issues = []
    visual_led = plan.get("merchandising_version") == "visual-merchandising-v1"
    source_clauses = _clauses(source)
    primary_name = re.split(r'[（(]|含|附带|配套', str((plan.get('product_meta') or {}).get('name', '')))[0]
    companion_is_primary = bool(_COMPANION.search(primary_name))
    delivery = plan.get('visual_delivery_version') == 'grounded-visual-delivery-v1'

    def add(code, location, message):
        issue = {"code": code, "location": location, "message": message}
        if issue not in issues:
            issues.append(issue)

    def claims(text, location):
        if plan.get("buyer_value_version") == "buyer-value-v1":
            for pattern in (
                r"自动(?:加水|补水|上水|下水|排污|排水)|无人(?:值守|作业|清扫)|夜间自主作业|定时(?:自主)?作业"
                if delivery else r"自动(?:加水|补水|上水|下水|排污|排水)|无人(?:值守|作业)|夜间自主作业|定时(?:自主)?作业",
                r"(?:一箱水|清水箱|水箱|储液)[^，。；;\n]{0,24}(?:小时|\d+h)",
            ):
                regex = re.compile(pattern)
                for clause in _clauses(text):
                    for match in _positive_matches(regex, clause):
                        def supports(value, original):
                            target = match.group()
                            if not delivery or target == value:
                                return target == value
                            if target == '无人值守':
                                return False
                            return target in ('无人清扫', '无人作业') and value in ('无人清扫', '无人作业', '无人值守')
                        if not any(supports(supported.group(), original)
                                   for original in source_clauses
                                   if not re.search(r"未(?:证明|证实|确认|说明)|未经证实|无法证明|尚不明确", original)
                                   for supported in _positive_matches(regex, original)):
                            add("unsupported_buyer_promise", location,
                                "自动能力或耗材容量对应作业时长需原文明确支持")
        if grounded_copy:
            for issue in unsupported_outcome_claims(text, source, check_availability=
                    plan.get('caption_repair_version') == 'grounded-caption-repair-v1'):
                add(issue["code"], location, issue["message"])
        for clause in _clauses(text):
            for match in _positive_matches(_ADJUSTABLE, clause):
                subject = match.group('subject') or match.group('reverse')
                if not any(any((m.group('subject') or m.group('reverse')) == subject
                               for m in _positive_matches(_ADJUSTABLE, s)) for s in source_clauses):
                    add('unsupported_adjustability', location, f'{subject}的数值或上限不能证明可调能力')
            if list(_positive_matches(_COMPARATIVE, clause)) and not any(list(_positive_matches(_COMPARATIVE, s)) for s in source_clauses):
                add('unsupported_comparison', location, '容量等规格不能证明补给或中断次数减少')

    seen = {}
    for point in plan.get('selling_points', []):
        pid = point.get('id', '')
        for key in ('text', 'need', 'benefit'):
            claims(point.get(key), f'{pid}.{key}')
        # Do not deduplicate by shared evidence or audience. Only identical
        # outcome statements are certain duplicates here; synonyms remain a
        # limitation, rather than a reason to silently drop distinct benefits.
        outcome = re.sub(r'[\W_]+', '', str(point.get('benefit', ''))).lower()
        if outcome and outcome in seen:
            add('duplicate_outcome', pid, f'与{seen[outcome]}重复同一收益，不能仅换人群拆图')
        seen[outcome] = pid

    for screen in plan.get('screens', []):
        location = f"screen_{screen.get('idx')}"
        for key in ('title', 'subtitle', 'body', 'prompt'):
            claims(screen.get(key), f'{location}.{key}')
        brief = screen.get('visual_brief') or {}
        for key, value in brief.items():
            claims(value, f'{location}.visual_brief.{key}')
        if not visual_led and screen.get('role') not in ('hero', 'spec_table'):
            title = re.sub(r'[\s，,：:、]', '', str(screen.get('title', '')))
            if _SPEC_TITLE.fullmatch(title):
                add('parameter_only_title', location, '标题仅列参数名称与数值，应归入参数页或表达独立客户用途')
        if text_only_reference:
            if not visual_led and brief.get('product_presentation') == 'visible_detail':
                add('unverified_detail', location, '文本策划未观察图片，不能断言指定局部在参考图中可见')
            directions = [screen.get('prompt', '')] + list(brief.values())
            for direction in directions:
                for clause in _clauses(direction):
                    if not (visual_led and brief.get('product_presentation') == 'concept_detail') and not companion_is_primary and list(_positive_matches(_COMPANION, clause)) and list(_positive_matches(_DRAW, clause)) and not _SCHEMATIC.search(clause):
                        add('unverified_companion', location, '仅文字提及配套设备不能证明参考图提供其外观，改用功能图解')
    return issues


def repair_plan_quality(plan, source):
    """Repair only known local issues; keep originals and never invent benefits."""
    result = copy.deepcopy(plan)
    issues = check_plan_quality(result, source)
    if not issues:
        return result
    points = {p['id']: p for p in result['selling_points']}
    screens = {f"screen_{s['idx']}": s for s in result['screens']}
    remove, redraw = {}, {}
    for issue in issues:
        location = issue['location'].split('.')[0]
        screen = screens.get(location)
        pid = screen.get('selling_point_id') if screen else location
        code = issue['code']
        if code in {'unverified_detail', 'unverified_companion'}:
            redraw.setdefault(location, []).append(code)
        elif pid in points:
            # A parameter page must already exist before a parameter-only
            # screen can be removed; otherwise leave the issue blocking.
            if code != 'parameter_only_title' or result.get('specifications'):
                remove.setdefault(pid, []).append(code)
    adjustments = result.setdefault('quality_adjustments', [])
    for pid, reasons in remove.items():
        originals = [copy.deepcopy(s) for s in result['screens'] if s.get('selling_point_id') == pid]
        result.setdefault('deferred_buying_points', []).append(
            {**copy.deepcopy(points[pid]), 'reason': reasons[0]})
        adjustments.append({'action': 'omit_buying_point', 'id': pid,
                            'reasons': sorted(set(reasons)), 'original_screens': originals})
    result['selling_points'] = [p for p in result['selling_points'] if p['id'] not in remove]
    result['screens'] = [s for s in result['screens'] if s.get('selling_point_id') not in remove]
    if result.get('primary_demonstration_id') in remove:
        result['primary_demonstration_id'] = None
    for location, reasons in redraw.items():
        screen = screens[location]
        if screen.get('selling_point_id') in remove:
            continue
        adjustments.append({'action': 'replace_visual_direction', 'idx': screen['idx'],
                            'reasons': sorted(set(reasons)), 'original_screen': copy.deepcopy(screen)})
        hero = screen['role'] == 'hero'
        spec = screen['role'] == 'spec_table'
        if not hero and not spec:
            screen['role'] = 'feature_wall'
        brief = {
            'product_presentation': 'whole_product' if hero else 'diagram_only',
            'scene': '沿用整套配色的简洁信息底图',
            'framing': '原图主体的整体视角，不指定未知部位' if hero else '平面文字信息图，不画内部结构',
            'product_action': '按Image 1展示原图主体' if hero else '不放产品实物，以已验证文案说明用途',
            'visual_evidence': '原图主体外形' if hero else '仅用本屏已验证的标题与说明表达，不模拟实测',
            'layout': '主体居中、标题居上、留足边距' if hero else '标题居上、说明居中，信息分组且留白',
        }
        screen['visual_brief'] = brief
        # Rebuild the complete instruction, rather than appending a prohibition
        # to an earlier contradictory request. Captions/specs stay unchanged.
        captions = {'title': screen.get('title', ''), 'subtitle': screen.get('subtitle', '')}
        if spec:
            captions['specifications'] = [{'name': s['name'], 'value': s['value']}
                                          for s in result['specifications']]
        screen['prompt'] = (
            '制作竖版产品详情图。沿用本套style_dna的色彩、字体、光照与留白，中文大字清晰可读。'
            '所有新增画面文字仅限下列JSON中的标题、说明与参数，不把字段名印到画面上：'
            + json.dumps(captions, ensure_ascii=False) + '。'
            + ('主体以Image 1为唯一外观依据，保留整体轮廓和可见标识。' if hero else
               '本页为平面信息图，只呈现文字和简洁几何分区，不安排整机、局部或配套实物。')
            + '不得新增配套设备，不画未知底部、内部、背面、接口或结构特写。'
            '不模拟实测场景、清洁前后对比、性能曲线或数据比例，不把示意图当作实物外形。'
            '保持单一视觉重点，标题与说明层级分明，四周留足边距，不添加认证、承诺、数字徽章。'
            'DO NOT INVENT any brand logos, company names, trademarks, certifications, '
            'or printed text NOT VISIBLE in Image 1. PRESERVE all existing labels, stickers, '
            'model markings, printed text exactly as shown in Image 1 (faithful to position, color, content). '
            'NO 「」-quoted headlines should be added ONTO the product surface itself.'
        )
    for idx, screen in enumerate(result['screens'], 1):
        screen['idx'] = idx
    result['screen_count'] = len(result['screens'])
    return result
