from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.errors import ContentEngineError
from content_engine.protocol import METHODS
from content_engine.service import ContentEngineService, utc_now


class MixEngineTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.service = ContentEngineService(Path(self.temp_dir.name) / "data")
        self._insert_asset("asset_a", "A.mp4", 1_000)
        self._insert_asset("asset_b", "B.mp4", 2_000)
        self._insert_asset("asset_c", "C.mp4", 3_000)

    def tearDown(self):
        self.service.close()
        self.temp_dir.cleanup()

    def _insert_asset(self, asset_id: str, display_name: str, duration_ms: int):
        now = utc_now()
        self.service.connection.execute(
            """
            INSERT INTO assets(
                id, fingerprint, media_kind, extension, size_bytes, display_name,
                rights_status, created_at, updated_at, probe_status, duration_ms
            ) VALUES (?, ?, 'video', '.mp4', 1, ?, 'owned', ?, ?, 'ok', ?)
            """,
            (asset_id, asset_id, display_name, now, now, duration_ms),
        )

    def _create_project(self, **overrides):
        payload = {
            "name": "课程混剪",
            "slots": [
                {
                    "name": "开场",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b"],
                },
                {
                    "name": "正文",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_c"],
                },
            ],
            "constraints": {
                "allow_repeated_assets": False,
                "min_duration_ms": 3_500,
                "max_duration_ms": 5_000,
            },
        }
        payload.update(overrides)
        return self.service.create_mix_project(**payload)

    def test_persists_project_slots_and_counts_exact_valid_cartesian_product(self):
        created = self._create_project()

        restored = self.service.get_mix_project(created["project_id"])
        count = self.service.calculate_mix_combinations(created["project_id"])

        self.assertEqual("课程混剪", restored["name"])
        self.assertEqual(2, len(restored["slots"]))
        self.assertEqual(2, count["combination_count"])
        self.assertEqual(4, count["raw_cartesian_count"])
        self.assertEqual(
            {
                "required_slots": 2,
                "fixed_slots": 0,
                "allow_repeated_assets": False,
                "duration_constrained": True,
            },
            count["constraints_applied"],
        )

        self.service.close()
        self.service = ContentEngineService(Path(self.temp_dir.name) / "data")
        listed = self.service.list_mix_projects()
        self.assertEqual(created["project_id"], listed["items"][0]["project_id"])

    def test_optional_and_fixed_slots_are_counted_and_invalid_assets_are_rejected(self):
        project = self.service.create_mix_project(
            name="固定片尾",
            slots=[
                {
                    "name": "主内容",
                    "required": True,
                    "fixed_asset_id": "asset_a",
                    "asset_ids": ["asset_b"],
                },
                {
                    "name": "可选片尾",
                    "required": False,
                    "asset_ids": ["asset_b", "asset_c"],
                },
            ],
            constraints={"allow_repeated_assets": False},
        )
        count = self.service.calculate_mix_combinations(project["project_id"])
        self.assertEqual(3, count["raw_cartesian_count"])
        self.assertEqual(3, count["combination_count"])

        with self.assertRaises(ContentEngineError) as raised:
            self.service.update_mix_project(
                project["project_id"],
                slots=[
                    {
                        "name": "坏槽位",
                        "required": True,
                        "asset_ids": ["missing_asset"],
                    }
                ],
            )
        self.assertEqual("asset_not_found", raised.exception.code)

    def test_seeded_generation_is_deterministic_explainable_and_balances_usage(self):
        project = self.service.create_mix_project(
            name="多样性",
            slots=[
                {
                    "name": "前半段",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b", "asset_c"],
                },
                {
                    "name": "后半段",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b", "asset_c"],
                },
            ],
            constraints={"allow_repeated_assets": False},
        )

        first = self.service.generate_mix_candidates(
            project["project_id"], limit=3, seed="campaign-7"
        )
        second = self.service.generate_mix_candidates(
            project["project_id"], limit=3, seed="campaign-7"
        )

        first_signatures = [item["selection_signature"] for item in first["items"]]
        second_signatures = [item["selection_signature"] for item in second["items"]]
        self.assertEqual(first_signatures, second_signatures)
        self.assertEqual(3, len(set(first_signatures)))
        for candidate in first["items"]:
            self.assertIn("total", candidate["score"])
            self.assertIn("usage_penalty", candidate["score"])
            self.assertTrue(candidate["score"]["explanations"])
            self.assertNotIn("absolute_path", json.dumps(candidate))

        usage = first["asset_usage_counts"]
        self.assertLessEqual(max(usage.values()) - min(usage.values()), 1)

    def test_generation_streams_large_combination_space_through_a_bounded_beam(self):
        project = self.service.create_mix_project(
            name="大组合空间",
            slots=[
                {
                    "name": f"槽位 {index}",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b", "asset_c"],
                }
                for index in range(10)
            ],
            constraints={"allow_repeated_assets": True},
        )

        generated = self.service.generate_mix_candidates(
            project["project_id"], limit=2, seed="bounded"
        )

        self.assertEqual(3**10, generated["generation_stats"]["inspected_count"])
        self.assertLessEqual(
            generated["generation_stats"]["retained_count"],
            generated["generation_stats"]["beam_capacity"],
        )
        self.assertLessEqual(generated["generation_stats"]["beam_capacity"], 32)
        self.assertEqual(2, len(generated["items"]))

    def test_combination_count_reports_too_large_instead_of_traversing_every_choice(self):
        project = self.service.create_mix_project(
            name="bounded count",
            slots=[
                {
                    "name": f"slot {index}",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b", "asset_c"],
                }
                for index in range(12)
            ],
            constraints={"allow_repeated_assets": True},
        )

        counted = self.service.calculate_mix_combinations(project["project_id"])

        self.assertEqual(3**12, counted["raw_cartesian_count"])
        self.assertIsNone(counted["combination_count"])
        self.assertFalse(counted["count_is_exact"])
        self.assertEqual("too_large", counted["count_status"])

    def test_streaming_selector_does_not_retain_the_full_input_iterable(self):
        project = self._create_project()
        domain = self.service.mix_domain
        persisted = domain._load_project(project["project_id"])

        class TrackedChoice:
            alive = 0
            peak = 0

            def __init__(self, value):
                self.value = value
                type(self).alive += 1
                type(self).peak = max(type(self).peak, type(self).alive)

            def __iter__(self):
                return iter(self.value)

            def __del__(self):
                type(self).alive -= 1

        def choices():
            for index in range(5_000):
                yield TrackedChoice((f"synthetic-{index}", None))

        with mock.patch.object(domain, "_valid_combinations", return_value=choices()):
            retained, inspected = domain._stream_candidate_beam(
                persisted, (), "bounded-memory", 16
            )

        self.assertEqual(5_000, inspected)
        self.assertEqual(16, len(retained))
        self.assertLessEqual(TrackedChoice.peak, 18)

    def test_custom_score_weights_are_persisted_normalized_and_explained(self):
        project = self.service.create_mix_project(
            name="自定义评分",
            slots=[
                {
                    "name": "素材",
                    "required": True,
                    "asset_ids": ["asset_a", "asset_b"],
                }
            ],
            constraints={
                "allow_repeated_assets": False,
                "score_weights": {
                    "duration_fit": 0,
                    "diversity": 4,
                    "freshness": 0,
                },
            },
        )
        generated = self.service.generate_mix_candidates(
            project["project_id"], limit=1, seed="weighted"
        )
        score = generated["items"][0]["score"]

        self.assertEqual(
            {"duration_fit": 0.0, "diversity": 1.0, "freshness": 0.0},
            project["constraints"]["score_weights"],
        )
        self.assertEqual(100.0, score["total"])
        self.assertEqual(project["constraints"]["score_weights"], score["weights"])
        self.assertEqual(0.0, score["weighted_components"]["duration_fit"])
        self.assertEqual(100.0, score["weighted_components"]["diversity"])
        self.assertTrue(any("权重" in item for item in score["explanations"]))
        self.assertTrue(any("使用次数" in item for item in score["explanations"]))

        with self.assertRaises(ContentEngineError) as raised:
            self.service.create_mix_project(
                name="无效权重",
                slots=[
                    {
                        "name": "素材",
                        "required": True,
                        "fixed_asset_id": "asset_a",
                    }
                ],
                constraints={
                    "score_weights": {
                        "duration_fit": 0,
                        "diversity": 0,
                        "freshness": 0,
                    }
                },
            )
        self.assertEqual("invalid_score_weights", raised.exception.code)

    def test_review_approval_enqueues_publish_item_and_queue_status_is_mutable(self):
        project = self._create_project()
        candidate = self.service.generate_mix_candidates(
            project["project_id"], limit=1, seed=11
        )["items"][0]

        reviewed = self.service.review_mix_candidate(
            candidate["candidate_id"], "approved", review_note="可发布"
        )
        queue = self.service.list_publish_queue()

        self.assertEqual("approved", reviewed["review_status"])
        self.assertEqual(1, len(queue["items"]))
        self.assertEqual(candidate["candidate_id"], queue["items"][0]["candidate_id"])
        self.service.close()
        self.service = ContentEngineService(Path(self.temp_dir.name) / "data")
        self.assertEqual(
            candidate["candidate_id"],
            self.service.list_mix_candidates()["items"][0]["candidate_id"],
        )
        queue = self.service.list_publish_queue()
        updated = self.service.update_publish_queue_item(
            queue["items"][0]["queue_item_id"], "processing"
        )
        self.assertEqual("processing", updated["status"])

        with self.assertRaises(ContentEngineError) as raised:
            self.service.review_mix_candidate(candidate["candidate_id"], "maybe")
        self.assertEqual("invalid_review_status", raised.exception.code)

    def test_constraint_update_invalidates_stale_candidates_and_publish_queue(self):
        project = self._create_project()
        candidate = self.service.generate_mix_candidates(
            project["project_id"], limit=1, seed="before-update"
        )["items"][0]
        self.service.review_mix_candidate(candidate["candidate_id"], "approved")

        self.service.update_mix_project(
            project["project_id"],
            constraints={
                "allow_repeated_assets": True,
                "min_duration_ms": 3_000,
                "max_duration_ms": 6_000,
            },
        )

        self.assertEqual(
            [],
            self.service.list_mix_candidates(project_id=project["project_id"])[
                "items"
            ],
        )
        self.assertEqual([], self.service.list_publish_queue()["items"])

    def test_protocol_exposes_mix_domain_without_path_resolution_methods(self):
        expected = {
            "create_mix_project",
            "update_mix_project",
            "get_mix_project",
            "list_mix_projects",
            "calculate_mix_combinations",
            "generate_mix_candidates",
            "list_mix_candidates",
            "review_mix_candidate",
            "list_publish_queue",
            "update_publish_queue_item",
        }
        self.assertTrue(expected.issubset(METHODS))
        self.assertFalse(any("path" in name for name in expected))
        project = METHODS["create_mix_project"](
            self.service,
            {
                "name": "协议项目",
                "slots": [
                    {
                        "name": "固定槽",
                        "required": True,
                        "fixed_asset_id": "asset_a",
                    }
                ],
                "constraints": {},
            },
        )
        counted = METHODS["calculate_mix_combinations"](
            self.service, {"project_id": project["project_id"]}
        )
        self.assertEqual(1, counted["combination_count"])
        self.assertNotIn("absolute_path", json.dumps(project, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
