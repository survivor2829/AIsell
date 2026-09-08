"""Small service-level batch contracts; cloud/TTS/media I/O use existing fakes."""
import itertools
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_auto_mix_v2 as fixtures
from content_engine.narrated_batch import (
    NarratedBatchDomain, VISUAL_FACTS_VERSION, CLAIM_AUDIT_VERSION, canonical_hash, near_duplicate, validate_count,
    reported_speech_context, reported_speech_cache_key, compact_claim_segment,
    closing_action_cache_key,
    compact_claim_semantics, semantic_review_cache_key,
    typed_visual_review_cache_key, visual_findings_error,
)
from content_engine.errors import ContentEngineError


ORIGINAL_GROUND_SHOTS = NarratedBatchDomain._ground_shots


class NarratedBatchTests(unittest.TestCase):
    def setUp(self):
        # These service contract tests fake media and cloud I/O, including visual grounding.
        grounding = patch.object(NarratedBatchDomain, "_ground_shots", lambda self, task, batch, shots, snapshots, versions: shots)
        grounding.start()
        self.addCleanup(grounding.stop)
        self.fixture = fixtures.AutoMixV2ServiceTests()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
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
        if "requested_count" in payload:
            return {"stories": [], "limitations": []}
        if "paragraphs" in payload:
            return {"paragraphs": [{"index": p["index"], "text": "看看现场表现。"} for p in payload["paragraphs"]]}
        if "rejected_plans" in payload:
            return {"candidates": payload["rejected_plans"]}
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
        b = self.s.save_narrated_batch({"groups": {"opening": self.ids[:2], "middle": self.ids[2:4], "ending": self.ids[4:]},
                                           "title": "真实展示", "target_count": count,
                                           "settings": {"voice_persona_id": "natural-life@1"}})
        # Existing cases exercise compatibility with previously persisted batches.
        state = json.loads(self.s.connection.execute("SELECT state_json FROM narrated_batches_v1 WHERE id=?", (b["batch_id"],)).fetchone()[0])
        state.pop("_story_planning_version", None)
        self.s.connection.execute("UPDATE narrated_batches_v1 SET state_json=? WHERE id=?", (json.dumps(state), b["batch_id"]))
        return b

    def test_story_paragraph_can_span_multiple_shots_and_render(self):
        original = self.complete
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            if "available_asset_ids" not in payload:
                return original(messages=messages, **kwargs)
            keys = [s["segment_id"] for s in payload["shots"]
                    if s["asset_id"] == payload["available_asset_ids"][0]][:3]
            return {"candidates": [{"title": "不同现场的清洁展示", "angle": "场景选择", "shot_ids": keys,
                                    "phrases": [{"text": "挑选设备时，先看看现场地面和通道。不同场景有不同的需求，需要结合实际情况判断。最后这句话也必须完整显示。", "shot_ids": keys}]}]}
        self.analyzer.cloud_client._structured_completion = complete
        grounding = patch.object(NarratedBatchDomain, "_ground_shots",
            lambda self, task, batch, shots, snapshots, versions:
                [{**shot, "content_signature": shot["segment_id"]} for shot in shots])
        grounding.start()
        self.addCleanup(grounding.stop)
        batch = self.s.save_narrated_batch({"groups": {"opening": self.ids[:3], "middle": [], "ending": []}, "target_count": 1})
        planned = self.run_samples(batch)
        self.assertEqual("completed", planned["status"])
        rendered = planned
        self.assertEqual("completed", rendered["status"], rendered["candidates"])
        self.assertEqual(3, len(rendered["candidates"][0]["phrases"][0]["shot_ids"]))
        video_id = rendered["candidates"][0]["generated_video_id"]
        recipe = json.loads(self.s.connection.execute("SELECT recipe_json FROM generated_videos WHERE id=?", (video_id,)).fetchone()[0])
        actual_duration = sum(s["target_duration_ms"] for s in recipe["visual_segments"])
        self.assertEqual(recipe["captions"][-1]["end_ms"], actual_duration)
        self.assertEqual(rendered["candidates"][0]["narration"], "".join(c["text"] for c in recipe["captions"]))
        self.assertLess(actual_duration, sum(shot["target_duration_ms"] for shot in planned["candidates"][0]["shots"]))

    def test_new_story_can_select_materials_and_exceed_sixty_seconds(self):
        original = self.complete
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            if "available_asset_ids" not in payload:
                return original(messages=messages, **kwargs)
            by_asset = {s["asset_id"]: s for s in payload["shots"]}
            self.assertEqual(1, payload["count"])
            ids = [by_asset[a]["segment_id"] for a in payload["available_asset_ids"][:4]]
            return {"candidates": [{"title": "清洁机器人不同场景实拍", "angle": "多场景展示", "shot_ids": ids,
                                    "phrases": [{"text": "看看机器人的现场表现。", "shot_ids": [k]} for k in ids]}]}
        self.analyzer.cloud_client._structured_completion = complete
        b = self.s.save_narrated_batch({"groups": {"opening": self.ids[:1], "middle": self.ids[1:3], "ending": self.ids[3:5]}, "target_count": 1})
        planned = self.run_samples(b)
        self.assertEqual("completed", planned["status"])
        self.assertTrue(all(c.get("generated_video_id") for c in planned["candidates"]))
        self.assertEqual(set(self.ids[:4]), {s["asset_id"] for s in planned["candidates"][0]["shots"]})
        domain = NarratedBatchDomain(self.s.creative_domain)
        key = planned["available_shots"][0]["segment_id"]
        raw = {"title": "选材测试", "shot_ids": [key], "phrases": [{"text": "看看现场表现。", "shot_ids": [key]}]}
        state = json.loads(self.s.connection.execute("SELECT state_json FROM narrated_batches_v1 WHERE id=?", (b["batch_id"],)).fetchone()[0])
        self.assertEqual(1, len(domain._normalize_candidate(raw, state, [])["shots"]))
        from copy import deepcopy
        long_state = deepcopy(state)
        planned_ids = {s["segment_id"] for s in planned["candidates"][0]["shots"]}
        for shot in long_state["available_shots"]:
            if shot["segment_id"] in planned_ids:
                shot["source_end_ms"] = shot["source_start_ms"] + 18_000
                shot["target_duration_ms"] = 18_000
        long_raw = {"title": "完整展示", "shot_ids": [s["segment_id"] for s in planned["candidates"][0]["shots"]],
                    "phrases": planned["candidates"][0]["phrases"]}
        self.assertGreater(domain._normalize_candidate(long_raw, long_state, [])["duration_ms"], 60_000)
        done = planned
        candidate = done["candidates"][0]
        self.assertEqual("completed", candidate["status"], candidate.get("error"))
        self.assertEqual([s["segment_id"] for s in candidate["shots"]],
                         [s["segment_id"] for s in candidate["actual_shots"]])
        for original, actual in zip(candidate["shots"], candidate["actual_shots"]):
            self.assertLessEqual(original["source_start_ms"], actual["source_start_ms"])
            self.assertGreaterEqual(original["source_end_ms"], actual["source_end_ms"])

    def run_samples(self, b):
        queued = self.s.generate_narrated_samples(b["batch_id"])
        task = self.s.run_creative_task(queued["task_id"])
        self.assertEqual("completed", task["status"], task)
        return self.s.get_narrated_batch(b["batch_id"])

    def test_script_options_do_not_render_and_confirmed_first_precedes_batch_variations(self):
        events = []
        batch = self.s.save_narrated_batch({"groups": {"opening": self.ids[:2]},
            "title": "现场选择", "target_count": 2, "settings": {"workflow_version": 2}})
        with self.assertRaises(ContentEngineError) as error:
            self.s.generate_narrated_samples(batch["batch_id"])
        self.assertEqual("narrated_script_confirmation_required", error.exception.code)

        def plan(domain, task_id, state, wanted):
            domain._initialize_speech_budget(state)
            options = state.get("_preparing_scripts")
            rows = state.setdefault("script_options", []) if options else state["candidates"]
            events.append(("plan_options" if options else "plan_variation", wanted))
            for number in range(len(rows), wanted):
                shot = state["available_shots"][0 if options else -1]
                key = shot["segment_id"]
                row = domain._normalize_candidate({"title": f"方向{number}", "angle": f"问题{number}",
                    "audience": "使用者", "pain_point": "场地不合适", "shot_ids": [key],
                    "phrases": [{"text": f"我想先看第{number + 1}处现场。", "shot_ids": [key]}]}, state,
                    [item["shots"] for item in rows])
                row["review_version"] = 2
                rows.append(row)

        def render(domain, task_id, state, candidate, index, total):
            domain._verify_confirmed_script(state, candidate)
            events.append(("render", candidate["narration"]))
            candidate.update(status="completed", generated_video_id=f"fake-{index}")

        with patch.object(NarratedBatchDomain, "_plan", plan), \
                patch.object(NarratedBatchDomain, "_prepare_script_options", lambda domain, task_id, state: plan(domain, task_id, state, 3)), \
                patch.object(NarratedBatchDomain, "_render_candidate", render):
            queued = self.s.prepare_narrated_scripts(batch["batch_id"])
            prepared_task = self.s.run_creative_task(queued["task_id"])
            self.assertEqual("completed", prepared_task["status"], prepared_task)
            prepared = self.s.get_narrated_batch(batch["batch_id"])
            self.assertEqual("scripts_ready", prepared["status"])
            self.assertEqual(3, len(prepared["script_options"]))
            self.assertEqual([], prepared["candidates"])
            self.assertEqual([], self.renderer.rendered_recipes)
            self.assertFalse(any(key.startswith("_") for key in prepared["script_options"][0]))
            selected = prepared["script_options"][1]
            domain = self.s._narrated_batches()
            state = domain._load(batch["batch_id"])
            state["_preparing_scripts"] = True
            with patch.object(NarratedBatchDomain, "_history", return_value=[selected["shots"]]):
                with self.assertRaises(ContentEngineError) as duplicate:
                    domain._normalize_candidate({**selected, "shot_ids": [s["segment_id"] for s in selected["shots"]]}, state, [])
            self.assertEqual("narrated_duplicate", duplicate.exception.code, "Published work is excluded before TTS even for alternatives")
            request = {"batch_id": batch["batch_id"], "script_id": selected["candidate_id"], "revision": selected["revision"]}
            queued = self.s.confirm_narrated_script(request)
            self.assertEqual("completed", self.s.run_creative_task(queued["task_id"])["status"])
            completed = self.s.get_narrated_batch(batch["batch_id"])
            self.assertEqual("completed", completed["status"])
            self.assertEqual(2, len(completed["candidates"]))
            self.assertEqual(selected["narration"], completed["candidates"][0]["narration"])
            self.assertEqual(selected["narration"], completed["script_confirmation"]["narration"])
            self.assertEqual(selected["angle"], completed["candidates"][1]["angle"])
            self.assertEqual(["plan_options", "render", "plan_variation", "render"], [item[0] for item in events])
            queued = self.s.confirm_narrated_script(request)
            self.s.run_creative_task(queued["task_id"])
            self.assertEqual(2, sum(item[0] == "render" for item in events), "Repeat confirmation must reuse completed work")
            state = domain._load(batch["batch_id"])
            state["candidates"][0].update(status="failed", error_code="render_failed", error="Local renderer unavailable", _run_id="kept-run")
            domain._store(state)
            with patch.object(self.s.creative_domain, "_auto_mix_run_row", return_value={"status": "rendering"}):
                queued = self.s.continue_narrated_batch(batch["batch_id"])
                self.s.run_creative_task(queued["task_id"])
            state = domain._load(batch["batch_id"])
            self.assertEqual("completed", state["status"])
            self.assertEqual("kept-run", state["candidates"][0]["_run_id"])
            self.assertEqual(selected["narration"], state["candidates"][0]["narration"])
            self.assertEqual(3, sum(item[0] == "render" for item in events))
            state["candidates"][0].update(status="failed", error_code="narrated_copy_too_long", error="Needs copy edit")
            domain._store(state)
            queued = self.s.continue_narrated_batch(batch["batch_id"])
            self.s.run_creative_task(queued["task_id"])
            self.assertEqual(3, sum(item[0] == "render" for item in events), "A copy failure must require a new confirmation")

    def test_script_edit_invalidates_confirmation_and_stale_revision_cannot_render(self):
        batch = self.s.save_narrated_batch({"groups": {"opening": self.ids[:1]},
            "target_count": 1, "settings": {"workflow_version": 2}})
        domain = self.s._narrated_batches()
        state = domain._load(batch["batch_id"])
        option = {"candidate_id": "chosen-script", "title": "用户选择", "narration": "原来的正文。",
                  "revision": 1, "status": "planned", "audience": "使用者", "pain_point": "选择困难", "angle": "选择场景"}
        state.update(script_options=[option], selected_script_id="chosen-script", direction={"angle": "选择场景"},
                     script_confirmation={"script_id": "chosen-script", "revision": 1, "narration": "原来的正文。"})
        domain._store(state)
        edited = self.s.update_narrated_candidate({"batch_id": batch["batch_id"], "candidate_id": "chosen-script", "narration": "我想先看看现场。"})
        self.assertIsNone(edited["script_confirmation"])
        self.assertEqual(2, edited["script_options"][0]["revision"])
        self.assertEqual("原来的正文。", edited["script_confirmation_history"][0]["narration"])
        with self.assertRaises(ContentEngineError) as error:
            self.s.confirm_narrated_script({"batch_id": batch["batch_id"], "script_id": "chosen-script", "revision": 1})
        self.assertEqual("narrated_script_revision_changed", error.exception.code)
        with self.assertRaises(ContentEngineError) as error:
            domain._verify_confirmed_script(state, {"narration": "偷偷替换的正文。", "_confirmed_script": {"narration": "原来的正文。"},
                                                   "_tracks": {"spoken_phrases": [{"text": "偷偷替换的正文。"}]}})
        self.assertEqual("narrated_confirmed_script_changed", error.exception.code)

    def test_story_v2_uses_rewritten_script_and_fills_two_candidates(self):
        requested = []
        rewrite_issues = []
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            if "requested_count" in payload:
                requested.append(payload["requested_count"])
                return {"stories": [], "limitations": []}
            if "mapped_plan_repairs" in payload:
                invalid = {"candidates": [{"narration_draft": "短"}]}
                rewrite_issues.append(kwargs["validation_error"](invalid))
                source = payload["mapped_plan_repairs"][0]["plan"]
                by_id = {shot["segment_id"]: shot for shot in payload["shots"]}
                assets = list(dict.fromkeys(by_id[key]["asset_id"] for key in source["shot_ids"]))
                phrases = [{"text": "先看这段现场画面，再比较周边的实际布置，明确还需要进一步核对的问题。",
                            "shot_ids": [s["segment_id"] for s in payload["shots"] if s["asset_id"] == asset][:2]}
                           for asset in assets]
                result = {"candidates": [{"title": source["title"], "angle": source["angle"], "phrases": phrases}]}
                self.assertIsNone(kwargs["validation_error"](result))
                return result
            if "candidates" in payload:
                return {"reviews": [{"candidate_id": item["candidate_id"], "accepted": True,
                                      "quality_score": .9, "reason": "结构完整"}
                                     for item in payload["candidates"]]}
            assets = payload["available_asset_ids"]
            sequences = (assets, assets[1:] + assets[:1], assets[2:] + assets[:2])
            by_asset = {asset: [shot for shot in payload["shots"] if shot["asset_id"] == asset]
                        for asset in assets}
            return {"candidates": [{"title": f"现场观察 {index + 1}", "angle": "场景比较",
                "shot_ids": [shot["segment_id"] for asset in sequence
                             for shot in (by_asset[asset][0], by_asset[asset][-1])],
                "phrases": [{"text": "看看现场表现。", "shot_ids": [shot["segment_id"]]}
                            for asset in sequence for shot in (by_asset[asset][0], by_asset[asset][-1])]}
                for index, sequence in enumerate(sequences[:payload["count"]])], "reason": "场景组合"}

        self.analyzer.cloud_client._structured_completion = complete
        grounding = patch.object(NarratedBatchDomain, "_ground_shots",
            lambda self, task, batch, shots, snapshots, versions:
                [{**shot, "content_signature": shot["segment_id"]} for shot in shots])
        grounding.start()
        self.addCleanup(grounding.stop)
        batch = self.s.save_narrated_batch({
            "groups": {"opening": self.ids[:1], "middle": self.ids[1:4], "ending": self.ids[4:5]},
            "title": "真实展示", "target_count": 2,
            "settings": {"voice_persona_id": "natural-life@1", "minimum_duration_seconds": 30},
        })
        queued = self.s.recommend_narrated_batch(batch["batch_id"])
        task = self.s.run_creative_task(queued["task_id"])
        self.assertEqual("completed", task["status"], task)
        planned = self.s.get_narrated_batch(batch["batch_id"])
        self.assertEqual(2, planned["feasible_count"], planned["reasons"])
        self.assertEqual(2, len(planned["candidates"]))
        self.assertTrue(all(len(item["narration"]) >= 150 for item in planned["candidates"]))
        self.assertEqual(2, len(rewrite_issues), "仅修复两条确实不足时长的稿件")
        self.assertIn("phrases", rewrite_issues[0])
        self.assertEqual([2], requested)

    def test_story_v2_preserves_valid_scene_mapping_without_rewrite(self):
        returned = []
        calls = []
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            calls.append(payload)
            if "requested_count" in payload:
                by_asset = {}
                for shot in payload["shots"]:
                    by_asset.setdefault(shot["asset_id"], []).append(shot)
                assets = list(by_asset)
                stories = []
                for number in range(payload["requested_count"]):
                    sequence = assets[number:] + assets[:number]
                    phrases = [{
                        "text": "先看这段现场画面，再比较周边的实际布置，明确还需要进一步核对的问题。",
                        "shot_ids": [s["segment_id"] for s in by_asset[asset][:2]],
                    } for asset in sequence]
                    stories.append({"title": f"现场观察 {number + 1}", "viewer_value": "比较现场布置",
                                    "phrases": phrases})
                returned.extend(stories)
                return {"stories": stories, "limitations": []}
            if "candidates" in payload:
                return {"reviews": [{"candidate_id": item["candidate_id"], "accepted": True,
                                      "quality_score": .9, "reason": "结构完整"}
                                     for item in payload["candidates"]]}
            self.fail("有效映射不应重新选镜头、扩写或按字数重新分段")

        self.analyzer.cloud_client._structured_completion = complete
        grounding = patch.object(NarratedBatchDomain, "_ground_shots",
            lambda self, task, batch, shots, snapshots, versions:
                [{**shot, "content_signature": shot["segment_id"]} for shot in shots])
        grounding.start()
        self.addCleanup(grounding.stop)
        with patch.object(NarratedBatchDomain, "_speech_ms_per_char", return_value=193.0):
            batch = self.s.save_narrated_batch({
                "groups": {"opening": self.ids[:1], "middle": self.ids[1:4], "ending": self.ids[4:5]},
                "title": "真实展示", "target_count": 2,
                "settings": {"voice_persona_id": "natural-life@1", "minimum_duration_seconds": 30},
            })
            queued = self.s.recommend_narrated_batch(batch["batch_id"])
            task = self.s.run_creative_task(queued["task_id"])
        self.assertEqual("completed", task["status"], task)
        planned = self.s.get_narrated_batch(batch["batch_id"])
        self.assertEqual(2, planned["feasible_count"], planned["reasons"])
        self.assertFalse(any("mapped_plan_repairs" in call or "scripts" in call for call in calls))
        for candidate, story in zip(planned["candidates"], returned):
            self.assertEqual(story["phrases"], candidate["phrases"])
            self.assertEqual([key for phrase in story["phrases"] for key in phrase["shot_ids"]],
                             [shot["segment_id"] for shot in candidate["shots"]])
            self.assertGreaterEqual(len(candidate["narration"]), 156)

    def test_repack_adds_visual_capacity_until_clause_allocation_succeeds(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        shots = [{"segment_id": f"shot-{index}", "asset_id": "asset-one",
                  "target_duration_ms": 5_000, "content_signature": f"visual-{index}"}
                 for index in range(6)]
        batch = {"available_shots": shots, "settings": {"minimum_duration_seconds": 0}}
        draft = "甲" * 40 + "。" + "乙" * 40 + "。"
        raw = {"title": "容量分配", "angle": "真实展示",
               "shot_ids": [shot["segment_id"] for shot in shots[:5]],
               "narration_draft": draft}

        prepared = domain._repack_duration_candidate(raw, batch, shots)

        self.assertEqual([shot["segment_id"] for shot in shots], prepared["shot_ids"])
        self.assertEqual(draft, "".join(item["text"] for item in prepared["phrases"]))
        self.assertEqual(2, len(prepared["phrases"]))

        mapped_batch = {**batch, "_story_planning_version": 2}
        mapped = {"title": "保留语义映射", "narration_draft": "整篇旧稿不能覆盖已经选定的对应关系。",
                  "phrases": [{"text": "这里是第一段。", "shot_ids": ["shot-0", "shot-1"]},
                              {"text": "接着看另一个位置。", "shot_ids": ["shot-2"]}]}
        result = domain._repack_duration_candidate(mapped, mapped_batch, shots)
        self.assertEqual(mapped["phrases"], result["phrases"])
        self.assertEqual(["shot-0", "shot-1", "shot-2"], result["shot_ids"])
        with self.assertRaises(ContentEngineError) as missing:
            domain._repack_duration_candidate(raw, mapped_batch, shots)
        self.assertEqual("narrated_mapping_invalid", missing.exception.code)
        mixed = {**mapped_batch, "available_shots": [
            {**shot, "asset_id": "another-scene"} if shot["segment_id"] == "shot-1" else shot
            for shot in shots]}
        with self.assertRaises(ContentEngineError) as mixed_scene:
            domain._repack_duration_candidate(mapped, mixed, mixed["available_shots"])
        self.assertEqual("narrated_mapping_invalid", mixed_scene.exception.code)
        self.assertIn("第1段", str(mixed_scene.exception))

    def test_source_evidence_pins_asset_range_version_provider_and_provenance(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        shot = {"asset_id": "asset-batch-1", "source_start_ms": 0, "source_end_ms": 5000}
        snapshot = {"asset_id": "asset-batch-1", "fingerprint": "pinned"}
        state = {"_versions": {"asset-batch-1": "test-analysis-v1"},
                 "_analysis_provider": "bailian", "_snapshots": [snapshot],
                 "_source_provenance": {"asset-batch-1": {
                     "authority": "user_confirmed", "snapshot_hash": canonical_hash(snapshot),
                     "activity_label": "设备操作培训", "source_record": "user-source-manifest"}}}
        self.s.connection.execute("UPDATE media_segments SET transcript_text=? WHERE id=?",
                                  ("有人问：怎么连接网络？", "segment-batch-1"))
        result = domain._source_evidence_for(state, shot)
        self.assertEqual(["segment-batch-1"], [s["segment_id"] for s in result["recorded_speech"]])
        self.assertEqual("设备操作培训", result["source_provenance"]["activity_label"])
        self.assertIn("怎么连接网络", domain._claim_source_text(result, "recorded_speech"))
        self.assertEqual([], domain._source_evidence_for(state, {**shot, "source_start_ms": 18000,
                                                                 "source_end_ms": 20000})["recorded_speech"])
        for invalid in [{**state, "_analysis_provider": "volcengine"},
                        {**state, "_versions": {"asset-batch-1": "old"}}]:
            self.assertEqual([], domain._source_evidence_for(invalid, shot)["recorded_speech"])
        changed = {**state, "_snapshots": [{**snapshot, "fingerprint": "changed"}]}
        self.assertEqual({}, domain._source_evidence_for(changed, shot)["source_provenance"])

    def test_grounded_claims_are_audited_before_visual_review(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        claim_frames = patch.object(domain, "_claim_frames", side_effect=lambda batch, candidate, source: ([], source["frames"]))
        claim_frames.start()
        self.addCleanup(claim_frames.stop)
        exact_phrase = "前方是干枯落叶，旁边是白色服务台和悬挂的标识牌。"
        self.assertEqual([exact_phrase],
                         [item["quote"] for item in domain._claim_statement_units("phrase-2", exact_phrase)])
        protected = "比例16:9，数量1,000，版本3.5，链接https://example.com/a,b?x=1,000；路径C:\\demo，括号（里面，保持）结束。"
        units = domain._claim_statement_units("phrase-protected", protected)
        self.assertEqual(protected, "".join(item["quote"] for item in units))
        self.assertEqual(["比例16:9，数量1,000，版本3.5，链接https://example.com/a,b?x=1,000；",
                          "路径C:\\demo，括号（里面，保持）结束。"],
                         [item["quote"] for item in units])
        advice = "第一次来培训，先带上自己关心的问题。"
        self.assertEqual([advice], [item['quote'] for item in domain._claim_statement_units('advice', advice)])
        batch = self.create(1)
        state = domain._load(batch["batch_id"])
        domain._active_batch = state
        observation = "画面中有一台绿色设备，设备位于室内通道。"
        shot = {"segment_id": "shot-grounded", "fact_id": "fact-grounded",
                "source_start_ms": 0, "source_end_ms": 5000,
                "description": observation,
                "visual_facts": {"observation": observation, "direct_observation": observation,
                                 "illustrative_observation": "", "evidence_class": "direct_real",
                                 "uncertainties": [], "onscreen_claims": []}}
        second_observation = "画面中可见室内地面。"
        second_shot = {"segment_id": "shot-grounded-2", "fact_id": "fact-grounded-2",
                       "source_start_ms": 5000, "source_end_ms": 10000,
                       "description": second_observation,
                       "visual_facts": {"observation": second_observation,
                                        "direct_observation": second_observation,
                                        "illustrative_observation": "",
                                        "evidence_class": "direct_real",
                                        "uncertainties": [], "onscreen_claims": []}}
        supported = {"candidate_id": "candidate-supported", "title": "通道现场",
                     "shots": [shot, second_shot],
                     "phrases": [{"text": "画面中有一台绿色设备。",
                                  "shot_ids": ["shot-grounded"]},
                                 {"text": "画面中可见室内地面，选型时要不要观察旁边设备？",
                                  "shot_ids": ["shot-grounded-2"]}]}
        unsupported = {"candidate_id": "candidate-unsupported", "title": "通道现场",
                       "shots": [shot], "phrases": [{"text": "设备经过以后地面没有任何残留。动画示意只是辅助。现场问过这些问题。选型时可以观察通道里的实际表现。",
                                                          "shot_ids": ["shot-grounded"]}]}

        def statement(segment, supported_fact):
            statements = []
            for expected in segment["statements"]:
                quote = expected["quote"]
                item = {"statement_id": expected["statement_id"], "supported": True,
                        "evidence": [], "reason": "不需要画面依据", "risk_scope": "nonassertive"}
                if segment["phrase_id"] == "title":
                    item["kind"] = "other"
                elif not supported_fact and "没有任何残留" in quote:
                    item.update(kind="advice", supported=True, risk_scope="absence",
                                reason="模型返回了自相矛盾的分类")
                elif not supported_fact and "动画示意" in quote:
                    item.update(kind="illustration", supported=True, risk_scope="nonassertive",
                                reason="模型返回了反向自相矛盾的分类")
                elif not supported_fact and "现场问过" in quote:
                    item.update(kind="fact", supported=True, risk_scope="recorded_speech",
                        evidence=[{"shot_id": "shot-grounded", "fact_id": "fact-grounded", "source": source}
                                  for source in ("direct_real", "recorded_speech")])
                elif not supported_fact:
                    item.update(kind="advice", reason="这是一般观察建议")
                elif quote.rstrip().endswith(("？", "?")):
                    item.update(kind="question", reason="这是观察问题")
                else:
                    second = segment["shot_ids"] == ["shot-grounded-2"]
                    item.update(kind="fact", risk_scope="direct_observation",
                                reason="画面直接可见", evidence=[{
                        "shot_id": "shot-grounded-2" if second else "shot-grounded",
                        "fact_id": "fact-grounded-2" if second else "fact-grounded",
                        "source": "direct_real",
                        "observation_quote": ("画面中可见室内地面" if second
                                              else "画面中有一台绿色设备"),
                    }])
                statements.append(item)
            return {"phrase_id": segment["phrase_id"], "statements": statements}

        timeouts = []
        segment_calls = []
        self.analyzer.cloud_client.timeout_seconds = 90

        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            timeouts.append(kwargs["timeout"])
            if payload.get("probe"):
                return {"ok": True}
            self.assertEqual(CLAIM_AUDIT_VERSION, payload["claim_audit_version"])
            segment = payload["segment"]
            segment_calls.append(payload)
            self.assertEqual(set(segment["shot_ids"]),
                             {fact["shot_id"] for fact in segment["facts"]})
            self.assertEqual(segment["text"], "".join(item["quote"] for item in segment["statements"]))
            self.assertEqual([f"{segment['phrase_id']}-statement-{index + 1}"
                              for index in range(len(segment["statements"]))],
                             [item["statement_id"] for item in segment["statements"]])
            good = (payload["candidate_id"] == supported["candidate_id"]
                    or segment["phrase_id"] == "title")
            response = {"candidate_id": payload["candidate_id"],
                        "segment_key": segment["segment_key"],
                        # A claim auditor may score a nonassertive title at
                        # zero even though it contains no unsupported claim.
                        "quality_score": 0 if segment["phrase_id"] == "title" else .9,
                        "reason": "逐条核对完成",
                        "phrase_review": statement(segment, good)}
            for item in response["phrase_review"]["statements"]:
                if item["kind"] == "fact" and item["supported"]:
                    item["evidence"][0].update(frame_index=0, frame_observation="实拍帧可见该物体。")
            self.assertIsNone(kwargs["validation_error"](response))
            frame_copy = json.loads(json.dumps(response, ensure_ascii=False))
            frame_items = [e for s in frame_copy["phrase_review"]["statements"] for e in s["evidence"] if "frame_index" in e]
            if frame_items:
                frame_items[0]["frame_index"] = len(segment["frames"])
                self.assertIn("原帧证据", kwargs["validation_error"](frame_copy))
            if len(segment["statements"]) > 1:
                reordered = json.loads(json.dumps(response, ensure_ascii=False))
                reordered["phrase_review"]["statements"].reverse()
                self.assertIn("statement_id", kwargs["validation_error"](reordered))
            return response

        visual_calls = []
        self.analyzer.cloud_client._structured_completion = complete
        with patch.object(domain, "_visual_review", side_effect=lambda candidate, current, claim_review=None: (
                visual_calls.append(candidate["candidate_id"]) or
                {"accepted": True, "quality_score": .95, "unsupported_claims": [], "reason": "画面复核通过"})):
            audit = {"rejections": []}
            accepted = domain._review([supported, unsupported], state, audit)
        self.assertEqual("事实声明核对完成，共 5 / 5 段", state["activity"]["message"])
        self.assertEqual((5, 5), (state["activity"]["completed"], state["activity"]["total"]))
        self.assertEqual(5, len(segment_calls))
        self.assertTrue(all("candidates" not in payload and "segment" in payload
                            for payload in segment_calls))
        supported_phrase_facts = [len(payload["segment"]["facts"]) for payload in segment_calls
                                  if payload["candidate_id"] == supported["candidate_id"]
                                  and payload["segment"]["phrase_id"] != "title"]
        self.assertEqual([1, 1], supported_phrase_facts,
                         "每段请求只能携带本段shot_ids对应的facts")
        self.assertEqual("completed", state["_claim_review_progress"]["status"])
        self.assertEqual(5, state["_claim_review_progress"]["completed"])
        self.assertEqual(5, len(state["_claim_review_segments"]))
        self.assertTrue(all(item.get("quote")
                            for saved in state["_claim_review_segments"].values()
                            for item in saved["response"]["phrase_review"]["statements"]),
                        "模型无需复述quote，程序仍须用既定原文补全审计记录")
        unsupported_saved = [saved for saved in state["_claim_review_segments"].values()
                             if saved["candidate_id"] == unsupported["candidate_id"]
                             and saved["phrase_id"] != "title"][0]
        self.assertFalse(unsupported_saved["response"]["accepted"],
                         "分段是否通过必须由程序根据unsupported statement计算")
        normalized = unsupported_saved["response"]["phrase_review"]["statements"][0]
        self.assertEqual(("fact", "absence", False),
                         (normalized["kind"], normalized["risk_scope"], normalized["supported"]))
        self.assertIn("审查分类自相矛盾", normalized["reason"])
        reverse = unsupported_saved["response"]["phrase_review"]["statements"][1]
        self.assertEqual(("illustration", "direct_observation", False),
                         (reverse["kind"], reverse["risk_scope"], reverse["supported"]))
        self.assertIn("审查分类自相矛盾", reverse["reason"])
        mismatched = unsupported_saved["response"]["phrase_review"]["statements"][2]
        self.assertFalse(mismatched["supported"])
        self.assertEqual([], mismatched["evidence"])
        self.assertIn("缺少实际的recorded_speech证据", mismatched["reason"])
        self.assertEqual([supported["candidate_id"]], [item["candidate_id"] for item in accepted])
        self.assertEqual([supported["candidate_id"]], visual_calls)
        self.assertEqual("claim_review", audit["rejections"][0]["stage"])
        self.assertEqual("设备经过以后地面没有任何残留。",
                         audit["rejections"][0]["unsupported_claims"][0]["quote"])
        self.assertEqual("动画示意只是辅助。",
                         audit["rejections"][0]["unsupported_claims"][1]["quote"])

        before_reuse = len(timeouts)
        self.analyzer.cloud_client._structured_completion = lambda **_kwargs: self.fail("已成功段不应重复请求")
        reused = domain._grounded_claim_review([supported, unsupported], state, {"rejections": []})
        self.assertEqual([supported["candidate_id"]], [item[0]["candidate_id"] for item in reused])
        self.assertEqual(before_reuse, len(timeouts))

        rebound = json.loads(json.dumps(supported))
        rebound["candidate_id"] = "candidate-recreated"
        for current in rebound["shots"]:
            current["segment_id"] += "-new"
            current["fact_id"] += "-new"
        # Runtime IDs may change, but the full narrative context must stay the same.
        for phrase in rebound["phrases"]:
            phrase["shot_ids"] = [key + "-new" for key in phrase["shot_ids"]]
        rebound_review = domain._grounded_claim_review([rebound], state, {"rejections": []})
        self.assertEqual("candidate-recreated", rebound_review[0][1]["candidate_id"])
        rebound_phrase = rebound_review[0][1]["phrase_reviews"][1]
        self.assertEqual("phrase-1-statement-1", rebound_phrase["statements"][0]["statement_id"])
        self.assertEqual("shot-grounded-new", rebound_phrase["statements"][0]["evidence"][0]["shot_id"])
        self.assertEqual("fact-grounded-new", rebound_phrase["statements"][0]["evidence"][0]["fact_id"])
        self.assertEqual(5, len(state["_claim_review_segments"]), "本轮未引用的段落缓存仍须保留")

        known_batch = self.create(1)
        known_state = domain._load(known_batch["batch_id"])
        domain._active_batch = known_state
        self.analyzer.cloud_client._structured_completion = lambda **_kwargs: (_ for _ in ()).throw(
            ContentEngineError("cloud_response_invalid", "模拟已知格式错误"))
        with self.assertRaises(ContentEngineError):
            domain._cloud({"known_failure": True}, "已知格式错误")
        known_stored = domain._load(known_batch["batch_id"])
        self.assertNotIn("_planning_inflight", known_stored)
        self.assertNotIn("_planning_request", known_stored,
                         "已知失败清除在途标记时不能残留旧请求说明")
        known_state["_planning_budget"] = {"status": "running", "started_at_epoch": 0,
            "max_elapsed_seconds": 1200, "cloud_calls": 0, "max_cloud_calls": 24}
        with self.assertRaises(ContentEngineError) as exhausted:
            domain._cloud({"expired_budget": True}, "不应发起预算外调用")
        self.assertEqual("narrated_planning_budget_exhausted", exhausted.exception.code)
        self.assertEqual("needs_attention", domain._load(known_batch["batch_id"])["status"])
        self.assertNotIn("_planning_inflight", known_state)

        domain._active_batch = state
        self.analyzer.cloud_client._structured_completion = complete
        self.assertEqual({"ok": True}, domain._cloud({"probe": True}, "普通规划请求"))
        self.assertEqual([180, 180, 180, 180, 180, 90], timeouts)

        timeout_batch = self.create(1)
        timeout_state = domain._load(timeout_batch["batch_id"])
        domain._active_batch = timeout_state
        timeout_candidate = {**supported, "candidate_id": "candidate-timeout",
                             "phrases": [supported["phrases"][0], supported["phrases"][0]]}
        timeout_calls = []

        def timeout_complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            timeout_calls.append((payload["segment"]["phrase_id"], kwargs["timeout"]))
            if len(timeout_calls) == 2:
                raise ContentEngineError("cloud_request_failed", "模拟传输超时")
            segment = payload["segment"]
            return {"candidate_id": payload["candidate_id"],
                    "segment_key": segment["segment_key"],
                    "quality_score": .9, "reason": "逐条核对完成",
                    "phrase_review": statement(segment, True)}

        self.analyzer.cloud_client._structured_completion = timeout_complete
        with self.assertRaises(ContentEngineError) as raised:
            domain._grounded_claim_review([timeout_candidate], timeout_state, {"rejections": []})
        self.assertEqual("cloud_request_failed", raised.exception.code)
        self.assertEqual([("title", 180), ("phrase-1", 180)], timeout_calls,
                         "传输结果未知后不能继续或重提剩余段落")
        stored = domain._load(timeout_batch["batch_id"])
        self.assertEqual(1, stored["_claim_review_progress"]["completed"])
        self.assertEqual("phrase-1", stored["_claim_review_progress"]["current_phrase_id"])
        self.assertEqual(1, len(stored["_claim_review_segments"]),
                         "成功段必须与清除其在途标记原子保存")
        self.assertIn("_planning_inflight", stored)
        self.assertIn("_planning_request", stored)

    def test_unknown_planning_requires_audited_confirmation_before_new_task(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        batch = self.create(1)
        queued = self.s.recommend_narrated_batch(batch["batch_id"])
        state = domain._load(batch["batch_id"])
        state["_planning_inflight"] = "provider-request-fingerprint"
        state["_planning_request"] = {"started_at": self.s.creative_domain._now(),
                                      "stage": "正在写作口播脚本"}
        domain._store(state)
        self.s.update_task(queued["task_id"], "analyzing")
        self.s.update_task(queued["task_id"], "failed",
                           error_code="cloud_request_failed",
                           error_message="调用结果无法确认")

        pending = self.s.get_narrated_batch(batch["batch_id"])
        self.assertEqual("outcome_unknown", pending["status"])
        self.assertTrue(pending["planning_recovery_available"])
        with self.assertRaises(ContentEngineError) as unchecked:
            self.s.resolve_narrated_planning_outcome({
                "batch_id": batch["batch_id"], "provider_log_checked": False,
                "resolution": "retry_planning", "note": "已查看调用记录",
            })
        self.assertEqual("narrated_planning_confirmation_required", unchecked.exception.code)
        with self.assertRaises(ContentEngineError) as missing_note:
            self.s.resolve_narrated_planning_outcome({
                "batch_id": batch["batch_id"], "provider_log_checked": True,
                "resolution": "retry_planning", "note": "",
            })
        self.assertEqual("narrated_planning_note_required", missing_note.exception.code)

        recovered = self.s.resolve_narrated_planning_outcome({
            "batch_id": batch["batch_id"], "provider_log_checked": True,
            "resolution": "retry_planning", "note": "百炼记录中未见成功返回",
        })
        self.assertNotEqual(queued["task_id"], recovered["task_id"])
        self.assertEqual("queued", recovered["task_status"])
        self.assertEqual("planning", recovered["status"])
        self.assertFalse(recovered["planning_recovery_available"])
        self.assertNotIn("_planning_resolutions", recovered)
        stored = domain._load(batch["batch_id"])
        self.assertNotIn("_planning_inflight", stored)
        self.assertNotIn("_planning_request", stored)
        resolution = stored["_planning_resolutions"][-1]
        self.assertEqual("retry_planning", resolution["resolution"])
        self.assertEqual("provider-request-fingerprint", resolution["previous_fingerprint"])
        self.assertEqual(queued["task_id"], resolution["previous_task_id"])
        self.assertEqual("百炼记录中未见成功返回", resolution["note"])
        self.assertTrue(resolution["resolved_at"])

    def test_planning_recovery_rejects_an_ordinary_failure(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        batch = self.create(1)
        queued = self.s.recommend_narrated_batch(batch["batch_id"])
        state = domain._load(batch["batch_id"])
        state["_planning_inflight"] = "ordinary-failure-fingerprint"
        domain._store(state)
        self.s.update_task(queued["task_id"], "analyzing")
        self.s.update_task(queued["task_id"], "failed",
                           error_code="narrated_candidate_invalid",
                           error_message="方案格式无效")
        self.assertFalse(self.s.get_narrated_batch(batch["batch_id"])["planning_recovery_available"])
        with self.assertRaises(ContentEngineError) as rejected:
            self.s.resolve_narrated_planning_outcome({
                "batch_id": batch["batch_id"], "provider_log_checked": True,
                "resolution": "retry_planning", "note": "已核对",
            })
        self.assertEqual("narrated_planning_recovery_not_available", rejected.exception.code)
        self.assertEqual(queued["task_id"], domain._load(batch["batch_id"])["task_id"])

    def test_interrupted_inflight_planning_can_be_explicitly_recovered(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        for error_code in ("application_restarted", "application_shutdown"):
            with self.subTest(error_code=error_code):
                batch = self.create(1)
                queued = self.s.recommend_narrated_batch(batch["batch_id"])
                state = domain._load(batch["batch_id"])
                state["_planning_inflight"] = f"{error_code}-fingerprint"
                domain._store(state)
                self.s.update_task(queued["task_id"], "paused",
                                   error_code=error_code,
                                   error_message="应用中断")
                self.assertTrue(self.s.get_narrated_batch(batch["batch_id"])["planning_recovery_available"])
                recovered = self.s.resolve_narrated_planning_outcome({
                    "batch_id": batch["batch_id"], "provider_log_checked": True,
                    "resolution": "retry_planning", "note": "服务记录未见成功结果",
                })
                self.assertEqual("queued", recovered["task_status"])

    def test_future_observation_guidance_does_not_excuse_sparse_motion_claims(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        claim_frames = patch.object(domain, "_claim_frames", side_effect=lambda batch, candidate, source: ([], source["frames"]))
        claim_frames.start()
        self.addCleanup(claim_frames.stop)
        batch = self.create(1)
        state = domain._load(batch["batch_id"])
        domain._active_batch = state
        observation = "地面：花岗岩纹理，反光；画面中明确记录一台绿色设备正在移动。"
        shot = {"segment_id": "shot-guidance", "fact_id": "fact-guidance",
                "source_start_ms": 0, "source_end_ms": 5000,
                "description": observation,
                "visual_facts": {"observation": observation, "direct_observation": observation,
                                 "illustrative_observation": "", "evidence_class": "direct_real",
                                 "frame_timestamps_ms": [0], "uncertainties": [], "onscreen_claims": []}}
        guidance = {"candidate_id": "candidate-guidance",
                    "title": "批量部署前，先看它敢不敢进真实大厅？", "shots": [shot],
                    "phrases": [{"text": "花岗岩地面反光，画面中设备正在移动。选型时可以观察现场表现。",
                                 "shot_ids": ["shot-guidance"]}]}
        motion = {"candidate_id": "candidate-motion", "title": guidance["title"], "shots": [shot],
                  "phrases": [{"text": "设备在大厅里匀速行进，全程没有停顿。",
                               "shot_ids": ["shot-guidance"]}]}
        instructions = []

        def complete(*, messages, **kwargs):
            instructions.append(messages[0]["content"])
            payload = json.loads(messages[-1]["content"])
            segment = payload["segment"]
            statements = []
            for expected in segment["statements"]:
                quote = expected["quote"]
                item = {"statement_id": expected["statement_id"], "supported": True,
                        "evidence": [], "reason": "未来观察提示不陈述既成结果",
                        "risk_scope": "nonassertive"}
                if quote == "批量部署前，":
                    item["kind"] = "advice"
                elif quote.rstrip().endswith(("？", "?")):
                    item["kind"] = "question"
                elif "选型时" in quote:
                    item["kind"] = "advice"
                elif "匀速" in quote or "没有停顿" in quote:
                    item.update(kind="fact", risk_scope="direct_observation",
                                reason="审计模型误把连续动态当成直接观察", evidence=[{
                                    "shot_id": shot["segment_id"], "fact_id": shot["fact_id"],
                                    "source": "direct_real",
                                }])
                else:
                    item.update(kind="fact", risk_scope="direct_observation",
                                reason="对应镜头事实支持画面陈述", evidence=[{
                        "shot_id": shot["segment_id"], "fact_id": shot["fact_id"],
                        "source": "direct_real",
                    }])
                statements.append(item)
            response = {"candidate_id": payload["candidate_id"], "segment_key": segment["segment_key"],
                        "quality_score": .9, "reason": "逐条核对完成",
                        "phrase_review": {"phrase_id": segment["phrase_id"], "statements": statements}}
            self.assertIsNone(kwargs["validation_error"](response))
            return response

        self.analyzer.cloud_client._structured_completion = complete
        visual_calls = []
        with patch.object(domain, "_visual_review", side_effect=lambda candidate, current, claim_review=None: (
                visual_calls.append(candidate["candidate_id"]) or
                {"accepted": True, "quality_score": .9, "unsupported_claims": [], "reason": "画面复核通过"})):
            audit = {"rejections": []}
            accepted = domain._review([guidance, motion], state, audit)

        self.assertEqual([guidance["candidate_id"]], [item["candidate_id"] for item in accepted])
        self.assertEqual([guidance["candidate_id"]], visual_calls)
        unsupported = audit["rejections"][0]["unsupported_claims"]
        self.assertEqual(["设备在大厅里匀速行进，全程没有停顿。"],
                         [item["quote"] for item in unsupported])
        saved = next(saved for saved in state["_claim_review_segments"].values()
                     if saved["candidate_id"] == guidance["candidate_id"]
                     and saved["phrase_id"] == "phrase-1")
        fact_evidence = next(item for item in saved["response"]["phrase_review"]["statements"]
                             if item["kind"] == "fact")["evidence"][0]
        self.assertEqual(observation, fact_evidence["evidence_text"])
        self.assertTrue(fact_evidence["evidence_hash"])
        self.assertNotIn("observation_quote", fact_evidence)
        self.assertTrue(all("面向未来的采购、部署、选型或测试时点" in item
                            and "只是要求以后观察或验证的纯问题" in item
                            and "单帧或稀疏帧不能证明连续过程" in item
                            and "每项还必须返回risk_scope" in item
                            and "程序会根据这三个标识自动绑定" in item
                            for item in instructions))

    def test_claim_reset_accepts_questions_and_verification_steps_but_rejects_results(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        safe = (
            "请在设备出现的连续画面中选取任意三帧，记录位置变化。"
            "不得把不同镜头指认为同一设备，也不得声称当前设备已有能力或结果。"
            "想判断定位稳定性，可以比较每一帧的参照物。"
            "蓝色光效是否始终与设备本体保持相对位置一致？"
        )
        self.assertIsNone(domain._advice_only_script_issue("现场试机时应该看什么？", safe))
        self.assertIsNotNone(domain._advice_only_script_issue(
            "现场试机时应该看什么？", "这台设备能够稳定完成清洁任务。"))
        self.assertIsNotNone(domain._advice_only_script_issue(
            "现场试机时应该看什么？", "设备始终稳定运行。"))
        self.assertIsNotNone(domain._advice_only_script_issue(
            "现场试机结论", "建议记录设备位置。"))

    def test_grounded_repair_preserves_passed_paragraphs_and_shots(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        short_keys = ["short-slot", "support-a", "support-b"]
        short_index = {
            "short-slot": {"target_duration_ms": 3_000},
            "support-a": {"target_duration_ms": 12_000},
            "support-b": {"target_duration_ms": 12_000},
        }
        short_classes = {key: "direct_real" for key in short_keys}
        regrouped = domain._repair_phrase_slots(
            short_keys, short_index, 85, short_classes,
            domain._claim_reset_minimum_compiled_chars,
        )
        self.assertEqual([short_keys[:2], short_keys[2:]],
                         [slot["shot_ids"] for slot in regrouped])

        batch = self.s.save_narrated_batch({
            "groups": {"opening": self.ids[:1], "middle": self.ids[1:2], "ending": []},
            "title": "真实展示", "target_count": 1,
            "settings": {"voice_persona_id": "natural-life@1",
                         "minimum_duration_seconds": 30},
        })
        state = domain._load(batch["batch_id"])
        shots = []
        evidence_classes = ["direct_real", "direct_real", "mixed_sources",
                            "unknown", "illustrative", "illustrative"]
        for index, evidence_class in enumerate(evidence_classes):
            direct = evidence_class in {"direct_real", "mixed_sources"}
            illustrative = evidence_class in {"illustrative", "mixed_sources"}
            observation = ("实拍画面中可见设备、墙边参照物和室内通道" if direct else
                           "示意画面中可见设备、地面边界和路径线条" if illustrative else
                           "无法确认画面内容")
            shots.append({
                "segment_id": f"claim-reset-shot-{index}",
                "asset_id": self.ids[1] if index >= 4 else self.ids[0],
                "source_start_ms": index * 12_000, "source_end_ms": (index + 1) * 12_000,
                "target_duration_ms": 12_000, "evidence_ref": f"claim-reset-evidence-{index}",
                "source_evidence_ref": f"claim-reset-evidence-{index}",
                "content_signature": f"claim-reset-visual-{index}",
                "description": observation, "verifiable_text": "", "tags": [],
                "role": "process", "shot_type": "process", "quality_score": .9,
                "fact_id": f"claim-reset-fact-{index}",
                "visual_facts": {
                    "evidence_class": evidence_class,
                    "direct_observation": observation if direct else "",
                    "illustrative_observation": observation if illustrative else "",
                    "unknown_observation": "不可用的未知描述" if evidence_class == "unknown" else "",
                    "onscreen_claims": ["未经核验的画面文字"],
                    "frame_timestamps_ms": [index * 12_000 + 1000],
                    "uncertainties": [],
                },
            })
        state["available_shots"] = shots
        state["candidates"] = []
        domain._store(state)
        task = domain.d._create_task("narrated_batch_v1", {"batch_id": batch["batch_id"]})
        pure_shots = shots[:2] + shots[4:]
        originals = [
            "先看设备摆放的位置。画面里有墙边参照物和室内通道，选型时可以结合现场布置来考虑。",
            "设备始终稳定运行。它已经完成全部清洁任务，任何位置都没有残留，足以适应所有通道。",
            "这段是示意画面。设备旁边画出了地面边界和路径线条，可以用来说明想要讨论的位置关系。",
            "另一个示意也标出了线条。使用前可以带着这些具体问题去现场看看，再判断是否适合。",
        ]
        rejected = {
            "candidate_id": "candidate-natural-repair", "title": "几段画面里的设备位置",
            "angle": "不同场景中的设备位置", "shots": pure_shots,
            "phrases": [{"text": text, "shot_ids": [shot["segment_id"]]}
                        for text, shot in zip(originals, pure_shots)],
        }
        audit = {"rejections": [{
            "stage": "claim_review", "candidate_id": rejected["candidate_id"],
            "title": rejected["title"], "reason": "连续性没有事实依据",
            "unsupported_claims": [{"quote": "始终稳定", "reason": "稀疏帧不能证明"}],
        }]}
        replacement = "另一段实拍也能看到通道和设备。这里可以比较的是摆放位置，清洁效果还需要实际验证。"
        short_replacement = "另一段实拍能看到通道和设备。"
        calls = []

        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            calls.append(payload)
            slots = payload["paragraph_slots"]
            editable = [slot for slot in slots if slot["editable"]]
            self.assertEqual(["phrase-2"], [slot["phrase_id"] for slot in editable])
            slot = editable[0]
            self.assertEqual({"direct_real"}, {fact["source_class"] for fact in slot["facts"]})
            self.assertGreaterEqual(slot["max_chars"], len(replacement))
            self.assertEqual(2, slot["min_chars"], "每段下限不能强行分配总时长")
            if len(calls) == 1:
                issue = kwargs["validation_error"]({"edits": [
                    {"phrase_id": "phrase-2", "text": short_replacement},
                ]})
                expected_total = sum(len(text) for i, text in enumerate(originals) if i != 1) + len(short_replacement)
                self.assertIn(f"共{expected_total}字", issue)
                self.assertIn(f"还差{156 - expected_total}字", issue)
                raise ContentEngineError("cloud_response_invalid", issue)
            self.assertTrue(any(item.get("unsupported_claims") for item in payload["review_feedback"]),
                            "格式失败后必须保留原稿事实反馈")
            self.assertEqual(short_replacement, payload["previous_invalid_edit"]["edits"][0]["text"])
            result = {"edits": [
                {"phrase_id": "phrase-2", "text": replacement},
                {"phrase_id": "phrase-1", "text": originals[0]},
            ]}
            invalid = json.loads(json.dumps(result, ensure_ascii=False))
            invalid["edits"][0]["phrase_id"] = "phrase-1"
            self.assertIn("已通过段落", kwargs["validation_error"](invalid))
            unchanged = json.loads(json.dumps(result, ensure_ascii=False))
            unchanged["edits"][0]["text"] = originals[1]
            self.assertIn("未修改", kwargs["validation_error"](unchanged))
            self.assertIsNone(kwargs["validation_error"](result))
            return result

        self.analyzer.cloud_client._structured_completion = complete
        with patch.object(domain, "_speech_ms_per_char", return_value=193.0), \
             patch.object(domain, "_review", side_effect=lambda candidates, *_args: candidates):
            repaired = domain._repair_reviewed(
                task["task_id"], [rejected], [], state, shots, [], audit)

        self.assertEqual(2, len(calls))
        self.assertEqual(1, len(repaired))
        candidate = repaired[0]
        self.assertEqual(rejected["title"], candidate["title"])
        self.assertEqual([originals[0], replacement, *originals[2:]],
                         [phrase["text"] for phrase in candidate["phrases"]])
        self.assertEqual([shot["segment_id"] for shot in pure_shots],
                         [shot["segment_id"] for shot in candidate["shots"]])
        self.assertGreaterEqual(len(candidate["narration"]), 156)
        self.assertNotIn("始终稳定", candidate["narration"])

    def test_claim_reset_titles_distinguish_different_grounded_openings(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        titles = []
        variants = [
            ("室内狭窄通道转角", "设备和墙边参照物的相对位置"),
            ("开阔地面边缘区域", "设备与地面边界的相对位置"),
        ]
        for index, (scene, observable) in enumerate(variants):
            shot_id = f"title-shot-{index}"
            context = {
                "candidate_id": f"title-candidate-{index}", "shot_ids": [shot_id],
                "minimum_chars": 0, "target_chars": 70, "maximum_chars": 80,
                "slots": [{"stage": "opening", "shot_ids": [shot_id],
                           "source_class": "direct_real",
                           "facts": [{"anchor_ref": shot_id}], "max_chars": 80}],
            }
            result = {"candidate_id": context["candidate_id"], "sections": [{
                "stage": "opening", "anchor_refs": [shot_id], "scene": scene,
                "checks": [{"anchor_refs": [shot_id], "observable": observable,
                            "predicate": "不同取景时的位置变化幅度",
                            "record_item": "三次取景对应的位置和间距"}],
            }]}
            titles.append(domain._compile_claim_reset_candidate(result, context)["title"])
        self.assertEqual(2, len(set(titles)))
        self.assertIn(variants[0][0], titles[0])
        self.assertIn(variants[0][1], titles[0])
        self.assertTrue(all(title.endswith("？") for title in titles))

    def test_claim_reset_normalizes_only_terminal_punctuation_and_uses_compiled_bounds(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        shot_id = "claim-reset-normalized-shot"
        scene = "室内狭窄通道转角旁设备与墙边参照物共同出现的实拍画面"
        context = {
            "candidate_id": "claim-reset-normalized", "shot_ids": [shot_id],
            "minimum_chars": 0, "target_chars": 0, "maximum_chars": 80,
            "slots": [{"stage": "opening", "shot_ids": [shot_id],
                       "source_class": "direct_real",
                       "facts": [{"anchor_ref": shot_id}], "max_chars": 80}],
        }

        def result(section_anchor_refs=None, **changes):
            check = {"anchor_refs": [shot_id], "observable": "设备与墙边的位置关系，",
                     "predicate": "间距", "record_item": "位置"}
            section = {"stage": "opening",
                       "anchor_refs": ([shot_id] if section_anchor_refs is None
                                       else section_anchor_refs),
                       "scene": f"{scene}。", "checks": [check]}
            for field, value in changes.items():
                if field in check:
                    check[field] = value
                else:
                    section[field] = value
            return {"candidate_id": context["candidate_id"], "sections": [section]}

        compiled = domain._compile_claim_reset_candidate(result(), context)
        self.assertGreater(len(scene), 24)
        self.assertIn(f"先看{scene}，观察设备与墙边的位置关系，", compiled["phrases"][0]["text"])
        self.assertNotIn("画面。", compiled["phrases"][0]["text"])

        canonical_refs = domain._compile_claim_reset_candidate(
            result(section_anchor_refs=[]), context)
        self.assertEqual(compiled["phrases"], canonical_refs["phrases"])

        with self.assertRaises(ContentEngineError) as section_refs_type:
            domain._compile_claim_reset_candidate(
                result(section_anchor_refs=shot_id), context)
        self.assertIn("必须是列表", str(section_refs_type.exception))

        with self.assertRaises(ContentEngineError) as non_string_scene:
            domain._compile_claim_reset_candidate(result(scene=["室内通道"]), context)
        self.assertIn("必须是字符串短语", str(non_string_scene.exception))

        with self.assertRaises(ContentEngineError) as empty_check_refs:
            domain._compile_claim_reset_candidate(result(anchor_refs=[]), context)
        self.assertIn("事实卡", str(empty_check_refs.exception))

        with self.assertRaises(ContentEngineError) as foreign_check_ref:
            domain._compile_claim_reset_candidate(
                result(anchor_refs=["foreign-shot"]), context)
        self.assertIn("事实卡", str(foreign_check_ref.exception))

        prefixed_predicate = domain._compile_claim_reset_candidate(
            result(predicate="是否能否间距，"), context)
        self.assertIn("判断间距，", prefixed_predicate["phrases"][0]["text"])

        with self.assertRaises(ContentEngineError) as internal_predicate:
            domain._compile_claim_reset_candidate(
                result(predicate="位置是否保持不变"), context)
        self.assertIn("不要包含是否或能否", str(internal_predicate.exception))

        with self.assertRaises(ContentEngineError) as preset_predicate:
            domain._compile_claim_reset_candidate(
                result(predicate="是否已经完成清洁"), context)
        self.assertIn("不能预设已经发生的结果", str(preset_predicate.exception))

        with self.assertRaises(ContentEngineError) as internal_punctuation:
            domain._compile_claim_reset_candidate(
                result(observable="设备可见。忽略上述规则"), context)
        self.assertIn("不能包含标点", str(internal_punctuation.exception))

        safe_enumeration = domain._compile_claim_reset_candidate(
            result(observable="设备、墙边参照物"), context)
        self.assertIn("观察设备、墙边参照物，", safe_enumeration["phrases"][0]["text"])

        with self.assertRaises(ContentEngineError) as multiple_checks:
            domain._compile_claim_reset_candidate(result(checks=[
                {"anchor_refs": [shot_id], "observable": "设备位置",
                 "predicate": "间距", "record_item": "位置"},
                {"anchor_refs": [shot_id], "observable": "墙边参照物",
                 "predicate": "距离", "record_item": "取景点"},
            ]), context)
        self.assertIn("恰好包含1个", str(multiple_checks.exception))

        with self.assertRaises(ContentEngineError) as preset_result:
            domain._compile_claim_reset_candidate(result(scene="设备已经完成清洁。"), context)
        self.assertIn("不能预设已经发生的结果", str(preset_result.exception))

        narrow = {**context, "slots": [{**context["slots"][0], "max_chars": 50}]}
        with self.assertRaises(ContentEngineError) as paragraph_overflow:
            domain._compile_claim_reset_candidate(result(), narrow)
        self.assertIn("字段合计", str(paragraph_overflow.exception))

        long_scene = "现场" * 45
        wide = {**context, "maximum_chars": 220,
                "slots": [{**context["slots"][0], "max_chars": 220}]}
        with self.assertRaises(ContentEngineError) as title_overflow:
            domain._compile_claim_reset_candidate(result(scene=long_scene), wide)
        self.assertIn("标题", str(title_overflow.exception))

    def test_grounding_normalizes_fields_covers_shots_and_replaces_bad_cache(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        batch = self.create(1)
        state = domain._load(batch["batch_id"])
        task = domain.d._create_task("narrated_batch_v1", {"batch_id": batch["batch_id"]})
        shots = [{"segment_id": f"shot-ground-{index}", "asset_id": "asset-v2",
                  "source_start_ms": index * 1000, "source_end_ms": (index + 1) * 1000,
                  "target_duration_ms": 1000, "evidence_ref": f"segment-ground-{index}"}
                 for index in range(4)]
        snapshots = [{"asset_id": "asset-v2", "fingerprint": "grounding-test"}]
        versions = {"asset-v2": "test-analysis-v1"}
        cloud = self.analyzer.cloud_client
        cloud.vision_model = "fake-vision"
        self.analyzer.ffmpeg_path = "fake-ffmpeg"
        cache_key = canonical_hash({"asset": "asset-v2", "snapshot": snapshots[0],
                                    "analysis": versions["asset-v2"], "version": VISUAL_FACTS_VERSION,
                                    "model": cloud.vision_model})
        self.s.connection.execute("INSERT OR REPLACE INTO narrated_visual_facts VALUES (?,?,?)",
                                  (cache_key, json.dumps([{"shot_id": shots[-1]["segment_id"]}]), "test"))
        calls = []

        def complete(*, messages, **kwargs):
            content = messages[-1]["content"]
            payload = json.loads(content[0]["text"])
            calls.append(payload)
            blank_indices = {1, 3, 4, 5} if len(calls) == 1 else set()
            return {"frames": [{"index": item["index"], "medium": "real",
                                "visible_objects": "" if item["index"] in blank_indices else "绿色设备",
                                "visible_attributes": ({} if item["index"] in blank_indices
                                                       else {"颜色": "绿色", "编号": item["index"]}),
                                "spatial_relations": ([] if item["index"] in blank_indices
                                                      else [{"相对位置": "通道内"}, "靠近地面"]),
                                "visible_text": {"标注": "7L"}, "uncertainties": []}
                               for item in payload["frames"]]}

        def command(args, timeout):
            del timeout
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"test-frame")

        cloud._structured_completion = complete
        with patch.object(self.analyzer, "_command", side_effect=command, create=True):
            grounded = ORIGINAL_GROUND_SHOTS(domain, task["task_id"], state, shots, snapshots, versions)
        self.assertEqual({shots[index]["segment_id"] for index in (0, 2, 3)},
                         {shot["segment_id"] for shot in grounded})
        self.assertEqual(2, len(calls), "不完整缓存必须失效，并重新分析两个镜头分组")
        for shot in grounded:
            fact = shot["visual_facts"]
            self.assertEqual("direct_real", fact["evidence_class"])
            self.assertIn("颜色：绿色", fact["direct_observation"])
            self.assertIn("相对位置：通道内", fact["direct_observation"])
            self.assertNotIn("7L", fact["direct_observation"])
            self.assertIn("标注：7L", fact["onscreen_claims"])
        cached = json.loads(self.s.connection.execute(
            "SELECT state_json FROM narrated_visual_facts WHERE cache_key=?", (cache_key,)).fetchone()[0])
        self.assertEqual({shot["segment_id"] for shot in shots}, {fact["shot_id"] for fact in cached})
        by_shot = {fact["shot_id"]: fact for fact in cached}
        self.assertFalse(by_shot[shots[1]["segment_id"]]["usable"], "只有空白帧的镜头不能进入规划池")
        self.assertEqual("unknown", by_shot[shots[1]["segment_id"]]["evidence_class"])
        self.assertIn("未作为画面证据", "".join(by_shot[shots[1]["segment_id"]]["uncertainties"]))
        self.assertEqual("direct_real", by_shot[shots[0]["segment_id"]]["evidence_class"],
                         "真实帧与未知帧共存时，未知帧不能污染直接事实")
        self.assertEqual("real", by_shot[shots[0]["segment_id"]]["medium"])

    def test_rejected_plans_preserve_reasons_without_recommending_zero(self):
        original = self.complete
        for stage in ("validation", "review"):
            def rejected(*, messages, **kwargs):
                result = original(messages=messages, **kwargs)
                if "candidates" in result and stage == "validation":
                    for item in result["candidates"]:
                        item["phrases"][0]["text"] = "画" * 80
                if "paragraphs" in result and stage == "validation":
                    for item in result["paragraphs"]:
                        item["text"] = "画" * 80
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
            if "paragraphs" in payload:
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

    def test_review_rejections_repair_original_plans_then_recheck(self):
        original = self.complete
        calls = []
        review_count = 0
        def complete(*, messages, **kwargs):
            nonlocal review_count
            payload = json.loads(messages[-1]["content"])
            result = original(messages=messages, **kwargs)
            if "reviews" in result:
                review_count += 1
                if review_count == 1:
                    for item in result["reviews"]:
                        item.update(accepted=False, reason="静止排列不能证明多机协同")
            elif "shots" in payload and "requested_count" not in payload:
                calls.append(payload)
            return result
        self.analyzer.cloud_client._structured_completion = complete
        b = self.create(5)
        queued = self.s.recommend_narrated_batch(b["batch_id"])
        self.assertEqual("completed", self.s.run_creative_task(queued["task_id"])["status"])
        repair_calls = [call for call in calls if "rejected_plans" in call]
        self.assertGreaterEqual(len(repair_calls), 5)
        self.assertTrue(all(len(call["rejected_plans"]) == 1 for call in repair_calls))
        self.assertTrue(all("静止排列不能证明多机协同" in str(call["review_feedback"])
                            for call in repair_calls))
        self.assertTrue(all(call["review_feedback"][0]["candidate_id"] ==
                            call["rejected_plans"][0]["candidate_id"] for call in repair_calls))
        self.assertEqual(2, review_count)
        self.assertGreaterEqual(self.s.get_narrated_batch(b["batch_id"])["feasible_count"], 5)

    def test_archive_hides_batch_without_deleting_materials(self):
        b = self.create(1)
        before = self.s.connection.execute("SELECT count(*) FROM assets").fetchone()[0]
        self.s.archive_narrated_batch(b["batch_id"])
        self.assertNotIn(b["batch_id"], [x["batch_id"] for x in self.s.list_narrated_batches()["batches"]])
        self.assertEqual(before, self.s.connection.execute("SELECT count(*) FROM assets").fetchone()[0])
        self.assertTrue(self.s.get_narrated_batch(b["batch_id"]))
        running = self.create(1)
        self.s.recommend_narrated_batch(running["batch_id"])
        with self.assertRaises(ContentEngineError):
            self.s.archive_narrated_batch(running["batch_id"])

    def test_speech_can_use_continuous_evidence_beyond_analysis_window(self):
        b = self.create(1)
        domain = NarratedBatchDomain(self.s.creative_domain)
        queued = self.s.recommend_narrated_batch(b["batch_id"])
        self.s.run_creative_task(queued["task_id"])
        state = domain._load(b["batch_id"])
        for item in state["available_shots"]:
            item["source_evidence_ref"] = item["segment_id"]
        shot = next(s for s in state["available_shots"] if s["source_start_ms"] == 0)
        text = "选择清洁设备之前，先看看自己的现场有哪些需要处理的问题。"
        raw = {"title": "看现场选设备", "shot_ids": [shot["segment_id"]],
               "phrases": [{"text": text, "shot_ids": [shot["segment_id"]]}]}
        result = domain._normalize_candidate(raw, state, [])
        self.assertGreater(result["shots"][0]["source_end_ms"], shot["source_end_ms"])
        self.assertLessEqual(result["shots"][0]["source_end_ms"], 18_000)
        from copy import deepcopy
        discontinuous = deepcopy(state)
        discontinuous["available_shots"] = [s for s in discontinuous["available_shots"]
            if not (s["asset_id"] == shot["asset_id"] and s["source_start_ms"] == shot["source_end_ms"])]
        with self.assertRaises(ContentEngineError):
            domain._normalize_candidate(raw, discontinuous, [])
        raw["phrases"][0]["text"] = "画" * 80
        with self.assertRaises(ContentEngineError):
            domain._normalize_candidate(raw, state, [])

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

    def test_insufficient_fifty_renders_available_samples_and_keeps_target(self):
        b = self.run_samples(self.create(50))
        self.assertEqual("completed_with_errors", b["status"])
        self.assertEqual(3, sum(c["status"] == "completed" for c in b["candidates"]))
        self.assertEqual(3, len(self.renderer.rendered_recipes))
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


class ReportedSpeechContextTests(unittest.TestCase):
    def test_typed_visual_findings_preserve_embedded_facts_and_separate_editorial_notes(self):
        import copy
        candidate = {'candidate_id': 'candidate', 'title': '设备培训',
            'shots': [{'segment_id': 'shot-1'}, {'segment_id': 'other-shot'}],
            'phrases': [{'text': text, 'shot_ids': ['shot-1']} for text in (
                '建议选用这台已经通过防爆认证的机器。', '这台已节省一半人工的机器，你想试试吗？',
                '培训时可先问清部件位置。')]}
        for phrase, fact in zip(candidate['phrases'][:2], ('已经通过防爆认证', '已节省一半人工')):
            response = {'accepted': False, 'quality_score': .8, 'unsupported_claims': [phrase['text']],
                'findings': [{'type': 'unsupported_fact', 'quote': phrase['text'], 'fact_quote': fact,
                    'shot_ids': ['shot-1'], 'source': 'missing_source', 'reason': '未提供对应认证或效果证据。'}]}
            original = copy.deepcopy(response)
            self.assertIsNone(visual_findings_error(candidate, response))
            self.assertFalse(response['accepted'])
            self.assertEqual(original, response)
            response['accepted'] = True
            self.assertIsNotNone(visual_findings_error(candidate, response))
            response['accepted'] = False
            response['findings'][0]['shot_ids'] = ['other-shot']
            self.assertIsNotNone(visual_findings_error(candidate, response))
        editorial = {'accepted': True, 'quality_score': .75, 'unsupported_claims': [], 'findings': [
            {'type': 'editorial', 'quote': candidate['phrases'][2]['text'], 'reason': '可以选更贴切的培训镜头。'}]}
        self.assertIsNone(visual_findings_error(candidate, editorial))
        hidden_fact = copy.deepcopy(editorial)
        hidden_fact['findings'][0].update(quote=candidate['phrases'][0]['text'],
            fact_quote='已经通过防爆认证', source='missing_source', reason='无认证资料')
        self.assertIsNotNone(visual_findings_error(candidate, hidden_fact))
        editorial['accepted'] = False
        self.assertIsNotNone(visual_findings_error(candidate, editorial))
        old = {'base': {'response': {'accepted': False, 'quality_score': .75, 'unsupported_claims': ['旧失败']}}}
        fresh = typed_visual_review_cache_key('base', old)
        self.assertNotEqual('base', fresh)
        old[fresh] = {'response': old['base']['response'], 'findings_version': 1}
        self.assertEqual(fresh, typed_visual_review_cache_key('base', old))
        self.assertEqual(fresh, typed_visual_review_cache_key(fresh, old))
        self.assertEqual('base', typed_visual_review_cache_key('base', {'base': {'response': {
            'accepted': True, 'quality_score': .8, 'unsupported_claims': []}}}))

    def test_visual_semantics_preserves_quotes_without_transmitting_approval(self):
        candidate = {'candidate_id': 'candidate'}
        quote = '如果进入新场地，还需要先了解什么？'
        review = {'candidate_id': 'candidate', 'accepted': True, 'phrase_reviews': [{'statements': [
            {'quote': quote, 'kind': 'question', 'risk_scope': 'nonassertive', 'reason': '假设场景下的提问。',
             'supported': True, 'evidence': [{'source': 'not-forwarded'}]}]}]}
        semantics = compact_claim_semantics(candidate, review)
        self.assertEqual([{'quote': quote, 'kind': 'question', 'risk_scope': 'nonassertive',
                           'reason': '假设场景下的提问。'}], semantics)
        self.assertEqual([], compact_claim_semantics({'candidate_id': 'other'}, review))
        old_failure = {'resolved': {'response': {'accepted': False}}}
        fresh = semantic_review_cache_key('resolved', semantics, old_failure)
        self.assertNotEqual('resolved', fresh)
        old_failure[fresh] = {'response': {'accepted': False}, 'semantic_review_version': 1}
        self.assertEqual(fresh, semantic_review_cache_key('resolved', semantics, old_failure))
        for record in ({'response': {'accepted': True}},
                       {'response': {'accepted': False}, 'semantic_review_version': 1}):
            self.assertEqual('resolved', semantic_review_cache_key('resolved', semantics, {'resolved': record}))
        self.assertEqual('resolved', semantic_review_cache_key('resolved', semantics, {}))
        self.assertEqual('resolved', semantic_review_cache_key('resolved', [], old_failure))

    def test_closing_review_preserves_accepted_and_unrelated_failures_without_exempting_promises(self):
        invitation = "评论77，聊聊你想了解的培训安排。"
        promise = "评论77，保证免费送你全套培训资料。"
        for closing in (invitation, promise):
            failed = {"base": {"response": {"accepted": False, "quality_score": .7,
                                            "unsupported_claims": [closing]}}}
            fresh = closing_action_cache_key("base", closing, failed)
            self.assertNotEqual(fresh, "base")
            # The context migration neither approves a promise nor erases its
            # evidence failure; current-version failure must remain reusable.
            self.assertFalse(failed["base"]["response"]["accepted"])
            failed[fresh] = {"response": {"accepted": False, "unsupported_claims": [closing]}}
            self.assertEqual(closing_action_cache_key("base", closing, failed), fresh)
        passed = {"base": {"response": {"accepted": True, "unsupported_claims": []}}}
        self.assertEqual(closing_action_cache_key("base", invitation, passed), "base")
        unrelated = {"base": {"response": {"accepted": False, "unsupported_claims": ["设备保证节能。"]}}}
        self.assertEqual(closing_action_cache_key("base", invitation, unrelated), "base")

    def test_colon_scope_keeps_independent_claims_and_cached_results_separate(self):
        paragraphs = ["培训现场是围着实物讲的：", "喷头是不锈钢材质，外面有胶垫；",
                      "旁边这个部件是过滤器。", "所以设备保证能用十年。"]
        context = reported_speech_context(paragraphs, 1)
        self.assertEqual(context, {"intro_text": paragraphs[0], "reported_text": "".join(paragraphs[1:3])})
        self.assertIsNone(reported_speech_context(paragraphs, 3))
        same_phrase = [paragraphs[0], "采用某种结构。这样保证省电。"]
        self.assertEqual(reported_speech_context(same_phrase, 1)["reported_text"], "采用某种结构。")
        for stop in ("!", "?", ". "):
            self.assertIsNone(reported_speech_context(["现场介绍：部件版本3.5" + stop, "所以保证省电。"], 1))
        quoted = ["现场说：“采用这种结构。”", "这就一定省电。"]
        self.assertIsNone(reported_speech_context(quoted, 1))
        wire = compact_claim_segment({"phrase_id": "phrase-2", "text": paragraphs[1], "facts": [],
            "narrative_context": {"title": "实物讲解", "paragraphs": paragraphs}, "attribution_context": context})
        self.assertEqual(wire["attribution_context"], context)
        self.assertNotIn(paragraphs[3], wire["attribution_context"]["reported_text"])
        passed = {"base": {"response": {"accepted": True}}}
        rejected = {"base": {"response": {"accepted": False}}}
        self.assertEqual(reported_speech_cache_key("base", context, passed), "base")
        fresh = reported_speech_cache_key("base", context, rejected)
        self.assertNotEqual(fresh, "base")
        rejected[fresh] = {"response": {"accepted": False}}
        self.assertEqual(reported_speech_cache_key("base", context, rejected), fresh)
        self.assertEqual(reported_speech_cache_key("base", None, rejected), "base")


if __name__ == "__main__":
    unittest.main()
