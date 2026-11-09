import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import service as maintenance
from service import Handler, Server, Store

GATEWAY_DIR = Path(__file__).resolve().parents[1] / "provider-gateway"
TOKEN = "accounts-admin-fixture-0123456789"


def load_gateway():
    sys.path.insert(0, str(GATEWAY_DIR))
    spec = importlib.util.spec_from_file_location("gateway_service_for_admin_test", GATEWAY_DIR / "service.py")
    if spec.name in sys.modules:
        return sys.modules[spec.name]
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class AccountsAdminTest(unittest.TestCase):
    def setUp(self):
        gateway = load_gateway()
        self.temp = tempfile.TemporaryDirectory()
        config = gateway.GatewayConfig(keys={})
        config.receipt_db_path = str(Path(self.temp.name) / "receipts.sqlite3")
        config.accounts_admin_token = TOKEN
        self.gateway = gateway.GatewayServer(("127.0.0.1", 0), gateway.Handler, config)
        self.admin = Server(("127.0.0.1", 0), Handler, Store(str(Path(self.temp.name) / "maintenance")), admin=True)
        for server in (self.gateway, self.admin):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.gateway_origin = f"http://127.0.0.1:{self.gateway.server_address[1]}"
        self.admin_origin = f"http://127.0.0.1:{self.admin.server_port}"
        self.patches = [patch.object(maintenance, "PROVIDER_GATEWAY_ORIGIN", self.gateway_origin),
                        patch.dict(os.environ, {"XIAOXI_GATEWAY_ACCOUNTS_ADMIN_TOKEN": TOKEN})]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        for server in (self.gateway, self.admin):
            server.shutdown()
            server.server_close()
        self.gateway.receipts.close()
        self.temp.cleanup()

    def call(self, base, route, body=None, origin=True, headers=None):
        request = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Content-Type": "application/json", **({"Origin": base} if origin else {}), **(headers or {})},
                                         method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def login(self, phone, password):
        return self.call(self.gateway_origin, "/v1/provider-gateway/session", {
            "phone": phone, "password": password, "appId": "com.aihuoke.desktop.test", "channel": "test",
            "version": "1.2.15", "installId": "33333333-3333-3333-3333-333333333333"}, origin=False)

    def test_admin_page_manages_customer_accounts_through_the_gateway(self):
        self.assertEqual(403, self.call(self.admin_origin, "/api/accounts", {"phone": "13800000001", "password": "start2026"}, origin=False)[0],
                         "cross-origin posts are refused")
        status, created = self.call(self.admin_origin, "/api/accounts", {"phone": "13800000001", "password": "start2026", "displayName": "张总"})
        self.assertEqual(200, status, created)
        status, listed = self.call(self.admin_origin, "/api/accounts")
        self.assertEqual(["13800000001"], [item["phone"] for item in listed["accounts"]])
        self.assertEqual(200, self.login("13800000001", "start2026")[0])
        account_id = listed["accounts"][0]["id"]
        self.assertEqual(200, self.call(self.admin_origin, f"/api/accounts/{account_id}/reset-password", {"password": "fresh2026"})[0])
        self.assertEqual(401, self.login("13800000001", "start2026")[0])
        self.assertEqual(200, self.login("13800000001", "fresh2026")[0])
        self.assertEqual(200, self.call(self.admin_origin, f"/api/accounts/{account_id}/status", {"status": "disabled"})[0])
        self.assertEqual(403, self.login("13800000001", "fresh2026")[0])
        # Compute credit: the grant shows in the list; recharge, the no-block switch and the detail go through.
        self.assertEqual(20_000_000, listed["accounts"][0]["usage"]["billing"]["balance"])
        status, recharged = self.call(self.admin_origin, f"/api/accounts/{account_id}/recharge", {"amountCny": 500, "note": "转账"})
        self.assertEqual((200, 40_000_000), (status, recharged.get("balance")), recharged)
        self.assertEqual(200, self.call(self.admin_origin, f"/api/accounts/{account_id}/billing-access", {"unblocked": True})[0])
        status, detail = self.call(self.admin_origin, f"/api/accounts/{account_id}/billing")
        self.assertEqual(200, status, detail)
        self.assertTrue(detail["unblocked"])
        self.assertEqual(["recharge", "grant"], [row["kind"] for row in detail["ledger"]])

    def test_the_public_proxy_carries_the_administrator_ticket(self):
        public = Server(("127.0.0.1", 0), Handler, Store(str(Path(self.temp.name) / "public")))
        threading.Thread(target=public.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{public.server_port}"
            created = self.call(self.admin_origin, "/api/accounts", {"phone": "13800000007", "password": "start2026"})[1]
            self.assertEqual(200, self.call(self.admin_origin, f"/api/accounts/{created['id']}/admin", {"enabled": True})[0])
            token = self.login("13800000007", "start2026")[1]["token"]
            auth = {"Authorization": f"Bearer {token}"}
            status, granted = self.call(base, "/v1/provider-gateway/account/admin/ticket", {"password": "start2026"}, origin=False, headers=auth)
            self.assertEqual(200, status, granted)
            status, listed = self.call(base, "/v1/provider-gateway/account/admin/accounts", origin=False,
                                       headers={**auth, "X-Xiaoxi-Admin-Ticket": granted["ticket"]})
            self.assertEqual(200, status, listed)
        finally:
            public.shutdown()
            public.server_close()

    def test_callers_cannot_state_their_own_address_through_the_proxy(self):
        public = Server(("127.0.0.1", 0), Handler, Store(str(Path(self.temp.name) / "public-address")))
        threading.Thread(target=public.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{public.server_port}"
            body = {"password": "wrong1234", "appId": "com.aihuoke.desktop.test", "channel": "test", "version": "1.2.15", "installId": "33333333-3333-3333-3333-333333333333"}
            replies = [self.call(base, "/v1/provider-gateway/session", {**body, "phone": f"1390000{index:04d}"}, origin=False,
                                 headers={"X-Xiaoxi-Client-Ip": f"203.0.113.{index}"}) for index in range(31)]
            self.assertEqual((429, "login_throttled"), (replies[-1][0], replies[-1][1].get("error")), replies[-1])
        finally:
            public.shutdown()
            public.server_close()

    def test_gateway_admin_routes_need_the_token(self):
        self.assertEqual(404, self.call(self.gateway_origin, "/v1/accounts-admin/accounts", origin=False)[0])
        self.assertEqual(404, self.call(self.gateway_origin, "/v1/accounts-admin/accounts", origin=False,
                                        headers={"X-Xiaoxi-Accounts-Admin": "guess"})[0])
        with patch.dict(os.environ, {"XIAOXI_GATEWAY_ACCOUNTS_ADMIN_TOKEN": ""}):
            self.assertEqual(503, self.call(self.admin_origin, "/api/accounts")[0])


if __name__ == "__main__":
    unittest.main()
