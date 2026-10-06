"""Selected directions run through the real service/DB; only paid/media work is faked."""
import contextlib
import copy
import json
import re
import unittest
import time
from unittest.mock import patch

import test_narrated_batch as batch_fixtures
from content_engine.errors import ContentEngineError
from content_engine.creative_domain import rebalance_narrated_phrase_refs
from content_engine.narrated_batch import NarratedBatchDomain
from content_engine.narrated_sources import related_shots
from content_engine import narrated_production, narrated_script_drafts
from content_engine.narrated_production import bind_planned_candidate, export_completed, output_folder, review_confirmed_candidate, cohere_mapping_sources, complete_mapping_capacity, confirmed_narration_units, remap_units_with_source_capacity, normalize_preserved_mapping, confirm_selections, retryable_planning_jobs, retry_failed_planning
from content_engine.narrated_production import follow_script_footage, follow_script_phrases, follow_script_candidate, strict_visual_review


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


# The kind of copy the 2026-10-01 batch was skipped for: business claims that no
# frame can show (已办4期, 20-25款, 每月免费复训). Synthetic wording, same shape.
PROVIDED_COPY = ('有人问：学费凭什么每月涨100？清洁设备渠道商老板们，我今天交个底。\n\n'
                 '我们已经办了4期了，这次第5期课程新增了机器人二开定制化服务；真机加到了20-25款，'
                 '不同品牌不同价位摆一起让你摸；主机厂讲师也请得更多了。\n\n'
                 '还有一句实话：这个营办一期亏一期，真机调运、场地、讲师，每期都在加。\n'
                 '你交的这一次费用，买的是往后每一期的门票。学不会每月免费复训、不限次数；\n\n'
                 '还在犹豫的，建议先报名，随时可退，现场等你来')


class NarratedProductionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = batch_fixtures.NarratedBatchTests(methodName='runTest')
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.s = self.fixture.s
        self.domain = self.s._narrated_batches()
        # Production tests exercise an approved voice compatible with the narrated TTS path.
        approved_voice = self.domain.d._approved_auto_mix_voice_persona
        def compatible_voice(*args, **kwargs):
            persona = approved_voice(*args, **kwargs)
            return {**persona, 'provider': 'volcengine'} if persona else None
        voice = patch.object(self.domain.d, '_approved_auto_mix_voice_persona', side_effect=compatible_voice)
        voice.start()
        self.addCleanup(voice.stop)
        tts = patch('content_engine.volcengine_tts.VolcengineTTSProvider')
        tts_provider = tts.start()
        tts_provider.return_value.configured = True
        self.addCleanup(tts.stop)
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

    def strict(self):
        """Pins today's visual fact review: the batch opts into strict_visual_review."""
        self.s.save_narrated_batch({'batch_id': self.batch['batch_id'],
                                    'settings': {'workflow_version': 2, 'strict_visual_review': True}})

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
        self.strict()
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

    def test_incompatible_voice_stops_at_confirmation(self):
        with patch.object(self.domain.d, '_approved_auto_mix_voice_persona',
                          return_value={'id': 'legacy-voice', 'provider': 'bailian'}):
            with self.assertRaises(ContentEngineError) as error:
                self.s.confirm_narrated_script(self.request())
        self.assertEqual('auto_mix_voice_persona_invalid', error.exception.code)
        self.assertFalse(self.domain._load(self.batch['batch_id']).get('production_jobs'))
        self.assertEqual([], self.events)

    def test_unavailable_selected_music_stops_before_production_is_created(self):
        self.s.save_narrated_batch({
            'batch_id': self.batch['batch_id'],
            'settings': {
                'workflow_version': 2,
                'voice_persona_id': 'natural-life@1',
                'music_mode': 'selected',
                'music_track_ids': ['missing-track'],
            },
        })
        with self.assertRaises(ContentEngineError) as error:
            self.s.confirm_narrated_script(self.request())
        self.assertEqual('narrated_music_pool_empty', error.exception.code)
        self.assertFalse(self.domain._load(self.batch['batch_id']).get('production_jobs'))
        self.assertEqual([], self.events)

    def test_empty_auto_music_pool_stops_before_production_is_created(self):
        self.s.save_narrated_batch({
            'batch_id': self.batch['batch_id'],
            'settings': {
                'workflow_version': 2,
                'voice_persona_id': 'natural-life@1',
                'music_mode': 'auto',
                'music_track_ids': [],
            },
        })
        with patch.object(self.domain.d, '_select_auto_mix_music', return_value=None):
            with self.assertRaises(ContentEngineError) as error:
                self.s.confirm_narrated_script(self.request(first_count=1))
        self.assertEqual('auto_mix_licensed_music_required', error.exception.code)
        self.assertFalse(self.domain._load(self.batch['batch_id']).get('production_jobs'))
        self.assertEqual([], self.events)

    def test_legacy_missing_music_mode_keeps_voice_only_semantics(self):
        with patch.object(self.domain.d, '_select_auto_mix_music', return_value=None) as select_music:
            task = self.s.confirm_narrated_script(self.request(first_count=1))
        self.assertEqual('rendering', task['status'])
        self.assertFalse(select_music.called)
        self.assertEqual(2, len(self.domain._load(self.batch['batch_id'])['production_jobs']))

    def test_selected_music_is_accepted_when_the_track_is_ready(self):
        track_id = self.fixture.fixture._import_valid_music(with_loop=True)['trackId']
        self.s.save_narrated_batch({
            'batch_id': self.batch['batch_id'],
            'settings': {
                'workflow_version': 2,
                'voice_persona_id': 'natural-life@1',
                'music_mode': 'selected',
                'music_track_ids': [track_id],
            },
        })
        task = self.s.confirm_narrated_script(self.request())
        self.assertEqual('rendering', task['status'])
        self.assertEqual(3, len(self.domain._load(self.batch['batch_id'])['production_jobs']))

    def test_unavailable_formal_renderer_stops_before_production_is_created(self):
        with patch.object(self.domain.d.renderer, 'capability', {
            'available': True,
            'remotion': {'available': False, 'code': 'worker_unavailable'},
        }):
            with self.assertRaises(ContentEngineError) as error:
                self.s.confirm_narrated_script(self.request(first_count=1))
        self.assertEqual('remotion_runtime_unavailable', error.exception.code)
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
        for option in state['script_options']:
            option['narration'] = '这是对现场操作过程的详细说明。' * 40
        self.domain._store(state)
        self.options = state['script_options']
        task = self.s.confirm_narrated_script(self.request(first_count=1))
        saved = self.domain._load(self.batch['batch_id'])
        self.assertEqual(task['task_id'], saved['task_id'])
        self.assertEqual(2, len(saved['production_jobs']))

    def test_grounding_group_order_does_not_replace_confirmed_edit_order(self):
        state = self.domain._load(self.batch['batch_id'])
        state['settings']['strict_visual_review'] = True
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

    def test_explicit_voice_recovery_invalidates_only_unresolved_voice_steps(self):
        queued = self.s.confirm_narrated_script(self.request(first_count=1))
        state = self.domain._load(self.batch['batch_id'])
        candidate = state['candidates'][0]
        run_id = self.domain._create_run(queued['task_id'], state, candidate)
        self.domain.d._save_auto_mix_run(
            run_id,
            status='outcome_unknown',
            public_plan={'attention': {'code': 'auto_mix_voice_outcome_unknown'}},
            private_state={},
        )
        self.domain.d._record_auto_mix_artifact(run_id, 'tts', 'unknown-tts', 'outcome_unknown')
        self.domain.d._record_auto_mix_artifact(run_id, 'voice_alignment', 'completed-asr', 'completed')
        job = state['production_jobs'][0]
        job.update(status='outcome_unknown', candidate_id=candidate['candidate_id'],
                   error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        candidate.update(status='outcome_unknown', error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        state.update(status='outcome_unknown', _active_production_job=copy.deepcopy(job))
        self.domain._store(state)
        self.domain.db.execute(
            "UPDATE content_tasks SET status='paused', error_code=?, error_message=? WHERE id=?",
            ('auto_mix_voice_outcome_unknown', '等待配音回执', queued['task_id']),
        )

        with self.assertRaises(ContentEngineError) as error:
            self.s.resolve_narrated_voice_outcome({
                'batch_id': self.batch['batch_id'], 'provider_log_checked': False,
                'resolution': 'retry_voice', 'note': '尚未核对',
            })
        self.assertEqual('narrated_voice_confirmation_required', error.exception.code)

        result = self.s.resolve_narrated_voice_outcome({
            'batch_id': self.batch['batch_id'], 'provider_log_checked': True,
            'resolution': 'retry_voice', 'note': '平台记录没有可下载的第三段音频',
        })
        self.assertEqual('queued', result['task_status'])
        self.assertFalse(result['voice_recovery_available'])
        self.assertEqual('planned', self.domain.d._auto_mix_run_row(run_id=run_id)['status'])
        self.assertEqual('queued', self.domain._load(self.batch['batch_id'])['production_jobs'][0]['status'])
        self.assertEqual('planned', self.domain._load(self.batch['batch_id'])['candidates'][0]['status'])
        statuses = {row['cache_key']: row['status'] for row in self.domain.db.execute(
            "SELECT cache_key, status FROM auto_mix_stage_artifacts_v2 WHERE run_id=?", (run_id,)
        )}
        self.assertEqual('invalidated', statuses['unknown-tts'])
        self.assertEqual('completed', statuses['completed-asr'])

    def test_voice_recovery_can_requeue_a_gateway_preflight_failure(self):
        queued = self.s.confirm_narrated_script(self.request(first_count=1))
        state = self.domain._load(self.batch['batch_id'])
        candidate = state['candidates'][0]
        run_id = self.domain._create_run(queued['task_id'], state, candidate)
        self.domain.d._save_auto_mix_run(
            run_id,
            status='outcome_unknown',
            public_plan={'attention': {'code': 'auto_mix_voice_outcome_unknown'}},
            private_state={},
        )
        self.domain.d._record_auto_mix_artifact(run_id, 'tts', 'gateway-tts', 'outcome_unknown')
        job = state['production_jobs'][0]
        job.update(status='outcome_unknown', candidate_id=candidate['candidate_id'],
                   error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        candidate.update(status='outcome_unknown', error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        state.update(status='outcome_unknown', _active_production_job=copy.deepcopy(job))
        self.domain._store(state)
        self.domain.db.execute(
            "UPDATE content_tasks SET status='failed', error_code=?, error_message=? WHERE id=?",
            ('provider_gateway_unavailable', '云端服务暂不可用', queued['task_id']),
        )

        result = self.s.resolve_narrated_voice_outcome({
            'batch_id': self.batch['batch_id'], 'provider_log_checked': True,
            'resolution': 'retry_voice', 'note': '已确认本次没有成功提交配音请求',
        })
        self.assertEqual('queued', result['task_status'])
        task = self.s.get_task(queued['task_id'])
        self.assertEqual('queued', task['status'])
        self.assertIsNone(task['error_code'])
        self.assertEqual('planned', self.domain.d._auto_mix_run_row(run_id=run_id)['status'])

    def test_voice_retry_needs_the_batch_voice_approved_first(self):
        # CE2: an older build cleared the approval of this batch's voice. The retry would
        # voice with it and fail again, so nothing is invalidated or requeued first.
        queued = self.s.confirm_narrated_script(self.request(first_count=1))
        state = self.domain._load(self.batch['batch_id'])
        state['settings'] = {**state['settings'], 'voice_persona_id': 'natural-life@1'}
        candidate = state['candidates'][0]
        run_id = self.domain._create_run(queued['task_id'], state, candidate)
        self.domain.d._save_auto_mix_run(
            run_id, status='outcome_unknown',
            public_plan={'attention': {'code': 'auto_mix_voice_outcome_unknown'}}, private_state={})
        self.domain.d._record_auto_mix_artifact(run_id, 'tts', 'unknown-tts', 'outcome_unknown')
        job = state['production_jobs'][0]
        job.update(status='outcome_unknown', candidate_id=candidate['candidate_id'],
                   error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        candidate.update(status='outcome_unknown', error_code='auto_mix_voice_outcome_unknown', error='等待配音回执')
        state.update(status='outcome_unknown', _active_production_job=copy.deepcopy(job))
        self.domain._store(state)
        self.domain.db.execute(
            "UPDATE content_tasks SET status='paused', error_code=? WHERE id=?",
            ('auto_mix_voice_outcome_unknown', queued['task_id']))
        self.domain.db.execute("UPDATE voice_personas_v1 SET approved_at = NULL WHERE id = 'natural-life@1'")
        stored = self.domain._load(self.batch['batch_id'])
        request = {'batch_id': self.batch['batch_id'], 'provider_log_checked': True,
                   'resolution': 'retry_voice', 'note': '平台记录没有可下载的音频'}

        with self.assertRaises(ContentEngineError) as error:
            self.s.resolve_narrated_voice_outcome(request)
        self.assertEqual('auto_mix_voice_persona_approval_required', error.exception.code)
        self.assertEqual(stored, self.domain._load(self.batch['batch_id']), 'no audit, no queued job')
        self.assertEqual('outcome_unknown', self.domain.d._auto_mix_run_row(run_id=run_id)['status'])
        self.assertEqual(['outcome_unknown'], [row['status'] for row in self.domain.db.execute(
            "SELECT status FROM auto_mix_stage_artifacts_v2 WHERE run_id=?", (run_id,))])
        self.assertEqual('paused', self.s.get_task(queued['task_id'])['status'])
        self.assertTrue(self.s.get_narrated_batch(self.batch['batch_id'])['voice_recovery_available'])

        self.domain.db.execute(
            "UPDATE voice_personas_v1 SET approved_at = '2026-09-29T00:00:00.000Z' WHERE id = 'natural-life@1'")
        self.assertEqual('queued', self.s.resolve_narrated_voice_outcome(request)['task_status'])

    def test_known_voice_failure_resumes_from_accepted_review_checkpoint(self):
        self.strict()
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
            self.assertEqual('needs_attention', self.s.get_narrated_batch(self.batch['batch_id'])['status'])

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

    def test_failed_two_item_batch_can_replan_without_reusing_short_voice_run(self):
        state = self.domain._load(self.batch['batch_id'])
        first = copy.deepcopy(self.options[0])
        first['_run_id'] = 'old-voice-run'
        first['status'] = 'failed'
        state['candidates'] = [first]
        state['status'] = 'completed_with_errors'
        state['production_jobs'] = [
            {'candidate_id': first['candidate_id'], 'status': 'skipped',
             'error_code': 'narrated_copy_too_long'},
            {'candidate_id': None, 'status': 'skipped',
             'error_code': 'narrated_no_usable_candidate'},
        ]
        self.assertEqual(2, len(retryable_planning_jobs(state)))
        retry_failed_planning(state)
        self.assertEqual(['queued', 'queued'], [j['status'] for j in state['production_jobs']])
        self.assertEqual('needs_review', first['status'])
        self.assertNotIn('_run_id', first)
        self.assertTrue(first['_voice_capacity_retry'])

    def test_voice_overflow_retry_adds_unused_source_before_review(self):
        state = self.domain._load(self.batch['batch_id'])
        state['settings']['strict_visual_review'] = True
        state['_story_planning_version'] = 2
        state['_speech_budget'] = {'version': 1, 'capacity_ms_per_char': 283.4}
        state['available_shots'] = [
            {'segment_id': f'S{i}', 'asset_id': 'same-source',
             'source_start_ms': i * 5000, 'source_end_ms': (i + 1) * 5000,
             'target_duration_ms': 5000} for i in range(4)]
        candidate = {'candidate_id': 'retry', 'title': '现场说明',
                     'narration': '文' * 45, 'status': 'needs_review',
                     '_voice_capacity_retry': True,
                     'phrases': [{'text': '文' * 45, 'shot_ids': ['S0', 'S1', 'S2']}],
                     'shots': state['available_shots'][:3]}
        state['candidates'] = [candidate]
        def normalize(raw, *_args):
            return {'shots': [state['available_shots'][int(ref[1:])]
                              for ref in raw['shot_ids']],
                    'phrases': raw['phrases'], '_tracks': {}, '_timeline': {},
                    'duration_ms': len(raw['shot_ids']) * 5000}
        with patch.object(self.domain, '_source_evidence_for', return_value={}), \
             patch.object(self.domain, '_normalize_candidate', side_effect=normalize), \
             patch.object(self.domain, '_ground_shots', side_effect=lambda _task, _batch, shots, *_: shots), \
             patch.object(self.domain, '_review_edit', side_effect=lambda current, _batch: current.update(status='planned')):
            review_confirmed_candidate(self.domain, state, candidate)
        self.assertEqual(['S0', 'S1', 'S2', 'S3'],
                         [shot['segment_id'] for shot in candidate['shots']])
        self.assertEqual('文' * 45, candidate['narration'])
        self.assertNotIn('_voice_capacity_retry', candidate)

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
        state['settings']['strict_visual_review'] = True
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
        state['settings']['strict_visual_review'] = True
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
        state['settings']['strict_visual_review'] = True
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

    def test_short_user_copy_is_rejected_before_paid_mapping(self):
        state = self.domain._load(self.batch['batch_id'])
        state['settings']['minimum_duration_seconds'] = 30
        self.domain._initialize_speech_budget(state)
        candidate = {**state['script_options'][0], '_draft_only': True, '_user_supplied': True,
                     'narration': '这是一段很短的文案。', 'phrases': []}
        with patch.object(self.domain, '_cloud', side_effect=AssertionError('No paid mapping')) as cloud:
            with self.assertRaises(ContentEngineError) as error:
                review_confirmed_candidate(self.domain, state, candidate)
        self.assertEqual('narrated_duration_too_short', error.exception.code)
        cloud.assert_not_called()

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

    def test_slow_voice_splits_approved_copy_to_fit_three_typical_shots(self):
        state = self.domain._load(self.batch['batch_id'])
        state['_story_planning_version'] = 2
        state['_speech_budget'] = {'capacity_ms_per_char': 307.0}
        state['available_shots'] = [
            {'target_duration_ms': 5000} for _ in range(12)
        ]
        narration = '现场演示，' * 12 + '继续核对。'
        units = confirmed_narration_units(self.domain, state, narration)
        self.assertEqual(narration, ''.join(unit['text'] for unit in units))
        self.assertGreater(len(units), 1)
        self.assertTrue(all(unit['required_ms'] <= 15000 for unit in units))

    def test_existing_voice_budget_reserves_a_fourth_shot_for_long_phrase(self):
        state = self.domain._load(self.batch['batch_id'])
        state['_story_planning_version'] = 2
        state['_speech_budget'] = {'version': 1, 'capacity_ms_per_char': 283.4}
        # The observed voice took 15.8 seconds for this length; three 5-second
        # shots passed the old estimate but failed after paid TTS completed.
        self.assertGreater(self.domain._phrase_budget_ms(state, '文' * 45), 15_000)

    def test_slow_voice_mapping_keeps_neighbouring_shots_beyond_stale_draft_estimate(self):
        state = self.domain._load(self.batch['batch_id'])
        state['_story_planning_version'] = 2
        state['_speech_budget'] = {'capacity_ms_per_char': 307.0}
        state['available_shots'] = [
            {'segment_id': f'S{number}', 'asset_id': f'asset-{number // 10}',
             'source_start_ms': number % 10 * 5000,
             'source_end_ms': (number % 10 + 1) * 5000,
             'target_duration_ms': 5000, 'description': ''}
            for number in range(39)
        ]
        candidate = {'narration': '文' * 267, 'estimated_duration_ms': 45245, 'shots': []}
        with patch.object(self.domain, '_source_evidence_for', return_value={}):
            selected = related_shots(self.domain, state, candidate)
        self.assertEqual(39, len(selected))

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
                state['settings']['strict_visual_review'] = True
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
                state['settings']['strict_visual_review'] = True
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
        state['settings']['strict_visual_review'] = True
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
        state['material_context'] = '往期培训'
        with patch.object(self.domain, '_source_evidence_for', return_value={}):
            result = self.domain._repack_duration_candidate(raw, state, state['available_shots'], allow_same_activity_cuts=True)
        self.assertEqual(raw['phrases'], result['phrases'])

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
        phrases = [{'text': '现场结合真机了解部署，再核对地图、网络和路线。',
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
        phrases = [{'text': '现场讲解了设备部件、联网和设置。', 'shot_ids': ['S0']},
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

    def test_capacity_fill_uses_explicit_material_context_when_cached_provenance_is_missing(self):
        state = self.domain._load(self.batch['batch_id'])
        state['material_context'] = '已确认的同场培训'
        state['available_shots'] = [
            {'segment_id': 'A1', 'asset_id': 'source-a', 'source_start_ms': 0,
             'source_end_ms': 5000, 'target_duration_ms': 5000},
            {'segment_id': 'B1', 'asset_id': 'source-b', 'source_start_ms': 0,
             'source_end_ms': 5000, 'target_duration_ms': 5000},
        ]
        phrases = [{'text': '同一培训现场的长段说明。', 'shot_ids': ['A1']}]
        with patch.object(self.domain, '_source_evidence_for', return_value={}), \
             patch.object(self.domain, '_phrase_budget_ms', return_value=9000):
            completed, _ = complete_mapping_capacity(self.domain, state, phrases)
        self.assertEqual(['A1', 'B1'], completed[0]['shot_ids'])

    def test_capacity_fallback_moves_whole_unit_instead_of_mixing_unverified_sources(self):
        state = self.domain._load(self.batch['batch_id'])
        state['available_shots'] = [
            {'segment_id': f'A{number}', 'asset_id': 'a', 'source_start_ms': number * 5000,
             'source_end_ms': (number + 1) * 5000, 'target_duration_ms': 5000}
            for number in range(2)] + [
            {'segment_id': f'B{number}', 'asset_id': 'b', 'source_start_ms': number * 5000,
             'source_end_ms': (number + 1) * 5000, 'target_duration_ms': 5000}
            for number in range(4)]
        units = [{'unit_id': 'U1', 'text': '第一段。'}, {'unit_id': 'U2', 'text': '第二段。'}]
        assignments = [{'unit_ids': ['U1'], 'shot_ids': ['A0', 'A1']},
                       {'unit_ids': ['U2'], 'shot_ids': ['A0', 'A1']}]
        short_ids = {shot['segment_id']: shot for shot in state['available_shots']}
        with patch.object(self.domain, '_phrase_budget_ms', return_value=9000):
            repaired = remap_units_with_source_capacity(self.domain, state, units, assignments, short_ids)
        self.assertEqual(''.join(unit['text'] for unit in units), ''.join(row['text'] for row in repaired))
        self.assertEqual([['A0', 'A1'], ['B0', 'B1']], [row['shot_ids'] for row in repaired])
        self.assertEqual(len({ref for row in repaired for ref in row['shot_ids']}), 4)

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


    # CE3: the default follow-script mode. Each test counts the paid and reviewing entry points.
    def footage(self, state, durations=(6000, 6000, 6000)):
        """Distinct visual windows on the fixture assets, as a current analysis yields them."""
        base = {key: value for key, value in state['available_shots'][0].items()
                if key not in {'fact_id', 'visual_facts', 'description'}} if state.get('available_shots') else {}
        ids = list(dict.fromkeys(asset for group in ('opening', 'middle', 'ending') for asset in state['groups'][group]))
        shots = []
        for asset in ids:
            cursor = 0
            for number, duration in enumerate(durations):
                ref = f'shot_{asset[-6:]}_{number:02d}'
                shots.append({**base, 'segment_id': ref, 'evidence_ref': ref, 'source_evidence_ref': ref,
                              'asset_id': asset, 'source_start_ms': cursor, 'source_end_ms': cursor + duration,
                              'target_duration_ms': duration, 'content_signature': f'sig-{asset}-{number}',
                              'description': '', 'visual_facts': {}, 'evidence_scope': 'not_observed'})
                cursor += duration
        state['available_shots'] = shots
        profile = self.domain.d._auto_mix_v2_analysis_profile()
        state['_snapshots'] = self.domain.d._auto_mix_asset_snapshots(ids)
        state['_versions'] = {asset: self.domain.d.analyzer.analysis_version_for(self.domain.d._asset_row(asset), profile)
                              for asset in ids}
        state['_analysis_provider'] = self.domain.d.analyzer.capability['provider']
        return shots

    @contextlib.contextmanager
    def paid_calls(self, allow=()):
        """Doubles for every paid or reviewing entry point; the test asserts none ran."""
        names = ('_cloud', '_ground_shots', '_review', '_review_edit', '_grounded_claim_review', '_visual_review', '_plan')
        with contextlib.ExitStack() as stack:
            mocks = {name: stack.enter_context(patch.object(NarratedBatchDomain, name,
                         side_effect=ContentEngineError('test_paid_call', name))) for name in names if name not in allow}
            mocks['_analyze_asset'] = stack.enter_context(patch.object(
                self.s.creative_domain, '_analyze_asset', side_effect=AssertionError('no media analysis')))
            if 'provider' not in allow:
                mocks['provider'] = stack.enter_context(patch.object(
                    self.domain.d.analyzer.cloud_client, '_structured_completion',
                    side_effect=AssertionError('no provider request')))
            yield mocks

    def draft_options(self, state):
        """Confirmable drafts as preparation leaves them: copy only, shots still to be arranged."""
        self.footage(state)
        for option in state['script_options']:
            option.update(status='needs_review', _draft_only=True, phrases=[])
        self.domain._store(state)
        self.options = state['script_options']

    def provided_batch(self, narration):
        saved = self.s.save_narrated_batch({'groups': {'middle': self.fixture.ids}, 'title': '学员招募',
            'target_count': 1, 'brief_version': 1, 'script_source': 'provided', 'target_audience': '清洁设备渠道商',
            'expression': narration, 'settings': {'workflow_version': 2}})
        self.s.run_creative_task(self.s.prepare_narrated_scripts(saved['batch_id'])['task_id'])
        state = self.domain._load(saved['batch_id'])
        # Like the 2026-10-01 batch: the materials were analysed by the earlier attempt.
        self.footage(state)
        self.domain._store(state)
        return state

    def test_provided_copy_with_unseen_claims_reaches_render_without_any_paid_call(self):
        state = self.provided_batch(PROVIDED_COPY)
        option = state['script_options'][0]
        self.assertTrue(option['_user_supplied'])
        progress, rendered = [], []
        original_activity = NarratedBatchDomain._activity
        def activity(domain, batch, message, *args, **kwargs):
            original_activity(domain, batch, message, *args, **kwargs)
            progress.append((message, batch['activity'].get('overall_percent')))
        def render(domain, task_id, batch, candidate, index, total):
            domain._verify_confirmed_script(batch, candidate)
            domain._create_run(task_id, batch, candidate)  # pins the recipe locally; voice is not part of this test
            rendered.append(copy.deepcopy(candidate))
            candidate.update(status='completed', generated_video_id=f'fake-{index}')
        with self.paid_calls() as mocks, \
             patch.object(NarratedBatchDomain, '_activity', autospec=True, side_effect=activity), \
             patch.object(NarratedBatchDomain, '_render_candidate', render):
            task = self.s.confirm_narrated_script({'batch_id': state['batch_id'], 'selections': [
                {'script_id': option['candidate_id'], 'revision': option['revision'], 'count': 1}]})
            self.s.run_creative_task(task['task_id'])
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, f'{name} must not run in the default mode')
        result = self.domain._load(state['batch_id'])
        self.assertEqual('completed', result['status'], result.get('reasons'))
        self.assertEqual('completed', result['production_jobs'][0]['status'])
        candidate = rendered[0]
        self.assertEqual(PROVIDED_COPY, candidate['narration'])
        self.assertEqual(PROVIDED_COPY, candidate['_confirmed_script']['narration'])
        self.assertEqual(re.sub(r'\s+', '', PROVIDED_COPY), re.sub(r'\s+', '', ''.join(
            phrase['text'] for phrase in candidate['_tracks']['spoken_phrases'])))
        for claim in ('已经办了4期', '20-25款', '学不会每月免费复训'):
            self.assertIn(claim, ''.join(phrase['text'] for phrase in candidate['phrases']))
        self.assertEqual(('planned', 2, 'follow_script'),
                         (candidate['status'], candidate['review_version'], candidate['review_mode']))
        rank = {asset: number for number, asset in enumerate(result['groups']['middle'])}
        positions = [(rank[shot['asset_id']], shot['source_start_ms']) for shot in candidate['shots']]
        self.assertEqual(sorted(set(positions)), positions, 'material order, then source time, each shot once')
        refs = [shot['segment_id'] for shot in candidate['shots']]
        self.assertEqual(refs, [shot['segment_id'] for shot in follow_script_footage(result) if shot['segment_id'] in refs])
        by_id = {shot['segment_id']: shot for shot in candidate['shots']}
        for phrase in candidate['phrases']:
            self.assertGreaterEqual(sum(by_id[ref]['target_duration_ms'] for ref in phrase['shot_ids']),
                                    self.domain._phrase_budget_ms(result, phrase['text']))
        self.assertEqual(set(self.fixture.ids), {shot['asset_id'] for shot in candidate['shots']},
                         'surplus footage is spread over every material')
        self.assertIn(('正在按文案顺序安排镜头', 45), progress)
        self.assertIn(('已按文案顺序安排镜头', 60), progress)
        # The same shots as a published work refuse neither the arrangement nor the voiced timeline.
        again = {**copy.deepcopy(result['candidates'][0]), 'status': 'needs_review'}
        with patch.object(NarratedBatchDomain, '_history', return_value=[candidate['shots']]):
            review_confirmed_candidate(self.domain, result, again)
            self.assertEqual(refs, [shot['segment_id'] for shot in again['shots']])
            identity = {'narrated_batch_id': state['batch_id'], 'narrated_candidate_id': candidate['candidate_id']}
            self.domain.validate_actual_timeline(identity, {'selected_segments': candidate['shots']})
            result['candidates'][0].pop('review_mode')
            self.domain._store(result)
            with self.assertRaises(ContentEngineError) as duplicate:
                self.domain.validate_actual_timeline(identity, {'selected_segments': candidate['shots']})
        self.assertEqual('narrated_duplicate', duplicate.exception.code, 'reviewed works keep the repeat check')

    def test_strict_mode_still_reviews_and_refuses_the_same_copy(self):
        for strict in (True, False):
            with self.subTest(strict=strict):
                state = self.domain._load(self.batch['batch_id'])
                self.footage(state)
                # The arrangement the earlier attempt already had; strict mode reviews it.
                candidate = follow_script_candidate(self.domain, state, PROVIDED_COPY, '学员招募', {})
                for key in ('review_mode', 'review_version', 'review_reason'):
                    candidate.pop(key)
                candidate.update(status='needs_review', narration=PROVIDED_COPY, _user_supplied=True,
                                 _confirmed_script={'narration': PROVIDED_COPY})
                state['settings']['strict_visual_review'] = strict
                state['candidates'] = [candidate]
                grounded, reviewed = [], []
                def ground(task_id, batch, shots, *_args):
                    grounded.append(len(shots))
                    return [{**shot, 'fact_id': f"fact-{shot['segment_id']}"} for shot in shots]
                def claim_review(candidates, batch, audit=None):
                    reviewed.append(re.sub(r'\s+', '', candidates[0]['narration']))
                    audit['rejections'].append({'stage': 'claim_review', 'candidate_id': candidates[0]['candidate_id'],
                                                'reason': '缺少画面证据：已办4期'})
                    return []
                def remap(payload, instruction, **kwargs):
                    self.assertEqual(PROVIDED_COPY, payload['confirmed_narration'])
                    raise ContentEngineError('narrated_edit_rejected', '缺少画面证据：已办4期')
                with patch.object(self.domain, '_ground_shots', side_effect=ground), \
                     patch.object(self.domain, '_grounded_claim_review', side_effect=claim_review), \
                     patch.object(self.domain, '_cloud', side_effect=remap) as cloud:
                    if strict:
                        with self.assertRaises(ContentEngineError) as refused:
                            review_confirmed_candidate(self.domain, state, candidate)
                        self.assertEqual('narrated_edit_rejected', refused.exception.code)
                        self.assertIn('已办4期', refused.exception.message)
                        self.assertEqual(1, len(grounded))
                        self.assertEqual([re.sub(r'\s+', '', PROVIDED_COPY)], reviewed)
                        self.assertEqual(1, cloud.call_count, 'the strict path keeps its paid remapping')
                    else:
                        review_confirmed_candidate(self.domain, state, candidate)
                        self.assertEqual(([], [], 0), (grounded, reviewed, cloud.call_count))
                        self.assertEqual(('planned', 'follow_script'), (candidate['status'], candidate['review_mode']))
                        self.assertEqual(PROVIDED_COPY, candidate['narration'])

    def test_surplus_footage_spreads_in_order_and_shortage_stops_before_paid_work(self):
        state = self.domain._load(self.batch['batch_id'])
        shots = self.footage(state)
        narration = '先说第一件事。再说第二件事。最后说第三件事。'
        phrases = follow_script_phrases(self.domain, state, narration)
        refs = [ref for phrase in phrases for ref in phrase['shot_ids']]
        order = [shot['segment_id'] for shot in shots]
        self.assertEqual(sorted(refs, key=order.index), refs)
        assets = [next(shot['asset_id'] for shot in shots if shot['segment_id'] == ref) for ref in refs]
        self.assertEqual(self.fixture.ids[0], assets[0])
        self.assertEqual(self.fixture.ids[-1], assets[-1], 'not only the start of the first material')
        self.assertGreaterEqual(len(set(assets)), 3)
        self.assertEqual(narration, ''.join(phrase['text'] for phrase in phrases))
        # Uneven windows: a paragraph may run past where the next one would start; no shot is reused.
        uneven = {'groups': {'middle': ['a']}, 'available_shots': [
            {'segment_id': f's{number}', 'asset_id': 'a', 'source_start_ms': start, 'source_end_ms': start + duration,
             'target_duration_ms': duration, 'content_signature': f'k{number}'}
            for number, (start, duration) in enumerate(zip((0, 3000, 6000, 7000, 12000, 15000, 23000),
                                                           (3000, 3000, 1000, 5000, 3000, 8000, 5000)))]}
        with patch.object(self.domain, '_phrase_budget_ms', side_effect=lambda batch, text: len(text.strip()) * 1000), \
             patch.object(self.domain, '_max_narration_chars', return_value=80):
            groups = [phrase['shot_ids'] for phrase in follow_script_phrases(self.domain, uneven, '甲甲甲甲甲。甲甲。甲甲。甲。')]
        self.assertEqual([['s0', 's1'], ['s3'], ['s5'], ['s6']], groups)
        # Shortage: two short windows. The job waits for the user before any voice or model call.
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        state['available_shots'] = state['available_shots'][:1] + state['available_shots'][3:4]
        state['script_options'][0]['narration'] = '这段口播比两个镜头长得多，需要更多素材才能配完，' * 3 + '请补充。'
        self.domain._store(state)
        self.options = state['script_options']
        with self.paid_calls() as mocks:
            result = self.run_selection(self.request(first_count=1))
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, name)
        self.assertEqual('needs_attention', result['status'])
        self.assertIn('素材总时长不够配完这段口播', result['reasons'][0])
        self.assertIn('请补充素材或缩短文案', result['reasons'][0])
        self.assertEqual(('queued', 'narrated_insufficient_unique_footage'),
                         (result['production_jobs'][0]['status'], result['production_jobs'][0]['error_code']))
        self.assertFalse(any(kind == 'render' for kind, _ in self.events))

    def test_default_mode_lets_one_paragraph_continue_into_the_next_material(self):
        state = self.domain._load(self.batch['batch_id'])
        self.footage(state, durations=(3000,))
        text = '这一段口播需要跨两个素材才够长。'
        phrases = follow_script_phrases(self.domain, state, text)
        self.assertEqual(1, len(phrases))
        assets = {shot['asset_id'] for shot in state['available_shots'] if shot['segment_id'] in phrases[0]['shot_ids']}
        self.assertEqual(2, len(assets))
        candidate = follow_script_candidate(self.domain, state, text, '跨素材', {})
        self.assertEqual(phrases[0]['shot_ids'], [shot['segment_id'] for shot in candidate['shots']])
        with patch.object(self.domain, '_source_evidence_for', return_value={}), self.assertRaises(ContentEngineError) as strict:
            self.domain._repack_duration_candidate({'title': '跨素材', 'phrases': phrases}, state,
                                                   state['available_shots'], allow_same_activity_cuts=True)
        self.assertEqual('narrated_mapping_invalid', strict.exception.code, 'the strict mapping keeps one activity per paragraph')

    def test_continue_reruns_confirmed_copy_skipped_by_the_visual_review(self):
        for code in ('narrated_edit_rejected', 'narrated_facts_invalid'):
            with self.subTest(code=code):
                state = self.domain._load(self.batch['batch_id'])
                narrated_production.clear_selection(state)
                state.update(script_confirmation=None, candidates=[], status='scripts_ready')
                self.draft_options(state)
                task = self.s.confirm_narrated_script(self.request(first_count=1))
                # What the earlier build left: the confirmed script skipped by the visual review.
                old = self.domain._load(self.batch['batch_id'])
                first = old['candidates'][0]
                first.update(status='failed', error_code=code, error='缺少画面证据')
                old['production_jobs'][0].update(status='skipped', error_code=code, error='缺少画面证据')
                old['production_jobs'][1]['status'] = 'completed'
                old['status'] = 'completed_with_errors'
                self.domain._store(old)
                self.domain.db.execute("UPDATE content_tasks SET status='completed' WHERE id=?", (task['task_id'],))
                self.assertTrue(self.domain.get(self.batch['batch_id'])['production_retry_available'])
                strict = copy.deepcopy(old)
                strict['settings']['strict_visual_review'] = True
                self.assertEqual(code == 'narrated_edit_rejected', bool(retryable_planning_jobs(strict)),
                                 'strict mode keeps the earlier retry rules')
                for blocked in ({'_run_id': 'already-voiced'}, {'status': 'outcome_unknown'},
                                {'error_code': 'cloud_request_outcome_unknown'}):
                    probe = copy.deepcopy(old)
                    probe['candidates'][0].update(blocked)
                    self.assertEqual([], retryable_planning_jobs(probe), blocked)
                self.assertEqual([], retryable_planning_jobs({**copy.deepcopy(old), '_planning_inflight': 'pending'}))
                self.events.clear()
                with self.paid_calls() as mocks:
                    continued = self.s.continue_narrated_batch(self.batch['batch_id'])
                    self.s.run_creative_task(continued['task_id'])
                for name, mock in mocks.items():
                    self.assertEqual(0, mock.call_count, name)
                result = self.domain._load(self.batch['batch_id'])
                self.assertEqual('completed', result['status'], result.get('reasons'))
                self.assertEqual([('render', first['candidate_id'])], self.events)
                self.assertEqual(self.options[0]['narration'], result['candidates'][0]['narration'])
                self.assertEqual('follow_script', result['candidates'][0]['review_mode'])

    def test_ai_draft_confirmed_unchanged_takes_the_follow_script_path(self):
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        self.assertFalse(any(option.get('_user_supplied') for option in self.options))
        with self.paid_calls() as mocks:
            result = self.run_selection(self.request(first_count=1))
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, name)
        self.assertEqual('completed', result['status'], result.get('reasons'))
        for option in self.options[:2]:
            candidate = next(c for c in result['candidates'] if c['candidate_id'] == option['candidate_id'])
            self.assertEqual(option['narration'], candidate['narration'])
            self.assertEqual('follow_script', candidate['review_mode'])

    def test_strict_setting_is_boolean_defaults_off_and_unconfirms_when_changed(self):
        state = self.domain._load(self.batch['batch_id'])
        self.assertNotIn('strict_visual_review', state['settings'])
        self.assertFalse(strict_visual_review(state))
        for value in ('yes', 1, None, 'true'):
            with self.subTest(value=value), self.assertRaises(ContentEngineError) as error:
                self.s.save_narrated_batch({'batch_id': self.batch['batch_id'],
                                            'settings': {'workflow_version': 2, 'strict_visual_review': value}})
            self.assertEqual('invalid_narrated_settings', error.exception.code)
        self.strict()
        self.assertTrue(strict_visual_review(self.domain._load(self.batch['batch_id'])))
        self.assertIs(True, self.s.get_narrated_batch(self.batch['batch_id'])['settings']['strict_visual_review'])
        task = self.s.confirm_narrated_script(self.request(first_count=1))
        self.domain.db.execute("UPDATE content_tasks SET status='completed' WHERE id=?", (task['task_id'],))
        self.assertTrue(self.domain._load(self.batch['batch_id'])['script_confirmation'])
        changed = self.s.save_narrated_batch({'batch_id': self.batch['batch_id'],
                                              'settings': {'workflow_version': 2, 'strict_visual_review': False}})
        self.assertIsNone(changed['script_confirmation'])
        self.assertEqual('scripts_ready', changed['status'])

    def variation_completion(self, responses, calls):
        """The provider double: up to three attempts inside one request, as _structured_completion makes."""
        def completion(**kwargs):
            calls.append(kwargs.get('operation_label'))
            payload = json.loads(kwargs['messages'][-1]['content'])
            self.assertIn('source_narration', payload)
            self.assertIn('数字', kwargs['messages'][0]['content'])
            issue = None
            for _ in range(3):
                response = next(responses)
                if isinstance(response, Exception):
                    raise response
                issue = kwargs['validation_error'](response)
                if issue is None:
                    return response
            raise ContentEngineError(kwargs['parse_code'], f"{kwargs['parse_message']}：{issue}")
        return completion

    def test_variations_are_one_text_rewrite_each_without_visual_review(self):
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        source = self.options[0]['narration']
        self.assertEqual('我想了解第1个问题。', source)
        responses = iter([
            {'title': '换个开头', 'narration': '第1个问题我想弄懂，' * 4},         # too long, rewritten in the same request
            {'title': '换个开头', 'narration': '第1个问题我很想弄懂！'},
            {'title': '再换一种', 'narration': source},                             # the confirmed copy again
            {'title': '再换一种', 'narration': '第1个问题，怎么弄懂？' * 3},         # too long
            {'title': '再换一种', 'narration': ''},
        ])
        calls, rendered = [], []
        def render(domain, task_id, batch, candidate, index, total):
            domain._verify_confirmed_script(batch, candidate)
            domain._create_run(task_id, batch, candidate)
            rendered.append(candidate['candidate_id'])
            candidate.update(status='completed', generated_video_id=f'fake-{index}')
        cloud = self.domain.d.analyzer.cloud_client
        with self.paid_calls(allow=('_cloud', 'provider')) as mocks, \
             patch.object(NarratedBatchDomain, '_render_candidate', render), \
             patch('content_engine.narrated_brief.review', side_effect=AssertionError('no copy review')) as brief_review, \
             patch.object(cloud, '_structured_completion', side_effect=self.variation_completion(responses, calls)):
            result = self.run_selection({'batch_id': self.batch['batch_id'], 'selections': [
                {'script_id': self.options[0]['candidate_id'], 'revision': self.options[0]['revision'], 'count': 3}]})
        self.assertEqual(['文案改写', '文案改写'], calls, 'exactly one text request per variation')
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, name)
        brief_review.assert_not_called()
        self.assertEqual(['completed', 'completed', 'skipped'], [job['status'] for job in result['production_jobs']])
        self.assertEqual('completed_with_errors', result['status'])
        self.assertEqual('narrated_variation_invalid', result['production_jobs'][2]['error_code'])
        self.assertIn('AI 改写未通过格式检查', result['production_jobs'][2]['error'])
        confirmed, variation = result['candidates']
        self.assertEqual(rendered, [confirmed['candidate_id'], variation['candidate_id']])
        self.assertEqual(source, confirmed['narration'])
        self.assertEqual('第1个问题我很想弄懂！', variation['narration'])
        self.assertEqual(('follow_script', self.options[0]['candidate_id'], 2),
                         (variation['review_mode'], variation['source_script_id'], variation['production_index']))
        self.assertNotEqual(confirmed['shots'][0]['segment_id'], variation['shots'][0]['segment_id'], 'staggered start')
        self.assertNotIn('_planning_inflight', self.domain._load(self.batch['batch_id']))

    def test_unknown_variation_rewrite_is_not_sent_again(self):
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        calls = []
        unknown = ContentEngineError('cloud_request_outcome_unknown', '云端结果未知')
        cloud = self.domain.d.analyzer.cloud_client
        with patch.object(cloud, '_structured_completion', side_effect=self.variation_completion(iter([unknown]), calls)):
            result = self.run_selection({'batch_id': self.batch['batch_id'], 'selections': [
                {'script_id': self.options[0]['candidate_id'], 'revision': self.options[0]['revision'], 'count': 2}]})
            self.assertEqual(['文案改写'], calls)
            self.assertEqual('outcome_unknown', result['status'])
            self.assertEqual(['completed', 'outcome_unknown'], [job['status'] for job in result['production_jobs']])
            with self.assertRaises(ContentEngineError) as error:
                self.s.continue_narrated_batch(self.batch['batch_id'])
            self.assertEqual('narrated_planning_outcome_unknown', error.exception.code)
        self.assertEqual(['文案改写'], calls, 'an unknown rewrite is never sent again automatically')

    def test_default_draft_preparation_keeps_drafts_for_the_user_to_confirm(self):
        state = self.domain._load(self.batch['batch_id'])
        state['script_options'] = []
        script = {'title': '准备提问', 'audience': '学员', 'pain_point': '不知道问什么', 'angle': '准备提问',
                  'narration': '参加活动之前可以整理疑问，已办4期的老学员都这么做。', 'source_ids': ['S1']}
        calls = []
        def cloud(payload, instruction, **kwargs):
            calls.append(kwargs.get('purpose'))
            result = {'scripts': [script]}
            self.assertIsNone(kwargs['validation_error'](result))
            return result
        with patch.object(self.domain, '_cloud', side_effect=cloud):
            narrated_script_drafts.prepare(self.domain, state['task_id'], state)
        self.assertEqual(['文案生成'], calls, 'no fact review drops a draft in the default mode')
        self.assertEqual([script['narration']], [option['narration'] for option in state['script_options']])
        self.assertIsNone(state['script_options'][0]['_draft_review'])

    def test_single_confirmation_path_also_follows_the_script_by_default(self):
        state = self.domain._load(self.batch['batch_id'])
        self.footage(state)
        option = state['script_options'][0]
        option['status'] = 'needs_review'  # an edited draft that still has its earlier arrangement
        self.domain._store(state)
        with self.paid_calls() as mocks:
            task = self.s.confirm_narrated_script({'batch_id': self.batch['batch_id'],
                                                   'script_id': option['candidate_id'], 'revision': option['revision']})
            self.s.run_creative_task(task['task_id'])
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, name)
        result = self.domain._load(self.batch['batch_id'])
        self.assertNotIn('production_jobs', result)
        self.assertEqual([('render', option['candidate_id'])], self.events)
        self.assertEqual('follow_script', result['candidates'][0]['review_mode'])

    def test_default_analysis_skips_representative_frames_but_strict_keeps_them(self):
        for strict in (False, True):
            with self.subTest(strict=strict):
                state = self.provided_batch(PROVIDED_COPY)
                state['settings']['strict_visual_review'] = strict
                state['available_shots'] = []
                grounded = []
                def ground(task_id, batch, shots, *_args):
                    grounded.append(len(shots))
                    return shots
                with patch.object(NarratedBatchDomain, '_ground_shots', side_effect=ground), \
                     patch.object(self.s.creative_domain, '_analyze_asset', side_effect=AssertionError('cached analysis')):
                    self.assertTrue(self.domain._refresh_provider_analysis(state['task_id'], state))
                self.assertTrue(state['available_shots'])
                if strict:
                    self.assertEqual(1, len(grounded), 'strict drafts still look at representative frames')
                else:
                    self.assertEqual([], grounded)
                    self.assertTrue(all(shot['evidence_scope'] == 'not_observed' for shot in state['available_shots']))

    # CE3 round 4: arrangement across materials, staggering, retries and the rewrite request.
    def test_every_material_contributes_with_the_app_speech_budget(self):
        """The 2026-10-01 batch's frozen 245.8 ms/char budget: a short file between long ones is not skipped."""
        for lengths in ({'A': 80, 'B': 80, 'C': 10, 'D': 80, 'E': 80}, {'A': 60, 'B': 12, 'C': 60, 'D': 12, 'E': 60}):
            with self.subTest(lengths=lengths):
                shots = [{'segment_id': f'{asset}{second:02d}', 'asset_id': asset, 'source_start_ms': second * 1000,
                          'source_end_ms': (second + 4) * 1000, 'target_duration_ms': 4000, 'content_signature': f'{asset}{second}'}
                         for asset, length in lengths.items() for second in range(0, length, 4)]
                batch = {'groups': {'middle': list(lengths)}, 'available_shots': shots, '_story_planning_version': 2,
                         '_speech_budget': {'version': 2, 'capacity_ms_per_char': 245.8, 'fast_ms_per_char': 170}}
                phrases = follow_script_phrases(self.domain, batch, '我们的培训班已经办了四期，学员反馈都很好。' * 5)
                refs = [ref for phrase in phrases for ref in phrase['shot_ids']]
                order = [shot['segment_id'] for shot in shots]
                self.assertEqual(sorted(refs, key=order.index), refs, 'material order, then source time')
                self.assertEqual(len(set(refs)), len(refs), 'each shot once')
                self.assertEqual(list(lengths), list(dict.fromkeys(ref[0] for ref in refs)), 'every material, in order')
                by_id = {shot['segment_id']: shot for shot in shots}
                for phrase in phrases:
                    self.assertGreaterEqual(sum(by_id[ref]['target_duration_ms'] for ref in phrase['shot_ids']),
                                            self.domain._phrase_budget_ms(batch, phrase['text']))
        # Fewer paragraphs than materials: the materials are picked evenly, first and last included.
        self.assertEqual([1, 0, 1, 0, 1], narrated_production.material_paragraph_counts([80, 80, 10, 80, 80], 3))
        self.assertEqual([1, 1, 1, 1, 1], narrated_production.material_paragraph_counts([80, 80, 10, 80, 80], 5))
        self.assertEqual([3, 3, 1, 2, 2], narrated_production.material_paragraph_counts([80, 80, 10, 80, 80], 11))
        self.assertEqual([1], narrated_production.material_paragraph_counts([30], 1))

    def test_spread_over_forty_shots_falls_back_to_tight_packing(self):
        """Spreading into a run of one-second windows needs too many shots; the tight layout still fits."""
        shots = [{'segment_id': f's{number}', 'asset_id': 'a', 'source_start_ms': start, 'source_end_ms': start + length,
                  'target_duration_ms': length, 'content_signature': f'k{number}'}
                 for number, (start, length) in enumerate([(index * 10000, 10000) for index in range(40)]
                                                          + [(400000 + index * 1000, 1000) for index in range(200)])]
        batch = {'groups': {'middle': ['a']}, 'available_shots': shots}
        with patch.object(self.domain, '_phrase_budget_ms', side_effect=lambda batch, text: len(text.strip()) * 1000), \
             patch.object(self.domain, '_max_narration_chars', return_value=80):
            phrases = follow_script_phrases(self.domain, batch, '甲甲甲甲甲甲甲甲甲。' * 35)
        refs = [ref for phrase in phrases for ref in phrase['shot_ids']]
        self.assertEqual([f's{number}' for number in range(35)], refs, 'the tight layout, not narrated_copy_too_long')
        # 21 paragraphs of two long shots each need 42 shots even packed tight.
        with patch.object(self.domain, '_phrase_budget_ms', side_effect=lambda batch, text: len(text.strip()) * 1000), \
             patch.object(self.domain, '_max_narration_chars', return_value=80), \
             self.assertRaises(ContentEngineError) as too_long:
            follow_script_phrases(self.domain, batch, ('甲' * 14 + '。') * 21)
        self.assertEqual('narrated_copy_too_long', too_long.exception.code)

    def test_works_of_one_batch_start_at_different_places(self):
        """Two directions with the same words no longer get the same shots; offsets are per position."""
        self.assertEqual([0, 0.25, 0.5], [narrated_production.stagger_offset({'production_jobs': [{}, {}, {}]}, index) for index in (1, 2, 3)])
        self.assertEqual(0, narrated_production.stagger_offset({}, 1))
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        for option in state['script_options'][:2]:
            option['narration'] = '先说第一件事。再说第二件事。最后说第三件事。'
        self.domain._store(state)
        self.options = state['script_options']
        with self.paid_calls() as mocks:
            result = self.run_selection(self.request(first_count=1))
        for name, mock in mocks.items():
            self.assertEqual(0, mock.call_count, name)
        self.assertEqual(['completed', 'completed'], [job['status'] for job in result['production_jobs']])
        first, second = (next(c for c in result['candidates'] if c['candidate_id'] == option['candidate_id']) for option in self.options[:2])
        self.assertEqual(first['narration'], second['narration'])
        self.assertNotEqual([s['segment_id'] for s in first['shots']], [s['segment_id'] for s in second['shots']])
        self.assertEqual(state['available_shots'][0]['segment_id'], first['shots'][0]['segment_id'], 'the first work still opens the first material')
        # Staggering never refuses a confirmed copy: with a single layout both still render.
        tiny = self.domain._load(self.batch['batch_id'])
        tiny['available_shots'] = tiny['available_shots'][:2]
        candidate = follow_script_candidate(self.domain, tiny, '一句话。', '短', {}, offset=0.5)
        self.assertEqual(1, len(candidate['shots']))

    def test_rewrite_request_lists_only_recent_openers(self):
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        selected = {'script_id': self.options[0]['candidate_id'], 'title': self.options[0]['title'],
                    'narration': self.options[0]['narration'], 'direction': {'angle': self.options[0]['angle']}}
        texts = [f'第{number}条改写的开头是这句话。' + '接着讲设备怎么用、怎么保养，' * 6 + '再加一句收尾。' for number in range(1, 8)]
        for number, text in enumerate(texts, 2):
            state['candidates'].append({'candidate_id': f'narrated_candidate_old{number}', 'title': f'旧稿{number}', 'narration': text,
                                        'source_script_id': selected['script_id'], 'production_index': number, 'shots': [], 'status': 'completed'})
        self.domain._store(state)
        requests = []
        def cloud(payload, instruction, **kwargs):
            requests.append(copy.deepcopy(payload))
            self.assertIsNotNone(kwargs['validation_error']({'title': '再来', 'narration': texts[0]}),
                                 'all earlier variations still take part in the local similarity check')
            return {'title': '换个说法', 'narration': '第1个问题我很想弄懂！'}
        with patch.object(self.domain, '_cloud', side_effect=cloud):
            narrated_production.rewrite_variation(self.domain, state, selected)
        listed = requests[0]['existing_variations']
        self.assertEqual(5, len(listed), 'only the last five earlier variations are described')
        self.assertEqual([f'旧稿{number}' for number in range(4, 9)], [item['title'] for item in listed])
        for item in listed:
            self.assertEqual({'title', 'opening'}, set(item))
            self.assertLessEqual(len(item['opening']), 60)
            self.assertNotIn('再加一句收尾', item['opening'], 'an opener, not the full text')
        self.assertNotIn(texts[-1], json.dumps(requests[0], ensure_ascii=False))

    def test_continue_rearranges_an_old_variation_by_script_in_default_mode(self):
        """A variation planned by an earlier build (no review_mode) is retried without the paid visual review."""
        for strict in (False, True):
            with self.subTest(strict=strict):
                state = self.domain._load(self.batch['batch_id'])
                narrated_production.clear_selection(state)
                state.update(script_confirmation=None, candidates=[], status='scripts_ready')
                self.draft_options(state)
                if strict:
                    self.strict()
                task = self.s.confirm_narrated_script({'batch_id': self.batch['batch_id'], 'selections': [
                    {'script_id': self.options[0]['candidate_id'], 'revision': self.options[0]['revision'], 'count': 2}]})
                old = self.domain._load(self.batch['batch_id'])
                first = old['candidates'][0]
                first.update(status='completed', generated_video_id='fake-old')
                old['production_jobs'][0]['status'] = 'completed'
                variation = copy.deepcopy(first)
                for key in ('_confirmed_script', 'generated_video_id', 'review_mode', '_run_id', '_draft_only'):
                    variation.pop(key, None)
                shots = old['available_shots']
                variation.update(candidate_id='narrated_candidate_' + 'f' * 32, title='旧版变体', narration='我想了解第1个问题，旧版改写。',
                                 production_index=2, status='failed', error_code='narrated_edit_rejected', error='缺少画面证据',
                                 shots=[shots[4], shots[5]], phrases=[{'text': '我想了解第1个问题，旧版改写。', 'shot_ids': [shots[4]['segment_id'], shots[5]['segment_id']]}])
                old['candidates'].append(variation)
                old['production_jobs'][1].update(status='skipped', candidate_id=variation['candidate_id'],
                                                 error_code='narrated_edit_rejected', error='缺少画面证据')
                old['status'] = 'completed_with_errors'
                self.domain._store(old)
                self.domain.db.execute("UPDATE content_tasks SET status='completed' WHERE id=?", (task['task_id'],))
                self.assertEqual(1, len(retryable_planning_jobs(old)))
                self.events.clear()
                with self.paid_calls() as mocks:
                    continued = self.s.continue_narrated_batch(self.batch['batch_id'])
                    self.s.run_creative_task(continued['task_id'])
                result = self.domain._load(self.batch['batch_id'])
                job = result['production_jobs'][1]
                if strict:
                    self.assertEqual(1, mocks['_ground_shots'].call_count, 'strict mode keeps the visual review for the old variation')
                    self.assertEqual('skipped', job['status'])
                    continue
                for name, mock in mocks.items():
                    self.assertEqual(0, mock.call_count, f'{name} must not run for a retried variation in the default mode')
                self.assertEqual(('completed', None), (job['status'], job.get('error_code')))
                self.assertEqual([('render', variation['candidate_id'])], self.events)
                retried = result['candidates'][1]
                self.assertEqual(('我想了解第1个问题，旧版改写。', 'follow_script', 'completed'),
                                 (retried['narration'], retried['review_mode'], retried['status']))
                self.assertTrue(retried['shots'])

    def test_footage_pool_keeps_each_visual_window_once_without_overlap(self):
        def shot(ref, start, end, signature, **extra):
            return {'segment_id': ref, 'asset_id': 'a', 'source_start_ms': start, 'source_end_ms': end,
                    'target_duration_ms': end - start, 'content_signature': signature, **extra}
        batch = {'groups': {'middle': ['a']}, 'available_shots': [
            shot('crop', 6000, 9000, 'X'),          # a finer crop of the same window: not new footage
            shot('first', 0, 6000, 'X'),
            shot('third', 12000, 18000, 'Y'),
            shot('overlap', 15000, 21000, 'Z'),     # overlaps the third window
            shot('fourth', 18000, 24000, 'W'),      # adjacent is fine
            shot('unusable', 24000, 30000, 'V', usable=False),
            shot('empty', 30000, 30000, 'U')]}
        self.assertEqual(['first', 'third', 'fourth'], [item['segment_id'] for item in follow_script_footage(batch)])

    def test_voice_overflow_retry_arranges_with_headroom(self):
        state = self.domain._load(self.batch['batch_id'])
        self.footage(state)
        text = '第一句。第二句。'
        candidate = {'candidate_id': 'narrated_candidate_retry', 'revision': 1, 'title': '重排', 'narration': text,
                     '_confirmed_script': {'narration': text}, 'status': 'needs_review', '_voice_capacity_retry': True,
                     'audience': '', 'pain_point': '', 'angle': '', 'production_index': 1}
        state['candidates'] = [candidate]
        with patch.object(NarratedBatchDomain, '_phrase_budget_ms', lambda domain, batch, text: 5500):
            narrated_production.arrange_follow_script(self.domain, state, candidate)
            by_id = {shot['segment_id']: shot for shot in candidate['shots']}
            for phrase in candidate['phrases']:
                self.assertGreaterEqual(sum(by_id[ref]['target_duration_ms'] for ref in phrase['shot_ids']), 6600,
                                        'a measured overflow reserves 1.2x the budget')
            self.assertNotIn('_voice_capacity_retry', candidate)
            plain = follow_script_phrases(self.domain, state, text)
        self.assertEqual([1, 1], [len(phrase['shot_ids']) for phrase in plain], 'without the overflow one window suffices')

    def test_variation_capacity_is_checked_inside_the_rewrite_request(self):
        """An overlong rewrite is corrected in the same request, not queued as needs_attention after the paid call."""
        state = self.domain._load(self.batch['batch_id'])
        self.draft_options(state)
        self.footage(state, durations=(5000, 5000))
        state['available_shots'] = state['available_shots'][:2]   # ten seconds: exactly the confirmed copy
        self.domain._store(state)
        source = self.options[0]['narration']
        self.assertEqual(10, len(source))
        responses = iter([{'title': '换个开头', 'narration': '第1个问题我想弄懂吗？'},   # 11 chars: too long for the footage
                          {'title': '换个开头', 'narration': '第1个问题怎么弄懂？'}])
        calls, rendered = [], []
        def render(domain, task_id, batch, candidate, index, total):
            domain._verify_confirmed_script(batch, candidate)
            rendered.append(candidate['narration'])
            candidate.update(status='completed', generated_video_id=f'fake-{index}')
        cloud = self.domain.d.analyzer.cloud_client
        with self.paid_calls(allow=('_cloud', 'provider')), \
             patch.object(NarratedBatchDomain, '_phrase_budget_ms', lambda domain, batch, text: len(text.strip()) * 1000), \
             patch.object(NarratedBatchDomain, '_render_candidate', render), \
             patch.object(cloud, '_structured_completion', side_effect=self.variation_completion(responses, calls)):
            result = self.run_selection({'batch_id': self.batch['batch_id'], 'selections': [
                {'script_id': self.options[0]['candidate_id'], 'revision': self.options[0]['revision'], 'count': 2}]})
        self.assertEqual(['文案改写'], calls)
        self.assertEqual(['completed', 'completed'], [job['status'] for job in result['production_jobs']], result.get('reasons'))
        self.assertEqual([source, '第1个问题怎么弄懂？'], rendered)

    def test_variation_avoids_published_sequences_before_any_voice_request(self):
        state = self.domain._load(self.batch['batch_id'])
        shots = self.footage(state)
        text = '先说第一件事。再说第二件事。'
        plain = follow_script_phrases(self.domain, state, text, offset=0.25)
        published = [[shot for shot in shots if shot['segment_id'] in phrase['shot_ids']] for phrase in plain]
        published = [shot for group in published for shot in group]
        other = follow_script_phrases(self.domain, state, text, history=[published], offset=0.25)
        self.assertNotEqual([p['shot_ids'] for p in plain], [p['shot_ids'] for p in other], 'another layout is chosen')
        self.assertEqual(text, ''.join(p['text'] for p in other))
        tiny = {**state, 'available_shots': shots[:2]}
        only = follow_script_phrases(self.domain, tiny, '一句话。')
        with self.assertRaises(ContentEngineError) as refused:
            follow_script_phrases(self.domain, tiny, '一句话。', history=[[shots[0]]])
        self.assertEqual(('narrated_duplicate', [[shots[0]['segment_id']]]), (refused.exception.code, [p['shot_ids'] for p in only]))
        # End to end: the published work's shots are known before the rewrite is voiced.
        self.draft_options(state)
        responses = iter([{'title': '换个开头', 'narration': '第1个问题我很想弄懂！'}])
        calls, rendered = [], []
        def render(domain, task_id, batch, candidate, index, total):
            domain._verify_confirmed_script(batch, candidate)
            rendered.append([shot['segment_id'] for shot in candidate['shots']])
            candidate.update(status='completed', generated_video_id=f'fake-{index}')
        cloud = self.domain.d.analyzer.cloud_client
        first = follow_script_phrases(self.domain, state, '第1个问题我很想弄懂！', offset=narrated_production.stagger_offset({'production_jobs': [{}, {}]}, 2))
        history = [[shot for shot in shots if shot['segment_id'] in phrase['shot_ids']] for phrase in first]
        with self.paid_calls(allow=('_cloud', 'provider')), patch.object(NarratedBatchDomain, '_render_candidate', render), \
             patch.object(NarratedBatchDomain, '_history', return_value=[[shot for group in history for shot in group]]), \
             patch.object(cloud, '_structured_completion', side_effect=self.variation_completion(responses, calls)):
            result = self.run_selection({'batch_id': self.batch['batch_id'], 'selections': [
                {'script_id': self.options[0]['candidate_id'], 'revision': self.options[0]['revision'], 'count': 2}]})
        self.assertEqual(['completed', 'completed'], [job['status'] for job in result['production_jobs']], result.get('reasons'))
        self.assertNotEqual([ref for phrase in first for ref in phrase['shot_ids']], rendered[1])

    def test_visual_review_errors_retry_only_the_confirmed_copy(self):
        confirmed = {'candidate_id': 'c1', '_confirmed_script': {'narration': '确认稿'}, 'status': 'failed'}
        variation = {'candidate_id': 'c2', 'status': 'failed'}
        jobs = [{'candidate_id': 'c1', 'status': 'skipped', 'error_code': 'narrated_facts_invalid', 'production_index': 1},
                {'candidate_id': 'c2', 'status': 'skipped', 'error_code': 'narrated_facts_invalid', 'production_index': 2}]
        batch = {'settings': {'workflow_version': 2}, 'candidates': [confirmed, variation], 'production_jobs': jobs}
        self.assertEqual([jobs[0]], retryable_planning_jobs(batch))
        self.assertEqual([], retryable_planning_jobs({**batch, 'settings': {'workflow_version': 2, 'strict_visual_review': True}}))
        mapping = [{**job, 'error_code': 'narrated_edit_rejected'} for job in jobs]
        self.assertEqual(mapping, retryable_planning_jobs({**batch, 'production_jobs': mapping}), 'mapping errors retry either')

if __name__ == '__main__':
    unittest.main()
