"""Offline checks of the official video transport and existing request receipts."""
import json
import threading
import unittest
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import test_service


class BailianVideoRoutesTest(unittest.TestCase):
    session = test_service.GatewayTest.session
    post_json = test_service.GatewayTest.post_json

    def test_async_headers_and_upload_query_preserve_receipts(self):
        config = test_service.GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_BAILIAN_API_KEY": "fixture-server-only-key",
            "XIAOXI_GATEWAY_DEEPSEEK_API_KEY": "fixture-other-key",
            "XIAOXI_GATEWAY_SESSION_SECRET": "fixture-session-secret",
        })
        config.license_validator = lambda _code: {
            "license_id": "fixture-customer",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }
        requests = []

        def upstream(operation, timeout):
            requests.append(operation)
            return test_service.FakeResponse(body=b'{"output":{"task_id":"wan-fixture","task_status":"PENDING"}}')

        config.upstream_open = upstream
        server = test_service.GatewayServer(("127.0.0.1", 0), test_service.Handler, config)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{server.server_port}"
        try:
            token = self.session()
            headers = {"Authorization": f"Bearer {token}", "X-DashScope-Async": "enable",
                       "X-DashScope-OssResourceResolve": "enable", "X-Xiaoxi-Operation-Id": "wan-one-post"}
            self.assertTrue(config.capabilities()["bailian_video"])
            route = "/v1/provider-gateway/bailian/api/v1/services/aigc/video-generation/video-synthesis"
            payload = {"model": "wan2.6-i2v-flash", "input": {"img_url": "oss://dashscope-instant/fixture.png"}}
            with self.post_json(route, payload, headers) as response:
                original = json.load(response)
            forwarded = dict((key.lower(), value) for key, value in requests[-1].header_items())
            self.assertEqual(forwarded["x-dashscope-async"], "enable")
            self.assertEqual(forwarded["x-dashscope-ossresourceresolve"], "enable")
            self.assertEqual(forwarded["authorization"], "Bearer fixture-server-only-key")
            # Recovery reads the saved POST result; it never sends another paid request.
            receipt = urllib.request.Request(self.origin + "/v1/provider-gateway/operations/wan-one-post", headers=headers)
            with urllib.request.urlopen(receipt) as response:
                self.assertEqual(json.load(response), original)
            self.assertEqual(len(requests), 1)
            upload = urllib.request.Request(self.origin + "/v1/provider-gateway/bailian/api/v1/uploads?action=getPolicy&model=wan2.6-i2v-flash", headers=headers)
            with urllib.request.urlopen(upload) as response:
                self.assertEqual(response.status, 200)
            self.assertEqual(parse_qs(urlsplit(requests[-1].full_url).query), {"action": ["getPolicy"], "model": ["wan2.6-i2v-flash"]})
            with self.post_json("/v1/provider-gateway/deepseek/chat/completions", {"model": "fixture"}, headers) as response:
                self.assertEqual(response.status, 200)
            other_headers = dict((key.lower(), value) for key, value in requests[-1].header_items())
            self.assertNotIn("x-dashscope-async", other_headers)
            self.assertNotIn("x-dashscope-ossresourceresolve", other_headers)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
