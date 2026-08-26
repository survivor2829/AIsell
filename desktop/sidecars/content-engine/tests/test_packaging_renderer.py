from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.creative_render import FFmpegCreativeRenderer
from content_engine.packaging import PACKAGING_PRESETS


PRESET_IDS = (
    "knowledge_focus",
    "slide_teacher",
    "classroom_value",
    "hook_impact",
    "process_rhythm",
    "result_close",
)


def packaging_for(preset_id: str) -> dict:
    packaging = deepcopy(PACKAGING_PRESETS[preset_id])
    packaging.update(
        {
            "title": "培训现场价值",
            "brand": {
                "primary_color": "#6D5DFB",
                "accent_color": "#FFE45C",
                "font_preset": "microsoft_yahei",
            },
            "events": [
                {"type": "title", "start_ms": 0, "end_ms": 2_400},
                {"type": "hook", "start_ms": 0, "end_ms": 3_000},
                {"type": "keyword", "start_ms": 3_000, "end_ms": 5_800},
                {"type": "slide_focus", "start_ms": 4_000, "end_ms": 7_000},
                {"type": "process", "start_ms": 6_000, "end_ms": 9_000},
                {"type": "result", "start_ms": 9_000, "end_ms": 11_000},
                {"type": "close", "start_ms": 11_000, "end_ms": 12_000},
            ],
            "cover": {"mode": "local_frame"},
        }
    )
    return packaging


class CapturingRenderer(FFmpegCreativeRenderer):
    def __init__(self, data_dir: Path):
        super().__init__(
            data_dir,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
        )
        self.encode_calls = []

    def _encode_with_fallback(self, input_args, output, *, audio=True):
        self.encode_calls.append((list(input_args), Path(output), audio))


class ReuseCoverRenderer(FFmpegCreativeRenderer):
    def __init__(self, data_dir: Path):
        super().__init__(
            data_dir,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
        )
        self.cover_calls = 0

    def _render_course(self, recipe, output, subtitle, resolve_asset_path):
        Path(output).write_bytes(b"video")

    def _render_cover(
        self,
        output,
        thumbnail,
        packaging,
        resolve_asset_path=None,
        *,
        seek_seconds=0.5,
    ):
        self.cover_calls += 1
        Path(thumbnail).write_bytes(b"discarded-cover")


class PackagingRendererTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.renderer = CapturingRenderer(self.root)

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def course_recipe(packaging: dict | None = None) -> dict:
        recipe = {
            "kind": "course",
            "voice_segment": {
                "asset_id": "asset_course",
                "start_ms": 10_000,
                "end_ms": 20_000,
            },
            "visual_segments": [
                {
                    "asset_id": "asset_course",
                    "start_ms": 10_000,
                    "end_ms": 12_000,
                    "frame_mode": "teacher_focus",
                },
                {
                    "asset_id": "asset_course",
                    "start_ms": 12_000,
                    "end_ms": 15_000,
                    "frame_mode": "slide_with_teacher_pip",
                },
                {
                    "asset_id": "asset_course",
                    "start_ms": 15_000,
                    "end_ms": 20_000,
                    "frame_mode": "teacher_focus",
                },
            ],
            "captions": [],
        }
        if packaging is not None:
            recipe["packaging"] = packaging
        return recipe

    def test_six_presets_have_distinct_event_driven_filtergraphs(self):
        graphs = {
            preset_id: self.renderer._packaging_filter(packaging_for(preset_id))
            for preset_id in PRESET_IDS
        }

        self.assertEqual(6, len(set(graphs.values())))
        self.assertIn("观点 01", graphs["knowledge_focus"])
        self.assertIn("课件重点", graphs["slide_teacher"])
        self.assertIn("培训现场", graphs["classroom_value"])
        self.assertIn("开场重点", graphs["hook_impact"])
        self.assertIn("步骤 01", graphs["process_rhythm"])
        self.assertIn("结果总结", graphs["result_close"])
        for preset_id in PRESET_IDS[:3]:
            self.assertNotIn("fontcolor=black", graphs[preset_id])
        self.assertEqual(2, graphs["hook_impact"].count("fontcolor=black"))
        self.assertEqual(2, graphs["process_rhythm"].count("fontcolor=black"))
        self.assertEqual(1, graphs["result_close"].count("fontcolor=black"))

    def test_product_ffmpeg_fallback_keeps_only_grounded_title_and_caption_lane(self):
        packaging = packaging_for("hook_impact")
        packaging["fallback_safe_clean"] = True
        graph = self.renderer._packaging_filter(packaging)

        self.assertIn("培训现场价值", graph)
        self.assertNotIn("开场重点", graph)
        self.assertNotIn("观点 01", graph)
        self.assertNotIn("步骤 01", graph)

        recipe = {
            "voice_segment": {"start_ms": 0},
            "subtitle_style": {"preset": "dynamic_clean"},
        }
        cues = self.renderer._caption_cues(
            [
                {
                    "start_ms": 0,
                    "end_ms": 4_000,
                    "text": "画面描述，不应与原声转写重叠。",
                    "caption_priority": 1,
                },
                {
                    "start_ms": 1_000,
                    "end_ms": 3_000,
                    "text": "真实原声转写。",
                    "caption_priority": 4,
                },
            ],
            recipe,
        )
        self.assertEqual(["真实原声转写。"], [cue["text"] for cue in cues])

    def test_bundled_commercial_font_is_preferred(self):
        expected = (
            SIDECAR_ROOT
            / "content_engine"
            / "assets"
            / "fonts"
            / "NotoSansSC-Variable.ttf"
        ).resolve()
        discovered = self.renderer._discover_font_paths()

        self.assertTrue(expected.is_file())
        self.assertEqual(expected, discovered["microsoft_yahei"])
        self.assertEqual(expected, discovered["source_han_sans"])
        self.assertEqual(expected, discovered["neutral_sans"])

        manifest_path = expected.parents[1] / "ASSETS.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        font = next(item for item in manifest["assets"] if item["type"] == "font")
        self.assertEqual("OFL-1.1", font["license"])
        self.assertTrue((manifest_path.parent / font["license_file"]).is_file())
        self.assertEqual(
            font["sha256"], hashlib.sha256(expected.read_bytes()).hexdigest()
        )

    def test_slide_teacher_switches_only_during_relative_slide_interval(self):
        recipe = self.course_recipe(packaging_for("slide_teacher"))

        graph = self.renderer._course_layout_filter(recipe, None)
        self.renderer._render_course(
            recipe,
            self.root / "course.mp4",
            None,
            lambda _asset_id: self.root / "source.mp4",
        )

        self.assertIn("[0:v]split=3", graph)
        self.assertIn("between(t,2.000,5.000)", graph)
        self.assertNotIn("between(t,0.000,10.000)", graph)
        command = self.renderer.encode_calls[0][0]
        self.assertEqual("10.000", command[command.index("-ss") + 1])
        self.assertEqual("10.000", command[command.index("-t") + 1])
        self.assertEqual("[vout]", command[command.index("-map") + 1])
        self.assertIn("between(t,2.000,5.000)", command[command.index("-filter_complex") + 1])

    def test_course_layout_behavior_follows_selected_preset(self):
        knowledge = self.course_recipe(packaging_for("knowledge_focus"))
        classroom = self.course_recipe(packaging_for("classroom_value"))

        self.assertEqual("", self.renderer._course_layout_filter(knowledge, None))
        classroom_graph = self.renderer._course_layout_filter(classroom, None)
        self.assertIn("wide_background", classroom_graph)
        self.assertIn("between(t,3.000,5.400)", classroom_graph)
        self.assertNotIn("slide_composed]overlay=0:0", classroom_graph)

    def test_old_unwrapped_slide_recipe_keeps_legacy_presentation_path(self):
        recipe = self.course_recipe()

        self.renderer._render_course(
            recipe,
            self.root / "legacy.mp4",
            None,
            lambda _asset_id: self.root / "source.mp4",
        )

        command = self.renderer.encode_calls[0][0]
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("[0:v]split=2[slide_source][classroom_source]", graph)
        self.assertNotIn("enable='between", graph)

    def test_reuse_cover_skips_discarded_cover_rendering(self):
        renderer = ReuseCoverRenderer(self.root)
        source = self.root / "source.mp4"
        source.write_bytes(b"source")
        packaging = packaging_for("knowledge_focus")
        packaging["audio"] = {"profile": "course_clean", "bgm": False, "cue_budget": 0}
        packaging["brand"] = None
        packaging["cover"] = {
            "mode": "reuse",
            "source_generated_video_id": "generated_video_source",
        }
        recipe = self.course_recipe(packaging)
        output_dir = self.root / "generated" / "candidate"

        result = renderer.render(
            video_id="candidate",
            recipe=recipe,
            output_dir=output_dir,
            resolve_asset_path=lambda _asset_id: source,
        )

        self.assertEqual(0, renderer.cover_calls)
        self.assertTrue(result["video_path"].is_file())
        self.assertTrue(result["thumbnail_path"].is_file())
        self.assertEqual(0, result["thumbnail_path"].stat().st_size)


if __name__ == "__main__":
    unittest.main()
