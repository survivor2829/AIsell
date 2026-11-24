"""Each work of a batch takes its cover from a shot the earlier covers did not use."""
import unittest

from content_engine.cover_frame import cover_segment, recipe_cover_segment, segment_window


def shot(segment_id, asset, start, end, **extra):
    return {"segment_id": segment_id, "asset_id": asset, "start_ms": start, "end_ms": end, **extra}


class CoverFrameTest(unittest.TestCase):
    def test_first_work_keeps_its_opening_shot(self):
        shots = [shot("a", "m1", 0, 3000), shot("b", "m2", 0, 3000)]
        self.assertEqual("a", cover_segment(shots)["segment_id"])

    def test_later_work_prefers_another_material_then_another_range(self):
        shots = [shot("a", "m1", 0, 3000), shot("b", "m1", 5000, 8000), shot("c", "m2", 0, 3000)]
        self.assertEqual("c", cover_segment(shots, [("m1", 0, 3000)])["segment_id"])
        self.assertEqual("b", cover_segment(shots, [("m1", 0, 3000), ("m2", 0, 3000)])["segment_id"])

    def test_all_used_still_varies_and_skips_ending_assist_image(self):
        shots = [shot("a", "m1", 0, 3000), shot("s", "img", 0, 0, role="supplemental", media_kind="image")]
        self.assertEqual("a", cover_segment(shots, [("m1", 0, 3000)])["segment_id"])
        two = [shot("a", "m1", 0, 3000), shot("b", "m1", 1000, 4000)]
        avoid = [("m1", 0, 4000)]
        self.assertEqual("b", cover_segment(two, avoid)["segment_id"])

    def test_timeline_shots_and_images_have_windows(self):
        self.assertEqual(("m1", 10, 20), segment_window({"asset_id": "m1", "source_start_ms": 10, "source_end_ms": 20}))
        self.assertEqual(("img", 0, 1), segment_window({"asset_id": "img", "start_ms": 0, "end_ms": 0}))
        both = {"asset_id": "m1", "start_ms": 0, "end_ms": 3000, "source_start_ms": 5000, "source_end_ms": 8000}
        self.assertEqual(("m1", 5000, 8000), segment_window(both))

    def test_recipe_uses_chosen_segment_and_old_recipes_the_first(self):
        shots = [shot("a", "m1", 0, 3000), shot("b", "m2", 0, 3000)]
        self.assertEqual("b", recipe_cover_segment({"visual_segments": shots, "cover_segment_id": "b"})["segment_id"])
        self.assertEqual("a", recipe_cover_segment({"visual_segments": shots})["segment_id"])
        self.assertEqual("a", recipe_cover_segment({"visual_segments": shots, "cover_segment_id": "gone"})["segment_id"])


if __name__ == "__main__":
    unittest.main()
