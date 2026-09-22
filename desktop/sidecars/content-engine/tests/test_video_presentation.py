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


if __name__ == "__main__":
    unittest.main()
