"""Selected directions run through the real service/DB; only paid/media work is faked."""
import copy
import unittest
import time
from unittest.mock import patch

import test_narrated_batch as batch_fixtures
from content_engine.errors import ContentEngineError
from content_engine.creative_domain import rebalance_narrated_phrase_refs
from content_engine.narrated_batch import NarratedBatchDomain
from content_engine import narrated_script_drafts
from content_engine.narrated_production import bind_planned_candidate, export_completed, output_folder, review_confirmed_candidate, cohere_mapping_sources, complete_mapping_capacity, confirmed_narration_units, normalize_preserved_mapping, confirm_selections


class NarratedTimelineTests(unittest.TestCase):
    def test_rebalances_ordered_shots_for_measured_phrase_audio(self):
        phrases = [
            {'evidenceRefs': ['s1'], 'sentenceBindings': [{'evidenceRefs': ['s1']}]},
            {'evidenceRefs': ['s2', 's3']},
        ]
        audio = [{'duration_ms': 5_500}, {'duration_ms': 2_000}]
        segments = [
            {'evidence_ref': 's1', 'target_duration_ms': 3_000},
            {'evidence_ref': 's2', 'target_duration_ms': 3_000},
            {'evidence_ref': 's3', 'target_duration_ms': 3_000},
        ]

        rebalance_narrated_phrase_refs(phrases, audio, segments)

        self.assertEqual([['s1', 's2'], ['s3']], [p['evidenceRefs'] for p in phrases])
        self.assertNotIn('sentenceBindings', phrases[0])

    def test_rebalancing_rejects_insufficient_total_duration(self):
        phrases = [{'evidenceRefs': ['s1']}, {'evidenceRefs': ['s2']}]
        audio = [{'duration_ms': 4_000}, {'duration_ms': 4_000}]
        segments = [
            {'evidence_ref': 's1', 'target_duration_ms': 3_000},
            {'evidence_ref': 's2', 'target_duration_ms': 3_000},
        ]

        with self.assertRaisesRegex(ContentEngineError, '全部画面'):
            rebalance_narrated_phrase_refs(phrases, audio, segments)

    def test_same_material_accepts_different_copy_shapes(self):
        segments = [
            {'evidence_ref': f's{index}', 'target_duration_ms': 3_000}
            for index in range(1, 7)
        ]
        cases = [
            (
                [
                    {'text': '短开场', 'evidenceRefs': ['s1', 's2']},
                    {'text': '较长的主体内容', 'evidenceRefs': ['s3', 's4']},
                    {'text': '简短收尾', 'evidenceRefs': ['s5', 's6']},
                ],
                [{'duration_ms': 1_500}, {'duration_ms': 5_200}, {'duration_ms': 2_500}],
            ),
            (
                [
                    {'text': '换一种开场', 'evidenceRefs': ['s1']},
                    {'text': '换成两段主体中的第一段', 'evidenceRefs': ['s2', 's3']},
                    {'text': '换成两段主体中的第二段', 'evidenceRefs': ['s4']},
                    {'text': '新的结尾', 'evidenceRefs': ['s5', 's6']},
                ],
                [
                    {'duration_ms': 2_200},
                    {'duration_ms': 4_000},
                    {'duration_ms': 1_800},
                    {'duration_ms': 2_500},
                ],
            ),
        ]

        for phrases, audio in cases:
            with self.subTest(phrase_count=len(phrases)):
                rebalance_narrated_phrase_refs(phrases, audio, segments)
                refs = [ref for phrase in phrases for ref in phrase['evidenceRefs']]
                self.assertEqual([f's{index}' for index in range(1, 7)], refs)
                durations = {segment['evidence_ref']: segment['target_duration_ms'] for segment in segments}
                for index, (phrase, voice) in enumerate(zip(phrases, audio)):
                    required = voice['duration_ms'] + (160 if index < len(phrases) - 1 else 0)
                    available = sum(durations[ref] for ref in phrase['evidenceRefs'])
                    self.assertGreaterEqual(available, required)


class NarratedProductionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = batch_fixtures.NarratedBatchTests(methodName='runTest')
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.s = self.fixture.s
        self.domain = self.s._narrated_batches()
        self.events = []
        self.failure = None
        self.batch = self.s.save_narrated_batch({
            'groups': {'middle': self.fixture.ids}, 'title': '现场学习', 'target_count': 1,
            'settings': {'workflow_version': 2},
        })
        self.planner = patch.object(NarratedBatchDomain, '_plan', self.plan)
        self.draft_planner = patch.object(NarratedBatchDomain, '_prepare_script_options',
            lambda domain, task_id, state: self.plan(task_id, state, 3))
        self.renderer = patch.object(NarratedBatchDomain, '_render_candidate', self.render)
        self.exporter = patch.object(NarratedBatchDomain, '_export_completed_candidates', return_value=None, create=True)
        for replacement in (self.planner, self.draft_planner, self.renderer, self.exporter):
            replacement.start()
            self.addCleanup(replacement.stop)
        task = self.s.prepare_narrated_scripts(self.batch['batch_id'])
        self.s.run_creative_task(task['task_id'])
        self.options = self.s.get_narrated_batch(self.batch['batch_id'])['script_options']
        self.events.clear()

    def plan(self, task_id, state, wanted):
        rows = state.setdefault('script_options', []) if state.get('_preparing_scripts') else state['candidates']
        self.events.append(('plan', (state.get('direction') or {}).get('angle')))
        self.domain._initialize_speech_budget(state)
        while len(rows) < wanted:
            number = len(rows)
            # Distinct evidence windows; the real normalizer still validates mapping.
            shot = state['available_shots'][number * 2]
            sid = shot['segment_id']
            candidate = self.domain._normalize_candidate({
                'title': f'现场问题{number}', 'angle': f'方向{number}', 'audience': '学员',
                'pain_point': '不懂操作', 'shot_ids': [sid],
                'phrases': [{'text': f'我想了解第{number + 1}个问题。', 'shot_ids': [sid]}],
            }, state, [])
            candidate.update(review_version=2, status='planned')
            rows.append(candidate)
            bind_planned_candidate(state, candidate)

    def render(self, task_id, state, candidate, index, total):
        self.domain._verify_confirmed_script(state, candidate)
        self.events.append(('render', candidate['candidate_id']))
        if self.failure and candidate['candidate_id'] == self.options[0]['candidate_id']:
            if self.failure != 'cloud_response_invalid':
                self.domain.db.execute("UPDATE content_tasks SET status='paused',error_code=? WHERE id=?", (self.failure, task_id))
            raise ContentEngineError(self.failure, '本条失败')
        candidate.update(status='completed', generated_video_id=f'fake-{index}')

    def request(self, first_count=2):
        return {'batch_id': self.batch['batch_id'], 'selections': [
            {'script_id': item['candidate_id'], 'revision': item['revision'], 'count': count}
            for item, count in zip(self.options[:2], (first_count, 1))
        ]}

    def run_selection(self, request):
        task = self.s.confirm_narrated_script(request)
        self.s.run_creative_task(task['task_id'])
        return self.s.get_narrated_batch(self.batch['batch_id'])

    def test_selected_counts_preserve_both_seeds_and_resume_without_duplicates(self):
        request = self.request()
        result = self.run_selection(request)
        self.assertEqual('completed', result['status'])
        self.assertEqual(3, result['target_count'])
        self.assertTrue(result['count_is_exact'])
        self.assertEqual([2, 1], [item['count'] for item in result['script_selections']])
        for option in self.options[:2]:
            candidate = next(c for c in result['candidates'] if c['candidate_id'] == option['candidate_id'])
            self.assertEqual(option['narration'], candidate['narration'])
        self.assertEqual([self.options[0]['angle']], [value for kind, value in self.events if kind == 'plan'])
        self.assertEqual(3, sum(kind == 'render' for kind, _ in self.events))
        self.run_selection(request)
        self.assertEqual(3, sum(kind == 'render' for kind, _ in self.events))

    def test_missing_speech_credentials_stops_before_production_is_created(self):
        with patch.object(self.domain.d, '_approved_auto_mix_voice_persona', return_value={'provider': 'volcengine'}), \
                patch('content_engine.volcengine_tts.VolcengineTTSProvider') as provider:
            provider.return_value.configured = False
            with self.assertRaises(ContentEngineError) as error:
                self.s.confirm_narrated_script(self.request())
        self.assertEqual('volcengine_tts_not_configured', error.exception.code)
        self.assertFalse(self.domain._load(self.batch['batch_id']).get('production_jobs'))
        self.assertEqual([], self.events)

    def test_insufficient_unique_footage_stops_before_production_is_created(self):
        state = self.domain._load(self.batch['batch_id'])
        state['settings']['minimum_duration_seconds'] = 30
        state['available_shots'] = [{
            'segment_id': 'short-only', 'asset_id': self.fixture.ids[0],
            'source_start_ms': 0, 'source_end_ms': 5_000,
            'target_duration_ms': 5_000,
        }]
        self.domain._store(state)
        with self.assertRaises(ContentEngineError) as error:
            self.s.confirm_narrated_script(self.request(first_count=1))
        self.assertEqual('narrated_insufficient_unique_footage', error.exception.code)
        self.assertIn('最多可制作 0 条', error.exception.message)
        self.assertFalse(self.domain._load(self.batch['batch_id']).get('production_jobs'))

    def test_missing_analysis_defers_unique_footage_gate_until_production(self):
        state = self.domain._load(self.batch['batch_id'])
        state['settings']['minimum_duration_seconds'] = 30
        state['available_shots'] = []
        self.domain._store(state)
        task = self.s.confirm_narrated_script(self.request(first_count=1))
        saved = self.domain._load(self.batch['batch_id'])
        self.assertEqual(task['task_id'], saved['task_id'])
        self.assertEqual(2, len(saved['production_jobs']))

    def test_grounding_group_order_does_not_replace_confirmed_edit_order(self):
        state = self.domain._load(self.batch['batch_id'])
        candidate = copy.deepcopy(state['script_options'][0])
        candidate['shots'] = [state['available_shots'][3], state['available_shots'][0]]
        expected = [shot['segment_id'] for shot in candidate['shots']]
        def check_order(reviewed, batch):
            self.assertEqual([shot['segment_id'] for shot in reviewed['shots']], expected)
        with patch.object(self.domain, '_ground_shots', return_value=list(reversed(candidate['shots']))), \
             patch.object(self.domain, '_review_edit', side_effect=check_order) as review:
            review_confirmed_candidate(self.domain, state, candidate)
        review.assert_called_once()

    def test_invalid_selection_is_atomic(self):
        request = self.request()
        request['selections'][1]['revision'] += 1
        with self.assertRaises(ContentEngineError) as error:
            self.s.confirm_narrated_script(request)
        self.assertEqual('narrated_script_revision_changed', error.exception.code)
        state = self.domain._load(self.batch['batch_id'])
        self.assertFalse(state.get('script_confirmation'))
        self.assertEqual([], state['candidates'])
        request = self.request(first_count=300)
        with self.assertRaises(ContentEngineError) as error:
            self.s.confirm_narrated_script(request)
        self.assertEqual('invalid_narrated_count', error.exception.code)

    def test_known_item_failure_keeps_other_direction_running(self):
        self.failure = 'narrated_edit_rejected'
        result = self.run_selection(self.request(first_count=1))
        self.assertEqual('completed_with_errors', result['status'])
        self.assertEqual(1, sum(c['status'] == 'completed' for c in result['candidates']))
        self.assertEqual('skipped', result['production_jobs'][0]['status'])
        self.assertEqual(2, sum(kind == 'render' for kind, _ in self.events))

    def test_unknown_outcome_is_retained_without_automatic_resubmission(self):
        self.failure = 'auto_mix_tts_outcome_unknown'
        result = self.run_selection(self.request(first_count=1))
        self.assertEqual('outcome_unknown', result['status'])
        self.assertEqual('outcome_unknown', result['production_jobs'][0]['status'])
        self.assertEqual(1, sum(kind == 'render' for kind, _ in self.events))
        with self.assertRaises(ContentEngineError) as error:
            self.s.continue_narrated_batch(self.batch['batch_id'])
        self.assertEqual('narrated_planning_outcome_unknown', error.exception.code)
        self.assertEqual(1, sum(kind == 'render' for kind, _ in self.events))

    def test_known_voice_failure_resumes_from_accepted_review_checkpoint(self):
        task = self.s.confirm_narrated_script(self.request(first_count=1))
        state = self.domain._load(self.batch['batch_id'])
        for candidate in state['candidates']:
            candidate['status'] = 'needs_review'
        self.domain._store(state)

        reviewed = []
        rendered = []
        failed_candidate_id = self.options[1]['candidate_id']
        voice_available = False

        def accept_review(candidate, batch):
            reviewed.append(candidate['candidate_id'])
            candidate.update(review_version=2, status='planned')

        def render_after_review(task_id, batch, candidate, index, total):
            nonlocal voice_available
            self.domain._verify_confirmed_script(batch, candidate)
            rendered.append(candidate['candidate_id'])
            if candidate['candidate_id'] == failed_candidate_id and not voice_available:
                self.domain.db.execute(
                    "UPDATE content_tasks SET status='paused',error_code=? WHERE id=?",
                    ('auto_mix_voice_request_failed', task_id),
                )
                raise ContentEngineError('auto_mix_voice_request_failed', '云端配音暂时不可用')
            candidate.update(status='completed', generated_video_id=f'fake-{index}')

        with patch.object(NarratedBatchDomain, '_review_edit', side_effect=accept_review), \
             patch.object(NarratedBatchDomain, '_render_candidate', side_effect=render_after_review):
            self.s.run_creative_task(task['task_id'])
            interrupted = self.domain._load(self.batch['batch_id'])
            failed = next(c for c in interrupted['candidates'] if c['candidate_id'] == failed_candidate_id)
            checkpoint = {
                'candidate_id': failed['candidate_id'],
                'review_version': failed['review_version'],
                'shots': copy.deepcopy(failed['shots']),
                'phrases': copy.deepcopy(failed['phrases']),
            }
            self.assertEqual('planned', failed['status'])
            self.assertEqual('queued', interrupted['production_jobs'][1]['status'])
            self.assertEqual('needs_attention', interrupted['status'])

            voice_available = True
            self.s.continue_narrated_batch(self.batch['batch_id'])
            self.s.run_creative_task(task['task_id'])

        result = self.domain._load(self.batch['batch_id'])
        resumed = next(c for c in result['candidates'] if c['candidate_id'] == failed_candidate_id)
        self.assertEqual('completed', result['status'])
        self.assertEqual(checkpoint['candidate_id'], resumed['candidate_id'])
        self.assertEqual(checkpoint['review_version'], resumed['review_version'])
        self.assertEqual(checkpoint['shots'], resumed['shots'])
        self.assertEqual(checkpoint['phrases'], resumed['phrases'])
        self.assertEqual(1, reviewed.count(failed_candidate_id), '已通过的付费审核不得在续跑时重复调用。')
        self.assertEqual(1, rendered.count(self.options[0]['candidate_id']), '已完成作品不得重复渲染。')
        self.assertEqual(2, rendered.count(failed_candidate_id), '只应重试中断的本地/配音制作步骤。')

    def test_explicit_continue_retries_invalid_planning_but_not_completed_work(self):
        self.failure = 'cloud_response_invalid'
        result = self.run_selection(self.request(first_count=1))
        self.assertTrue(result['production_retry_available'])
        self.assertEqual('skipped', result['production_jobs'][0]['status'])
        self.assertEqual(1, sum(kind == 'render' and value == self.options[0]['candidate_id'] for kind, value in self.events),
                         '格式错误已用尽结构化纠错后，不得自动重进整条制作。')
        state = self.domain._load(self.batch['batch_id'])
        state['candidates'][0]['_run_id'] = 'already-started-paid-run'
        self.domain._store(state)
        self.assertFalse(self.domain.get(self.batch['batch_id'])['production_retry_available'])
        state['candidates'][0].pop('_run_id')
        self.domain._store(state)
        self.failure = None
        task = self.s.continue_narrated_batch(self.batch['batch_id'])
        with patch.object(NarratedBatchDomain, '_review_edit', side_effect=lambda candidate, batch: candidate.update(status='planned')):
            self.s.run_creative_task(task['task_id'])
        result = self.domain.get(self.batch['batch_id'])
        self.assertEqual('completed', result['status'])
        self.assertEqual(self.options[0]['narration'], result['candidates'][0]['narration'])
        self.assertEqual(1, sum(kind == 'render' and value == self.options[1]['candidate_id'] for kind, value in self.events))

    def test_export_resumes_and_preserves_a_changed_destination(self):
        state = self.domain._load(self.batch['batch_id'])
        candidate = {**self.options[0], 'status': 'completed', 'generated_video_id': 'export-fixture'}
        state['candidates'] = [candidate]
        source = self.domain.d.data_dir / 'generated' / 'export-fixture.mp4'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b'local export fixture')
        with patch.object(self.domain.d, '_generated_row', return_value={'status': 'completed', 'output_path': str(source)}):
            export_completed(self.domain, state, [candidate])
            self.assertTrue(state['export_ready'])
            saved = state['_exported_candidates'][candidate['candidate_id']]
            target = output_folder(self.domain, state) / saved['file']
            modified = target.stat().st_mtime_ns
            export_completed(self.domain, state)
            self.assertEqual(modified, target.stat().st_mtime_ns)
            target.write_bytes(b'user changed this file')
            export_completed(self.domain, state)
            self.assertIn('export_error', state)
            self.assertEqual(b'user changed this file', target.read_bytes())

    def test_prepare_probes_new_import_before_analysis(self):
        asset_id = self.fixture.ids[0]
        self.s.connection.execute("UPDATE assets SET probe_status='pending' WHERE id=?", (asset_id,))
        def probe(requested_id):
            self.s.connection.execute("UPDATE assets SET probe_status='ok' WHERE id=?", (requested_id,))
            return {'probe_status': 'ok'}
        with patch.object(self.s, 'probe_asset', side_effect=probe) as probing:
            task = self.s.prepare_narrated_scripts(self.batch['batch_id'])
            self.s.run_creative_task(task['task_id'])
        probing.assert_called_once_with(asset_id)
        self.assertEqual(3, len(self.s.get_narrated_batch(self.batch['batch_id'])['script_options']))

    def test_mapping_repair_reports_all_paragraph_budgets_and_invalid_ids(self):
        state = self.domain._load(self.batch['batch_id'])
        state['_story_planning_version'] = 2
        shots = state['available_shots'][:2]
        state['available_shots'] = shots
        plan = {'title': '现场问题', 'phrases': [
            {'text': '需要完整讲解的问题。' * 7, 'shot_ids': [shot['segment_id']]}
            for shot in shots
        ] + [{'text': '另一个问题。', 'shot_ids': ['missing-shot']}]}
        def inspect(payload, instruction, **kwargs):
            issue = kwargs['validation_error']({'candidates': [plan]})
            self.assertIn('"paragraph": 2', issue)
            self.assertIn('missing-shot', issue)
            self.assertTrue(all(shot['max_narration_chars'] > 0 for shot in payload['shots']))
            self.assertIn('"max_chars":', payload['mapped_plan_repairs'][0]['validation_error'])
            raise ContentEngineError('inspection_complete', 'local-only check')
        with patch.object(self.domain, '_cloud', side_effect=inspect):
            with self.assertRaises(ContentEngineError) as error:
                self.domain._repair_mapped_plans([plan], state)
        self.assertEqual('inspection_complete', error.exception.code)

    def test_draft_preparation_keeps_good_choices_and_repairs_only_the_rejected_one(self):
        state = self.domain._load(self.batch['batch_id'])
        state['script_options'] = []
        scripts = [{'title': title, 'audience': title, 'pain_point': title, 'angle': title,
                    'narration': text, 'source_ids': ['S1']} for title, text in (
            ('认识设备', '先了解现场设备的构成，再带着自己的问题去交流。'),
            ('准备提问', '参加活动之前可以整理疑问，把关注的事情记下来。'),
            ('看配件', '想认识清洁用品，可以结合实物辨认不同配件。'))]
        calls = []
        def cloud(payload, instruction, **kwargs):
            calls.append(payload)
            if 'count' in payload:
                result = {'scripts': scripts if payload['count'] == 3 else [scripts[0]]}
            else:
                result = {'reviews': [{'index': index, 'accepted': not (len(calls) == 2 and index == 0),
                    'unsupported_claims': ['待修改内容'] if len(calls) == 2 and index == 0 else [],
                    'reason': '需要修改' if len(calls) == 2 and index == 0 else '素材支持'}
                    for index in range(len(payload['scripts']))]}
            self.assertIsNone(kwargs['validation_error'](result))
            return result
        with patch.object(self.domain, '_cloud', side_effect=cloud), patch.object(self.domain, '_review') as video_review:
            narrated_script_drafts.prepare(self.domain, state['task_id'], state)
        self.assertEqual(1, len(state['script_options']))
        self.assertEqual(1, calls[2]['count'])
        self.assertTrue(all(option['_draft_only'] and option['status'] == 'needs_review' for option in state['script_options']))
        video_review.assert_not_called()

    def test_unmapped_confirmed_draft_cannot_reach_paid_render(self):
        state = self.domain._load(self.batch['batch_id'])
        for option in state['script_options']:
            option.update(_draft_only=True, status='needs_review', phrases=[])
        self.domain._store(state)
        with patch.object(NarratedBatchDomain, '_cloud', side_effect=ContentEngineError('cloud_not_configured', '本地阻断验证')) as mapping_request:
            result = self.run_selection(self.request(first_count=1))
        self.assertTrue(mapping_request.called)
        self.assertTrue(all(call.kwargs.get('generation_rules') is False for call in mapping_request.call_args_list),
                        '确认稿编排不能注入续作改写规则')
        self.assertEqual('needs_attention', result['status'])
        self.assertFalse(any(kind == 'render' for kind, _ in self.events))
        self.renderer.stop()
        with self.assertRaises(ContentEngineError) as error:
            self.domain._render_candidate(state['task_id'], state, state['script_options'][0], 0, 1)
        self.assertEqual('narrated_script_needs_mapping', error.exception.code)

    def test_batch_budget_does_not_shorten_an_admitted_provider_request(self):
        state = self.domain._load(self.batch['batch_id'])
        state['_planning_budget'] = {'status': 'running', 'started_at_epoch': time.time() - 230,
            'max_elapsed_seconds': 300, 'cloud_calls': 6, 'max_cloud_calls': 12}
        self.domain._active_batch = state
        cloud = self.domain.d.analyzer.cloud_client
        cloud.timeout_seconds = 90
        with patch.object(cloud, '_structured_completion', return_value={'ok': True}) as request:
            self.domain._cloud({'local_fixture': True}, 'test', generation_rules=False)
        self.assertEqual(90, request.call_args.kwargs['timeout'])

    def test_confirmed_mapping_keeps_words_local_and_exposes_measured_budgets(self):
        state = self.domain._load(self.batch['batch_id'])
        narration = '我想了解这个部件。再看看设备的屏幕。'
        candidate = {**state['script_options'][0], '_draft_only': True, 'narration': narration, 'phrases': []}
        def choose_shots(payload, instruction, **kwargs):
            units = payload['narration_units']
            self.assertEqual(narration, ''.join(unit['text'] for unit in units))
            self.assertEqual([self.domain._phrase_budget_ms(state, unit['text']) for unit in units],
                             [unit['required_ms'] for unit in units])
            unused = list(payload['shots'])
            assignments = []
            for unit in units:
                shot = next(shot for shot in unused if shot['target_duration_ms'] >= unit['required_ms'])
                unused = [other for other in unused if other['asset_id'] != shot['asset_id']]
                assignments.append({'unit_ids': [unit['unit_id']], 'shot_ids': [shot['shot_id']], 'text': '模型不得覆盖正文'})
            response = {'assignments': assignments}
            self.assertIsNone(kwargs['validation_error'](response))
            return response
        with patch.object(self.domain, '_cloud', side_effect=choose_shots), patch.object(self.domain, '_review_edit'):
            review_confirmed_candidate(self.domain, state, candidate)
        self.assertNotIn('_draft_only', candidate)
        self.assertEqual(narration, candidate['narration'])
        self.assertEqual(narration, ''.join(phrase['text'] for phrase in candidate['phrases']))

    def test_confirmed_units_preserve_full_sentences_and_only_split_overlong_copy(self):
        state = self.domain._load(self.batch['batch_id'])
        first = '现场人员说明，先观察部件位置，再核对用途；'
        quoted = '随后提醒：“先看这个按钮，再看旁边的部件。”'
        long_sentence = '接着补充：' + '说明部件位置，' * 15 + '最后核对。'
        narration = first + quoted + long_sentence + '还有什么疑问？'
        units = confirmed_narration_units(self.domain, state, narration)
        texts = [unit['text'] for unit in units]
        self.assertEqual(narration, ''.join(texts))
        self.assertTrue(all(0 < len(text) <= 80 for text in texts))
        self.assertEqual([first, quoted], texts[:2])
        self.assertEqual(long_sentence, ''.join(texts[2:-1]))
        self.assertGreater(len(texts[2:-1]), 1)
        self.assertTrue(texts[2].endswith('，'))
        self.assertEqual('还有什么疑问？', texts[-1])
        self.assertEqual([self.domain._phrase_budget_ms(state, text) for text in texts],
                         [unit['required_ms'] for unit in units])

    def test_local_copy_edit_reuses_runtime_mapping_and_confirmation_still_requires_review(self):
        initial = self.domain._load(self.batch['batch_id'])
        initial['_story_planning_version'] = 2
        refs = [shot['segment_id'] for shot in list({s['asset_id']: s for s in initial['available_shots']}.values())[:3]]
        phrases = [{'text': text, 'shot_ids': [ref]} for text, ref in zip(
            ('先看设备。', '这里介绍部件。', '再问使用问题。'), refs)]
        baseline = self.domain._normalize_candidate({'title': '现场讲解', 'shot_ids': refs,
            'phrases': phrases}, initial, [])
        baseline.update(candidate_id=initial['script_options'][0]['candidate_id'], revision=1,
                        status='failed', error_code='narrated_edit_rejected')
        narration = ''.join(phrase['text'] for phrase in phrases)
        baseline['narration'] = narration
        edited_text = narration.replace('这里介绍部件。', '讲师说，这里介绍部件。')
        for stale_phrases in ([], [{'text': '更早的草稿。', 'shot_ids': [refs[0]]}]):
            with self.subTest(stale_phrases=bool(stale_phrases)):
                state = copy.deepcopy(initial)
                state['script_options'][0] = {**copy.deepcopy(baseline),
                    'phrases': stale_phrases, '_draft_only': not stale_phrases}
                state['candidates'] = [copy.deepcopy(baseline)]
                self.domain._store(state)
                with patch.object(self.domain, '_cloud', side_effect=AssertionError('No paid mapping')) as cloud:
                    self.domain.update_candidate({'batch_id': state['batch_id'],
                        'candidate_id': baseline['candidate_id'], 'narration': edited_text})
                    saved = self.domain._load(state['batch_id'])
                    option = saved['script_options'][0]
                    self.assertFalse(option.get('_draft_only'))
                    self.assertTrue(option.get('_user_supplied'))
                    self.assertEqual(edited_text, self.domain._candidate_user_context(saved, option))
                    statement = {'kind': 'fact', 'risk_scope': 'outcome', 'supported': False,
                                 'evidence': [], 'reason': '画面无法证明用户提供的活动信息'}
                    source = {'user_context_authority': 'confirmed_script', 'user_context': edited_text,
                              'facts': [{'shot_id': 'shot-1', 'fact_id': 'fact-1'}]}
                    self.assertFalse(self.domain._bind_confirmed_user_statement(
                        source, statement, {'quote': edited_text}))
                    self.assertEqual('outcome', statement['risk_scope'])
                    self.assertEqual([], statement['evidence'])
                    self.assertEqual(edited_text, ''.join(p['text'] for p in option['phrases']))
                    self.assertEqual([p['shot_ids'] for p in phrases], [p['shot_ids'] for p in option['phrases']])
                    for index in (0, 2):
                        self.assertEqual(baseline['shots'][index], option['shots'][index])
                    with patch.object(self.domain, 'start', return_value={'local': True}):
                        confirm_selections(self.domain, {'batch_id': state['batch_id'], 'selections': [
                            {'script_id': option['candidate_id'], 'revision': option['revision'], 'count': 1}]})
                    confirmed = self.domain._load(state['batch_id'])
                    seed = confirmed['candidates'][0]
                    self.assertEqual(option['phrases'], seed['phrases'])
                    self.assertEqual(edited_text, seed['_confirmed_script']['narration'])
                    def review_candidates(candidates, batch, audit):
                        self.assertTrue(candidates[0].get('_user_supplied'))
                        return candidates
                    with patch.object(self.domain, '_review', side_effect=review_candidates) as review:
                        self.domain._review_edit(seed, confirmed)
                    self.assertTrue(seed.get('_user_supplied'))
                    review.assert_called_once()
                    cloud.assert_not_called()

    def test_local_mapping_rejects_cross_paragraph_changes_and_source_range_drift(self):
        state = self.domain._load(self.batch['batch_id'])
        refs = [shot['segment_id'] for shot in list({s['asset_id']: s for s in state['available_shots']}.values())[:2]]
        baseline = self.domain._normalize_candidate({'title': '现场讲解', 'shot_ids': refs,
            'phrases': [{'text': '先看设备。', 'shot_ids': [refs[0]]},
                        {'text': '再问问题。', 'shot_ids': [refs[1]]}]}, state, [])
        baseline['narration'] = '先看设备。再问问题。'
        for candidate, text in ((baseline, '先看展板。再问参数。'),
                                ({**baseline, '_run_id': 'already-started'}, '先看设备。讲师说，再问问题。'),
                                ({**baseline, 'status': 'outcome_unknown'}, '先看设备。讲师说，再问问题。')):
            self.assertIsNone(normalize_preserved_mapping(self.domain, state, candidate, text, baseline['title']))
        prepared = normalize_preserved_mapping(self.domain, state, baseline,
            '先看设备。讲师说，再问问题。', baseline['title'])
        self.assertEqual(1, prepared['changed_phrase'])
        self.assertEqual('先看设备。', prepared['candidate']['phrases'][0]['text'])
        drifted = copy.deepcopy(prepared['candidate'])
        drifted['shots'][0]['source_end_ms'] += 1
        with patch.object(self.domain, '_normalize_candidate', return_value=drifted):
            self.assertIsNone(normalize_preserved_mapping(self.domain, state, baseline,
                '先看设备。讲师说，再问问题。', baseline['title']))

    def test_failed_remapping_restores_reviewed_mapping_but_success_keeps_new_shots(self):
        for succeeds in (False, True):
            with self.subTest(succeeds=succeeds):
                state = self.domain._load(self.batch['batch_id'])
                candidate = copy.deepcopy(state['script_options'][0])
                candidate['status'] = 'needs_review'
                state['candidates'] = [candidate]
                original = copy.deepcopy(candidate)
                original_error = ContentEngineError('narrated_edit_rejected', '原镜头的收尾画面需要复核')
                reviews, mappings = [], []

                def review(current, batch):
                    reviews.append(copy.deepcopy(current['shots']))
                    if len(reviews) > 1 and succeeds:
                        current['status'] = 'planned'
                        return
                    first = len(reviews) == 1
                    current['_edit_review_audit'] = {
                        'claim_review_response': {'reviews': [{'candidate_id': 'temporary-review', 'accepted': first}]},
                        'rejections': [{'candidate_id': 'temporary-review',
                            'stage': 'visual_review' if first else 'claim_review',
                            'reason': original_error.message if first else '新镜头缺少原声证据'}],
                    }
                    raise original_error if first else ContentEngineError('narrated_edit_rejected', '新镜头缺少原声证据')

                def remap(payload, instruction, **kwargs):
                    mappings.append(payload)
                    response = {'assignments': [{'unit_ids': [unit['unit_id'] for unit in payload['narration_units']],
                        'shot_ids': [payload['shots'][len(mappings) * 2]['shot_id']]}]}
                    self.assertIsNone(kwargs['validation_error'](response))
                    return response

                with patch.object(self.domain, '_review_edit', side_effect=review), \
                     patch.object(self.domain, '_cloud', side_effect=remap):
                    if succeeds:
                        review_confirmed_candidate(self.domain, state, candidate)
                    else:
                        with self.assertRaises(ContentEngineError) as failed:
                            review_confirmed_candidate(self.domain, state, candidate)
                        self.assertIs(failed.exception, original_error)
                self.assertEqual(original['narration'], candidate['narration'])
                self.assertEqual(1 if succeeds else 2, len(mappings))
                if succeeds:
                    self.assertEqual('planned', candidate['status'])
                    self.assertNotEqual(original['shots'], candidate['shots'])
                else:
                    self.assertEqual(original['shots'], candidate['shots'])
                    self.assertEqual(original['phrases'], candidate['phrases'])
                    self.assertEqual(original_error.message, candidate['_edit_review_audit']['rejections'][0]['reason'])
                    saved = self.domain._load(state['batch_id'])['candidates'][0]
                    self.assertEqual(candidate, saved)

    def test_known_format_failure_restores_mapping_without_replacing_error_or_retrying_unknown(self):
        for code, phase in (('cloud_response_invalid', 'review'), ('cloud_response_invalid', 'mapping'),
                            ('volcengine_request_rejected', 'review'), ('cloud_request_outcome_unknown', 'review')):
            with self.subTest(code=code, phase=phase):
                state = self.domain._load(self.batch['batch_id'])
                candidate = copy.deepcopy(state['script_options'][0])
                state['candidates'] = [candidate]
                original = copy.deepcopy(candidate)
                terminal_error = ContentEngineError(code, '保留真实终止错误')
                review_count = 0

                def review(current, batch):
                    nonlocal review_count
                    review_count += 1
                    if review_count > 1:
                        raise terminal_error
                    current['_edit_review_audit'] = {
                        'claim_review_response': {'reviews': [{'candidate_id': 'temporary', 'accepted': True}]},
                        'rejections': [{'stage': 'visual_review', 'candidate_id': 'temporary', 'reason': '原镜头待复核'}]}
                    raise ContentEngineError('narrated_edit_rejected', '原镜头待复核')

                def remap(payload, instruction, **kwargs):
                    if phase == 'mapping':
                        raise terminal_error
                    return {'assignments': [{'unit_ids': [unit['unit_id'] for unit in payload['narration_units']],
                                             'shot_ids': [payload['shots'][2]['shot_id']]}]}

                with patch.object(self.domain, '_review_edit', side_effect=review), \
                     patch.object(self.domain, '_cloud', side_effect=remap) as requests:
                    with self.assertRaises(ContentEngineError) as failed:
                        review_confirmed_candidate(self.domain, state, candidate)
                self.assertIs(failed.exception, terminal_error)
                self.assertEqual(1, requests.call_count)
                if code == 'cloud_response_invalid':
                    self.assertEqual(original['shots'], candidate['shots'])
                    self.assertEqual(original['phrases'], candidate['phrases'])
                    self.assertEqual('原镜头待复核', candidate['_edit_review_audit']['rejections'][0]['reason'])
                else:
                    self.assertNotEqual(original['shots'], candidate['shots'])

    def test_editorial_quality_failure_preserves_rejection_without_remapping(self):
        state = self.domain._load(self.batch['batch_id'])
        candidate = copy.deepcopy(state['script_options'][0])
        state['candidates'] = [candidate]
        error = ContentEngineError('narrated_edit_rejected', '编辑质量评分不足')
        def review(current, batch):
            current['_edit_review_audit'] = {
                'claim_review_response': {'reviews': [{'candidate_id': 'temporary', 'accepted': True}]},
                'rejections': [{'stage': 'visual_review', 'candidate_id': 'temporary', 'quality_score': .5,
                    'reason': error.message, 'findings_version': 1, 'hard_findings': [],
                    'editorial_notes': [{'type': 'editorial', 'reason': '表达可以更聚焦'}]}]}
            raise error
        with patch.object(self.domain, '_review_edit', side_effect=review), patch.object(self.domain, '_cloud') as requests:
            with self.assertRaises(ContentEngineError) as failed:
                review_confirmed_candidate(self.domain, state, candidate)
        self.assertIs(failed.exception, error)
        requests.assert_not_called()

    def test_training_context_can_supplement_but_not_replace_visible_action(self):
        state = self.domain._load(self.batch['batch_id'])
        self.domain._active_batch = state
        candidate = {**state['script_options'][0], 'title': '现场观察',
                     'phrases': [{'text': '培训现场，大家围着设备。',
                                  'shot_ids': [state['script_options'][0]['shots'][0]['segment_id']]}]}
        shot = candidate['shots'][0]
        shot['fact_id'] = 'training-fact'
        shot['visual_facts'] = {'evidence_class': 'direct_real', 'direct_observation': '多人围着设备。',
                                'frame_timestamps_ms': [1000], 'uncertainties': [], 'onscreen_claims': []}
        missing_pixels_rejected = []
        primary_source = 'direct_real'
        def completion(**kwargs):
            import json
            payload = json.loads(kwargs['messages'][-1]['content'])
            segment = payload['segment']
            item = {'statement_id': segment['statements'][0]['statement_id'], 'kind': 'fact',
                    'risk_scope': 'direct_observation' if primary_source == 'direct_real' else 'recorded_speech',
                    'supported': True, 'reason': '分别核对主要证据和活动来源',
                    'evidence': [{'shot_id': shot['segment_id'], 'fact_id': shot['fact_id'], 'source': source}
                                 for source in [primary_source, 'source_provenance']]}
            response = {'candidate_id': payload['candidate_id'], 'segment_key': segment['segment_key'],
                        'quality_score': .9, 'reason': '证据一致',
                        'phrase_review': {'phrase_id': segment['phrase_id'], 'statements': [item]}}
            self.assertIsNone(kwargs['validation_error'](response))
            self.assertTrue(item['supported'])
            item['evidence'] = item['evidence'][1:]
            missing_pixels_rejected.append(kwargs['validation_error'](response))
            item['evidence'].insert(0, {'shot_id': shot['segment_id'], 'fact_id': shot['fact_id'], 'source': primary_source})
            return response
        with patch.object(self.domain, '_source_evidence_for', return_value={'source_provenance': {'activity_label': '培训现场'},
                            'recorded_speech': [{'text': '点这个设置。'}]}), \
             patch.object(self.domain, '_claim_frames', side_effect=lambda batch, candidate, source: ([], source['frames'])), \
             patch.object(self.domain.d.analyzer.cloud_client, '_structured_completion', side_effect=completion):
            accepted = self.domain._grounded_claim_review([candidate], state, {'rejections': []})
            self.assertTrue(accepted)
            primary_source = 'recorded_speech'
            candidate['phrases'][0]['text'] = '现场讲解提到了设置。'
            accepted = self.domain._grounded_claim_review([candidate], state, {'rejections': []})
        self.assertTrue(accepted)
        self.assertTrue(all('主要证据' in issue for issue in missing_pixels_rejected))

    def test_confirmed_copy_can_cut_between_sources_of_the_same_verified_activity(self):
        state = self.domain._load(self.batch['batch_id'])
        first = state['available_shots'][0]
        second = next(shot for shot in state['available_shots'] if shot['asset_id'] != first['asset_id'])
        raw = {'title': '现场学习', 'phrases': [{'text': '现场讲解了部件和设置。',
                                               'shot_ids': [first['segment_id'], second['segment_id']]}]}
        with self.assertRaises(ContentEngineError):
            self.domain._repack_duration_candidate(raw, state, state['available_shots'])
        with patch.object(self.domain, '_source_evidence_for', return_value={'source_provenance': {'activity_label': '往期培训'}}):
            result = self.domain._repack_duration_candidate(raw, state, state['available_shots'], allow_same_activity_cuts=True)
            self.assertEqual(raw['phrases'], result['phrases'])
        for source in ({}, {'source_provenance': {'activity_label': None}}):
            with patch.object(self.domain, '_source_evidence_for', return_value=source), self.assertRaises(ContentEngineError):
                self.domain._repack_duration_candidate(raw, state, state['available_shots'], allow_same_activity_cuts=True)

    def test_mapping_repair_keeps_one_source_when_activity_identity_is_unverified(self):
        state = self.domain._load(self.batch['batch_id'])
        state['available_shots'] = [
            {'segment_id': 'A1', 'asset_id': 'source-a', 'source_start_ms': 0,
             'source_end_ms': 5000, 'target_duration_ms': 5000},
            {'segment_id': 'A2', 'asset_id': 'source-a', 'source_start_ms': 5000,
             'source_end_ms': 10000, 'target_duration_ms': 5000},
            {'segment_id': 'B1', 'asset_id': 'source-b', 'source_start_ms': 0,
             'source_end_ms': 5000, 'target_duration_ms': 5000},
        ]
        phrases = [{'text': '现场可以结合真机了解部署步骤，再逐项核对地图、网络、路线和清洁参数。',
                    'shot_ids': ['A1', 'B1']}]
        with patch.object(self.domain, '_source_evidence_for', return_value={}):
            coherent, source_changes = cohere_mapping_sources(self.domain, state, phrases)
            completed, _ = complete_mapping_capacity(self.domain, state, coherent)
            result = self.domain._repack_duration_candidate(
                {'title': '部署学习', 'phrases': completed}, state,
                state['available_shots'], allow_same_activity_cuts=True)
        self.assertEqual(phrases[0]['text'], result['phrases'][0]['text'])
        self.assertEqual(['A1', 'A2'], result['phrases'][0]['shot_ids'])
        self.assertEqual('B1', source_changes[0]['removed_shot_ids'][0])
        self.assertEqual(['A1', 'B1'], phrases[0]['shot_ids'])

    def test_capacity_fill_reserves_unused_footage_without_changing_copy_or_other_groups(self):
        state = self.domain._load(self.batch['batch_id'])
        state['available_shots'] = [{'segment_id': f'S{number}', 'asset_id': 'source-a',
            'source_start_ms': number * 5000, 'source_end_ms': (number + 1) * 5000,
            'target_duration_ms': 5000} for number in range(3)]
        phrases = [{'text': '现场讲解提到了设备部件、联网和设置，大家可以结合实物了解这些问题。', 'shot_ids': ['S0']},
                   {'text': '带着问题来看看。', 'shot_ids': ['S2']}]
        completed, changes = complete_mapping_capacity(self.domain, state, phrases)
        self.assertEqual(['S0', 'S1'], completed[0]['shot_ids'])
        self.assertEqual(phrases[1], completed[1])
        self.assertEqual([p['text'] for p in phrases], [p['text'] for p in completed])
        self.assertEqual(['S0'], phrases[0]['shot_ids'])
        self.assertEqual('S1', changes[0]['added_shot_id'])
        generous = [phrases[0], {**phrases[1], 'shot_ids': ['S1', 'S2']}]
        with self.assertRaises(ContentEngineError):
            complete_mapping_capacity(self.domain, state, generous, changed_phrase=0, allow_donors=False)
        self.assertEqual(['S1', 'S2'], generous[1]['shot_ids'])
        redistributed, _ = complete_mapping_capacity(self.domain, state, generous)
        self.assertEqual(['S0', 'S1'], redistributed[0]['shot_ids'])
        self.assertEqual(['S2'], redistributed[1]['shot_ids'])
        state['available_shots'][1]['asset_id'] = 'unrelated-source'
        with self.assertRaises(ContentEngineError):
            complete_mapping_capacity(self.domain, state, phrases)
        with patch.object(self.domain, '_source_evidence_for', return_value={
                'source_provenance': {'activity_label': '已确认的同场培训'}}):
            completed, _ = complete_mapping_capacity(self.domain, state, phrases)
        self.assertEqual(['S0', 'S1'], completed[0]['shot_ids'])
        self.assertEqual([p['text'] for p in phrases], [p['text'] for p in completed])

    def test_provider_retry_receives_errors_beyond_display_truncation(self):
        state = self.domain._load(self.batch['batch_id'])
        self.domain._active_batch = state
        issue = '需要逐段修正。' * 60 + '最后一段的镜头编号无效。'
        cloud = self.domain.d.analyzer.cloud_client
        def completion(**kwargs):
            kwargs['validation_error']({'candidates': []})
            retry = kwargs['validation_retry_context'](issue[:240], {'candidates': []})
            self.assertTrue(retry[-1]['content'].endswith('最后一段的镜头编号无效。'))
            return {'ok': True}
        with patch.object(cloud, '_structured_completion', side_effect=completion):
            self.domain._cloud({}, 'local test', validation_error=lambda _: issue)
        self.assertNotIn('_planning_inflight', state)


if __name__ == '__main__':
    unittest.main()
