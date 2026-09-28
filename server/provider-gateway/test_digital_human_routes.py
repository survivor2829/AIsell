"""Offline gateway regression: new fixed routes and existing receipt mechanism."""
import json
import unittest
import urllib.error
import urllib.request
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
import test_service


class DigitalHumanRoutesTest(unittest.TestCase):
    session = test_service.GatewayTest.session
    post_json = test_service.GatewayTest.post_json

    def setUp(self):
        # This route check needs no files; an in-memory receipt store also avoids
        # platform-specific tempfile ACLs while exercising the actual HTTP server.
        self.upstream_requests = []
        self.config = test_service.GatewayConfig.from_environment({
            "XIAOXI_GATEWAY_APIMART_API_KEY": "apimart-server-secret",
            "XIAOXI_GATEWAY_SESSION_SECRET": "digital-human-test-secret",
        })
        self.config.license_validator = lambda _code: {
            "license_id": "first-customer",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }
        def upstream(operation, timeout):
            self.upstream_requests.append((operation, timeout))
            return test_service.FakeResponse()
        self.config.upstream_open = upstream
        self.server = test_service.GatewayServer(("127.0.0.1", 0), test_service.Handler, self.config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_digital_human_routes(self):
        token = self.session()
        headers = {"Authorization": f"Bearer {token}"}
        registered_names = []
        registered_groups = []
        task_group = "dh_1234567890abcdef12345678"
        original_upstream = self.config.upstream_open

        def upstream(request, timeout):
            parsed = urlsplit(request.full_url)
            if parsed.path.endswith("/private-avatar/groups"):
                self.upstream_requests.append((request, timeout))
                name = parse_qs(parsed.query).get("name", [""])[0]
                rows = [{"Name": group, "Id": "fixture_group"} for group in registered_groups if group == name]
                rows.append({"Name": "other_customer", "Id": "private_other_group"})
                return test_service.FakeResponse(body=json.dumps({"Result": {"Items": rows}}).encode())
            if parsed.path.endswith("/private-avatar/assets"):
                self.upstream_requests.append((request, timeout))
                if request.method == "POST":
                    registered_names.extend(item["name"] for item in json.loads(request.data)["assets"])
                    registered_groups.append(json.loads(request.data)["group"]["name"])
                    return test_service.FakeResponse(body=b'{"data":{"id":"review_fixture"}}')
                rows = [{"Name": name, "Id": "fixture", "Status": "Active"} for name in registered_names] if parse_qs(parsed.query).get("group_id") in (None, ["fixture_group"]) else []
                rows.append({"Name": "other_customer", "Id": "private_other", "Status": "Active"})
                return test_service.FakeResponse(body=json.dumps({"ResponseMetadata": {}, "Result": {"Items": rows, "TotalCount": len(rows), "PageNumber": 1, "PageSize": 20}}).encode())
            return original_upstream(request, timeout)

        self.config.upstream_open = upstream
        self.assertTrue(self.config.capabilities()["apimart_video"])
        self.assertTrue(self.config.capabilities()["apimart_avatar_assets"])
        for suffix, payload in (
            ("videos/generations", {"model": "seedance-2.5", "duration": 12}),
            ("seedance2/private-avatar/assets", {"model": "seedance-2.5", "group": {"name": task_group}, "asset_type": "Image", "assets": [{"name": "my_avatar", "url": "https://cdn.example.com/avatar.png"}]}),
        ):
            route = "/v1/provider-gateway/apimart/" + suffix
            with self.post_json(route, payload, headers) as response:
                self.assertEqual(response.status, 200)
            request, _ = self.upstream_requests[-1]
            self.assertEqual(request.full_url, "https://api.apimart.ai/v1/" + suffix)
            self.assertEqual(request.get_header("Authorization"), "Bearer apimart-server-secret")
        request = urllib.request.Request(self.origin + "/v1/provider-gateway/apimart/seedance2/private-avatar/assets?group=" + task_group, headers=headers)
        with urllib.request.urlopen(request) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response)["data"]["items"], [{"name": "my_avatar", "id": "fixture", "status": "Active"}])
        group_request, asset_request = [item[0] for item in self.upstream_requests[-2:]]
        self.assertIn("/private-avatar/groups?name=xh_", group_request.full_url)
        self.assertEqual(parse_qs(urlsplit(asset_request.full_url).query), {"group_id": ["fixture_group"]})
        self.config.license_validator = lambda _code: {
            "license_id": "second-customer",
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        }
        other_token = self.session()
        request = urllib.request.Request(self.origin + "/v1/provider-gateway/apimart/seedance2/private-avatar/assets?group=" + task_group, headers={"Authorization": f"Bearer {other_token}"})
        with urllib.request.urlopen(request) as response:
            self.assertEqual(json.load(response)["data"]["items"], [])
        calls = len(self.upstream_requests)
        for suffix, expected in (("videos/generations", 405), ("videos/generations?url=https://example.com", 400), ("seedance2/private-avatar/groups", 404), ("seedance2/private-avatar/assets?group=other_customer", 400)):
            request = urllib.request.Request(self.origin + "/v1/provider-gateway/apimart/" + suffix, headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(request)
            self.assertEqual(rejected.exception.code, expected)
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.post_json("/v1/provider-gateway/apimart/seedance2/private-avatar/assets", {
                "model": "seedance-2.5", "group": {"name": "my_group"}, "asset_type": "Image",
                "assets": [{"name": "my_avatar", "url": {"unexpected": "object"}}],
            }, headers)
        self.assertEqual(rejected.exception.code, 400)
        self.assertEqual(json.load(rejected.exception)["error"], "invalid_avatar_submission")
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            self.post_json("/v1/provider-gateway/apimart/seedance2/private-avatar/assets", {
                "model": "seedance-2.5", "group": {"name": task_group}, "asset_type": "Image",
                "assets": [{"name": task_group + "_overlongx", "url": "https://cdn.example.com/avatar.png"}],
            }, headers)
        self.assertEqual(rejected.exception.code, 400)
        self.assertEqual(json.load(rejected.exception)["error"], "invalid_avatar_submission")
        self.assertEqual(len(self.upstream_requests), calls)


if __name__ == "__main__":
    suite = unittest.TestSuite([DigitalHumanRoutesTest("test_digital_human_routes")])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)
