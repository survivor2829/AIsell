from __future__ import annotations

import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.database import Database
from content_engine.apimart_cover import (
    APIMartCoverClient,
    APIMartError,
    APIMartOutcomeUnknown,
    APIMartPollingStopped,
    _stdlib_request,
)
from content_engine.creative_analysis import (
    ANALYSIS_MANIFEST_NAME,
    DashScopeMediaClient,
    FFmpegCreativeAnalyzer,
    _safe_json_object,
)
from content_engine.creative_domain import CreativeDomain
from content_engine.creative_render import FFmpegCreativeRenderer
from content_engine.errors import ContentEngineError
from content_engine.packaging import PACKAGING_PRESETS, apply_motion_plan, build_packaging
from content_engine.protocol import METHODS, serve_jsonl
from content_engine.service import ContentEngineService, utc_now


class APIMartCoverClientTests(unittest.TestCase):
    def test_stdlib_http_reader_is_bounded_before_buffering(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b"ok"
        with mock.patch("urllib.request.urlopen", return_value=response):
            status, raw = _stdlib_request(
                "GET", "https://api.test/file", max_bytes=128
            )

        self.assertEqual(200, status)
        self.assertEqual(b"ok", raw)
        response.read.assert_called_once_with(129)

    def test_submit_poll_and_download_use_one_paid_task_with_fake_http(self):
        requests = []

        def request(method, url, *, payload=None, headers=None, timeout=None):
            requests.append((method, url, payload, headers, timeout))
            if method == "POST":
                return 200, json.dumps({"data": [{"task_id": "provider-1"}]}).encode()
            if "/tasks/" in url:
                return 200, json.dumps(
                    {"data": {"status": "completed", "result": {"images": [{"url": "https://cdn.test/cover.png"}]}}}
                ).encode()
            return 200, b"fake-image"

        client = APIMartCoverClient(
            api_key="secret-key",
            base_url="https://api.test/v1",
            model="gpt-image-2",
            request_fn=request,
            sleep=lambda _seconds: None,
        )
        task_id = client.submit("vertical education scene, no text")
        url = client.poll(task_id, poll_interval=0, poll_timeout=1)
        target = Path(tempfile.mkdtemp(prefix="xiaoxi-cover-client-")) / "cover.png"
        try:
            client.download(url, target)
            submitted = [item for item in requests if item[0] == "POST"]
            self.assertEqual(1, len(submitted))
            self.assertEqual("gpt-image-2", submitted[0][2]["model"])
            self.assertEqual("9:16", submitted[0][2]["size"])
            self.assertEqual(b"fake-image", target.read_bytes())
            self.assertNotIn("secret-key", json.dumps(submitted[0][2]))
        finally:
            shutil.rmtree(target.parent, ignore_errors=True)

    def test_submit_transport_failure_is_outcome_unknown_without_retry(self):
        calls = []

        def request(method, url, **_kwargs):
            calls.append((method, url))
            raise OSError("connection lost")

        client = APIMartCoverClient(
            api_key="secret-key",
            base_url="https://api.test/v1",
            request_fn=request,
        )

        with self.assertRaises(APIMartOutcomeUnknown):
            client.submit("no text")

        self.assertEqual(1, len(calls))

    def test_submit_uploads_one_local_reference_image_before_generation(self):
        requests = []

        def request(method, url, **kwargs):
            requests.append((method, url, kwargs))
            if url.endswith("/uploads/images"):
                return 200, json.dumps({"url": "https://cdn.test/reference.png"}).encode()
            return 200, json.dumps({"data": [{"task_id": "provider-ref"}]}).encode()

        client = APIMartCoverClient(
            api_key="secret-key",
            base_url="https://api.test/v1",
            request_fn=request,
        )
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-cover-reference-"))
        reference = root / "teacher.png"
        reference.write_bytes(b"fake-png")
        try:
            task_id = client.submit("preserve the referenced person", reference_path=reference)
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual("provider-ref", task_id)
        self.assertEqual(2, len(requests))
        generation = requests[1][2]["payload"]
        self.assertEqual(["https://cdn.test/reference.png"], generation["image_urls"])
        self.assertNotIn("fake-png", json.dumps(generation))

    def test_poll_can_stop_locally_without_changing_provider_outcome(self):
        requests = []
        checks = iter((False, True))

        def request(method, url, **_kwargs):
            requests.append((method, url))
            return 200, json.dumps({"data": {"status": "processing"}}).encode()

        client = APIMartCoverClient(
            api_key="secret-key",
            base_url="https://api.test/v1",
            request_fn=request,
            sleep=lambda _seconds: None,
        )
        with self.assertRaises(APIMartPollingStopped):
            client.poll(
                "provider-existing",
                should_stop=lambda: next(checks, True),
            )

        self.assertEqual(1, len(requests))


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

    def test_renderer_uses_ai_event_text_timing_and_zone_instead_of_generic_labels(self):
        packaging = {
            "preset_id": "knowledge_focus",
            "effects": {"title_card": True, "keyword_card": True},
            "brand": None,
            "director": {"provider": "bailian", "model": "qwen-plus", "version": 1},
            "events": [{
                "type": "keyword", "text": "办公商用场景",
                "start_ms": 4_000, "end_ms": 6_000,
                "zone": "upper_right", "size": "card", "priority": 2,
            }],
        }

        graph = self.renderer._packaging_filter(packaging)

        self.assertIn("办公商用场景", graph)
        self.assertIn("between(t,4.000,6.000)", graph)
        self.assertIn("x=551", graph)
        self.assertNotIn("观点 01", graph)

    def test_finishing_pass_uses_logo_outro_and_ducked_procedural_audio(self):
        logo = self.root / "logo.png"
        logo.write_bytes(b"logo")
        recipe = {
            "voice_segment": {"start_ms": 0, "end_ms": 30_000},
            "packaging": {
                "brand": {"logo_asset_id": "logo-asset", "outro_text": "关注我们"},
                "audio": {"bgm": True, "bgm_gain_db": -24, "cue_budget": 2},
                "events": [
                    {"type": "hook", "start_ms": 0, "end_ms": 1_000},
                    {"type": "keyword", "start_ms": 8_000, "end_ms": 9_000},
                ],
            },
        }

        self.renderer._finish_video(
            self.root / "base.mp4",
            self.root / "finished.mp4",
            recipe,
            lambda _asset_id: logo,
        )

        args = self.encodes[-1]["args"]
        graph = args[args.index("-filter_complex") + 1]
        self.assertIn(str(logo), args)
        self.assertIn("overlay=W-w-40:40", graph)
        self.assertIn("between(t,29.200,30.000)", graph)
        self.assertIn("关注我们", graph)
        self.assertIn("sidechaincompress", graph)
        self.assertIn("adelay=8000|8000", graph)
        self.assertIn("alimiter=limit=0.75:attack=5:release=50:level=false", graph)

    def test_visual_montage_does_not_stack_procedural_bgm_or_cues(self):
        recipe = {
            "audio_mode": "visual_montage",
            "voice_segment": {"start_ms": 0, "end_ms": 12_000},
            "packaging": {
                "audio": {"bgm": True, "bgm_gain_db": -24, "cue_budget": 4},
                "events": [{"type": "hook", "start_ms": 0, "end_ms": 1_000}],
            },
        }

        self.renderer._finish_video(
            self.root / "montage-base.mp4",
            self.root / "montage-finished.mp4",
            recipe,
            lambda _asset_id: self.root / "unused.png",
        )

        args = self.encodes[-1]["args"]
        self.assertNotIn("aevalsrc=exprs=", args)
        self.assertNotIn("sine=frequency=880", args)

    def test_short_product_tts_is_padded_to_full_candidate_duration(self):
        voice = self.root / "short-product-voice.wav"
        voice.write_bytes(b"short-voice-fixture")
        temp_dir = self.root / "product-tts"
        temp_dir.mkdir()
        recipe = {
            "kind": "mix",
            "layout": "product_showcase",
            "audio_mode": "voiceover",
            "voice_audio_path": voice.name,
            "voice_segment": {
                "asset_id": "visual-asset",
                "start_ms": 0,
                "end_ms": 12_000,
            },
            "visual_segments": [{
                "asset_id": "visual-asset",
                "media_kind": "video",
                "start_ms": 0,
                "end_ms": 12_000,
                "target_duration_ms": 12_000,
            }],
            "packaging": {},
        }

        self.renderer._render_mix(
            recipe,
            temp_dir / "output.mp4",
            None,
            temp_dir,
            lambda asset_id: self.root / f"{asset_id}.mp4",
        )

        bounded, normalized, final = self.encodes
        self.assertIn("-an", bounded["args"])
        self.assertIn("-an", normalized["args"])
        audio_filter = final["args"][final["args"].index("-af") + 1]
        self.assertIn("apad=whole_dur=12.000", audio_filter)
        self.assertIn("atrim=duration=12.000", audio_filter)
        self.assertIn("asetpts=PTS-STARTPTS", audio_filter)

    def test_source_voice_product_montage_preserves_source_audio(self):
        temp_dir = self.root / "product-source-voice"
        temp_dir.mkdir()
        recipe = {
            "kind": "mix",
            "layout": "product_showcase",
            "audio_mode": "visual_montage",
            "voice_segment": {
                "asset_id": "visual-asset",
                "start_ms": 0,
                "end_ms": 8_000,
            },
            "visual_segments": [{
                "asset_id": "visual-asset",
                "media_kind": "video",
                "start_ms": 0,
                "end_ms": 8_000,
                "target_duration_ms": 8_000,
            }],
            "packaging": {},
        }

        self.renderer._render_mix(
            recipe,
            temp_dir / "output.mp4",
            None,
            temp_dir,
            lambda asset_id: self.root / f"{asset_id}.mp4",
        )

        bounded, normalized, final = self.encodes
        self.assertNotIn("-an", bounded["args"])
        self.assertNotIn("-an", normalized["args"])
        self.assertIn("0:a:0?", final["args"])

    def test_explicit_bgm_ducks_under_padded_product_tts(self):
        recipe = {
            "audio_mode": "voiceover",
            "voice_audio_path": "product-voices/voice.wav",
            "voice_segment": {"start_ms": 0, "end_ms": 12_000},
            "packaging": {
                "audio": {
                    "bgm": True,
                    "bgm_asset_id": "selected-bgm",
                    "bgm_gain_db": -24,
                    "cue_budget": 0,
                },
            },
        }
        bgm = self.root / "selected-bgm.mp3"

        self.renderer._finish_video(
            self.root / "padded-tts-base.mp4",
            self.root / "padded-tts-finished.mp4",
            recipe,
            lambda asset_id: bgm if asset_id == "selected-bgm" else self.root / "unused",
        )

        args = self.encodes[-1]["args"]
        graph = args[args.index("-filter_complex") + 1]
        self.assertIn(str(bgm), args)
        self.assertIn("asplit=2[primary_mix][primary_sidechain]", graph)
        self.assertIn("[bgm][primary_sidechain]sidechaincompress", graph)
        self.assertIn("[primary_mix][ducked_bgm]amix", graph)

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

    def test_standard_packaging_keeps_words_and_template_subtitle_contract(self):
        domain = object.__new__(CreativeDomain)
        segment = {
            "segment_id": "segment-1",
            "asset_id": "asset-1",
            "start_ms": 10_000,
            "end_ms": 20_000,
            "transcript_text": "标准课程也要逐词高亮。",
            "speaker": "teacher",
            "media_kind": "video",
            "shot_type": "lecturer",
            "tags": [],
            "metadata": {
                "words": [
                    {"text": "标准课程", "begin_time": 10_100, "end_time": 10_800},
                    {"text": "也要", "begin_time": 10_850, "end_time": 11_200},
                    {"text": "逐词高亮", "begin_time": 11_250, "end_time": 12_000, "punctuation": "。"},
                ]
            },
        }
        recipe = domain._course_recipe(
            "asset-1",
            {"start_ms": 10_000, "end_ms": 20_000, "segments": [segment]},
            subtitle_font_size=48,
            subtitle_margin_bottom=170,
            include_word_timestamps=True,
        )
        domain._attach_packaging(
            recipe,
            kind="course",
            title="标准课程",
            index=0,
            options={
                "packaging_mode": "auto",
                "packaging_preset_id": None,
                "brand_profile_id": None,
                "cover_mode": "local_frame",
            },
        )

        self.assertEqual("knowledge_course", recipe["subtitle_style"]["preset"])
        self.assertEqual(14, recipe["subtitle_style"]["max_chars"])
        self.assertEqual(48, recipe["subtitle_style"]["font_size"])
        self.assertEqual(170, recipe["subtitle_style"]["margin_bottom"])
        self.assertEqual(3, len(recipe["captions"][0]["words"]))

        renderer = FFmpegCreativeRenderer.__new__(FFmpegCreativeRenderer)
        renderer.font_paths = {}
        renderer.font_path = None
        ass = renderer._write_ass(
            Path(tempfile.mkdtemp(prefix="xiaoxi-standard-karaoke-")) / "captions.ass",
            recipe["captions"],
            recipe,
        )
        try:
            self.assertIn(r"{\kf", ass.read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(ass.parent, ignore_errors=True)

    def test_packaged_mix_recipe_keeps_normalized_voice_words(self):
        domain = object.__new__(CreativeDomain)
        voice_segment = {
            "segment_id": "voice-1",
            "asset_id": "voice-asset",
            "start_ms": 5_000,
            "end_ms": 35_000,
            "transcript_text": "混剪也使用词级时间。",
            "speaker": "teacher",
            "metadata": {
                "words": [
                    {"text": "混剪", "begin_time": 5_100, "end_time": 5_500},
                    {"text": "也使用", "begin_time": 5_550, "end_time": 6_000},
                    {"text": "词级时间", "begin_time": 6_050, "end_time": 6_700, "punctuation": "。"},
                ]
            },
        }
        backbone = {
            "duration_ms": 30_000,
            "start_ms": 5_000,
            "end_ms": 35_000,
            "segments": [voice_segment],
        }
        choice = [
            {
                "segment_id": f"visual-{index}",
                "asset_id": f"asset-{index}",
                "start_ms": 0,
                "end_ms": 10_000,
                "media_kind": "video",
            }
            for index in range(3)
        ]

        recipe = domain._mix_recipe(
            backbone, choice, include_word_timestamps=True
        )
        domain._attach_packaging(
            recipe,
            kind="mix",
            title="混剪",
            index=0,
            options={
                "packaging_mode": "auto",
                "packaging_preset_id": None,
                "brand_profile_id": None,
                "cover_mode": "local_frame",
            },
        )

        self.assertEqual("energetic_talking", recipe["subtitle_style"]["preset"])
        self.assertEqual(3, len(recipe["captions"][0]["words"]))

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

    def test_packaging_filter_adds_local_title_card_without_timeline_collapsing_zoompan(self):
        packaging = {
            "preset_id": "knowledge_focus",
            "title": "三个现场判断标准",
            "effects": {"gentle_push": True, "title_card": True},
            "brand": {"primary_color": "#6D5DFB", "accent_color": "#FFE45C"},
        }

        rendered = self.renderer._packaging_filter(packaging)

        self.assertNotIn("zoompan=", rendered)
        self.assertIn("drawbox=", rendered)
        self.assertIn("drawtext=", rendered)
        self.assertNotIn("C:\\", rendered)

    def test_brand_font_presets_change_drawtext_and_caption_fonts(self):
        self.renderer.font_paths = {
            "microsoft_yahei": self.root / "yahei.ttc",
            "source_han_sans": self.root / "deng.ttf",
            "neutral_sans": self.root / "simhei.ttf",
        }
        self.renderer.font_path = self.renderer.font_paths["microsoft_yahei"]
        packaging = {"brand": {"font_preset": "neutral_sans"}}
        drawtext = self.renderer._drawtext_font_option(packaging)
        subtitle = self.renderer._write_ass(
            self.root / "brand-font.ass",
            [{"start_ms": 0, "end_ms": 1_000, "text": "品牌字体"}],
            {
                "voice_segment": {"start_ms": 0},
                "packaging": packaging,
                "subtitle_style": {"preset": "dynamic_clean"},
            },
        ).read_text(encoding="utf-8")

        self.assertIn("simhei.ttf", drawtext)
        self.assertIn("Style: Dynamic,SimHei", subtitle)

    def test_cover_uses_raw_recipe_source_instead_of_packaged_video(self):
        packaged = self.root / "packaged.mp4"
        raw = self.root / "raw.mp4"
        source, seek = self.renderer._cover_source(
            {
                "kind": "course",
                "voice_segment": {
                    "asset_id": "raw-asset",
                    "start_ms": 12_000,
                    "end_ms": 20_000,
                },
            },
            lambda _asset_id: raw,
            fallback=packaged,
        )

        self.assertEqual(raw, source)
        self.assertEqual(12.5, seek)

    def test_audio_profiles_keep_voice_loudness_and_add_mix_compression(self):
        course = self.renderer._audio_filter(
            {"packaging": {"audio": {"profile": "course_clean"}}}
        )
        mix = self.renderer._audio_filter(
            {"packaging": {"audio": {"profile": "mix_rhythm"}}}
        )

        self.assertIn("loudnorm=I=-16", course)
        self.assertNotIn("acompressor", course)
        self.assertIn("acompressor", mix)
        self.assertIn("TP=-1.5", mix)
        self.assertIn("alimiter=limit=0.75:attack=5:release=50:level=false", course)
        self.assertIn("alimiter=limit=0.75:attack=5:release=50:level=false", mix)


class PackagingPresetTests(unittest.TestCase):
    def test_six_presets_are_versioned_and_split_by_generation_kind(self):
        self.assertEqual(6, len(PACKAGING_PRESETS))
        self.assertEqual(
            {"knowledge_focus", "slide_teacher", "classroom_value"},
            {
                preset["preset_id"]
                for preset in PACKAGING_PRESETS.values()
                if preset["kind"] == "course"
            },
        )
        self.assertEqual(
            {"hook_impact", "process_rhythm", "result_close"},
            {
                preset["preset_id"]
                for preset in PACKAGING_PRESETS.values()
                if preset["kind"] == "mix"
            },
        )
        self.assertTrue(all(preset["version"] == 1 for preset in PACKAGING_PRESETS.values()))

    def test_motion_plan_keeps_two_non_duplicate_events_in_distinct_zones(self):
        packaging = {"events": []}
        plan = {
            "provider": "bailian",
            "model": "qwen-plus",
            "version": 1,
            "events": [
                {
                    "type": "hook",
                    "text": "真实课堂重点",
                    "start_ms": 0,
                    "end_ms": 3_000,
                    "zone": "top_banner",
                    "size": "hero",
                    "priority": 3,
                },
                {
                    "type": "keyword",
                    "text": "真实课堂重点",
                    "start_ms": 500,
                    "end_ms": 2_500,
                    "zone": "top_banner",
                    "size": "card",
                    "priority": 2,
                },
                {
                    "type": "step",
                    "text": "设备实操",
                    "start_ms": 700,
                    "end_ms": 2_700,
                    "zone": "top_banner",
                    "size": "chip",
                    "priority": 2,
                },
                {
                    "type": "result",
                    "text": "现场结果",
                    "start_ms": 900,
                    "end_ms": 2_900,
                    "zone": "top_banner",
                    "size": "card",
                    "priority": 1,
                },
            ],
        }

        result = apply_motion_plan(packaging, plan)
        events = result["events"]

        self.assertEqual(["真实课堂重点", "设备实操"], [event["text"] for event in events])
        self.assertEqual(2, len({event["zone"] for event in events}))

    def test_cover_none_keeps_preview_thumbnail_but_reports_no_publish_cover(self):
        packaging = build_packaging(
            {"voice_segment": {"start_ms": 0, "end_ms": 30_000}},
            kind="course",
            title="课程",
            mode="auto",
            preset_id=None,
            index=0,
            brand=None,
            cover_mode="none",
        )

        self.assertEqual("none", packaging["cover"]["mode"])
        self.assertEqual("none", packaging["cover"]["status"])

    def test_legacy_auto_cover_remains_local_for_persisted_recipes(self):
        packaging = build_packaging(
            {"voice_segment": {"start_ms": 0, "end_ms": 30_000}},
            kind="course",
            title="课程",
            mode="auto",
            preset_id=None,
            index=0,
            brand=None,
            cover_mode="auto",
        )

        self.assertEqual("local_frame", packaging["cover"]["mode"])
        self.assertEqual("local", packaging["cover"]["status"])


class DashScopeCourseSelectionTests(unittest.TestCase):
    def test_provider_prose_and_markdown_fence_are_parsed_without_relaxing_schema(self):
        parsed = _safe_json_object(
            '模型说明：\n```json\n{"frames": [{"index": 0}]}\n```\n以上。'
        )
        self.assertEqual(0, parsed["frames"][0]["index"])

    def test_visual_response_format_error_gets_one_strict_retry(self):
        client = DashScopeMediaClient(api_key="test-key")
        responses = iter(
            [
                {"choices": [{"message": {"content": "我先分析一下画面"}}]},
                {"choices": [{"message": {"content": '{"frames": []}'}}]},
            ]
        )
        calls = []

        def request_json(_url, **kwargs):
            calls.append(kwargs["payload"])
            return next(responses)

        client._request_json = request_json
        frame = Path(tempfile.mkdtemp(prefix="creative-frame-")) / "frame.jpg"
        frame.write_bytes(b"fixture-jpeg")
        try:
            self.assertEqual([], client.understand_frames([{"path": frame, "timestamp_ms": 0}]))
        finally:
            shutil.rmtree(frame.parent, ignore_errors=True)
        self.assertEqual(2, len(calls))
        self.assertEqual(0.0, calls[1]["temperature"])
        self.assertIn("只返回一个合法的 JSON 对象", calls[1]["messages"][-1]["content"][-1]["text"])

    def test_visual_response_schema_error_gets_one_strict_retry(self):
        client = DashScopeMediaClient(api_key="test-key")
        responses = iter(
            [
                {"choices": [{"message": {"content": '{"items": []}'}}]},
                {"choices": [{"message": {"content": '{"frames": []}'}}]},
            ]
        )
        calls = []
        client._request_json = lambda _url, **kwargs: (
            calls.append(kwargs["payload"]) or next(responses)
        )
        frame = Path(tempfile.mkdtemp(prefix="creative-frame-")) / "frame.jpg"
        frame.write_bytes(b"fixture-jpeg")
        try:
            self.assertEqual([], client.understand_frames([{"path": frame, "timestamp_ms": 0}]))
        finally:
            shutil.rmtree(frame.parent, ignore_errors=True)
        self.assertEqual(2, len(calls))

    def test_product_script_retry_reports_all_structural_gaps_once(self):
        client = DashScopeMediaClient(api_key="test-key")
        incomplete = {
            "title_candidates": [],
            "hook": None,
            "voiceover": "机器人正在工厂清洁地面。" * 9,
            "shots": [],
            "cta": None,
            "bgm_mood": "平稳",
        }
        corrected = {
            **incomplete,
            "title_candidates": ["工厂清洁"],
            "hook": "清洁任务开始。",
            "voiceover": (
                "清洁任务开始。"
                + "机器人正在工厂清洁地面。" * 10
                + "持续完成清洁任务。"
            ),
            "shots": [
                {
                    "asset_id": "asset-1",
                    "asset_tags": [],
                    "caption": "机器人作业",
                    "action": "展示",
                }
            ],
            "cta": "持续完成清洁任务。",
        }
        responses = iter(
            [
                {"choices": [{"message": {"content": json.dumps(incomplete, ensure_ascii=False)}}]},
                {"choices": [{"message": {"content": json.dumps(corrected, ensure_ascii=False)}}]},
            ]
        )
        calls = []
        client._request_json = lambda _url, **kwargs: (
            calls.append(kwargs["payload"]) or next(responses)
        )

        result = client.generate_product_script(
            {
                "product_name": "自动清洁机器人",
                "voiceover_min_chars": 20,
                "voiceover_max_chars": 220,
                "voiceover_min_sentence_count": 10,
                "guided_storyboard": True,
            },
            [{"asset_id": "asset-1", "asset_tags": ["机器人"]}],
        )

        self.assertEqual(2, len(calls))
        retry_prompt = calls[1]["messages"][-1]["content"]
        self.assertIn("hook 必须是非空字符串", retry_prompt)
        self.assertIn("voiceover 只有 9 句", retry_prompt)
        self.assertIn("至少需要 10 句", retry_prompt)
        self.assertIn("cta 必须是非空字符串", retry_prompt)
        self.assertNotIn("上一次输出无法解析", retry_prompt)
        self.assertEqual(corrected["voiceover"], result["voiceover"])

    def test_product_script_final_error_keeps_safe_reason_and_stops_after_two_calls(self):
        client = DashScopeMediaClient(api_key="test-key")
        invalid = {
            "title_candidates": ["工厂清洁"],
            "hook": "清洁任务开始。",
            "voiceover": "最终正文哨兵。",
            "shots": [{"asset_id": "asset-1"}],
            "cta": "继续查看。",
        }
        calls = []
        client._request_json = lambda _url, **kwargs: (
            calls.append(kwargs["payload"])
            or {
                "choices": [
                    {"message": {"content": json.dumps(invalid, ensure_ascii=False)}}
                ]
            }
        )

        with self.assertRaises(ContentEngineError) as caught:
            client.generate_product_script(
                {
                    "product_name": "自动清洁机器人",
                    "voiceover_min_chars": 20,
                    "voiceover_max_chars": 220,
                    "voiceover_min_sentence_count": 10,
                    "guided_storyboard": True,
                },
                [{"asset_id": "asset-1", "asset_tags": ["机器人"]}],
            )

        self.assertEqual(2, len(calls))
        self.assertEqual("product_copy_invalid", caught.exception.code)
        self.assertIn("至少需要 20 个字符", caught.exception.message)
        self.assertIn("至少需要 10 句", caught.exception.message)
        self.assertNotIn("最终正文哨兵", caught.exception.message)

    def test_guided_product_script_retry_reuses_the_cloud_draft_for_length_fix(self):
        client = DashScopeMediaClient(api_key="test-key")
        hook = "清洁任务开始。"
        cta = "持续完成清洁任务。"
        invalid_cta = "现在就开始清洁。"
        sentence = "机器人沿工厂通道前进，持续清洁脚下地面。"
        under_length = f"{hook}{sentence * 8}{cta}"
        corrected_voiceover = f"{hook}{sentence * 9}{cta}"
        self.assertLess(len(under_length), 189)
        self.assertGreaterEqual(len(corrected_voiceover), 189)
        self.assertLessEqual(len(corrected_voiceover), 221)
        first = {
            "hook": hook,
            "voiceover": under_length,
            "cta": invalid_cta,
        }
        corrected = {**first, "voiceover": corrected_voiceover, "cta": cta}
        responses = iter(
            [
                {"choices": [{"message": {"content": json.dumps(first, ensure_ascii=False)}}]},
                {"choices": [{"message": {"content": json.dumps(corrected, ensure_ascii=False)}}]},
            ]
        )
        calls = []
        client._request_json = lambda _url, **kwargs: (
            calls.append(kwargs["payload"]) or next(responses)
        )

        result = client.generate_product_script(
            {
                "product_name": "自动清洁机器人",
                "voiceover_min_chars": 189,
                "voiceover_max_chars": 221,
                "voiceover_min_sentence_count": 10,
                "guided_storyboard": True,
            },
            [{"asset_id": "asset-1", "asset_tags": ["机器人"]}],
        )

        self.assertEqual(2, len(calls))
        initial_prompt = calls[0]["messages"][-1]["content"]
        self.assertIn("字段必须包括 hook、voiceover、cta", initial_prompt)
        self.assertIn("不需要 title_candidates、shots 或 bgm_mood", initial_prompt)
        self.assertIn("cta 必须逐字复制 voiceover 的最后一句", initial_prompt)
        retry_messages = calls[1]["messages"]
        self.assertEqual("assistant", retry_messages[-2]["role"])
        self.assertIn(under_length, retry_messages[-2]["content"])
        retry_prompt = retry_messages[-1]["content"]
        self.assertIn("至少需要 189 个字符", retry_prompt)
        self.assertIn("优先写到 200 到 210 个字符", retry_prompt)
        self.assertIn("当前初稿还差至少", retry_prompt)
        self.assertIn("cta 必须是 voiceover 结尾的原句", retry_prompt)
        self.assertIn("cta 必须逐字复制 voiceover 的最后一句", retry_prompt)
        self.assertEqual(corrected_voiceover, result["voiceover"])

    def test_visual_response_prompt_carries_locked_product_context(self):
        client = DashScopeMediaClient(api_key="test-key")
        captured = {}
        client._request_json = lambda _url, **kwargs: (
            captured.update(kwargs["payload"])
            or {"choices": [{"message": {"content": '{"frames": []}'}}]}
        )
        frame = Path(tempfile.mkdtemp(prefix="creative-frame-")) / "frame.jpg"
        frame.write_bytes(b"fixture-jpeg")
        try:
            client.understand_frames(
                [{"path": frame, "timestamp_ms": 0}],
                context={"product_name": "清洁扫地机器人", "industry": "清洁机器人"},
            )
        finally:
            shutil.rmtree(frame.parent, ignore_errors=True)
        text = captured["messages"][-1]["content"][-1]["text"]
        self.assertIn("清洁扫地机器人", text)
        self.assertIn("不得把商品改写成其他品类", text)

    def test_visual_response_stops_after_one_format_retry(self):
        client = DashScopeMediaClient(api_key="test-key")
        calls = []
        client._request_json = lambda _url, **kwargs: (
            calls.append(kwargs["payload"]) or {"choices": [{"message": {"content": "not-json"}}]}
        )
        frame = Path(tempfile.mkdtemp(prefix="creative-frame-")) / "frame.jpg"
        frame.write_bytes(b"fixture-jpeg")
        try:
            with self.assertRaises(ContentEngineError) as raised:
                client.understand_frames([{"path": frame, "timestamp_ms": 0}])
        finally:
            shutil.rmtree(frame.parent, ignore_errors=True)
        self.assertEqual("cloud_response_invalid", raised.exception.code)
        self.assertEqual(2, len(calls))

    def test_supoclip_selection_sends_visual_evidence_and_clamps_four_scores(self):
        client = DashScopeMediaClient(api_key="test-key")
        captured = {}
        source_id = "candidate-" + "x" * 100

        def request_json(_url, **kwargs):
            captured.update(kwargs["payload"])
            return {
                "choices": [{"message": {"content": json.dumps({
                    "candidates": [{
                        "id": "c1",
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
                "id": source_id,
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
        self.assertEqual(source_id, result[0]["id"])
        self.assertEqual(25.0, result[0]["hook"])
        self.assertEqual(0.0, result[0]["engagement"])
        self.assertEqual(18.5, result[0]["value"])
        self.assertEqual(21.0, result[0]["shareability"])
        self.assertEqual(64.5, result[0]["total"])

    def test_supoclip_selection_discards_incomplete_cloud_scores(self):
        client = DashScopeMediaClient(api_key="test-key")
        client._request_json = lambda *_args, **_kwargs: {
            "choices": [{"message": {"content": json.dumps({
                "candidates": [{
                    "id": "c1",
                    "hook": 20,
                    "engagement": 18,
                    "value": 17,
                    # shareability is required; a local score must not fill it in.
                    "total": 90,
                }]
            })}}]
        }

        with self.assertRaises(ContentEngineError) as raised:
            client.rank_course_candidates(
                [{"id": "candidate-1", "duration_ms": 45_000, "transcript": "课程内容"}],
                "培训现场价值",
                experiment_mode="supoclip_bailian_v1",
            )

        self.assertEqual("cloud_scores_incomplete", raised.exception.code)

    def test_standard_course_selection_rejects_incomplete_cloud_scores(self):
        client = DashScopeMediaClient(api_key="test-key")
        client._request_json = lambda *_args, **_kwargs: {
            "choices": [{"message": {"content": json.dumps({
                "candidates": [{
                    "id": "c1",
                    "opening_hook": 0.8,
                    "standalone_value": 0.7,
                    "content_completeness": 0.9,
                    "language_quality": 0.8,
                    # theme_relevance is required; local defaults are forbidden.
                }]
            })}}]
        }

        with self.assertRaises(ContentEngineError) as raised:
            client.rank_course_candidates(
                [{"id": "candidate-1", "duration_ms": 45_000, "transcript": "课程内容"}],
                "培训现场价值",
            )

        self.assertEqual("cloud_scores_incomplete", raised.exception.code)


class FakeCreativeAnalyzer:
    def __init__(
        self,
        *,
        version="fixture-v1",
        only_role=None,
        on_analyze=None,
        on_motion_plan=None,
        fail_asset_ids=None,
    ):
        self.version = version
        self.only_role = only_role
        self.on_analyze = on_analyze
        self.on_motion_plan = on_motion_plan
        self.fail_asset_ids = set(fail_asset_ids or ())
        self.motion_plan_calls = 0
        self.analysis_profiles = []

    @property
    def capability(self):
        return {"available": True, "cloud_configured": True, "provider": "fixture"}

    def analyze(self, *, asset, source_path, task_id, profile, should_stop):
        del source_path
        self.analysis_profiles.append(dict(profile or {}))
        if should_stop():
            return {"stopped": True}
        if asset["id"] in self.fail_asset_ids:
            raise ContentEngineError("cloud_response_invalid", "百炼返回了无法解析的结果。")
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
                    "metadata": {
                        "sentence_complete": True,
                        "words": [
                            {
                                "text": f"第{index + 1}句",
                                "begin_time": start + 100,
                                "end_time": min(end, start + 900),
                                "confidence": 0.99,
                            }
                        ],
                    },
                }
            )
        return {
            "analysis_version": self.version,
            "provider": "fixture",
            "derivatives": [],
            "segments": sentences,
        }

    def plan_motion_events_batch(self, candidates):
        self.motion_plan_calls += 1
        if self.on_motion_plan:
            self.on_motion_plan()
        return {
            item["id"]: {
                "version": 1,
                "provider": "bailian",
                "model": "qwen-plus-fixture",
                "events": [{
                    "type": "hook",
                    "text": "先看真实课程重点",
                    "start_ms": 0,
                    "end_ms": min(2_200, int(item["duration_ms"])),
                    "zone": "top_banner",
                    "size": "hero",
                    "priority": 3,
                    "icon": "question",
                    "reason": "真实开场观点",
                }],
            }
            for item in candidates
        }


class FailingCourseRanker(FakeCreativeAnalyzer):
    def rank_course_windows(self, _windows, _theme):
        raise ContentEngineError("cloud_request_failed", "offline")


class PartialStandardCourseRanker(FakeCreativeAnalyzer):
    def rank_course_windows(self, windows, _theme):
        return [
            {
                "id": item["signature"],
                "opening_hook": 0.8,
                "standalone_value": 0.7,
                "content_completeness": 0.9,
                "language_quality": 0.8,
                # theme_relevance intentionally missing.
                "reason": ["字段不完整"],
            }
            for item in windows
        ]


class SupoClipEvidenceRanker(FakeCreativeAnalyzer):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.rank_calls = 0

    def rank_course_windows(self, windows, _theme, *, experiment_mode=None):
        if experiment_mode != "supoclip_bailian_v1":
            raise AssertionError("missing experiment mode")
        self.rank_calls += 1
        return [
            {
                "id": item["signature"],
                "hook": 999,
                "engagement": -4,
                "value": 18.5,
                "shareability": 21,
                "total": 99,
                "reason": ["开场可直接核验"],
            }
            for item in windows
        ]


class PartialSupoClipRanker(SupoClipEvidenceRanker):
    def rank_course_windows(self, windows, theme, *, experiment_mode=None):
        return super().rank_course_windows(
            windows, theme, experiment_mode=experiment_mode
        )[:4]


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

    def compose_cover(
        self, background_path, target_path, packaging, resolve_asset_path=None
    ):
        del packaging
        del resolve_asset_path
        Path(target_path).write_bytes(Path(background_path).read_bytes())
        return Path(target_path)


class ComparisonCreativeRenderer(FakeCreativeRenderer):
    def __init__(
        self,
        *,
        runtime_hash="runtime-manifest-v1",
        bundle_hash=None,
        on_render=None,
        failure=None,
    ):
        super().__init__(on_render=on_render)
        self.runtime_hash = runtime_hash
        self.bundle_hash = bundle_hash
        self.failure = failure
        self.rendered_styles = []
        self.capability_calls = 0

    @property
    def capability(self):
        self.capability_calls += 1
        return {
            "available": True,
            "remotion_packaging_v1": True,
            "remotion": {
                "available": True,
                "code": "ready",
                "runtime_hash": self.runtime_hash,
                "bundle_hash": self.bundle_hash,
                "runtime_hash_includes_bundle": True,
            },
        }

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        visual = recipe["packaging"]["visualRenderer"]
        if visual.get("allowFallback") is not False:
            raise AssertionError("visual comparisons must fail closed")
        self.rendered_styles.append(visual["visualStyleId"])
        if self.failure is not None:
            raise self.failure
        result = super().render(
            video_id=video_id,
            recipe=recipe,
            output_dir=output_dir,
            resolve_asset_path=resolve_asset_path,
        )
        visual.update(
            {
                "actualEngine": "remotion",
                "actualStyleVersion": visual["requestedStyleVersion"],
                "fallbackCode": None,
                "runtimeHash": self.runtime_hash,
            }
        )
        return result


class OrdinaryVisualRenderer(FakeCreativeRenderer):
    def __init__(self):
        super().__init__()
        self.rendered_visuals = []

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        visual = recipe["packaging"]["visualRenderer"]
        if visual.get("allowFallback") is not True:
            raise AssertionError("ordinary visual rendering must allow local fallback")
        self.rendered_visuals.append(dict(visual))
        result = super().render(
            video_id=video_id,
            recipe=recipe,
            output_dir=output_dir,
            resolve_asset_path=resolve_asset_path,
        )
        visual.update(
            {
                "actualEngine": "ffmpeg",
                "actualStyleVersion": None,
                "fallbackCode": "browser_unavailable",
            }
        )
        return result


class FakeCoverClient:
    configured = True

    def __init__(self, *, provider_task_id="provider-fixture", image=b"ai-cover"):
        self.provider_task_id = provider_task_id
        self.image = image
        self.submit_calls = []
        self.poll_calls = []
        self.download_calls = []
        self.reference_paths = []

    def submit(self, prompt, *, reference_path=None):
        self.submit_calls.append(prompt)
        self.reference_paths.append(
            str(Path(reference_path)) if reference_path is not None else None
        )
        return self.provider_task_id

    def poll(self, task_id, **_options):
        self.poll_calls.append(task_id)
        return "https://cdn.fixture/cover.png"

    def download(self, url, target):
        self.download_calls.append(url)
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.image)
        return target


class FirstUnknownCoverClient(FakeCoverClient):
    def submit(self, prompt, *, reference_path=None):
        self.submit_calls.append(prompt)
        self.reference_paths.append(
            str(Path(reference_path)) if reference_path is not None else None
        )
        return f"provider-{len(self.submit_calls)}"

    def poll(self, task_id, **_options):
        self.poll_calls.append(task_id)
        if len(self.poll_calls) == 1:
            raise APIMartOutcomeUnknown(task_id, "provider polling timed out")
        return "https://cdn.fixture/cover.png"


class FirstPollFailureCoverClient(FakeCoverClient):
    def submit(self, prompt, *, reference_path=None):
        self.submit_calls.append(prompt)
        self.reference_paths.append(
            str(Path(reference_path)) if reference_path is not None else None
        )
        return f"provider-{len(self.submit_calls)}"

    def poll(self, task_id, **_options):
        self.poll_calls.append(task_id)
        if len(self.poll_calls) == 1:
            raise APIMartError("temporary provider transport failure")
        return "https://cdn.fixture/cover.png"


class PausingCoverClient(FakeCoverClient):
    def __init__(self, on_poll):
        super().__init__()
        self.on_poll = on_poll

    def poll(self, task_id, *, should_stop=None, **_options):
        self.poll_calls.append(task_id)
        self.on_poll()
        if should_stop is not None and should_stop():
            raise APIMartPollingStopped("paused")
        return "https://cdn.fixture/cover.png"


class FailingDownloadCoverClient(FakeCoverClient):
    def download(self, url, target):
        self.download_calls.append(url)
        raise OSError("temporary download failure")


class FailSecondDownloadCoverClient(FakeCoverClient):
    def submit(self, prompt, *, reference_path=None):
        self.submit_calls.append(prompt)
        self.reference_paths.append(
            str(Path(reference_path)) if reference_path is not None else None
        )
        return f"provider-bulk-{len(self.submit_calls)}"

    def download(self, url, target):
        self.download_calls.append(url)
        if len(self.download_calls) == 2:
            raise OSError("second download failed")
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self.image)
        return target


class FailingComposeRenderer(FakeCreativeRenderer):
    def compose_cover(
        self, background_path, target_path, packaging, resolve_asset_path=None
    ):
        del background_path, target_path, packaging, resolve_asset_path
        raise OSError("temporary composition failure")


class BlockingCreativeAnalyzer(FakeCreativeAnalyzer):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()

    def analyze(self, *, should_stop, **kwargs):
        self.started.set()
        while not should_stop():
            time.sleep(0.005)
        return {"stopped": True}


class BlockingFFmpegCreativeRenderer(FFmpegCreativeRenderer):
    def __init__(self, data_dir):
        self.started = threading.Event()
        self.released = threading.Event()
        self.killed = []
        owner = self

        class Process:
            returncode = None

            def poll(self):
                return self.returncode

            def communicate(self, timeout=None):
                owner.started.set()
                if not owner.released.wait(timeout=timeout):
                    raise subprocess.TimeoutExpired("ffmpeg-fixture", timeout)
                return "", "cancelled"

            def kill(self):
                self.returncode = -9
                owner.released.set()

        self.process = Process()

        def kill_tree(process):
            self.killed.append(process)
            process.kill()

        super().__init__(
            data_dir,
            ffmpeg_path="ffmpeg-fixture",
            ffprobe_path="ffprobe-fixture",
            popen_factory=lambda *_args, **_options: self.process,
            process_tree_killer=kill_tree,
        )

    def render(self, **_kwargs):
        self.begin_task()
        self._command([self.ffmpeg_path, "-version"])
        raise AssertionError("cancelled FFmpeg render unexpectedly continued")


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

    def test_database_uses_full_synchronous_durability_for_paid_ledger(self):
        synchronous = self.service.connection.execute(
            "PRAGMA synchronous"
        ).fetchone()[0]
        self.assertEqual(2, synchronous)

    def _insert_asset(
        self, name, *, duration_ms=120_000, has_audio=True, media_kind="video"
    ):
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owned', ?, ?,
                          'ok', ?, 1080, 1920, 30, ?, ?)
                """,
                (
                    asset_id,
                    f"fingerprint-{asset_id}",
                    f"full-{asset_id}",
                    media_kind,
                    Path(name).suffix.lower(),
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

    def test_analysis_skips_one_unparseable_asset_and_finishes_remaining(self):
        bad_asset = self._insert_asset("bad-vision.mp4", duration_ms=30_000)
        good_asset = self._insert_asset("good-vision.mp4", duration_ms=30_000)
        self.service.creative_analyzer = FakeCreativeAnalyzer(
            fail_asset_ids={bad_asset}
        )
        self.service.creative_domain.analyzer = self.service.creative_analyzer

        task = self._run(self.service.analyze_assets([bad_asset, good_asset])["task_id"])

        self.assertEqual("completed", task["status"])
        self.assertEqual(1, task["analysis_summary"]["analyzed_count"])
        self.assertEqual(bad_asset, task["analysis_summary"]["skipped_assets"][0]["asset_id"])
        stored = self.service.connection.execute(
            "SELECT result_json FROM content_tasks WHERE id = ?", (task["task_id"],)
        ).fetchone()
        result = json.loads(stored["result_json"])
        self.assertEqual(1, result["analyzed_count"])
        self.assertEqual(2, result["requested_count"])
        self.assertEqual(bad_asset, result["skipped_assets"][0]["asset_id"])
        self.assertEqual("cloud_response_invalid", result["skipped_assets"][0]["error_code"])
        self.assertGreater(
            self.service.connection.execute(
                "SELECT COUNT(*) FROM media_segments WHERE asset_id = ?", (good_asset,)
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            0,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM media_segments WHERE asset_id = ?", (bad_asset,)
            ).fetchone()[0],
        )

    def _comparison_source(self):
        asset_id = self._insert_asset("comparison-source.mp4", duration_ms=180_000)
        self.assertEqual(
            "completed", self._run(self.service.analyze_assets([asset_id])["task_id"])["status"]
        )
        task = self.service.generate_course_cuts(
            asset_id, count=1, packaging_mode="auto", cover_mode="local_frame"
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        source = self.service.list_generated_videos(project_id=task["project_id"])[
            "items"
        ][0]
        # A style comparison is only meaningful when the source has a
        # completed, auditable AI-cover operation.  The fixture uses the local
        # image bytes already produced by the renderer, but records the same
        # completed provider receipt the production preflight requires.
        row = self.service.connection.execute(
            "SELECT recipe_json, output_path FROM generated_videos WHERE id = ?",
            (source["generated_video_id"],),
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        recipe["packaging"]["visualRenderer"] = {
            "requestedEngine": "remotion",
            "visualStyleId": "social_pop",
            "requestedStyleVersion": 1,
            "allowFallback": False,
            "actualEngine": "remotion",
            "actualStyleVersion": 1,
            "fallbackCode": None,
        }
        recipe["packaging"]["cover"].update({"mode": "ai_generate", "status": "completed"})
        self.service.connection.execute(
            "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
            (json.dumps(recipe, ensure_ascii=False, separators=(",", ":")), source["generated_video_id"]),
        )
        now = utc_now()
        self.service.connection.execute(
            """
            INSERT INTO cover_generation_ledger(
                id, generated_video_id, request_key, provider, status,
                estimated_calls, external_task_id, created_at, updated_at
            ) VALUES (?, ?, ?, 'apimart_gpt_image_2', 'completed', 1, ?, ?, ?)
            """,
            (
                f"cover_{source['generated_video_id']}",
                source["generated_video_id"],
                f"fixture:{source['generated_video_id']}",
                "fixture-provider-task",
                now,
                now,
            ),
        )
        media_digest = self.service.creative_domain._sha256_file(Path(row["output_path"]))
        self.service.connection.execute(
            """
            INSERT INTO creative_media_reviews(
                id, generated_video_id, device, verdict, reason, reviewer,
                media_digest, reviewed_at
            ) VALUES (?, ?, 'phone', 'pass', 'fixture phone review', 'fixture', ?, ?)
            """,
            (f"review_{source['generated_video_id']}", source["generated_video_id"], media_digest, now),
        )
        return task, source

    def _use_comparison_renderer(self, **options):
        renderer = ComparisonCreativeRenderer(**options)
        self.service.creative_renderer = renderer
        self.service.creative_domain.renderer = renderer
        return renderer

    def test_startup_ready_refreshes_visual_capability_snapshot_once(self):
        source_task, source = self._comparison_source()
        renderer = self._use_comparison_renderer()
        output = io.StringIO()

        serve_jsonl(self.service, input_stream=io.StringIO(""), output_stream=output)

        ready = json.loads(output.getvalue())
        self.assertTrue(ready["capabilities"]["visual_comparison_v1"])
        after_ready = renderer.capability_calls
        card = next(
            item for item in self.service.list_generated_videos(
                project_id=source_task["project_id"]
            )["items"]
            if item["generated_video_id"] == source["generated_video_id"]
        )
        self.assertTrue(card["visual_comparison_capable"])
        self.assertEqual(after_ready, renderer.capability_calls)

        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        before_poll = renderer.capability_calls
        listed = self.service.list_tasks(limit=2_000)["items"]
        self.assertTrue(any(
            task["task_id"] == comparison["task_id"]
            and task["visual_comparison_capable"]
            for task in listed
        ))
        self.assertEqual(before_poll, renderer.capability_calls)

    def test_visual_comparison_preflight_is_local_exact_and_fail_closed(self):
        _task, source = self._comparison_source()
        self._use_comparison_renderer()
        motion_calls = self.service.creative_analyzer.motion_plan_calls

        eligible = self.service.preflight_visual_comparison(
            source["generated_video_id"]
        )

        self.assertEqual(
            {
                "eligible": True,
                "reason": "ready",
                "renderCount": 3,
                "bailianCalls": 0,
                "apimartCalls": 0,
            },
            {key: eligible[key] for key in (
                "eligible", "reason", "renderCount", "bailianCalls", "apimartCalls"
            )},
        )
        self.assertTrue(eligible["remotionAvailable"])
        self.assertTrue(eligible["visualComparisonAvailable"])
        self.assertEqual(motion_calls, self.service.creative_analyzer.motion_plan_calls)

        self.service.creative_domain.renderer = ComparisonCreativeRenderer(
            runtime_hash=""
        )
        blocked = self.service.preflight_visual_comparison(
            source["generated_video_id"]
        )
        self.assertFalse(blocked["eligible"])
        self.assertEqual("comparison_runtime_hash_unavailable", blocked["reason"])
        before = self.service.connection.execute(
            "SELECT COUNT(*) FROM content_tasks"
        ).fetchone()[0]
        with self.assertRaises(ContentEngineError) as raised:
            self.service.create_visual_comparison_task(source["generated_video_id"])
        self.assertEqual("comparison_runtime_hash_unavailable", raised.exception.code)
        self.assertEqual(
            before,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM content_tasks"
            ).fetchone()[0],
        )

    def test_visual_comparison_requires_current_phone_acceptance(self):
        _task, source = self._comparison_source()
        self._use_comparison_renderer()
        self.service.connection.execute(
            "DELETE FROM creative_media_reviews WHERE generated_video_id = ?",
            (source["generated_video_id"],),
        )
        blocked = self.service.preflight_visual_comparison(source["generated_video_id"])
        self.assertFalse(blocked["eligible"])
        self.assertEqual("phone_review_required", blocked["reason"])

    def test_media_review_records_digest_and_rejects_stale_candidate(self):
        asset_id = self._insert_asset("phone-review.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        task = self.service.generate_course_cuts(asset_id, count=1, cover_mode="local_frame")
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        candidate = self.service.list_generated_videos(project_id=task["project_id"])["items"][0]
        review = self.service.record_media_review(
            candidate["generated_video_id"],
            device="phone",
            verdict="pass",
            reason="人物、字幕、音画同步通过",
            reviewer="Scott",
        )
        self.assertEqual("pass", review["verdict"])
        self.assertEqual(64, len(review["media_digest"]))
        self.assertEqual(1, len(self.service.list_media_reviews(candidate["generated_video_id"])["items"]))

    def test_visual_comparison_preflight_rejects_invalid_persisted_motion_plan(self):
        _task, source = self._comparison_source()
        self._use_comparison_renderer()
        row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE id = ?",
            (source["generated_video_id"],),
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        recipe["motion_director"]["version"] = 999
        self.service.connection.execute(
            "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
            (
                json.dumps(recipe, ensure_ascii=False, separators=(",", ":")),
                source["generated_video_id"],
            ),
        )
        before_candidates = self.service.connection.execute(
            "SELECT COUNT(*) FROM generated_videos"
        ).fetchone()[0]

        blocked = self.service.preflight_visual_comparison(
            source["generated_video_id"]
        )

        self.assertFalse(blocked["eligible"])
        self.assertEqual("motion_plan_version_unsupported", blocked["reason"])
        with self.assertRaises(ContentEngineError) as raised:
            self.service.create_visual_comparison_task(source["generated_video_id"])
        self.assertEqual("motion_plan_version_unsupported", raised.exception.code)
        self.assertEqual(
            before_candidates,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM generated_videos"
            ).fetchone()[0],
        )

    def test_visual_comparison_creates_three_new_styles_without_cloud_calls(self):
        source_task, source = self._comparison_source()
        renderer = self._use_comparison_renderer()
        motion_calls = self.service.creative_analyzer.motion_plan_calls
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client

        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        completed = self._run(comparison["task_id"])
        items = self.service.list_generated_videos(
            project_id=source_task["project_id"]
        )["items"]
        compared = [item for item in items if item["comparison_group_id"] == comparison["task_id"]]

        self.assertEqual("completed", completed["status"], completed)
        self.assertEqual(
            ["social_pop", "neo_editorial", "tech_motion"],
            renderer.rendered_styles,
        )
        self.assertEqual(3, len(compared))
        self.assertEqual(4, len(items))
        self.assertEqual("completed", next(
            item for item in items if item["generated_video_id"] == source["generated_video_id"]
        )["status"])
        self.assertEqual(
            {source["generated_video_id"]},
            {item["comparison_source_candidate_id"] for item in compared},
        )
        self.assertEqual(motion_calls, self.service.creative_analyzer.motion_plan_calls)
        self.assertEqual([], cover_client.submit_calls)
        self.assertEqual([], cover_client.poll_calls)
        self.assertTrue(all(item["actual_engine"] == "remotion" for item in compared))
        self.assertTrue(all(item["fallback_code"] is None for item in compared))
        before_listing = renderer.capability_calls
        self.service.list_generated_videos(project_id=source_task["project_id"])
        self.assertEqual(0, renderer.capability_calls - before_listing)
        persisted_visuals = [
            json.loads(row["recipe_json"])["packaging"]["visualRenderer"]
            for row in self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE task_id = ? ORDER BY generation",
                (comparison["task_id"],),
            ).fetchall()
        ]
        self.assertTrue(all(item["runtimeHash"] == "runtime-manifest-v1" for item in persisted_visuals))

        payload = json.loads(self.service.connection.execute(
            "SELECT payload_json FROM content_tasks WHERE id = ?", (comparison["task_id"],)
        ).fetchone()[0])
        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertEqual(comparison["task_id"], payload["comparison_group_id"])
        self.assertEqual(3, len(payload["entries"]))
        self.assertNotIn(str(self.sources), encoded)
        self.assertNotIn("secret", encoded.casefold())
        self.assertTrue(all(entry["cover_digest"] for entry in payload["entries"]))

    def test_task_list_uses_capability_snapshot_and_batches_comparison_candidates(self):
        _source_task, source = self._comparison_source()
        renderer = self._use_comparison_renderer()
        comparisons = [
            self.service.create_visual_comparison_task(source["generated_video_id"])
            for _index in range(2)
        ]
        renderer.capability_calls = 0
        statements = []
        self.service.connection.set_trace_callback(statements.append)
        try:
            tasks = self.service.list_tasks(limit=2_000)["items"]
        finally:
            self.service.connection.set_trace_callback(None)

        comparison_tasks = [
            task for task in tasks
            if task["task_id"] in {item["task_id"] for item in comparisons}
        ]
        candidate_queries = [
            statement for statement in statements
            if "FROM generated_videos WHERE id IN" in statement
        ]
        self.assertEqual(0, renderer.capability_calls)
        self.assertEqual(2, len(comparison_tasks))
        self.assertTrue(all(len(task["candidates"]) == 3 for task in comparison_tasks))
        self.assertEqual(1, len(candidate_queries))

    def test_visual_comparison_render_request_hash_ignores_actual_result_fields(self):
        _source_task, source = self._comparison_source()
        self._use_comparison_renderer()
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE task_id = ? ORDER BY generation LIMIT 1",
            (comparison["task_id"],),
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        visual = recipe["packaging"]["visualRenderer"]
        frozen_hash = visual["renderRequestHash"]

        visual.update({
            "actualEngine": "ffmpeg",
            "actualStyleVersion": 999,
            "fallbackCode": "worker_crashed",
            "runtimeHash": "different-runtime-result",
        })

        self.assertEqual(
            frozen_hash,
            self.service.creative_domain._render_request_hash(visual),
        )

    def test_visual_comparison_pause_and_resume_reuses_completed_candidate(self):
        _source_task, source = self._comparison_source()
        paused_once = set()

        def pause_after_first(_video_id):
            if not paused_once:
                paused_once.add(True)
                self.service.update_task(comparison["task_id"], "paused")

        first_renderer = self._use_comparison_renderer(on_render=pause_after_first)
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        first = self._run(comparison["task_id"])
        completed_before = self.service.connection.execute(
            "SELECT id FROM generated_videos WHERE task_id = ? AND status = 'completed'",
            (comparison["task_id"],),
        ).fetchall()

        self.assertEqual("paused", first["status"])
        self.assertEqual(1, len(completed_before))
        first_id = completed_before[0]["id"]
        self.service.close()
        second_renderer = ComparisonCreativeRenderer()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=second_renderer,
            start_background_jobs=False,
        )
        self.service.resume_creative_task(comparison["task_id"])
        self.assertEqual("completed", self._run(comparison["task_id"])["status"])
        completed_after = self.service.connection.execute(
            "SELECT id FROM generated_videos WHERE task_id = ? AND status = 'completed'",
            (comparison["task_id"],),
        ).fetchall()

        self.assertEqual(3, len(completed_after))
        self.assertIn(first_id, {row["id"] for row in completed_after})
        self.assertEqual(1, len(first_renderer.rendered_styles))
        self.assertEqual(2, len(second_renderer.rendered_styles))

    def test_visual_comparison_cancel_stops_after_candidate_boundary(self):
        _source_task, source = self._comparison_source()
        cancelled_once = set()

        def cancel_after_first(_video_id):
            if not cancelled_once:
                cancelled_once.add(True)
                self.service.update_task(comparison["task_id"], "cancelled")

        renderer = self._use_comparison_renderer(on_render=cancel_after_first)
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        cancelled = self._run(comparison["task_id"])

        self.assertEqual("cancelled", cancelled["status"])
        self.assertEqual(1, len(renderer.rendered_styles))
        self.assertEqual(
            1,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM generated_videos WHERE task_id = ? AND status = 'completed'",
                (comparison["task_id"],),
            ).fetchone()[0],
        )

    def test_visual_comparison_runtime_change_pauses_without_rendering(self):
        _source_task, source = self._comparison_source()
        renderer = self._use_comparison_renderer(runtime_hash="runtime-v1")
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        renderer.runtime_hash = "runtime-v2"

        paused = self._run(comparison["task_id"])

        self.assertEqual("paused", paused["status"])
        self.assertEqual("comparison_runtime_hash_mismatch", paused["error_code"])
        self.assertEqual([], renderer.rendered_styles)

    def test_visual_comparison_render_failure_does_not_create_fallback_outputs(self):
        _source_task, source = self._comparison_source()
        renderer = self._use_comparison_renderer(
            failure=ContentEngineError("remotion_worker_crashed", "local failure")
        )
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )

        failed = self._run(comparison["task_id"])
        items = self.service.list_generated_videos()["items"]
        compared = [item for item in items if item["comparison_group_id"] == comparison["task_id"]]

        self.assertEqual("failed", failed["status"])
        self.assertEqual(1, len(renderer.rendered_styles))
        self.assertFalse(any(item["actual_engine"] == "ffmpeg" for item in compared))
        self.assertFalse(any(item["status"] == "completed" for item in compared))

    def test_generated_and_task_public_contracts_redact_visual_recipe_details(self):
        _source_task, source = self._comparison_source()
        self._use_comparison_renderer()
        comparison = self.service.create_visual_comparison_task(
            source["generated_video_id"]
        )
        self.assertEqual("completed", self._run(comparison["task_id"])["status"])
        public_candidate = next(
            item for item in self.service.list_generated_videos()["items"]
            if item["comparison_group_id"] == comparison["task_id"]
        )
        public_task = next(
            item for item in self.service.list_tasks(limit=2_000)["items"]
            if item["task_id"] == comparison["task_id"]
        )
        legacy = next(
            item for item in self.service.list_generated_videos()["items"]
            if item["generated_video_id"] == source["generated_video_id"]
        )

        self.assertEqual("remotion", public_candidate["requested_engine"])
        self.assertEqual("remotion", public_candidate["actual_engine"])
        self.assertTrue(public_candidate["render_request_hash"])
        self.assertEqual(comparison["task_id"], public_task["comparison_group_id"])
        self.assertEqual("remotion", legacy["requested_engine"])
        self.assertEqual("remotion", legacy["actual_engine"])
        legacy_row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE id = ?",
            (source["generated_video_id"],),
        ).fetchone()
        fallback_recipe = json.loads(legacy_row["recipe_json"])
        fallback_recipe["packaging"]["visualRenderer"] = {
            "requestedEngine": "remotion",
            "visualStyleId": "social_pop",
            "requestedStyleVersion": 1,
            "actualEngine": "ffmpeg",
            "actualStyleVersion": None,
            "fallbackCode": "browser_unavailable",
            "renderRequestHash": "opaque-request-hash",
        }
        self.service.connection.execute(
            "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
            (
                json.dumps(fallback_recipe, ensure_ascii=False, separators=(",", ":")),
                source["generated_video_id"],
            ),
        )
        fallback = next(
            item for item in self.service.list_generated_videos()["items"]
            if item["generated_video_id"] == source["generated_video_id"]
        )
        self.assertEqual("remotion", fallback["requested_engine"])
        self.assertEqual("ffmpeg", fallback["actual_engine"])
        self.assertEqual("browser_unavailable", fallback["fallback_code"])
        public_json = json.dumps(
            {"candidate": public_candidate, "task": public_task}, ensure_ascii=False
        )
        self.assertNotIn("recipe", public_json.casefold())
        self.assertNotIn(str(self.sources), public_json)

    def test_service_waits_for_creative_job_join_before_closing_renderer_and_database(self):
        events = []

        class JoinedCreativeJobs:
            def close(self):
                events.append("jobs_joined")

        class OrderedRenderer(FakeCreativeRenderer):
            def cancel(self):
                events.append("renderer_cancelled")

            def close(self, timeout_seconds=3.0):
                del timeout_seconds
                self.connection.execute("SELECT 1").fetchone()
                self.assert_joined()
                events.append("renderer_closed")

            def assert_joined(self):
                if "jobs_joined" not in events:
                    raise AssertionError("renderer closed before creative jobs joined")

        renderer = OrderedRenderer()
        renderer.connection = self.service.connection
        self.service.creative_renderer = renderer
        self.service._creative_jobs = JoinedCreativeJobs()

        self.service.close()

        self.assertEqual(
            ["renderer_cancelled", "jobs_joined", "renderer_closed"], events
        )
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=False,
        )

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

    def test_brand_profiles_persist_opaque_asset_ids_and_never_publish_paths(self):
        logo_id = self._insert_asset(
            "brand-logo.png", has_audio=False, media_kind="image"
        )
        profile = self.service.save_brand_profile(
            {
                "name": "客户轻品牌",
                "logo_asset_id": logo_id,
                "primary_color": "#6D5DFB",
                "accent_color": "#FFE45C",
                "font_preset": "microsoft_yahei",
                "outro_text": "关注我们",
            }
        )

        restarted_id = profile["brand_profile_id"]
        self.service.close()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            start_background_jobs=False,
        )
        persisted = self.service.list_brand_profiles()["items"]

        self.assertEqual(restarted_id, persisted[0]["brand_profile_id"])
        self.assertEqual(logo_id, persisted[0]["logo_asset_id"])
        self.assertNotIn(str(self.sources), json.dumps(persisted, ensure_ascii=False))

    def test_packaging_validation_rejects_cross_kind_preset_and_bad_brand_color(self):
        asset_id = self._insert_asset("invalid-packaging.mp4", duration_ms=180_000)
        with self.assertRaises(ContentEngineError) as preset_error:
            self.service.generate_course_cuts(
                asset_id,
                packaging_mode="preset",
                packaging_preset_id="hook_impact",
            )
        with self.assertRaises(ContentEngineError) as color_error:
            self.service.save_brand_profile(
                {"name": "坏颜色", "primary_color": "purple"}
            )
        with self.assertRaises(ContentEngineError) as logo_error:
            self.service.save_brand_profile(
                {"name": "错误 Logo", "logo_asset_id": asset_id}
            )

        self.assertEqual("invalid_packaging_preset", preset_error.exception.code)
        self.assertEqual("invalid_primary_color", color_error.exception.code)
        self.assertEqual("invalid_logo", logo_error.exception.code)

    def test_course_generation_persists_auto_packaging_recipe_and_four_scores(self):
        asset_id = self._insert_asset("packaged-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.generate_course_cuts(
            asset_id,
            count=3,
            packaging_mode="auto",
            cover_mode="local_frame",
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        rows = self.service.connection.execute(
            "SELECT recipe_json, score_json FROM generated_videos WHERE project_id = ? ORDER BY rowid",
            (task["project_id"],),
        ).fetchall()

        self.assertEqual(3, len(rows))
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)
        self.assertEqual(
            ["knowledge_focus", "slide_teacher", "classroom_value"],
            [json.loads(row["recipe_json"])["packaging"]["preset_id"] for row in rows],
        )
        for row in rows:
            recipe = json.loads(row["recipe_json"])
            score = json.loads(row["score_json"])
            self.assertEqual(1, recipe["packaging"]["version"])
            self.assertTrue(recipe["packaging"]["events"])
            self.assertEqual("bailian", recipe["packaging"]["director"]["provider"])
            self.assertEqual("先看真实课程重点", recipe["packaging"]["events"][0]["text"])
            self.assertEqual("local_frame", recipe["packaging"]["cover"]["mode"])
            self.assertTrue(
                {"hook", "engagement", "value", "shareability", "virality_total"}
                .issubset(score)
            )

    def test_repackage_clones_content_without_cloud_calls_and_reuses_cover(self):
        asset_id = self._insert_asset("repackage-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        original_task = self.service.generate_course_cuts(asset_id, count=1)
        self._run(original_task["task_id"])
        original = self.service.list_generated_videos(
            project_id=original_task["project_id"]
        )["items"][0]
        calls_before_repackage = self.service.creative_analyzer.motion_plan_calls

        task = self.service.repackage_video(
            original["generated_video_id"],
            {"packaging_preset_id": "slide_teacher", "reuse_cover": True},
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        versions = self.service.list_generated_videos(
            project_id=original_task["project_id"]
        )["items"]
        new = max(versions, key=lambda item: item["generation"])

        self.assertEqual(2, new["generation"])
        self.assertEqual(original["source_start_ms"], new["source_start_ms"])
        self.assertEqual(original["source_end_ms"], new["source_end_ms"])
        self.assertEqual("slide_teacher", new["packaging_preset_id"])
        self.assertEqual("reused", new["cover_status"])
        self.assertEqual(calls_before_repackage, self.service.creative_analyzer.motion_plan_calls)
        new_recipe = json.loads(self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE id = ?", (new["generated_video_id"],)
        ).fetchone()[0])
        self.assertEqual("bailian", new_recipe["packaging"]["director"]["provider"])

    def test_singleton_auto_repackage_rotates_to_the_next_course_preset(self):
        asset_id = self._insert_asset("rotate-packaging.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self.assertEqual("completed", self._run(generated["task_id"])["status"])
        current = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]
        seen = [current["packaging_preset_id"]]

        for _index in range(3):
            task = self.service.repackage_video(
                current["generated_video_id"],
                {"packaging_mode": "auto", "reuse_cover": True},
            )
            self.assertEqual("completed", self._run(task["task_id"])["status"])
            current = max(
                self.service.list_generated_videos(
                    project_id=generated["project_id"]
                )["items"],
                key=lambda item: item["generation"],
            )
            seen.append(current["packaging_preset_id"])

        self.assertEqual(
            [
                "knowledge_focus",
                "slide_teacher",
                "classroom_value",
                "knowledge_focus",
            ],
            seen,
        )

    def test_repackage_restores_words_for_historical_unpackaged_recipe(self):
        asset_id = self._insert_asset("historical-caption.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(
            asset_id, count=1, packaging_mode="none", cover_mode="none"
        )
        self.assertEqual("completed", self._run(generated["task_id"])["status"])
        original = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]
        original_recipe = json.loads(
            self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE id = ?",
                (original["generated_video_id"],),
            ).fetchone()[0]
        )
        self.assertNotIn("words", original_recipe["captions"][0])

        task = self.service.repackage_video(
            original["generated_video_id"],
            {"packaging_mode": "auto", "reuse_cover": True},
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        latest = self.service.connection.execute(
            """
            SELECT recipe_json FROM generated_videos
            WHERE project_id = ? ORDER BY generation DESC LIMIT 1
            """,
            (generated["project_id"],),
        ).fetchone()
        recipe = json.loads(latest["recipe_json"])

        self.assertEqual("knowledge_course", recipe["subtitle_style"]["preset"])
        self.assertTrue(recipe["captions"][0]["words"])

    def test_bulk_fresh_ai_cover_repackage_resumes_partial_batch_without_resubmit(self):
        asset_id = self._insert_asset("bulk-cover-repackage.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=2)
        self.assertEqual("completed", self._run(generated["task_id"])["status"])
        source_ids = [
            item["generated_video_id"]
            for item in self.service.list_generated_videos(
                project_id=generated["project_id"]
            )["items"]
        ]
        failing_client = FailSecondDownloadCoverClient()
        self.service.creative_domain.cover_client = failing_client
        packaging = self.service.package_generated_videos(
            source_ids,
            {
                "packaging_mode": "auto",
                "cover_mode": "ai_generate",
                "reuse_cover": False,
            },
        )

        paused = self._run(packaging["task_id"])
        self.assertEqual("paused", paused["status"])
        self.assertEqual(2, len(failing_client.submit_calls))
        ledger = self.service.connection.execute(
            "SELECT status, external_task_id FROM cover_generation_ledger ORDER BY rowid"
        ).fetchall()
        self.assertEqual(["completed", "submitted"], [row["status"] for row in ledger])

        resumed_client = FakeCoverClient()
        self.service.creative_domain.cover_client = resumed_client
        resumed = self.service.resume_creative_task(packaging["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        self.assertEqual([], resumed_client.submit_calls)
        self.assertEqual(["provider-bulk-2"], resumed_client.poll_calls)
        self.assertTrue(
            all(
                row["status"] == "completed"
                for row in self.service.connection.execute(
                    "SELECT status FROM cover_generation_ledger ORDER BY rowid"
                ).fetchall()
            )
        )

    def test_packaging_cost_estimate_counts_only_explicit_ai_cover_requests(self):
        estimate = self.service.get_packaging_cost_estimate(
            ["candidate-1", "candidate-2", "candidate-1"],
            cover_mode="ai_generate",
        )
        local = self.service.get_packaging_cost_estimate(
            ["candidate-1", "candidate-2"], cover_mode="local_frame"
        )

        self.assertEqual(2, estimate["estimated_image_calls"])
        self.assertEqual(0, local["estimated_image_calls"])
        self.assertFalse(estimate["provider_configured"])

        planned = self.service.get_packaging_cost_estimate(
            [], cover_mode="ai_generate", planned_count=5
        )
        self.assertEqual(5, planned["candidate_count"])
        self.assertEqual(5, planned["estimated_image_calls"])
        self.assertFalse(planned["provider_configured"])

    def test_generation_cost_estimate_explains_bailian_stages_and_confirmation(self):
        asset_id = self._insert_asset("cost-breakdown.mp4", duration_ms=180_000)
        estimate = self.service.get_packaging_cost_estimate(
            [],
            cover_mode="local_frame",
            planned_count=1,
            asset_ids=[asset_id],
            generation_kind="course",
        )

        self.assertEqual(4, estimate["bailian_calls"])
        self.assertTrue(estimate["bailian_provider_configured"])
        self.assertTrue(estimate["confirmation_required"])
        self.assertEqual(
            ["speech_to_text", "visual_understanding", "selection_scoring", "motion_direction"],
            [item["operation"] for item in estimate["bailian_breakdown"]],
        )
        self.assertTrue(all("estimated_calls" in item for item in estimate["bailian_breakdown"]))

        task = self.service.generate_course_cuts(
            asset_id,
            count=1,
            cover_mode="local_frame",
            confirm_paid_calls=True,
        )
        settings = json.loads(
            self.service.connection.execute(
                "SELECT settings_json FROM creative_projects WHERE id = ?",
                (task["project_id"],),
            ).fetchone()[0]
        )
        self.assertTrue(settings["paid_call_confirmation"])

    def test_regenerate_cover_reserves_one_exact_once_paid_operation(self):
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_id = self._insert_asset("cover-ledger.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated_task = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated_task["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated_task["project_id"]
        )["items"][0]["generated_video_id"]

        first = self.service.regenerate_cover(candidate_id)
        self.assertEqual("completed", self._run(first["task_id"])["status"])
        repeated = self.service.regenerate_cover(candidate_id)
        self.assertEqual("completed", self._run(repeated["task_id"])["status"])
        rows = self.service.connection.execute(
            "SELECT * FROM cover_generation_ledger WHERE generated_video_id = ?",
            (candidate_id,),
        ).fetchall()

        self.assertNotEqual(first["task_id"], repeated["task_id"])
        self.assertNotEqual(first["cover_operation_id"], repeated["cover_operation_id"])
        self.assertTrue(all(row["status"] == "completed" for row in rows))
        self.assertEqual(2, len(cover_client.submit_calls))
        self.assertEqual(2, len(rows))

    def test_duplicate_regenerate_cover_before_execution_reuses_one_operation(self):
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_id = self._insert_asset("cover-duplicate.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]

        first = self.service.regenerate_cover(candidate_id)
        duplicate = self.service.regenerate_cover(candidate_id)

        self.assertEqual(first["task_id"], duplicate["task_id"])
        self.assertEqual(first["cover_operation_id"], duplicate["cover_operation_id"])
        self.assertTrue(duplicate["reused_operation"])
        self.assertEqual("completed", self._run(first["task_id"])["status"])
        self.assertEqual(1, len(cover_client.submit_calls))
        self.assertEqual(
            1,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM cover_generation_ledger WHERE generated_video_id = ?",
                (candidate_id,),
            ).fetchone()[0],
        )

    def test_initial_ai_cover_and_each_explicit_redo_submit_exactly_once(self):
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_id = self._insert_asset("cover-revisions.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(
            asset_id, count=1, cover_mode="ai_generate"
        )
        self.assertEqual("completed", self._run(generated["task_id"])["status"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]

        first_redo = self.service.regenerate_cover(candidate_id)
        self.assertEqual("completed", self._run(first_redo["task_id"])["status"])
        # Reopening resumes persisted work; it must not submit completed tasks again.
        self.service.close()
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=FakeCreativeRenderer(),
            creative_cover_client=cover_client,
            start_background_jobs=False,
        )
        self.assertEqual("completed", self._run(first_redo["task_id"])["status"])
        second_redo = self.service.regenerate_cover(candidate_id)
        self.assertEqual("completed", self._run(second_redo["task_id"])["status"])

        rows = self.service.connection.execute(
            "SELECT status FROM cover_generation_ledger WHERE generated_video_id = ?",
            (candidate_id,),
        ).fetchall()
        self.assertEqual(3, len(rows))
        self.assertEqual(3, len(cover_client.submit_calls))
        self.assertTrue(all(row["status"] == "completed" for row in rows))

    def test_ai_cover_generation_reserves_one_ledger_row_per_candidate_before_network(self):
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_id = self._insert_asset("ai-cover-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        task = self.service.generate_course_cuts(
            asset_id, count=2, cover_mode="ai_generate"
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        operations = self.service.connection.execute(
            "SELECT status, estimated_calls FROM cover_generation_ledger ORDER BY rowid"
        ).fetchall()

        self.assertEqual(2, len(operations))
        self.assertTrue(all(row["status"] == "completed" for row in operations))
        self.assertTrue(all(row["estimated_calls"] == 1 for row in operations))
        self.assertEqual(2, len(cover_client.submit_calls))

    def test_ai_cover_uses_only_an_imported_image_reference_without_exposing_path(self):
        cover_client = FakeCoverClient()
        self.service.creative_domain.cover_client = cover_client
        portrait_id = self._insert_asset(
            "teacher-reference.png", has_audio=False, media_kind="image"
        )
        brand = self.service.save_brand_profile(
            {"name": "老师品牌", "reference_portrait_asset_id": portrait_id}
        )
        course_id = self._insert_asset("reference-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([course_id])["task_id"])

        task = self.service.generate_course_cuts(
            course_id,
            count=1,
            cover_mode="ai_generate",
            brand_profile_id=brand["brand_profile_id"],
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        public = self.service.list_generated_videos(project_id=task["project_id"])

        self.assertEqual(1, len(cover_client.reference_paths))
        self.assertTrue(cover_client.reference_paths[0].endswith("teacher-reference.png"))
        self.assertNotIn(str(self.sources), json.dumps(public, ensure_ascii=False))

    def test_product_ai_cover_uses_highest_quality_selected_keyframe(self):
        asset_id = self._insert_asset(
            "cleaning-robot.mp4", duration_ms=30_000, has_audio=False
        )
        derivative_dir = self.data_dir / "derivatives" / "product-cover"
        derivative_dir.mkdir(parents=True, exist_ok=True)
        low_path = derivative_dir / "low.jpg"
        best_path = derivative_dir / "best.jpg"
        low_path.write_bytes(b"low-frame")
        best_path.write_bytes(b"best-frame")
        now = utc_now()
        with self.service.database.transaction() as connection:
            for derivative_id, path, ordinal, timestamp in (
                ("derivative_low", low_path, 0, 2_000),
                ("derivative_best", best_path, 1, 12_000),
            ):
                connection.execute(
                    """
                    INSERT INTO asset_derivatives(
                        id, asset_id, derivative_kind, ordinal, config_hash,
                        relative_path, status, metadata_json, created_at, updated_at
                    ) VALUES (?, ?, 'keyframe', ?, 'product-v1', ?, 'ready', ?, ?, ?)
                    """,
                    (
                        derivative_id,
                        asset_id,
                        ordinal,
                        str(path.relative_to(self.data_dir)).replace("\\", "/"),
                        json.dumps({"timestamp_ms": timestamp}),
                        now,
                        now,
                    ),
                )
            for segment_id, derivative_id, quality, tags, start, end in (
                # Deliberately swap the persisted thumbnail IDs to emulate an
                # old cached manifest. Selection must recover by timestamp.
                ("segment_low", "derivative_best", 0.42, ["use_scene"], 0, 8_000),
                (
                    "segment_best",
                    "derivative_low",
                    0.94,
                    ["product_closeup", "product_detail"],
                    8_000,
                    18_000,
                ),
            ):
                connection.execute(
                    """
                    INSERT INTO media_segments(
                        id, asset_id, start_ms, end_ms, transcript_text, speaker,
                        role, shot_type, tags_json, quality_score,
                        thumbnail_derivative_id, analysis_version, provider,
                        metadata_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, '', '', 'process', 'product', ?, ?, ?,
                              'product-v1', 'fixture', '{}', ?, ?)
                    """,
                    (
                        segment_id,
                        asset_id,
                        start,
                        end,
                        json.dumps(tags, ensure_ascii=False),
                        quality,
                        derivative_id,
                        now,
                        now,
                    ),
                )
        recipe = {
            "product_workflow": "one_click_v1",
            "visual_segments": [{"asset_id": asset_id, "start_ms": 0, "end_ms": 20_000}],
            "packaging": {"cover": {"mode": "ai_generate"}},
        }

        selected = self.service.creative_domain._cover_reference_path(recipe)

        self.assertEqual(best_path.resolve(), selected.resolve())
        self.assertEqual(
            "derivative_best",
            recipe["packaging"]["cover"]["reference_derivative_id"],
        )
        self.assertNotIn(str(self.data_dir), json.dumps(recipe, ensure_ascii=False))

    def test_product_cover_unknown_does_not_abort_remaining_video_candidates(self):
        cover_client = FirstUnknownCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_ids = [
            self._insert_asset(
                f"visual-product-{index}.mp4",
                duration_ms=30_000,
                has_audio=False,
            )
            for index in range(3)
        ]
        project = self.service.create_one_click_project(
            "商品封面容错",
            asset_ids,
            {
                "brief": {},
                "target_count": 3,
                "duration_ms": 60_000,
                "cover_mode": "ai_generate",
            },
        )
        task = self.service.generate_one_click_candidates(
            project["project_id"],
            {"target_count": 3, "duration_ms": 60_000},
        )

        completed = self._run(task["task_id"])
        candidates = self.service.list_one_click_candidates(project["project_id"])["items"]
        ledger = self.service.connection.execute(
            "SELECT status, error_code FROM cover_generation_ledger ORDER BY rowid"
        ).fetchall()

        self.assertEqual("completed", completed["status"], completed)
        self.assertEqual(3, len(candidates))
        self.assertEqual(3, len(cover_client.submit_calls))
        recipes = [
            json.loads(row["recipe_json"])
            for row in self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE project_id = ? ORDER BY rowid",
                (project["project_id"],),
            ).fetchall()
        ]
        self.assertTrue(
            all(
                recipe.get("product_workflow") == "one_click_v1"
                and recipe.get("packaging", {}).get("cover", {}).get("status")
                in {"completed", "outcome_unknown"}
                for recipe in recipes
            ),
            recipes,
        )
        self.assertEqual(
            ["outcome_unknown", "completed", "completed"],
            [row["status"] for row in ledger],
            [dict(row) for row in ledger],
        )
        unknown = next(item for item in candidates if item["cover_status"] == "outcome_unknown")
        self.assertEqual("outcome_unknown", unknown["cover_phase"])
        self.assertTrue(unknown["cover_network_submitted"])
        self.assertEqual("poll_outcome_unknown", unknown["cover_issue_code"])
        self.assertNotIn("external_task_id", unknown)

    def test_product_cover_poll_failure_can_resume_without_another_submit(self):
        cover_client = FirstPollFailureCoverClient()
        self.service.creative_domain.cover_client = cover_client
        asset_ids = [
            self._insert_asset(
                f"recoverable-product-{index}.mp4",
                duration_ms=30_000,
                has_audio=False,
            )
            for index in range(3)
        ]
        project = self.service.create_one_click_project(
            "商品封面恢复",
            asset_ids,
            {
                "brief": {},
                "target_count": 3,
                "duration_ms": 60_000,
                "cover_mode": "ai_generate",
            },
        )
        task = self.service.generate_one_click_candidates(
            project["project_id"],
            {"target_count": 3, "duration_ms": 60_000},
        )

        completed = self._run(task["task_id"])
        candidates = self.service.list_one_click_candidates(project["project_id"])["items"]
        recoverable_items = [
            item for item in candidates if item["cover_phase"] == "recovery_required"
        ]

        self.assertEqual("completed", completed["status"], completed)
        self.assertEqual(3, len(candidates))
        self.assertEqual(3, len(cover_client.submit_calls))
        self.assertEqual(
            1,
            len(recoverable_items),
            [
                {
                    "status": item["cover_status"],
                    "phase": item["cover_phase"],
                    "issue": item["cover_issue_code"],
                }
                for item in candidates
            ],
        )
        recoverable = recoverable_items[0]
        self.assertEqual("submitted", recoverable["cover_status"])
        self.assertEqual("cover_poll_failed", recoverable["cover_issue_code"])
        self.assertTrue(recoverable["cover_network_submitted"])

        resume = self.service.regenerate_cover(recoverable["generated_video_id"])
        self.assertTrue(resume["reused_operation"])
        resumed = self._run(resume["task_id"])
        refreshed = self.service.list_one_click_candidates(project["project_id"])["items"]
        restored = next(
            item
            for item in refreshed
            if item["generated_video_id"] == recoverable["generated_video_id"]
        )

        self.assertEqual("completed", resumed["status"])
        self.assertEqual(3, len(cover_client.submit_calls))
        self.assertEqual("completed", restored["cover_status"])
        self.assertEqual("completed", restored["cover_phase"])

    def test_outcome_unknown_cover_operation_is_terminal_and_cannot_be_resubmitted(self):
        asset_id = self._insert_asset("unknown-cover.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        task = self.service.generate_course_cuts(asset_id, count=1)
        self._run(task["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=task["project_id"]
        )["items"][0]["generated_video_id"]
        operation = self.service.regenerate_cover(candidate_id)

        unknown = self.service.update_cover_operation(
            operation["cover_operation_id"], "outcome_unknown"
        )
        with self.assertRaises(ContentEngineError) as raised:
            self.service.update_cover_operation(
                operation["cover_operation_id"], "submitted"
            )

        self.assertEqual("outcome_unknown", unknown["status"])
        self.assertEqual("invalid_cover_operation_transition", raised.exception.code)

    def test_cover_recovery_polls_existing_provider_task_without_resubmitting(self):
        cover_client = FakeCoverClient(provider_task_id="must-not-submit")
        self.service.creative_domain.cover_client = cover_client
        asset_id = self._insert_asset("cover-recovery.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]
        task = self.service.regenerate_cover(candidate_id)
        self.service.update_cover_operation(
            task["cover_operation_id"],
            "submitted",
            external_task_id="provider-existing",
        )

        self.assertEqual("completed", self._run(task["task_id"])["status"])
        self.assertEqual([], cover_client.submit_calls)
        self.assertEqual(["provider-existing"], cover_client.poll_calls)

    def test_paused_cover_poll_keeps_submitted_ledger_and_resume_only_polls(self):
        asset_id = self._insert_asset("cover-pause.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]
        cover_task = self.service.regenerate_cover(candidate_id)
        self.service.update_cover_operation(
            cover_task["cover_operation_id"],
            "submitted",
            external_task_id="provider-existing",
        )
        pausing_client = PausingCoverClient(
            lambda: self.service.update_task(cover_task["task_id"], "paused")
        )
        self.service.creative_domain.cover_client = pausing_client

        paused = self._run(cover_task["task_id"])
        ledger = self.service.connection.execute(
            "SELECT status, external_task_id FROM cover_generation_ledger WHERE id = ?",
            (cover_task["cover_operation_id"],),
        ).fetchone()
        self.assertEqual("paused", paused["status"])
        self.assertEqual("submitted", ledger["status"])
        self.assertEqual("provider-existing", ledger["external_task_id"])

        resumed_client = FakeCoverClient()
        self.service.creative_domain.cover_client = resumed_client
        self.service.update_task(cover_task["task_id"], "queued")
        self.assertEqual("completed", self._run(cover_task["task_id"])["status"])
        self.assertEqual([], resumed_client.submit_calls)
        self.assertEqual(["provider-existing"], resumed_client.poll_calls)

    def test_cancel_submitted_cover_pauses_and_redo_reuses_original_task(self):
        asset_id = self._insert_asset("cover-cancel.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]
        cover_task = self.service.regenerate_cover(candidate_id)
        self.service.update_cover_operation(
            cover_task["cover_operation_id"],
            "submitted",
            external_task_id="provider-cancelled-wait",
        )

        cancelled = self.service.update_task(cover_task["task_id"], "cancelled")
        self.assertEqual("paused", cancelled["status"])
        self.assertEqual("cover_submission_inflight", cancelled["error_code"])

        reused = self.service.regenerate_cover(candidate_id)
        self.assertEqual(cover_task["task_id"], reused["task_id"])
        self.assertEqual(cover_task["cover_operation_id"], reused["cover_operation_id"])
        self.assertTrue(reused["reused_operation"])
        self.assertEqual("queued", reused["status"])

        resumed_client = FakeCoverClient()
        self.service.creative_domain.cover_client = resumed_client
        self.assertEqual("completed", self._run(reused["task_id"])["status"])
        self.assertEqual([], resumed_client.submit_calls)
        self.assertEqual(["provider-cancelled-wait"], resumed_client.poll_calls)

    def test_cover_download_failure_pauses_and_resume_does_not_resubmit(self):
        asset_id = self._insert_asset("cover-download-retry.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]
        failing_client = FailingDownloadCoverClient(
            provider_task_id="provider-download-existing"
        )
        self.service.creative_domain.cover_client = failing_client
        cover_task = self.service.regenerate_cover(candidate_id)

        paused = self._run(cover_task["task_id"])
        self.assertEqual("paused", paused["status"])
        self.assertEqual("cover_download_failed", paused["error_code"])
        self.assertEqual(1, len(failing_client.submit_calls))

        resumed_client = FakeCoverClient()
        self.service.creative_domain.cover_client = resumed_client
        resumed = self.service.resume_creative_task(cover_task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        self.assertEqual([], resumed_client.submit_calls)
        self.assertEqual(["provider-download-existing"], resumed_client.poll_calls)

    def test_cover_composition_failure_pauses_and_resume_does_not_resubmit(self):
        asset_id = self._insert_asset("cover-compose-retry.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        generated = self.service.generate_course_cuts(asset_id, count=1)
        self._run(generated["task_id"])
        candidate_id = self.service.list_generated_videos(
            project_id=generated["project_id"]
        )["items"][0]["generated_video_id"]
        cover_client = FakeCoverClient(provider_task_id="provider-compose-existing")
        self.service.creative_domain.cover_client = cover_client
        self.service.creative_domain.renderer = FailingComposeRenderer()
        cover_task = self.service.regenerate_cover(candidate_id)

        paused = self._run(cover_task["task_id"])
        self.assertEqual("paused", paused["status"])
        self.assertEqual("cover_composition_failed", paused["error_code"])
        self.assertEqual(1, len(cover_client.submit_calls))

        resumed_client = FakeCoverClient()
        self.service.creative_domain.cover_client = resumed_client
        self.service.creative_domain.renderer = FakeCreativeRenderer()
        resumed = self.service.resume_creative_task(cover_task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        self.assertEqual([], resumed_client.submit_calls)
        self.assertEqual(["provider-compose-existing"], resumed_client.poll_calls)

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

    def test_shutdown_cancels_active_ffmpeg_before_worker_database_closes(self):
        asset_id = self._insert_asset("shutdown-render.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        self.service.close()

        renderer = BlockingFFmpegCreativeRenderer(self.data_dir)
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=renderer,
            start_background_jobs=True,
        )
        task = self.service.generate_course_cuts(
            asset_id,
            count=1,
            packaging_mode="none",
            cover_mode="none",
        )
        self.assertTrue(renderer.started.wait(timeout=2))

        started = time.monotonic()
        self.service.close()
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual([renderer.process], renderer.killed)

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

    def test_user_cancellation_stops_the_active_ffmpeg_process(self):
        asset_id = self._insert_asset("cancel-render.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        self.service.close()

        renderer = BlockingFFmpegCreativeRenderer(self.data_dir)
        self.service = ContentEngineService(
            self.data_dir,
            creative_analyzer=FakeCreativeAnalyzer(),
            creative_renderer=renderer,
            start_background_jobs=True,
        )
        task = self.service.generate_course_cuts(
            asset_id,
            count=1,
            packaging_mode="none",
            cover_mode="none",
        )
        self.assertTrue(renderer.started.wait(timeout=2))

        cancelled = self.service.update_task(task["task_id"], "cancelled")
        self.assertEqual("cancelled", cancelled["status"])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            persisted = next(
                item
                for item in self.service.list_tasks(limit=2_000)["items"]
                if item["task_id"] == task["task_id"]
            )
            if renderer.killed:
                break
            time.sleep(0.01)

        self.assertEqual([renderer.process], renderer.killed)
        self.assertEqual("cancelled", persisted["status"])

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

    def test_pause_during_motion_planning_persists_plan_without_creating_outputs(self):
        asset_id = self._insert_asset("pause-motion-plan.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        analyzer = FakeCreativeAnalyzer(
            on_motion_plan=lambda: self.service.update_task(task["task_id"], "paused")
        )
        self.service.creative_domain.analyzer = analyzer

        task = self.service.generate_course_cuts(asset_id, count=3)
        first = self._run(task["task_id"])

        self.assertEqual("paused", first["status"])
        self.assertEqual(1, analyzer.motion_plan_calls)
        self.assertEqual(
            [], self.service.list_generated_videos(project_id=task["project_id"])["items"]
        )
        self.assertEqual(
            "paused", self.service.get_creative_project(task["project_id"])["status"]
        )

        analyzer.on_motion_plan = None
        resumed = self.service.resume_creative_task(task["task_id"])

        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        self.assertEqual(1, analyzer.motion_plan_calls)

    def test_unknown_motion_request_outcome_is_not_automatically_resubmitted(self):
        asset_id = self._insert_asset("unknown-motion-plan.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        task = self.service.generate_course_cuts(asset_id, count=3)
        payload = json.loads(self.service.connection.execute(
            "SELECT payload_json FROM content_tasks WHERE id = ?", (task["task_id"],)
        ).fetchone()[0])
        payload["motion_plan_request"] = {
            "status": "submitted",
            "expected": ["unknown-after-restart"],
        }
        self.service.connection.execute(
            "UPDATE content_tasks SET payload_json = ? WHERE id = ?",
            (json.dumps(payload), task["task_id"]),
        )

        finished = self._run(task["task_id"])

        self.assertEqual("failed", finished["status"])
        self.assertEqual("cloud_motion_plan_outcome_unknown", finished["error_code"])
        self.assertEqual(0, self.service.creative_analyzer.motion_plan_calls)

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
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)
        self.assertEqual(
            "paused", self.service.get_creative_project(task["project_id"])["status"]
        )
        before = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(5, len(before))
        completed_before = [item for item in before if item["status"] == "completed"]
        self.assertEqual(1, len(completed_before))
        first_id = completed_before[0]["generated_video_id"]

        self.service.creative_domain.renderer = FakeCreativeRenderer()
        resumed = self.service.resume_creative_task(task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        after = self.service.list_generated_videos(project_id=task["project_id"])["items"]
        self.assertEqual(5, len(after))
        self.assertIn(first_id, {item["generated_video_id"] for item in after})
        self.assertTrue(all(item["generation"] == 1 for item in after))
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)

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

    def test_visual_analysis_continues_when_asr_fails_and_records_audio_status(self):
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-asr-visual-fallback-"))
        source = root / "product.mp4"
        source.write_bytes(b"fixture")
        calls = []

        def fake_ffmpeg(args, **_kwargs):
            Path(args[-1]).write_bytes(b"fixture")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        class Cloud:
            configured = True
            asr_model = "asr-fixture"
            vision_model = "vision-fixture"

            def transcribe(self, _audio_path, _should_stop):
                raise ContentEngineError("cloud_transcription_failed", "fixture ASR failed")

            def understand_frames(self, frames, **_kwargs):
                calls.append(frames)
                return [
                    {
                        "timestamp_ms": 1_000,
                        "role": "process",
                        "shot_type": "equipment",
                        "tags": ["cleaning_robot"],
                        "caption": "清洁机器人在地面移动",
                        "quality": 0.86,
                    }
                ]

        analyzer = FFmpegCreativeAnalyzer(
            root / "data",
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=Cloud(),
            command_runner=fake_ffmpeg,
        )
        try:
            outcome = analyzer.analyze(
                asset={
                    "id": "asset-product",
                    "fingerprint": "fingerprint-product",
                    "media_kind": "video",
                    "duration_ms": 30_000,
                    "has_audio": True,
                },
                source_path=source,
                task_id="task-product",
                profile={"product_context": {"product_name": "清洁机器人"}},
                should_stop=lambda: False,
            )
            self.assertEqual("failed", outcome["audio"]["speech_status"])
            self.assertEqual("source_audio_unclassified", outcome["audio"]["audio_mode"])
            self.assertEqual(1, len(calls))
            self.assertTrue(any(item["metadata"].get("visual_caption") for item in outcome["segments"]))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_generation_uses_the_same_effective_provider_profile_as_analysis(self):
        analyzer = FakeCreativeAnalyzer()
        self.service.creative_domain.analyzer = analyzer
        asset_id = self._insert_asset("profile-consistency.mp4", duration_ms=180_000)

        self.assertEqual(
            "completed", self._run(self.service.analyze_assets([asset_id])["task_id"])["status"]
        )
        task = self.service.generate_course_cuts(asset_id, count=1)
        self.assertEqual("completed", self._run(task["task_id"])["status"])

        self.assertGreaterEqual(len(analyzer.analysis_profiles), 2)
        self.assertEqual({"provider": "fixture"}, analyzer.analysis_profiles[0])
        self.assertEqual({"provider": "fixture"}, analyzer.analysis_profiles[-1])

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
        self.assertTrue(all(item["source_asset_id"] == asset_id for item in videos))
        self.assertNotIn(str(self.sources), json.dumps(videos, ensure_ascii=False))
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

    def test_public_generated_video_exposes_safe_recipe_evidence_only(self):
        first_asset_id = self._insert_asset("evidence-first.mp4", duration_ms=180_000)
        second_asset_id = self._insert_asset("evidence-second.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([first_asset_id])["task_id"])
        task = self.service.generate_course_cuts(first_asset_id, count=1)
        self.assertEqual("completed", self._run(task["task_id"])["status"])

        row = self.service.connection.execute(
            "SELECT id, recipe_json FROM generated_videos WHERE project_id = ? LIMIT 1",
            (task["project_id"],),
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        recipe["visual_segments"] = [
            {"asset_id": first_asset_id, "start_ms": 0, "end_ms": 2_000},
            {"asset_id": first_asset_id, "start_ms": 2_000, "end_ms": 4_000},
            {"asset_id": second_asset_id, "start_ms": 0, "end_ms": 2_000},
        ]
        recipe["captions"] = [
            {
                "text": "真实配音字幕",
                "start_ms": 0,
                "end_ms": 1_000,
                "caption_source": "tts_voiceover",
            }
        ]
        with self.service.database.transaction() as connection:
            connection.execute(
                "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
                (json.dumps(recipe, ensure_ascii=False), row["id"]),
            )

        public = self.service.list_generated_videos(project_id=task["project_id"])[
            "items"
        ][0]
        self.assertEqual(2, public["source_asset_count"])
        self.assertEqual(3, public["shot_count"])
        self.assertEqual("tts_voiceover", public["caption_source"])
        self.assertNotIn("visual_segments", public)
        self.assertNotIn("captions", public)
        self.assertNotIn("recipe_json", public)

        recipe["captions"][0]["caption_source"] = "source_transcript"
        with self.service.database.transaction() as connection:
            connection.execute(
                "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
                (json.dumps(recipe, ensure_ascii=False), row["id"]),
            )
        public = self.service.list_generated_videos(project_id=task["project_id"])[
            "items"
        ][0]
        self.assertEqual("source_transcript", public["caption_source"])

        recipe["captions"] = []
        with self.service.database.transaction() as connection:
            connection.execute(
                "UPDATE generated_videos SET recipe_json = ? WHERE id = ?",
                (json.dumps(recipe, ensure_ascii=False), row["id"]),
            )
        public = self.service.list_generated_videos(project_id=task["project_id"])[
            "items"
        ][0]
        self.assertEqual("none", public["caption_source"])

    def test_ordinary_course_generation_persists_visual_request_and_fallback(self):
        asset_id = self._insert_asset("visual-course.mp4", duration_ms=180_000)
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        renderer = OrdinaryVisualRenderer()
        self.service.creative_domain.renderer = renderer

        task = self.service.generate_course_cuts(
            asset_id,
            count=3,
            visual_renderer={
                "requestedEngine": "remotion",
                "requestedStyleVersion": 1,
                "allowFallback": True,
            },
        )
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        self.assertEqual(
            ["social_pop", "neo_editorial", "tech_motion"],
            [item["visualStyleId"] for item in renderer.rendered_visuals],
        )
        videos = self.service.list_generated_videos(project_id=task["project_id"])[
            "items"
        ]
        self.assertTrue(all(item["requested_engine"] == "remotion" for item in videos))
        self.assertTrue(all(item["actual_engine"] == "ffmpeg" for item in videos))
        self.assertTrue(
            all(item["fallback_code"] == "browser_unavailable" for item in videos)
        )
        recipes = [
            json.loads(row[0])
            for row in self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE project_id = ? ORDER BY rowid",
                (task["project_id"],),
            ).fetchall()
        ]
        for recipe in recipes:
            visual = recipe["packaging"]["visualRenderer"]
            self.assertTrue(visual["allowFallback"])
            self.assertEqual(64, len(visual["semanticPlanHash"]))
            self.assertEqual(64, len(visual["renderRequestHash"]))

    def test_mix_task_preserves_explicit_visual_style_request(self):
        asset_id = self._insert_asset("visual-mix.mp4")
        task = self.service.generate_mix_batch(
            [asset_id],
            target_count=1,
            voice_asset_id=asset_id,
            visual_renderer={
                "requestedEngine": "remotion",
                "visualStyleId": "tech_motion",
                "requestedStyleVersion": 1,
                "allowFallback": True,
            },
        )
        row = self.service.connection.execute(
            "SELECT payload_json FROM content_tasks WHERE id = ?", (task["task_id"],)
        ).fetchone()
        self.assertEqual(
            "tech_motion", json.loads(row[0])["visual_renderer"]["visualStyleId"]
        )

    def test_visual_renderer_request_is_strict_and_requires_packaging(self):
        asset_id = self._insert_asset("visual-invalid.mp4")
        invalid_requests = [
            {
                "requestedEngine": "remotion",
                "visualStyleId": "unknown",
                "requestedStyleVersion": 1,
                "allowFallback": True,
            },
            {
                "requestedEngine": "remotion",
                "requestedStyleVersion": 1,
                "allowFallback": "yes",
            },
            {
                "requestedEngine": "remotion",
                "requestedStyleVersion": 1,
                "allowFallback": True,
                "sourcePath": "C:\\must-not-pass",
            },
        ]
        for request in invalid_requests:
            with self.subTest(request=request):
                with self.assertRaises(ContentEngineError) as raised:
                    self.service.generate_course_cuts(
                        asset_id, visual_renderer=request, cover_mode="local_frame"
                    )
                self.assertEqual("invalid_visual_renderer", raised.exception.code)
        with self.assertRaises(ContentEngineError) as confirmation_error:
            self.service.generate_course_cuts(
                asset_id,
                visual_renderer={
                    "requestedEngine": "remotion",
                    "requestedStyleVersion": 1,
                    "allowFallback": False,
                },
                cover_mode="local_frame",
            )
        self.assertEqual("paid_calls_confirmation_required", confirmation_error.exception.code)
        with self.assertRaises(ContentEngineError) as raised:
            self.service.generate_course_cuts(
                asset_id,
                packaging_mode="none",
                cover_mode="none",
                visual_renderer={
                    "requestedEngine": "remotion",
                    "requestedStyleVersion": 1,
                    "allowFallback": True,
                },
            )
        self.assertEqual("invalid_visual_renderer", raised.exception.code)

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

    def test_standard_course_rejects_partial_bailian_editor_scores(self):
        asset_id = self._insert_asset("editor-partial.mp4", duration_ms=180_000)
        self.service.creative_domain.analyzer = PartialStandardCourseRanker()
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.generate_course_cuts(asset_id, count=2)
        finished = self._run(task["task_id"])

        self.assertEqual("failed", finished["status"])
        self.assertEqual("course_editor_scores_incomplete", finished["error_code"])
        self.assertEqual(
            [],
            self.service.list_generated_videos(project_id=task["project_id"])["items"],
        )

    def test_supoclip_course_scores_use_four_bounded_cloud_dimensions(self):
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
            self.assertEqual(18.5, score["value"])
            self.assertEqual(21.0, score["shareability"])
            self.assertEqual(64.5, score["virality_total"])
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
            count=5,
            experiment_mode="supoclip_bailian_v1",
            subtitle_preset="energetic_talking",
        )
        finished = self._run(task["task_id"])

        self.assertEqual("completed", finished["status"])
        rows = self.service.connection.execute(
            "SELECT recipe_json, score_json FROM generated_videos WHERE project_id = ?",
            (task["project_id"],),
        ).fetchall()
        self.assertEqual(5, len(rows))
        for row in rows:
            recipe = json.loads(row["recipe_json"])
            score = json.loads(row["score_json"])
            self.assertEqual("supoclip_bailian_v1", recipe["experiment_mode"])
            self.assertEqual("energetic_talking", recipe["subtitle_style"]["preset"])
            self.assertEqual("supoclip_bailian_editor", score["selection_engine"])

    def test_supoclip_course_requires_exactly_five_candidates(self):
        asset_id = self._insert_asset("supoclip-partial.mp4", duration_ms=180_000)
        self.service.creative_domain.analyzer = PartialSupoClipRanker()
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.creative_domain.create_course_task(
            asset_id,
            count=5,
            experiment_mode="supoclip_bailian_v1",
            subtitle_preset="knowledge_course",
        )
        finished = self._run(task["task_id"])

        self.assertEqual("failed", finished["status"])
        self.assertEqual("insufficient_ai_candidates", finished["error_code"])
        self.assertEqual(
            [], self.service.list_generated_videos(project_id=task["project_id"])["items"]
        )

    def test_supoclip_course_rejects_non_five_request(self):
        asset_id = self._insert_asset("supoclip-count.mp4", duration_ms=180_000)

        with self.assertRaises(ContentEngineError) as raised:
            self.service.creative_domain.create_course_task(
                asset_id,
                count=4,
                experiment_mode="supoclip_bailian_v1",
                subtitle_preset="knowledge_course",
            )

        self.assertEqual("invalid_experiment_count", raised.exception.code)

    def test_supoclip_resume_renders_persisted_plan_without_second_paid_ranking(self):
        asset_id = self._insert_asset("supoclip-resume.mp4", duration_ms=180_000)
        analyzer = SupoClipEvidenceRanker()
        self.service.creative_domain.analyzer = analyzer
        self._run(self.service.analyze_assets([asset_id])["task_id"])
        paused_once = set()

        def pause_after_render(_video_id):
            if not paused_once:
                paused_once.add(True)
                self.service.update_task(task["task_id"], "paused")

        self.service.creative_domain.renderer = FakeCreativeRenderer(
            on_render=pause_after_render
        )
        task = self.service.creative_domain.create_course_task(
            asset_id,
            count=5,
            experiment_mode="supoclip_bailian_v1",
            subtitle_preset="knowledge_course",
        )
        self.assertEqual("paused", self._run(task["task_id"])["status"])
        self.assertEqual(1, analyzer.motion_plan_calls)
        self.assertEqual(1, analyzer.rank_calls)
        self.assertEqual(
            5,
            len(self.service.list_generated_videos(project_id=task["project_id"])["items"]),
        )

        self.service.creative_domain.renderer = FakeCreativeRenderer()
        resumed = self.service.resume_creative_task(task["task_id"])
        self.assertEqual("completed", self._run(resumed["task_id"])["status"])
        self.assertEqual(1, analyzer.rank_calls)
        self.assertEqual(1, analyzer.motion_plan_calls)

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
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)
        recipes = [
            json.loads(row[0])
            for row in self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE project_id = ?", (task["project_id"],)
            ).fetchall()
        ]
        self.assertTrue(all(recipe["packaging"]["director"]["provider"] == "bailian" for recipe in recipes))

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

    def test_mix_pilot_uses_available_segments_before_strict_role_gate(self):
        asset_id = self._insert_asset("pilot-single-upload.mp4", duration_ms=120_000)
        self.service.creative_domain.analyzer = FakeCreativeAnalyzer(only_role="hook")
        self._run(self.service.analyze_assets([asset_id])["task_id"])

        task = self.service.generate_mix_batch(
            [asset_id], target_count=1, voice_asset_id=asset_id, pilot_mode=True
        )
        payload = json.loads(
            self.service.connection.execute(
                "SELECT payload_json FROM content_tasks WHERE id = ?", (task["task_id"],)
            ).fetchone()[0]
        )
        self.assertTrue(payload["pilot_mode"])
        self.assertEqual("completed", self._run(task["task_id"])["status"])
        project = self.service.get_creative_project(task["project_id"])
        self.assertEqual(1, project["generated_count"])
        self.assertEqual(["process", "result"], project["missing_roles"])
        video = self.service.list_generated_videos(project_id=task["project_id"])["items"][0]
        self.assertEqual("completed", video["status"])

    def test_mix_pilot_uses_probed_source_when_transcription_is_unavailable(self):
        asset_ids = [
            self._insert_asset(f"pilot-no-asr-{index}.mp4", duration_ms=12_000 + index * 1_000)
            for index in range(3)
        ]
        self.service.creative_domain.analyzer = FakeCreativeAnalyzer(
            fail_asset_ids=set(asset_ids)
        )

        task = self.service.generate_mix_batch(
            asset_ids, target_count=1, voice_asset_id=asset_ids[0], pilot_mode=True
        )
        finished = self._run(task["task_id"])
        self.assertEqual("completed", finished["status"])
        project = self.service.get_creative_project(task["project_id"])
        self.assertEqual(1, project["generated_count"])
        self.assertIn("转写", project["pilot_notice"])
        recipe = json.loads(
            self.service.connection.execute(
                "SELECT recipe_json FROM generated_videos WHERE project_id = ?",
                (task["project_id"],),
            ).fetchone()[0]
        )
        self.assertEqual("visual_montage", recipe["layout"])
        self.assertEqual("visual_montage", recipe["audio_mode"])
        self.assertEqual(36_000, recipe["voice_segment"]["end_ms"])
        self.assertEqual(
            len(recipe["visual_segments"]),
            len({item["segment_id"] for item in recipe["visual_segments"]}),
        )
        self.assertTrue(
            all(item["target_duration_ms"] <= 12_000 for item in recipe["visual_segments"])
        )

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
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)
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
        self.assertEqual(1, self.service.creative_analyzer.motion_plan_calls)

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
            "list_packaging_presets",
            "list_brand_profiles",
            "save_brand_profile",
            "package_generated_videos",
            "repackage_video",
            "preflight_visual_comparison",
            "create_visual_comparison_task",
            "get_packaging_cost_estimate",
            "regenerate_cover",
            "update_cover_operation",
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
                "packaging_mode": "preset",
                "packaging_preset_id": "knowledge_focus",
                "brand_profile_id": "brand_fixture",
                "cover_mode": "ai_generate",
            },
        )

        self.assertEqual({"task_id": "task_fixture"}, result)
        self.assertEqual("supoclip_bailian_v1", captured["experiment_mode"])
        self.assertEqual("energetic_talking", captured["subtitle_preset"])
        self.assertEqual("preset", captured["packaging_mode"])
        self.assertEqual("knowledge_focus", captured["packaging_preset_id"])
        self.assertEqual("brand_fixture", captured["brand_profile_id"])
        self.assertEqual("ai_generate", captured["cover_mode"])


class ProductGenerationGuardTests(unittest.TestCase):
    @staticmethod
    def _script_with_text(text):
        return {
            "title_candidates": [text],
            "hook": text,
            "voiceover": text,
            "shots": [{"asset_id": "asset-1", "asset_tags": [], "caption": text, "action": "show"}],
            "cta": text,
            "bgm_mood": "clean",
            "provider": "bailian",
        }

    def test_product_copy_retries_identity_conflict_once_then_blocks(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "brief": {"product_name": "清洁扫地机器人", "industry": "清洁机器人"},
            "product_assets": [{"asset_id": "asset-1", "tags": ["cleaning_robot"]}],
            "target_count": 1,
        }
        calls = []
        cloud = SimpleNamespace(
            configured=True,
            generate_product_script=lambda brief, assets, count: (
                calls.append(dict(brief))
                or self._script_with_text("这是一台洗碗机")
            ),
        )
        domain.analyzer = SimpleNamespace(cloud_client=cloud)
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: None
        domain._set_task = lambda *args, **kwargs: None
        with self.assertRaises(ContentEngineError) as raised:
            domain._run_product_copy("task-1", {"project_id": "project-1"})
        self.assertEqual("product_category_mismatch", raised.exception.code)
        self.assertEqual(2, len(calls))
        self.assertIn("identity_lock", calls[1])
        self.assertEqual("blocked_mismatch", settings["copy_status"])

    def test_product_cover_prompt_uses_locked_product_context_not_classroom_copy(self):
        prompt = CreativeDomain._cover_prompt(
            {"title": "无人清洁机器人真实作业"},
            {
                "product_workflow": "one_click_v1",
                "product_context": {
                    "industry": "清洁机器人",
                    "brand_name": "玺联惠",
                    "product_name": "无人清洁机器人",
                    "selling_points": "自动作业、室外清扫",
                    "target_customer": "物业和工厂",
                    "avoid": "洗碗机、厨房、餐具",
                },
                "product_script": {
                    "shots": [
                        {"caption": "机器人在工厂通道完成清扫", "asset_tags": ["function_demo"]}
                    ]
                },
                "packaging": {
                    "title": "无人清洁机器人真实作业",
                    "cover": {"reference_derivative_id": "derivative_best"},
                    "brand": {"primary_color": "#6D5DFB", "accent_color": "#FFE45C"},
                },
            },
        )

        self.assertIn("无人清洁机器人", prompt)
        self.assertIn("自动作业、室外清扫", prompt)
        self.assertIn("机器人在工厂通道完成清扫", prompt)
        self.assertIn("洗碗机、厨房、餐具", prompt)
        self.assertNotIn("training-video", prompt)
        self.assertNotIn("classroom", prompt)

    def test_segment_thumbnail_uses_nearest_frame_ordinal(self):
        segments = FFmpegCreativeAnalyzer._segments(
            30_000,
            [
                {
                    "start_ms": 18_000,
                    "end_ms": 24_000,
                    "transcript": "",
                    "speaker": "",
                    "metadata": {},
                }
            ],
            [
                {
                    "timestamp_ms": 20_000,
                    "quality": 0.9,
                    "role": "process",
                    "shot_type": "product",
                    "tags": ["product_closeup"],
                    "caption": "产品特写",
                }
            ],
            [
                {"path": Path("frame-0.jpg"), "timestamp_ms": 2_000},
                {"path": Path("frame-1.jpg"), "timestamp_ms": 10_000},
                {"path": Path("frame-2.jpg"), "timestamp_ms": 20_000},
            ],
        )

        self.assertEqual(2, segments[0]["metadata"]["keyframe_ordinal"])

    def test_visual_only_voice_phase_does_not_create_silent_audio(self):
        domain = object.__new__(CreativeDomain)
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-visual-only-"))
        settings = {
            "workflow": "product_one_click",
            "voice_mode": "none",
            "voice_status": "not_requested",
            "product_script": {"voice_mode": "none", "voiceover": ""},
            "product_assets": [],
        }
        saved = []
        domain.data_dir = root
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: saved.append(dict(value))
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                synthesize_product_voice=mock.Mock(side_effect=AssertionError("TTS must not run")),
            )
        )
        try:
            result = domain._run_product_voice("task-1", {"project_id": "project-1"})
            self.assertEqual("not_requested", result["voice_status"])
            self.assertEqual("not_requested", settings["voice_status"])
            self.assertIsNone(settings["voice_audio_path"])
            self.assertFalse(list(root.rglob("*.wav")))
            self.assertTrue(saved)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_generic_visual_evidence_requests_tts_without_inventing_product_identity(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "brief": {},
            "target_count": 1,
            "product_assets": [{
                "asset_id": "asset-1",
                "media_kind": "video",
                "tags": ["function_demo"],
                "visual_evidence": ["设备在地面移动"],
                "audio_mode": "no_audio",
            }],
        }
        script = self._script_with_text("设备在真实场景中完成一次效果展示")
        calls = []
        cloud = SimpleNamespace(
            configured=True,
            generate_product_script=lambda brief, assets, count: (
                calls.append((brief, assets, count)) or dict(script)
            ),
        )
        domain.analyzer = SimpleNamespace(cloud_client=cloud)
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: None
        domain._set_task = lambda *args, **kwargs: None

        result = domain._run_product_copy("task-1", {"project_id": "project-1"})

        self.assertTrue(result["script_ready"])
        self.assertEqual(1, len(calls))
        self.assertEqual("tts", settings["voice_mode"])
        self.assertEqual("ai", settings["copy_mode"])
        self.assertEqual("pending", settings["voice_status"])

    def test_sparse_source_speech_does_not_disable_tts_for_the_whole_video(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "brief": {"product_name": "无人清洁机器人"},
            "target_count": 1,
            "product_assets": [{
                "asset_id": "asset-1",
                "media_kind": "video",
                "duration_ms": 60_000,
                "tags": ["function_demo"],
                "visual_evidence": ["机器人在地面移动"],
                "audio_mode": "source_voice",
                "speech_status": "recognized",
                "transcript_segments": [
                    {"start_ms": 1_000, "end_ms": 3_000, "text": "开始清扫"},
                ],
            }],
        }
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                generate_product_script=lambda brief, assets, count: self._script_with_text(
                    "无人清洁机器人在真实场景中自动完成清扫"
                ),
            )
        )
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: None
        domain._set_task = lambda *args, **kwargs: None

        domain._run_product_copy("task-1", {"project_id": "project-1"})

        self.assertEqual("tts", settings["voice_mode"])
        self.assertEqual("pending", settings["voice_status"])
        self.assertEqual(2_000, settings["audio_strategy"]["recognized_speech_ms"])
        self.assertEqual(60_000, settings["audio_strategy"]["source_media_ms"])
        self.assertAlmostEqual(2_000 / 60_000, settings["audio_strategy"]["source_coverage"])
        self.assertEqual("source_speech_below_threshold", settings["audio_strategy"]["reason"])

    def test_dominant_source_speech_keeps_source_voice(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "brief": {"product_name": "无人清洁机器人"},
            "target_count": 1,
            "product_assets": [{
                "asset_id": "asset-1",
                "media_kind": "video",
                "duration_ms": 60_000,
                "tags": ["function_demo"],
                "visual_evidence": ["机器人在地面移动"],
                "audio_mode": "source_voice",
                "speech_status": "recognized",
                "transcript_segments": [
                    {"start_ms": 0, "end_ms": 30_000, "text": "第一段讲解"},
                    # The overlap must be counted once: union is 45 seconds.
                    {"start_ms": 20_000, "end_ms": 45_000, "text": "第二段讲解"},
                ],
            }],
        }
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                generate_product_script=lambda brief, assets, count: self._script_with_text(
                    "这段生成文案不应覆盖完整的素材原声"
                ),
            )
        )
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: None
        domain._set_task = lambda *args, **kwargs: None

        domain._run_product_copy("task-1", {"project_id": "project-1"})

        self.assertEqual("source_voice", settings["voice_mode"])
        self.assertEqual("not_requested", settings["voice_status"])
        self.assertEqual(45_000, settings["audio_strategy"]["recognized_speech_ms"])
        self.assertEqual(0.75, settings["audio_strategy"]["source_coverage"])
        self.assertEqual("source_narration_dominant", settings["audio_strategy"]["reason"])

    def test_source_voice_is_preserved_and_never_synthesized(self):
        domain = object.__new__(CreativeDomain)
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-source-voice-"))
        settings = {
            "workflow": "product_one_click",
            "voice_mode": "source_voice",
            "voice_status": "pending",
            "product_script": {"voice_mode": "source_voice", "voiceover": ""},
            "product_assets": [],
        }
        saved = []
        domain.data_dir = root
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: saved.append(dict(value))
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                synthesize_product_voice=mock.Mock(side_effect=AssertionError("source voice must be kept")),
            )
        )
        try:
            result = domain._run_product_voice("task-1", {"project_id": "project-1"})
            self.assertEqual("not_requested", result["voice_status"])
            self.assertEqual("source_voice", settings["voice_mode"])
            self.assertEqual("source_voice_preserved", settings["voice_metadata"]["reason"])
            self.assertTrue(saved)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_asr_failure_with_trusted_script_uses_tts_instead_of_claiming_source_voice(self):
        domain = object.__new__(CreativeDomain)
        root = Path(tempfile.mkdtemp(prefix="xiaoxi-source-audio-"))
        settings = {
            "workflow": "product_one_click",
            "brief": {},
            "target_count": 1,
            "product_assets": [{
                "asset_id": "asset-1",
                "media_kind": "video",
                "tags": ["function_demo"],
                "visual_evidence": ["设备在地面移动"],
                "audio_mode": "source_audio_unclassified",
                "speech_status": "failed",
            }],
        }
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                generate_product_script=lambda brief, assets, count: self._script_with_text("设备在真实场景中完成一次效果展示"),
            )
        )
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: None
        domain._set_task = lambda *args, **kwargs: None
        result = domain._run_product_copy("task-1", {"project_id": "project-1"})
        self.assertTrue(result["script_ready"])
        self.assertEqual("tts", settings["voice_mode"])
        self.assertEqual("pending", settings["voice_status"])
        self.assertEqual("source_audio_unconfirmed", settings["audio_strategy"]["reason"])
        shutil.rmtree(root, ignore_errors=True)

    def test_tts_failure_stops_before_any_candidate_is_inserted(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "brief": {"product_name": "无人清洁机器人"},
            "product_assets": [{"asset_id": "asset-1", "media_kind": "video"}],
            "product_script": self._script_with_text("自动完成清扫"),
            "voice_mode": "tts",
            "voice_status": "pending",
        }
        domain._product_settings = lambda _project_id: (None, settings)
        domain._update_project = lambda *args, **kwargs: None
        domain._should_stop = lambda _task_id: False
        domain._insert_generated = mock.Mock()

        def fail_voice(_task_id, _payload):
            settings["voice_status"] = "failed"
            settings["voice_metadata"] = {
                "provider": "bailian",
                "error_code": "cloud_request_failed",
                "error_message": "\u767e\u70bc\u4e2d\u6587\u914d\u97f3\u8bf7\u6c42\u88ab\u62d2\u7edd\uff08HTTP 403\uff09\u3002",
            }
            return {"voice_status": "failed"}

        domain._run_product_voice = fail_voice

        with self.assertRaises(ContentEngineError) as raised:
            domain._run_product_generation(
                "task-1", {"project_id": "project-1", "target_count": 3}
            )

        self.assertEqual("cloud_request_failed", raised.exception.code)
        self.assertEqual(
            "\u767e\u70bc\u4e2d\u6587\u914d\u97f3\u8bf7\u6c42\u88ab\u62d2\u7edd\uff08HTTP 403\uff09\u3002",
            raised.exception.message,
        )
        domain._insert_generated.assert_not_called()

    def test_tts_provider_failure_is_persisted_for_project_diagnostics(self):
        domain = object.__new__(CreativeDomain)
        root = Path(
            tempfile.mkdtemp(
                prefix=".xiaoxi-product-voice-error-", dir=SIDECAR_ROOT
            )
        )
        settings = {
            "workflow": "product_one_click",
            "voice_mode": "tts",
            "voice_status": "pending",
            "product_script": self._script_with_text("\u81ea\u52a8\u5b8c\u6210\u6e05\u626b"),
            "product_assets": [],
        }
        saved = []
        domain.data_dir = root
        domain._product_settings = lambda _project_id: (None, settings)
        domain._save_product_settings = lambda _project_id, value: saved.append(
            dict(value)
        )
        domain.analyzer = SimpleNamespace(
            cloud_client=SimpleNamespace(
                configured=True,
                synthesize_product_voice=mock.Mock(
                    side_effect=ContentEngineError(
                        "cloud_request_failed",
                        "\u767e\u70bc\u4e2d\u6587\u914d\u97f3\u8bf7\u6c42\u88ab\u62d2\u7edd\uff08HTTP 403\uff09\u3002",
                    )
                ),
            )
        )

        try:
            result = domain._run_product_voice(
                "task-1", {"project_id": "project-1"}
            )

            self.assertEqual("failed", result["voice_status"])
            self.assertEqual("failed", settings["voice_status"])
            self.assertEqual(
                "cloud_request_failed", settings["voice_metadata"]["error_code"]
            )
            self.assertEqual(
                "\u767e\u70bc\u4e2d\u6587\u914d\u97f3\u8bf7\u6c42\u88ab\u62d2\u7edd\uff08HTTP 403\uff09\u3002",
                settings["voice_metadata"]["error_message"],
            )
            self.assertIsNone(settings["voice_audio_path"])
            self.assertTrue(saved)
            self.assertFalse(list(root.rglob("*.wav")))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_product_asset_timeout_skips_one_asset_after_provider_failure(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "asset_ids": ["asset-timeout", "asset-good"],
            "brief": {"product_name": "清洁扫地机器人"},
        }
        saved = []
        domain._product_settings = lambda _project_id: (None, settings)
        domain.analyzer = SimpleNamespace(capability={"provider": "bailian"})
        domain._asset_row = lambda asset_id: {"display_name": asset_id}
        domain._save_product_settings = lambda _project_id, value: saved.append(dict(value))
        domain._product_asset_cards = lambda _settings: [{"asset_id": "asset-good"}]
        domain._set_task = lambda *args, **kwargs: None
        domain._should_stop = lambda _task_id: False
        domain._analyze_asset = mock.Mock(
            side_effect=[
                ContentEngineError("cloud_request_failed", "百炼画面理解请求超时（90 秒）。"),
                True,
            ]
        )

        result = domain._run_product_asset_analysis("task-1", {"project_id": "project-1"})

        self.assertEqual(2, domain._analyze_asset.call_count)
        self.assertEqual("asset-timeout", domain._analyze_asset.call_args_list[0].args[1])
        self.assertEqual("asset-good", domain._analyze_asset.call_args_list[1].args[1])
        self.assertEqual("partial", settings["analysis_status"])
        self.assertEqual("asset-timeout", result["skipped_assets"][0]["asset_id"])
        self.assertEqual("asset-timeout", result["skipped_assets"][0]["asset_name"])
        self.assertEqual("asset_analysis", result["skipped_assets"][0]["stage"])
        self.assertTrue(saved)

    def test_product_asset_analysis_fails_when_every_asset_times_out(self):
        domain = object.__new__(CreativeDomain)
        settings = {
            "workflow": "product_one_click",
            "asset_ids": ["asset-timeout"],
            "brief": {"product_name": "清洁扫地机器人"},
        }
        domain._product_settings = lambda _project_id: (None, settings)
        domain.analyzer = SimpleNamespace(capability={"provider": "bailian"})
        domain._asset_row = lambda _asset_id: {"display_name": "video.mp4"}
        domain._save_product_settings = lambda _project_id, _value: None
        domain._product_asset_cards = lambda _settings: []
        domain._set_task = lambda *args, **kwargs: None
        domain._should_stop = lambda _task_id: False
        domain._analyze_asset = mock.Mock(
            side_effect=ContentEngineError("cloud_request_failed", "百炼画面理解请求超时（90 秒）。")
        )

        with self.assertRaises(ContentEngineError) as raised:
            domain._run_product_asset_analysis("task-1", {"project_id": "project-1"})

        self.assertEqual("all_assets_unavailable", raised.exception.code)

    def test_product_asset_cards_preserve_transcript_timecodes(self):
        domain = object.__new__(CreativeDomain)
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.execute(
            """
            CREATE TABLE media_segments(
                asset_id TEXT,
                tags_json TEXT,
                shot_type TEXT,
                role TEXT,
                metadata_json TEXT,
                transcript_text TEXT,
                start_ms INTEGER,
                end_ms INTEGER,
                updated_at TEXT
            )
            """
        )
        connection.execute(
            """
            INSERT INTO media_segments(
                asset_id, tags_json, shot_type, role, metadata_json,
                transcript_text, start_ms, end_ms, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "asset-1",
                "[]",
                "product_detail",
                "process",
                "{}",
                "真实清扫效果",
                1200,
                3400,
                "2026-08-18T00:00:00Z",
            ),
        )
        connection.commit()
        domain.connection = connection
        domain._asset_row = lambda _asset_id: {
            "id": "asset-1",
            "display_name": "robot.mp4",
            "media_kind": "video",
            "duration_ms": 5000,
            "has_audio": 1,
        }

        try:
            cards = domain._product_asset_cards(
                {"asset_ids": ["asset-1"], "brief": {"product_name": "清洁机器人"}}
            )
            self.assertEqual(
                [{"start_ms": 1200, "end_ms": 3400, "text": "真实清扫效果"}],
                cards[0]["transcript_segments"],
            )
        finally:
            connection.close()


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
                    "brand_profiles",
                    "cover_generation_ledger",
                    "creative_media_reviews",
                }.issubset(tables)
            )
            self.assertEqual(
                [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
                [row[0] for row in versions],
            )
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
