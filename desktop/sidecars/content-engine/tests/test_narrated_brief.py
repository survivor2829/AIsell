"""Audience brief persistence, selection compatibility and spoken ending contract."""
import copy
import unittest
from unittest.mock import Mock, patch

import test_narrated_batch as fixtures
from content_engine import narrated_brief, narrated_script_drafts
from content_engine.errors import ContentEngineError


class NarratedBriefTests(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.NarratedBatchTests(methodName='runTest')
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        self.domain = fixture.s._narrated_batches()
        self.batch = self.domain.save({'groups': {'middle': fixture.ids}, 'brief_version': 1,
            'target_audience': '物业保洁负责人', 'advantages': '可安排现场试用',
            'customer_pain_points': '担心地面不适用', 'cta': '评论77领取选型表',
            'settings': {'workflow_version': 2}, 'target_count': 1})

    def candidate(self, framework=narrated_brief.FRAMEWORK):
        return {'candidate_id': 'narrated_candidate_test', 'title': '选型前先验证',
            'audience': '物业保洁负责人', 'pain_point': '担心地面不适用', 'angle': '现场试用',
            'framework': framework, 'summary': '用现场试用核对实际需求',
            'narration': '担心设备不适合现场地面？先列出地面种类，再安排现场试用，按实际清洁需求核对，这项试用服务可帮助你做选择。评论77领取选型表。',
            'shots': [], 'phrases': [], 'revision': 1, 'status': 'needs_review'}

    def test_brief_change_invalidates_confirmation_but_preserves_history(self):
        batch = self.domain._load(self.batch['batch_id'])
        batch['script_confirmation'] = {'narration': '原确认稿'}
        batch['script_options'] = [self.candidate()]
        self.domain._store(batch)
        saved = self.domain.save({'batch_id': batch['batch_id'], 'target_audience': '渠道商'})
        self.assertEqual(saved['target_audience'], '渠道商')
        self.assertEqual(saved['advantages'], '可安排现场试用')
        self.assertEqual(saved['settings']['minimum_duration_seconds'], 30)
        self.assertEqual(saved['script_options'], [])
        self.assertIsNone(saved['script_confirmation'])
        self.assertEqual(saved['script_confirmation_history'][-1]['narration'], '原确认稿')
        saved = self.domain.save({'batch_id': batch['batch_id'], 'target_audience': ' '})
        with self.assertRaises(ContentEngineError) as error:
            self.domain.start(saved['batch_id'], 'scripts')
        self.assertEqual(error.exception.code, 'narrated_audience_required')

    def test_expression_keeps_identity_and_clear_does_not_restore_legacy_fields(self):
        self.assertIn('担心地面不适用', narrated_brief.expression(self.batch))
        text = '学员小陈，来自物业保洁班组。素材中的主角是他，想介绍他认识设备部件的过程。'
        saved = self.domain.save({'batch_id': self.batch['batch_id'], 'expression': text})
        self.assertEqual(saved['expression'], text)
        self.assertEqual(saved['advantages'], '')
        self.assertEqual(narrated_brief.context(saved)['expression'], text)
        self.assertNotIn('advantages', narrated_brief.context(saved))
        candidate = self.candidate()
        previous_hash = narrated_brief.stamp(candidate, saved)
        cleared = self.domain.save({'batch_id': saved['batch_id'], 'expression': ''})
        self.assertEqual(narrated_brief.expression(cleared), '')
        self.assertNotEqual(previous_hash, narrated_brief.stamp(candidate, cleared))
        with self.assertRaises(ContentEngineError):
            self.domain.save({'batch_id': saved['batch_id'], 'expression': '长' * 4001})

    def test_new_task_rejects_multi_selection_and_invalid_edit_without_saving(self):
        batch = self.domain._load(self.batch['batch_id'])
        batch['script_options'] = [dict(self.candidate(), candidate_id=f'script-{i}',
            framework=narrated_brief.FRAMEWORK if i == 0 else 'free') for i in range(3)]
        self.domain._store(batch)
        with self.assertRaises(ContentEngineError):
            self.domain.confirm_script({'batch_id': batch['batch_id'], 'selections': [
                {'script_id': f'script-{i}', 'revision': 1, 'count': 1} for i in range(2)]})
        with self.assertRaises(ContentEngineError):
            self.domain.update_candidate({'batch_id': batch['batch_id'], 'candidate_id': 'script-0',
                                          'narration': '只介绍产品。欢迎咨询。'})
        self.assertEqual(self.domain._load(batch['batch_id'])['script_options'], batch['script_options'])

    def test_user_identity_review_requires_quote_and_reuses_only_unchanged_context(self):
        batch = self.domain._load(self.batch['batch_id'])
        batch['expression'] = '素材中的学员是小陈。'
        shot = {'segment_id': 's1', 'fact_id': 'f1', 'source_start_ms': 0, 'source_end_ms': 5000,
                'visual_facts': {'direct_observation': '一位学员在设备旁', 'evidence_class': 'direct_real'}}
        candidate = {'candidate_id': 'c1', 'title': '学员介绍', 'shots': [shot],
                     'phrases': [{'text': '这位学员是小陈。', 'shot_ids': ['s1']}]}
        def cloud(payload, instruction, **kwargs):
            self.assertFalse(kwargs['generation_rules'])
            segment = payload['segment']
            statements = []
            for unit in segment['statements']:
                identity = segment['phrase_id'] != 'title'
                statements.append({'statement_id': unit['statement_id'], 'kind': 'fact' if identity else 'other',
                    'risk_scope': 'user_context' if identity else 'nonassertive', 'supported': True,
                    'evidence': [{'shot_id': 's1', 'fact_id': 'f1', 'source': 'user_context',
                                  'user_quote': '学员是小陈'}] if identity else [], 'reason': '用户明确说明身份'})
            result = {'candidate_id': 'c1', 'segment_key': segment['segment_key'], 'quality_score': 1,
                      'reason': '已核对', 'phrase_review': {'phrase_id': segment['phrase_id'], 'statements': statements}}
            self.assertIsNone(kwargs['validation_error'](result))
            if segment['phrase_id'] != 'title':
                bad = copy.deepcopy(result)
                bad['phrase_review']['statements'][0]['evidence'][0]['user_quote'] = '学员年入百万'
                self.assertIn('user_quote', kwargs['validation_error'](bad))
            kwargs['on_success'](result)
            return result
        with patch.object(self.domain, '_cloud', side_effect=cloud) as calls, \
             patch.object(self.domain, '_claim_frames', side_effect=lambda b, c, s: ([], s['frames'])), \
             patch.object(self.domain.d, '_should_stop', return_value=False):
            self.assertEqual(len(self.domain._grounded_claim_review([candidate], batch)), 1)
            initial = calls.call_count
            self.domain._grounded_claim_review([candidate], batch)
            self.assertEqual(calls.call_count, initial)
            batch['expression'] += '希望介绍他的学习过程。'
            self.domain._grounded_claim_review([candidate], batch)
            self.assertGreater(calls.call_count, initial)

    def test_semantic_review_rejects_empty_solution_and_rechecks_changed_copy(self):
        candidate = self.candidate()
        self.domain._source_evidence_for = Mock(return_value={})
        with patch.object(self.domain, '_cloud', return_value={'accepted': True, 'reason': '有具体办法'}) as cloud:
            narrated_brief.review(self.domain, candidate, self.batch)
            narrated_brief.review(self.domain, candidate, self.batch)
            self.assertEqual(cloud.call_count, 1)
            candidate['narration'] = '设备怎么选？使用我们的产品就行。欢迎咨询。'
            cloud.return_value = {'accepted': False, 'reason': '仅推销产品，没有回答选型办法'}
            with self.assertRaises(ContentEngineError) as error:
                narrated_brief.review(self.domain, candidate, self.batch)
            self.assertIn('没有回答', error.exception.message)
            self.assertEqual(cloud.call_count, 2)
            self.assertIn('物业保洁负责人', str(cloud.call_args.args[0]))

    def test_single_direction_batch_keeps_confirmed_copy_and_framework(self):
        batch = self.domain._load(self.batch['batch_id'])
        batch['script_options'] = [dict(self.candidate(), candidate_id=f'script-{i}',
            framework=narrated_brief.FRAMEWORK if i == 0 else 'free') for i in range(3)]
        self.domain._store(batch)
        with patch.object(self.domain, 'start', return_value={}) as start:
            self.domain.confirm_script({'batch_id': batch['batch_id'],
                'selections': [{'script_id': 'script-0', 'revision': 1, 'count': 2}]})
        saved = self.domain._load(batch['batch_id'])
        self.assertEqual(saved['direction']['framework'], narrated_brief.FRAMEWORK)
        self.assertEqual(saved['candidates'][0]['narration'], self.candidate()['narration'])
        self.assertEqual(saved['production_jobs'][1]['script_id'], 'script-0')
        self.assertEqual(saved['target_count'], 2)
        start.assert_called_once_with(batch['batch_id'], 'confirmed')

    def test_ending_uses_actual_caption_timing_and_mismatch_is_not_silently_rendered(self):
        events = [{'reason': 'cta', 'text': '评论77领取选型表。', 'start_ms': 26000, 'end_ms': 30000}]
        captions = [{'text': '按实际需求核对。', 'start_ms': 24000, 'end_ms': 26500},
                    {'text': '评论77', 'start_ms': 26500, 'end_ms': 28000},
                    {'text': '领取选型表。', 'start_ms': 28000, 'end_ms': 32000}]
        narrated_brief.align_ending_events(events, captions)
        self.assertEqual((events[0]['start_ms'], events[0]['end_ms']), (26500, 32000))
        self.assertEqual(events[0]['reason'], 'narrated_ending_cta')
        with self.assertRaises(ContentEngineError):
            narrated_brief.align_ending_events([{'reason': 'cta', 'text': '评论88领取资料'}], captions)

    def test_draft_retry_retains_two_angles_and_restores_problem_solution_first(self):
        batch = copy.deepcopy(self.batch)
        batch['available_shots'] = [{'description': '现场设备试用', 'target_duration_ms': 60000}]
        domain = self.domain
        scripts = [dict(self.candidate(narrated_brief.FRAMEWORK if i == 0 else 'free'),
            title=f'选题{i}', angle=f'切入点{i}', source_ids=['S1'],
            narration=self.candidate()['narration'] if i == 0 else f'切入点{i}。' + ('现场试用核对地面需求。' if i == 1 else '选购前列出场地任务。') * 5 + '欢迎咨询。') for i in range(3)]
        counts, reviews = [], []
        def cloud(payload, instruction, **kwargs):
            if 'count' in payload:
                counts.append(payload['count'])
                self.assertEqual(payload['creative_brief']['target_audience'], '物业保洁负责人')
                result = {'scripts': scripts if payload['count'] == 3 else [scripts[0]]}
            else:
                reviews.append(True)
                result = {'reviews': [{'index': i, 'accepted': len(reviews) > 1 or i != 0,
                    'unsupported_claims': [], 'reason': '请补充办法依据' if len(reviews) == 1 and i == 0 else '通过'} for i in range(len(payload['scripts']))]}
            self.assertIsNone(kwargs['validation_error'](result))
            return result
        with patch.object(domain, '_initialize_speech_budget'), patch.object(domain, '_minimum_spoken_chars', return_value=10), \
             patch.object(domain, '_source_evidence_for', return_value={}), patch.object(domain, '_cloud', side_effect=cloud), \
             patch.object(domain.d, '_should_stop', return_value=False):
            narrated_script_drafts.prepare(domain, 'test-task', batch)
        self.assertEqual(counts, [3, 1])
        self.assertEqual(len(batch['script_options']), 3)
        self.assertEqual(batch['script_options'][0]['framework'], narrated_brief.FRAMEWORK)

    def test_short_draft_does_not_discard_other_valid_choices(self):
        batch = copy.deepcopy(self.batch)
        batch['available_shots'] = [{'description': '培训现场', 'target_duration_ms': 60000}]
        counts = []
        def cloud(payload, instruction, **kwargs):
            if 'count' in payload:
                counts.append(payload['count'])
                if len(counts) == 1:
                    texts = ['不会用？先核对。欢迎咨询。', '联网设置。' + '对照屏幕了解入口。' * 5 + '欢迎咨询。',
                             '部件名称。' + '对照实物了解部件。' * 5 + '欢迎咨询。']
                else:
                    self.assertEqual(len(payload['existing_choices']), 2)
                    texts = [self.candidate()['narration']]
                scripts = [dict(self.candidate(), title=f'选题{i}', angle=f'角度{i}', narration=text,
                    framework=payload['required_frameworks'][i], source_ids=['S1']) for i, text in enumerate(texts)]
                result = {'scripts': scripts}
            else:
                result = {'reviews': [{'index': i, 'accepted': True, 'unsupported_claims': [], 'reason': '通过'}
                                     for i in range(len(payload['scripts']))]}
            self.assertIsNone(kwargs['validation_error'](result))
            return result
        with patch.object(self.domain, '_initialize_speech_budget'), patch.object(self.domain, '_minimum_spoken_chars', return_value=40), \
             patch.object(self.domain, '_source_evidence_for', return_value={}), patch.object(self.domain, '_cloud', side_effect=cloud), \
             patch.object(self.domain.d, '_should_stop', return_value=False):
            narrated_script_drafts.prepare(self.domain, 'test-task', batch)
        self.assertEqual(counts, [3, 1])
        self.assertEqual(len(batch['script_options']), 3)
        self.assertIn('正文实际', batch['_script_draft_audit'][0]['local_rejections'][0]['reason'])


if __name__ == '__main__':
    unittest.main()
