"""Small service-level batch contracts; cloud/TTS/media I/O use existing fakes."""
import itertools
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_auto_mix_v2 as fixtures
from content_engine.narrated_batch import (
    NarratedBatchDomain, VISUAL_FACTS_VERSION, canonical_hash, near_duplicate, validate_count,
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
            by_asset = {s["asset_id"]: s for s in payload["shots"]}
            keys = [by_asset[aid]["segment_id"] for aid in payload["available_asset_ids"][:3]]
            return {"candidates": [{"title": "不同现场的清洁展示", "angle": "场景选择", "shot_ids": keys,
                                    "phrases": [{"text": "挑选设备时，先看看现场地面和通道。不同场景有不同的需求，需要结合实际情况判断。最后这句话也必须完整显示。", "shot_ids": keys}]}]}
        self.analyzer.cloud_client._structured_completion = complete
        batch = self.s.save_narrated_batch({"groups": {"opening": self.ids[:3], "middle": [], "ending": []}, "target_count": 1})
        planned = self.run_samples(batch)
        self.assertEqual("ready", planned["status"])
        rendered = self.run_samples(planned)
        self.assertEqual("completed", rendered["status"], rendered["candidates"])
        self.assertEqual(3, len(rendered["candidates"][0]["phrases"][0]["shot_ids"]))
        video_id = rendered["candidates"][0]["generated_video_id"]
        recipe = json.loads(self.s.connection.execute("SELECT recipe_json FROM generated_videos WHERE id=?", (video_id,)).fetchone()[0])
        actual_duration = sum(s["target_duration_ms"] for s in recipe["visual_segments"])
        self.assertEqual(recipe["captions"][-1]["end_ms"], actual_duration)
        self.assertEqual(rendered["candidates"][0]["narration"], "".join(c["text"] for c in recipe["captions"]))
        self.assertLess(actual_duration, planned["candidates"][0]["duration_ms"])

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
        self.assertEqual("ready", planned["status"])
        self.assertTrue(all(not c.get("generated_video_id") for c in planned["candidates"]))
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
        done = self.run_samples(planned)
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

    def test_story_v2_uses_rewritten_script_and_fills_two_candidates(self):
        requested = []
        rewrite_issues = []
        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            if "requested_count" in payload:
                requested.append(payload["requested_count"])
                return {"stories": [], "limitations": []}
            if "scripts" in payload:
                invalid = {"scripts": [{"index": item["index"], "narration": "短"}
                                       for item in payload["scripts"]]}
                rewrite_issues.append(kwargs["validation_error"](invalid))
                return {"scripts": [{"index": item["index"], "title": item["title"],
                    "narration": ("先观察现场，再比较不同场景中的真实画面。" * 20)[:item["min_chars"]]}
                    for item in payload["scripts"]]}
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
        self.assertTrue(rewrite_issues and "min_chars" in rewrite_issues[0])
        self.assertEqual([3], requested)

    def test_story_v2_repacks_four_phrase_drafts_across_nine_shots_for_two_candidates(self):
        narration = (
            "选择清洁设备之前，先观察现场地面、通道宽窄和周边遮挡，再决定重点看哪些实际动作。"
            "面对不同区域，可以分别看设备如何接近散落物、如何经过边缘，以及画面里有没有持续过程。"
            "再把室内通道、开阔地面和室外场景分开比较，留意每段素材真正展示了什么，不急着下结论。"
            "最后结合自己的场地和日常任务，记录需要继续确认的问题，再选择更适合现场的方案。"
        )
        long_narration = narration + "并继续核对现场变化。"
        rewrite_sizes = []
        rewrite_bounds = []
        repair_calls = []

        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            if "requested_count" in payload:
                return {"stories": [], "limitations": []}
            if "scripts" in payload:
                rewrite_sizes.append(len(payload["scripts"]))
                source = payload["scripts"][0]
                rewrite_bounds.append((source["min_chars"], source["max_chars"]))
                return {"scripts": [{"index": source["index"], "title": source["title"],
                                      "narration": "这条故意太短。" if source["index"] == 0 else long_narration}]}
            if "repair_scripts" in payload:
                repair_calls.append(payload)
                source = payload["repair_scripts"][0]
                slots = source["paragraph_slots"]
                overlong = {"scripts": [{"index": source["index"], "paragraphs": [
                    {"index": index, "text": "画" * (slot["max_chars"] + (1 if index == 0 else 0))}
                    for index, slot in enumerate(slots)]}]}
                self.assertIn("max_chars", kwargs["validation_error"](overlong))
                remaining = source["target_chars"]
                paragraphs = []
                for index, slot in enumerate(slots):
                    future_capacity = sum(item["max_chars"] for item in slots[index + 1:])
                    future_minimum = len(slots) - index - 1
                    size = max(1, remaining - future_capacity)
                    size = min(slot["max_chars"], max(size, remaining - future_minimum))
                    remaining -= size
                    paragraphs.append({"index": index, "text": "画" * (size - 1) + "。"})
                result = {"scripts": [{"index": source["index"], "paragraphs": paragraphs}]}
                self.assertIsNone(kwargs["validation_error"](result))
                return result
            if "candidates" in payload:
                return {"reviews": [{"candidate_id": item["candidate_id"], "accepted": True,
                                      "quality_score": .9, "reason": "结构完整"}
                                     for item in payload["candidates"]]}
            shots = payload["shots"]
            sequences = ([shot["segment_id"] for shot in shots[:9]],
                         [shot["segment_id"] for shot in shots[1:10]])
            raw_phrases = ["先看通道里的实际移动。", "再看设备接近地面散落物。",
                           "不同区域要分开观察。", "最后记录还需要继续确认的问题。"]
            return {"candidates": [{"title": f"现场观察 {number + 1}", "angle": "真实场景比较",
                                     "shot_ids": keys,
                                     "phrases": [{"text": text,
                                                  "shot_ids": ([keys[index]] if index < 3 else keys[3:])}
                                                 for index, text in enumerate(raw_phrases)]}
                                    for number, keys in enumerate(sequences)],
                    "reason": "两种镜头顺序"}

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
        self.assertEqual([1, 1], rewrite_sizes, "每条口播必须独立整理，不能因一条失败回滚整页")
        self.assertTrue(all(minimum == 156 and maximum >= len(long_narration)
                            for minimum, maximum in rewrite_bounds))
        self.assertEqual(1, len(repair_calls), "只有失败的短稿需要单独重新编排")
        repair_source = repair_calls[0]["repair_scripts"][0]
        self.assertEqual(156, repair_source["min_chars"])
        self.assertLessEqual(156, repair_source["target_chars"])
        self.assertLessEqual(repair_source["target_chars"], repair_source["max_chars"])
        self.assertLessEqual(repair_source["max_chars"], 188)
        self.assertNotIn("shot_ids", json.dumps(repair_calls[0], ensure_ascii=False))
        self.assertTrue(all(len(candidate["shots"]) >= 9 for candidate in planned["candidates"]))
        narrations = {candidate["narration"] for candidate in planned["candidates"]}
        self.assertIn(long_narration, narrations)
        for candidate in planned["candidates"]:
            self.assertEqual(candidate["narration"], "".join(item["text"] for item in candidate["phrases"]))
            self.assertTrue(any(len(item["shot_ids"]) > 1 for item in candidate["phrases"]))
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

    def test_grounded_claims_are_audited_before_visual_review(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        exact_phrase = "前方是干枯落叶，旁边是白色服务台和悬挂的标识牌。"
        self.assertEqual(["前方是干枯落叶，", "旁边是白色服务台和悬挂的标识牌。"],
                         [item["quote"] for item in domain._claim_statement_units("phrase-2", exact_phrase)])
        protected = "比例16:9，数量1,000，版本3.5，链接https://example.com/a,b?x=1,000；路径C:\\demo，括号（里面，保持）结束。"
        units = domain._claim_statement_units("phrase-protected", protected)
        self.assertEqual(protected, "".join(item["quote"] for item in units))
        self.assertEqual(["比例16:9，", "数量1,000，", "版本3.5，",
                          "链接https://example.com/a,b?x=1,000；", "路径C:\\demo，", "括号（里面，保持）结束。"],
                         [item["quote"] for item in units])
        batch = self.create(1)
        state = domain._load(batch["batch_id"])
        domain._active_batch = state
        observation = "画面中有一台绿色设备，设备位于室内通道。"
        shot = {"segment_id": "shot-grounded", "fact_id": "fact-grounded",
                "description": observation,
                "visual_facts": {"observation": observation, "direct_observation": observation,
                                 "illustrative_observation": "", "evidence_class": "direct_real",
                                 "uncertainties": [], "onscreen_claims": []}}
        second_observation = "画面中可见室内地面。"
        second_shot = {"segment_id": "shot-grounded-2", "fact_id": "fact-grounded-2",
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
                       "shots": [shot], "phrases": [{"text": "设备经过以后地面没有任何残留。选型时可以观察通道里的实际表现。",
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
                    item.update(kind="fact", supported=False, risk_scope="absence",
                                reason="画面未展示清理后的结果")
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
            self.assertEqual(6, payload["claim_audit_version"])
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
            self.assertIsNone(kwargs["validation_error"](response))
            if len(segment["statements"]) > 1:
                reordered = json.loads(json.dumps(response, ensure_ascii=False))
                reordered["phrase_review"]["statements"].reverse()
                self.assertIn("statement_id", kwargs["validation_error"](reordered))
            return response

        visual_calls = []
        self.analyzer.cloud_client._structured_completion = complete
        with patch.object(domain, "_visual_review", side_effect=lambda candidate, current: (
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
        self.assertEqual([supported["candidate_id"]], [item["candidate_id"] for item in accepted])
        self.assertEqual([supported["candidate_id"]], visual_calls)
        self.assertEqual("claim_review", audit["rejections"][0]["stage"])
        self.assertEqual("设备经过以后地面没有任何残留。",
                         audit["rejections"][0]["unsupported_claims"][0]["quote"])

        before_reuse = len(timeouts)
        self.analyzer.cloud_client._structured_completion = lambda **_kwargs: self.fail("已成功段不应重复请求")
        reused = domain._grounded_claim_review([supported, unsupported], state, {"rejections": []})
        self.assertEqual([supported["candidate_id"]], [item[0]["candidate_id"] for item in reused])
        self.assertEqual(before_reuse, len(timeouts))

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
        batch = self.create(1)
        state = domain._load(batch["batch_id"])
        domain._active_batch = state
        observation = "地面：花岗岩纹理，反光；画面中明确记录一台绿色设备正在移动。"
        shot = {"segment_id": "shot-guidance", "fact_id": "fact-guidance",
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
        with patch.object(domain, "_visual_review", side_effect=lambda candidate, current: (
                visual_calls.append(candidate["candidate_id"]) or
                {"accepted": True, "quality_score": .9, "unsupported_claims": [], "reason": "画面复核通过"})):
            audit = {"rejections": []}
            accepted = domain._review([guidance, motion], state, audit)

        self.assertEqual([guidance["candidate_id"]], [item["candidate_id"] for item in accepted])
        self.assertEqual([guidance["candidate_id"]], visual_calls)
        unsupported = audit["rejections"][0]["unsupported_claims"]
        self.assertEqual(["设备在大厅里匀速行进，", "全程没有停顿。"],
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

    def test_claim_reset_pins_shots_and_compiles_bounded_grounded_sections(self):
        domain = NarratedBatchDomain(self.s.creative_domain)
        batch = self.s.save_narrated_batch({
            "groups": {"opening": self.ids[:1], "middle": [], "ending": []},
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
                "segment_id": f"claim-reset-shot-{index}", "asset_id": self.ids[0],
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
        rejected = {
            "candidate_id": "candidate-claim-reset", "title": "无依据结果",
            "angle": "错误能力断言", "shots": [shots[0], shots[2], shots[3]],
            "phrases": [{"text": "设备始终稳定运行。",
                         "shot_ids": [shots[0]["segment_id"], shots[2]["segment_id"],
                                      shots[3]["segment_id"]]}],
        }
        planning_shots = [{**shot, "max_narration_chars": 45} for shot in shots]
        audit = {"rejections": [{
            "stage": "claim_review", "candidate_id": rejected["candidate_id"],
            "title": rejected["title"], "reason": "连续性没有事实依据",
            "unsupported_claims": [{"quote": "始终稳定", "reason": "稀疏帧不能证明"}],
        }]}
        calls = []

        def complete(*, messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            calls.append(payload)
            self.assertNotIn("rejected_plans", payload)
            self.assertEqual(["direct_real", "illustrative"],
                             [slot["source_class"] for slot in payload["paragraph_slots"]])
            self.assertTrue(all(
                set(fact) == {"anchor_ref", "fact_id", "source_class", "observation"}
                and fact["source_class"] == slot["source_class"]
                and "未经核验" not in fact["observation"]
                and "不可用" not in fact["observation"]
                for slot in payload["paragraph_slots"] for fact in slot["facts"]
            ))
            ids = [[fact["anchor_ref"] for fact in slot["facts"]]
                   for slot in payload["paragraph_slots"]]
            result = {"candidate_id": payload["candidate_id"], "sections": [
                {"stage": "opening", "anchor_refs": ids[0],
                 "scene": "室内狭窄通道转角", "checks": [{
                     "anchor_refs": ids[0], "observable": "设备和墙边参照物的相对位置",
                     "predicate": "不同取景时的位置变化幅度",
                     "record_item": "三次取景对应的位置和间距",
                 }]},
                {"stage": "ending", "anchor_refs": ids[1],
                 "scene": "设备工作路径画面", "checks": [{
                     "anchor_refs": ids[1], "observable": "设备与地面边界的相对位置",
                     "predicate": "各取景点之间的距离差异",
                     "record_item": "每一次现场实拍的具体时间和对应位置",
                 }]},
            ]}
            invalid = {**result, "title": "模型不应自由写标题"}
            self.assertIn("只能返回", kwargs["validation_error"](invalid))
            self.assertIsNone(kwargs["validation_error"](result))
            return result

        self.analyzer.cloud_client._structured_completion = complete
        with patch.object(domain, "_speech_ms_per_char", return_value=193.0), \
             patch.object(domain, "_review", side_effect=lambda candidates, *_args: candidates):
            repaired = domain._repair_reviewed(
                task["task_id"], [rejected], [], state, planning_shots, [], audit)

        self.assertEqual(1, len(calls))
        self.assertEqual(1, len(repaired))
        candidate = repaired[0]
        pure_shots = shots[:2] + shots[4:]
        self.assertEqual([shot["segment_id"] for shot in pure_shots],
                         [shot["segment_id"] for shot in candidate["shots"]])
        self.assertEqual(candidate["narration"],
                         "".join(phrase["text"] for phrase in candidate["phrases"]))
        self.assertLessEqual(156, len(candidate["narration"]))
        self.assertLessEqual(len(candidate["narration"]), 188)
        self.assertIn("只是示意，不能作实测结论", candidate["narration"])
        self.assertNotIn("始终稳定", candidate["narration"])
        self.assertEqual(
            "在室内狭窄通道转角观察设备和墙边参照物的相对位置时，要记录什么？",
            candidate["title"])
        by_id = {shot["segment_id"]: shot for shot in candidate["shots"]}
        self.assertTrue(all(len({
            by_id[shot_id]["visual_facts"]["evidence_class"]
            for shot_id in phrase["shot_ids"]
        }) == 1 for phrase in candidate["phrases"]))
        self.assertEqual([shot["segment_id"] for shot in pure_shots],
                         [shot_id for phrase in candidate["phrases"]
                          for shot_id in phrase["shot_ids"]])

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
