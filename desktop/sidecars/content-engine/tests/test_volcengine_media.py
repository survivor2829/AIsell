import os
import unittest
from unittest.mock import patch
from urllib import request
from urllib.error import HTTPError

from content_engine.errors import ContentEngineError
from content_engine.volcengine_media import ARK_ENDPOINT, VolcengineMediaClient


class VolcengineMediaTests(unittest.TestCase):
    def test_gateway_asr_uses_configured_ca_without_disabling_tls(self):
        origin = "https://gateway.example"
        ca_pem = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----"
        gateway_url = origin + "/v1/provider-gateway/volcengine/asr/recognize/flash"
        with patch.dict(os.environ, {
            "XIAOXI_PROVIDER_GATEWAY_ORIGIN": origin,
            "XIAOXI_PROVIDER_GATEWAY_TOKEN": "gateway-token",
            "XIAOXI_PROVIDER_GATEWAY_CA_PEM": ca_pem,
        }, clear=False), patch("content_engine.provider_tls.ssl.create_default_context") as create_context, \
                patch("content_engine.volcengine_media.request.build_opener") as build_opener:
            context = create_context.return_value
            response = build_opener.return_value.open.return_value.__enter__.return_value
            response.headers.get.side_effect = lambda key: "20000003" if key == "X-Api-Status-Code" else None
            response.read.return_value = b"{}"
            result = VolcengineMediaClient()._post(gateway_url, {}, {}, 1, "语音识别")

        create_context.assert_called_once_with(cadata=ca_pem)
        https_handlers = [item for item in build_opener.call_args.args if isinstance(item, request.HTTPSHandler)]
        self.assertEqual(1, len(https_handlers))
        self.assertIs(https_handlers[0]._context, context)
        self.assertEqual("silent", result["speech_status"])

    def test_gateway_asr_fails_with_specific_configuration_error_without_ca(self):
        origin = "https://gateway.example"
        gateway_url = origin + "/v1/provider-gateway/volcengine/asr/recognize/flash"
        with patch.dict(os.environ, {
            "XIAOXI_PROVIDER_GATEWAY_ORIGIN": origin,
            "XIAOXI_PROVIDER_GATEWAY_TOKEN": "gateway-token",
            "XIAOXI_PROVIDER_GATEWAY_CA_PEM": "",
        }, clear=False):
            with self.assertRaises(ContentEngineError) as raised:
                VolcengineMediaClient()._post(gateway_url, {}, {}, 1, "语音识别")
        self.assertEqual("provider_gateway_tls_not_configured", raised.exception.code)

    def test_silent_material_is_not_a_permission_failure(self):
        with patch("content_engine.volcengine_media.request.build_opener") as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.headers.get.return_value = "20000003"
            response.read.return_value = b"{}"
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

    def test_gateway_5xx_is_outcome_unknown_without_retry_and_preserves_origin(self):
        with patch.dict(os.environ, {"XIAOXI_VOLCENGINE_ARK_API_KEY": "test-key"}):
            client = VolcengineMediaClient()
        error = HTTPError(
            ARK_ENDPOINT,
            504,
            "gateway timeout",
            {"X-Xiaoxi-Error-Origin": "gateway_transport"},
            None,
        )
        with patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json(
                    ARK_ENDPOINT,
                    method="POST",
                    payload={"model": client.selection_model},
                )
        self.assertEqual("volcengine_outcome_unknown", raised.exception.code)
        self.assertIn("HTTP 504", raised.exception.message)
        self.assertIn("网关传输", raised.exception.message)
        self.assertEqual(1, opener.return_value.open.call_count)
        self.assertEqual("gateway_transport", client._last_request_usage["error_origin"])
        self.assertEqual("outcome_unknown", client._last_request_usage["outcome"])

    def test_ark_429_without_retry_after_uses_bounded_backoff(self):
        with patch.dict(os.environ, {"XIAOXI_VOLCENGINE_ARK_API_KEY": "test-key"}):
            client = VolcengineMediaClient()
        rejected = HTTPError(ARK_ENDPOINT, 429, "rate limited", {}, None)
        with patch("content_engine.volcengine_media.request.build_opener") as opener, patch(
            "content_engine.volcengine_media.time.sleep"
        ) as sleep:
            opener.return_value.open.side_effect = [
                rejected,
                type("Response", (), {
                    "headers": {"X-Request-Id": "ok"},
                    "status": 200,
                    "read": lambda self, _limit=-1: b'{"choices":[{"message":{"content":"ok"}}]}',
                    "__enter__": lambda self: self,
                    "__exit__": lambda self, *_args: False,
                })(),
            ]
            result = client._request_json(
                ARK_ENDPOINT,
                method="POST",
                payload={"model": client.selection_model},
            )
        self.assertEqual(result["choices"][0]["message"]["content"], "ok")
        sleep.assert_called_once_with(1)

    def test_asr_grant_rejection_explains_server_credential_requirement(self):
        with patch.dict(os.environ, {"XIAOXI_VOLCENGINE_ASR_API_KEY": "test-key"}):
            client = VolcengineMediaClient()
        error = HTTPError(
            "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
            401,
            "Unauthorized",
            {"X-Api-Status-Code": "45000010"},
            None,
        )
        with patch("content_engine.volcengine_media.request.build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaises(ContentEngineError) as raised:
                client._post(error.url, {}, {}, 1, "语音识别")
        self.assertIn("volc.bigasr.auc_turbo", str(raised.exception))
        self.assertIn("ASR 专用 API Key", str(raised.exception))

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
