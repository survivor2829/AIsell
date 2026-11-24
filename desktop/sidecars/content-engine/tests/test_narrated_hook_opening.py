import unittest

from content_engine.narrated_production import lead_with_hook


def shot(segment_id, start, said='', asset='a1', tags=('室内', '清洁设备')):
    return {'segment_id': segment_id, 'asset_id': asset, 'media_kind': 'video', 'source_start_ms': start,
            'source_end_ms': start + 4000, 'verifiable_text': said, 'tags': list(tags), 'quality_score': .7}


class HookOpeningTest(unittest.TestCase):
    def setUp(self):
        self.pool = [shot('walk', 0, '啊？这是录啥呢？'), shot('s2', 4000, '机器往前走。'), shot('s3', 8000, '倒退再吸一下。'),
                     shot('pain', 12000, '然后那个订单就没成。'), shot('pain2', 0, '水痕特别多，订单就没成。', asset='a2'),
                     shot('s6', 16000, '清洁设备演示。')]
        self.phrases = [{'text': '水痕特别多，订单就没成——现场有人这么说。', 'shot_ids': ['walk']},
                        {'text': '我们看看怎么调吸水阀。', 'shot_ids': ['s2', 's3']}]

    def test_opens_on_the_shot_that_says_the_first_sentence(self):
        out = lead_with_hook(self.phrases, self.pool)
        self.assertEqual('pain2', out[0]['shot_ids'][0])
        self.assertEqual(['walk'], out[0]['shot_ids'][1:], 'the planned footage stays')
        self.assertEqual(self.phrases[1], out[1])

    def test_each_work_of_the_batch_opens_on_its_own_shot(self):
        out = lead_with_hook(self.phrases, self.pool, [self.pool[4]])
        self.assertEqual('pain', out[0]['shot_ids'][0])

    def test_a_shared_topic_word_is_not_a_hook(self):
        phrases = [{'text': '清洁设备怎么选？', 'shot_ids': ['walk']}] + self.phrases[1:]
        self.assertEqual(phrases, lead_with_hook(phrases, self.pool))

    def test_never_reuses_a_placed_window(self):
        phrases = [dict(self.phrases[0], shot_ids=['walk', 'pain2'])] + self.phrases[1:]
        out = lead_with_hook(phrases, self.pool)
        self.assertEqual('pain', out[0]['shot_ids'][0])
        self.assertEqual(1, sum(shot_id == 'pain2' for p in out for shot_id in p['shot_ids']))


if __name__ == '__main__':
    unittest.main()
