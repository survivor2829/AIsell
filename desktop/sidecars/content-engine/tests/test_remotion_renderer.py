from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import wave
from unittest import mock


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.creative_render import FFmpegCreativeRenderer, HybridCreativeRenderer
from content_engine.product_pipeline import build_local_copy, build_product_recipes, classify_assets
from content_engine.remotion_render import (
    RENDER_FAILURE_TAXONOMY_VERSION,
    RenderCancelledError,
    RemotionRenderError,
    RemotionWorkerClient,
)


def visual_renderer(*, comparison=False):
    result = {
        "requestedEngine": "remotion",
        "visualStyleId": "social_pop",
        "requestedStyleVersion": 1,
        "layoutPolicyVersion": 1,
        "semanticPlanHash": "semantic-plan-opaque",
        "deterministicSeed": "candidate-seed",
        "allowFallback": True,
    }
    if comparison:
        result["comparisonGroupId"] = "comparison-opaque"
    return result


def course_recipe(*, remotion=True):
    packaging = {
        "preset_id": "slide_teacher",
        "title": "课程重点",
        "effects": {
            "title_card": True,
            "slide_focus": True,
            "teacher_pip": True,
            "keyword_card": True,
        },
        "audio": {"profile": "course_clean", "bgm": False, "cue_budget": 1},
        "events": [{
            "type": "keyword", "text": "只属于 Remotion 的文字",
            "start_ms": 2_000, "end_ms": 3_000,
            "zone": "upper_right", "size": "chip", "priority": 2,
        }],
        "cover": {"mode": "local_frame"},
    }
    if remotion:
        packaging["visualRenderer"] = visual_renderer()
    return {
        "kind": "course",
        "voice_segment": {
            "asset_id": "asset_course", "start_ms": 10_250, "end_ms": 16_250,
        },
        "visual_segments": [
            {
                "asset_id": "asset_course", "start_ms": 10_250,
                "end_ms": 12_250, "frame_mode": "teacher_focus",
            },
            {
                "asset_id": "asset_course", "start_ms": 12_250,
                "end_ms": 15_250, "frame_mode": "slide_with_teacher_pip",
            },
        ],
        "captions": [{"text": "精确字幕", "start_ms": 10_500, "end_ms": 11_200}],
        "packaging": packaging,
    }


def mix_recipe():
    recipe = course_recipe()
    recipe["kind"] = "mix"
    recipe["voice_segment"] = {
        "asset_id": "voice", "start_ms": 20_000, "end_ms": 26_000,
    }
    recipe["visual_segments"] = [
        {
            "asset_id": "slot_a", "media_kind": "video",
            "start_ms": 5_000, "end_ms": 7_000, "target_duration_ms": 3_000,
        },
        {
            "asset_id": "slot_b", "media_kind": "image",
            "start_ms": 0, "end_ms": 0, "target_duration_ms": 3_000,
        },
    ]
    recipe["packaging"]["preset_id"] = "process_rhythm"
    return recipe


class CapturingFFmpegRenderer(FFmpegCreativeRenderer):
    def __init__(self, root):
        super().__init__(
            root, ffmpeg_path="fixture-ffmpeg.exe", ffprobe_path="fixture-ffprobe.exe"
        )
        self.encode_calls = []
        self.commands = []

    def _encode_with_fallback(self, input_args, output, *, audio=True):
        self.encode_calls.append((list(input_args), Path(output), audio, "legacy"))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_bytes(b"legacy")

    def _encode_mezzanine(self, input_args, output, *, audio=True, cwd=None):
        self.encode_calls.append((list(input_args), Path(output), audio, "mezzanine"))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_bytes(b"mezzanine")

    def _command(self, args, **kwargs):
        self.commands.append(list(args))
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class FakeWorker:
    RUNTIME_HASH = "a" * 64

    def __init__(self, failure=None):
        self.failure = failure
        self.calls = []
        self.closed = False
        self.capability_calls = 0
        self.expected_runtime_hashes = []
        self._capability = {
            "available": failure is None,
            "code": "ready" if failure is None else failure.code,
            "failure_class": None if failure is None else failure.failure_class,
            "runtime_hash": self.RUNTIME_HASH if failure is None else None,
            "runtime_hash_includes_bundle": failure is None,
        }

    @property
    def capability(self):
        self.capability_calls += 1
        return self._capability

    def render(self, *, source_path, output_path, public_props, expected_runtime_hash):
        self.calls.append((Path(source_path), Path(output_path), deepcopy(public_props)))
        self.expected_runtime_hashes.append(expected_runtime_hash)
        if self.failure:
            raise self.failure
        if expected_runtime_hash != self.RUNTIME_HASH:
            raise RemotionRenderError("contract", "runtime_hash_mismatch")
        Path(output_path).write_bytes(b"visual-only-h264")
        return {"style_version": 1, "runtime_hash": self.RUNTIME_HASH}

    def close(self, timeout_seconds=0):
        self.closed = True

    def cancel(self):
        pass


class RetryOnceWorker(FakeWorker):
    def __init__(self):
        super().__init__()
        self._attempt = 0

    def render(self, **kwargs):
        self._attempt += 1
        if self._attempt == 1:
            self.calls.append((Path(kwargs["source_path"]), Path(kwargs["output_path"]), deepcopy(kwargs["public_props"])))
            raise RemotionRenderError("transient-local", "worker_exited")
        return super().render(**kwargs)


class TransactionFFmpeg:
    capability = {"available": True, "code": "ready"}

    def __init__(self):
        self.legacy_calls = 0
        self.legacy_output_dirs = []
        self.mezzanine_calls = 0
        self.mux_calls = []

    def render_mezzanine(self, *, recipe, output, temp_dir, resolve_asset_path):
        self.mezzanine_calls += 1
        Path(output).write_bytes(b"clean-mezzanine-with-aac")

    def validate_mezzanine(self, path, *, expected_duration_ms):
        return {"duration_ms": expected_duration_ms, "audio_digest": "same-audio"}

    def mux_visual_with_mezzanine_audio(self, visual_path, mezzanine_path, output_path):
        self.mux_calls.append((Path(visual_path), Path(mezzanine_path), Path(output_path)))
        Path(output_path).write_bytes(b"final-h264-with-same-aac")

    def validate_final(self, path, *, expected_duration_ms, expected_audio_digest):
        self.asserted_audio = expected_audio_digest
        return {"duration_ms": expected_duration_ms, "audio_digest": "same-audio"}

    def render_cover_for_candidate(self, video_path, cover_path, recipe, resolve_asset_path):
        Path(cover_path).write_bytes(b"cover")

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        self.legacy_calls += 1
        self.legacy_output_dirs.append(Path(output_dir))
        Path(output_dir).mkdir(parents=True)
        (Path(output_dir) / "video.mp4").write_bytes(b"legacy-video")
        (Path(output_dir) / "cover.jpg").write_bytes(b"legacy-cover")
        return {
            "video_path": Path(output_dir) / "video.mp4",
            "thumbnail_path": Path(output_dir) / "cover.jpg",
        }

    def compose_cover(self, *args, **kwargs):
        return None


class FFmpegMezzanineContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.renderer = CapturingFFmpegRenderer(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_course_keeps_exact_range_and_layout_without_old_overlays(self):
        recipe = course_recipe()
        self.renderer.render_mezzanine(
            recipe=recipe,
            output=self.root / "course.mp4",
            temp_dir=self.root / "stage",
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        args = next(
            call[0] for call in self.renderer.encode_calls if "-ss" in call[0]
        )
        self.assertEqual("10.250", args[args.index("-ss") + 1])
        self.assertEqual("6.000", args[args.index("-t") + 1])
        graph = args[args.index("-filter_complex") + 1]
        self.assertIn("between(t,2.000,5.000)", graph)
        self.assertIn("slide_composed", graph)
        self.assertIn("setpts=PTS-STARTPTS", graph)
        self.assertNotIn("drawtext", graph)
        self.assertNotIn("drawbox", graph)
        self.assertNotIn("subtitles=", graph)
        audio = args[args.index("-af") + 1]
        self.assertIn("loudnorm=", audio)
        self.assertIn("aresample=48000", audio)
        self.assertIn("asetpts=PTS-STARTPTS", audio)

    def test_mux_bitstream_copies_visual_and_mezzanine_audio(self):
        self.renderer.mux_visual_with_mezzanine_audio(
            self.root / "visual.mp4", self.root / "mezzanine.mp4", self.root / "final.mp4"
        )
        command = self.renderer.commands[-1]
        self.assertEqual("copy", command[command.index("-c:v") + 1])
        self.assertEqual("copy", command[command.index("-c:a") + 1])
        self.assertIn("0:v:0", command)
        self.assertIn("1:a:0", command)

    def test_media_contract_rejects_video_track_shorter_than_audio(self):
        metadata = {
            "video_codec": "h264",
            "audio_codec": "aac",
            "width": 1080,
            "height": 1920,
            "fps": 30.0,
            "pixel_format": "yuv420p",
            "color_space": "bt709",
            "color_primaries": "bt709",
            "color_transfer": "bt709",
            "sample_rate": 48_000,
            "duration_ms": 75_000,
            "video_duration_ms": 39_067,
            "audio_duration_ms": 75_000,
            "video_start_ms": 0,
            "audio_start_ms": 0,
        }
        with self.assertRaisesRegex(
            RemotionRenderError, "media_track_duration_mismatch"
        ):
            FFmpegCreativeRenderer._validate_media_contract(
                metadata, expected_duration_ms=75_000, final=True
            )

    def test_mix_preserves_bounded_slot_ranges_without_old_overlays(self):
        stage = self.root / "stage"
        stage.mkdir()
        self.renderer.render_mezzanine(
            recipe=mix_recipe(),
            output=self.root / "mix.mp4",
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        bounded = self.renderer.encode_calls[0][0]
        self.assertEqual("5.000", bounded[bounded.index("-ss") + 1])
        self.assertEqual("2.000", bounded[bounded.index("-t") + 1])
        merged = next(
            call[0]
            for call in self.renderer.encode_calls
            if "20.000" in call[0]
        )
        self.assertEqual("6.000", merged[merged.index("-t") + 1])
        combined = " ".join(
            str(value) for call in self.renderer.encode_calls for value in call[0]
        )
        self.assertNotIn("drawtext", combined)
        self.assertNotIn("subtitles=", combined)

    def test_product_showcase_uses_motion_for_stills_and_bounded_video_windows(self):
        stage = self.root / "product-stage"
        stage.mkdir()
        assets = classify_assets([
            {"asset_id": "product-image", "display_name": "产品特写.jpg", "media_kind": "image"},
            {"asset_id": "product-video-1", "display_name": "使用现场 1.mp4", "media_kind": "video", "duration_ms": 20_000},
            {"asset_id": "product-video-2", "display_name": "使用现场 2.mp4", "media_kind": "video", "duration_ms": 20_000},
            {"asset_id": "product-video-3", "display_name": "使用现场 3.mp4", "media_kind": "video", "duration_ms": 20_000},
        ])
        script = build_local_copy({"product_name": "示例产品"}, assets)
        recipe = build_product_recipes(assets, script, output_count=1, duration_ms=60_000)[0]
        recipe["packaging"] = {"audio": {"profile": "visual_montage", "bgm": False, "cue_budget": 0}}
        self.renderer.render_mezzanine(
            recipe=recipe,
            output=self.root / "product.mp4",
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        combined = " ".join(str(value) for call in self.renderer.encode_calls for value in call[0])
        self.assertIn("zoompan=", combined)
        self.assertIn("-ss", combined)
        self.assertNotIn("-stream_loop", combined)
        self.assertNotIn("drawtext", combined)

    def test_ffmpeg_gentle_push_does_not_use_unbounded_zoompan_on_video(self):
        packaging = {
            "effects": {"gentle_push": True},
            "events": [],
        }
        self.assertNotIn("zoompan", self.renderer._packaging_filter(packaging))

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "FFmpeg smoke requires local media tools.",
    )
    def test_real_six_second_course_mezzanine_smoke(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        source = self.root / "smoke-source.mp4"
        subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
                "-t", "6.5", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
            ],
            check=True,
            timeout=60,
        )
        renderer = FFmpegCreativeRenderer(
            self.root, ffmpeg_path=ffmpeg, ffprobe_path=ffprobe,
            timeout_seconds=120,
        )
        renderer._encoder_checked = True
        renderer._preferred_encoder = "libx264"
        stage = self.root / "real-stage"
        stage.mkdir()
        recipe = course_recipe()
        recipe["voice_segment"]["start_ms"] = 250
        recipe["voice_segment"]["end_ms"] = 6_250
        recipe["visual_segments"] = []
        recipe["packaging"]["effects"] = {}
        recipe["packaging"]["audio"] = {
            "profile": "course_clean", "bgm": False, "cue_budget": 0,
        }
        output = stage / "mezzanine.mp4"
        renderer.render_mezzanine(
            recipe=recipe,
            output=output,
            temp_dir=stage,
            resolve_asset_path=lambda _asset_id: source,
        )
        metadata = renderer.validate_mezzanine(output, expected_duration_ms=6_000)
        self.assertEqual(1080, metadata["width"])
        self.assertEqual(1920, metadata["height"])
        self.assertAlmostEqual(30, metadata["fps"], places=2)
        self.assertEqual(48_000, metadata["sample_rate"])
        self.assertEqual(0, metadata["video_start_ms"])
        self.assertEqual(0, metadata["audio_start_ms"])
        self.assertEqual(64, len(metadata["audio_digest"]))

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "FFmpeg smoke requires local media tools.",
    )
    def test_real_product_image_video_montage_smoke(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        image = self.root / "product.png"
        source = self.root / "product-source.mp4"
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", "color=c=blue:s=360x640", "-frames:v", "1", str(image)],
            check=True, timeout=60,
        )
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", "testsrc2=size=360x640:rate=30", "-t", "4", "-an",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(source)],
            check=True, timeout=60,
        )
        voice = self.root / "product-voice.wav"
        with wave.open(str(voice), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48_000)
            audio.writeframes(b"\x00\x00" * (48_000 * 2))
        recipe = {
            "kind": "mix",
            "layout": "product_showcase",
            "audio_mode": "voiceover",
            "voice_audio_path": voice.name,
            "voice_segment": {"asset_id": "product-image", "start_ms": 0, "end_ms": 6_000},
            "visual_segments": [
                {"asset_id": "product-image", "media_kind": "image", "start_ms": 0, "end_ms": 0, "target_duration_ms": 3_000},
                {"asset_id": "product-video", "media_kind": "video", "start_ms": 500, "end_ms": 3_500, "target_duration_ms": 3_000},
            ],
            "packaging": {"audio": {"profile": "course_clean", "bgm": False, "cue_budget": 0}},
        }
        renderer = FFmpegCreativeRenderer(
            self.root, ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, timeout_seconds=120
        )
        renderer._encoder_checked = True
        renderer._preferred_encoder = "libx264"
        stage = self.root / "product-real-stage"
        stage.mkdir()
        output = stage / "product-mezzanine.mp4"
        renderer.render_mezzanine(
            recipe=recipe,
            output=output,
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: image if asset_id == "product-image" else source,
        )
        metadata = renderer.validate_mezzanine(output, expected_duration_ms=6_000)
        self.assertEqual(1080, metadata["width"])
        self.assertEqual(1920, metadata["height"])
        self.assertEqual(48_000, metadata["sample_rate"])
        self.assertEqual(6_000, metadata["video_duration_ms"])
        self.assertEqual(6_000, metadata["audio_duration_ms"])

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "FFmpeg smoke requires local media tools.",
    )
    def test_mixed_source_color_metadata_keeps_video_track_at_target_duration(self):
        """Concatenating real-world clips must not shorten the video stream."""
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        assets = {}
        for index, fps in enumerate((25, 20, 30)):
            asset = self.root / f"mixed-source-{index}.mp4"
            command = [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", f"testsrc2=size=360x640:rate={fps}",
                "-f", "lavfi", "-i", f"sine=frequency={440 + index * 80}:sample_rate=48000",
                "-t", "4", "-c:v", "libx264", "-preset", "ultrafast",
                "-pix_fmt", "yuv420p", "-r", str(fps),
                "-c:a", "aac", "-ar", "48000", "-ac", "2",
            ]
            if index == 1:
                # This matches the bt470bg metadata found in video(24).mp4.
                command.extend((
                    "-color_primaries", "bt470bg",
                    "-color_trc", "bt709",
                    "-colorspace", "bt470bg",
                ))
            subprocess.run([*command, str(asset)], check=True, timeout=60)
            assets[f"source-{index}"] = asset

        recipe = {
            "kind": "mix",
            "audio_mode": "visual_montage",
            "voice_segment": {"asset_id": "source-0", "start_ms": 0, "end_ms": 12_000},
            "visual_segments": [
                {
                    "asset_id": f"source-{index}",
                    "media_kind": "video",
                    "start_ms": 0,
                    "end_ms": 4_000,
                    "target_duration_ms": 4_000,
                }
                for index in range(3)
            ],
            "packaging": {},
        }
        renderer = FFmpegCreativeRenderer(
            self.root, ffmpeg_path=ffmpeg, ffprobe_path=ffprobe, timeout_seconds=120
        )
        renderer._encoder_checked = True
        renderer._preferred_encoder = "libx264"
        stage = self.root / "mixed-source-stage"
        stage.mkdir()
        output = stage / "mixed-source-mezzanine.mp4"
        renderer.render_mezzanine(
            recipe=recipe,
            output=output,
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: assets[asset_id],
        )
        metadata = renderer.validate_mezzanine(output, expected_duration_ms=12_000)
        self.assertEqual(12_000, metadata["video_duration_ms"])
        self.assertEqual(12_000, metadata["audio_duration_ms"])


class HybridRendererTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ffmpeg = TransactionFFmpeg()
        self.worker = FakeWorker()
        self.renderer = HybridCreativeRenderer(
            self.root, ffmpeg_renderer=self.ffmpeg, worker_client=self.worker
        )

    def tearDown(self):
        self.renderer.close()
        self.temp.cleanup()

    def render(self, video_id, recipe):
        return self.renderer.render(
            video_id=video_id,
            recipe=recipe,
            output_dir=self.root / "generated" / video_id,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )

    def test_success_is_visual_only_then_audio_remux_and_atomic_safe_manifest(self):
        recipe = course_recipe()
        result = self.render("candidate_safe", recipe)
        props = self.worker.calls[0][2]
        self.assertEqual("social_pop", props["styleId"])
        self.assertEqual("slide_teacher", props["semanticPresetId"])
        self.assertEqual(6_000, props["durationMs"])
        self.assertEqual(250, props["captions"][0]["startMs"])
        self.assertNotIn(str(self.root), json.dumps(props))
        self.assertEqual(1, len(self.ffmpeg.mux_calls))
        self.assertEqual("same-audio", self.ffmpeg.asserted_audio)
        output = result["video_path"].parent
        manifest = json.loads((output / "candidate-manifest.json").read_text("utf-8"))
        self.assertEqual("remotion", manifest["actualEngine"])
        self.assertNotIn(str(self.root), json.dumps(manifest))
        self.assertEqual([], list(output.parent.glob(".candidate_safe.rendering*")))
        self.assertEqual(1, self.worker.capability_calls)

    def test_auto_mix_packaging_identifier_maps_to_registered_semantic_preset(self):
        recipe = mix_recipe()
        recipe["product_workflow"] = "one_click_v2"
        recipe["packaging"]["preset_id"] = "auto_mix_v2"

        props = self.renderer._public_props(
            recipe, recipe["packaging"]["visualRenderer"]
        )

        self.assertEqual("knowledge_focus", props["semanticPresetId"])

    def test_public_props_wraps_long_chinese_caption_without_truncating_text(self):
        recipe = course_recipe()
        text = "不是参数越高越好，关键是根据现场环境和实际需求选择真正合适的设备。"
        recipe["captions"] = [{
            "text": text,
            "start_ms": 10_500,
            "end_ms": 14_500,
        }]
        recipe["subtitle_style"] = {"max_chars": 10}

        props = self.renderer._public_props(
            recipe, recipe["packaging"]["visualRenderer"]
        )

        self.assertGreater(len(props["captions"]), 1)
        self.assertEqual(text, "".join(item["text"] for item in props["captions"]))
        self.assertTrue(all(
            FFmpegCreativeRenderer._caption_width(item["text"]) <= 10
            for item in props["captions"]
        ))
        self.assertEqual(250, props["captions"][0]["startMs"])
        self.assertEqual(4_250, props["captions"][-1]["endMs"])

    def test_public_props_preserves_clip_relative_word_text_and_timing(self):
        recipe = course_recipe()
        long_word = "这是一条超过二十四个字但仍然必须完整保留的合法词级字幕内容"
        recipe["subtitle_style"] = {
            "preset": "knowledge_course",
            "max_chars": 14,
        }
        recipe["packaging"]["version"] = 1
        recipe["captions"] = [{
            "text": f"关键是{long_word}。",
            "start_ms": 10_500,
            "end_ms": 12_500,
            "words": [
                {"text": "关键", "start": 10_500, "end": 10_900},
                {"text": "是", "start": 10_950, "end": 11_100},
                {"text": long_word, "start": 11_150, "end": 12_400},
                {"text": "。", "start": 12_400, "end": 12_500},
            ],
        }]

        props = self.renderer._public_props(
            recipe, recipe["packaging"]["visualRenderer"]
        )

        self.assertEqual(
            [
                {"text": "关键", "startMs": 250, "endMs": 650},
                {"text": "是", "startMs": 700, "endMs": 850},
                {"text": long_word, "startMs": 900, "endMs": 2_150},
                {"text": "。", "startMs": 2_150, "endMs": 2_250},
            ],
            props["captions"],
        )

    def test_product_visual_labels_become_remotion_events_not_captions(self):
        recipe = mix_recipe()
        recipe["product_workflow"] = "one_click_v1"
        recipe["captions"] = [{
            "text": "这句是实际配音",
            "start_ms": 0,
            "end_ms": 1_800,
            "caption_source": "tts_voiceover",
        }]
        recipe["visual_labels"] = [
            {
                "text": "真实作业现场",
                "start_ms": 2_000,
                "end_ms": 4_000,
                "label_source": "planned_caption",
                "role": "process",
            },
            {
                "text": "了解更多",
                "start_ms": 5_000,
                "end_ms": 6_000,
                "label_source": "cta",
                "role": "result",
            },
        ]
        recipe["packaging"]["events"] = []

        props = self.renderer._public_props(
            recipe,
            recipe["packaging"]["visualRenderer"],
        )

        self.assertEqual(["这句是实际配音"], [item["text"] for item in props["captions"]])
        self.assertEqual(
            ["真实作业现场", "了解更多"],
            [item["text"] for item in props["events"]],
        )
        self.assertEqual(["scene", "result"], [item["type"] for item in props["events"]])
        self.assertNotIn("真实作业现场", [item["text"] for item in props["captions"]])

    def test_subtitle_none_disables_persisted_captions_in_both_renderers(self):
        recipe = course_recipe()
        recipe["subtitle_style"] = {"preset": "none"}
        recipe["captions"] = [{
            "text": "这条历史字幕不应该重新烧进只剪画面的成片。",
            "start_ms": 10_500,
            "end_ms": 12_500,
        }]

        self.assertEqual(
            [],
            FFmpegCreativeRenderer._caption_cues(recipe["captions"], recipe),
        )
        self.assertEqual(
            [],
            self.renderer._public_props(
                recipe, recipe["packaging"]["visualRenderer"]
            )["captions"],
        )

    def test_frozen_runtime_hash_skips_the_extra_capability_probe(self):
        recipe = course_recipe()
        recipe["packaging"]["visualRenderer"]["requestedRuntimeHash"] = (
            FakeWorker.RUNTIME_HASH
        )

        self.render("candidate_frozen", recipe)

        self.assertEqual(0, self.worker.capability_calls)
        self.assertEqual([FakeWorker.RUNTIME_HASH], self.worker.expected_runtime_hashes)

    def test_capability_hash_matches_actual_render_and_public_data_is_opaque(self):
        self.worker.capability.update({
            "bundlePath": str(self.root / "bundle-canary"),
            "providerKey": "provider-key-canary",
        })
        capability = self.renderer.capability
        self.assertTrue(capability["remotion_packaging_v1"])
        self.assertEqual(FakeWorker.RUNTIME_HASH, capability["runtime_hash"])
        self.assertTrue(capability["runtime_hash_includes_bundle"])
        self.assertEqual(FakeWorker.RUNTIME_HASH, capability["remotion"]["runtime_hash"])
        serialized = json.dumps(capability)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("bundlePath", serialized)
        self.assertNotIn("browserPath", serialized)
        self.assertNotIn("provider-key-canary", serialized)

        result = self.render("runtime_bound", course_recipe())
        manifest = json.loads(
            (result["video_path"].parent / "candidate-manifest.json").read_text("utf-8")
        )
        self.assertEqual(capability["runtime_hash"], manifest["runtimeHash"])

    def test_reused_cover_is_inside_the_same_atomic_install(self):
        source_dir = self.root / "generated" / "cover_source"
        source_dir.mkdir(parents=True)
        (source_dir / "cover.jpg").write_bytes(b"trusted-reused-cover")
        recipe = course_recipe()
        recipe["packaging"]["cover"] = {
            "mode": "reuse",
            "source_generated_video_id": "cover_source",
        }
        result = self.render("reuse_safe", recipe)
        self.assertEqual(b"trusted-reused-cover", result["thumbnail_path"].read_bytes())
        manifest = json.loads(
            (result["video_path"].parent / "candidate-manifest.json").read_text("utf-8")
        )
        self.assertEqual(
            HybridCreativeRenderer._sha256_file(result["thumbnail_path"]),
            manifest["coverSha256"],
        )

    def test_legacy_recipe_and_allowed_visible_fallback_are_preserved(self):
        self.render("legacy_safe", course_recipe(remotion=False))
        self.assertEqual(1, self.ffmpeg.legacy_calls)
        self.assertEqual(0, self.ffmpeg.mezzanine_calls)

        failure = RemotionRenderError("capability", "browser_unavailable")
        fallback = HybridCreativeRenderer(
            self.root, ffmpeg_renderer=self.ffmpeg, worker_client=FakeWorker(failure)
        )
        recipe = course_recipe()
        fallback.render(
            video_id="fallback_safe",
            recipe=recipe,
            output_dir=self.root / "generated" / "fallback_safe",
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        visual = recipe["packaging"]["visualRenderer"]
        self.assertEqual("ffmpeg", visual["actualEngine"])
        self.assertEqual("browser_unavailable", visual["fallbackCode"])

    def test_fallback_does_not_install_mismatched_legacy_output(self):
        class DurationCheckingFFmpeg(TransactionFFmpeg):
            def validate_rendered_output(self, path, *, expected_duration_ms):
                raise RemotionRenderError(
                    "output-quality", "media_track_duration_mismatch"
                )

        ffmpeg = DurationCheckingFFmpeg()
        renderer = HybridCreativeRenderer(
            self.root,
            ffmpeg_renderer=ffmpeg,
            worker_client=FakeWorker(
                RemotionRenderError("transient-local", "worker_exited")
            ),
        )
        output_dir = self.root / "generated" / "mismatched_fallback"
        with self.assertRaisesRegex(
            RemotionRenderError, "media_track_duration_mismatch"
        ):
            renderer.render(
                video_id="mismatched_fallback",
                recipe=course_recipe(),
                output_dir=output_dir,
                resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
            )
        self.assertFalse(output_dir.exists())

    def test_remotion_fallback_uses_a_short_transient_tree_for_mix_paths(self):
        failure = RemotionRenderError("transient-local", "worker_exited")
        renderer = HybridCreativeRenderer(
            self.root,
            ffmpeg_renderer=self.ffmpeg,
            worker_client=FakeWorker(failure),
        )
        candidate_id = "generated_video_" + ("a" * 96)
        final_dir = self.root / "generated" / ("creative_project_" + ("b" * 48)) / candidate_id
        renderer.render(
            video_id=candidate_id,
            recipe=mix_recipe(),
            output_dir=final_dir,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        self.assertEqual(1, len(self.ffmpeg.legacy_output_dirs))
        legacy_dir = self.ffmpeg.legacy_output_dirs[0]
        self.assertLess(len(str(legacy_dir)), 220)
        self.assertEqual(final_dir.parent.parent, legacy_dir.parent.parent)

    def test_transient_remotion_worker_is_retried_once_before_success(self):
        worker = RetryOnceWorker()
        renderer = HybridCreativeRenderer(
            self.root, ffmpeg_renderer=self.ffmpeg, worker_client=worker
        )
        result = renderer.render(
            video_id="retry_once_safe",
            recipe=course_recipe(),
            output_dir=self.root / "generated" / "retry_once_safe",
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        self.assertTrue(result["video_path"].is_file())
        self.assertEqual(2, worker._attempt)
        self.assertEqual(0, self.ffmpeg.legacy_calls)

    def test_cancellation_shaped_remotion_failure_never_falls_back(self):
        renderer = HybridCreativeRenderer(
            self.root,
            ffmpeg_renderer=self.ffmpeg,
            worker_client=FakeWorker(
                RemotionRenderError("transient-local", "render_cancelled")
            ),
        )
        with self.assertRaises(RenderCancelledError):
            renderer.render(
                video_id="cancelled_safe",
                recipe=course_recipe(),
                output_dir=self.root / "generated" / "cancelled_safe",
                resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
            )
        self.assertEqual(0, self.ffmpeg.legacy_calls)

    def test_active_ffmpeg_process_is_cooperatively_cancelled(self):
        started = threading.Event()
        released = threading.Event()
        killed = []

        class BlockingProcess:
            returncode = None

            def poll(self):
                return self.returncode

            def communicate(self, timeout=None):
                started.set()
                if not released.wait(timeout=timeout):
                    raise subprocess.TimeoutExpired("ffmpeg", timeout)
                return "", "cancelled"

            def kill(self):
                self.returncode = -9
                released.set()

        process = BlockingProcess()

        def kill_tree(active):
            killed.append(active)
            active.kill()

        renderer = FFmpegCreativeRenderer(
            self.root,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            popen_factory=lambda *_args, **_options: process,
            process_tree_killer=kill_tree,
        )
        failures = []

        def execute():
            try:
                renderer._command(["fixture-ffmpeg.exe", "-version"])
            except Exception as error:
                failures.append(error)

        thread = threading.Thread(target=execute)
        thread.start()
        self.assertTrue(started.wait(timeout=1))
        renderer.cancel()
        thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertEqual([process], killed)
        self.assertEqual(1, len(failures))
        self.assertIsInstance(failures[0], RenderCancelledError)

    def test_comparison_and_fail_closed_classes_never_fallback(self):
        for category in ("contract", "security", "output-quality"):
            renderer = HybridCreativeRenderer(
                self.root,
                ffmpeg_renderer=self.ffmpeg,
                worker_client=FakeWorker(RemotionRenderError(category, "stable_failure")),
            )
            with self.assertRaises(RemotionRenderError):
                renderer.render(
                    video_id=f"failure_{category.replace('-', '_')}",
                    recipe=course_recipe(),
                    output_dir=self.root / "generated" / f"failure-{category}",
                    resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
                )
        recipe = course_recipe()
        recipe["packaging"]["visualRenderer"] = visual_renderer(comparison=True)
        renderer = HybridCreativeRenderer(
            self.root,
            ffmpeg_renderer=self.ffmpeg,
            worker_client=FakeWorker(RemotionRenderError("capability", "worker_unavailable")),
        )
        with self.assertRaises(RemotionRenderError):
            renderer.render(
                video_id="comparison_safe", recipe=recipe,
                output_dir=self.root / "generated" / "comparison_safe",
                resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
            )

    def test_installed_candidate_is_adopted_after_database_handoff_gap(self):
        recipe = course_recipe()
        persisted_before_render = deepcopy(recipe)
        first = self.render("adopt_safe", recipe)
        count = self.ffmpeg.mezzanine_calls
        adopted = self.render("adopt_safe", persisted_before_render)
        self.assertEqual(first, adopted)
        self.assertEqual(count, self.ffmpeg.mezzanine_calls)
        adopted_config = persisted_before_render["packaging"]["visualRenderer"]
        self.assertEqual("remotion", adopted_config["actualEngine"])
        self.assertEqual(1, adopted_config["actualStyleVersion"])
        self.assertIsNone(adopted_config["fallbackCode"])

    def test_close_is_bounded(self):
        started = time.monotonic()
        self.renderer.close(timeout_seconds=0.1)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(self.worker.closed)


class RemotionWorkerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.node = self.root / "node.exe"
        self.worker = self.root / "worker.mjs"
        self.bundle = self.root / "bundle"
        self.browser = self.root / "browser.exe"
        self.node.write_bytes(b"node")
        self.worker.write_text("// worker", encoding="utf-8")
        self.bundle.mkdir()
        (self.bundle / "index.html").write_text("bundle", encoding="utf-8")
        self.browser.write_bytes(b"browser")

    def tearDown(self):
        self.temp.cleanup()

    def test_failure_taxonomy_is_versioned(self):
        self.assertEqual(1, RENDER_FAILURE_TAXONOMY_VERSION)
        for category in (
            "capability", "transient-local", "contract", "security", "output-quality"
        ):
            error = RemotionRenderError(category, "stable_code")
            self.assertEqual(category, error.failure_class)
            self.assertEqual("stable_code", error.code)

    @unittest.skipUnless(shutil.which("node"), "Node worker capability test requires Node.")
    def test_real_worker_capability_hash_changes_with_bundle_content(self):
        worker_path = (
            Path(__file__).resolve().parents[3]
            / "src" / "main" / "remotion-render-worker.mjs"
        )
        nested = self.bundle / "assets"
        nested.mkdir()
        asset = nested / "entry.js"
        asset.write_text("first", encoding="utf-8")
        client = RemotionWorkerClient(
            data_dir=self.root / "data",
            node_path=shutil.which("node"),
            worker_path=worker_path,
            bundle_path=self.bundle,
            browser_path=self.browser,
        )
        try:
            first = client.capability
            self.assertTrue(first["available"])
            self.assertRegex(first["runtime_hash"], r"^[0-9a-f]{64}$")
            self.assertNotIn(str(self.root), json.dumps(first))

            asset.write_text("second", encoding="utf-8")
            stage = self.root / "stage"
            stage.mkdir()
            source = stage / "mezzanine.mp4"
            source.write_bytes(b"private-source")
            with self.assertRaises(RemotionRenderError) as stale:
                client.render(
                    source_path=source,
                    output_path=stage / "visual-only.mp4",
                    public_props={},
                    expected_runtime_hash=first["runtime_hash"],
                )
            self.assertEqual("contract", stale.exception.failure_class)
            self.assertEqual("runtime_hash_mismatch", stale.exception.code)

            second = client.capability
            self.assertTrue(second["available"])
            self.assertNotEqual(first["runtime_hash"], second["runtime_hash"])
        finally:
            client.close(timeout_seconds=1)

    def test_unavailable_capability_does_not_publish_a_runtime_hash(self):
        client = RemotionWorkerClient(
            data_dir=self.root / "data",
            node_path=self.node,
            worker_path=self.worker,
            bundle_path=self.bundle,
            browser_path=self.root / "missing-browser.exe",
        )
        capability = client.capability
        self.assertFalse(capability["available"])
        self.assertIsNone(capability["runtime_hash"])
        self.assertFalse(capability["runtime_hash_includes_bundle"])

    def test_child_argv_and_allowlisted_environment_preserve_browser_runtime_only(self):
        captured = {}

        class Process:
            stdin = SimpleNamespace(write=lambda _value: None, flush=lambda: None)
            stdout = []
            stderr = SimpleNamespace(read=lambda _size=-1: "")
            returncode = None
            def poll(self): return self.returncode
            def terminate(self): self.returncode = 0
            def wait(self, timeout=None): self.returncode = 0; return 0
            def kill(self): self.returncode = -9

        def popen(args, **options):
            captured.update(args=args, options=options)
            return Process()

        with mock.patch.dict(os.environ, {
            "DASHSCOPE_API_KEY": "key-canary",
            "APIMART_API_KEY": "image-key-canary",
            "UNRELATED_SECRET": "secret-canary",
            "PATH": " path-canary ",
            "USERPROFILE": " user-profile-canary ",
            "APPDATA": " app-data-canary ",
            "LOCALAPPDATA": " local-app-data-canary ",
        }, clear=True):
            client = RemotionWorkerClient(
                data_dir=self.root / "data", node_path=self.node,
                worker_path=self.worker, bundle_path=self.bundle,
                browser_path=self.browser, popen_factory=popen,
            )
            client._start()
            client.close(timeout_seconds=0.01)

        self.assertEqual([str(self.node), str(self.worker)], captured["args"])
        argv = json.dumps(captured["args"])
        self.assertNotIn(str(self.bundle), argv)
        self.assertNotIn(str(self.browser), argv)
        child_env = json.dumps(captured["options"]["env"])
        self.assertNotIn("key-canary", child_env)
        self.assertNotIn("image-key-canary", child_env)
        self.assertNotIn("secret-canary", child_env)
        self.assertEqual("path-canary", captured["options"]["env"]["PATH"])
        self.assertEqual(
            "user-profile-canary", captured["options"]["env"]["USERPROFILE"]
        )
        self.assertEqual("app-data-canary", captured["options"]["env"]["APPDATA"])
        self.assertEqual(
            "local-app-data-canary", captured["options"]["env"]["LOCALAPPDATA"]
        )
        self.assertIn("TEMP", captured["options"]["env"])
        self.assertIn("TMP", captured["options"]["env"])
        self.assertFalse(captured["options"]["shell"])

    def test_worker_stderr_is_continuously_drained_into_a_private_bounded_tail(self):
        secret = "stderr-key-canary"

        class ChunkStream:
            def __init__(self):
                self.remaining = 20
            def read(self, _size=-1):
                if self.remaining <= 0:
                    return ""
                self.remaining -= 1
                return (secret + "x" * 4096)

        class Process:
            stdin = SimpleNamespace(write=lambda _value: None, flush=lambda: None)
            stdout = []
            stderr = ChunkStream()
            returncode = None
            def poll(self): return self.returncode
            def terminate(self): self.returncode = 0
            def wait(self, timeout=None): self.returncode = 0; return 0
            def kill(self): self.returncode = -9

        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser, popen_factory=lambda *_args, **_kwargs: Process(),
        )
        client._start()
        client._stderr_reader.join(timeout=1)
        self.assertFalse(client._stderr_reader.is_alive())
        self.assertLessEqual(len(client._stderr_tail), 16 * 1024)
        error = RemotionRenderError("transient-local", "worker_exited")
        self.assertNotIn(secret, str(error))
        client.close(timeout_seconds=0.01)

    def test_dead_worker_on_stdin_write_reports_worker_exited(self):
        class DeadProcess:
            stdout = []
            stderr = SimpleNamespace(read=lambda _size=-1: "")
            returncode = 17

            def poll(self):
                return self.returncode

            class _DeadStdin:
                def write(self, _value):
                    raise BrokenPipeError("worker already exited")

                def flush(self):
                    raise BrokenPipeError("worker already exited")

            stdin = _DeadStdin()

            def wait(self, timeout=None):
                return self.returncode

            def kill(self):
                self.returncode = -9

        process = DeadProcess()
        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser,
            popen_factory=lambda *_args, **_kwargs: process,
        )
        with self.assertRaises(RemotionRenderError) as raised:
            client._send({"version": 1, "id": "dead-worker", "method": "capability"})
        self.assertEqual("worker_exited", raised.exception.code)
        self.assertEqual("transient-local", raised.exception.failure_class)
        client.close(timeout_seconds=0.01)

    def test_broken_pipe_detaches_the_stale_worker_before_the_retry(self):
        secret = "worker-pipe-secret"

        class Stdin:
            def __init__(self, *, broken=False):
                self.broken = broken
                self.writes = []

            def write(self, value):
                if self.broken:
                    raise BrokenPipeError(secret)
                self.writes.append(value)

            def flush(self):
                if self.broken:
                    raise BrokenPipeError(secret)

        class Process:
            def __init__(self, *, broken=False):
                self.stdin = Stdin(broken=broken)
                self.stdout = []
                self.stderr = SimpleNamespace(read=lambda _size=-1: "")
                self.returncode = None

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = 17

            def wait(self, timeout=None):
                if self.returncode is None:
                    self.returncode = 0
                return self.returncode

            def kill(self):
                self.returncode = -9

        stale = Process(broken=True)
        fresh = Process()
        spawned = []

        def popen(*_args, **_kwargs):
            spawned.append(object())
            return stale if len(spawned) == 1 else fresh

        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser, popen_factory=popen,
        )
        with self.assertRaises(RemotionRenderError) as raised:
            client._send({"version": 1, "id": "broken-pipe", "method": "capability"})
        self.assertEqual("worker_pipe_failed", raised.exception.code)
        self.assertEqual(("worker_pipe_failed",), client.worker_recovery_diagnostics)
        self.assertEqual(17, stale.returncode)
        self.assertNotIn(secret, json.dumps(client.worker_recovery_diagnostics))

        client._send({"version": 1, "id": "fresh-pipe", "method": "capability"})
        self.assertEqual(2, len(spawned))
        self.assertTrue(fresh.stdin.writes)
        client.close(timeout_seconds=0.01)

    def test_worker_eof_isolated_from_a_fresh_worker_response_queue(self):
        class Stdin:
            def __init__(self):
                self.writes = []

            def write(self, value):
                self.writes.append(value)

            def flush(self):
                return None

        class Process:
            def __init__(self, stdout):
                self.stdin = Stdin()
                self.stdout = stdout
                self.stderr = SimpleNamespace(read=lambda _size=-1: "")
                self.returncode = None

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = 18

            def wait(self, timeout=None):
                if self.returncode is None:
                    self.returncode = 0
                return self.returncode

            def kill(self):
                self.returncode = -9

        stale = Process([])
        fresh = Process([
            '{"id":"fresh-worker","ok":true,"result":{"recovered":true}}\n'
        ])
        spawned = []

        def popen(*_args, **_kwargs):
            spawned.append(object())
            return stale if len(spawned) == 1 else fresh

        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser, popen_factory=popen,
        )
        with self.assertRaises(RemotionRenderError) as raised:
            client._request_result(
                {"version": 1, "id": "stale-worker", "method": "capability"}
            )
        self.assertEqual("worker_exited", raised.exception.code)
        self.assertEqual(("worker_exited",), client.worker_recovery_diagnostics)
        self.assertEqual(18, stale.returncode)

        result = client._request_result(
            {"version": 1, "id": "fresh-worker", "method": "capability"}
        )
        self.assertEqual({"recovered": True}, result)
        self.assertEqual(2, len(spawned))
        client.close(timeout_seconds=0.01)

    def test_existing_output_symlink_is_rejected_before_worker_start(self):
        stage = self.root / "stage"
        stage.mkdir()
        source = stage / "mezzanine.mp4"
        source.write_bytes(b"source")
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"do-not-overwrite")
        output = stage / "visual-only.mp4"
        try:
            output.symlink_to(outside)
        except OSError:
            self.skipTest("This Windows account cannot create symlinks.")
        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser,
        )
        with self.assertRaises(RemotionRenderError) as raised:
            client.render(source_path=source, output_path=output, public_props={})
        self.assertEqual("security", raised.exception.failure_class)
        self.assertEqual("output_reparse_rejected", raised.exception.code)
        self.assertEqual(b"do-not-overwrite", outside.read_bytes())

    def test_unresponsive_worker_uses_bounded_process_tree_kill(self):
        killed = []

        class HangingProcess:
            stdin = SimpleNamespace(write=lambda _value: None, flush=lambda: None)
            stdout = []
            stderr = SimpleNamespace(read=lambda _size=-1: "")
            returncode = None
            def poll(self): return self.returncode
            def wait(self, timeout=None):
                if self.returncode is None:
                    raise subprocess.TimeoutExpired("worker", timeout)
                return self.returncode
            def kill(self): self.returncode = -9

        process = HangingProcess()
        client = RemotionWorkerClient(
            data_dir=self.root / "data", node_path=self.node,
            worker_path=self.worker, bundle_path=self.bundle,
            browser_path=self.browser,
            popen_factory=lambda *_args, **_kwargs: process,
            tree_killer=lambda child: (killed.append(child), setattr(child, "returncode", -9)),
        )
        client._start()
        started = time.monotonic()
        client.close(timeout_seconds=0.01)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual([process], killed)


if __name__ == "__main__":
    unittest.main()
