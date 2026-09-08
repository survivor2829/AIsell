import base64
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from content_engine.errors import ContentEngineError
from content_engine.provider_usage import ProviderRequest, provider_usage_summary, usage_scope
from content_engine.volcengine_media import ARK_ENDPOINT, ASR_ENDPOINT, VolcengineMediaClient
from content_engine.volcengine_tts import VolcengineTTSProvider
from content_engine.narrated_batch import compact_claim_segment
from content_engine.narrated_production import retryable_planning_jobs, retry_failed_planning


class Response(io.BytesIO):
    def __init__(self, body, headers=None):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.headers = headers or {"X-Request-Id": "request-header", "X-Tt-Logid": "log-123"}
        self.status = 200


class ProviderUsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_json_correction_is_two_requests_and_preserves_each_usage(self):
        client = VolcengineMediaClient()
        client.api_key = "must-not-store-secret"
        responses = [Response({"id": "first", "usage": {"prompt_tokens": 80, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 50}}, "choices": [{"message": {"content": "invalid json"}}]}),
                     Response({"id": "second", "usage": {"prompt_tokens": 100, "completion_tokens": 20}, "choices": [{"message": {"content": '{"ok":true}'}}]})]
        with usage_scope(self.root, task_id="task_1", batch_id="batch_1"), patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.side_effect = responses
            result = client._structured_completion(messages=[{"role": "user", "content": "private full narration"}], model="model-1", empty_code="empty", empty_message="empty", operation_label="逐段事实审核")
        self.assertEqual(result, {"ok": True})
        summary = provider_usage_summary(self.root, task_ids=["task_1"])
        self.assertEqual(summary["totals"]["calls"], 2)
        self.assertEqual(summary["totals"]["input_tokens"], 180)
        self.assertEqual(summary["totals"]["output_tokens"], 30)
        self.assertEqual(summary["totals"]["unknown_cached_tokens_calls"], 1)
        self.assertEqual(summary["totals"]["invalid_response_calls"], 1)
        self.assertEqual({row["correction_attempt"] for row in summary["items"]}, {1, 2})
        self.assertEqual(len({row["operation_id"] for row in summary["items"]}), 1)
        self.assertEqual(len(client.last_completion_requests), 2)
        saved = (self.root / "provider-usage.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("private full narration", saved)
        self.assertNotIn("must-not-store-secret", saved)
        self.assertNotIn("invalid json", saved)

    def test_rejected_unknown_and_interrupted_calls_are_not_free_or_retried(self):
        client = VolcengineMediaClient()
        client.api_key = "test-key"
        with usage_scope(self.root, task_id="task_2"), patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.side_effect = HTTPError(ARK_ENDPOINT, 403, "private error", {"X-Request-Id": "rejected-id"}, io.BytesIO(b'{"error":{"code":"QuotaExceeded","message":"private customer text"}}'))
            with self.assertRaises(ContentEngineError):
                client._structured_completion(messages=[], model="model-1", empty_code="empty", empty_message="empty")
            self.assertEqual(opener.return_value.open.call_count, 1)
            opener.return_value.open.side_effect = TimeoutError()
            with self.assertRaises(ContentEngineError):
                client._structured_completion(messages=[], model="model-1", empty_code="empty", empty_message="empty")
            self.assertEqual(opener.return_value.open.call_count, 2)
            ProviderRequest(provider="volcengine", kind="llm", model="model-1").__enter__()
        rows = provider_usage_summary(self.root, task_ids=["task_2"])
        self.assertEqual(rows["totals"]["calls"], 3)
        self.assertEqual(rows["totals"]["outcome_unknown_calls"], 2)
        self.assertEqual(rows["totals"]["rejected_calls"], 1)
        self.assertEqual(rows["totals"]["unknown_input_tokens_calls"], 3)
        self.assertIsNone(rows["totals"]["input_tokens"])
        self.assertEqual(rows["totals"]["llm_calls"], 3)
        self.assertEqual(rows["totals"]["tts_calls"], 0)
        rejected = next(row for row in rows["items"] if row["outcome"] == "rejected")
        self.assertEqual(rejected["provider_code"], "QuotaExceeded")
        self.assertEqual(rejected["request_id"], "rejected-id")
        self.assertNotIn("private customer text", json.dumps(rows))

    def test_tts_final_sse_usage_and_asr_duration_are_separate(self):
        pcm = b"\x01\x00" * 2400
        events = [{"code": 0, "data": base64.b64encode(pcm).decode()}, {"code": 20000000, "usage": {"text_words": 9}}]
        body = b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events)
        provider = VolcengineTTSProvider(api_key="not-stored")
        with usage_scope(self.root, task_id="task_voice", batch_id="batch_1"), patch("content_engine.volcengine_tts.request.build_opener") as opener:
            opener.return_value.open.return_value = Response(body)
            result = provider.synthesize_auto_mix_phrase("这是测试。", self.root / "voice.wav", {"provider": "volcengine", "provider_model": "seed-tts-2.0", "provider_voice_id": "approved-test-voice"})
            operation = opener.return_value.open.call_args.args[0]
            self.assertEqual(operation.get_header("X-control-require-usage-tokens-return"), "text_words")
        self.assertEqual(result["billed_characters"], 9)
        client = VolcengineMediaClient()
        with usage_scope(self.root, task_id="task_asr", batch_id="batch_1"), patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.return_value = Response({"audio_info": {"duration": 2499}, "result": {"text": "private speech"}}, {"X-Api-Status-Code": "20000000", "X-Tt-Logid": "asr-log"})
            client._post(ASR_ENDPOINT, {}, {}, 1, "语音识别", requested_audio_ms=2500)
        totals = provider_usage_summary(self.root, batch_id="batch_1")["totals"]
        self.assertEqual(totals["billed_characters"], 9)
        self.assertEqual(totals["requested_characters"], 5)
        self.assertEqual(totals["generated_audio_ms"], 100)
        self.assertEqual(totals["audio_ms"], 2499)
        self.assertEqual(totals["requested_audio_ms"], 2500)

    def test_compaction_preserves_context_and_explicit_recovery_excludes_unknown(self):
        source = {"phrase_id": "phrase-2", "text": "当前正文" * 20, "segment_key": "same-key", "facts": [{"fact_id": "fact_1", "evidence_key": "a" * 64, "direct_observation": "对应画面"}],
                  "narrative_context": {"title": "标题", "paragraphs": ["前段", "当前正文" * 20, "后段"]}}
        wire = compact_claim_segment(source)
        context = wire["narrative_context"]
        self.assertEqual(context["before"] + [wire["text"]] + context["after"], source["narrative_context"]["paragraphs"])
        self.assertEqual(wire["segment_key"], source["segment_key"])
        self.assertIn("evidence_key", source["facts"][0])
        self.assertNotIn("evidence_key", wire["facts"][0])
        self.assertLess(len(json.dumps(wire)), len(json.dumps(source)))
        batch = {"candidates": [{"candidate_id": "c1", "status": "failed"}], "production_jobs": [{"candidate_id": "c1", "status": "skipped", "error_code": "volcengine_request_rejected"}]}
        self.assertEqual(len(retryable_planning_jobs(batch)), 1)
        self.assertEqual(batch["production_jobs"][0]["status"], "skipped")
        batch["_planning_inflight"] = "unknown"
        self.assertEqual(retryable_planning_jobs(batch), [])
        batch.pop("_planning_inflight")
        retry_failed_planning(batch)
        self.assertEqual(batch["production_jobs"][0]["status"], "queued")
        self.assertEqual(batch["candidates"][0]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
