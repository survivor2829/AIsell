import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from service import GatewayConfig, GatewayServer, Handler

INSTALL_A = "11111111-1111-1111-1111-111111111111"
INSTALL_B = "22222222-2222-2222-2222-222222222222"
ADMIN = "admin-token-fixture-0123456789"


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = GatewayConfig(keys={"deepseek": "server-secret"})
        self.config.receipt_db_path = str(Path(self.temp.name) / "receipts.sqlite3")
        self.config.accounts_admin_token = ADMIN
        expiry = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        self.config.license_validator = lambda code: {"license_id": "lic-" + code[-4:], "expires_at": expiry}
        self.server = GatewayServer(("127.0.0.1", 0), Handler, self.config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.receipts.close()
        self.temp.cleanup()

    def call(self, route, body=None, token="", admin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if admin is not None:
            headers["X-Xiaoxi-Accounts-Admin"] = admin
        request = urllib.request.Request(self.origin + route, data=None if body is None else json.dumps(body).encode(),
                                         headers=headers, method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def session(self, install=INSTALL_A, **credentials):
        return self.call("/v1/provider-gateway/session", {"appId": "com.aihuoke.desktop.test", "channel": "test", "version": "1.2.15",
                                                          "installId": install, **credentials})

    def alive(self, token):
        return self.call("/v1/provider-gateway/capabilities", token=token)[0] == 200

    def test_license_converts_once_into_a_phone_account_with_the_same_identity(self):
        status, first = self.session(licenseCode="signed-license-abcd")
        self.assertEqual(200, status, first)
        self.assertTrue(first["account"]["setupRequired"])
        self.assertTrue(first["deviceToken"])
        _, other = self.session(INSTALL_B, licenseCode="signed-license-abcd")
        self.assertTrue(self.alive(first["token"]) and self.alive(other["token"]),
                        "older clients sharing a license are not signed out during the transition")
        subject = self.server.config.sessions.subject(first["token"])
        self.assertEqual("lic-abcd", subject, "the account keeps the license id as its identity")
        self.assertEqual(400, self.call("/v1/provider-gateway/account/setup", {"phone": "13800138000", "password": "short"}, first["token"])[0])
        status, done = self.call("/v1/provider-gateway/account/setup", {"phone": "13800138000", "password": "clean2026"}, first["token"])
        self.assertEqual(200, status, done)
        self.assertFalse(done["account"]["setupRequired"])
        self.assertEqual("account_use_password", self.session(licenseCode="signed-license-abcd")[1]["error"])
        status, login = self.session(phone="13800138000", password="clean2026")
        self.assertEqual(200, status, login)
        self.assertEqual("lic-abcd", self.server.config.sessions.subject(login["token"]))

    def test_admin_created_account_must_change_its_password_first(self):
        self.assertEqual(404, self.call("/v1/accounts-admin/accounts")[0], "no admin token, no admin route")
        self.assertEqual(404, self.call("/v1/accounts-admin/accounts", admin="wrong")[0])
        status, created = self.call("/v1/accounts-admin/accounts", {"phone": "13900139000", "password": "start2026", "displayName": "张总"}, admin=ADMIN)
        self.assertEqual(200, status, created)
        self.assertEqual("phone_taken", self.call("/v1/accounts-admin/accounts", {"phone": "13900139000", "password": "start2026"}, admin=ADMIN)[1]["error"])
        status, login = self.session(phone="13900139000", password="start2026")
        self.assertTrue(login["account"]["mustChangePassword"])
        self.assertEqual("password_wrong", self.call("/v1/provider-gateway/account/password",
                         {"currentPassword": "nope1234", "newPassword": "mine2026x"}, login["token"])[1]["error"])
        status, changed = self.call("/v1/provider-gateway/account/password", {"currentPassword": "start2026", "newPassword": "mine2026x"}, login["token"])
        self.assertEqual(200, status, changed)
        self.assertFalse(changed["account"]["mustChangePassword"])
        listed = self.call("/v1/accounts-admin/accounts", admin=ADMIN)[1]["accounts"]
        self.assertEqual(["13900139000"], [item["phone"] for item in listed])
        self.assertNotIn("password", json.dumps(listed).lower().replace("mustchangepassword", ""))

    def test_one_computer_at_a_time(self):
        self.call("/v1/accounts-admin/accounts", {"phone": "13700137000", "password": "start2026"}, admin=ADMIN)
        _, first = self.session(INSTALL_A, phone="13700137000", password="start2026")
        self.assertTrue(self.alive(first["token"]))
        _, second = self.session(INSTALL_B, phone="13700137000", password="start2026")
        self.assertFalse(self.alive(first["token"]), "the older computer is signed out")
        self.assertTrue(self.alive(second["token"]))
        status, refused = self.session(INSTALL_A, deviceToken=first["deviceToken"])
        self.assertEqual((401, "account_signed_in_elsewhere"), (status, refused["error"]))
        status, again = self.session(INSTALL_B, deviceToken=second["deviceToken"])
        self.assertEqual(200, status, again)
        self.assertEqual(401, self.session(INSTALL_A, deviceToken=second["deviceToken"])[0], "a device token only works on its own computer")

    def test_an_older_client_sharing_the_license_never_signs_the_updated_computer_out(self):
        _, updated = self.session(INSTALL_A, licenseCode="signed-license-abcd")
        status, older = self.call("/v1/provider-gateway/session", {"appId": "com.aihuoke.desktop.test", "channel": "test", "version": "1.2.14",
                                                                   "installId": INSTALL_B, "licenseCode": "signed-license-abcd"})
        self.assertEqual(200, status, older)
        self.assertNotIn("deviceToken", older, "a client without accounts gets a session, not the device binding")
        self.call("/v1/provider-gateway/account/setup", {"phone": "13800138000", "password": "setup2026"}, token=updated["token"])
        status, relaunch = self.session(INSTALL_A, deviceToken=updated["deviceToken"])
        self.assertEqual(200, status, relaunch)
        self.assertEqual("lic-abcd", relaunch["account"]["id"])

    def test_wrong_passwords_are_throttled(self):
        self.call("/v1/accounts-admin/accounts", {"phone": "13600136000", "password": "start2026"}, admin=ADMIN)
        codes = [self.session(phone="13600136000", password="wrong1234")[0] for _ in range(6)]
        self.assertEqual([401] * 5 + [429], codes)
        self.assertEqual(429, self.session(phone="13600136000", password="start2026")[0], "even the right password waits")

    def test_disable_and_reset_take_effect_immediately(self):
        _, created = self.call("/v1/accounts-admin/accounts", {"phone": "13500135000", "password": "start2026"}, admin=ADMIN)
        _, login = self.session(phone="13500135000", password="start2026")
        self.call(f"/v1/accounts-admin/accounts/{created['id']}/status", {"status": "disabled"}, admin=ADMIN)
        self.assertFalse(self.alive(login["token"]))
        self.assertEqual((403, "account_disabled"), tuple(self.session(phone="13500135000", password="start2026")[i] if i == 0 else
                                                          self.session(phone="13500135000", password="start2026")[1]["error"] for i in (0, 1)))
        self.call(f"/v1/accounts-admin/accounts/{created['id']}/status", {"status": "active"}, admin=ADMIN)
        _, login = self.session(phone="13500135000", password="start2026")
        self.assertEqual(200, self.call(f"/v1/accounts-admin/accounts/{created['id']}/reset-password", {"password": "reset2026"}, admin=ADMIN)[0])
        self.assertFalse(self.alive(login["token"]), "a reset signs the customer out")
        self.assertEqual(401, self.session(phone="13500135000", password="start2026")[0])
        _, fresh = self.session(phone="13500135000", password="reset2026")
        self.assertTrue(fresh["account"]["mustChangePassword"])


if __name__ == "__main__":
    unittest.main()
