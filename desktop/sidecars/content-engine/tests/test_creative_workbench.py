from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.database import Database
from content_engine.creative_analysis import (
    ANALYSIS_MANIFEST_NAME,
    DashScopeMediaClient,
    FFmpegCreativeAnalyzer,
)
from content_engine.creative_domain import CreativeDomain
from content_engine.creative_render import FFmpegCreativeRenderer
from content_engine.errors import ContentEngineError
from content_engine.protocol import METHODS
from content_engine.service import ContentEngineService, utc_now


class CreativeRendererRecipeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="xiaoxi-creative-renderer-"))
        self.renderer = FFmpegCreativeRenderer(
            self.root, ffmpeg_path="ffmpeg", ffprobe_path="ffprobe"
        )
        self.encodes = []
        self.renderer._encode_with_fallback = (
            lambda args, output, audio=True: self.encodes.append(
                {"args": list(args), "output": Path(output), "audio": audio}
            )
        )
        self.renderer._command = lambda *args, **kwargs: SimpleNamespace(
            returncode=0, stdout="", stderr=""
        )

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_mix_loops_only_a_bounded_source_clip(self):
        temp_dir = self.root / "render"
        temp_dir.mkdir()
        recipe = {
            "visual_segments": [{
                "asset_id": "asset_visual",
                "media_kind": "video",
                "start_ms": 12_500,
                "end_ms": 17_500,
                "target_duration_ms": 12_000,
            }],
            "voice_segment": {
                "asset_id": "asset_voice", "start_ms": 0, "end_ms": 12_000
            },
        }
        self.renderer._render_mix(
            recipe,
            temp_dir / "output.mp4",
            None,
            temp_dir,
            lambda asset_id: self.root / f"{asset_id}.mp4",
        )

        bounded, looped = self.encodes[:2]
        self.assertIn("12.500", bounded["args"])
        self.assertIn("5.000", bounded["args"])
        self.assertNotIn("-stream_loop", bounded["args"])
        self.assertIn("-stream_loop", looped["args"])
        self.assertIn(str(bounded["output"]), looped["args"])
        self.assertNotIn(str(self.root / "asset_visual.mp4"), looped["args"])
        self.assertIn("12.000", looped["args"])

    def test_course_uses_presentation_layout_only_when_recipe_marks_it(self):
        recipe = {
            "voice_segment": {
                "asset_id": "asset_voice", "start_ms": 30_000, "end_ms": 60_000
            },
            "visual_segments": [{"frame_mode": "slide_with_teacher_pip"}],
        }
        self.renderer._render_course(
            recipe,
            self.root / "course.mp4",
            None,
            lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        args = self.encodes[0]["args"]
        self.assertIn("-filter_complex", args)
        graph = args[args.index("-filter_complex") + 1]
        self.assertIn("[classroom_source]", graph)
        self.assertIn("overlay=", graph)

    def test_course_layout_marker_comes_from_analyzed_shot_evidence(self):
        self.assertEqual(
            "slide_with_teacher_pip",
            CreativeDomain._course_frame_mode({"shot_type": "screen", "tags": []}),
        )
        self.assertEqual(
            "teacher_focus",
            CreativeDomain._course_frame_mode({"shot_type": "teacher", "tags": []}),
        )

    def test_dynamic_caption_style_uses_short_cues_and_explicit_canvas(self):
        recipe = {
            "voice_segment": {"start_ms": 10_000},
            "subtitle_style": {
                "font_size": 42,
                "margin_bottom": 140,
                "max_chars": 12,
            },
        }
        captions = [{
            "start_ms": 10_000,
            "end_ms": 16_000,
            "text": "不是参数越高越好，关键是根据现场选择合适的设备。",
        }]

        cues = self.renderer._caption_cues(captions, recipe)
        self.assertGreater(len(cues), 1)
        self.assertTrue(all(self.renderer._caption_width(item["text"]) <= 12 for item in cues))
        subtitle = self.renderer._write_ass(self.root / "captions.ass", captions, recipe)
        content = subtitle.read_text(encoding="utf-8")
        self.assertIn("PlayResY: 1920", content)
        self.assertIn("Microsoft YaHei,42", content)
        self.assertIn(",140,1", content)
        self.assertIn(r"{\c&H005CDBFF&}不是", content)

    def test_supoclip_recipe_keeps_real_word_timestamps_and_filters_invalid_words(self):
        domain = object.__new__(CreativeDomain)
        window = {
            "start_ms": 10_000,
            "end_ms": 20_000,
            "segments": [{
                "segment_id": "segment-1",
                "asset_id": "asset-1",
                "start_ms": 10_000,
                "end_ms": 20_000,
                "transcript_text": "关键是方法。",
                "speaker": "teacher",
                "media_kind": "video",
                "shot_type": "lecturer",
                "tags": ["培训"],
                "metadata": {
                    "words": [
                        {"text": "关键", "begin_time": 10_100, "end_time": 10_600},
                        {"text": "是", "begin_time": 10_650, "end_time": 10_900, "confidence": 0.93},
                        {"text": "方法", "begin_time": 10_950, "end_time": 11_500, "punctuation": "。"},
                        {"text": "越界", "begin_time": 20_100, "end_time": 20_500},
                        {"text": "非法", "begin_time": 12_000, "end_time": 11_999},
                    ]
                },
            }],
        }

        recipe = domain._course_recipe(
            "asset-1",
            window,
            experiment_mode="supoclip_bailian_v1",
            subtitle_preset="knowledge_course",
        )

        self.assertEqual("supoclip_bailian_v1", recipe["experiment_mode"])
        self.assertEqual("knowledge_course", recipe["subtitle_style"]["preset"])
        self.assertEqual(
            [
                {"text": "关键", "start": 10_100, "end": 10_600, "confidence": None, "speaker": "teacher"},
                {"text": "是", "start": 10_650, "end": 10_900, "confidence": 0.93, "speaker": "teacher"},
                {"text": "方法。", "start": 10_950, "end": 11_500, "confidence": None, "speaker": "teacher"},
            ],
            recipe["captions"][0]["words"],
        )

    def test_standard_course_recipe_remains_dynamic_clean_without_word_payload(self):
        domain = object.__new__(CreativeDomain)
        segment = {
            "segment_id": "segment-1",
            "asset_id": "asset-1",
            "start_ms": 0,
            "end_ms": 10_000,
            "transcript_text": "标准字幕。",
            "speaker": "teacher",
            "media_kind": "video",
            "shot_type": "lecturer",
            "tags": [],
            "metadata": {"words": [{"text": "标准", "begin_time": 10, "end_time": 500}]},
        }

        recipe = domain._course_recipe(
            "asset-1", {"start_ms": 0, "end_ms": 10_000, "segments": [segment]}
        )

        self.assertEqual("dynamic_clean", recipe["subtitle_style"]["preset"])
        self.assertNotIn("experiment_mode", recipe)
        self.assertNotIn("words", recipe["captions"][0])

    def test_supoclip_ass_presets_use_word_timing_but_srt_stays_literal(self):
        captions = [{
            "start_ms": 10_000,
            "end_ms": 12_000,
            "text": "关键方法。",
            "words": [
                {"text": "关键", "start": 10_000, "end": 10_700, "confidence": None, "speaker": "teacher"},
                {"text": "方法。", "start": 10_700, "end": 12_000, "confidence": 0.98, "speaker": "teacher"},
            ],
        }]
        for preset in ("knowledge_course", "energetic_talking"):
            with self.subTest(preset=preset):
                recipe = {
                    "experiment_mode": "supoclip_bailian_v1",
                    "voice_segment": {"start_ms": 10_000},
                    "subtitle_style": {"preset": preset, "font_size": 48, "margin_bottom": 150},
                }
                ass_path = self.renderer._write_ass(self.root / f"{preset}.ass", captions, recipe)
                srt_path = self.renderer._write_srt(self.root / f"{preset}.srt", captions, recipe)
                ass = ass_path.read_text(encoding="utf-8")
                srt = srt_path.read_text(encoding="utf-8")
                self.assertIn(r"{\kf", ass)
                self.assertIn(preset, ass)
                self.assertIn("关键方法。", srt)
                self.assertNotIn("🔥", srt)
                self.assertNotIn("💡", srt)

    def test_supoclip_caption_without_words_falls_back_to_phrase_timing(self):
        captions = [{"start_ms": 0, "end_ms": 2_000, "text": "没有词级时间戳。"}]
        recipe = {
            "experiment_mode": "supoclip_bailian_v1",
            "voice_segment": {"start_ms": 0},
            "subtitle_style": {"preset": "knowledge_course"},
        }
        cues = self.renderer._caption_cues(captions, recipe)
        subtitle = self.renderer._write_ass(self.root / "fallback.ass", captions, recipe)

        self.assertTrue(cues)
        self.assertTrue(all("words" not in cue for cue in cues))
        self.assertNotIn(r"{\kf", subtitle.read_text(encoding="utf-8"))


class DashScopeCourseSelectionTests(unittest.TestCase):
    def test_supoclip_selection_sends_visual_evidence_and_clamps_four_scores(self):
        client = DashScopeMediaClient(api_key="test-key")
        captured = {}

        def request_json(_url, **kwargs):
            captured.update(kwargs["payload"])
            return {
                "choices": [{"message": {"content": json.dumps({
                    "candidates": [{
                        "id": "candidate-1",
                        "hook": 40,
                        "engagement": -3,
                        "value": 18.5,
                        "shareability": 21,
                        "total": 140,
                        "reason": ["开场给出明确问题"],
                    }]
                }, ensure_ascii=False)}}]
            }

        client._request_json = request_json
        result = client.rank_course_candidates(
            [{
                "id": "candidate-1",
                "duration_ms": 45_000,
                "transcript": "如何判断培训设备是否合适？",
                "visual": [{
                    "shot_type": "slide",
                    "tags": ["课件", "老师"],
                    "quality": 0.82,
                    "visual_caption": "老师在屏幕旁讲解参数",
                }],
            }],
            "培训现场价值",
            experiment_mode="supoclip_bailian_v1",
        )

        prompt = captured["messages"][0]["content"]
        self.assertIn("老师在屏幕旁讲解参数", prompt)
        self.assertEqual(25.0, result[0]["hook"])
        self.assertEqual(0.0, result[0]["engagement"])
        self.assertEqual(18.5, result[0]["value"])
        self.assertEqual(21.0, result[0]["shareability"])
        self.assertEqual(100.0, result[0]["total"])


class FakeCreativeAnalyzer:
    def __init__(self, *, version="fixture-v1", only_role=None, on_analyze=None):
        self.version = version
        self.only_role = only_role
        self.on_analyze = on_analyze

    @property
    def capability(self):
        return {"available": True, "cloud_configured": True, "provider": "fixture"}

    def analyze(self, *, asset, source_path, task_id, profile, should_stop):
        del source_path, profile
        if should_stop():
            return {"stopped": True}
        if self.on_analyze:
            self.on_analyze(task_id)
        duration = int(asset["duration_ms"] or 120_000)
        sentences = []
        step = 10_000
        for start in range(0, duration, step):
            end = min(duration, start + step)
            index = start // step
            role = self.only_role or ("hook", "process", "result")[index % 3]
            sentences.append(
                {
                    "start_ms": start,
                    "end_ms": end,
                    "transcript": f"{self.version} 第{index + 1}句培训内容。",
                    "speaker": "speaker-0",
                    "role": role,
                    "shot_type": "lecturer" if index % 2 == 0 else "training",
                    "tags": ["培训", role],
                    "quality_score": 0.82 - (index % 3) * 0.02,
                    "metadata": {"sentence_complete": True},
                }
            )
        return {
            "analysis_version": self.version,
            "provider": "fixture",
            "derivatives": [],
            "segments": sentences,
        }


class FailingCourseRanker(FakeCreativeAnalyzer):
    def rank_course_windows(self, _windows, _theme):
        raise ContentEngineError("cloud_request_failed", "offline")


class SupoClipEvidenceRanker(FakeCreativeAnalyzer):
    def rank_course_windows(self, windows, _theme, *, experiment_mode=None):
        if experiment_mode != "supoclip_bailian_v1":
            raise AssertionError("missing experiment mode")
        return [
            {
                "id": item["signature"],
                "hook": 999,
                "engagement": -4,
                # value, shareability and total intentionally omitted so the
                # domain must derive them from the existing local evidence.
                "reason": ["开场可直接核验"],
            }
            for item in windows
        ]


class EmptySupoClipRanker(FakeCreativeAnalyzer):
    def rank_course_windows(self, _windows, _theme, *, experiment_mode=None):
        if experiment_mode != "supoclip_bailian_v1":
            raise AssertionError("missing experiment mode")
        return []


class FakeCreativeRenderer:
    def __init__(self, *, on_render=None):
        self.on_render = on_render

    @property
    def capability(self):
        return {"available": True, "hardware_encoder": False}

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        source_ids = {
            item["asset_id"]
            for item in recipe.get("visual_segments", [])
            if item.get("asset_id")
        }
        if recipe.get("voice_segment", {}).get("asset_id"):
            source_ids.add(recipe["voice_segment"]["asset_id"])
        for asset_id in source_ids:
            if not Path(resolve_asset_path(asset_id)).is_file():
                raise AssertionError("missing source")
        output_dir.mkdir(parents=True, exist_ok=True)
        video_path = output_dir / f"{video_id}.mp4"
        thumbnail_path = output_dir / f"{video_id}.jpg"
        video_path.write_bytes(b"fixture-video")
        thumbnail_path.write_bytes(b"fixture-thumbnail")
        if self.on_render:
            self.on_render(video_id)
        return {"video_path": video_path, "thumbnail_path": thumbnail_path}


class BlockingCreativeAnalyzer(FakeCreativeAnalyzer):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()

    def analyze(self, *, should_stop, **kwargs):
        self.started.set()
        while not should_stop():
            time.sleep(0.005)
        return {"stopped": True}


class OfflineCloudClient:
    configured = False
    asr_model = "offline-fixture"
    vision_model = "offline-fixture"


class CreativeWorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="xiaoxi-creative-test-"))
        self.data_dir = self.root / "data"
        self.sources = self.root / "sources"
        self.sources.mkdir()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=False,
        )

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _insert_asset(self, name, *, duration_ms=120_000, has_audio=True):
        source = self.sources / name
        source.write_bytes(name.encode("utf-8"))
        ordinal = len(list(self.sources.iterdir()))
        asset_id = f"asset_{ordinal:032x}"
        now = utc_now()
        with self.service.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO assets(
                    id, fingerprint, full_fingerprint, media_kind, extension,
                    size_bytes, display_name, rights_status, created_at, updated_at,
                    probe_status, duration_ms, width, height, fps, has_audio, probed_at
                ) VALUES (?, ?, ?, 'video', '.mp4', ?, ?, 'owned', ?, ?,
                          'ok', ?, 1080, 1920, 30, ?, ?)
                """,
                (
                    asset_id,
                    f"fingerprint-{asset_id}",
                    f"full-{asset_id}",
                    source.stat().st_size,
                    name,
                    now,
                    now,
                    duration_ms,
                    int(has_audio),
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO asset_locations(
                    id, asset_id, absolute_path, size_bytes, modified_ns,
                    is_available, created_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    f"location_{ordinal:032x}",
                    asset_id,
                    str(source),
                    source.stat().st_size,
                    source.stat().st_mtime_ns,
                    now,
                    now,
                ),
            )
        return asset_id

    def _run(self, task_id):
        self.service.run_creative_task(task_id)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            task = next(
                item
                for item in self.service.list_tasks(limit=2_000)["items"]
                if item["task_id"] == task_id
            )
            if task["status"] in {"completed", "failed", "paused", "cancelled"}:
                return task
            time.sleep(0.01)
        self.fail("creative task did not finish")

    def test_analysis_is_idempotent_and_public_segments_never_expose_paths(self):
        asset_id = self._insert_asset("course.mp4")
        first = self.service.analyze_assets([asset_id], {"provider": "bailian"})
        self.assertEqual("completed", self._run(first["task_id"])["status"])
        segments = self.service.list_media_segments(asset_id=asset_id)["items"]
        self.assertEqual(12, len(segments))
        self.assertTrue(all(item["start_ms"] < item["end_ms"] for item in segments))
        self.assertNotIn(str(self.sources), json.dumps(segments, ensure_ascii=False))

        second = self.service.analyze_assets([asset_id], {"provider": "bailian"})
        self.assertEqual("completed", self._run(second["task_id"])["status"])
        repeated = self.service.list_media_segments(asset_id=asset_id)["items"]
        self.assertEqual(
            [item["segment_id"] for item in segments],
            [item["segment_id"] for item in repeated],
        )

    def test_restart_enqueues_a_persisted_queued_creative_task(self):
        asset_id = self._insert_asset("restart-queued.mp4")
        task = self.service.analyze_assets([asset_id])
        self.service.close()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=True,
        )

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            status = next(
                item["status"]
                for item in self.service.list_tasks(limit=2_000)["items"]
                if item["task_id"] == task["task_id"]
            )
            if status == "completed":
                break
            time.sleep(0.01)
        self.assertEqual("completed", status)
        self.assertEqual(
            12, len(self.service.list_media_segments(asset_id=asset_id)["items"])
        )

    def test_shutdown_pauses_active_work_before_releasing_the_database(self):
        asset_id = self._insert_asset("shutdown-active.mp4")
        self.service.close()
        analyzer = BlockingCreativeAnalyzer()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=analyzer,
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=True,
        )
        task = self.service.analyze_assets([asset_id])
        self.assertTrue(analyzer.started.wait(timeout=1))

        self.service.close()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=False,
        )
        persisted = next(
            item
            for item in self.service.list_tasks(limit=2_000)["items"]
            if item["task_id"] == task["task_id"]
        )
        self.assertEqual("paused", persisted["status"])
        self.assertEqual("application_shutdown", persisted["error_code"])

    def test_pause_during_analysis_is_not_overwritten_by_late_analyzer_result(self):
        asset_id = self._insert_asset("pause-analysis.mp4")
        analyzer = FakeCreativeAnalyzer(
            on_analyze=lambda task_id: self.service.update_task(task_id, "paused")
        )
        self.service.creative_domain.analyzer = analyzer

        task = self.service.analyze_assets([asset_id])
        result = self._run(task["task_id"])

        self.assertEqual("paused", result["status"])
        self.assertEqual([], self.service.list_media_segments(asset_id=asset_id)["items"])

    def test_course_resume_reuses_generation_one_rows_after_render_pause(self):
        asset_id = self._insert_asset("resume-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        paused_once = set()

        def pause_after_render(_video_id):
            if not paused_once:
                paused_once.add(True)
                self.service.update_task(task["task_id"], "paused")

        self.service.creative_domain.renderer = FakeCreativeRenderer(
            on_render=pause_after_render
        )
        task = self.service.generate_course_cuts(asset_id, count=5)
        first = self._run(task["task_id"])
        self.assertEqual("paused", first["status"])
        self.assertEqual(
            "paused", self.service.get_creative_project(task["project_id"])["status"]
        )
        before = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(1, len(before))
        self.assertEqual("completed", before[0]["status"])
        first_id = before[0]["generated_video_id"]

        self.service.creative_domain.renderer = FakeCreativeRenderer()
        resumed = self.service.resume_creative_task(task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        after = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(5, len(after))
        self.assertIn(first_id, {item["generated_video_id"] for item in after})
        self.assertTrue(all(item["generation"] == 1 for item in after))

    def test_latest_analysis_version_is_the_only_generation_and_listing_source(self):
        asset_id = self._insert_asset("versioned.mp4", duration_ms=180_000)
        analyzer = FakeCreativeAnalyzer(version="local-v1")
        self.service.creative_domain.analyzer = analyzer
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        analyzer.version = "bailian-v2"
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        public_segments = self.service.list_media_segments(asset_id=asset_id)["items"]
        self.assertEqual(18, len(public_segments))
        self.assertTrue(all(item["transcript"].startswith("bailian-v2") for item in public_segments))
        stored_count = self.service.connection.execute(
            "SELECT COUNT(*) FROM media_segments WHERE asset_id = ?", (asset_id,)
        ).fetchone()[0]
        self.assertEqual(36, stored_count)

        task = self.service.generate_course_cuts(asset_id, count=1)
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        video = self.service.list_generated_videos(project_id=task["project_id"])["items"][0]
        row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE id = ?",
            (video["generated_video_id"],),
        ).fetchone()
        current_ids = {
            item[0]
            for item in self.service.connection.execute(
                """
                SELECT id FROM media_segments
                WHERE asset_id = ? AND analysis_version = 'bailian-v2'
                """,
                (asset_id,),
            ).fetchall()
        }
        self.assertTrue(
            {
                item["segment_id"]
                for item in json.loads(row["recipe_json"])["visual_segments"]
            }.issubset(current_ids)
        )

    def test_cached_manifest_rehydrates_segments_when_database_rows_are_missing(self):
        self.service.close()
        command_count = 0

        def fake_ffmpeg(args, **_kwargs):
            nonlocal command_count
            command_count += 1
            Path(args[-1]).write_bytes(b"fixture")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        analyzer = FFmpegCreativeAnalyzer(
            self.data_dir,
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=OfflineCloudClient(),
            command_runner=fake_ffmpeg,
        )
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=analyzer,
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=False,
        )
        asset_id = self._insert_asset("cached-course.mp4", duration_ms=60_000)
        first = self.service.analyze_assets([asset_id])
        self.assertEqual("completed", self._run(first["task_id"])["status"])
        initial = self.service.list_media_segments(asset_id=asset_id)["items"]
        self.assertGreater(len(initial), 0)
        first_command_count = command_count

        manifest_paths = list(
            (self.data_dir / "derivatives" / asset_id).glob(
                f"*/{ANALYSIS_MANIFEST_NAME}"
            )
        )
        self.assertEqual(1, len(manifest_paths))
        manifest_text = manifest_paths[0].read_text(encoding="utf-8")
        self.assertNotIn(str(self.sources), manifest_text)
        self.assertNotIn("analysis-temp", manifest_text)
        with self.service.database.transaction() as connection:
            connection.execute("DELETE FROM media_segments WHERE asset_id = ?", (asset_id,))

        second = self.service.analyze_assets([asset_id])
        self.assertEqual("completed", self._run(second["task_id"])["status"])
        restored = self.service.list_media_segments(asset_id=asset_id)["items"]
        self.assertEqual(first_command_count, command_count)
        self.assertEqual(
            [item["segment_id"] for item in initial],
            [item["segment_id"] for item in restored],
        )

    def test_course_generation_creates_five_finished_candidates_and_two_recommendations(self):
        asset_id = self._insert_asset("lesson.mp4", duration_ms=180_000)
        analysis = self.service.analyze_assets([asset_id])
        self._run(analysis["task_id"])

        task = self.service.generate_course_cuts(
            asset_id,
            min_duration_ms=30_000,
            max_duration_ms=90_000,
            count=5,
            theme="培训现场价值",
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        videos = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(5, len(videos))
        self.assertEqual(2, sum(item["recommended"] for item in videos))
        self.assertTrue(all(30_000 <= item["duration_ms"] <= 90_000 for item in videos))
        self.assertTrue(all(item["status"] == "completed" for item in videos))
        self.assertTrue(all(item["preview_ready"] for item in videos))
        ranges = sorted(
            (item["source_start_ms"], item["source_end_ms"]) for item in videos
        )
        for index, left in enumerate(ranges):
            for right in ranges[index + 1:]:
                overlap = max(0, min(left[1], right[1]) - max(left[0], right[0]))
                shortest = min(left[1] - left[0], right[1] - right[0])
                self.assertLessEqual(overlap / shortest, 0.35)
        row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE project_id = ? LIMIT 1",
            (task["project_id"],),
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        self.assertEqual(48, recipe["subtitle_style"]["font_size"])
        self.assertEqual(170, recipe["subtitle_style"]["margin_bottom"])

    def test_course_generation_does_not_label_local_fallback_as_ai_recommendation(self):
        asset_id = self._insert_asset("editor-offline.mp4", duration_ms=180_000)
        self.service.creative_domain.analyzer = FailingCourseRanker()
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.generate_course_cuts(asset_id, count=2)
        finished = self._run(task["task_id"])

        self.assertEqual("failed", finished["status"])
        self.assertEqual("course_editor_unavailable", finished["error_code"])
        self.assertEqual(
            [],
            self.service.list_generated_videos(project_id=task["project_id"])["items"],
        )

    def test_supoclip_course_scores_use_four_bounded_dimensions_with_evidence_fallback(self):
        asset_id = self._insert_asset("supoclip-course.mp4", duration_ms=180_000)
        analyzer = SupoClipEvidenceRanker()
        self.service.creative_domain.analyzer = analyzer
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        segments = self.service.creative_domain._segments_for_assets(
            [asset_id], transcript_only=True
        )

        windows = self.service.creative_domain._course_windows(
            segments,
            30_000,
            90_000,
            3,
            theme="培训现场价值",
            experiment_mode="supoclip_bailian_v1",
        )

        self.assertEqual(3, len(windows))
        for window in windows:
            score = window["score"]
            self.assertEqual("supoclip_bailian_editor", score["selection_engine"])
            self.assertEqual(25.0, score["hook"])
            self.assertEqual(0.0, score["engagement"])
            self.assertTrue(0 <= score["value"] <= 25)
            self.assertTrue(0 <= score["shareability"] <= 25)
            self.assertTrue(0 <= score["virality_total"] <= 100)
            self.assertEqual(["开场可直接核验"], score["editor_reason"])

    def test_supoclip_course_requires_at_least_one_bailian_ranking(self):
        asset_id = self._insert_asset("supoclip-empty-ranking.mp4", duration_ms=180_000)
        self.service.creative_domain.analyzer = EmptySupoClipRanker()
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        segments = self.service.creative_domain._segments_for_assets(
            [asset_id], transcript_only=True
        )

        with self.assertRaises(ContentEngineError) as raised:
            self.service.creative_domain._course_windows(
                segments,
                30_000,
                90_000,
                3,
                theme="培训现场价值",
                experiment_mode="supoclip_bailian_v1",
            )

        self.assertEqual("course_editor_unavailable", raised.exception.code)

    def test_supoclip_course_task_persists_isolated_recipe_and_finishes(self):
        asset_id = self._insert_asset("supoclip-render.mp4", duration_ms=180_000)
        self.service.creative_domain.analyzer = SupoClipEvidenceRanker()
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.creative_domain.create_course_task(
            asset_id,
            count=2,
            experiment_mode="supoclip_bailian_v1",
            subtitle_preset="energetic_talking",
        )
        finished = self._run(task["task_id"])

        self.assertEqual("completed", finished["status"])
        rows = self.service.connection.execute(
            "SELECT recipe_json, score_json FROM generated_videos WHERE project_id = ?",
            (task["project_id"],),
        ).fetchall()
        self.assertEqual(2, len(rows))
        for row in rows:
            recipe = json.loads(row["recipe_json"])
            score = json.loads(row["score_json"])
            self.assertEqual("supoclip_bailian_v1", recipe["experiment_mode"])
            self.assertEqual("energetic_talking", recipe["subtitle_style"]["preset"])
            self.assertEqual("supoclip_bailian_editor", score["selection_engine"])

    def test_mix_batch_uses_three_roles_and_reports_quality_limited_capacity(self):
        voice_id = self._insert_asset("voice.mp4", duration_ms=180_000)
        visual_ids = [self._insert_asset(f"visual-{index}.mp4") for index in range(1, 7)]
        analysis = self.service.analyze_assets([voice_id, *visual_ids])
        self._run(analysis["task_id"])

        task = self.service.generate_mix_batch(
            [voice_id, *visual_ids],
            theme="培训现场价值",
            target_count=30,
            voice_asset_id=voice_id,
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        summary = self.service.get_creative_project(task["project_id"])
        self.assertLessEqual(summary["generated_count"], 30)
        self.assertGreater(summary["generated_count"], 0)
        self.assertEqual(["hook", "process", "result"], summary["required_roles"])
        self.assertIn("maximum_qualified_count", summary)
        videos = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        signatures = [item["selection_signature"] for item in videos]
        self.assertEqual(len(signatures), len(set(signatures)))

    def test_mix_failure_persists_structured_capacity_and_missing_roles(self):
        self.service.creative_domain.analyzer = FakeCreativeAnalyzer(only_role="hook")
        assets = [self._insert_asset(f"missing-role-{index}.mp4") for index in range(3)]
        task = self.service.generate_mix_batch(
            assets, target_count=3, voice_asset_id=assets[0]
        )
        result = self._run(task["task_id"])
        self.assertEqual("failed", result["status"])

        project = self.service.get_creative_project(task["project_id"])
        self.assertEqual(["process", "result"], project["missing_roles"])
        self.assertEqual(0, project["maximum_qualified_count"])
        self.assertTrue(project["count_is_exact"])

    def test_mix_resume_reuses_generation_one_rows(self):
        voice_id = self._insert_asset("resume-mix-voice.mp4", duration_ms=180_000)
        visual_ids = [
            self._insert_asset(f"resume-mix-{index}.mp4") for index in range(5)
        ]
        self._run(self.service.analyze_assets([voice_id, *visual_ids])["task_id"])
        paused_once = set()

        def pause_after_render(_video_id):
            if not paused_once:
                paused_once.add(True)
                self.service.update_task(task["task_id"], "paused")

        self.service.creative_domain.renderer = FakeCreativeRenderer(
            on_render=pause_after_render
        )
        task = self.service.generate_mix_batch(
            [voice_id, *visual_ids], target_count=3, voice_asset_id=voice_id
        )
        self.assertEqual("paused", self._run(task["task_id"])["status"])
        before = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(1, len(before))
        self.assertEqual("completed", before[0]["status"])
        first_id = before[0]["generated_video_id"]

        self.service.creative_domain.renderer = FakeCreativeRenderer()
        resumed = self.service.resume_creative_task(task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        after = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(3, len(after))
        self.assertIn(first_id, {item["generated_video_id"] for item in after})
        self.assertTrue(all(item["generation"] == 1 for item in after))

    def test_queue_and_regenerate_keep_generated_outputs_internal(self):
        asset_id = self._insert_asset("lesson.mp4", duration_ms=180_000)
        analysis = self.service.analyze_assets([asset_id])
        self._run(analysis["task_id"])
        task = self.service.generate_course_cuts(asset_id, count=1)
        self._run(task["task_id"])
        video = self.service.list_generated_videos(project_id=task["project_id"])["items"][0]

        queued = self.service.queue_generated_videos([video["generated_video_id"]], "douyin")
        self.assertEqual("queued", queued["items"][0]["status"])
        regenerated = self.service.regenerate_video(video["generated_video_id"])
        self.assertEqual("queued", regenerated["status"])
        self.assertNotEqual(
            video["generated_video_id"], regenerated["generated_video_id"]
        )
        self.assertNotIn(str(self.data_dir), json.dumps(regenerated, ensure_ascii=False))
        self.assertEqual("completed", self._run(regenerated["task_id"])["status"])
        candidate = next(
            item
            for item in self.service.list_generated_videos(
                project_id=task["project_id"]
            )["items"]
            if item["generated_video_id"] == regenerated["generated_video_id"]
        )
        self.assertEqual("completed", candidate["status"])

    def test_restart_reconciles_and_finishes_interrupted_regeneration(self):
        asset_id = self._insert_asset("regeneration-restart.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        project_task = self.service.generate_course_cuts(asset_id, count=1)
        self._run(project_task["task_id"])
        source = self.service.list_generated_videos(
            project_id=project_task["project_id"]
        )["items"][0]
        regeneration = self.service.regenerate_video(source["generated_video_id"])
        self.service.connection.execute(
            "UPDATE generated_videos SET status = 'rendering' WHERE id = ?",
            (regeneration["generated_video_id"],),
        )
        self.service.close()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=True,
        )

        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            task_status = next(
                item["status"]
                for item in self.service.list_tasks(limit=2_000)["items"]
                if item["task_id"] == regeneration["task_id"]
            )
            if task_status == "completed":
                break
            time.sleep(0.01)
        self.assertEqual("completed", task_status)
        candidate = next(
            item
            for item in self.service.list_generated_videos(
                project_id=project_task["project_id"]
            )["items"]
            if item["generated_video_id"] == regeneration["generated_video_id"]
        )
        self.assertEqual("completed", candidate["status"])

    def test_repeated_queue_returns_persisted_status_and_reject_cancels_queued_item(self):
        asset_id = self._insert_asset("queue-state.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        task = self.service.generate_course_cuts(asset_id, count=2)
        self._run(task["task_id"])
        videos = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        first_id, second_id = [item["generated_video_id"] for item in videos]

        self.service.queue_generated_videos([first_id], "internal")
        self.service.connection.execute(
            """
            UPDATE generated_publish_queue SET status = 'published'
            WHERE generated_video_id = ? AND channel = 'internal'
            """,
            (first_id,),
        )
        repeated = self.service.queue_generated_videos([first_id], "internal")
        self.assertEqual("published", repeated["items"][0]["status"])

        self.service.queue_generated_videos([second_id], "internal")
        self.service.reject_generated_video(second_id)
        status = self.service.connection.execute(
            """
            SELECT status FROM generated_publish_queue
            WHERE generated_video_id = ? AND channel = 'internal'
            """,
            (second_id,),
        ).fetchone()[0]
        self.assertEqual("cancelled", status)

    def test_protocol_exposes_creative_methods_but_not_public_paths(self):
        expected = {
            "analyze_assets",
            "list_media_segments",
            "generate_course_cuts",
            "generate_mix_batch",
            "list_generated_videos",
            "regenerate_video",
            "queue_generated_videos",
        }
        self.assertTrue(expected.issubset(METHODS))

    def test_protocol_forwards_course_experiment_contract(self):
        captured = {}

        class FakeService:
            def generate_course_cuts(self, asset_id, **options):
                captured.update({"asset_id": asset_id, **options})
                return {"task_id": "task_fixture"}

        result = METHODS["generate_course_cuts"](
            FakeService(),
            {
                "asset_id": "asset_fixture",
                "experiment_mode": "supoclip_bailian_v1",
                "subtitle_preset": "energetic_talking",
            },
        )

        self.assertEqual({"task_id": "task_fixture"}, result)
        self.assertEqual("supoclip_bailian_v1", captured["experiment_mode"])
        self.assertEqual("energetic_talking", captured["subtitle_preset"])


class CreativeMigrationTests(unittest.TestCase):
    def test_v6_migration_is_idempotent(self):
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-creative-migration-"))
        try:
            first = Database(root).open()
            tables = {
                row[0]
                for row in first.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            first.close()
            second = Database(root).open()
            versions = second.connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            ).fetchall()
            second.close()
            self.assertTrue(
                {
                    "asset_derivatives",
                    "media_segments",
                    "creative_projects",
                    "generated_videos",
                    "generated_publish_queue",
                }.issubset(tables)
            )
            self.assertEqual([1, 2, 3, 4, 5, 6], [row[0] for row in versions])
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
