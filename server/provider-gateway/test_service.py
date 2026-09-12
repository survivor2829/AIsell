import base64
import json
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from service import GatewayConfig, GatewayServer, Handler


class FakeResponse:
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status = status
        self.code = status
        self.headers = headers or {"Content-Type": "application/json"}
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self._body


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.upstream_requests = []
        self.config = GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_DEEPSEEK_API_KEY": "deepseek-server-secret",
            "XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY": "ark-server-secret",
            "XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY": "tts-server-secret",
            "XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY": "asr-server-secret",
            "XIAOXI_GATEWAY_APIMART_API_KEY": "apimart-server-secret",
        })
        self.config.license_validator = lambda _code: {
            "license_id": "license-test-001",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }

        def upstream_open(operation, timeout):
            self.upstream_requests.append((operation, timeout))
            return FakeResponse(
                body=json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()
            )

        self.config.upstream_open = upstream_open
        self.server = GatewayServer(("127.0.0.1", 0), Handler, self.config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def post_json(self, route, body, headers=None):
        request = urllib.request.Request(
            self.origin + route,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        return urllib.request.urlopen(request)

    def session(self):
        with self.post_json("/v1/provider-gateway/session", {
            "licenseCode": "signed-license-fixture",
            "appId": "com.aihuoke.desktop.test",
            "channel": "test",
            "version": "1.1.19",
            "buildId": "build-test",
            "installId": "12345678-1234-1234-1234-123456789012",
        }) as response:
            payload = json.load(response)
        self.assertTrue(payload["ok"])
        self.assertNotIn("deepseek-server-secret", json.dumps(payload))
        return payload["token"]

    def test_session_and_capabilities_are_authenticated_and_redacted(self):
        token = self.session()
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/capabilities",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(request) as response:
            payload = json.load(response)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["capabilities"]["deepseek"])
        self.assertTrue(payload["capabilities"]["volcengine_ark"])
        self.assertTrue(payload["capabilities"]["volcengine_asr"])
        self.assertTrue(payload["capabilities"]["apimart"])
        self.assertNotIn("server-secret", json.dumps(payload))

    def test_provider_route_requires_session_and_injects_only_server_credential(self):
        body = {"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "hello"}]}
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/deepseek/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer client-session-is-not-valid",
                "X-Api-Key": "client-provider-secret",
            },
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 401)
        self.assertEqual(self.upstream_requests, [])

        token = self.session()
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/deepseek/v1/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "X-Api-Key": "client-provider-secret",
            },
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response)["choices"][0]["message"]["content"], "ok")
        operation, _timeout = self.upstream_requests[-1]
        self.assertEqual(operation.full_url, "https://api.deepseek.com/v1/chat/completions")
        self.assertEqual(operation.get_header("Authorization"), "Bearer deepseek-server-secret")
        self.assertIsNone(operation.get_header("X-api-key"))
        self.assertEqual(json.loads(operation.data), body)

    def test_fixed_routes_cover_sse_and_multipart_without_open_proxy(self):
        token = self.session()
        for route, method, expected_url, expected_auth in [
            (
                "/v1/provider-gateway/volcengine/tts/sse",
                "POST",
                "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
                "Bearer tts-server-secret",
            ),
            (
                "/v1/provider-gateway/apimart/uploads/images",
                "POST",
                "https://api.apimart.ai/v1/uploads/images",
                "Bearer apimart-server-secret",
            ),
        ]:
            request = urllib.request.Request(
                self.origin + route,
                data=b"multipart-or-sse-fixture",
                headers={
                    "Content-Type": "multipart/form-data; boundary=fixture",
                    "Authorization": f"Bearer {token}",
                },
                method=method,
            )
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 200)
            operation, _timeout = self.upstream_requests[-1]
            self.assertEqual(operation.full_url, expected_url)
            if "tts" in route:
                self.assertEqual(operation.get_header("X-api-key"), "tts-server-secret")
                self.assertIsNone(operation.get_header("Authorization"))
            else:
                self.assertEqual(operation.get_header("Authorization"), expected_auth)

        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/https://evil.example/steal",
            headers={"Authorization": f"Bearer {token}"},
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 404)

    def test_provider_without_server_key_fails_before_upstream(self):
        self.config.keys["deepseek"] = ""
        token = self.session()
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/deepseek/chat/completions",
            data=b"{}",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 503)
        self.assertEqual(self.upstream_requests, [])

    def test_asr_route_uses_dedicated_server_key(self):
        token = self.session()
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/volcengine/asr/recognize/flash",
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "X-Api-Key": "client-provider-secret",
            },
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 200)
        operation, _timeout = self.upstream_requests[-1]
        self.assertEqual(operation.full_url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash")
        self.assertEqual(operation.get_header("X-api-key"), "asr-server-secret")
        self.assertIsNone(operation.get_header("Authorization"))

    def test_generic_volcengine_key_does_not_enable_speech(self):
        config = GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_VOLCENGINE_API_KEY": "volcengine-unified-secret",
        })
        self.assertEqual(config.keys["volcengine_ark"], "volcengine-unified-secret")
        self.assertEqual(config.keys["volcengine_tts"], "")
        self.assertEqual(config.keys["volcengine_asr"], "")
        self.assertTrue(config.capabilities()["volcengine_ark"])
        self.assertFalse(config.capabilities()["volcengine_tts"])
        self.assertFalse(config.capabilities()["volcengine_asr"])

        asr_config = GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_VOLCENGINE_API_KEY": "volcengine-unified-secret",
            "XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY": "asr-api-secret",
        })
        self.assertEqual(asr_config.keys["volcengine_asr"], "asr-api-secret")
        self.assertTrue(asr_config.capabilities()["volcengine_asr"])

    def test_gateway_rate_limit_identifies_scope_and_wait(self):
        minute = int(time.time() / 60)
        self.server.rates["global"] = (minute, 300)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.origin + "/v1/provider-gateway/health")
        self.assertEqual(error.exception.code, 429)
        self.assertEqual(error.exception.headers.get("X-Xiaoxi-Error-Origin"), "gateway_rate_limit")
        self.assertRegex(error.exception.headers.get("Retry-After", ""), r"^[1-9][0-9]?$|^60$")
        payload = json.loads(error.exception.read())
        self.assertEqual(payload["error"], "rate_limit")
        self.assertEqual(payload["scope"], "global")

    def test_health_exposes_runtime_timeout_contract(self):
        with urllib.request.urlopen(self.origin + "/v1/provider-gateway/health") as response:
            payload = json.load(response)
        self.assertTrue(payload["ok"])
        self.assertRegex(payload["runtime_revision"], r"^[0-9a-f]{16}$")
        self.assertEqual(180, payload["upstream_timeout_seconds"])

    def test_ark_timeout_is_traceable_and_uses_multimodal_timeout_contract(self):
        token = self.session()
        observed = []

        def timed_out(_operation, timeout):
            observed.append(timeout)
            raise socket.timeout("provider did not finish before the gateway deadline")

        self.config.upstream_open = timed_out
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/volcengine/ark/chat/completions",
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(504, error.exception.code)
        self.assertEqual("gateway_transport", error.exception.headers.get("X-Xiaoxi-Error-Origin"))
        self.assertEqual({"error": "provider_timeout"}, json.loads(error.exception.read()))
        self.assertEqual([180], observed)

    def test_upstream_rejection_is_marked_without_exposing_body(self):
        token = self.session()
        private = b'{"error":{"message":"private customer text"}}'

        def rejected(_operation, timeout):
            del timeout
            raise urllib.error.HTTPError(
                "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
                429,
                "rate limited",
                {"Retry-After": "3", "X-Api-Status-Code": "45000010"},
                __import__("io").BytesIO(private),
            )

        self.config.upstream_open = rejected
        request = urllib.request.Request(
            self.origin + "/v1/provider-gateway/deepseek/chat/completions",
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "X-Xiaoxi-Operation-Id": "op-upstream-429",
            },
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 429)
        self.assertEqual(error.exception.headers.get("X-Xiaoxi-Error-Origin"), "upstream")
        self.assertEqual(error.exception.headers.get("Retry-After"), "3")
        self.assertEqual(error.exception.headers.get("X-Api-Status-Code"), "45000010")
        self.assertEqual(error.exception.read(), private)

    def test_identical_inflight_post_is_coalesced_only_with_valid_operation_id(self):
        token = self.session()
        started = threading.Event()
        release = threading.Event()
        calls = []

        def upstream(operation, timeout):
            del timeout
            calls.append(operation)
            started.set()
            self.assertTrue(release.wait(2))
            return FakeResponse(body=b'{"choices":[{"message":{"content":"ok"}}]}')

        self.config.upstream_open = upstream
        body = b'{"model":"deepseek-v4-flash","messages":[]}'
        responses = []

        def send():
            request = urllib.request.Request(
                self.origin + "/v1/provider-gateway/deepseek/chat/completions",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {token}",
                    "X-Xiaoxi-Operation-Id": "op-coalesce-1",
                },
                method="POST",
            )
            with urllib.request.urlopen(request) as response:
                responses.append((response.status, response.read()))

        first = threading.Thread(target=send)
        second = threading.Thread(target=send)
        first.start()
        self.assertTrue(started.wait(1))
        second.start()
        time.sleep(0.05)
        release.set()
        first.join(2)
        second.join(2)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(len(calls), 1)
        self.assertEqual(responses, [(200, b'{"choices":[{"message":{"content":"ok"}}]}')] * 2)

    def test_inflight_posts_are_isolated_by_subject_and_semantic_headers(self):
        first_token = self.session()
        second_token, _ = self.config.sessions.issue('another-license', datetime.now(timezone.utc) + timedelta(hours=1))
        barrier = threading.Barrier(3)
        calls, responses, errors = [], [], []
        def upstream(operation, timeout):
            calls.append(operation)
            barrier.wait(timeout=3)
            return FakeResponse(body=b'{"ok":true}')
        self.config.upstream_open = upstream
        def send(token, resource):
            try:
                with self.post_json('/v1/provider-gateway/deepseek/chat/completions',
                    {'model': 'deepseek-v4-flash', 'messages': []},
                    {'Authorization': f'Bearer {token}', 'X-Xiaoxi-Operation-Id': 'same-operation',
                     'X-Api-Resource-Id': resource}) as response:
                    responses.append(response.status)
            except Exception as error:
                errors.append(error)
        workers = [threading.Thread(target=send, args=args) for args in
                   [(first_token, 'one'), (second_token, 'one'), (first_token, 'two')]]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(5)
        self.assertFalse(errors)
        self.assertEqual(responses, [200] * 3)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
