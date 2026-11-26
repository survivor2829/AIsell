"""Visual-led merchandising: mixed pages, selective benefits, two text calls.

No product-specific template. Historical policies keep their original contracts.
"""
import copy
import json
import re
from prompt_ref import prompt_ref, prompt_variant

VERSION = "visual-merchandising-v1"
BUYER_VERSION = "buyer-value-v1"
OUTLINE_VERSION = "buyer-use-outline-v1"
COPY_VERSION = "visual-preserving-copy-v1"
AUTO_VERSION = "product-use-visual-v1"
DELIVERY_VERSION = "grounded-visual-delivery-v1"
CAPTION_REPAIR_VERSION = "grounded-caption-repair-v1"

# The new default plans uses and visuals together. It deliberately does not
# inherit the old visual-only brief or its prohibition on supported scheduling.
AUTO_RULES = prompt_ref("detail.vm.auto_rules")

AUTO_REVIEW = prompt_ref("detail.vm.auto_review")

COPY_RULES = prompt_ref("detail.vm.copy_rules")


def apply_copy_edits(draft, reply):
    """Only captions are mutable. Model output cannot replace visual planning."""
    from .refine_planner import _extract_json
    changes = _extract_json(reply)
    if set(changes) != {"edits"} or not isinstance(changes["edits"], list):
        raise ValueError("文案编辑只能返回edits，不能重编画面")
    result = copy.deepcopy(draft)
    pages = [result["cover"], *result["pages"]]
    seen = set()
    for edit in changes["edits"]:
        if not isinstance(edit, dict) or set(edit) != {"screen", "title", "body"}:
            raise ValueError("文案编辑只允许修改标题和一句说明")
        index = edit["screen"]
        if type(index) is not int or not 1 <= index <= len(pages) or index in seen:
            raise ValueError("文案编辑页码无效或重复")
        if not isinstance(edit["title"], str) or not edit["title"].strip():
            raise ValueError("文案标题不能为空")
        if not isinstance(edit["body"], str) or len(edit["body"]) > 40:
            raise ValueError("说明必须为空或不超过40字")
        pages[index - 1].update(title=edit["title"], body=edit["body"])
        seen.add(index)
    return result
RULES = prompt_ref("detail.vm.rules")

BRIEF = {"product_presentation": "whole_product|working_scene|visible_detail|concept_detail|diagram_only|small_reference",
         "scene": "有针对性的画面", "framing": "画面主角与景别", "product_action": "已知动作或静态展示",
         "visual_evidence": "用画面说明什么", "layout": "大标题、参数与主体的布局"}

BUYER_RULES = prompt_ref("detail.vm.buyer_rules")


# Detail screens per plan (user 2026-11-06: 8–15, as many as the material supports).
PLANNED_SCREEN_LIMIT = 15
# 配件、耗材、工具（用户 2026-11-13）：客户给的资料通常就那么些，凑满8屏只会出现大同小异的图。
# 整套（含封面和参数表）最多8屏，不设最低数量；设备类仍是8至15屏。
COMPACT_CATEGORIES = frozenset({"配件类", "耗材类", "工具类"})
COMPACT_SCREEN_LIMIT = 8


def screen_limit(category=None):
    return COMPACT_SCREEN_LIMIT if category in COMPACT_CATEGORIES else PLANNED_SCREEN_LIMIT


# The general prompts are written for 设备类 (8–15 screens). For the compact categories their
# screen-count wording is rewritten, so one prompt never asks for both "至少8屏" and "最多8屏".
_COMPACT_WORDING = (
    ("正常资料整套8至15屏", f"整套最多{COMPACT_SCREEN_LIMIT}屏、不设最低数量"),
    ("保留正常资料至少8屏：一个真实作用可以由作业图、相关部件图、原理图解释，",
     f"整套最多{COMPACT_SCREEN_LIMIT}屏：每个作用只做一页，"),
    ("而非只删到不足8屏", "资料不够就少出页"),
    ("保留正常资料至少8屏的丰富度", f"整套最多{COMPACT_SCREEN_LIMIT}屏，每个作用只做一页"),
)


def fit_category(system, category=None):
    if category not in COMPACT_CATEGORIES:
        return system
    for old, new in _COMPACT_WORDING:
        system = system.replace(old, new)
    # Stored prompts are tokens on a customer computer: each has a ".compact" variant on the server holding the same
    # wording change (scripts/prompt_variants.py), so both paths send the same text.
    return prompt_variant(system, "compact")


def category_rule(category=None):
    """Appended last to every planning call for the compact categories."""
    if category not in COMPACT_CATEGORIES:
        return ""
    return (f"{prompt_ref('detail.vm.category_rule.p1')}{category}{prompt_ref('detail.vm.category_rule.p2')}{COMPACT_SCREEN_LIMIT}{prompt_ref('detail.vm.category_rule.p3')}")


# Three extra 1:1 e-commerce images (主图/场景图/参数图), redrawn square from the matching
# detail screens and generated with them; they never enter the long detail image.
SQUARE_KINDS = {"main": "主图", "scene": "场景图", "spec": "参数图"}
SQUARE_VERSION = "square-ecommerce-v1"


def screen_budget(source, category=None):
    from .buyer_copy import screen_budget as legacy_budget
    sparse = legacy_budget(source, False)["sparse_exception_eligible"]
    compact = category in COMPACT_CATEGORIES
    return {"minimum_total_screens": 1 if sparse or compact else 8,
            "maximum_total_screens": screen_limit(category), "sparse_exception_eligible": sparse}


def prompt(buyer_value=False, *, automatic=False):
    return (AUTO_RULES if automatic else BUYER_RULES if buyer_value else RULES) + prompt_ref("detail.vm.output_intro") + json.dumps({
        "category_check": {"category": "设备类/配件类/耗材类/工具类", "evidence": ["原文品类依据"]},
        "product_meta": {"name": "原产品名", "category": "实际品类",
                         "primary_color": "Image 1 authoritative", "key_visual_parts": ["follow reference image"]},
        "style_dna": {"color_palette": "依据产品的配色", "lighting": "光照",
                      "composition_style": "不同信息不同构图", "mood": "专业",
                      "typography_hint": "手机大字可读", "unified_visual_treatment": "整套风格与产品原色相容"},
        "cover": {"title": "产品定位", "evidence": ["原文"], "visual_brief": BRIEF},
        "pages": [{"kind": "benefit或display", "role": "scenario或detail_zoom或feature_wall等",
                   "title": "直接易懂的标题，可含参数", "body": "", "technical_support": ["原文"],
                   "evidence": ["原文"], "component": "仅concept_detail必填原文部件名",
                   "visual_brief": BRIEF}],
        "specifications": [{"name": "参数名", "value": "原值含限定", "evidence": "原文"}],
    }, ensure_ascii=False)


def outline_prompt():
    # Deliberately no screen/title schema: do not anchor the editor to one
    # page per specification before the customer's use has been established.
    return prompt_ref("detail.vm.application_analysis")


def read_outline(raw, source, category, title):
    from .refine_planner import _extract_json, _check_product_category
    data = _extract_json(raw)
    _check_product_category(data, category, source, title)
    for collection, fields in (
        ("purchase_reasons", ("buyer_task", "help", "mechanism", "limits")),
        ("supporting_displays", ("subject", "purpose")),
    ):
        rows = data.get(collection)
        if not isinstance(rows, list) or len(rows) > 40:
            raise ValueError(f"{collection}必须为不超过40项的数组")
        for row in rows:
            if not isinstance(row, dict) or any(not isinstance(row.get(k), str) or not row[k].strip() for k in fields):
                raise ValueError("购买作用分析缺少实际任务、作用或边界")
            proof = row.get("evidence")
            if not isinstance(proof, list) or not proof or not all(isinstance(q, str) and q.strip() and q in source for q in proof):
                raise ValueError("购买作用分析缺少原文依据")
    return data


def components_supported(component, evidence):
    """Accept one named part or an explicit list; every listed part needs proof."""
    if not isinstance(component, str) or not component.strip():
        return False
    proof = [q for q in evidence if isinstance(q, str)]
    if any(component.strip() in q for q in proof):
        return True
    parts = re.split(r"[、，,+＋]", component)
    return all(part.strip() and any(part.strip() in q for q in proof) for part in parts)


def _whole_product_visual(page):
    """Draw the whole product instead of a part the copy never names."""
    brief = page.setdefault("visual_brief", {})
    brief.pop("component", None)
    page.pop("component", None)
    brief.update(product_presentation="whole_product", framing="整机主体清晰完整",
                 product_action="静态展示")


def normalize_components(data, *, degrade=False):
    """Accept a misplaced, evidenced component; never infer or invent one.

    With degrade, a page whose part has no source proof is redrawn as the
    whole product (recorded in visual_degradations) instead of failing the
    whole plan: plain spec copy names no parts, and that must still deliver.
    """
    result = copy.deepcopy(data)
    # Only our code records these; a model draft cannot set them.
    result.pop("visual_degradations", None)
    result.pop("dropped_pages", None)
    degraded = []
    for index, page in enumerate([result["cover"], *result["pages"]], 1):
        brief = page.get("visual_brief") or {}
        nested = brief.get("component")
        evidence = page.get("evidence", [])
        if nested is None:
            if brief.get("product_presentation") == "concept_detail" and not components_supported(
                page.get("component"), evidence
            ):
                if not degrade:
                    raise ValueError("部件字段引用了原文未明确的部件，文案编辑不能改变部件")
                degraded.append({"page": index, "component": page.get("component"),
                                 "reason": "component_not_in_source"})
                _whole_product_visual(page)
            continue
        outer = page.get("component")
        if outer not in (None, "", nested):
            if not degrade:
                raise ValueError("部件字段内外冲突，需确认该页主体")
            # Keep whichever named part the copy actually supports.
            nested = outer if components_supported(outer, evidence) else nested
        if not components_supported(nested, evidence):
            if not degrade:
                raise ValueError("部件字段引用了原文未明确的部件，需替换画面而非只移动字段")
            degraded.append({"page": index, "component": nested, "reason": "component_not_in_source"})
            _whole_product_visual(page)
            continue
        page["component"] = nested
        del brief["component"]
    if degraded:
        result["visual_degradations"] = degraded
    return result


def source_quote(quote, source):
    """Restore a whitespace-only variant to its actual source span, not fuzzy facts."""
    if not isinstance(quote, str) or not quote.strip():
        raise ValueError("原文引用为空或类型错误")
    if quote in source:
        return quote
    compact = re.sub(r"\s+", "", quote)
    match = re.search(r"\s*".join(map(re.escape, compact)), source)
    if match:
        def protected(text):
            return re.sub(r"\s+", "", re.sub(r"(?<=\d)\s+(?=\d)", "|", text))
        if protected(match.group()) == protected(quote):
            return match.group()
    # A label on its own line may be quoted as "label: value". Match only
    # that separator; do not discard decimal points, signs or range markers.
    if ':' in quote or '：' in quote:
        pattern = r'\s*'.join(r'(?:[：:]|\r?\n)' if c in ':：' else re.escape(c)
                              for c in compact)
        match = re.search(pattern, source)
        if match and not re.search(r'(?<=\d)\s+(?=\d)', match.group()):
            return match.group()
    raise ValueError("原文引用内容不匹配，不能用格式兼容补造事实")


# Full-width and half-width spellings of the same punctuation mark.
_PUNCT_EQUIV = {'，': ',', '；': ';', '（': '(', '）': ')', '！': '!', '？': '?',
                '／': '/', '＞': '>', '＜': '<', '～': '~', '＋': '+', '％': '%'}
_LABEL_GAP = r'[\s：:]*'


def _punct_canonical(text):
    return ''.join(_PUNCT_EQUIV.get(c, c) for c in text)


def _quote_char(c):
    canonical = _PUNCT_EQUIV.get(c, c)
    spellings = {canonical, *(k for k, v in _PUNCT_EQUIV.items() if v == canonical)}
    if len(spellings) == 1:
        return re.escape(c)
    return '[' + ''.join(re.escape(s) for s in sorted(spellings)) + ']'


def final_source_quote(quote, source):
    """source_quote, plus a missing/extra label colon and full-width punctuation.

    Used only on the editor's final draft. Only whitespace, a label colon or the
    width of a punctuation mark may differ; every character of every fact must
    appear in order, digits the source separates stay separated, and the
    returned text is always the exact source span.
    """
    try:
        return source_quote(quote, source)
    except ValueError:
        if not isinstance(quote, str):
            raise
    chars = [c for c in quote if not c.isspace() and c not in ':：']
    if len(chars) < 2:
        raise ValueError("原文引用内容不匹配，不能用格式兼容补造事实")
    match = re.search(_LABEL_GAP.join(_quote_char(c) for c in chars), source)
    if match:
        def protected(text):
            text = re.sub(r'(?<=\d)[\s：:]+(?=\d)', '|', _punct_canonical(text))
            return re.sub(r'[\s：:]', '', text)
        if protected(match.group()) == protected(quote):
            return match.group()
    raise ValueError("原文引用内容不匹配，不能用格式兼容补造事实")


_DEFAULT_BRIEF = {"product_presentation": "whole_product", "scene": "干净背景下的产品主视觉",
                  "framing": "整机主体清晰完整", "product_action": "静态展示",
                  "visual_evidence": "产品原图外观", "layout": "大标题、关键参数与产品主体"}


def _first_source_line(source, title):
    if isinstance(title, str) and title.strip() and title.strip() in source:
        return title.strip()
    return next((line.strip() for line in source.splitlines() if line.strip()), source.strip())


_SALVAGE_RECORDS = ("quote_repairs", "salvage_dropped_pages", "planning_source", "final_draft_issue",
                    "dropped_spec_rows")


def salvage_draft(data, source, title=""):
    """Keep what the paid final draft can prove; drop only the unproven part.

    A quote that is not in the source is removed, never rewritten. A page left
    with no source proof, title or usable shape is removed; a parameter row
    without proof is removed. The cover keeps the product, falling back to the
    customer's own title or a source line. Nothing is invented or re-purchased.
    """
    from .refine_planner import _normalize_claim_text
    result = copy.deepcopy(data)
    removed, dropped = [], []

    # Category proof: keep the provable items; the customer's own title (which
    # the category check already counts as source) stands in if none remain.
    check = result["category_check"]
    known = _normalize_claim_text(source + " " + (title or ""))
    proof = check.get("evidence") if isinstance(check.get("evidence"), list) else []
    kept_proof = [q for q in proof if isinstance(q, str) and q.strip() and _normalize_claim_text(q) in known]
    if len(kept_proof) != len(proof) or not kept_proof:
        removed.extend({"where": "category_check", "field": "evidence", "quote": str(q)[:80]}
                       for q in proof if q not in kept_proof)
        check["evidence"] = kept_proof or [_first_source_line(source, title)]

    def quotes(row, key, where):
        values = row.get(key)
        if values is None:
            return []
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list):
            removed.append({"where": where, "field": key, "quote": str(values)[:80]})
            return []
        kept = []
        for quote in values:
            try:
                kept.append(final_source_quote(quote, source))
            except ValueError:
                removed.append({"where": where, "field": key, "quote": str(quote)[:80]})
        return list(dict.fromkeys(kept))

    def clean(row, where):
        evidence = quotes(row, "evidence", where)
        support = quotes(row, "technical_support", where)
        # A proven big-number fact is also proof for its own page.
        evidence += [q for q in support if not any(q in e for e in evidence)]
        row["evidence"] = evidence
        # A bare value must retain the mode/maximum qualifiers in its evidence.
        row["technical_support"] = list(dict.fromkeys(
            min((e for e in evidence if q in e), key=len) for q in support))
        brief = row.get("visual_brief")
        if not isinstance(brief, dict):
            brief = row["visual_brief"] = {}
        for key, default in _DEFAULT_BRIEF.items():
            if not isinstance(brief.get(key), str) or not brief[key].strip():
                brief[key] = default
        if '无人值守' not in source and '无人清扫' in source:
            for key, value in brief.items():
                if isinstance(value, str):
                    brief[key] = value.replace('无人值守', '无人清扫')

    cover = result["cover"]
    clean(cover, "cover")
    if not cover["evidence"]:
        cover["evidence"] = [_first_source_line(source, title)]
    if not isinstance(cover.get("title"), str) or not cover["title"].strip():
        cover["title"] = title.strip() if isinstance(title, str) and title.strip() else cover["evidence"][0][:20]
    pages = []
    for index, page in enumerate(result["pages"], 1):
        if not isinstance(page, dict):
            dropped.append({"title": None, "issue": "页面格式无效"})
            continue
        clean(page, f"page{index}")
        if not isinstance(page.get("title"), str) or not page["title"].strip():
            dropped.append({"title": None, "issue": "展示页缺少标题"})
        elif not page["evidence"]:
            dropped.append({"title": page["title"], "issue": "展示页缺原文依据"})
        else:
            pages.append(page)
    result["pages"] = pages
    specs = []
    for spec in result["specifications"]:
        if not isinstance(spec, dict) or not all(
            isinstance(spec.get(k), str) and spec[k].strip() for k in ("name", "value", "evidence")
        ):
            removed.append({"where": "specifications", "field": "row", "quote": str(spec)[:80]})
            continue
        try:
            spec["evidence"] = final_source_quote(spec["evidence"], source)
        except ValueError:
            removed.append({"where": "specifications", "field": "evidence", "quote": spec["evidence"][:80]})
            continue
        specs.append(spec)
    result["specifications"] = specs
    result["quote_repairs"] = removed
    result["salvage_dropped_pages"] = dropped
    return result


def normalize_quotes(data, source):
    result = copy.deepcopy(data)
    for row in [result["cover"], *result["pages"]]:
        for key in ("evidence", "technical_support"):
            if key in row:
                if not isinstance(row[key], list):
                    raise ValueError(f"{key}必须为原文引用数组")
                row[key] = [source_quote(q, source) for q in row[key]]
        # A bare value must retain the mode/maximum qualifiers in its evidence.
        row['technical_support'] = [min((e for e in row.get('evidence', []) if q in e),
                                       key=len, default=q)
                                    for q in row.get('technical_support', [])]
        # Correct scene wording to the supplied capability, without changing
        # layout or inventing an unattended-operation promise in printed copy.
        if '无人值守' not in source and '无人清扫' in source:
            brief = row.get('visual_brief') or {}
            for key, value in brief.items():
                if isinstance(value, str):
                    brief[key] = value.replace('无人值守', '无人清扫')
    for spec in result["specifications"]:
        spec["evidence"] = source_quote(spec["evidence"], source)
    return result


def _check_capacity(data):
    if data.get("capacity_exceeded") is True:
        from .refine_planner import ProductInputError
        raise ProductInputError("AI_REFINE_TOO_MANY_SCREENS", "独立卖点加封面和参数图超过15张，请精简或分批提供资料；尚未提交生图")


def read_draft(raw, source, *, delivery=False, salvage=False, title=""):
    """Parse and check a draft. With salvage (final delivery draft only), an
    unprovable quote, page or parameter row is removed instead of failing."""
    from .refine_planner import _extract_json
    from .candidate_plan import restore_spec_values
    data = _extract_json(raw)
    _check_capacity(data)
    for key in _SALVAGE_RECORDS:
        data.pop(key, None)  # Only our code records these; a model draft cannot set them.
    if salvage:
        if not isinstance(data.get("cover"), dict):
            data["cover"] = {}
        for key in ("category_check", "product_meta", "style_dna"):
            if not isinstance(data.get(key), dict):
                raise ValueError(f"{key}必须为对象")
        if data.get("specifications") is None:
            data["specifications"] = []
    for key in ("category_check", "product_meta", "style_dna", "cover"):
        if not isinstance(data.get(key), dict):
            raise ValueError(f"{key}必须为对象")
    pages, specs = data.get("pages"), data.get("specifications")
    if not isinstance(pages, list) or not isinstance(specs, list):
        raise ValueError("pages与specifications必须为数组")
    if len(pages) > 40:
        raise ValueError("文字候选异常过多")
    if delivery and salvage:
        data = salvage_draft(data, source, title)
        pages, specs = data["pages"], data["specifications"]
    elif delivery:
        data = normalize_quotes(data, source)
        pages, specs = data["pages"], data["specifications"]
    for page in [data["cover"], *pages]:
        if not isinstance(page, dict) or not isinstance(page.get("title"), str) or not page["title"].strip():
            raise ValueError("展示页缺少标题")
        proof = page.get("evidence")
        if not isinstance(proof, list) or not proof or not all(
            isinstance(q, str) and q.strip() and q in source for q in proof
        ):
            raise ValueError("展示页缺原文依据")
        brief = page.get("visual_brief")
        if not isinstance(brief, dict) or not all(
            isinstance(brief.get(k), str) and brief[k].strip() for k in BRIEF
        ):
            raise ValueError("展示页缺完整画面设计")
    for spec in specs:
        if not isinstance(spec, dict) or not all(
            isinstance(spec.get(k), str) and spec[k].strip() for k in ("name", "value", "evidence")
        ):
            raise ValueError("参数记录不完整")
    restore_spec_values(specs, source)
    return data


def _temper_caption(text):
    """Narrow explicit guarantees, including those copied from source material.

    Only wording changes: no number conversion, new function or weather claim.
    Negative limitations remain intact instead of becoming positive promises.
    """
    def replace(match):
        clause_prefix = re.split(r'[，,；;。！？!?\n]', text[:match.start()])[-1]
        if re.search(r'不|未|无法|难以|并非', clause_prefix):
            return match.group()
        if match.group().startswith('全天候'):
            return (match.group(1) or '日常') + match.group(2)
        return '减少'

    return re.sub(r'(?:彻底|完全)(?:杜绝|消除)|杜绝|全天候(室外|户外)?(作业|运行|使用)',
                  replace, text)


def printable_captions(plan, screen):
    captions = {k: screen.get(k) for k in ("title", "subtitle", "body", "technical_support")}
    if screen["role"] == "spec_table":
        captions["specifications"] = plan["specifications"]
    if plan.get('caption_repair_version') != CAPTION_REPAIR_VERSION:
        return captions
    if screen['role'] == 'spec_table':
        # Evidence stays unchanged in the plan and is never printed as a table value.
        captions['specifications'] = [{k: row[k] for k in ('name', 'value')} for row in plan['specifications']]
    def temper(value):
        if isinstance(value, str):
            return _temper_caption(value)
        if isinstance(value, list):
            return [temper(v) for v in value]
        if isinstance(value, dict):
            return {k: temper(v) for k, v in value.items()}
        return value
    return temper(captions)


def render(plan):
    for screen in plan["screens"]:
        captions = printable_captions(plan, screen)
        if plan.get('caption_repair_version') == CAPTION_REPAIR_VERSION:
            for key, edited in captions.items():
                value = plan['specifications'] if key == 'specifications' else screen.get(key)
                if edited != value:
                    change = {'screen': screen['idx'], 'field': key, 'before': value,
                              'after': edited, 'reason': 'absolute_rhetoric'}
                    repairs = plan.setdefault('caption_repairs', [])
                    if change not in repairs:
                        repairs.append(change)
        screen["prompt"] = (
            prompt_ref("detail.vm.screen_prompt")
            + (prompt_ref("detail.vm.screen_prompt_auto")
               if plan.get("automatic_planning_version") == AUTO_VERSION else "")
            +
            "整套设计：" + json.dumps(plan["style_dna"], ensure_ascii=False)
            + "。本页构图：" + json.dumps(screen["visual_brief"], ensure_ascii=False)
            + "。本页部件主体（不是印刷文字）："
            + json.dumps(screen.get("component"), ensure_ascii=False)
            + "。只印以下文案，不印字段名，不自行添加小字："
            + json.dumps(captions, ensure_ascii=False)
        )


def keep_person_scene(pages, slots):
    """The person-at-work scene feeds the square e-commerce 场景图; never let the cap defer it.
    Salvage maps screen numbers back to page positions, so it applies the same order first."""
    pages = list(pages)
    scene = next((i for i, page in enumerate(pages) if page.get("role") == "lifestyle_demo"), None)
    if scene is not None and slots > 0 and scene >= slots:
        pages.insert(slots - 1, pages.pop(scene))
    return pages


def compile_plan(data, source, title, category, *, buyer_value=False, buyer_outline=False, delivery=False, repair_copy=False, check=True):
    from .refine_planner import PLANNING_VERSION
    plan = normalize_components(data) if buyer_outline else copy.deepcopy(data)
    plan.pop('caption_repair_version', None)
    if repair_copy:
        plan['caption_repair_version'] = CAPTION_REPAIR_VERSION
    plan.update(planning_version=PLANNING_VERSION, merchandising_version=VERSION,
                visual_strategy_version="selling-point-evidence-v1",
                primary_demonstration_id=None, selling_points=[], screens=[])
    if delivery:
        plan["visual_delivery_version"] = DELIVERY_VERSION
    else:
        plan.pop("visual_delivery_version", None)  # Model fields cannot select policy.
    if buyer_value:
        plan["buyer_value_version"] = BUYER_VERSION
        plan["screen_budget"] = screen_budget(source, category)
    if buyer_outline:
        plan["buyer_outline_version"] = OUTLINE_VERSION
    cover = plan.pop("cover")
    plan["screens"].append({**cover, "role": "hero", "selling_point_id": None})
    slots = screen_limit(category) - 1 - int(bool(plan["specifications"]))
    pages = keep_person_scene(plan.pop("pages"), slots)
    plan["deferred_pages"] = pages[slots:]  # Text only, never passed to the image queue.
    for page in pages[:slots]:
        if page.get("kind") not in ("benefit", "display") or page.get("role") in ("hero", "spec_table"):
            raise ValueError("中间页面必须明确购买理由或展示类型，不能重复封面参数表")
        pid = None
        if page["kind"] == "benefit":
            pid = f"p{len(plan['selling_points']) + 1}"
            plan["selling_points"].append({"id": pid, "text": page["title"], "evidence": page["evidence"]})
        plan["screens"].append({**page, "selling_point_id": pid})
    if plan["specifications"]:
        plan["screens"].append({
            "role": "spec_table", "kind": "display", "title": "产品参数", "selling_point_id": None,
            "evidence": [s["evidence"] for s in plan["specifications"]],
            "visual_brief": {"product_presentation": "diagram_only", "scene": "清晰参数表",
                             "framing": "参数信息主导", "product_action": "静态信息",
                             "visual_evidence": "原文技术规格", "layout": "大字参数分组，手机可读"},
        })
    for i, s in enumerate(plan["screens"], 1):
        s.update(idx=i, body=s.get("body") or "", subtitle="",
                 technical_support=s.get("technical_support") or [])
    plan["screen_count"] = len(plan["screens"])
    plan["input_evidence"] = {"product_text": source, "product_title": title, "product_category": category}
    render(plan)
    if check:
        validate(plan, source, title, category)
    return plan


def detail_screens(plan):
    """The detail screens without the appended 1:1 e-commerce images."""
    return [s for s in plan.get("screens") or [] if not s.get("square")]


def square_wording(text):
    """Rewrite the portrait wording of a detail-screen prompt for a square picture."""
    text = re.sub(r"3\s*[:：]\s*4", "1:1", text)
    for portrait, square in (("竖版详情图", "1:1方形电商主图"), ("竖版", "方形"), ("竖构图", "方形构图"),
                             ("detail image", "e-commerce main image"), ("portrait", "square"), ("Portrait", "Square")):
        text = text.replace(portrait, square)
    return text


def add_square_screens(plan):
    """Append the 1:1 主图/场景图/参数图 as extra screens of the same plan, so they share the
    paid pipeline's quote, receipts and recovery. Each copies its source screen's verified
    captions and visual brief and is generated square instead of 3:4."""
    screens = detail_screens(plan)

    def first(test):
        return next((s for s in screens if test(s)), None)

    def presentation(screen):
        brief = screen.get("visual_brief") if isinstance(screen.get("visual_brief"), dict) else {}
        return brief.get("product_presentation")

    sources = {
        "main": first(lambda s: s.get("role") == "hero"),
        # Never the cover: that would buy a near copy of the 主图.
        "scene": first(lambda s: s.get("role") == "lifestyle_demo")
                 or first(lambda s: s.get("role") != "hero"
                          and (s.get("role") == "scenario" or presentation(s) == "working_scene")),
        "spec": first(lambda s: s.get("role") == "spec_table"),
    }
    squares = []
    for kind, source in sources.items():
        if source is None:
            continue
        square = copy.deepcopy(source)
        square.update(square=kind, square_source_idx=source.get("idx"), selling_point_id=None)
        square["prompt"] = (
            "1:1 SQUARE E-COMMERCE MAIN IMAGE (" + SQUARE_KINDS[kind] + "): redesign this screen for a square "
            "marketplace listing frame; product large and fully visible, every supplied word inside the square, "
            "nothing cropped at the edges. " + square_wording(str(source.get("prompt") or ""))
        )
        squares.append(square)
    plan["screens"] = screens + squares
    for i, s in enumerate(plan["screens"], 1):
        s["idx"] = i
    plan["square_version"] = SQUARE_VERSION if squares else None
    return plan


def validate(plan, source, title="", category=None):
    squares = [s for s in plan.get("screens") or [] if s.get("square")]
    if squares:
        core = detail_screens(plan)
        indices = {s.get("idx") for s in core}
        if (len(squares) > len(SQUARE_KINDS) or len({s["square"] for s in squares}) != len(squares)
                or any(s["square"] not in SQUARE_KINDS or s.get("square_source_idx") not in indices for s in squares)):
            raise ValueError("1:1 电商图方案异常，尚未提交生图")
        plan = {**plan, "screens": core, "screen_count": len(core)}
    issues = plan_issues(plan, source, title, category)
    if issues:
        raise ValueError("视觉策划未通过，尚未提交生图：" + "; ".join(message for _, message in issues))


def _screen_of(location, plan):
    """Map an issue location (screen_3, screens[2], p1.text) to a screen idx."""
    match = re.match(r"screen_(\d+)", location or "")
    if match:
        return int(match.group(1))
    match = re.match(r"screens\[(\d+)\]", location or "")
    if match:
        return int(match.group(1)) + 1
    if re.match(r"specifications\[\d+\]", location or ""):
        # A parameter row belongs to the parameter screen, so salvage can drop
        # just that row instead of failing the whole paid plan (2026-11-14: a
        # tool's "32英寸/70cm" against the source's 32"/70cm).
        return next((s.get("idx") for s in plan.get("screens", []) if s.get("role") == "spec_table"), None)
    pid = (location or "").split(".")[0]
    return next((s.get("idx") for s in plan.get("screens", []) if pid and s.get("selling_point_id") == pid), None)


CAPTION_VALUE_ISSUE = "标题或解释出现原文没有的参数值/单位："


def _caption_values(delivery):
    """The value pattern and the one written form captions and source are compared in."""
    from .refine_planner import spell_units
    # Delivery plans first write equal values one way (500*300mm/500×300毫米,
    # 5L/5升, 40℃/40°C, 32"/32英寸, full-width digits); only there can 英寸 and
    # m2/m3 be checked without flagging a correct title. Never arithmetic.
    numeric = re.compile(
        r"\d+(?:\.\d+)?(?:[×x*]\d+(?:\.\d+)?)?(?:[-–—~～]\d+(?:\.\d+)?)?"
        r"(?:km/h|m/s|m²/h|m2/h|mAh|Ah|kW|W|kPa|Pa|RPM|mm|cm|kg|ml|mL|L|V|h|小时|分钟|毫米|厘米|公斤|升|伏|瓦|%|％"
        + (r"|英寸|°|度|m2|m3)" if delivery else r"|°|度)"),
        re.I)
    def compact(value):
        if delivery:
            value = spell_units(value)  # Before spaces go: 5升 水箱 is a unit, 5升级 is not.
        # Two numbers a space apart stay two numbers: 4100x1525x2050 66升 is not 205066升.
        value = re.sub(r"(?<=\d)\s+(?=\d)", "|", value)
        return re.sub(r"\s+", "", value).replace("–", "-").replace("—", "-").replace("％", "%").lower()
    return numeric, compact


_LOOSE_NUMBER = re.compile(r"\d+(?:\.\d+)?(?:\s*[×x*]\s*\d+(?:\.\d+)?)?(?:\s*[-–—~～至到]\s*\d+(?:\.\d+)?)?", re.I)


def strip_caption_value(text, value, delivery=True):
    """The caption without one value the source does not support; the rest of it stays.

    A caption is a sentence the AI wrote; an unsupported number in it is removed, not
    the page (2026-11-17: the same invented 30英寸 on several pages dropped them all
    and failed the plan). Each written form of the value (30英寸, 30", 30 英寸) is found
    through the same comparison form the check uses, so nothing else is touched.
    """
    numeric, compact = _caption_values(delivery)
    text, wanted = str(text or ""), str(value or "").lower()
    if not wanted:
        return text
    out, cursor = [], 0
    for match in _LOOSE_NUMBER.finditer(text):
        if match.start() < cursor:
            continue
        for end in range(match.end(), min(len(text), match.end() + 6) + 1):
            if compact(text[match.start():end]) == wanted:
                out.append(text[cursor:match.start()])
                cursor = end
                break
    if not out:
        return text
    cleaned = "".join(out) + text[cursor:]
    cleaned = re.sub(r"[（(\[【]\s*[)）\]】]", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip(" ，,、/·|-—:：;；")


def without_unsupported_values(text, source, title="", delivery=True):
    """The caption with every value the source (or the customer's title) lacks removed."""
    numeric, compact = _caption_values(delivery)
    allowed = {m.group().lower() for m in numeric.finditer(compact(str(source or "") + "\n" + str(title or "")))}
    for match in list(numeric.finditer(compact(str(text or "")))):
        if match.group().lower() not in allowed:
            text = strip_caption_value(text, match.group(), delivery)
    return text


def plan_issues(plan, source, title="", category=None):
    """Return [(screen idx or None, message)]; None concerns the whole plan."""
    from .refine_planner import _validate_schema_v2, _check_product_category
    from .planning_quality import check_plan_quality
    if plan.get("merchandising_version") != VERSION or not source:
        raise ValueError("缺少视觉策划版本或原始资料，尚未提交生图")
    _check_product_category(plan, category, source, title)
    issues = [(_screen_of(message, plan), message)
              for message in _validate_schema_v2(plan, source, title, require_visual_strategy=True)]
    buyer_value = plan.get("buyer_value_version") == BUYER_VERSION
    delivery = plan.get("visual_delivery_version") == DELIVERY_VERSION
    minimum = screen_budget(source, category)["minimum_total_screens"]
    if plan.get("dropped_pages"):
        minimum = min(minimum, MIN_SALVAGED_SCREENS)
    if buyer_value and len(plan["screens"]) < minimum:
        issues.append((None, "正常资料整套至少8屏，包含展示与参数页；需展开有依据的画面，不要求8个独立买点"))
    content_pages = [s for s in plan["screens"] if s.get("role") not in ("hero", "spec_table")]
    if not buyer_value and len(content_pages) >= 3 and all(
        (s.get("visual_brief") or {}).get("product_presentation") == "whole_product"
        for s in content_pages
    ):
        issues.append((None, "内容页全部重复整机主视觉，应按部件、性能或使用内容设计画面"))
    seen_signatures = set()
    for s in content_pages:
        signature = json.dumps([s.get("title"), s.get("body") or "", s.get("technical_support") or []],
                               ensure_ascii=False)
        if signature in seen_signatures:
            # Reported once, as before: the text feeds the paid review request,
            # and a saved review is reused only for an identical request.
            issues.append((s.get("idx"), "存在重复文案页面，不能仅换背景凑图"))
            break
        seen_signatures.add(signature)
    # Caption values must exist in supplied facts. This guards units/values,
    # not semantic attribution; the editor still checks which value means what.
    numeric, compact = _caption_values(delivery)
    # The customer's own title is supplied material too: a value written there is
    # theirs, not invented (2026-11-17: a title with 30英寸 failed every retry).
    source_values = {m.group().lower() for m in numeric.finditer(compact(source + "\n" + (title or "")))}
    for screen in plan["screens"]:
        idx = screen.get("idx")
        body = screen.get("body", "")
        if not isinstance(body, str) or len(body) > 40:
            issues.append((idx, "正文必须为空或一句40字以内的简短解释"))
        for key in ("title", "body"):
            for match in numeric.finditer(compact(str(screen.get(key) or ""))):
                if match.group().lower() not in source_values:
                    issues.append((idx, CAPTION_VALUE_ISSUE + match.group()))
        proof = screen.get("technical_support", [])
        if not isinstance(proof, list) or not all(
            isinstance(q, str) and any(q == e
                                      for e in (screen.get("evidence") or [])) for q in proof
        ):
            issues.append((idx, "大字参数必须来自该页的完整原文依据"))
        brief = screen.get("visual_brief") or {}
        if plan.get("buyer_outline_version") == OUTLINE_VERSION:
            from .planning_quality import _SPEC_TITLE
            if screen.get("kind") == "benefit" and _SPEC_TITLE.fullmatch(
                re.sub(r"[\s，,：:、]", "", str(screen.get("title", "")))
            ):
                issues.append((idx, "购买理由标题仍仅列参数，应表达实际作用；性能展示需明确其展示身份"))
            if brief.get("product_presentation") == "visible_detail" and screen.get("component"):
                issues.append((idx, "文字策划未观察部件外观，有依据的部件改为拟真示意，不假装已看见内部结构"))
        if brief.get("product_presentation") == "concept_detail":
            component = screen.get("component")
            if not components_supported(component, screen.get("evidence", [])):
                issues.append((idx, "部件示意必须引用资料明确存在的部件"))
    quality = check_plan_quality(plan, source, grounded_copy=True)
    advisories = []
    for issue in quality:
        # Image authenticity is reviewable when the companion is explicitly
        # supplied. It must not invent an absent item or an automatic function.
        if delivery and issue['code'] == 'unverified_companion':
            from .planning_quality import _COMPANION
            screen = next((s for s in plan['screens'] if f"screen_{s['idx']}" == issue['location']), None)
            mentions = set(_COMPANION.findall(json.dumps(screen.get('visual_brief', {}), ensure_ascii=False))) if screen else set()
            if mentions and all(word in source for word in mentions):
                advisories.append({**issue, 'message': '资料已明确配套设备；其外观为示意演绎，成图需核对，不能增添功能'})
                continue
        issues.append((_screen_of(issue['location'], plan), f"{issue['location']}: {issue['message']}"))
    if delivery:
        plan['planning_advisories'] = advisories
    return issues


# Below this a salvaged set is too thin; the plan fails as before instead.
MIN_SALVAGED_SCREENS = 4


def compile_with_salvage(data, source, title, category, **options):
    """Compile; if only some pages fail, drop just those pages and deliver.

    Whole-plan problems (category, schema, cover, parameter table, too few
    pages left) still fail with the original message. Nothing is re-planned
    or re-purchased: this only removes pages from the paid final draft.
    """
    data = copy.deepcopy(data)
    if data.get("salvage_dropped_pages"):
        data["dropped_pages"] = list(data["salvage_dropped_pages"])
    try:
        return compile_plan(data, source, title, category, **options)
    except ValueError as exc:
        original = exc
    remaining = copy.deepcopy(data)
    # Same page order compile_plan uses, so screen idx - 2 names the right page below.
    remaining["pages"] = keep_person_scene(remaining.get("pages") or [],
                                           screen_limit(category) - 1 - int(bool(remaining.get("specifications"))))
    dropped = list(data.get("salvage_dropped_pages") or [])  # Pages the final read already removed.
    # Two pages with the same caption are one page shown twice: keep the first. A
    # duplicate is a page problem, never a reason to fail the whole plan.
    seen_captions, unique_pages = set(), []
    for page in remaining["pages"]:
        caption = tuple(re.sub(r"\s+", "", str(page.get(key) or "")) for key in ("title", "body"))
        if caption in seen_captions:
            dropped.append({"title": page.get("title"), "issue": "与前一页文案重复"})
            continue
        seen_captions.add(caption)
        unique_pages.append(page)
    remaining["pages"] = unique_pages
    cover_reset = False
    stripped_values = []
    for _ in range(8):
        changed = False
        pages = remaining["pages"]
        bad = {i for i, page in enumerate(pages)
               if page.get("kind") not in ("benefit", "display") or page.get("role") in ("hero", "spec_table")}
        reasons = {i: "页面类型无效" for i in bad}
        fix_cover = None
        fix_table = []
        if not bad:
            remaining["dropped_pages"] = dropped
            plan = compile_plan(remaining, source, title, category, **options, check=False)
            planned = sum(1 for s in plan["screens"] if s.get("role") not in ("hero", "spec_table"))
            roles = {s.get("idx"): s.get("role") for s in plan["screens"]}
            whole_plan = False
            for idx, message in plan_issues(plan, source, title, category):
                page_index = (idx or 0) - 2  # Screen 1 is the cover.
                # The cover keeps resetting to the customer's own title when there is one
                # (it names the product); without one, its invented value is removed too.
                if message.startswith(CAPTION_VALUE_ISSUE) and roles.get(idx) != "spec_table" and not (
                        roles.get(idx) == "hero" and (title or "").strip()):
                    # An invented value leaves the caption it sits in; the page stays.
                    target = (remaining.get("cover") if roles.get(idx) == "hero"
                              else pages[page_index] if 0 <= page_index < len(pages) else None)
                    value = message[len(CAPTION_VALUE_ISSUE):]
                    if isinstance(target, dict):
                        before = (target.get("title"), target.get("body"))
                        for key in ("title", "body"):
                            if isinstance(target.get(key), str):
                                target[key] = strip_caption_value(target[key], value, options.get("delivery", False))
                        if (target.get("title"), target.get("body")) != before:
                            stripped_values.append({"title": before[0], "value": value})
                            changed = True
                        # A title and a body with the same value raise two issues; the
                        # first already removed both. The page stays once the value is
                        # gone; a value that cannot be separated drops the page below.
                        numeric, compact = _caption_values(options.get("delivery", False))
                        still = any(m.group().lower() == value.lower()
                                    for key in ("title", "body")
                                    for m in numeric.finditer(compact(str(target.get(key) or ""))))
                        if (target.get("title") or "").strip() and not still:
                            continue
                if roles.get(idx) == "hero" and not cover_reset and (title or "").strip():
                    fix_cover = message
                elif roles.get(idx) == "spec_table" and remaining.get("specifications"):
                    fix_table.append(message)
                elif idx is None or not 0 <= page_index < planned:
                    whole_plan = True  # A whole-plan problem, or the cover again.
                else:
                    bad.add(page_index)
                    reasons.setdefault(page_index, message)
            if whole_plan:
                # Values removed this round can clear it (two captions that differed only
                # by an invented value read as duplicates); check again before giving up.
                if not changed:
                    raise original
                continue
        if fix_cover:
            # The cover only shows the product under the customer's own title.
            cover_reset = True
            remaining["cover"] = {**remaining["cover"], "title": (title or "").strip(), "body": "",
                                  "technical_support": []}
            dropped.append({"title": "封面文案", "issue": fix_cover})
        if fix_table:
            # Drop only the rows that fail; a table-wide problem drops the table.
            # Without a provable parameter table the detail set still ships.
            specs = remaining["specifications"]
            failing = {}  # Row index -> its first issue.
            for message in fix_table:
                match = re.match(r"specifications\[(\d+)\]", message)
                if match and int(match.group(1)) < len(specs):
                    failing.setdefault(int(match.group(1)), message)
            row_only = len(failing) > 0 and all(re.match(r"specifications\[\d+\]", m) for m in fix_table)
            kept = [s for i, s in enumerate(specs) if i not in failing] if row_only else []
            if kept:
                # The parameter screen still ships, so this is no dropped page and
                # the normal screen minimum stays.
                remaining["dropped_spec_rows"] = list(remaining.get("dropped_spec_rows") or []) + [
                    {"name": specs[i].get("name"), "issue": m} for i, m in sorted(failing.items())]
            else:
                dropped.append({"title": "产品参数", "issue": "; ".join(fix_table)})
            remaining["specifications"] = kept
        if not bad and not fix_cover and not fix_table and not changed:
            break
        if not bad:
            continue
        dropped.extend({"title": pages[i].get("title"), "issue": reasons[i]} for i in sorted(bad))
        remaining["pages"] = [page for i, page in enumerate(pages) if i not in bad]
    remaining["dropped_pages"] = dropped
    if stripped_values:
        remaining["stripped_caption_values"] = stripped_values
    try:
        return compile_plan(remaining, source, title, category, **options)
    except ValueError:
        raise original from None


def repair_captions(data, source):
    """Locally trim unsupported rhetoric; keep pages, facts and visual briefs.

    Numeric conflicts fall back to a whole source fact, never inferred values.
    The full final validator still runs after this bounded, non-paid repair.
    """
    from .refine_planner import _find_unbacked_commercial_claims
    from .planning_quality import check_plan_quality
    result = copy.deepcopy(data)
    changes = []
    allowed = {'unbacked_comparison', 'unsupported_comparison',
               'unbacked_interruption', 'unbacked_access', 'unbacked_availability'}

    def defects(text, proof):
        claims = _find_unbacked_commercial_claims(text, proof)
        probe = {'buyer_value_version': BUYER_VERSION, 'merchandising_version': VERSION,
                 'caption_repair_version': CAPTION_REPAIR_VERSION,
                 'visual_delivery_version': DELIVERY_VERSION,
                 'screens': [{'idx': 1, 'title': text}]}
        codes = {i['code'] for i in check_plan_quality(probe, proof, grounded_copy=True)}
        return bool(claims or codes), bool(codes - allowed), any(re.search(r'\d', c) for c in claims)

    for index, row in enumerate([result['cover'], *result['pages']], 1):
        proof = '\n'.join(row.get('evidence') or [])
        for key in ('title', 'body'):
            original = row.get(key) or ''
            tempered = _temper_caption(original)
            if tempered != original:
                row[key] = tempered
                changes.append({'screen': index, 'field': key, 'before': original,
                                'after': tempered, 'reason': 'absolute_rhetoric',
                                'evidence': row.get('evidence', [])})
                original = tempered
            bad, hard, numeric_conflict = defects(original, proof)
            if not bad or hard:
                continue
            clauses = [c.strip() for c in re.split(r'[，,；;。！？!?\n]', original) if c.strip()]
            kept = [] if numeric_conflict else [c for c in clauses if not defects(c, proof)[0]]
            replacement = '，'.join(kept)
            if numeric_conflict:
                # Only the invented value leaves; the caption the AI wrote stays. Several
                # pages swapped for the same source fact read as duplicates and failed the
                # whole plan (2026-11-17).
                trimmed = without_unsupported_values(original, source)
                if trimmed != original and re.search(r'[\w一-鿿]', trimmed) and not defects(trimmed, proof)[0]:
                    replacement = trimmed
            if key == 'title' and not replacement:
                # Prefer this page's own complete, supported fact. Never use
                # another page's benefit, invent a title or silently omit a page.
                candidates = row.get('technical_support', []) + row.get('evidence', [])
                replacement = next((c.strip('。；;\n ') for c in candidates
                                    if len(c) <= 40 and not defects(c, proof)[0]), '')
            if key == 'title' and (not replacement or not re.search(r'[\w\u4e00-\u9fff]', replacement)):
                continue
            if not defects(replacement, proof)[0]:
                row[key] = replacement
                changes.append({'screen': index, 'field': key, 'before': original,
                                'after': replacement, 'reason': 'unsupported_rhetoric',
                                'evidence': row.get('evidence', [])})
    result['caption_repairs'] = changes
    return result


def run(source, title, category, image_available, key, model, first_http, review_http, *, buyer_value=False, buyer_outline=False, copy_only=False, automatic=False, delivery=False, repair_copy=False):
    """One planning operation and one editorial review; no automatic repair call."""
    if review_http is None:
        raise ValueError("缺少独立复核通道，尚未提交策划")
    from .refine_planner import PlannerResponseTruncated
    def call(system, data, http):
        body = {"model": model, "thinking": {"type": "disabled"}, "temperature": 0.3,
                "max_tokens": 12000, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": fit_category(system, category) + rule},
                             {"role": "user", "content": json.dumps(data, ensure_ascii=False)}]}
        result = http(body, key)
        if result["choices"][0].get("finish_reason") == "length":
            raise PlannerResponseTruncated()
        return result["choices"][0]["message"]["content"]
    rule = category_rule(category)
    inputs = {"source": source, "title": title, "selected_category": category,
              "reference_image_available": image_available}
    if buyer_value:
        inputs["screen_budget"] = screen_budget(source, category)
    if automatic:
        # Two existing paid positions, no outline call, retry or hand-written
        # fallback. The editor can repair both captions and visual decisions.
        from .refine_planner import _extract_json, _check_product_category, ProductInputError, PlannerError
        raw = call(prompt(automatic=True), inputs, first_http)
        context = {}
        try:
            parsed = _extract_json(raw)
            _check_capacity(parsed)
            _check_product_category(parsed, category, source, title)
            draft = normalize_components(read_draft(raw, source, delivery=delivery))
            compile_plan(draft, source, title, category, buyer_value=True, delivery=delivery)
        except (ValueError, KeyError, TypeError, PlannerError) as exc:
            if isinstance(exc, ProductInputError) and exc.code != "AI_REFINE_CATEGORY_UNCLEAR":
                raise  # A real input/category conflict cannot be edited away.
            # The raw first response stays untouched in the existing journal.
            draft = {"unparsed_model_draft": raw}
            context["local_issues_to_correct"] = str(exc)
        final_raw = call(prompt(automatic=True) + AUTO_REVIEW,
                         {**inputs, **context, "draft_to_edit": draft}, review_http)
        # Problems confined to one page, quote or parameter row degrade or drop
        # just that part; they no longer fail the whole paid plan.
        def deliver(text):
            draft_ = normalize_components(
                read_draft(text, source, delivery=delivery, salvage=delivery, title=title or ""),
                degrade=True)
            # The provider's raw response remains untouched in the cost journal.
            if repair_copy:
                draft_ = repair_captions(draft_, source)
            return compile_with_salvage(draft_, source, title, category, buyer_value=True,
                                        delivery=delivery, repair_copy=repair_copy)
        try:
            plan = deliver(final_raw)
        except (ValueError, KeyError, TypeError, PlannerError) as exc:
            if not delivery or isinstance(exc, ProductInputError):
                raise
            # The editor's reply is unusable as a whole (e.g. broken JSON). The
            # first paid draft passes the same local checks; nothing is bought.
            try:
                plan = deliver(raw)
            except (ValueError, KeyError, TypeError, PlannerError):
                raise exc from None
            plan["planning_source"] = "first_draft_salvaged"
            plan["final_draft_issue"] = str(exc)[:200]
        plan["automatic_planning_version"] = AUTO_VERSION
        render(plan)
        return add_square_screens(plan)
    if copy_only:
        visual_prompt = prompt(False) + prompt_ref("detail.vm.copy_only_visual")
        draft = normalize_components(read_draft(call(visual_prompt, inputs, first_http), source))
        # Reject input/category conflicts now, but let the existing editor fix
        # captions before applying the full final-plan checks.
        from .refine_planner import _check_product_category
        _check_product_category(draft, category, source, title)
        targets = [{"screen": i, **page} for i, page in enumerate([draft["cover"], *draft["pages"]], 1)]
        raw_edits = call(COPY_RULES, {**inputs, "copy_targets": targets}, review_http)
        final = apply_copy_edits(draft, raw_edits)
        plan = compile_plan(final, source, title, category, buyer_value=True)
        plan["copy_edit_version"] = COPY_VERSION
        return plan
    if buyer_outline:
        raw_outline = call(outline_prompt(), inputs, first_http)
        try:
            outline = read_outline(raw_outline, source, category, title)
        except Exception as exc:
            # The existing editorial operation can repair the original analysis.
            # It is not a retry and never synthesizes a successful first answer.
            from .refine_planner import ProductInputError
            if isinstance(exc, ProductInputError) and exc.code != "AI_REFINE_CATEGORY_UNCLEAR":
                raise
            if not isinstance(exc, (ValueError, TypeError, ProductInputError)):
                raise
            outline = {"unparsed_analysis": raw_outline, "analysis_issue": str(exc)}
        editorial = prompt_ref("detail.vm.editorial_outline")
        final_raw = call(prompt(True) + editorial,
                         {**inputs, "use_analysis_to_verify": outline}, review_http)
        final = read_draft(final_raw, source)
        return compile_plan(final, source, title, category, buyer_value=True, buyer_outline=True)
    raw_draft = call(prompt(buyer_value), inputs, first_http)
    from .refine_planner import _check_product_category
    try:
        draft = read_draft(raw_draft, source)
    except json.JSONDecodeError:
        # The existing second operation can edit the original draft even when
        # its JSON punctuation is invalid. Never repair/rebuy the first call.
        draft = {"unparsed_model_draft": raw_draft,
                 "format_issue": "初稿JSON无效，请先纠正结构，再依据原文完成整套编辑。"}
    else:
        _check_product_category(draft, category, source, title)
    review_context = {}
    if buyer_value and "unparsed_model_draft" not in draft:
        try:
            compile_plan(draft, source, title, category, buyer_value=True)
        except ValueError as exc:
            review_context["local_issues_to_correct"] = str(exc)
    editorial = (
        prompt_ref("detail.vm.editorial_buyer")
        if buyer_value else
        prompt_ref("detail.vm.editorial_general")
    )
    final_raw = call(
        prompt(buyer_value) + editorial,
        {**inputs, **review_context, "draft_to_edit": draft}, review_http)
    final = read_draft(final_raw, source)
    return compile_plan(final, source, title, category, buyer_value=buyer_value)
