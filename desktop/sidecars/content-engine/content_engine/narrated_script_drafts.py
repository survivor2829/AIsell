"""Prepare grounded copy choices before committing to a video edit."""
import copy
import math
import re
import time
from difflib import SequenceMatcher

from .errors import ContentEngineError
from . import narrated_brief, narrated_production
from .prompt_ref import prompt_ref


def _fit_generated_sentences(domain, script, batch, minimum, maximum):
    """Shorten only an unconfirmed AI draft, retaining complete sentences."""
    if batch.get('script_action') in {'rewrite', 'expand'}:
        return script  # Editing a supplied draft must never silently delete its ending or parameters.
    text = script['narration']
    if domain._spoken_char_count(text) <= maximum:
        return script
    sentences = narrated_brief.sentences(text)
    ending = sentences.pop() if batch.get('cta') and len(sentences) > 1 else ''
    kept = []
    for sentence in sentences:
        if domain._spoken_char_count(''.join(kept) + sentence + ending) > maximum:
            break
        kept.append(sentence)
    fitted = ''.join(kept) + ending
    return {**script, 'narration': fitted} if minimum <= domain._spoken_char_count(fitted) <= maximum else script


_LABEL_LIMITS = (('title', 100), ('pain_point', 300), ('angle', 150), ('summary', 60))


def _clip(text, limit):
    """At most ``limit`` characters, ending at a sentence or clause break when one is near."""
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    breaks = [cut.rfind(mark) for mark in '。！？；，,;']
    end = max(breaks)
    return (cut[:end] if end >= limit // 2 else cut).rstrip('，,;；、 ')


def _repair_labels(script, batch):
    """Labels around a draft are fixed locally; only the narration itself is the AI's to redo.

    2026-11-17 real run: a usable script was thrown away because its one-line summary ran
    past 60 characters ("summary须为60字以内…"), and the batch stopped. Titles, pain point,
    angle and summary are shown to the customer, not voiced, so they are trimmed or filled.
    """
    title = _clip(script.get('title') if isinstance(script.get('title'), str) else '', 100)
    narration = script.get('narration') if isinstance(script.get('narration'), str) else ''
    if not title and narration.strip():
        title = _clip(re.split(r'[。！？!?]', narration.strip())[0], 30)
    script['title'] = title
    for field, limit in _LABEL_LIMITS[1:]:
        if field == 'summary' and batch is None:
            continue
        value = script.get(field)
        value = _clip(value if isinstance(value, str) else '', limit)
        script[field] = value or _clip(title, limit)
    if batch is not None:
        script['audience'] = batch['target_audience']


def prepare(domain, task_id, batch):
    domain._initialize_speech_budget(batch)
    options = batch.setdefault('script_options', [])
    modern = narrated_brief.enabled(batch)
    editing = modern and batch.get('script_action') in {'rewrite', 'expand'}
    shots = batch['available_shots']
    from .narrated_sources import source_index as build_sources
    sources, source_index = build_sources(domain, batch)
    minimum = domain._minimum_spoken_chars(batch)
    # Footage limits the copy only where pictures may not repeat (strict review). The
    # default mode replays pictures when the copy outruns them, as production does
    # (narrated_production.follows_script); capping the copy by footage there stopped
    # image-only batches before any script (2026-11-17: 12 photos, "总时长不足").
    maximum = min(2400, sum(domain._max_narration_chars(batch, shot['target_duration_ms']) for shot in shots))
    source_chars = 0
    if editing:
        source_chars = domain._spoken_char_count(narrated_brief.expression(batch))
    if narrated_production.follows_script(batch):
        # Never below what one proper video needs; above that, footage still bounds it.
        needed = math.ceil(domain._minimum_spoken_chars(batch) * 1.5)
        if editing:
            needed = max(needed, math.ceil(source_chars * 1.2))
        maximum = min(2400, max(maximum, needed))
    if editing:
        if source_chars > maximum:
            raise ContentEngineError('narrated_duration_too_short', '当前素材不足以承载完整原稿，请补充相关素材；系统没有截断原文。')
        if batch['script_action'] == 'expand':
            minimum = max(minimum, source_chars + 1)
    elif modern:
        minimum_seconds = max(30, int(batch.get('settings', {}).get('minimum_duration_seconds') or 30))
        # Available footage is a capacity limit, not a request to narrate all of it.
        maximum = min(maximum, math.floor(minimum_seconds * 1.5 * 1000 / domain._speech_ms_per_char(batch)))
    if maximum < minimum:
        raise ContentEngineError('narrated_duration_too_short', '当前素材总时长不足以承载要求的口播，请补充相关素材。')
    # Aim clearly above the floor: a target sitting exactly on the minimum lets the
    # model land a few characters short, and the draft is then rejected.
    floor_target = min(maximum, minimum + max(12, round(minimum * .15)))
    # A supplied draft shorter than the video's minimum must be lengthened, even in
    # rewrite mode, or the model keeps it as is and every attempt is rejected.
    source_too_short = editing and source_chars < minimum
    if not editing or source_too_short:
        target_chars = max(floor_target, min(maximum, round(source_chars * 1.2)) if editing else 0)
    else:
        target_chars = min(maximum, max(minimum, round(source_chars * (1.2 if batch['script_action'] == 'expand' else 1))))
    audit = batch.setdefault('_script_draft_audit', [])
    feedback = copy.deepcopy(batch.get('_script_draft_feedback',
        [{'reason': reason} for reason in batch.get('reasons', [])])) if modern and options else []
    target = len(options) + 1
    for attempt in range(2):
        if len(options) >= target or domain.d._should_stop(task_id):
            break
        count = 1
        domain._activity(batch, '正在准备一份完整文案' if not attempt else '正在定向修正文案中的具体问题')

        def validate_drafts(result):
            issue = draft_issue(result)
            if issue:
                # Kept so a recurring paid correction can be traced to its cause.
                batch.setdefault('_script_draft_issues', []).append(issue[:200])
            return issue

        def draft_issue(result):
            scripts = result.get('scripts') if isinstance(result, dict) else None
            if not isinstance(scripts, list) or len(scripts) != count:
                return f'scripts须包含{count}份完整文案。'
            if modern and not narrated_brief.expression(batch):
                suggestions = result.get('brief_suggestions')
                if not isinstance(suggestions, dict) or any(
                    not isinstance(suggestions.get(key), str) or len(suggestions[key]) > 4000
                    for key in ('expression',)):
                    return 'brief_suggestions.expression须为4000字以内的表达建议，缺乏依据时用空字符串。'
            errors = []
            for number, script in enumerate(scripts, 1):
                if not isinstance(script, dict):
                    return f'第{number}份文案格式无效。'
                _repair_labels(script, batch if modern else None)
                for field, limit in (('title', 100), ('audience', 150), ('pain_point', 300), ('angle', 150), ('narration', 2400)):
                    value = script.get(field)
                    if not isinstance(value, str) or not 0 < len(value.strip()) <= limit:
                        return f'第{number}份{field}须为1至{limit}字的文字。'
                length = domain._spoken_char_count(script['narration'])
                if modern:
                    # Known locally, so a different wording never costs a paid correction.
                    script['audience'] = batch['target_audience']
                    script.setdefault('framework', 'free')
                    if not isinstance(script.get('summary'), str) or not 0 < len(script['summary'].strip()) <= 60:
                        return 'summary须为60字以内的一句话思路，只说核心看点，不复述制作流程。'
                if not modern and not minimum <= length <= maximum:
                    errors.append(f'第{number}份实际{length}字，须在{minimum}至{maximum}字之间。')
                refs = script.get('source_ids')
                if not narrated_production.strict_visual_review(batch):
                    # Only strict review checks facts against these; elsewhere a wrong number
                    # is dropped (all sources when none is left), never a reason to redo the draft.
                    kept = [ref for ref in refs if isinstance(ref, str) and ref in source_index] if isinstance(refs, list) else []
                    script['source_ids'] = refs = kept or list(source_index)[:20]
                if not isinstance(refs, list) or not refs or any(not isinstance(ref, str) or ref not in source_index for ref in refs):
                    errors.append(f'第{number}份source_ids只能引用所给S编号。')
            return ' '.join(errors) or None

        response = domain._cloud({'count': count, 'topic': batch['title'],
            **({'creative_brief': narrated_brief.context(batch), 'required_frameworks': [
                narrated_brief.FRAMEWORK if i == 0 and not any(o.get('framework') == narrated_brief.FRAMEWORK for o in options) else 'free'
                for i in range(count)]} if modern else {}),
            'user_information': batch['description'], 'cta': batch.get('cta', ''),
            'minimum_chars': minimum, 'maximum_chars': maximum,
            'target_chars': target_chars,
            'sources': sources, 'existing_directions': [option['angle'] for option in options],
            **({'existing_choices': [{key: option.get(key, '') for key in
                ('title', 'summary', 'pain_point', 'angle', 'narration')} for option in options]} if modern else {}),
            'previous_feedback': feedback},
            prompt_ref("video.drafts.writer")
            + ('本次是用户明确选择的' + ('扩写' if batch['script_action'] == 'expand' else '改写') + prompt_ref("video.drafts.edit_source")
               + (f"{prompt_ref('video.drafts.too_short.p1')}{source_chars}{prompt_ref('video.drafts.too_short.p2')}" if source_too_short else '')
               if editing else '')
            + (narrated_brief.RULES + prompt_ref("video.drafts.frameworks") if modern else ''),
            validation_error=validate_drafts, generation_rules=False, purpose='文案生成')
        scripts = response['scripts']
        if modern:
            suggestions = response.get('brief_suggestions')
            if isinstance(suggestions, dict):
                batch['brief_suggestions'] = {key: value.strip()[:4000] for key, value in suggestions.items()
                    if key == 'expression' and isinstance(value, str) and not narrated_brief.expression(batch)}
        record = {'scripts': copy.deepcopy(scripts)}
        audit.append(record)
        local_rejections = []
        if modern:
            ready = []
            for script in scripts:
                script = _fit_generated_sentences(domain, script, batch, minimum, maximum)
                length = domain._spoken_char_count(script['narration'])
                if minimum <= length <= maximum:
                    ready.append(script)
                else:
                    local_rejections.append({'script': script, 'issues': [],
                        'reason': f'正文实际{length}字，须为{minimum}至{maximum}字；请按目标长度精简或补充有依据的内容，不用重复内容凑数。'})
            scripts = ready
            record['local_rejections'] = copy.deepcopy(local_rejections)
            if not scripts:
                feedback = local_rejections
                batch['_script_draft_feedback'] = copy.deepcopy(feedback)
                domain._store(batch)
                continue
        domain._store(batch)
        if not narrated_production.strict_visual_review(batch):
            # Default mode: the user reads and confirms each draft; no fact review drops one.
            review = {'reviews': [None] * len(scripts)}
        else:
            review = None
            domain._activity(batch, '正在核对完整文案与素材依据')

        def validate_reviews(result):
            reviews = result.get('reviews') if isinstance(result, dict) else None
            if not isinstance(reviews, list) or len(reviews) != len(scripts):
                return 'reviews须逐一覆盖每份文案。'
            for number, review in enumerate(reviews):
                if not isinstance(review, dict) or type(review.get('index')) is not int or review['index'] != number:
                    return 'reviews须按index从0开始原序返回。'
                if type(review.get('accepted')) is not bool or not isinstance(review.get('reason'), str):
                    return '每项须有accepted布尔值和reason。'
                claims = review.get('unsupported_claims')
                if not isinstance(claims, list) or any(not isinstance(claim, str) for claim in claims):
                    return 'unsupported_claims须为待修正表述的文字列表。'
            return None

        review = review or domain._cloud({'scripts': [{'index': number, **script} for number, script in enumerate(scripts)],
            'sources': [source for source in sources if source['source_id'] in {ref for script in scripts for ref in script['source_ids']}], **({'creative_brief': narrated_brief.context(batch),
                'existing_choices': [{key: option.get(key, '') for key in
                    ('title', 'summary', 'pain_point', 'angle', 'narration')} for option in options]} if modern else {})},
            prompt_ref("video.drafts.faithfulness")
            ,
            validation_error=validate_reviews, generation_rules=False, purpose='文案事实复核')
        record['review'] = copy.deepcopy(review)
        feedback = copy.deepcopy(local_rejections)
        for script, decision in zip(scripts, review['reviews']):
            duplicate = any(SequenceMatcher(None, script['narration'], option['narration'], autojunk=False).ratio() > .9
                            or script['angle'] == option['angle'] for option in options)
            if duplicate or decision is not None and (not decision['accepted'] or decision['unsupported_claims']):
                feedback.append({'script': script, 'issues': decision['unsupported_claims'] if decision else [],
                    'reason': '与已保留方向重复，请换一个具体切入点。' if duplicate else decision['reason']})
                continue
            options.append({**{field: script[field].strip() for field in ('title', 'audience', 'pain_point', 'angle', 'narration')},
                **({'framework': script['framework'], 'summary': script['summary'].strip(),
                    'opening_example': narrated_brief.sentences(script['narration'])[0],
                    # Only a reviewed draft carries the review stamp: a default-mode draft
                    # must still be reviewed if strict mode is turned on afterwards.
                    **({'_brief_review_hash': narrated_brief.stamp(script, batch)} if decision is not None else {})}
                   if modern else {}),
                'candidate_id': domain.d._new_id('narrated_candidate'), 'revision': 1,
                'shots': [copy.deepcopy(source_index[ref]) for ref in dict.fromkeys(script['source_ids'])],
                'phrases': [], 'status': 'needs_review', 'generated_video_id': None,
                'estimated_duration_ms': domain._estimated_speech_duration_ms(batch, [script['narration']]),
                'duration_ms': 0, '_draft_only': True, '_draft_source_ids': script['source_ids'],
                '_draft_review': decision, 'review_reason': '文案依据已核对；确认后安排并检查镜头。' if decision is not None
                    else '请通读文案后确认；确认后按文案顺序安排镜头。'})
        if modern:
            batch['_script_draft_feedback'] = copy.deepcopy(feedback)
        domain._store(batch)
    if batch.get('_planning_budget'):
        batch['_planning_budget']['status'] = 'completed'
    batch['reasons'] = [item['reason'] for item in feedback]
    domain._store(batch)


def use_supplied(domain, batch):
    text = narrated_brief.expression(batch)
    if not text.strip() or len(text) > 2400:
        raise ContentEngineError('invalid_narration', '完整文案须为 1 至 2400 字。')
    domain._initialize_speech_budget(batch)
    options = batch.setdefault('script_options', [])
    if not any(option.get('narration') == text for option in options):
        title = (narrated_brief.sentences(text)[0] if narrated_brief.sentences(text) else text)[:100]
        options.append({'candidate_id': domain.d._new_id('narrated_candidate'), 'revision': 1,
            'title': title, 'audience': batch.get('target_audience', ''),
            'pain_point': '', 'angle': '用户提供文案', 'framework': 'free', 'summary': '保留你提供的完整文案',
            'narration': text, 'shots': [], 'phrases': [], 'status': 'needs_review',
            'generated_video_id': None, 'duration_ms': 0,
            'estimated_duration_ms': domain._estimated_speech_duration_ms(batch, [text]),
            '_draft_only': True, '_user_supplied': True,
            'review_reason': '已保留原文；确认后检查素材、安排镜头并制作。'})
    batch.update(status='scripts_ready', reasons=[])
    domain._activity(batch, '原文已保留，请确认后制作')
    domain._store(batch)
