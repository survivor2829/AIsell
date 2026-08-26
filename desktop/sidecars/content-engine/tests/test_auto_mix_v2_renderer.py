from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import sys
import unittest
import uuid


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.creative_render import FFmpegCreativeRenderer, HybridCreativeRenderer
from content_engine.errors import ContentEngineError
from content_engine.remotion_render import RemotionRenderError


def auto_mix_v2_recipe(*, allow_fallback=False):
    return {
        "kind": "mix",
        "product_workflow": "one_click_v2",
        "audio_mode": "tts_only",
        "voice_audio_path": "voices/verified.wav",
        "licensed_music_relative_path": "music/licensed.mp3",
        "licensed_music": {
            "duration_ms": 5_000,
            "loop_start_ms": None,
            "loop_end_ms": None,
        },
        "voice_segment": {
            "asset_id": "visual-a",
            "start_ms": 0,
            "end_ms": 5_000,
        },
        "visual_segments": [
            {
                "asset_id": "visual-a",
                "media_kind": "video",
                "start_ms": 1_000,
                "end_ms": 6_000,
                "target_duration_ms": 5_000,
            }
        ],
        "captions": [
            {
                "text": "真实合成字幕",
                "start_ms": 0,
                "end_ms": 1_500,
                "timing": "audio_measured",
            }
        ],
        "packaging": {
            "audio": {"profile": "auto_mix_v2"},
            "cover": {"mode": "local_frame"},
            "visualRenderer": {
                "requestedEngine": "remotion",
                "visualStyleId": "social_pop",
                "requestedStyleVersion": 1,
                "allowFallback": allow_fallback,
            },
        },
    }


class CapturingV2Renderer(FFmpegCreativeRenderer):
    def __init__(self, root):
        super().__init__(
            root,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
        )
        self.encode_calls = []

    def _encode_with_fallback(self, input_args, output, *, audio=True):
        self.encode_calls.append((list(input_args), Path(output), audio, "legacy"))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_bytes(b"legacy")

    def _encode_mezzanine(self, input_args, output, *, audio=True, cwd=None):
        self.encode_calls.append((list(input_args), Path(output), audio, "mezzanine"))
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_bytes(b"mezzanine")

    def _measure_auto_mix_window_margins(self, *_args, **_kwargs):
        return [
            {
                "captionId": "caption-1",
                "startMs": 0,
                "endMs": 1_500,
                "voiceLufs": -16.0,
                "musicLufs": -26.0,
                "rawMarginLu": 10.0,
                "marginLu": 10.0,
            }
        ]


class FakeWorker:
    RUNTIME_HASH = "b" * 64

    def __init__(self, failure=None):
        self.failure = failure
        self.calls = 0

    @property
    def capability(self):
        if self.failure:
            return {
                "available": False,
                "code": self.failure.code,
                "failure_class": self.failure.failure_class,
                "runtime_hash": None,
            }
        return {
            "available": True,
            "code": "ready",
            "failure_class": None,
            "runtime_hash": self.RUNTIME_HASH,
            "runtime_hash_includes_bundle": True,
        }

    def render(self, *, source_path, output_path, public_props, expected_runtime_hash):
        self.calls += 1
        if self.failure:
            raise self.failure
        Path(output_path).write_bytes(b"visual")
        return {"style_version": 1, "runtime_hash": expected_runtime_hash}

    def close(self, timeout_seconds=0):
        pass

    def cancel(self):
        pass


class FakeHybridFFmpeg:
    capability = {"available": True, "code": "ready"}

    def __init__(self):
        self.legacy_calls = 0
        self.mezzanine_calls = 0

    def render_mezzanine(self, *, recipe, output, temp_dir, resolve_asset_path):
        self.mezzanine_calls += 1
        Path(output).write_bytes(b"mezzanine")

    def validate_mezzanine(self, path, *, expected_duration_ms):
        return {"duration_ms": expected_duration_ms, "audio_digest": "same"}

    def mux_visual_with_mezzanine_audio(self, visual_path, mezzanine_path, output_path):
        Path(output_path).write_bytes(b"final")

    def validate_final(self, path, *, expected_duration_ms, expected_audio_digest):
        return {"duration_ms": expected_duration_ms, "audio_digest": expected_audio_digest}

    def measure_audio_quality(self, path):
        return {
            "integrated_lufs": -15.1,
            "true_peak_dbtp": -1.2,
        }

    def read_auto_mix_speech_music_report(self, path):
        return {
            "speech_music_margin_lu": 10.0,
            "music_gain_db": 0.0,
            "speech_music_windows": [
                {
                    "captionId": "caption-1",
                    "startMs": 0,
                    "endMs": 1_500,
                    "voiceLufs": -16.0,
                    "musicLufs": -26.0,
                    "rawMarginLu": 10.0,
                    "marginLu": 10.0,
                }
            ],
        }

    def render_cover_for_candidate(self, video_path, cover_path, recipe, resolve_asset_path):
        Path(cover_path).write_bytes(b"cover")

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        self.legacy_calls += 1
        raise AssertionError("V2 must never enter legacy FFmpeg rendering")

    def compose_cover(self, *args, **kwargs):
        return None


class AutoMixV2RendererTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".auto-mix-v2-renderer-{uuid.uuid4().hex}"
        self.root.mkdir()
        (self.root / "voices").mkdir()
        (self.root / "music").mkdir()
        (self.root / "voices" / "verified.wav").write_bytes(b"voice")
        (self.root / "music" / "licensed.mp3").write_bytes(b"music")
        (self.root / "visual-a.mp4").write_bytes(b"video")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_contract_requires_verified_voice_and_licensed_music(self):
        renderer = CapturingV2Renderer(self.root)
        for missing_key, expected_code in (
            ("voice_audio_path", "auto_mix_voice_required"),
            ("licensed_music_relative_path", "auto_mix_music_required"),
        ):
            recipe = auto_mix_v2_recipe()
            recipe.pop(missing_key)
            with self.assertRaises(ContentEngineError) as caught:
                renderer.render_mezzanine(
                    recipe=recipe,
                    output=self.root / f"{missing_key}.mp4",
                    temp_dir=self.root / f"stage-{missing_key}",
                    resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
                )
            self.assertEqual(expected_code, caught.exception.code)

        recipe = auto_mix_v2_recipe()
        recipe["licensed_music_relative_path"] = str(
            self.root / "music" / "licensed.mp3"
        )
        with self.assertRaises(ContentEngineError) as caught:
            renderer.render_mezzanine(
                recipe=recipe,
                output=self.root / "absolute-music.mp4",
                temp_dir=self.root / "absolute-music-stage",
                resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
            )
        self.assertEqual("auto_mix_music_required", caught.exception.code)
        self.assertNotIn(str(self.root), caught.exception.message)

    def test_v2_mezzanine_mutes_source_and_uses_separate_licensed_mix(self):
        renderer = CapturingV2Renderer(self.root)
        stage = self.root / "stage"
        stage.mkdir()
        recipe = auto_mix_v2_recipe()
        recipe["packaging"]["audio"]["intro_delay_ms"] = 900
        recipe["packaging"]["audio"].update(
            {
                "energy_curve": [
                    {"position": 0.0, "energy": 0.32},
                    {"position": 0.55, "energy": 0.72},
                    {"position": 1.0, "energy": 0.46},
                ],
                "transition_points_ms": [2_000],
                "music_section_hints": [{"type": "cta", "atMs": 3_800}],
            }
        )
        renderer.render_mezzanine(
            recipe=recipe,
            output=self.root / "mezzanine.mp4",
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )

        all_args = "\n".join(
            " ".join(str(value) for value in call[0]) for call in renderer.encode_calls
        )
        bounded_call = next(call[0] for call in renderer.encode_calls if "1.000" in call[0])
        final_graph = next(
            call[0][call[0].index("-filter_complex") + 1]
            for call in renderer.encode_calls
            if "-filter_complex" in call[0] and "[music_norm]" in " ".join(call[0])
        )
        visual_canvas = next(
            call[0][call[0].index("-filter_complex") + 1]
            for call in renderer.encode_calls
            if "-filter_complex" in call[0]
            and "[auto_mix_vout]" in call[0][call[0].index("-filter_complex") + 1]
        )
        self.assertIn("-an", bounded_call)
        self.assertNotIn("crop=1080:1920:(in_w-1080)", " ".join(bounded_call))
        self.assertIn("split=2", visual_canvas)
        self.assertIn("boxblur=18:2", visual_canvas)
        self.assertIn("force_original_aspect_ratio=decrease", visual_canvas)
        self.assertIn("overlay=(W-w)/2:(H-h)/2", visual_canvas)
        self.assertIn("-shortest", all_args)
        self.assertNotIn("apad", all_args)
        self.assertNotIn("aevalsrc", all_args)
        self.assertNotIn("volume=-24", all_args)
        self.assertNotIn("lowpass=f=1200", all_args)
        self.assertNotIn("sidechaincompress", final_graph)
        self.assertIn("[music_norm]volume=", final_graph)
        self.assertIn("loudnorm=I=-15:LRA=8:TP=-1.2", final_graph)
        self.assertIn("adelay=900|900", final_graph)
        self.assertIn(
            "adelay=900|900,afade=t=in:st=0.900:d=0.4,afade=t=out:st=4.200:d=0.8",
            final_graph,
        )
        self.assertNotIn("atrim=duration=", final_graph)
        self.assertIn("volume='pow(10", final_graph)
        self.assertIn("between(t,2.000,2.220)", final_graph)
        self.assertIn("between(t,3.800,4.020)", final_graph)
        self.assertIn(str(self.root / "music" / "licensed.mp3"), all_args)

    def test_material_energy_and_section_plan_changes_the_music_envelope(self):
        calm = {
            "energy_curve": [
                {"position": 0.0, "energy": 0.2},
                {"position": 1.0, "energy": 0.35},
            ],
            "transition_points_ms": [2_000],
            "music_section_hints": [],
        }
        energetic = {
            "energy_curve": [
                {"position": 0.0, "energy": 0.8},
                {"position": 0.5, "energy": 0.95},
                {"position": 1.0, "energy": 0.6},
            ],
            "transition_points_ms": [1_000, 3_000],
            "music_section_hints": [{"type": "cta", "atMs": 4_000}],
        }

        calm_filter = FFmpegCreativeRenderer._auto_mix_music_envelope_filter(
            calm, 5_000
        )
        energetic_filter = FFmpegCreativeRenderer._auto_mix_music_envelope_filter(
            energetic, 5_000
        )

        self.assertNotEqual(calm_filter, energetic_filter)
        self.assertIn("between(t,1.000,1.220)", energetic_filter)
        self.assertIn("between(t,4.000,4.220)", energetic_filter)

    def test_measure_audio_quality_parses_ffmpeg_loudnorm_output(self):
        stderr = """
        [Parsed_loudnorm_0 @ fixture]
        {
          "input_i" : "-15.08",
          "input_tp" : "-1.24",
          "input_lra" : "3.20"
        }
        """
        commands = []

        def runner(command, **_options):
            commands.append(list(command))
            return SimpleNamespace(returncode=0, stdout="", stderr=stderr)

        renderer = FFmpegCreativeRenderer(
            self.root,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            command_runner=runner,
        )
        report = renderer.measure_audio_quality(self.root / "final.mp4")
        self.assertEqual(-15.08, report["integrated_lufs"])
        self.assertEqual(-1.24, report["true_peak_dbtp"])
        command = " ".join(commands[-1])
        self.assertIn("print_format=json", command)
        self.assertIn("TP=-1.2", command)

    def test_window_margin_measurement_uses_two_series_for_many_captions(self):
        class SeriesCountingRenderer(FFmpegCreativeRenderer):
            def __init__(self, root):
                super().__init__(
                    root,
                    ffmpeg_path="fixture-ffmpeg.exe",
                    ffprobe_path="fixture-ffprobe.exe",
                )
                self.series_paths = []

            def _command(self, _args, **_options):
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            def _measure_loudness_series(self, path):
                self.series_paths.append(Path(path))
                loudness = -16.0 if "voice" in Path(path).name else -26.0
                return [(timestamp, loudness) for timestamp in range(0, 20_101, 100)]

        captions = [
            {
                "captionId": f"caption-{index + 1}",
                "start_ms": index * 500,
                "end_ms": (index + 1) * 500,
            }
            for index in range(40)
        ]
        renderer = SeriesCountingRenderer(self.root)
        windows = renderer._measure_auto_mix_window_margins(
            self.root / "voices" / "verified.wav",
            ["-i", str(self.root / "music" / "licensed.mp3")],
            captions,
            duration=20.0,
            music_duration=20.0,
            fade_out=19.2,
            delay_filter="",
            output=self.root / "many-captions.mp4",
        )
        gain_plan = renderer._auto_mix_music_gain_plan(
            windows, duration_ms=20_000
        )
        verified_windows = renderer._validate_auto_mix_window_margins(
            windows, gain_plan["speech_window_gains"]
        )

        self.assertEqual(2, len(renderer.series_paths))
        self.assertEqual(1, sum("voice" in path.name for path in renderer.series_paths))
        self.assertEqual(1, sum("music" in path.name for path in renderer.series_paths))
        self.assertEqual(40, len(verified_windows))
        self.assertEqual(
            [caption["captionId"] for caption in captions],
            [window["captionId"] for window in verified_windows],
        )
        self.assertEqual("global", gain_plan["strategy"])
        self.assertEqual(0.0, gain_plan["music_gain_db"])
        self.assertTrue(
            all(window["marginLu"] == 10.0 for window in verified_windows)
        )

    def test_window_margin_measurement_rejects_any_speech_window_without_music(self):
        class MissingMusicRenderer(FFmpegCreativeRenderer):
            def __init__(self, root):
                super().__init__(
                    root,
                    ffmpeg_path="fixture-ffmpeg.exe",
                    ffprobe_path="fixture-ffprobe.exe",
                )

            def _command(self, _args, **_options):
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            def _measure_loudness_series(self, path):
                if "voice" in Path(path).name:
                    return [(timestamp, -16.0) for timestamp in range(0, 1_201, 100)]
                return [
                    (timestamp, -26.0 if timestamp <= 500 else float("-inf"))
                    for timestamp in range(0, 1_201, 100)
                ]

        renderer = MissingMusicRenderer(self.root)
        with self.assertRaises(ContentEngineError) as caught:
            renderer._measure_auto_mix_window_margins(
                self.root / "voices" / "verified.wav",
                ["-i", str(self.root / "music" / "licensed.mp3")],
                [
                    {"captionId": "with-music", "start_ms": 0, "end_ms": 500},
                    {"captionId": "without-music", "start_ms": 700, "end_ms": 1_100},
                ],
                duration=1.2,
                music_duration=1.2,
                fade_out=0.4,
                delay_filter="",
                output=self.root / "missing-music.mp4",
            )
        self.assertEqual("auto_mix_music_not_audible", caught.exception.code)

    def test_window_gain_plan_uses_per_speech_control_when_global_gain_is_impossible(self):
        windows = [
            {
                "captionId": "caption-1",
                "startMs": 0,
                "endMs": 720,
                "rawMarginLu": 17.84,
            },
            {
                "captionId": "caption-2",
                "startMs": 880,
                "endMs": 1_700,
                "rawMarginLu": 23.87,
            },
        ]

        plan = FFmpegCreativeRenderer._auto_mix_music_gain_plan(
            windows, duration_ms=2_000
        )

        self.assertEqual("per_speech_window", plan["strategy"])
        self.assertIn("volume='pow(10", plan["post_duck_gain_filter"])
        self.assertIn("eval=frame", plan["post_duck_gain_filter"])
        gains = {
            item["captionId"]: item["gainDb"]
            for item in plan["speech_window_gains"]
        }
        self.assertAlmostEqual(7.84, gains["caption-1"], places=2)
        self.assertAlmostEqual(13.87, gains["caption-2"], places=2)
        for window in windows:
            self.assertAlmostEqual(
                10.0,
                window["rawMarginLu"] - gains[window["captionId"]],
                places=2,
            )
        with self.assertRaises(ContentEngineError) as caught:
            FFmpegCreativeRenderer._auto_mix_music_gain_plan(
                [
                    {
                        "captionId": "unsafe-caption",
                        "startMs": 0,
                        "endMs": 500,
                        "rawMarginLu": 30.1,
                    }
                ],
                duration_ms=1_000,
            )
        self.assertEqual("auto_mix_voice_music_margin_failed", caught.exception.code)

    def test_mezzanine_calibrates_per_speech_music_control_from_measured_residual(self):
        class VariableMarginRenderer(CapturingV2Renderer):
            def __init__(self, root):
                super().__init__(root)
                self.margin_measurement_filters = []

            def _measure_auto_mix_window_margins(self, *_args, **kwargs):
                post_duck_gain_filter = str(
                    kwargs.get("post_duck_gain_filter") or ""
                )
                self.margin_measurement_filters.append(post_duck_gain_filter)
                if len(self.margin_measurement_filters) >= 3:
                    return [
                        {
                            "captionId": "caption-1",
                            "startMs": 0,
                            "endMs": 720,
                            "voiceLufs": -16.0,
                            "musicLufs": -26.0,
                            "rawMarginLu": 10.0,
                        },
                        {
                            "captionId": "caption-2",
                            "startMs": 880,
                            "endMs": 1_700,
                            "voiceLufs": -16.0,
                            "musicLufs": -26.0,
                            "rawMarginLu": 10.0,
                        },
                    ]
                if post_duck_gain_filter:
                    return [
                        {
                            "captionId": "caption-1",
                            "startMs": 0,
                            "endMs": 720,
                            "voiceLufs": -16.0,
                            "musicLufs": -26.48,
                            "rawMarginLu": 10.48,
                        },
                        {
                            "captionId": "caption-2",
                            "startMs": 880,
                            "endMs": 1_700,
                            "voiceLufs": -16.0,
                            "musicLufs": -29.02,
                            "rawMarginLu": 13.02,
                        },
                    ]
                return [
                    {
                        "captionId": "caption-1",
                        "startMs": 0,
                        "endMs": 720,
                        "voiceLufs": -16.0,
                        "musicLufs": -33.84,
                        "rawMarginLu": 17.84,
                    },
                    {
                        "captionId": "caption-2",
                        "startMs": 880,
                        "endMs": 1_700,
                        "voiceLufs": -16.0,
                        "musicLufs": -39.87,
                        "rawMarginLu": 23.87,
                    },
                ]

        renderer = VariableMarginRenderer(self.root)
        recipe = auto_mix_v2_recipe()
        recipe["captions"] = [
            {
                "captionId": "caption-1",
                "text": "第一句",
                "start_ms": 0,
                "end_ms": 720,
                "timing": "audio_measured",
            },
            {
                "captionId": "caption-2",
                "text": "第二句",
                "start_ms": 880,
                "end_ms": 1_700,
                "timing": "audio_measured",
            },
        ]
        output = self.root / "dynamic-margin.mp4"
        stage = self.root / "dynamic-margin-stage"
        stage.mkdir()

        renderer.render_mezzanine(
            recipe=recipe,
            output=output,
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )

        self.assertEqual(3, len(renderer.margin_measurement_filters))
        self.assertEqual("", renderer.margin_measurement_filters[0])
        self.assertIn(
            "volume='pow(10", renderer.margin_measurement_filters[1]
        )
        self.assertIn(
            ",volume=", renderer.margin_measurement_filters[2]
        )
        final_graph = next(
            call[0][call[0].index("-filter_complex") + 1]
            for call in renderer.encode_calls
            if "-filter_complex" in call[0]
            and "[music_norm]" in " ".join(call[0])
        )
        self.assertIn(renderer.margin_measurement_filters[2], final_graph)
        report = json.loads(
            renderer._auto_mix_margin_report_path(output).read_text(encoding="utf-8")
        )
        self.assertTrue(
            all(8.0 <= item["marginLu"] <= 12.0 for item in report["windows"])
        )

    def test_short_music_extracts_declared_loop_region_before_repeating(self):
        commands = []

        def runner(command, **_options):
            commands.append(list(command))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        renderer = FFmpegCreativeRenderer(
            self.root,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            command_runner=runner,
        )
        recipe = auto_mix_v2_recipe()
        recipe["licensed_music"] = {
            "duration_ms": 2_000,
            "loop_start_ms": 500,
            "loop_end_ms": 1_500,
        }
        music_path = self.root / "music" / "licensed.mp3"
        music_input, loop_path = renderer._auto_mix_music_input(
            music_path,
            recipe,
            required_duration_ms=5_000,
            output=self.root / "short-music.mp4",
        )

        self.assertEqual(1, len(commands))
        extraction = commands[0]
        self.assertEqual("0.500", extraction[extraction.index("-ss") + 1])
        self.assertEqual("1.000", extraction[extraction.index("-t") + 1])
        self.assertEqual(str(music_path), extraction[extraction.index("-i") + 1])
        self.assertEqual(["-stream_loop", "-1", "-i", str(loop_path)], music_input)
        self.assertNotIn(str(music_path), music_input)

    def test_formal_recipe_rejects_estimated_and_unknown_caption_timing(self):
        renderer = CapturingV2Renderer(self.root)
        for timing in ("estimated", "provider_unknown", None):
            with self.subTest(timing=timing):
                recipe = auto_mix_v2_recipe()
                recipe["captions"][0]["timing"] = timing
                with self.assertRaises(ContentEngineError) as caught:
                    renderer.render_mezzanine(
                        recipe=recipe,
                        output=self.root / f"timing-{timing}.mp4",
                        temp_dir=self.root / f"timing-stage-{timing}",
                        resolve_asset_path=lambda asset_id: self.root
                        / f"{asset_id}.mp4",
                    )
                self.assertEqual("auto_mix_caption_estimated", caught.exception.code)

    def test_probe_audio_duration_is_read_only_and_path_neutral_on_failure(self):
        calls = []

        def runner(command, **_options):
            calls.append(list(command))
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {"streams": [{"duration": "12.345"}], "format": {}}
                ),
                stderr="",
            )

        renderer = FFmpegCreativeRenderer(
            self.root,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            command_runner=runner,
        )
        self.assertEqual(
            12_345, renderer.probe_audio_duration_ms(self.root / "music" / "licensed.mp3")
        )
        self.assertIn("a:0", calls[-1])

        renderer._run_process = lambda command, **options: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr=f"failed to open {self.root / 'private-license-proof.txt'}",
        )
        with self.assertRaises(ContentEngineError) as caught:
            renderer.probe_audio_duration_ms(self.root / "missing.mp3")
        self.assertEqual("audio_probe_failed", caught.exception.code)
        self.assertNotIn(str(self.root), caught.exception.message)

    def test_hybrid_returns_and_re_adopts_audio_quality_report(self):
        ffmpeg = FakeHybridFFmpeg()
        renderer = HybridCreativeRenderer(
            self.root, ffmpeg_renderer=ffmpeg, worker_client=FakeWorker()
        )
        output_dir = self.root / "generated" / "candidate-v2"
        recipe = auto_mix_v2_recipe()
        result = renderer.render(
            video_id="candidate-v2",
            recipe=recipe,
            output_dir=output_dir,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        self.assertEqual(-15.1, result["audioQualityReport"]["integrated_lufs"])
        manifest = json.loads((output_dir / "candidate-manifest.json").read_text("utf-8"))
        self.assertEqual(result["audioQualityReport"], manifest["audioQualityReport"])

        adopted_recipe = deepcopy(auto_mix_v2_recipe())
        adopted = renderer.render(
            video_id="candidate-v2",
            recipe=adopted_recipe,
            output_dir=output_dir,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        self.assertEqual(result["audioQualityReport"], adopted["audioQualityReport"])
        self.assertEqual(1, ffmpeg.mezzanine_calls)

    def test_v2_never_falls_back_even_if_persisted_flag_is_tampered(self):
        ffmpeg = FakeHybridFFmpeg()
        renderer = HybridCreativeRenderer(
            self.root,
            ffmpeg_renderer=ffmpeg,
            worker_client=FakeWorker(
                RemotionRenderError("capability", "browser_unavailable")
            ),
        )
        recipe = auto_mix_v2_recipe(allow_fallback=True)
        with self.assertRaises(RemotionRenderError):
            renderer.render(
                video_id="tampered-v2",
                recipe=recipe,
                output_dir=self.root / "generated" / "tampered-v2",
                resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
            )
        self.assertEqual(0, ffmpeg.legacy_calls)

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"),
        "V2 audio-graph smoke requires local media tools.",
    )
    def test_real_v2_mezzanine_audio_graph_smoke(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        source = self.root / "visual-a.mp4"
        voice = self.root / "voices" / "verified.wav"
        music = self.root / "music" / "licensed.mp3"
        commands = (
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=360x640:rate=30",
                "-t",
                "1.2",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                str(source),
            ],
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                "1.2",
                "-c:a",
                "pcm_s16le",
                str(voice),
            ],
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=180:sample_rate=48000",
                "-t",
                "1.5",
                "-c:a",
                "libmp3lame",
                str(music),
            ],
        )
        for command in commands:
            subprocess.run(command, check=True, timeout=60)

        recipe = auto_mix_v2_recipe()
        recipe["voice_segment"]["end_ms"] = 1_200
        recipe["captions"][0]["end_ms"] = 1_200
        recipe["licensed_music"]["duration_ms"] = 1_500
        recipe["visual_segments"][0].update(
            {"start_ms": 0, "end_ms": 1_200, "target_duration_ms": 1_200}
        )
        renderer = FFmpegCreativeRenderer(
            self.root,
            ffmpeg_path=ffmpeg,
            ffprobe_path=ffprobe,
            timeout_seconds=120,
        )
        renderer._encoder_checked = True
        renderer._preferred_encoder = "libx264"
        stage = self.root / "real-stage"
        stage.mkdir()
        output = self.root / "real-v2-mezzanine.mp4"
        renderer.render_mezzanine(
            recipe=recipe,
            output=output,
            temp_dir=stage,
            resolve_asset_path=lambda asset_id: self.root / f"{asset_id}.mp4",
        )
        metadata = renderer.validate_mezzanine(output, expected_duration_ms=1_200)
        report = renderer.measure_audio_quality(output)
        report.update(renderer.read_auto_mix_speech_music_report(output))
        self.assertEqual(1080, metadata["width"])
        self.assertEqual(1920, metadata["height"])
        self.assertGreaterEqual(report["integrated_lufs"], -16.0)
        self.assertLessEqual(report["integrated_lufs"], -14.0)
        self.assertLessEqual(report["true_peak_dbtp"], -1.0)
        self.assertEqual(10.0, report["speech_music_margin_lu"])


if __name__ == "__main__":
    unittest.main()
