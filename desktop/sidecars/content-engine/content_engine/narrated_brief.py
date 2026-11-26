"""Audience-led copy contract for new tasks; legacy batches keep their workflow."""
import re

from .auto_mix_v2 import canonical_hash
from .errors import ContentEngineError
from .prompt_ref import prompt_ref

FIELDS = {'target_audience': 150, 'expression': 14000, 'advantages': 1500, 'customer_pain_points': 1500}
FRAMEWORK = 'problem_solution_cta'
_LEGACY_RULES = (
    prompt_ref("video.brief.rules")
)
RULES = (
    prompt_ref("video.brief.expression")
)


def enabled(batch):
    return batch.get('brief_version') == 1


def supplied(batch):
    return enabled(batch) and batch.get('script_source') == 'provided'


def context(batch):
    result = {key: batch.get(key, '') for key in ('target_audience', 'description', 'cta')} | {'expression': expression(batch)}
    if batch.get('script_action') in {'rewrite', 'expand'} and not supplied(batch):
        result['script_action'] = batch['script_action']
    return result


def expression(batch):
    if 'expression' in batch:
        return batch['expression']
    return '\n\n'.join(f'{label}：{batch[key]}' for key, label in
        (('advantages', '产品／服务优势'), ('customer_pain_points', '客户痛点')) if batch.get(key))


def sentences(text):
    return [part.strip() for part in re.findall(r'.*?[。！？!?](?:[”’\"])?|.+$', text, re.S) if part.strip()]


def ending(text):
    parts = sentences(text)
    return parts[-1] if parts else ''


def ending_overlay(text):
    """Only a complete short final sentence can be shown as an ending card."""
    last = ending(text)
    return last if 0 < len(last) <= 48 else ''


def renderable_visual_items(items):
    """Older runs may contain an overlong ending that the renderer would truncate."""
    return [item for item in items or []
            if item.get('type') != 'cta' or 0 < len(str(item.get('text') or '')) <= 48]


def issue(candidate, batch):
    if not enabled(batch) or supplied(batch):
        return None
    text = candidate.get('narration', '').strip()
    if not text or len(text) > 2400:
        return '请提供 1 至 2400 字的有效正文。'
    return None


def stamp(candidate, batch, rules=RULES):
    return canonical_hash([rules, context(batch), candidate.get('framework'),
                           candidate.get('title'), re.sub(r'\s+', '', candidate.get('narration', ''))])


def align_ending_events(events, captions):
    """Use the spoken caption timing, not an arbitrary last-four-seconds card."""
    compact = lambda text: re.sub(r'[^\w]', '', str(text), flags=re.UNICODE)
    full = ''.join(compact(row.get('text', '')) for row in captions)
    for event in events:
        if event.get('reason') != 'cta':
            continue
        tail = compact(event['text'])
        if not tail or not full.endswith(tail):
            raise ContentEngineError('narrated_cta_timing_missing', '结尾引导与实际字幕不一致，请检查口播后重试。')
        offset, cursor = len(full) - len(tail), 0
        for row in captions:
            cursor += len(compact(row.get('text', '')))
            if cursor > offset:
                event.update(start_ms=int(row['start_ms']), end_ms=int(captions[-1]['end_ms']),
                             reason='narrated_ending_cta')
                break


def review(domain, candidate, batch):
    """Review edited copy and variants once; reuse the exact approved copy review."""
    if not enabled(batch):
        return
    if supplied(batch):
        return  # User wording is intentional; factual checks run on the selected shots.
    error = issue(candidate, batch)
    if error:
        raise ContentEngineError('narrated_brief_invalid', error)
    key = stamp(candidate, batch)
    if candidate.get('_brief_review_hash') in {key, stamp(candidate, batch, _LEGACY_RULES)}:
        # A stricter historical pass remains valid for identical content and inputs.
        candidate['_brief_review_hash'] = key
        return

    def validate(result):
        if not isinstance(result, dict) or type(result.get('accepted')) is not bool or not isinstance(result.get('reason'), str):
            return '请返回accepted布尔值与reason文字。'
        return None

    result = domain._cloud({'creative_brief': context(batch),
        'framework': candidate.get('framework'), 'title': candidate['title'],
        'narration': candidate['narration'],
        'sources': [domain._source_evidence_for(batch, shot) | {'observation': shot['description']}
                    for shot in candidate['shots']]},
        RULES + prompt_ref("video.brief.accept_format"),
        validation_error=validate, generation_rules=False)
    if not result['accepted']:
        raise ContentEngineError('narrated_brief_invalid', result['reason'] or '文案未回应创作需求，请修改后重新确认。')
    candidate['_brief_review_hash'] = key
