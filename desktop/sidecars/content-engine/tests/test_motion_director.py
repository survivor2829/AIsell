from __future__ import annotations

import json
import unittest

from content_engine.creative_analysis import DashScopeMediaClient
from content_engine.errors import ContentEngineError


class RecordingDashScopeClient(DashScopeMediaClient):
    def __init__(self, response):
        super().__init__(api_key="sk-test-motion-director")
        self.response = response
        self.requests = []

    def _request_json(self, url, **options):
        self.requests.append((url, options))
        return self.response


class MotionDirectorTests(unittest.TestCase):
    def test_bailian_batches_multiple_clips_into_one_paid_planning_request(self):
        client = RecordingDashScopeClient(
            {
                "choices": [{
                    "message": {"content": json.dumps({
                        "candidates": [
                            {
                                "id": "c1",
                                "events": [{
                                    "type": "hook", "text": "先看设备怎么收集垃圾",
                                    "start_ms": 0, "end_ms": 2200,
                                    "zone": "top_banner", "size": "hero",
                                    "priority": 3, "icon": "question", "reason": "开场问题",
                                }],
                            },
                            {
                                "id": "c2",
                                "events": [{
                                    "type": "keyword", "text": "办公商用场景",
                                    "start_ms": 4000, "end_ms": 5900,
                                    "zone": "upper_left", "size": "card",
                                    "priority": 2, "icon": "office", "reason": "场景结论",
                                }],
                            },
                        ]
                    }, ensure_ascii=False)}
                }]
            }
        )

        result = client.plan_motion_events_batch([
            {
                "id": "clip-a", "duration_ms": 12_000,
                "transcript": "设备可以用边刷收集垃圾。", "captions": [],
                "visual_context": [], "style_id": "knowledge_focus",
            },
            {
                "id": "clip-b", "duration_ms": 10_000,
                "transcript": "它适合办公和商用场景。", "captions": [],
                "visual_context": [], "style_id": "classroom_value",
            },
        ])

        self.assertEqual(1, len(client.requests))
        self.assertEqual({"clip-a", "clip-b"}, set(result))
        self.assertEqual("bailian", result["clip-a"]["provider"])
        self.assertEqual("upper_left", result["clip-b"]["events"][0]["zone"])

    def test_bailian_batch_rejects_a_missing_clip_instead_of_faking_layout(self):
        client = RecordingDashScopeClient({
            "choices": [{"message": {"content": '{"candidates":[]}'}}]
        })

        with self.assertRaises(ContentEngineError) as raised:
            client.plan_motion_events_batch([{
                "id": "clip-a", "duration_ms": 10_000,
                "transcript": "真实课程内容", "captions": [],
                "visual_context": [], "style_id": "knowledge_focus",
            }])

        self.assertEqual("cloud_motion_plan_invalid", raised.exception.code)

    def test_bailian_plans_semantic_timing_and_bounded_layout_intent(self):
        response = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "events": [
                                    {
                                        "type": "hook",
                                        "text": "扫洗一体，适合什么场景？",
                                        "start_ms": 0,
                                        "end_ms": 2300,
                                        "zone": "top_banner",
                                        "size": "hero",
                                        "priority": 3,
                                        "icon": "question",
                                        "reason": "开头提出核心问题",
                                        "x": 0.91,
                                        "y": 0.02,
                                    },
                                    {
                                        "type": "keyword",
                                        "text": "一组边刷",
                                        "start_ms": 6200,
                                        "end_ms": 7900,
                                        "zone": "upper_right",
                                        "size": "chip",
                                        "priority": 2,
                                        "icon": "brush",
                                        "reason": "与讲解同步",
                                    },
                                    {
                                        "type": "keyword",
                                        "text": "整段霸屏",
                                        "start_ms": 0,
                                        "end_ms": 15_680,
                                        "zone": "middle_left",
                                        "size": "card",
                                        "priority": 1,
                                    },
                                ]
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }
        client = RecordingDashScopeClient(response)

        result = client.plan_motion_events(
            transcript="它是扫洗一体，有一组边刷，适合办公和商用场景。",
            duration_ms=15_680,
            captions=[
                {"text": "它是扫洗一体", "start_ms": 0, "end_ms": 3100},
                {"text": "有一组边刷", "start_ms": 6100, "end_ms": 8100},
            ],
            visual_context=[
                {"start_ms": 0, "end_ms": 15_680, "shot_type": "slide_teacher"}
            ],
            style_id="social_pop",
        )

        self.assertEqual("bailian", result["provider"])
        self.assertEqual("qwen-plus", result["model"])
        self.assertEqual(2, len(result["events"]))
        self.assertEqual("upper_right", result["events"][1]["zone"])
        self.assertNotIn("x", result["events"][0])
        self.assertNotIn("y", result["events"][0])
        payload = client.requests[0][1]["payload"]
        prompt = payload["messages"][0]["content"]
        self.assertIn("只返回语义区域", prompt)
        self.assertNotIn("source_path", prompt)

    def test_bailian_motion_plan_fails_when_no_valid_events_return(self):
        client = RecordingDashScopeClient(
            {"choices": [{"message": {"content": '{"events":[{"type":"confetti"}]}'}}]}
        )

        with self.assertRaises(ContentEngineError) as raised:
            client.plan_motion_events(
                transcript="真实课程内容",
                duration_ms=10_000,
                captions=[],
                visual_context=[],
                style_id="social_pop",
            )

        self.assertEqual("cloud_motion_plan_invalid", raised.exception.code)

    def test_bailian_rejects_an_ungrounded_marketing_claim(self):
        client = RecordingDashScopeClient({
            "choices": [{"message": {"content": json.dumps({
                "events": [{
                    "type": "result", "text": "效率提升百分之五十",
                    "start_ms": 7_000, "end_ms": 9_000,
                    "zone": "top_banner", "size": "card", "priority": 3,
                }]
            }, ensure_ascii=False)}}]
        })

        with self.assertRaises(ContentEngineError) as raised:
            client.plan_motion_events(
                transcript="老师正在说明设备的清洁流程。",
                duration_ms=10_000,
                captions=[],
                visual_context=[],
                style_id="social_pop",
            )

        self.assertEqual("cloud_motion_plan_invalid", raised.exception.code)

    def test_invalid_motion_input_is_rejected_before_a_paid_request(self):
        client = RecordingDashScopeClient({"choices": []})

        with self.assertRaises(ContentEngineError) as raised:
            client.plan_motion_events(
                transcript="",
                duration_ms=0,
                captions=[],
                visual_context=[],
                style_id="social_pop",
            )

        self.assertEqual("invalid_motion_plan_input", raised.exception.code)
        self.assertEqual([], client.requests)


if __name__ == "__main__":
    unittest.main()
