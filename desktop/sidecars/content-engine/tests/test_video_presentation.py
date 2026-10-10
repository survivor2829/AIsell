import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

from content_engine.creative_domain import CreativeDomain
from content_engine.creative_render import HybridCreativeRenderer
from content_engine.narration_alignment import reference_caption_cues
from content_engine.video_presentation import presentation, validate_headlines
from content_engine.errors import ContentEngineError
from content_engine.database import Database


class VideoPresentationTests(unittest.TestCase):
    def test_persisted_course_words_keep_measured_times_in_reference_packaging(self):
        captions = [{"text": "先看现场，再做判断。", "start_ms": 1000, "end_ms": 2800,
                     "words": [{"text": text, "start": start, "end": end, "confidence": None}
                               for text, start, end in [('先看', 1000, 1400), ('现场', 1400, 1800),
                                                        ('再做', 1900, 2300), ('判断', 2400, 2800)]]}]
        recipe = {"captions": captions, "voice_segment": {"start_ms": 1000, "end_ms": 2800},
                  "caption_presentation": "reference_narration", "presentation": presentation(captions, '现场判断'),
                  "packaging": {}}
        cues = HybridCreativeRenderer._public_props(recipe, {})['captions']
        self.assertEqual(captions[0]['text'], ''.join(cue['text'] for cue in cues))
        self.assertEqual([(0, 400), (400, 800), (900, 1300), (1400, 1800)],
                         [(word['startMs'], word['endMs']) for cue in cues for word in cue['words']])
        self.assertNotIn('start_ms', captions[0]['words'][0])
        props = HybridCreativeRenderer._public_props(recipe, {})
        self.assertEqual((0, 1800), (props['presentation']['points'][0]['startMs'],
                                    props['presentation']['points'][0]['endMs']))
        self.assertEqual(1000, recipe['presentation']['points'][0]['startMs'])

    def test_narration_opener_uses_complete_quoted_heading(self):
        title = '有人问：「学完了觉得没用怎么办」——这问题我每期都答，今天再答一遍。'
        self.assertEqual('学完了觉得没用怎么办', presentation([], title)['topic'])
        unbroken = '产品功能和适用环境需要结合实际现场条件以及完整产品资料进行判断'
        self.assertEqual(unbroken, presentation([], unbroken)['topic'])

    def test_sentence_page_preserves_every_observed_word_and_time(self):
        words = [{"text": text, "start_ms": index * 200, "end_ms": (index + 1) * 200}
                 for index, text in enumerate(['清洁', '机器人', '现场', '培训', '需要', '结合', '实际', '场景'])]
        text = ''.join(word['text'] for word in words)
        recipe = {"voice_segment": {"end_ms": 1600}, "caption_presentation": "reference_narration",
                  "presentation": presentation([], '现场培训'), "packaging": {},
                  "captions": [{"text": text, "start_ms": 0, "end_ms": 1600,
                                "alignment": {"source": "asr_words", "words": words}}]}
        cues = HybridCreativeRenderer._public_props(recipe, {})['captions']
        self.assertEqual(len(cues), 1)
        self.assertEqual(text, ''.join(cue['text'] for cue in cues))
        self.assertEqual([(w['text'], w['start_ms'], w['end_ms']) for w in words],
                         [(w['text'], w['startMs'], w['endMs']) for cue in cues for w in cue['words']])

    def test_observed_words_survive_grouping_and_remotion_manifest(self):
        words = [{"text": "看清", "start_ms": 100, "end_ms": 400}, {"text": "细节。", "start_ms": 450, "end_ms": 950}]
        captions = [{"text": "看清细节。", "start_ms": 100, "end_ms": 950,
                     "alignment": {"source": "asr_words", "words": words}}]
        cues = reference_caption_cues(captions)
        self.assertEqual(words, cues[0]["words"])
        recipe = {"voice_segment": {"end_ms": 1000}, "captions": captions, "caption_presentation": "reference_narration",
                  "presentation": presentation(captions, "看清细节"), "packaging": {}}
        props = HybridCreativeRenderer._public_props(recipe, {})
        self.assertEqual(1, len(props["captions"]))
        self.assertEqual(450, props["captions"][0]["words"][1]["startMs"])
        self.assertEqual("topic_fixed", props["presentation"]["templateId"])
        recipe.pop("presentation")
        self.assertNotIn("words", HybridCreativeRenderer._public_props(recipe, {})["captions"][0])

    def test_phrase_timing_paginates_long_sentences_without_inventing_word_times(self):
        text = '我们已经办了4期了，这次第5期，课程新增了机器人二开定制化服务；'
        pages = reference_caption_cues([{'text': text, 'start_ms': 100, 'end_ms': 6500}],
                                       sentence_pages=True)
        self.assertEqual(len(pages), 2)
        self.assertEqual(text, ''.join(page['text'] for page in pages))
        self.assertEqual((100, 6500), (pages[0]['start_ms'], pages[-1]['end_ms']))
        self.assertTrue(all(page['timing_source'] == 'audio_measured_proportional' and 'words' not in page for page in pages))

    def test_long_opener_uses_semantic_pages_with_original_word_times(self):
        parts = ["干清洁设备这行久一点的老板，应该都吃过这种亏——",
                 "一个项目跟了半年，临到成交，",
                 "被一句「这个品牌本地已经有人备案了」给卡死，"]
        text = "".join(parts)
        words = [{"text": char, "start_ms": index * 180, "end_ms": index * 180 + 120}
                 for index, char in enumerate(text)]
        caption = {"text": text, "start_ms": 0, "end_ms": len(text) * 180,
                   "alignment": {"source": "asr_words", "words": words}}
        pages = reference_caption_cues([caption], sentence_pages=True)
        self.assertEqual(parts, [p["text"] for p in pages])
        self.assertEqual(words, [w for p in pages for w in p["words"]])
        self.assertEqual([p["start_ms"] for p in pages[1:]], [p["end_ms"] for p in pages[:-1]])
        internal_short_clause = "这个项目已经经过多次现场沟通并且马上就要进入合同签订阶段，好，我们还需要继续跟进客户的现场需求以及采购计划才能完成交付，"
        no_flash = reference_caption_cues([{"text": internal_short_clause, "start_ms": 0, "end_ms": 9000}], sentence_pages=True)
        self.assertEqual(internal_short_clause, "".join(p["text"] for p in no_flash))
        self.assertTrue(all(len(p["text"]) > 3 for p in no_flash))


    def test_sentence_pages_split_at_full_stop_not_comma(self):
        words = [{"text": text, "start_ms": index * 600, "end_ms": (index + 1) * 600}
                 for index, text in enumerate(["先看现场，", "再做判断。", "需要时，", "回来复训。"])]
        text = "".join(word["text"] for word in words)
        for alignment in ({"source": "asr_words", "words": words}, {}):
            cues = reference_caption_cues([{"text": text, "start_ms": 0, "end_ms": 2400,
                                            "alignment": alignment}], sentence_pages=True)
            self.assertEqual(["先看现场，再做判断。", "需要时，回来复训。"], [c["text"] for c in cues])
            self.assertEqual((0, 2400), (cues[0]["start_ms"], cues[-1]["end_ms"]))

    def test_unpunctuated_long_copy_paginates_without_changing_text_or_word_times(self):
        tokens = ['选择', '清洁机器人', '需要', '结合', '实际', '场地', '条件', '仔细', '判断'] * 3
        text = ''.join(tokens)
        words = [{'text': token, 'start_ms': index * 500, 'end_ms': (index + 1) * 500}
                 for index, token in enumerate(tokens)]
        for alignment in ({'source': 'asr_words', 'words': words}, {}):
            pages = reference_caption_cues([{'text': text, 'start_ms': 0, 'end_ms': len(words) * 500,
                                            'alignment': alignment}], sentence_pages=True)
            self.assertEqual(text, ''.join(page['text'] for page in pages))
            self.assertTrue(all(3 < len(page['text']) <= 42 for page in pages))
            if alignment:
                self.assertEqual(words, [word for page in pages for word in page['words']])
            else:
                self.assertTrue(all(page['timing_source'] == 'audio_measured_proportional' for page in pages))

    def test_outline_uses_observed_sentence_boundaries(self):
        captions = [{"text": "先看外观。再看细节。", "start_ms": 0, "end_ms": 3000, "alignment": {"sentences": [
            {"text": "先看外观。", "start_ms": 100, "end_ms": 1200}, {"text": "再看细节。", "start_ms": 1700, "end_ms": 2800}]}}]
        result = presentation(captions, "看清产品", "key_points")
        self.assertEqual([100, 1700], [point["startMs"] for point in result["points"]])
        self.assertEqual(["先看外观", "再看细节"], [point["text"] for point in result["points"]])

    def test_title_only_edit_composes_saved_background_without_provider(self):
        with tempfile.TemporaryDirectory() as root:
            background, target = Path(root) / "background.png", Path(root) / "cover.jpg"
            background.write_bytes(b"test")
            row = {"id": "generated_video_" + "a" * 32, "status": "completed", "thumbnail_path": str(target),
                   "recipe_json": json.dumps({"packaging": {"cover": {"background_path": str(background), "plan": {}}}})}
            calls = []
            fake = SimpleNamespace(_generated_row=lambda _: row, _validate_generated_path=lambda value: Path(value),
                renderer=SimpleNamespace(compose_cover=lambda *args, **kwargs: calls.append(args)),
                connection=SimpleNamespace(execute=lambda *args: None), _resolve_asset_path=None,
                _json=json.dumps, _now=lambda: "now", _public_generated=lambda value: value)
            CreativeDomain.update_cover_title(fake, row["id"], ["先看细节", "再做选择"])
            self.assertEqual(background, calls[0][0])
            self.assertEqual(["先看细节", "再做选择"], calls[0][2]["cover"]["plan"]["headline_lines"])
            self.assertTrue(background.is_file())

    def test_rejects_overlong_cover_headline(self):
        with self.assertRaises(ContentEngineError):
            validate_headlines(["这是一个超过十二个字符的封面标题"])

    def test_import_without_music_registers_video_even_when_cover_is_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source.mp4"
            source.write_bytes(b"isolated-video-fixture")
            database = Database(root / "engine").open()
            def render(**request):
                self.assertNotIn("imported_music_path", request["recipe"])
                target = request["output_dir"]
                target.mkdir(parents=True)
                (target / "video.mp4").write_bytes(source.read_bytes())
                (target / "cover.jpg").write_bytes(b"local-cover")
                return {"video_path": target / "video.mp4", "thumbnail_path": target / "cover.jpg"}
            cloud = SimpleNamespace(configured=True, transcribe=lambda *_args: [
                {"transcript": "看清细节。", "start_ms": 100, "end_ms": 2800,
                 "metadata": {"words": [{"text": "看清", "begin_time": 100, "end_time": 1000},
                                          {"text": "细节", "begin_time": 1100, "end_time": 2800}]}}])
            analyzer = SimpleNamespace(cloud_client=cloud, ffmpeg_path="fake", _command=lambda *_args: None)
            renderer = SimpleNamespace(_probe_rendered_media=lambda _: {"duration_ms": 3000}, render=render)
            try:
                with mock.patch.object(CreativeDomain, "_sync_configured_voice_persona"):
                    domain = CreativeDomain(database, new_id=lambda prefix: prefix + "_" + uuid.uuid4().hex,
                        now=lambda: "2026-09-22T12:00:00Z", analyzer=analyzer, renderer=renderer,
                        cover_client=SimpleNamespace(configured=False))
                task = domain.import_base_video({"source_id": "digital_human_" + uuid.uuid4().hex,
                    "input_video_path": str(source), "title": "看清细节", "confirmed_script": "看清细节。",
                    "template_id": "topic_fixed", "cover_mode": "apimart"})
                result = domain.run_task(task["task_id"])
                self.assertEqual("completed", result["status"], result)
                self.assertTrue(result["generated_video_id"].startswith("generated_video_"))
                self.assertEqual(1, database.connection.execute("SELECT count(*) FROM finished_videos").fetchone()[0])
                self.assertEqual("completed", database.connection.execute("SELECT status FROM generated_videos").fetchone()[0])
                cover_task = database.connection.execute("SELECT status,error_code FROM content_tasks WHERE task_type='creative_cover'").fetchone()
                self.assertNotEqual("completed", cover_task["status"])
                self.assertEqual("apimart_not_configured", cover_task["error_code"])
            finally:
                database.close()

    def test_prepared_transcript_reuses_paid_result_and_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / "source.mp4"
            source.write_bytes(b"frozen-video-fixture")
            database = Database(root / "engine").open()
            def render(**request):
                target = request["output_dir"]
                target.mkdir(parents=True)
                (target / "video.mp4").write_bytes(source.read_bytes())
                (target / "cover.jpg").write_bytes(b"local-cover")
                return {"video_path": target / "video.mp4", "thumbnail_path": target / "cover.jpg"}
            analyzer = SimpleNamespace(cloud_client=None, ffmpeg_path="not-needed",
                _command=lambda *_args: self.fail("Prepared speech must not be transcribed again"))
            renderer = SimpleNamespace(_probe_rendered_media=lambda _: {"duration_ms": 3000}, render=render)
            try:
                with mock.patch.object(CreativeDomain, "_sync_configured_voice_persona"):
                    domain = CreativeDomain(database, new_id=lambda prefix: prefix + "_" + uuid.uuid4().hex,
                        now=lambda: "2026-10-08T12:00:00Z", analyzer=analyzer, renderer=renderer,
                        cover_client=SimpleNamespace(configured=False))
                request = {"source_id": "digital_human_" + uuid.uuid4().hex, "input_video_path": str(source),
                    "title": "看清细节", "confirmed_script": "看清细节。", "cover_mode": "local_frame",
                    "prepared_transcript": {"source_sha256": domain._sha256_file(source), "time_unit": "ms",
                        "utterances": [{"text": "看清细节。", "start_time": 100, "end_time": 2800,
                            "words": [{"text": "看清", "start_time": 100, "end_time": 1000},
                                      {"text": "细节", "start_time": 1100, "end_time": 2800}]}]}}
                task = domain.import_base_video(request)
                result = domain.run_task(task["task_id"])
                self.assertEqual("completed", result["status"], result)
                source.write_bytes(b"changed-video")
                with self.assertRaises(ContentEngineError) as caught:
                    domain.import_base_video({**request, "source_id": "digital_human_" + uuid.uuid4().hex})
                self.assertEqual("invalid_video_transcript", caught.exception.code)
            finally:
                database.close()


if __name__ == "__main__":
    unittest.main()
