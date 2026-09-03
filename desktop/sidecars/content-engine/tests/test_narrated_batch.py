"""Small service-level batch contracts; cloud/TTS/media I/O use existing fakes."""
import itertools
import json
import unittest

import test_auto_mix_v2 as fixtures
from content_engine.narrated_batch import NarratedBatchDomain, near_duplicate, validate_count
from content_engine.errors import ContentEngineError


class NarratedBatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.AutoMixV2ServiceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.s = self.fixture.service
        self.fixture._install_approved_voice()
        self.fixture._import_valid_music()
        self.analyzer, self.renderer = fixtures._HappyAnalyzer(), fixtures._HappyRenderer()
        self.fixture._use_pipeline(self.analyzer, self.renderer)
        self.analyzer.cloud_client.selection_model = "fake"
        self.analyzer.cloud_client._structured_completion = self.complete
        db = self.s.connection
        db.execute("UPDATE media_segments SET provider='bailian'")
        self.ids = ["asset-v2"]
        for i in range(1, 7):
            aid = f"asset-batch-{i}"
            self.ids.append(aid)
            asset = dict(db.execute("SELECT * FROM assets WHERE id='asset-v2'").fetchone())
            asset.update(id=aid, fingerprint=f"fingerprint-{i}", full_fingerprint=f"full-{i}")
            db.execute(f"INSERT INTO assets({','.join(asset)}) VALUES({','.join('?' for _ in asset)})", list(asset.values()))
            source = self.fixture.root / f"material-{i}.mp4"
            source.write_bytes(f"material-{i}".encode())
            db.execute("INSERT INTO asset_locations SELECT ?,?,?,size_bytes,modified_ns,is_available,created_at,last_seen_at FROM asset_locations WHERE asset_id='asset-v2'",
                       (f"location-batch-{i}", aid, str(source)))
            base = db.execute("SELECT * FROM media_segments WHERE id='segment-v2'").fetchone()
            metadata = json.loads(base["metadata_json"])
            metadata["content_signature"] = f"batch-sequence-{i}"
            db.execute("INSERT INTO media_segments(id,asset_id,start_ms,end_ms,transcript_text,speaker,role,shot_type,tags_json,quality_score,analysis_version,provider,metadata_json,created_at,updated_at) VALUES(?,?,0,18000,?,'','process','function_demo','[]',.92,'test-analysis-v1','bailian',?,?,?)",
                       (f"segment-batch-{i}", aid, base["transcript_text"], json.dumps(metadata), base["created_at"], base["updated_at"]))

    def complete(self, *, messages, **kwargs):
        payload = json.loads(messages[-1]["content"])
        if "overlong_plans" in payload:
            return {"candidates": [{**c, "phrases": [{"text": "机器人沿墙移动。", "shot_ids": [k]} for k in c["shot_ids"]]}
                                   for c in payload["overlong_plans"]]}
        if "candidates" in payload:
            return {"reviews": [{"candidate_id": c["candidate_id"], "accepted": True,
                                  "quality_score": .9 if i < 3 else .75, "reason": "可核验的演示"}
                                 for i, c in enumerate(payload["candidates"])]}
        if "narration" in payload:
            return {"title": payload["title"], "shot_ids": [s["segment_id"] for s in payload["shots"]],
                    "phrases": [{"text": "机器人沿墙移动。", "shot_ids": [s["segment_id"]]} for s in payload["shots"]]}
        shots = payload["shots"]
        by_asset = {}
        for s in shots:
            by_asset.setdefault(s["asset_id"], s)
        parts = [[by_asset[a] for a in ids] for ids in (self.ids[:2], self.ids[2:4], self.ids[4:])]
        existing = payload["avoid_sequences"]
        items = []
        combinations = itertools.permutations(by_asset.values(), 4) if getattr(self, "capacity_mode", False) else itertools.product(*parts)
        for triple in combinations:
            ids = [s["segment_id"] for s in triple]
            if ids in existing:
                continue
            items.append({"title": "机器人真实展示", "angle": "过程演示", "shot_ids": ids,
                          "phrases": [{"text": "机器人沿墙移动。", "shot_ids": [s["segment_id"]]} for s in triple]})
        return {"candidates": items[:payload["count"]], "reason": "按不同画面组合进行筛选"}

    def create(self, count):
        return self.s.save_narrated_batch({"groups": {"opening": self.ids[:2], "middle": self.ids[2:4], "ending": self.ids[4:]},
                                           "title": "真实展示", "target_count": count,
                                           "settings": {"voice_persona_id": "natural-life@1"}})

    def run_samples(self, b):
        queued = self.s.generate_narrated_samples(b["batch_id"])
        task = self.s.run_creative_task(queued["task_id"])
        self.assertEqual("completed", task["status"], task)
        return self.s.get_narrated_batch(b["batch_id"])

    def test_rejected_plans_preserve_reasons_without_recommending_zero(self):
        original = self.complete
        for stage in ("validation", "review"):
            def rejected(*, messages, **kwargs):
                result = original(messages=messages, **kwargs)
                if "candidates" in result and stage == "validation":
                    for item in result["candidates"]:
                        item["phrases"][0]["text"] = "画" * 80
                if "reviews" in result and stage == "review":
                    for item in result["reviews"]:
                        item.update(accepted=False, reason="主体关联缺少画面依据")
                return result
            self.analyzer.cloud_client._structured_completion = rejected
            b = self.create(5)
            queued = self.s.recommend_narrated_batch(b["batch_id"])
            task = self.s.run_creative_task(queued["task_id"])
            self.assertEqual("completed", task["status"])
            public = self.s.get_narrated_batch(b["batch_id"])
            self.assertEqual(0, public["feasible_count"])
            self.assertNotIn("建议选择 0", "".join(public["reasons"]))
            expected = "解说超过" if stage == "validation" else "主体关联缺少画面依据"
            self.assertIn(expected, "".join(public["reasons"]))
            stored = json.loads(self.s.connection.execute("SELECT state_json FROM narrated_batches_v1 WHERE id=?", (b["batch_id"],)).fetchone()[0])
            self.assertEqual(stage, stored["_planning_audit"][0]["rejections"][0]["stage"])
            self.assertNotIn("_planning_audit", public)

    def test_overlong_copy_is_rewritten_once_then_reviewed(self):
        original = self.complete
        repairs = []
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            result = original(messages=messages, **kwargs)
            if "overlong_plans" in payload:
                repairs.append(payload)
            elif "shots" in payload and "candidates" in result:
                self.assertTrue(all("max_narration_chars" in s for s in payload["shots"]))
                for c in result["candidates"]:
                    c["phrases"][0]["text"] = "画" * 80
            return result
        self.analyzer.cloud_client._structured_completion = complete
        b = self.create(5)
        queued = self.s.recommend_narrated_batch(b["batch_id"])
        self.assertEqual("completed", self.s.run_creative_task(queued["task_id"])["status"])
        public = self.s.get_narrated_batch(b["batch_id"])
        self.assertGreaterEqual(public["feasible_count"], 5)
        self.assertEqual(1, len(repairs))
        self.assertTrue(all(c["quality_score"] >= .65 for c in public["candidates"]))

    def test_requested_six_exceeds_recommendation_samples_then_continue(self):
        b = self.run_samples(self.create(6))
        self.assertEqual(3, b["recommended_count"])
        self.assertEqual(12, b["feasible_count"])
        self.assertEqual("awaiting_confirmation", b["status"])
        self.assertEqual(3, sum(c["status"] == "completed" for c in b["candidates"]))
        before = len(self.renderer.rendered_recipes)
        queued = self.s.continue_narrated_batch(b["batch_id"])
        result = self.s.run_creative_task(queued["task_id"])
        self.assertEqual("completed", result["status"], result)
        b = self.s.get_narrated_batch(b["batch_id"])
        self.assertEqual(6, sum(c["status"] == "completed" for c in b["candidates"]))
        self.assertEqual(3, len(self.renderer.rendered_recipes) - before)
        self.assertTrue(all(r["audio_mode"] == "tts_only" for r in self.renderer.rendered_recipes))

    def test_insufficient_fifty_does_not_synthesize(self):
        b = self.run_samples(self.create(50))
        self.assertEqual("insufficient_materials", b["status"])
        self.assertEqual([], self.analyzer.synthesized)
        self.assertEqual([], self.renderer.rendered_recipes)
        self.assertEqual(50, b["target_count"])

    def test_one_two_and_five_have_exact_targets(self):
        for count in (1, 2, 5):
            with self.subTest(count=count):
                # Historical completed plans must not contaminate this count
                # boundary test; cross-batch dedupe has a separate assertion.
                self.s.connection.execute("DELETE FROM narrated_history_v1")
                b = self.run_samples(self.create(count))
                self.assertEqual(min(3, count), sum(c["status"] == "completed" for c in b["candidates"]))
                self.assertEqual("completed" if count <= 3 else "awaiting_confirmation", b["status"])

    def test_collection_reference_and_duplicate_contract(self):
        a = self.s.save_asset_collection({"name": "设备", "asset_ids": self.ids, "description": "现场实拍"})
        b = self.s.save_asset_collection({"name": "案例", "asset_ids": self.ids[:2]})
        self.assertNotEqual(a["collection_id"], b["collection_id"])
        self.assertEqual(2, len(self.s.list_asset_collections()["collections"]))
        self.assertEqual(300, validate_count(300))
        with self.assertRaises(ContentEngineError):
            validate_count(301)
        shot = {"asset_id": "a", "source_start_ms": 0, "source_end_ms": 4000, "evidence_ref": "same"}
        self.assertTrue(near_duplicate([shot], [{**shot, "source_start_ms": 100}]))

    def test_missing_or_ambiguous_footage_is_not_a_candidate(self):
        b = self.run_samples(self.create(1))
        domain = NarratedBatchDomain(self.s.creative_domain)
        shots = b["available_shots"][:3]
        ids = [s["segment_id"] for s in shots]
        for refs in ([ids[0]], ids):
            with self.assertRaises(ContentEngineError):
                domain._normalize_candidate({"title": "错误方案", "shot_ids": ids,
                    "phrases": [{"text": "真实演示。", "shot_ids": refs}]}, b, [])

    def test_pause_resume_and_edit_tenth_without_repeating_completed(self):
        for count in (12,):
            self.s.connection.execute("DELETE FROM narrated_history_v1")
            b = self.run_samples(self.create(count))
            self.assertEqual(count, b["feasible_count"])
            task = self.s.continue_narrated_batch(b["batch_id"])
            self.s.update_task(task["task_id"], "paused")
            self.assertEqual("paused", self.s.get_narrated_batch(b["batch_id"])["task_status"])
            self.s.resume_creative_task(task["task_id"])
            result = self.s.run_creative_task(task["task_id"])
            self.assertEqual("completed", result["status"], result)
            b = self.s.get_narrated_batch(b["batch_id"])
            self.assertEqual(count, sum(c["status"] == "completed" for c in b["candidates"]))
            previous = {c["candidate_id"]: c["generated_video_id"] for c in b["candidates"]}
            tenth = b["candidates"][9]
            b = self.s.update_narrated_candidate({"batch_id": b["batch_id"], "candidate_id": tenth["candidate_id"], "title": "修改标题"})
            before = len(self.renderer.rendered_recipes)
            b = self.run_samples(b)
            self.assertEqual(1, len(self.renderer.rendered_recipes) - before)
            for c in b["candidates"]:
                if c["candidate_id"] != tenth["candidate_id"]:
                    self.assertEqual(previous[c["candidate_id"]], c["generated_video_id"])

    def test_offline_capacity_plans_100_and_300(self):
        self.capacity_mode = True
        for count in (100, 300):
            b = self.create(count)
            queued = self.s.recommend_narrated_batch(b["batch_id"])
            result = self.s.run_creative_task(queued["task_id"])
            self.assertEqual("completed", result["status"], result)
            b = self.s.get_narrated_batch(b["batch_id"])
            self.assertEqual(count, b["feasible_count"])
            self.assertEqual(count, len(b["candidates"]))
            self.assertFalse(b["count_is_exact"])
            self.assertEqual([], self.renderer.rendered_recipes)


if __name__ == "__main__":
    unittest.main()
