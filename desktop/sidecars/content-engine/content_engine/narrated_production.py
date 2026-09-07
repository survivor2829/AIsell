"""Run the user's selected script directions as one resumable production queue."""
import copy
import json
import os
import re
import shutil
from pathlib import Path
from uuid import uuid4

from .errors import ContentEngineError


LOCAL_RENDER_ERRORS = frozenset({
    'render_failed', 'render_timeout', 'renderer_failed', 'media_tools_unavailable',
    'media_encoder_unavailable', 'remotion_runtime_unavailable', 'remotion_render_failed',
    'remotion_render_timeout', 'audio_probe_failed',
})
MAPPING_ERRORS = frozenset({
    'narrated_mapping_invalid', 'narrated_copy_too_long', 'narrated_candidate_invalid',
    'narrated_duplicate', 'narrated_edit_mismatch', 'narrated_edit_rejected',
})


def require(condition, code, message):
    if not condition:
        raise ContentEngineError(code, message)


def clear_selection(batch):
    batch.pop('script_selections', None)
    batch.pop('production_jobs', None)
    batch.pop('_active_production_job', None)


def retryable_planning_jobs(batch):
    if batch.get('_planning_inflight') or batch.get('status') == 'outcome_unknown':
        return []
    candidates = {c['candidate_id']: c for c in batch.get('candidates', [])}
    return [job for job in batch.get('production_jobs', [])
            if job.get('status') == 'skipped' and job.get('error_code') in MAPPING_ERRORS | {'cloud_response_invalid'}
            and not candidates.get(job.get('candidate_id'), {}).get('_run_id')]


def retry_failed_planning(batch):
    for job in retryable_planning_jobs(batch):
        batch.setdefault('_production_retry_history', []).append(copy.deepcopy(job))
        job.update(status='queued', format_retries=0)
        candidate = next((c for c in batch['candidates'] if c['candidate_id'] == job.get('candidate_id')), None)
        if candidate:
            candidate['status'] = 'needs_review'
        for item in (job, candidate):
            if item:
                item.pop('error', None)
                item.pop('error_code', None)


def confirm_selections(domain, request):
    b = domain._load(request.get('batch_id'))
    domain._idle(b)
    require(b.get('settings', {}).get('workflow_version') == 2,
            'invalid_narrated_settings', '该批次使用旧版制作流程。')
    requested = request.get('selections')
    require(isinstance(requested, list) and 1 <= len(requested) <= 3,
            'invalid_narrated_selection', '请选择一到三个文案方向。')
    options = {c['candidate_id']: c for c in b.get('script_options', [])}
    selections = []
    seen = set()
    # Validate the whole request before changing any draft or confirmation.
    for item in requested:
        require(isinstance(item, dict) and not set(item) - {'script_id', 'revision', 'count'},
                'invalid_narrated_selection', '文案选择格式无效。')
        script_id = item.get('script_id')
        require(isinstance(script_id, str) and script_id in options and script_id not in seen,
                'invalid_narrated_selection', '请选择有效且不重复的文案方向。')
        option = options[script_id]
        require(type(item.get('revision')) is int and item['revision'] == option['revision'],
                'narrated_script_revision_changed', '文案版本已更新，请查看最新正文后确认。')
        require(type(item.get('count')) is int and 1 <= item['count'] <= 300,
                'invalid_narrated_count', '每个方向请填写1到300的整数。')
        selections.append({**item, 'narration': option['narration'], 'title': option['title'],
                           'direction': {key: option.get(key, '') for key in ('audience', 'pain_point', 'angle')}})
        seen.add(script_id)
    total = sum(item['count'] for item in selections)
    require(total <= 300, 'invalid_narrated_count', '本批合计最多生成300条。')
    settings = request.get('settings', b['settings'])
    require(isinstance(settings, dict) and settings.get('minimum_duration_seconds', 0) == b['settings'].get('minimum_duration_seconds', 0),
            'narrated_settings_changed', '最短时长已改变，请先重新准备文案。')
    previous = [{k: v for k, v in item.items() if k != 'confirmed_at'} for item in b.get('script_selections', [])]
    if previous == selections:
        require(settings == b['settings'], 'narrated_settings_changed', '本批已开始制作，请新建批次使用其他声音或配乐。')
        return domain.start(b['batch_id'], 'confirmed')
    require(not b.get('script_confirmation'), 'narrated_script_already_confirmed',
            '本批已开始制作；修改正文后重新确认，或新建批次选择其他方向。')
    if settings != b['settings']:
        domain.save({'batch_id': b['batch_id'], 'settings': settings})
        b = domain._load(b['batch_id'])
    now = domain.d._now()
    candidates, jobs = [], []
    for selected in selections:
        selected['confirmed_at'] = now
        for ordinal in range(1, selected['count'] + 1):
            job = {'script_id': selected['script_id'], 'ordinal': ordinal,
                   'production_index': len(jobs) + 1, 'candidate_id': None, 'status': 'queued'}
            if ordinal == 1:
                seed = copy.deepcopy(options[selected['script_id']])
                confirmation = {key: selected[key] for key in ('script_id', 'revision', 'narration', 'confirmed_at')}
                seed.update(_confirmed_script=confirmation, generated_video_id=None,
                            source_script_id=selected['script_id'], production_index=job['production_index'])
                seed.pop('_run_id', None)
                candidates.append(seed)
                job['candidate_id'] = seed['candidate_id']
            jobs.append(job)
    b.update(script_selections=selections, production_jobs=jobs, candidates=candidates,
             selected_script_id=selections[0]['script_id'], script_confirmation=copy.deepcopy(candidates[0]['_confirmed_script']),
             direction=copy.deepcopy(selections[0]['direction']), target_count=total,
             recommended_count=total, feasible_count=len(candidates), approved=True, reasons=[])
    domain._store(b)
    return domain.start(b['batch_id'], 'confirmed')


def bind_planned_candidate(batch, candidate):
    job = batch.get('_active_production_job')
    if job is not None and not job.get('candidate_id'):
        candidate.update(source_script_id=job['script_id'], production_index=job['production_index'])
        job['candidate_id'] = candidate['candidate_id']


def resolve_planning_job(batch):
    """Called only after the existing provider-log confirmation has succeeded."""
    active = batch.get('_active_production_job') or {}
    job = next((item for item in batch.get('production_jobs', [])
                if item['production_index'] == active.get('production_index')), None)
    if job is None:
        return
    candidate = next((c for c in batch['candidates'] if c['candidate_id'] == job.get('candidate_id')), None)
    require(not (candidate or {}).get('_run_id'), 'narrated_planning_recovery_not_available',
            '该作品已进入配音制作，不能用重新规划代替核对原调用。')
    job['status'] = 'queued'
    for key in ('error', 'error_code'):
        job.pop(key, None)
        if candidate:
            candidate.pop(key, None)
    if candidate:
        candidate['status'] = 'needs_review'


def confirmed_narration_units(domain, batch, narration):
    """Keep the approved words local and give the editor measured sentence budgets."""
    pieces = re.findall(r'.*?[，、：。！？；,!?;:](?:[”’\"])?|.+$', narration, re.S)
    units = []
    for sentence in pieces:
        while len(sentence) > 80:
            boundary = max(sentence.rfind(mark, 0, 80) for mark in '，、：, ')
            end = boundary + 1 if boundary > 0 else 80
            units.append(sentence[:end])
            sentence = sentence[end:]
        if sentence:
            units.append(sentence)
    return [{'unit_id': f'U{number + 1}', 'text': text,
             'required_ms': domain._phrase_budget_ms(batch, text)}
            for number, text in enumerate(units)]


def complete_mapping_capacity(domain, batch, phrases):
    """Reserve unused nearby source footage; normal fact/visual review still follows."""
    index = {shot['segment_id']: shot for shot in batch['available_shots']}
    phrases = copy.deepcopy(phrases)
    used = {ref for phrase in phrases for ref in phrase['shot_ids']}
    changes = []
    for phrase in phrases:
        refs = phrase['shot_ids']
        required = domain._phrase_budget_ms(batch, phrase['text'])
        capacity = sum(index[ref]['target_duration_ms'] for ref in set(refs))
        while capacity < required:
            anchors = [index[ref] for ref in refs]
            def distance(shot):
                return min(min(abs(shot['source_start_ms'] - anchor['source_end_ms']),
                               abs(anchor['source_start_ms'] - shot['source_end_ms']))
                           for anchor in anchors if anchor['asset_id'] == shot['asset_id'])
            eligible = [shot for ref, shot in index.items() if ref not in used
                        and any(anchor['asset_id'] == shot['asset_id'] for anchor in anchors)
                        and not any(index[other]['asset_id'] == shot['asset_id']
                            and index[other]['source_start_ms'] < shot['source_end_ms']
                            and shot['source_start_ms'] < index[other]['source_end_ms'] for other in used)]
            if not eligible:
                donors = [(other, index[ref]) for other in phrases if other is not phrase
                          for ref in other['shot_ids']
                          if any(anchor['asset_id'] == index[ref]['asset_id'] for anchor in anchors)
                          and sum(index[key]['target_duration_ms'] for key in other['shot_ids'] if key != ref)
                              >= domain._phrase_budget_ms(batch, other['text'])]
                if donors:
                    donor, returned = min(donors, key=lambda pair: (distance(pair[1]), pair[1]['source_start_ms']))
                    donor['shot_ids'].remove(returned['segment_id'])
                    used.remove(returned['segment_id'])
                    eligible = [returned]
            require(eligible and len(used) < 40, 'narrated_copy_too_long',
                    f"本段需要{required}毫秒，已选镜头只有{capacity}毫秒，且同素材没有足够未使用片段；请重新选择相关镜头。")
            extra = min(eligible, key=lambda shot: (distance(shot), shot['source_start_ms'], shot['segment_id']))
            same_source = [ref for ref in refs if index[ref]['asset_id'] == extra['asset_id']]
            following = next((ref for ref in same_source if index[ref]['source_start_ms'] > extra['source_start_ms']), None)
            position = refs.index(following) if following else refs.index(same_source[-1]) + 1
            refs.insert(position, extra['segment_id'])
            used.add(extra['segment_id'])
            capacity += extra['target_duration_ms']
            changes.append({'added_shot_id': extra['segment_id'], 'required_ms': required, 'reserved_ms': capacity})
    return phrases, changes


def review_confirmed_candidate(domain, batch, candidate):
    """Repair scene selection only; the user's confirmed words remain immutable."""
    for attempt in range(3):
        try:
            if candidate.get('_draft_only'):
                raise ContentEngineError('narrated_mapping_invalid', '已确认完整文案，现在为正文选择并安排真实镜头。')
            domain._review_edit(candidate, batch)
            return
        except ContentEngineError as error:
            if error.code not in MAPPING_ERRORS or attempt == 2 or candidate.get('_run_id'):
                raise
            if domain.d._should_stop(batch['task_id']):
                return
            audit = candidate.get('_edit_review_audit') or {}
            shots = [{'shot_id': f'S{number + 1}', **{key: shot[key] for key in ('asset_id', 'source_start_ms', 'source_end_ms', 'target_duration_ms', 'description')},
                      'max_narration_chars': domain._max_narration_chars(batch, shot['target_duration_ms']),
                      'source_evidence': domain._source_evidence_for(batch, shot)}
                     for number, shot in enumerate(batch['available_shots'])]
            shot_index = {short['shot_id']: full for short, full in zip(shots, batch['available_shots'])}
            units = confirmed_narration_units(domain, batch, candidate['narration'])
            unit_index = {unit['unit_id']: unit for unit in units}
            def mapped(result):
                assignments = result.get('assignments') if isinstance(result, dict) else None
                require(isinstance(assignments, list) and assignments and all(
                    isinstance(item, dict) and isinstance(item.get('unit_ids'), list) and item['unit_ids'] for item in assignments),
                        'narrated_mapping_invalid', 'assignments须用unit_ids将连续U编号分组，每组至少一个编号。')
                require([uid for item in assignments for uid in item['unit_ids']] == list(unit_index),
                        'narrated_mapping_invalid', '所有unit_ids按顺序拼接必须恰好等于全部U编号，不得遗漏、重复、调换。')
                phrases = []
                for assignment in assignments:
                    text = ''.join(unit_index[uid]['text'] for uid in assignment['unit_ids'])
                    unit_label = ','.join(assignment['unit_ids'])
                    refs = assignment.get('shot_ids')
                    require(isinstance(refs, list) and refs and all(isinstance(ref, str) and ref in shot_index for ref in refs),
                            'narrated_mapping_invalid', f"{unit_label}的shot_ids必须使用所给S编号。")
                    phrases.append({'text': text, 'shot_ids': [shot_index[ref]['segment_id'] for ref in refs]})
                phrases, changes = complete_mapping_capacity(domain, batch, phrases)
                prepared = domain._repack_duration_candidate({'title': candidate['title'], 'phrases': phrases}, batch,
                                                             batch['available_shots'], allow_same_activity_cuts=True)
                return {**prepared, '_capacity_adjustments': changes}
            def validate(result):
                try:
                    domain._normalize_candidate(mapped(result), batch, domain._history(batch['batch_id']))
                except (ContentEngineError, KeyError, TypeError, ValueError) as invalid:
                    return str(invalid)
                return None
            domain._activity(batch, f'正在调整镜头安排，第 {attempt + 1} 次')
            result = domain._cloud({'confirmed_narration': candidate['narration'], 'narration_units': units,
                'issue': error.message, 'review_feedback': domain._compact_review_feedback(audit.get('rejections', [])),
                'shots': shots, 'speech_budget': batch.get('_speech_budget'),
                'avoid_sequences': [[s['segment_id'] for s in previous] for previous in domain._history(batch['batch_id'])]},
                '你是剪辑师。正文已确认并由程序保存，你只选择镜头，不返回或改写正文。'
                'narration_units是原文在自然停顿处切开的短语。把相邻U编号组合成适合对应画面的段落，每段最多80字，'
                '每组用unit_ids列出U编号并选择所给S编号，不能遗漏、重复或调换U编号。优先保持完整句意；'
                '一句涉及不同素材的内容时，可以在U编号之间分组，也可选多个相关镜头共同支持，例如部件讲解和联网设置应各选对应来源。'
                '每个短语的required_ms已由程序计算；一组所选镜头target_duration_ms之和至少覆盖这组短语所需总时长；'
                '例如需要5900毫秒，单个5000毫秒镜头不够，须选两个相关镜头。'
                '同一组跨asset_id时，素材必须具有同一条已确认的source_provenance.activity_label；'
                '不得把不同场次或不同人物说成同一次连续事件。每个S编号只能使用一次。'
                '结合画面事实、原声和拒绝原因选相关镜头，先满足长句容量，再安排其余句子，不能把镜头用在多句。'
                '开场与已有作品有实质区别。source_evidence里的原声只证明现场说过什么。'
                '只返回JSON {assignments:[{unit_ids:["U1","U2"],shot_ids:["S1","S2"]}]}。', validation_error=validate,
                generation_rules=False)
            prepared = mapped(result)
            updated = domain._normalize_candidate({**prepared,
                **{key: candidate.get(key, '') for key in ('audience', 'pain_point', 'angle')}}, batch, domain._history(batch['batch_id']))
            updated.update({key: copy.deepcopy(candidate[key]) for key in
                            ('candidate_id', 'revision', 'narration', '_confirmed_script', 'source_script_id', 'production_index') if key in candidate})
            updated['status'] = 'needs_review'
            if prepared['_capacity_adjustments']:
                batch.setdefault('_capacity_adjustments', []).append({'candidate_id': candidate['candidate_id'],
                    'changes': prepared['_capacity_adjustments']})
            batch.setdefault('_automatic_shot_repairs', []).append({'candidate_id': candidate['candidate_id'],
                'attempt': attempt + 1, 'reason': error.code, 'narration_unchanged': True})
            candidate.clear()
            candidate.update(updated)
            domain._store(batch)


def _unknown(domain, batch, candidate, error=None):
    if batch.get('_planning_inflight') or 'unknown' in str(getattr(error, 'code', '')):
        return True
    if not candidate:
        return False
    if candidate.get('status') == 'outcome_unknown' or 'unknown' in str(candidate.get('error_code', '')):
        return True
    return bool(candidate.get('_run_id') and domain.d._auto_mix_run_row(run_id=candidate['_run_id'])['status'] == 'outcome_unknown')


def run_production(domain, task_id, batch):
    if not domain._refresh_provider_analysis(task_id, batch):
        return {'batch_id': batch['batch_id'], 'generated_count': 0}
    domain.validate_pinned_plan({'narrated_batch_id': batch['batch_id'],
                                'narrated_snapshots': batch['_snapshots'], 'narrated_versions': batch['_versions']})
    domain._initialize_speech_budget(batch)
    selections = {item['script_id']: item for item in batch['script_selections']}
    jobs = batch['production_jobs']
    batch['reasons'] = []
    for job in jobs:
        if domain.d._should_stop(task_id):
            break
        candidate = next((c for c in batch['candidates'] if c['candidate_id'] == job.get('candidate_id')), None)
        if job['status'] == 'outcome_unknown' or _unknown(domain, batch, candidate):
            batch['status'] = 'outcome_unknown'
            batch['reasons'] = [job.get('error') or '上次调用结果待核对，不会自动重复请求。']
            domain._store(batch)
            raise ContentEngineError(job.get('error_code') or 'narrated_production_outcome_unknown', batch['reasons'][0])
        if job['status'] in {'completed', 'skipped'}:
            continue
        selected = selections[job['script_id']]
        if job['ordinal'] == 1:
            require(candidate and candidate['candidate_id'] == selected['script_id']
                    and (candidate.get('_confirmed_script') or {}).get('narration') == selected['narration'],
                    'narrated_confirmed_script_changed', '确认稿与本条作品不一致，请重新确认文案。')
        batch['direction'] = copy.deepcopy(selected['direction'])
        batch['_active_production_job'] = job
        job['status'] = 'processing'
        domain._store(batch)
        while True:
            try:
                if candidate is None:
                    batch.pop('_planning_budget', None)
                    domain._plan(task_id, batch, len(batch['candidates']) + 1)
                    candidate = next((c for c in batch['candidates'] if c['candidate_id'] == job.get('candidate_id')), None)
                    require(candidate is not None, 'narrated_no_usable_candidate', '当前素材没有得到符合这个方向的新作品，已跳过本条。')
                if domain.d._should_stop(task_id):
                    break
                if candidate.get('status') == 'needs_review':
                    review_confirmed_candidate(domain, batch, candidate)
                if domain.d._should_stop(task_id):
                    break
                domain._verify_confirmed_script(batch, candidate)
                batch['status'] = 'rendering'
                domain._render_candidate(task_id, batch, candidate, job['production_index'] - 1, len(jobs))
                if candidate.get('status') != 'completed':
                    raise ContentEngineError(candidate.get('error_code') or 'narrated_render_incomplete',
                                             candidate.get('error') or '本条尚未完成。')
                job['status'] = 'completed'
                job.pop('error', None)
                job.pop('error_code', None)
                domain._export_completed_candidates(batch, [candidate])
                break
            except ContentEngineError as error:
                candidate = next((c for c in batch['candidates'] if c['candidate_id'] == job.get('candidate_id')), candidate)
                if _unknown(domain, batch, candidate, error):
                    job.update(status='outcome_unknown', error_code=error.code, error=error.message)
                    if candidate:
                        candidate.update(status='outcome_unknown', error_code=error.code, error=error.message)
                    batch.update(status='outcome_unknown', reasons=[error.message])
                    domain._store(batch)
                    raise
                if (error.code == 'cloud_response_invalid' and not (candidate or {}).get('_run_id')
                        and job.get('format_retries', 0) < 1):
                    job['format_retries'] = job.get('format_retries', 0) + 1
                    domain._store(batch)
                    continue
                if (error.code in LOCAL_RENDER_ERRORS and (candidate or {}).get('_run_id')
                        and job.get('render_retries', 0) < 1):
                    job['render_retries'] = job.get('render_retries', 0) + 1
                    candidate['status'] = 'planned'
                    domain.db.execute("UPDATE content_tasks SET status='analyzing',error_code=NULL,error_message=NULL "
                                      "WHERE id=? AND status IN ('failed','paused') AND error_code=?", (task_id, error.code))
                    domain._store(batch)
                    continue
                # Configuration/provider failures affect the whole batch, unlike bad source/copy for one item.
                if error.code.startswith(('cloud_', 'auto_mix_voice_', 'auto_mix_music_')) and error.code != 'cloud_response_invalid':
                    job.update(status='queued', error_code=error.code, error=error.message)
                    batch.update(status='needs_attention', reasons=[error.message])
                    domain._store(batch)
                    return {'batch_id': batch['batch_id']}
                job.update(status='skipped', error_code=error.code, error=error.message)
                domain.db.execute("UPDATE content_tasks SET status='analyzing',error_code=NULL,error_message=NULL "
                                  "WHERE id=? AND status IN ('failed','paused') AND error_code=?", (task_id, error.code))
                if candidate and candidate.get('status') != 'completed':
                    candidate.update(status='failed', error_code=error.code, error=error.message)
                batch['reasons'].append(f"第{job['production_index']}条：{error.message}")
                domain._store(batch)
                break
        batch.pop('_active_production_job', None)
        domain._store(batch)
    completed = sum(job['status'] == 'completed' for job in jobs)
    unfinished = any(job['status'] not in {'completed', 'skipped'} for job in jobs)
    if not unfinished:
        batch['status'] = 'completed' if completed == len(jobs) else 'completed_with_errors'
        domain._export_completed_candidates(batch)
    domain._activity(batch, f'已完成 {completed} / {len(jobs)} 条作品', completed, len(jobs))
    domain._store(batch)
    return {'batch_id': batch['batch_id'], 'generated_count': completed}


def output_folder(domain, batch):
    root = (domain.d.data_dir / 'batch-exports').resolve()
    folder = (root / batch['batch_id']).resolve()
    require(root in folder.parents, 'narrated_export_invalid', '成片目录无效。')
    return folder


def export_completed(domain, batch, candidates=None):
    """Local, resumable copies only. Export failure never triggers cloud generation."""
    folder = output_folder(domain, batch)
    records = batch.setdefault('_exported_candidates', {})
    batch.pop('export_error', None)
    try:
        for candidate in batch['candidates'] if candidates is None else candidates:
            if candidate.get('status') != 'completed' or not candidate.get('generated_video_id'):
                continue
            video = domain.d._generated_row(candidate['generated_video_id'])
            require(video['status'] == 'completed' and video['output_path'], 'narrated_export_unavailable', '成片文件尚未就绪。')
            source = Path(video['output_path']).resolve(strict=True)
            require((domain.d.data_dir / 'generated').resolve() in source.parents,
                    'narrated_export_invalid', '成片文件不在受管理的目录中。')
            saved = records.get(candidate['candidate_id'])
            if saved and (folder / saved['file']).is_file():
                stat = (folder / saved['file']).stat()
                if stat.st_size == saved['size_bytes'] and stat.st_mtime_ns == saved.get('modified_ns'):
                    continue
            title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', candidate['title']).strip(' .')[:50]
            name = f"{candidate.get('production_index', 1):02d}-{title}-{candidate['candidate_id'][-8:]}.mp4"
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / name
            digest = domain.d._sha256_file(source)
            if target.exists():
                require(domain.d._sha256_file(target) == digest, 'narrated_export_conflict', '同名导出文件已改变，已保留该文件，请另选位置导出。')
            else:
                temporary = folder / f'.{uuid4().hex}.part'
                try:
                    shutil.copyfile(source, temporary)
                    require(domain.d._sha256_file(temporary) == digest, 'narrated_export_failed', '导出校验失败，可重新导出，无需重新制作。')
                    os.replace(temporary, target)
                finally:
                    if temporary.exists():
                        temporary.unlink()
            records[candidate['candidate_id']] = {'file': name, 'size_bytes': target.stat().st_size, 'modified_ns': target.stat().st_mtime_ns,
                'sha256': digest, 'generated_video_id': candidate['generated_video_id'],
                'title': candidate['title'], 'narration': candidate['narration'], 'source_script_id': candidate.get('source_script_id')}
        if records:
            manifest = folder / '作品清单.json'
            temporary = folder / f'.{uuid4().hex}.json'
            temporary.write_text(json.dumps({'batch_id': batch['batch_id'], 'works': list(records.values())}, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(temporary, manifest)
    except (ContentEngineError, OSError) as error:
        batch['export_error'] = str(error)
    batch.update(export_ready=bool(records), exported_count=len(records))
    domain._store(batch)
