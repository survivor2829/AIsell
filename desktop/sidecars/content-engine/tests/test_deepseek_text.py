"""Director transport contracts; no real provider requests."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from content_engine.deepseek_text import DeepSeekTextClient
from content_engine.errors import ContentEngineError
from content_engine.provider_usage import usage_scope


class DeepSeekTextTests(unittest.TestCase):
    def test_structured_json_uses_existing_usage_and_explicit_text_model(self):
        response = io.BytesIO(json.dumps({"id": "reply-1", "model": "deepseek-v4-flash",
            "choices": [{"message": {"content": '{"ok":true}'}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4}}).encode())
        response.headers, response.status = {}, 200
        opener = Mock()
        opener.open.return_value = response
        with tempfile.TemporaryDirectory() as directory, patch(
                "content_engine.deepseek_text.request.build_opener", return_value=opener):
            client = DeepSeekTextClient(api_key="test-secret")
            with usage_scope(Path(directory), task_id="task-director"):
                result = client._structured_completion(messages=[{"role": "user", "content": "保留完整原稿"}],
                    model=client.selection_model, empty_code="empty", empty_message="empty")
            self.assertEqual({"ok": True}, result)
            op = opener.open.call_args.args[0]
            body = json.loads(op.data)
            self.assertEqual("https://api.deepseek.com/chat/completions", op.full_url)
            self.assertEqual("deepseek-v4-flash", body["model"])
            self.assertEqual({"type": "disabled"}, body["thinking"])
            self.assertTrue(op.get_header("X-xiaoxi-operation-id"))
            events = [json.loads(row) for row in (Path(directory) / "provider-usage.jsonl").read_text().splitlines()]
            self.assertEqual("deepseek", events[-1]["provider"])
            self.assertEqual("accepted", events[-1]["response_validation"])
            self.assertNotIn("test-secret", json.dumps(events))

    def test_unknown_transport_is_not_submitted_twice(self):
        opener = Mock()
        opener.open.side_effect = TimeoutError("response unavailable")
        client = DeepSeekTextClient(api_key="test-secret")
        with tempfile.TemporaryDirectory() as directory, patch(
                "content_engine.deepseek_text.request.build_opener", return_value=opener):
            with usage_scope(Path(directory)), self.assertRaises(ContentEngineError) as error:
                client._structured_completion(messages=[{"role": "user", "content": "导演规划"}],
                    model=client.selection_model, empty_code="empty", empty_message="empty")
            self.assertEqual("cloud_request_failed", error.exception.code)
            self.assertEqual(1, opener.open.call_count)
            events = [json.loads(row) for row in (Path(directory) / "provider-usage.jsonl").read_text().splitlines()]
            self.assertEqual("outcome_unknown", events[-1]["outcome"])

    def test_rejects_images_and_untrusted_provider_destination(self):
        with self.assertRaises(ContentEngineError):
            DeepSeekTextClient(api_key="test-secret", endpoint="https://example.com/chat/completions")
        client = DeepSeekTextClient(api_key="test-secret")
        with patch("content_engine.deepseek_text.request.build_opener") as transport:
            with self.assertRaises(ContentEngineError) as error:
                client._structured_completion(messages=[{"role": "user", "content": [{"type": "image_url"}]}],
                    model=client.selection_model, empty_code="empty", empty_message="empty")
            self.assertEqual("deepseek_text_only", error.exception.code)
            transport.assert_not_called()
