import unittest
from content_engine.narration_alignment import align_narration, reference_caption_cues, spoken_key, rebind_sentence_copy, sentence_shot_budgets


class ObservedSpanTests(unittest.TestCase):
    def test_small_edit_keeps_scene_binding_and_cuts_at_observed_word(self):
        old = '大厅里的落叶、机器旁的棉絮。'
        new = old.replace('落叶','杂物')
        sentences = [{'text':'大厅里的落叶、','shot_ids':['hall']},{'text':'机器旁的棉絮。','shot_ids':['factory']}]
        rebound = rebind_sentence_copy(old,new,sentences)
        self.assertEqual(['hall'],rebound[0]['shot_ids'])
        self.assertEqual(new,''.join(x['text'] for x in rebound))
        phrase={'sentenceBindings':[{'text':x['text'],'evidenceRefs':x['shot_ids']} for x in rebound]}
        audio={'duration_ms':2500,'verification':{'alignment':{'matched':True,'words':[
            {'text':rebound[0]['text'],'start_ms':100,'end_ms':700},
            {'text':rebound[1]['text'],'start_ms':900,'end_ms':2400}]}}}
        self.assertEqual([900,1760],sentence_shot_budgets(phrase,audio,[{'evidence_ref':'hall','target_duration_ms':5000},{'evidence_ref':'factory','target_duration_ms':5000}],160))

    def test_local_asr_omission_keeps_copy_and_observed_clause_edges(self):
        text = '如果让我说清洁工作最头疼的地方，过一会儿又得回来。每天都在忙，却总觉得事情没有真正做完。'
        recognized = text.replace('会儿', '会')
        chars = spoken_key(recognized)
        words = [{'text': c, 'begin_time': i*100, 'end_time': (i+1)*100} for i,c in enumerate(chars)]
        segments = [{'transcript': recognized, 'start_ms': 0, 'end_ms': len(chars)*100, 'metadata': {'words':words}}]
        alignment = align_narration(text, segments, len(chars)*100)
        self.assertEqual('asr_spans', alignment['source'])
        self.assertEqual([], alignment['words'])
        cues = reference_caption_cues([{'text':text,'alignment':alignment}])
        self.assertEqual(text, ''.join(c['text'] for c in cues))
        self.assertTrue(all(c['start_ms'] in {w['begin_time'] for w in words} and c['end_ms'] in {w['end_time'] for w in words} for c in cues))
        segments[0]['metadata']['words'][3]['begin_time'] = 0
        self.assertEqual('phrase', align_narration(text, segments, len(chars)*100)['source'])

    def test_missing_boundary_is_not_interpolated(self):
        text = '如果让我说清洁工作最头疼的地方，过一会儿。每天都在忙，却总觉得事情没有真正做完。'
        recognized = text.replace('会儿', '会')
        chars = spoken_key(recognized)
        words = [{'text':c,'begin_time':i*100,'end_time':(i+1)*100} for i,c in enumerate(chars)]
        result = align_narration(text,[{'transcript':recognized,'start_ms':0,'end_ms':len(chars)*100,'metadata':{'words':words}}],len(chars)*100)
        self.assertEqual('phrase',result['source'])
