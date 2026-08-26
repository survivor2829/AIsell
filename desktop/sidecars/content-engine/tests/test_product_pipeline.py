import unittest
from pathlib import Path
import sys

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.product_pipeline import (
    build_local_copy,
    build_product_recipes,
    build_visual_only_copy,
    classify_assets,
    product_script_mismatch_reason,
)


class ProductPipelineTests(unittest.TestCase):
    def setUp(self):
        self.assets = [
            {
                "asset_id": "asset-image-1",
                "display_name": "机器人产品特写.jpg",
                "media_kind": "image",
                "duration_ms": 0,
                "has_audio": False,
            },
            {
                "asset_id": "asset-video-1",
                "display_name": "机器人清扫现场.mp4",
                "media_kind": "video",
                "duration_ms": 24_000,
                "has_audio": False,
            },
            {
                "asset_id": "asset-video-2",
                "display_name": "工厂环境.mp4",
                "media_kind": "video",
                "duration_ms": 18_000,
                "has_audio": True,
            },
        ]

    @staticmethod
    def _balanced_video_assets():
        return [
            {
                "asset_id": f"asset-video-{index}",
                "display_name": f"产品场景 {index}.mp4",
                "media_kind": "video",
                "duration_ms": duration,
                "has_audio": index == 0,
            }
            for index, duration in enumerate(
                (86_000, 48_000, 13_500, 12_867, 7_633), start=1
            )
        ]

    def test_classification_is_opaque_and_tags_product_material(self):
        cards = classify_assets(self.assets)
        self.assertEqual([item["asset_id"] for item in cards], [
            "asset-image-1", "asset-video-1", "asset-video-2"
        ])
        self.assertIn("product_detail", cards[0]["tags"])
        self.assertIn("function_demo", cards[1]["tags"])
        self.assertNotIn("path", cards[0])

    def test_local_copy_has_script_roles_and_no_untrusted_claims(self):
        copy = build_local_copy(
            {
                "industry": "清洁机器人",
                "brand_name": "示例品牌",
                "product_name": "无人清洁机器人",
                "selling_points": "自动作业、减少人工",
                "target_customer": "物业和工厂",
            },
            classify_assets(self.assets),
            count=3,
        )
        self.assertEqual(copy["provider"], "local_fallback")
        self.assertEqual(len(copy["title_candidates"]), 3)
        self.assertGreaterEqual(len(copy["shots"]), len(self.assets))
        self.assertIn("voiceover", copy)

    def test_recipes_bound_source_ranges_and_vary_candidates(self):
        cards = classify_assets(self._balanced_video_assets())
        script = build_local_copy({"product_name": "无人清洁机器人"}, cards, count=3)
        recipes = build_product_recipes(
            cards,
            script,
            output_count=3,
            duration_ms=75_000,
            product_context={
                "industry": "清洁机器人",
                "brand_name": "示例品牌",
                "product_name": "无人清洁机器人",
                "selling_points": "自动作业、室外清扫",
                "avoid": "洗碗机、厨房",
            },
        )
        self.assertEqual(len(recipes), 3)
        skeletons = {recipe["skeleton_id"] for recipe in recipes}
        self.assertEqual(len(skeletons), 3)
        for recipe in recipes:
            self.assertEqual("无人清洁机器人", recipe["product_context"]["product_name"])
            self.assertEqual("洗碗机、厨房", recipe["product_context"]["avoid"])
            self.assertNotIn("absolute_path", recipe["product_context"])
            self.assertGreaterEqual(recipe["voice_segment"]["end_ms"], 60_000)
            self.assertLessEqual(recipe["voice_segment"]["end_ms"], 90_000)
            self.assertGreaterEqual(len(recipe["visual_segments"]), 6)
            elapsed = recipe["voice_segment"]["end_ms"]
            usage = recipe["capacity_report"]["asset_usage_ms"]
            self.assertTrue(all(value / elapsed <= 0.35 for value in usage.values()))
            for segment in recipe["visual_segments"]:
                self.assertLess(segment["start_ms"], segment["end_ms"])
                if segment["media_kind"] == "video":
                    self.assertLessEqual(
                        segment["end_ms"] - segment["start_ms"],
                        next(item["duration_ms"] for item in cards if item["asset_id"] == segment["asset_id"]),
                    )
            by_asset = {}
            for segment in recipe["visual_segments"]:
                by_asset.setdefault(segment["asset_id"], []).append(
                    (segment["start_ms"], segment["end_ms"])
                )
            for ranges in by_asset.values():
                for index, current in enumerate(ranges):
                    for other in ranges[index + 1:]:
                        self.assertFalse(
                            current[0] < other[1] and other[0] < current[1],
                            (current, other),
                        )

    def test_visual_only_copy_never_invents_voice_or_product_story(self):
        copy = build_visual_only_copy(classify_assets(self.assets))
        self.assertEqual("none", copy["voice_mode"])
        self.assertEqual("", copy["voiceover"])
        self.assertEqual([], copy["title_candidates"])
        self.assertTrue(all(not shot["caption"] for shot in copy["shots"]))

        recipes = build_product_recipes(
            classify_assets(self._balanced_video_assets()),
            build_visual_only_copy(classify_assets(self._balanced_video_assets())),
            output_count=1,
            duration_ms=60_000,
        )
        self.assertEqual("visual_montage", recipes[0]["audio_mode"])
        self.assertEqual([], recipes[0]["captions"])
        ranges = {
            (item["asset_id"], item["start_ms"], item["end_ms"])
            for item in recipes[0]["visual_segments"]
        }
        self.assertEqual(len(ranges), len(recipes[0]["visual_segments"]))

    def test_unclassified_audio_track_is_not_promoted_to_source_bgm(self):
        assets = classify_assets(
            [
                {
                    **item,
                    "has_audio": True,
                    "audio_mode": "source_audio_unclassified",
                    "speech_status": "failed",
                }
                for item in self._balanced_video_assets()
            ]
        )
        recipe = build_product_recipes(
            assets,
            build_visual_only_copy(assets),
            output_count=1,
            duration_ms=60_000,
        )[0]

        self.assertNotIn("source_bgm_asset_id", recipe)

    def test_source_voice_keeps_original_audio_instead_of_switching_to_tts(self):
        fixtures = self._balanced_video_assets()
        assets = classify_assets(
            [
                {
                    **fixtures[0],
                    "audio_mode": "source_voice",
                    "speech_status": "recognized",
                    "transcript_evidence": ["现场讲解清扫效果"],
                    "transcript_segments": [
                        {"start_ms": 1_000, "end_ms": 3_000, "text": "现场讲解清扫效果"}
                    ],
                },
                *fixtures[1:],
            ]
        )
        script = {
            "voice_mode": "source_voice",
            "shots": [{"asset_id": assets[0]["asset_id"], "caption": "清扫效果"}],
            "hook": "",
            "cta": "",
        }
        recipe = build_product_recipes(assets, script, output_count=1, duration_ms=60_000)[0]
        self.assertEqual("visual_montage", recipe["audio_mode"])
        self.assertTrue(any(item["text"] == "现场讲解清扫效果" for item in recipe["captions"]))
        self.assertEqual(
            {"source_transcript"},
            {item["caption_source"] for item in recipe["captions"]},
        )
        self.assertTrue(
            any(
                item["text"] == "清扫效果"
                and item["label_source"] == "planned_caption"
                for item in recipe["visual_labels"]
            )
        )
        for index, caption in enumerate(recipe["captions"]):
            for other in recipe["captions"][index + 1:]:
                self.assertFalse(
                    caption["start_ms"] < other["end_ms"]
                    and other["start_ms"] < caption["end_ms"]
                )

    def test_tts_voiceover_owns_caption_lane_and_visual_copy_stays_in_labels(self):
        assets = classify_assets(self._balanced_video_assets())
        script = {
            "voice_mode": "tts",
            "voiceover": "第一句介绍真实产品。第二句说明实际作业。最后一句完成收束。",
            "shots": [
                {
                    "asset_id": assets[0]["asset_id"],
                    "caption": "产品外观标签",
                },
                {
                    "asset_id": assets[1]["asset_id"],
                    "caption": "实际作业标签",
                },
            ],
            "hook": "开头视觉钩子",
            "cta": "结尾行动提示",
        }

        recipe = build_product_recipes(
            assets, script, output_count=1, duration_ms=60_000
        )[0]

        self.assertTrue(recipe["captions"])
        self.assertEqual(
            {"tts_voiceover"},
            {item["caption_source"] for item in recipe["captions"]},
        )
        self.assertEqual(
            {"estimated"},
            {item["timing"] for item in recipe["captions"]},
        )
        label_sources = {item["label_source"] for item in recipe["visual_labels"]}
        self.assertTrue({"hook", "planned_caption", "cta"}.issubset(label_sources))
        spoken_text = "".join(item["text"] for item in recipe["captions"])
        self.assertNotIn("产品外观标签", spoken_text)
        self.assertNotIn("实际作业标签", spoken_text)
        self.assertNotIn("开头视觉钩子", spoken_text)
        self.assertNotIn("结尾行动提示", spoken_text)
        duration = recipe["voice_segment"]["end_ms"]
        previous_end = 0
        for caption in recipe["captions"]:
            self.assertGreaterEqual(caption["start_ms"], previous_end)
            self.assertGreater(caption["end_ms"], caption["start_ms"])
            self.assertLessEqual(caption["end_ms"], duration)
            previous_end = caption["end_ms"]
        # The renderer may pad a short TTS file with silence so the MP4 keeps
        # its full duration.  Caption timing must still describe only the
        # estimated spoken portion, not pretend narration fills the video.
        self.assertLess(recipe["captions"][-1]["end_ms"], duration)

    def test_non_speech_modes_never_turn_visual_copy_into_spoken_captions(self):
        assets = classify_assets(self._balanced_video_assets())
        for voice_mode in ("none", "source_audio", "source_voice"):
            with self.subTest(voice_mode=voice_mode):
                script = {
                    "voice_mode": voice_mode,
                    "voiceover": "",
                    "shots": [
                        {
                            "asset_id": assets[0]["asset_id"],
                            "caption": "只用于画面卡片",
                        }
                    ],
                    "hook": "只用于开头画面",
                    "cta": "只用于结尾画面",
                }
                recipe = build_product_recipes(
                    assets, script, output_count=1, duration_ms=60_000
                )[0]

                self.assertEqual([], recipe["captions"])
                self.assertEqual(
                    {"hook", "planned_caption", "cta"},
                    {item["label_source"] for item in recipe["visual_labels"]},
                )

    def test_repeated_planned_asset_keeps_shot_identity_without_overlapping_source(self):
        assets = classify_assets(self._balanced_video_assets())
        repeated_id = assets[0]["asset_id"]
        script = {
            "voice_mode": "none",
            "shots": [
                {
                    "shot_id": f"planned-{index}",
                    "asset_id": repeated_id,
                    "caption": f"画面说明 {index}",
                    "action": f"动作 {index}",
                }
                for index in range(1, 4)
            ],
            "hook": "",
            "cta": "",
        }

        recipe = build_product_recipes(
            assets, script, output_count=1, duration_ms=75_000
        )[0]
        planned = [
            item
            for item in recipe["visual_segments"]
            if item.get("planned_shot_id")
        ]
        self.assertEqual(
            ["planned-1", "planned-2", "planned-3"],
            [item["planned_shot_id"] for item in planned],
        )
        self.assertEqual(
            ["画面说明 1", "画面说明 2", "画面说明 3"],
            [item["planned_caption"] for item in planned],
        )
        ranges = [(item["start_ms"], item["end_ms"]) for item in planned]
        for index, current in enumerate(ranges):
            for other in ranges[index + 1:]:
                self.assertFalse(current[0] < other[1] and other[0] < current[1])

    def test_insufficient_capacity_shortens_instead_of_replaying(self):
        assets = classify_assets(
            [
                {
                    "asset_id": f"short-{index}",
                    "display_name": f"短素材 {index}.mp4",
                    "media_kind": "video",
                    "duration_ms": 10_000,
                    "has_audio": False,
                }
                for index in range(4)
            ]
        )
        recipe = build_product_recipes(
            assets,
            build_visual_only_copy(assets),
            output_count=1,
            duration_ms=60_000,
        )[0]
        self.assertEqual(40_000, recipe["voice_segment"]["end_ms"])
        self.assertTrue(recipe["capacity_report"]["shortened"])
        self.assertEqual(
            "unique_source_capacity", recipe["capacity_report"]["reason"]
        )

    def test_less_than_thirty_seconds_balanced_capacity_returns_no_recipe(self):
        assets = classify_assets(
            [
                {
                    "asset_id": f"tiny-{index}",
                    "display_name": f"极短素材 {index}.mp4",
                    "media_kind": "video",
                    "duration_ms": 9_000,
                    "has_audio": False,
                }
                for index in range(3)
            ]
        )
        self.assertEqual(
            [],
            build_product_recipes(
                assets,
                build_visual_only_copy(assets),
                output_count=1,
                duration_ms=60_000,
            ),
        )

    def test_product_script_mismatch_is_detected_against_locked_identity(self):
        reason = product_script_mismatch_reason(
            {
                "title_candidates": ["厨房洗碗机体验"],
                "hook": "洗碗机自动清洗餐具",
                "voiceover": "这台洗碗机适合家庭厨房。",
                "shots": [],
                "cta": "了解洗碗机",
            },
            {"product_name": "清洁扫地机器人", "industry": "清洁机器人"},
        )
        self.assertEqual("product_category_mismatch", reason)
        self.assertIsNone(
            product_script_mismatch_reason(
                {
                    "title_candidates": ["清洁扫地机器人真实作业"],
                    "hook": "看看清洁扫地机器人如何完成清扫",
                    "voiceover": "它在真实场景中自动完成清洁。",
                    "shots": [],
                    "cta": "了解清洁扫地机器人",
                },
                {"product_name": "清洁扫地机器人", "industry": "清洁机器人"},
            )
        )


if __name__ == "__main__":
    unittest.main()
