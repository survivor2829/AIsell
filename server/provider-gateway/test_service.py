import base64
import json
import threading
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

    def test_one_volcengine_key_enables_all_volcengine_capabilities(self):
        config = GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_VOLCENGINE_API_KEY": "volcengine-unified-secret",
        })
        self.assertEqual(config.keys["volcengine_ark"], "volcengine-unified-secret")
        self.assertEqual(config.keys["volcengine_tts"], "volcengine-unified-secret")
        self.assertEqual(config.keys["volcengine_asr"], "volcengine-unified-secret")
        self.assertTrue(config.capabilities()["volcengine_ark"])
        self.assertTrue(config.capabilities()["volcengine_tts"])
        self.assertTrue(config.capabilities()["volcengine_asr"])


if __name__ == "__main__":
    unittest.main()
