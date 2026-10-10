import base64
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import wave

from content_engine.creative_analysis import DashScopeMediaClient, FFmpegCreativeAnalyzer
from content_engine.errors import ContentEngineError
from content_engine.volcengine_media import VolcengineMediaClient


class DigitalHumanAudioUploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="avatar-upload-check-")
        self.addCleanup(self.directory.cleanup)
        self.cloud = DashScopeMediaClient(api_key="fixture-only")
        self.analyzer = FFmpegCreativeAnalyzer(Path(self.directory.name), cloud_client=self.cloud)
        output = io.BytesIO()
        with wave.open(output, "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(16000)
            sound.writeframes(b"\0\0" * 16000 * 3)
        self.raw = output.getvalue()
        self.payload = {"audio_base64": base64.b64encode(self.raw).decode(),
                        "sha256": hashlib.sha256(self.raw).hexdigest()}

    def test_refresh_uploads_exact_frozen_bytes_and_never_calls_tts(self):
        captured = []

        def upload(source, model):
            captured.append(source)
            self.assertEqual(source.read_bytes(), self.raw)
            self.assertEqual(model, "wan2.6-i2v-flash")
            return "oss://dashscope-instant/fixture/voice.wav"

        with mock.patch.object(self.cloud, "_temporary_upload", side_effect=upload), \
                mock.patch.object(self.cloud, "_request_json", side_effect=AssertionError("No synthesis call allowed")):
            result = self.analyzer.upload_digital_human_audio(self.payload)
        self.assertEqual(result["sha256"], self.payload["sha256"])
        self.assertTrue(result["url"].startswith("oss://"))
        self.assertIn("expiresAt", result)
        self.assertFalse(captured[0].exists(), "Temporary upload copies are cleaned without touching the original voice")

    def test_changed_or_non_audio_input_stops_before_upload(self):
        with mock.patch.object(self.cloud, "_temporary_upload") as upload:
            with self.assertRaises(ContentEngineError):
                self.analyzer.upload_digital_human_audio({**self.payload, "sha256": "0" * 64})
            raw = b"not an audio file"
            with self.assertRaises(ContentEngineError):
                self.analyzer.upload_digital_human_audio({"audio_base64": base64.b64encode(raw).decode(), "sha256": hashlib.sha256(raw).hexdigest()})
            upload.assert_not_called()

    def test_volcengine_editor_does_not_receive_wan_upload(self):
        self.analyzer.cloud_client = VolcengineMediaClient()
        with mock.patch('content_engine.creative_analysis.DashScopeMediaClient', wraps=DashScopeMediaClient) as adapter, \
                mock.patch.dict('os.environ', {'DASHSCOPE_API_KEY': 'fixture-only'}), \
                mock.patch.object(DashScopeMediaClient, '_temporary_upload', return_value='oss://fixture/voice.wav') as upload, \
                mock.patch.object(self.analyzer.cloud_client, '_request_json', side_effect=AssertionError('Wrong provider')):
            result = self.analyzer.upload_digital_human_audio(self.payload)
        self.assertEqual('oss://fixture/voice.wav', result['url'])
        adapter.assert_called_once_with()
        upload.assert_called_once()


if __name__ == "__main__":
    unittest.main()
