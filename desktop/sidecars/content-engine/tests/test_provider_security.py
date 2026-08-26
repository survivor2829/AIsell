from __future__ import annotations

import base64
from contextlib import contextmanager
from email.message import Message
import io
import json
import os
import socket
from pathlib import Path
import shutil
import sys
import unittest
from unittest import mock
import urllib.error
import urllib.request
import uuid
import wave


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.apimart_cover import (
    APIMartCoverClient,
    APIMartError,
    ProviderResponseIncomplete,
    ProviderResponseTooLarge,
    ProviderUrlError,
    _ProviderRedirectHandler,
    public_https_get,
    validate_public_https_url,
)
from content_engine.creative_analysis import (
    AUTO_MIX_TTS_MODEL,
    AUTO_MIX_TTS_SAMPLE_RATE,
    DEFAULT_DASHSCOPE_ORIGIN,
    MAX_PROVIDER_JSON_BYTES,
    VOICE_PREVIEW_SAMPLE,
    DashScopeMediaClient,
    FFmpegCreativeAnalyzer,
)
from content_engine.errors import ContentEngineError
from content_engine.auto_mix_resources import (
    BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES,
)


def resolver_for(address):
    return lambda _host, port, **_kwargs: [
        (2, 1, 6, "", (address, port))
    ]


def auto_mix_wav_bytes(*, sample_rate=AUTO_MIX_TTS_SAMPLE_RATE, frames=480):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * frames)
    return output.getvalue()


def auto_mix_streaming_wav_bytes(*, frames=480):
    """Match the placeholder RIFF/data lengths returned by Bailian TTS."""
    output = bytearray(auto_mix_wav_bytes(frames=frames))
    if output[36:40] != b"data":
        raise AssertionError("test WAV data chunk moved")
    riff_size, data_size = BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES
    output[4:8] = riff_size.to_bytes(4, "little")
    output[40:44] = data_size.to_bytes(4, "little")
    return bytes(output)


def auto_mix_unknown_placeholder_wav_bytes(*, frames=480):
    output = bytearray(auto_mix_wav_bytes(frames=frames))
    output[4:8] = (0x7FFF0000).to_bytes(4, "little")
    output[40:44] = (0x7FFF0000).to_bytes(4, "little")
    return bytes(output)


@contextmanager
def provider_test_directory(prefix):
    root = SIDECAR_ROOT / f".{prefix}{uuid.uuid4().hex}"
    root.mkdir()
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


class ProviderOriginSecurityTests(unittest.TestCase):
    def test_dashscope_ignores_inherited_origin_overrides(self):
        with mock.patch.dict(
            os.environ,
            {
                "DASHSCOPE_ORIGIN": "https://attacker.invalid",
                "DASHSCOPE_COMPATIBLE_ORIGIN": "https://attacker.invalid/v1",
            },
            clear=False,
        ):
            client = DashScopeMediaClient(api_key="sk-test-key")

        self.assertEqual(DEFAULT_DASHSCOPE_ORIGIN, client.origin)
        self.assertEqual(
            f"{DEFAULT_DASHSCOPE_ORIGIN}/compatible-mode/v1",
            client.compatible_origin,
        )

    def test_dashscope_explicit_https_origins_remain_testable(self):
        client = DashScopeMediaClient(
            api_key="sk-test-key",
            origin="https://api.test",
            compatible_origin="https://chat.test/v1",
        )

        self.assertEqual("https://api.test", client.origin)
        self.assertEqual("https://chat.test/v1", client.compatible_origin)
        with self.assertRaises(ContentEngineError) as raised:
            DashScopeMediaClient(api_key="sk-test-key", origin="http://api.test")
        self.assertEqual("cloud_origin_invalid", raised.exception.code)

    def test_authenticated_cross_origin_redirect_is_blocked(self):
        handler = _ProviderRedirectHandler()
        operation = urllib.request.Request(
            "https://api.apimart.ai/v1/tasks/one",
            headers={"Authorization": "Bearer secret"},
        )

        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(
                operation,
                None,
                302,
                "Found",
                Message(),
                "https://attacker.invalid/collect",
            )

        redirected = handler.redirect_request(
            operation,
            None,
            302,
            "Found",
            Message(),
            "https://api.apimart.ai/v1/tasks/two",
        )
        self.assertEqual(
            "https://api.apimart.ai/v1/tasks/two", redirected.full_url
        )


class ProviderDownloadSecurityTests(unittest.TestCase):
    def test_public_url_rejects_http_credentials_and_private_literals(self):
        invalid_urls = (
            "http://example.com/cover.png",
            "https://user:secret@example.com/cover.png",
            "https://localhost/cover.png",
            "https://127.0.0.1/cover.png",
            "https://10.0.0.2/cover.png",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/cover.png",
            "https://[fe80::1]/cover.png",
        )
        for url in invalid_urls:
            with self.subTest(url=url), self.assertRaises(ProviderUrlError):
                validate_public_https_url(url, resolve_dns=False)

    def test_public_url_rejects_hostname_resolving_to_private_ipv4_or_ipv6(self):
        for address in ("192.168.1.4", "fd00::1"):
            with self.subTest(address=address), self.assertRaises(ProviderUrlError):
                validate_public_https_url(
                    "https://cdn.example/cover.png",
                    resolver=resolver_for(address),
                )

        self.assertEqual(
            "https://cdn.example/cover.png",
            validate_public_https_url(
                "https://cdn.example/cover.png",
                resolver=resolver_for("93.184.216.34"),
            ),
        )

    def test_public_redirect_revalidates_private_destination(self):
        handler = _ProviderRedirectHandler(
            resolver=resolver_for("10.20.30.40")
        )
        operation = urllib.request.Request("https://cdn.example/cover.png")
        operation._xiaoxi_public_download = True

        with self.assertRaises(ProviderUrlError):
            handler.redirect_request(
                operation,
                None,
                302,
                "Found",
                Message(),
                "https://private.example/cover.png",
            )

    def test_public_download_rejects_oversized_body(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.geturl.return_value = "https://8.8.8.8/cover.png"
        response.read.side_effect = lambda size: b"x" * size

        with mock.patch("urllib.request.urlopen", return_value=response):
            with self.assertRaises(ProviderResponseTooLarge):
                public_https_get(
                    "https://8.8.8.8/cover.png",
                    timeout=1,
                    max_bytes=128,
                )

        response.read.assert_called_once_with(129)

    def test_public_download_rejects_truncated_declared_body(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.geturl.return_value = "https://8.8.8.8/voice.wav"
        response.headers = Message()
        response.headers["Content-Length"] = "10"
        response.read.return_value = b"short"

        with mock.patch("urllib.request.urlopen", return_value=response):
            with self.assertRaises(ProviderResponseIncomplete):
                public_https_get(
                    "https://8.8.8.8/voice.wav",
                    timeout=1,
                    max_bytes=128,
                )


class ProviderResponseSecurityTests(unittest.TestCase):
    def test_auto_mix_voice_design_uses_private_bailian_contract_once(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://workspace.cn-beijing.maas.aliyuncs.com",
        )
        private_voice_id = "cosyvoice-v3.5-plus-vd-life26-private"
        wav_audio = auto_mix_wav_bytes()
        client._request_json = mock.Mock(
            return_value={
                "request_id": "voice-design-request-1",
                "output": {
                    "target_model": AUTO_MIX_TTS_MODEL,
                    "voice_id": private_voice_id,
                    "preview_audio": {
                        "data": base64.b64encode(wav_audio).decode("ascii"),
                        "sample_rate": AUTO_MIX_TTS_SAMPLE_RATE,
                        "response_format": "wav",
                    },
                },
                "usage": {"count": 1},
            }
        )
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-voice-design-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        output = root / "preview.wav"

        result = client.design_auto_mix_voice(
            output,
            {
                "provider_model": AUTO_MIX_TTS_MODEL,
                "voice_prompt": "年轻自然的中文女声，松弛清晰，像真实生活分享。",
                "voice_prefix": "life26",
            },
        )

        self.assertEqual(wav_audio, output.read_bytes())
        self.assertEqual(private_voice_id, result["provider_voice_id"])
        self.assertEqual(1, client._request_json.call_count)
        request_url = client._request_json.call_args.args[0]
        request_options = client._request_json.call_args.kwargs
        self.assertEqual(
            "https://workspace.cn-beijing.maas.aliyuncs.com/"
            "api/v1/services/audio/tts/customization",
            request_url,
        )
        self.assertEqual("POST", request_options["method"])
        self.assertFalse(request_options["retry_on_timeout"])
        self.assertEqual(
            {
                "model": "voice-enrollment",
                "input": {
                    "action": "create_voice",
                    "target_model": AUTO_MIX_TTS_MODEL,
                    "voice_prompt": "年轻自然的中文女声，松弛清晰，像真实生活分享。",
                    "preview_text": (
                        "你好，这是一段自然、清晰的中文口播试听。"
                        "接下来，我会用真实分享的语气把重点讲明白。"
                    ),
                    "prefix": "life26",
                    "language_hints": ["zh"],
                },
                "parameters": {
                    "sample_rate": AUTO_MIX_TTS_SAMPLE_RATE,
                    "response_format": "wav",
                },
            },
            request_options["payload"],
        )

    def test_auto_mix_voice_design_submit_timeout_is_outcome_unknown(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://workspace.cn-beijing.maas.aliyuncs.com",
            timeout_seconds=9,
        )
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-voice-design-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)

        with mock.patch(
            "content_engine.creative_analysis.provider_urlopen",
            side_effect=socket.timeout("transport detail"),
        ) as opened:
            with self.assertRaises(ContentEngineError) as raised:
                client.design_auto_mix_voice(
                    root / "unknown.wav",
                    {
                        "provider_model": AUTO_MIX_TTS_MODEL,
                        "voice_prompt": "年轻自然的中文女声，松弛清晰。",
                        "voice_prefix": "life26",
                    },
                )

        self.assertEqual(1, opened.call_count)
        self.assertEqual(
            "auto_mix_voice_design_outcome_unknown", raised.exception.code
        )
        self.assertNotIn("sk-private-auto-mix-key", raised.exception.message)

    def test_auto_mix_voice_design_reconciliation_only_observes_existing_voice(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://workspace.cn-beijing.maas.aliyuncs.com",
        )
        private_voice_id = "cosyvoice-v3.5-plus-vd-life26-existing"
        client._request_json = mock.Mock(
            side_effect=[
                {
                    "request_id": "voice-list-request-1",
                    "output": {
                        "voice_list": [
                            {
                                "voice_id": private_voice_id,
                                "status": "OK",
                                "voice_prompt": "年轻自然的中文女声，松弛清晰，像真实生活分享。",
                                "preview_text": VOICE_PREVIEW_SAMPLE,
                            }
                        ]
                    },
                    "usage": {"count": 1},
                },
                {
                    "request_id": "voice-query-request-1",
                    "output": {
                        "voice_id": private_voice_id,
                        "target_model": AUTO_MIX_TTS_MODEL,
                        "status": "OK",
                        "voice_prompt": "年轻自然的中文女声，松弛清晰，像真实生活分享。",
                        "preview_text": VOICE_PREVIEW_SAMPLE,
                    },
                    "usage": {"count": 1},
                },
            ]
        )

        result = client.reconcile_auto_mix_voice_design(
            {
                "provider_model": AUTO_MIX_TTS_MODEL,
                "voice_prompt": "年轻自然的中文女声，松弛清晰，像真实生活分享。",
                "voice_prefix": "life26",
            }
        )

        self.assertEqual("recovered", result["status"])
        self.assertEqual(private_voice_id, result["provider_voice_id"])
        self.assertEqual(2, client._request_json.call_count)
        actions = [
            call.kwargs["payload"]["input"]["action"]
            for call in client._request_json.call_args_list
        ]
        self.assertEqual(["list_voice", "query_voice"], actions)
        self.assertNotIn("create_voice", actions)

    def test_auto_mix_voice_design_reconciliation_refuses_ambiguous_matches(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://workspace.cn-beijing.maas.aliyuncs.com",
        )
        prompt = "年轻自然的中文女声，松弛清晰，像真实生活分享。"
        client._request_json = mock.Mock(
            return_value={
                "request_id": "voice-list-request-ambiguous",
                "output": {
                    "voice_list": [
                        {
                            "voice_id": f"{AUTO_MIX_TTS_MODEL}-vd-life26-first",
                            "status": "OK",
                            "voice_prompt": prompt,
                            "preview_text": VOICE_PREVIEW_SAMPLE,
                        },
                        {
                            "voice_id": f"{AUTO_MIX_TTS_MODEL}-vd-life26-second",
                            "status": "OK",
                            "voice_prompt": prompt,
                            "preview_text": VOICE_PREVIEW_SAMPLE,
                        },
                    ]
                },
                "usage": {"count": 2},
            }
        )

        result = client.reconcile_auto_mix_voice_design(
            {
                "provider_model": AUTO_MIX_TTS_MODEL,
                "voice_prompt": prompt,
                "voice_prefix": "life26",
            }
        )

        self.assertEqual("ambiguous", result["status"])
        self.assertNotIn("provider_voice_id", result)
        self.assertEqual(1, client._request_json.call_count)

    def test_auto_mix_phrase_uses_locked_cosyvoice_contract_once(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://workspace.cn-beijing.maas.aliyuncs.com",
        )
        audio_url = (
            "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/"
            "pre/cosyvoice/result.wav?Expires=123&Signature=redacted"
        )
        client._request_json = mock.Mock(
            return_value={
                "request_id": "request-1",
                "output": {
                    "finish_reason": "stop",
                    "audio": {
                        "url": audio_url,
                        "id": "audio-request-1",
                        "expires_at": 1772697707,
                    },
                },
                "usage": {"characters": 8},
            }
        )
        analyzer = FFmpegCreativeAnalyzer(
            SIDECAR_ROOT,
            ffmpeg_path="ffmpeg",
            cloud_client=client,
        )
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-tts-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        output = root / "phrase.wav"
        private_voice_id = "cosyvoice-private-voice-id"
        wav_audio = auto_mix_wav_bytes()

        with mock.patch(
            "content_engine.creative_analysis.public_https_get",
            return_value=(200, wav_audio),
        ) as download:
            metadata = analyzer.synthesize_auto_mix_phrase(
                "  这款   产品很自然  ",
                output,
                {
                    "provider": "bailian",
                    "provider_model": AUTO_MIX_TTS_MODEL,
                    "provider_voice_id": private_voice_id,
                    "instruction": "自然、轻松，短句之间稍作停顿。",
                },
            )

        self.assertEqual(wav_audio, output.read_bytes())
        self.assertEqual(1, client._request_json.call_count)
        request_url = client._request_json.call_args.args[0]
        request_options = client._request_json.call_args.kwargs
        self.assertEqual(
            "https://workspace.cn-beijing.maas.aliyuncs.com/"
            "api/v1/services/audio/tts/SpeechSynthesizer",
            request_url,
        )
        self.assertEqual("POST", request_options["method"])
        self.assertFalse(request_options["retry_on_timeout"])
        self.assertEqual(AUTO_MIX_TTS_MODEL, request_options["payload"]["model"])
        self.assertEqual(
            {
                "text": "这款 产品很自然",
                "voice": private_voice_id,
                "format": "wav",
                "sample_rate": AUTO_MIX_TTS_SAMPLE_RATE,
                "instruction": "自然、轻松，短句之间稍作停顿。",
            },
            request_options["payload"]["input"],
        )
        download.assert_called_once()
        self.assertEqual(
            audio_url.replace("http://", "https://", 1),
            download.call_args.args[0],
        )
        self.assertEqual("bailian", metadata["provider"])
        self.assertEqual(AUTO_MIX_TTS_MODEL, metadata["model"])
        self.assertEqual(AUTO_MIX_TTS_SAMPLE_RATE, metadata["sample_rate"])
        self.assertGreater(metadata["duration_ms"], 0)
        self.assertEqual("request-1", metadata["request_id"])
        self.assertNotIn(private_voice_id, repr(metadata))
        self.assertNotIn("voice", metadata)

    def test_auto_mix_phrase_normalizes_bailian_streaming_wav_lengths(self):
        client = DashScopeMediaClient(api_key="sk-test", origin="https://api.test")
        client._request_json = mock.Mock(
            return_value={
                "request_id": "request-streaming-wav",
                "output": {
                    "finish_reason": "stop",
                    "audio": {
                        "url": "https://voice-cdn.test/result.wav",
                        "id": "audio-streaming-wav",
                    },
                },
                "usage": {"characters": 4},
            }
        )
        source_audio = auto_mix_streaming_wav_bytes(frames=480)

        with provider_test_directory("xiaoxi-auto-mix-streaming-wav-") as root:
            output = root / "phrase.wav"
            with mock.patch(
                "content_engine.creative_analysis.public_https_get",
                return_value=(200, source_audio),
            ):
                metadata = client.synthesize_auto_mix_phrase(
                    "自然配音",
                    output,
                    {
                        "provider_model": AUTO_MIX_TTS_MODEL,
                        "provider_voice_id": "private-voice",
                    },
                )

            with wave.open(str(output), "rb") as wav_file:
                self.assertEqual(480, wav_file.getnframes())
                self.assertEqual(AUTO_MIX_TTS_SAMPLE_RATE, wav_file.getframerate())
            self.assertEqual(480, metadata["frame_count"])
            self.assertEqual(20, metadata["duration_ms"])
            saved_audio = output.read_bytes()
            self.assertEqual(
                len(saved_audio) - 8,
                int.from_bytes(saved_audio[4:8], "little"),
            )

    def test_auto_mix_phrase_rejects_unknown_large_wav_placeholders(self):
        client = DashScopeMediaClient(api_key="sk-test", origin="https://api.test")
        unknown_audio = auto_mix_unknown_placeholder_wav_bytes()

        with self.assertRaises(ContentEngineError) as raised:
            client._normalize_auto_mix_wav(unknown_audio)

        self.assertEqual("auto_mix_voice_invalid", raised.exception.code)

    def test_auto_mix_phrase_rejects_unapproved_model_and_long_instruction(self):
        client = DashScopeMediaClient(api_key="sk-test", origin="https://api.test")
        client._request_json = mock.Mock()
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-tts-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        private_voice_id = "never-expose-this-voice"
        invalid_personas = [
            {
                "provider_model": "cosyvoice-v3.5-flash",
                "provider_voice_id": private_voice_id,
            },
            {
                "provider_model": AUTO_MIX_TTS_MODEL,
                "provider_voice_id": private_voice_id,
                "instruction": "中" * 51,
            },
        ]

        for index, persona in enumerate(invalid_personas):
            with self.subTest(index=index):
                with self.assertRaises(ContentEngineError) as raised:
                    client.synthesize_auto_mix_phrase(
                        "单个短语", root / f"invalid-{index}.wav", persona
                    )
                self.assertEqual("auto_mix_voice_persona_invalid", raised.exception.code)
                self.assertNotIn(private_voice_id, raised.exception.message)

        client._request_json.assert_not_called()

    def test_auto_mix_phrase_invalid_provider_response_fails_closed(self):
        client = DashScopeMediaClient(api_key="sk-test", origin="https://api.test")
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-tts-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        persona = {
            "provider_model": AUTO_MIX_TTS_MODEL,
            "provider_voice_id": "private-voice",
        }
        invalid_responses = [
            {},
            {"output": {"finish_reason": "stop", "audio": {}}},
            {
                "output": {
                    "finish_reason": "length",
                    "audio": {"url": "https://voice-cdn.test/result.wav"},
                }
            },
        ]

        for index, response in enumerate(invalid_responses):
            client._request_json = mock.Mock(return_value=response)
            output = root / f"invalid-response-{index}.wav"
            with self.subTest(index=index):
                with self.assertRaises(ContentEngineError) as raised:
                    client.synthesize_auto_mix_phrase("单个短语", output, persona)
                self.assertEqual("auto_mix_voice_invalid", raised.exception.code)
                self.assertFalse(output.exists())

    def test_auto_mix_phrase_rejects_empty_or_malformed_wav(self):
        client = DashScopeMediaClient(api_key="sk-test", origin="https://api.test")
        client._request_json = mock.Mock(
            return_value={
                "request_id": "request-invalid-audio",
                "output": {
                    "finish_reason": "stop",
                    "audio": {"url": "https://voice-cdn.test/result.wav"},
                },
            }
        )
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-tts-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        persona = {
            "provider_model": AUTO_MIX_TTS_MODEL,
            "provider_voice_id": "private-voice",
        }
        valid_audio = auto_mix_wav_bytes()
        invalid_audio = [
            b"",
            b"RIFF" + (b"\x00" * 48),
            auto_mix_wav_bytes(frames=0),
            valid_audio[:-2],
        ]

        for index, audio in enumerate(invalid_audio):
            output = root / f"invalid-audio-{index}.wav"
            with self.subTest(index=index):
                with mock.patch(
                    "content_engine.creative_analysis.public_https_get",
                    return_value=(200, audio),
                ):
                    with self.assertRaises(ContentEngineError) as raised:
                        client.synthesize_auto_mix_phrase("单个短语", output, persona)
                self.assertEqual("auto_mix_voice_invalid", raised.exception.code)
                self.assertFalse(output.exists())

    def test_auto_mix_phrase_submit_timeout_is_outcome_unknown_without_retry(self):
        client = DashScopeMediaClient(
            api_key="sk-private-auto-mix-key",
            origin="https://api.test",
            timeout_seconds=9,
        )
        root = SIDECAR_ROOT / f".xiaoxi-auto-mix-tts-{uuid.uuid4().hex}"
        root.mkdir()
        self.addCleanup(shutil.rmtree, root, True)
        private_voice_id = "never-expose-this-voice"
        with mock.patch(
            "content_engine.creative_analysis.provider_urlopen",
            side_effect=socket.timeout("transport detail"),
        ) as opened:
            with self.assertRaises(ContentEngineError) as raised:
                client.synthesize_auto_mix_phrase(
                    "单个短语",
                    root / "unknown.wav",
                    {
                        "provider_model": AUTO_MIX_TTS_MODEL,
                        "provider_voice_id": private_voice_id,
                    },
                )

        self.assertEqual(1, opened.call_count)
        self.assertEqual("auto_mix_voice_outcome_unknown", raised.exception.code)
        self.assertNotIn("sk-private-auto-mix-key", raised.exception.message)
        self.assertNotIn(private_voice_id, raised.exception.message)

    def test_product_voice_uses_native_bailian_contract_and_persists_audio(self):
        client = DashScopeMediaClient(
            api_key="sk-test-key", origin="https://api.test"
        )
        audio = b"RIFF" + (b"\x00" * 48)
        client._request_json = mock.Mock(
            return_value={
                "output": {"audio": {"data": base64.b64encode(audio).decode("ascii")}}
            }
        )

        with provider_test_directory("xiaoxi-product-voice-") as root:
            output = Path(root) / "voice.wav"
            metadata = client.synthesize_product_voice("  \u81ea\u52a8   \u5b8c\u6210\u6e05\u626b  ", output)

            self.assertEqual(audio, output.read_bytes())
            self.assertEqual("bailian", metadata["provider"])
            self.assertEqual(client.tts_model, metadata["model"])
            self.assertEqual(client.tts_voice, metadata["voice"])

        request_url = client._request_json.call_args.args[0]
        request_options = client._request_json.call_args.kwargs
        self.assertEqual(
            "https://api.test/api/v1/services/aigc/multimodal-generation/generation",
            request_url,
        )
        self.assertEqual("POST", request_options["method"])
        self.assertEqual(client.tts_model, request_options["payload"]["model"])
        self.assertEqual("\u81ea\u52a8 \u5b8c\u6210\u6e05\u626b", request_options["payload"]["input"]["text"])
        self.assertEqual(client.tts_voice, request_options["payload"]["input"]["voice"])
        self.assertEqual("Chinese", request_options["payload"]["input"]["language_type"])
        self.assertGreaterEqual(request_options["timeout"], 120)
        self.assertEqual("\u4e2d\u6587\u914d\u97f3", request_options["operation_label"])

    def test_product_voice_http_failure_is_actionable_and_hides_key(self):
        client = DashScopeMediaClient(
            api_key="sk-private-voice-key", origin="https://api.test"
        )
        error = urllib.error.HTTPError(
            "https://api.test/api/v1/services/aigc/multimodal-generation/generation",
            403,
            "forbidden",
            Message(),
            None,
        )
        with provider_test_directory("xiaoxi-product-voice-") as root:
            with mock.patch(
                "content_engine.creative_analysis.provider_urlopen", side_effect=error
            ):
                with self.assertRaises(ContentEngineError) as raised:
                    client.synthesize_product_voice(
                        "\u81ea\u52a8\u5b8c\u6210\u6e05\u626b", Path(root) / "voice.wav"
                    )

        self.assertEqual("cloud_request_failed", raised.exception.code)
        self.assertIn("HTTP 403", raised.exception.message)
        self.assertNotIn("sk-private-voice-key", raised.exception.message)

    def test_product_voice_downloads_bounded_public_audio_url_and_persists_it(self):
        client = DashScopeMediaClient(
            api_key="sk-private-voice-key", origin="https://api.test"
        )
        audio = b"RIFF" + (b"\x00" * 48)
        audio_url = "https://voice-cdn.test/result.wav"
        client._request_json = mock.Mock(
            return_value={"output": {"audio": {"url": audio_url}}}
        )

        with provider_test_directory("xiaoxi-product-voice-") as root:
            output = Path(root) / "voice.wav"
            with mock.patch(
                "content_engine.creative_analysis.public_https_get",
                return_value=(200, audio),
            ) as download:
                metadata = client.synthesize_product_voice(
                    "\u81ea\u52a8\u5b8c\u6210\u6e05\u626b", output
                )

            self.assertEqual(audio, output.read_bytes())
            self.assertEqual("bailian", metadata["provider"])

        download.assert_called_once()
        self.assertEqual(audio_url, download.call_args.args[0])
        self.assertGreaterEqual(download.call_args.kwargs["timeout"], 120)
        self.assertGreater(download.call_args.kwargs["max_bytes"], len(audio))
        self.assertNotIn(
            "Authorization", download.call_args.kwargs.get("headers") or {}
        )
        self.assertNotIn(
            "sk-private-voice-key", repr(download.call_args.kwargs)
        )

    def test_product_voice_upgrades_official_http_oss_url_before_download(self):
        client = DashScopeMediaClient(
            api_key="sk-private-voice-key", origin="https://api.test"
        )
        audio = b"RIFF" + (b"\x00" * 48)
        audio_url = (
            "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/"
            "voice/result.wav?Expires=123&Signature=redacted"
        )
        client._request_json = mock.Mock(
            return_value={"output": {"audio": {"url": audio_url}}}
        )

        with provider_test_directory("xiaoxi-product-voice-") as root:
            output = Path(root) / "voice.wav"
            with mock.patch(
                "content_engine.creative_analysis.public_https_get",
                return_value=(200, audio),
            ) as download:
                client.synthesize_product_voice("自动完成清扫", output)

        self.assertEqual(
            audio_url.replace("http://", "https://", 1),
            download.call_args.args[0],
        )

    def test_product_voice_keeps_untrusted_http_url_blocked(self):
        client = DashScopeMediaClient(
            api_key="sk-private-voice-key", origin="https://api.test"
        )
        client._request_json = mock.Mock(
            return_value={
                "output": {"audio": {"url": "http://untrusted.example/voice.wav"}}
            }
        )

        with provider_test_directory("xiaoxi-product-voice-") as root:
            with self.assertRaises(ContentEngineError) as raised:
                client.synthesize_product_voice("自动完成清扫", Path(root) / "voice.wav")

        self.assertEqual("product_voice_download_failed", raised.exception.code)

    def test_default_cloud_timeout_is_extended_but_bounded(self):
        client = DashScopeMediaClient(api_key="sk-test-key")
        self.assertEqual(90, client.timeout_seconds)
        bounded = DashScopeMediaClient(api_key="sk-test-key", timeout_seconds=999)
        self.assertEqual(300, bounded.timeout_seconds)

    def test_timeout_retry_is_limited_to_two_attempts_and_labels_operation(self):
        client = DashScopeMediaClient(api_key="sk-test-key", timeout_seconds=9)
        with mock.patch(
            "content_engine.creative_analysis.provider_urlopen",
            side_effect=[socket.timeout("first"), socket.timeout("second")],
        ) as opened:
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json(
                    "https://dashscope.test/api/v1",
                    operation_label="画面理解",
                    retry_on_timeout=True,
                )

        self.assertEqual(2, opened.call_count)
        self.assertIn("画面理解请求超时", raised.exception.message)
        self.assertIn("9 秒", raised.exception.message)

    def test_http_failure_keeps_safe_status_for_diagnostics(self):
        client = DashScopeMediaClient(api_key="sk-test-key")
        error = urllib.error.HTTPError(
            "https://dashscope.test/api/v1",
            401,
            "unauthorized",
            Message(),
            None,
        )
        with mock.patch(
            "content_engine.creative_analysis.provider_urlopen", side_effect=error
        ):
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json("https://dashscope.test/api/v1")

        self.assertEqual("cloud_request_failed", raised.exception.code)
        self.assertIn("HTTP 401", raised.exception.message)
        self.assertNotIn("sk-test-key", raised.exception.message)

    def test_timeout_failure_is_distinguishable_without_exposing_key(self):
        client = DashScopeMediaClient(api_key="sk-test-key", timeout_seconds=9)
        with mock.patch(
            "content_engine.creative_analysis.provider_urlopen",
            side_effect=socket.timeout("timed out"),
        ):
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json("https://dashscope.test/api/v1")

        self.assertEqual("cloud_request_failed", raised.exception.code)
        self.assertIn("超时", raised.exception.message)
        self.assertIn("9 秒", raised.exception.message)
        self.assertNotIn("sk-test-key", raised.exception.message)

    def test_dashscope_json_response_is_bounded(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = lambda size: b"x" * size
        client = DashScopeMediaClient(
            api_key="sk-test-key", origin="https://api.test"
        )

        with mock.patch("urllib.request.urlopen", return_value=response):
            with self.assertRaises(ContentEngineError) as raised:
                client._request_json("https://api.test/v1/status")

        self.assertEqual("cloud_response_too_large", raised.exception.code)
        response.read.assert_called_once_with(MAX_PROVIDER_JSON_BYTES + 1)

    def test_transcription_oversize_has_specific_failure(self):
        client = DashScopeMediaClient(api_key="sk-test-key")
        client._temporary_upload = lambda _source, _model: "oss://fixture/audio.wav"
        responses = iter(
            (
                {"output": {"task_id": "task-one"}},
                {
                    "output": {
                        "task_status": "SUCCEEDED",
                        "results": [
                            {
                                "subtask_status": "SUCCEEDED",
                                "transcription_url": "https://8.8.8.8/transcript.json",
                            }
                        ],
                    }
                },
            )
        )
        client._request_json = lambda *_args, **_kwargs: next(responses)

        with mock.patch(
            "content_engine.creative_analysis.public_https_get",
            side_effect=ProviderResponseTooLarge("too large"),
        ):
            with self.assertRaises(ContentEngineError) as raised:
                client.transcribe(Path("fixture.wav"), lambda: False)

        self.assertEqual("cloud_transcription_too_large", raised.exception.code)

    def test_provider_error_details_scrub_keys_and_tokens(self):
        client = APIMartCoverClient(
            api_key="sk-live-secret-value",
            base_url="https://api.test/v1",
            request_fn=lambda *_args, **_kwargs: (200, b"{}"),
        )
        detail = client._safe_detail(
            {
                "error": {
                    "message": (
                        "Authorization: Bearer sk-live-secret-value; "
                        "access_token=token-value-123"
                    )
                }
            }
        )

        self.assertNotIn("sk-live-secret-value", detail)
        self.assertNotIn("token-value-123", detail)
        self.assertIn("[redacted secret]", detail)

    def test_reference_image_magic_must_match_extension_in_production(self):
        client = APIMartCoverClient(
            api_key="secret-key", base_url="https://api.apimart.ai/v1"
        )
        client._request = lambda *_args, **_kwargs: (
            200,
            json.dumps({"url": "https://cdn.example/reference.png"}).encode(),
        )
        with provider_test_directory("xiaoxi-provider-security-") as root:
            invalid = Path(root) / "invalid.png"
            invalid.write_bytes(b"not-an-image")
            with self.assertRaises(APIMartError):
                client._upload_reference(invalid)

            valid = Path(root) / "valid.png"
            valid.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fixture")
            self.assertEqual(
                "https://cdn.example/reference.png",
                client._upload_reference(valid),
            )


if __name__ == "__main__":
    unittest.main()
