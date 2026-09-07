import os
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from content_engine.errors import ContentEngineError
from content_engine.volcengine_media import ARK_ENDPOINT, VolcengineMediaClient


class VolcengineMediaTests(unittest.TestCase):
    def test_silent_material_is_not_a_permission_failure(self):
        with patch("content_engine.volcengine_media.request.build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.headers.get.return_value = "20000003"
            result = VolcengineMediaClient()._post("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", {}, {}, 1, "语音识别")
        self.assertEqual(VolcengineMediaClient.asr_sentences(result), [])
        self.assertEqual(result["speech_status"], "silent")

    def test_asr_pair_is_isolated_from_tts_and_requires_both_fields(self):
        with patch.dict(os.environ, {"XIAOXI_VOLCENGINE_ASR_APP_ID": "123", "XIAOXI_VOLCENGINE_ASR_ACCESS_TOKEN": "asr-token", "XIAOXI_VOLCENGINE_TTS_API_KEY": "tts-key"}):
            client = VolcengineMediaClient()
        self.assertEqual(client._asr_auth_headers(), {"X-Api-App-Key": "123", "X-Api-Access-Key": "asr-token"})
        client.asr_access_token = ""
        with self.assertRaises(ContentEngineError):
            client._asr_auth_headers()

    def test_no_legacy_key_or_endpoint_fallback(self):
        with patch.dict(os.environ, {"DASHSCOPE_API_KEY": "old-secret", "XIAOXI_BAILIAN_API_HOST": "https://example.invalid", "XIAOXI_VOLCENGINE_ARK_API_KEY": ""}):
            client = VolcengineMediaClient()
            self.assertFalse(client.configured)
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", method="POST", payload={})
            self.assertEqual(raised.exception.code, "volcengine_operation_unsupported")

    def test_http_rejection_is_not_retried(self):
        with patch.dict(os.environ, {"XIAOXI_VOLCENGINE_ARK_API_KEY": "test-key"}):
            client = VolcengineMediaClient()
        with patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.side_effect = HTTPError(ARK_ENDPOINT, 401, "Unauthorized", {}, None)
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json(ARK_ENDPOINT, method="POST", payload={"model": client.selection_model}, retry_on_timeout=True)
            self.assertEqual(raised.exception.code, "volcengine_request_rejected")
            self.assertEqual(opener.return_value.open.call_count, 1)

    def test_word_times_are_converted_without_inventing_alignment(self):
        result = VolcengineMediaClient.asr_sentences({"result": {"utterances": [
            {"text": "清洁。", "start_time": 100, "end_time": 700, "words": [
                {"text": "清", "start_time": 100, "end_time": 300},
                {"text": "洁", "start_time": 300, "end_time": 650},
                {"text": "bad", "start_time": 650, "end_time": 900}]},
            {"text": "下一句", "start_time": 900, "end_time": 1200},
            {"text": "invalid", "start_time": 1200, "end_time": 1000}]}})
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["metadata"]["words"][0]["begin_time"], 100)
        self.assertEqual(len(result[0]["metadata"]["words"]), 2)
        self.assertEqual(result[1]["metadata"]["words"], [])


if __name__ == "__main__":
    unittest.main()
