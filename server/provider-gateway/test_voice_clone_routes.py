"""Existing-slot ownership, overwrite prevention and receipt recovery."""
import base64
import io
import json
import threading
import time
import unittest
import urllib.error
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import test_service


class VoiceCloneRoutesTest(unittest.TestCase):
    session = test_service.GatewayTest.session
    post_json = test_service.GatewayTest.post_json

    def setUp(self):
        self.calls = []
        self.status = 0
        self.fail_train = False
        self.config = test_service.GatewayConfig(
            keys={"volcengine_tts": "server-secret"}, session_secret="clone-test",
            voice_clone_slots={"first": [{"speaker_id": "S_owned", "billing": "prepaid"}]},
            license_validator=lambda _code: {"license_id": "first", "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()},
        )
        def upstream(request, timeout):
            self.calls.append(request)
            if request.full_url.endswith("/get_voice"):
                return test_service.FakeResponse(body=json.dumps({"speaker_id": "S_owned", "status": self.status}).encode())
            if request.full_url.endswith("/voice_clone"):
                if self.fail_train:
                    raise TimeoutError()
                self.status = 2
                return test_service.FakeResponse(body=b'{"speaker_id":"S_owned","status":2}')
            return test_service.FakeResponse(body=b'data: {"code":0,"data":"YXVkaW8="}\n\ndata: {"code":20000000}\n\n')
        self.config.upstream_open = upstream
        self.server = test_service.GatewayServer(("127.0.0.1", 0), test_service.Handler, self.config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.headers = {"Authorization": "Bearer " + self.session(), "X-Xiaoxi-Operation-Id": "clone-1"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, action, payload, headers=None):
        return self.post_json("/v1/provider-gateway/volcengine/voice-clone/" + action, payload, headers or self.headers)

    @staticmethod
    def sample():
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"\x01\x00" * 24000 * 14)
        return {"speaker_id": "S_owned", "audio": {"data": base64.b64encode(output.getvalue()).decode(), "format": "wav"}, "consent": True}

    def test_owned_prepaid_training_replay_and_no_overwrite(self):
        with self.call("list", {}) as response:
            self.assertTrue(json.load(response)["items"][0]["trainable"])
        payload = self.sample()
        for _ in range(2):
            with self.call("train", payload) as response:
                self.assertEqual(json.load(response)["status"], 2)
        self.assertEqual(sum(request.full_url.endswith("/voice_clone") for request in self.calls), 1)
        self.assertEqual(self.calls[-1].get_header("X-api-key"), "server-secret")
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.call("train", payload, {**self.headers, "X-Xiaoxi-Operation-Id": "new-training"})
        self.assertEqual(rejected.exception.code, 409)
        with self.call("synthesize", {"speaker_id": "S_owned", "text": "产品介绍。"}, {**self.headers, "X-Xiaoxi-Operation-Id": "voice-audio"}) as response:
            self.assertIn(b"20000000", response.read())
        self.assertEqual(self.calls[-1].get_header("X-api-resource-id"), "seed-icl-2.0")

    def test_other_customer_cannot_list_train_or_synthesize_slot(self):
        self.config.license_validator = lambda _code: {"license_id": "other", "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        headers = {**self.headers, "Authorization": "Bearer " + self.session()}
        with self.call("list", {}, headers) as response:
            result = json.load(response)
            self.assertEqual(result["items"], [])
            self.assertFalse(result["inventory_configured"])
        for action, payload in (("train", self.sample()), ("status", {"speaker_id": "S_owned"}), ("synthesize", {"speaker_id": "S_owned", "text": "介绍"})):
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                self.call(action, payload, headers)
            self.assertEqual(rejected.exception.code, 403)
        self.assertEqual(self.calls, [])

    def test_unknown_training_keeps_slot_claim_and_never_reposts(self):
        self.fail_train = True
        for operation in ("unknown-1", "unknown-1", "unknown-2"):
            with self.assertRaises(urllib.error.HTTPError):
                self.call("train", self.sample(), {**self.headers, "X-Xiaoxi-Operation-Id": operation})
        self.assertEqual(sum(request.full_url.endswith("/voice_clone") for request in self.calls), 1)
        with self.call("list", {}) as response:
            self.assertFalse(json.load(response)["items"][0]["trainable"])
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.post_json("/v1/provider-gateway/volcengine/tts/sse", {"req_params": {"speaker": "S_owned"}}, self.headers)
        self.assertEqual(rejected.exception.code, 403)

    def test_concurrent_operation_cannot_purchase_two_different_scripts(self):
        self.status = 2
        lookup = self.server.receipts.lookup
        def slow_lookup(*args):
            result = lookup(*args)
            time.sleep(.1)
            return result
        self.server.receipts.lookup = slow_lookup
        start = threading.Barrier(2)
        def submit(text):
            start.wait()
            try:
                with self.call('synthesize', {'speaker_id': 'S_owned', 'text': text}) as response:
                    response.read()
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(submit, ['第一份文案', '另一份文案']))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(sum(request.full_url.endswith('/sse') for request in self.calls), 1)


if __name__ == "__main__":
    unittest.main()
