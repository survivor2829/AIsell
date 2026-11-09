import hashlib
import hmac
import json
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from accounts import AccountStore
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

    def new_account(self, phone="13800000001", password="abc12345"):
        status, created = self.call("/v1/accounts-admin/accounts", {"phone": phone, "password": password}, admin=ADMIN)
        self.assertEqual(200, status, created)
        return created["id"]

    def admin_action(self, account_id, action, body):
        return self.call(f"/v1/accounts-admin/accounts/{account_id}/{action}", body, admin=ADMIN)

    def listed(self, account_id):
        accounts = self.call("/v1/accounts-admin/accounts", admin=ADMIN)[1]["accounts"]
        return next(item for item in accounts if item["id"] == account_id)

    def shared_login_on_two_computers(self):
        account_id = self.new_account()
        self.assertEqual(200, self.admin_action(account_id, "multi-device", {"enabled": True})[0])
        first = self.session(INSTALL_A, phone="13800000001", password="abc12345")[1]
        second = self.session(INSTALL_B, phone="13800000001", password="abc12345")[1]
        return account_id, first, second

    def test_new_accounts_stay_on_one_computer(self):
        account_id = self.new_account()
        self.assertFalse(self.listed(account_id)["multiDevice"])
        first = self.session(INSTALL_A, phone="13800000001", password="abc12345")[1]
        second = self.session(INSTALL_B, phone="13800000001", password="abc12345")[1]
        self.assertFalse(self.alive(first["token"]))
        self.assertTrue(self.alive(second["token"]))
        status, refused = self.session(INSTALL_A, deviceToken=first["deviceToken"])
        self.assertEqual((401, "account_signed_in_elsewhere"), (status, refused["error"]))

    def test_shared_account_keeps_every_computer_signed_in(self):
        account_id, first, second = self.shared_login_on_two_computers()
        self.assertTrue(self.alive(first["token"]))
        self.assertTrue(self.alive(second["token"]))
        renewed = self.session(INSTALL_A, deviceToken=first["deviceToken"])[1]
        self.assertTrue(self.alive(renewed["token"]))
        self.assertTrue(self.alive(second["token"]), "renewing one computer leaves the other alone")
        self.assertEqual(2, len(self.listed(account_id)["devices"]))

    def test_signing_out_one_computer_leaves_the_others(self):
        account_id, first, second = self.shared_login_on_two_computers()
        target = next(item for item in self.listed(account_id)["devices"] if item["label"] == INSTALL_A[-4:])
        self.assertEqual(200, self.admin_action(account_id, "device-sign-out", {"deviceId": target["id"]})[0])
        self.assertFalse(self.alive(first["token"]))
        self.assertTrue(self.alive(second["token"]))
        self.assertEqual(401, self.session(INSTALL_A, deviceToken=first["deviceToken"])[0])

    def test_switching_back_to_one_computer_keeps_the_most_recent(self):
        account_id, first, second = self.shared_login_on_two_computers()
        self.assertEqual(200, self.admin_action(account_id, "multi-device", {"enabled": False})[0])
        self.assertFalse(self.alive(first["token"]))
        self.assertTrue(self.alive(second["token"]))
        self.assertEqual([INSTALL_B[-4:]], [item["label"] for item in self.listed(account_id)["devices"]])
        status, refused = self.session(INSTALL_A, deviceToken=first["deviceToken"])
        self.assertEqual((401, "account_signed_in_elsewhere"), (status, refused["error"]))

    def admin_session(self, phone="13800000009"):
        account_id = self.new_account(phone)
        self.assertEqual(200, self.admin_action(account_id, "admin", {"enabled": True})[0])
        session = self.session(INSTALL_A, phone=phone, password="abc12345")[1]
        self.assertTrue(session["account"]["isAdmin"])
        return account_id, session["token"]

    def app_call(self, route, body=None, token="", ticket=None):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        if ticket:
            headers["X-Xiaoxi-Admin-Ticket"] = ticket
        request = urllib.request.Request(f"{self.origin}/v1/provider-gateway/account/admin{route}",
                                         data=None if body is None else json.dumps(body).encode(), headers=headers,
                                         method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def test_changing_the_password_signs_out_the_other_computers(self):
        account_id, first, second = self.shared_login_on_two_computers()
        status, _ = self.call("/v1/provider-gateway/account/password", {"currentPassword": "abc12345", "newPassword": "new12345x"}, token=first["token"])
        self.assertEqual(200, status)
        self.assertTrue(self.alive(first["token"]), "the computer changing it stays")
        self.assertFalse(self.alive(second["token"]))
        self.assertEqual(401, self.session(INSTALL_B, deviceToken=second["deviceToken"])[0])
        self.assertEqual([INSTALL_A[-4:]], [item["label"] for item in self.listed(account_id)["devices"]])

    def test_wrong_administrator_passwords_do_not_lock_out_customers(self):
        self.new_account("13800000005")
        _, token = self.admin_session()
        for _ in range(6):
            self.app_call("/ticket", {"password": "wrong1234"}, token)
        self.assertEqual(429, self.app_call("/ticket", {"password": "abc12345"}, token)[0])
        self.assertEqual(200, self.session(INSTALL_B, phone="13800000005", password="abc12345")[0])

    def test_an_expiry_in_the_past_ends_the_session_at_once(self):
        account_id = self.new_account()
        token = self.session(INSTALL_A, phone="13800000001", password="abc12345")[1]["token"]
        self.assertEqual(200, self.admin_action(account_id, "expires", {"expiresAt": time.time() + 86400})[0])
        self.assertTrue(self.alive(token))
        self.assertEqual(200, self.admin_action(account_id, "expires", {"expiresAt": time.time() - 60})[0])
        self.assertFalse(self.alive(token))

    def test_the_app_cannot_change_yourself_or_another_administrator(self):
        admin_id, token = self.admin_session()
        other = self.new_account("13800000006")
        self.assertEqual(200, self.admin_action(other, "admin", {"enabled": True})[0])
        ticket = self.app_call("/ticket", {"password": "abc12345"}, token)[1]["ticket"]
        for action, body in (("reset-password", {"password": "taken1234"}), ("status", {"status": "disabled"}), ("expires", {"expiresAt": 1}), ("sign-out", {})):
            self.assertEqual("admin_protected", self.app_call(f"/accounts/{other}/{action}", body, token, ticket)[1].get("error"), action)
        for action, body in (("multi-device", {"enabled": False}), ("expires", {"expiresAt": 1}), ("device-sign-out", {"deviceId": 1})):
            self.assertEqual("cannot_change_self", self.app_call(f"/accounts/{admin_id}/{action}", body, token, ticket)[1].get("error"), action)
        self.assertEqual(200, self.app_call(f"/accounts/{admin_id}/multi-device", {"enabled": True}, token, ticket)[0])

    def test_app_account_management_needs_an_administrator_and_a_fresh_password(self):
        customer = self.new_account("13800000002")
        plain = self.session(INSTALL_B, phone="13800000002", password="abc12345")[1]["token"]
        self.assertEqual(403, self.app_call("/ticket", {"password": "abc12345"}, plain)[0])
        self.assertEqual(403, self.app_call("/accounts", token=plain)[0])
        admin_id, token = self.admin_session()
        self.assertEqual(403, self.app_call("/accounts", token=token)[0], "no ticket yet")
        self.assertEqual(403, self.app_call("/ticket", {"password": "wrong1234"}, token)[0])
        status, granted = self.app_call("/ticket", {"password": "abc12345"}, token)
        self.assertEqual(200, status, granted)
        ticket = granted["ticket"]
        self.assertEqual(403, self.app_call("/accounts", token=plain, ticket=ticket)[0], "a ticket belongs to one administrator")
        self.assertEqual({}, self.app_call("/accounts", token=token, ticket=ticket)[1]["accounts"][0]["usage"])
        self.assertEqual(200, self.app_call(f"/accounts/{customer}/multi-device", {"enabled": True}, token, ticket)[0])
        self.assertTrue(self.listed(customer)["multiDevice"])
        self.assertEqual(404, self.app_call(f"/accounts/{customer}/recharge", {"amountCny": 1}, token, ticket)[0])
        self.assertEqual(404, self.app_call(f"/accounts/{customer}/admin", {"enabled": True}, token, ticket)[0])
        self.assertFalse(self.listed(customer)["isAdmin"])
        self.assertEqual(400, self.app_call(f"/accounts/{admin_id}/status", {"status": "disabled"}, token, ticket)[0])
        self.assertEqual(200, self.admin_action(admin_id, "admin", {"enabled": False})[0])
        self.assertEqual(403, self.app_call("/accounts", token=token, ticket=ticket)[0], "losing the role ends the ticket")


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


class AccountMigrationTest(unittest.TestCase):
    def test_accounts_from_before_this_version_become_shared_and_stay_signed_in(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "receipts.sqlite3")
            config = GatewayConfig(keys={"deepseek": "server-secret"})
            config.receipt_db_path = path
            config.accounts_admin_token = ADMIN
            token = "d" * 48
            digest = hmac.new(config.sessions.secret, b"device:" + token.encode(), hashlib.sha256).digest()
            old = sqlite3.connect(path)
            old.execute("""CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, password_hash TEXT,
                display_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
                subject TEXT NOT NULL UNIQUE, legacy_license_id TEXT UNIQUE, must_change_password INTEGER NOT NULL DEFAULT 1,
                expires_at REAL, active_install_id TEXT, device_digest BLOB, device_expires_at REAL,
                limits_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, last_login_at REAL)""")
            old.execute("""INSERT INTO accounts (phone, subject, active_install_id, device_digest, device_expires_at, created_at)
                VALUES ('13800000003','acct_old',?,?,?,1)""", (INSTALL_A, digest, time.time() + 3600))
            old.commit()
            old.close()
            server = GatewayServer(("127.0.0.1", 0), Handler, config)
            try:
                accounts = server.accounts
                self.assertEqual(1, accounts.by_subject("acct_old")["multi_device"])
                self.assertEqual("acct_old", accounts.login_device(token, INSTALL_A)["subject"])
                created = accounts.admin_create("13800000004", "abc12345")
                self.assertEqual(0, created["multi_device"])
                # A restart must not turn later single-computer accounts into shared ones.
                reopened = AccountStore(server.receipts.db, server.receipts.lock, config.sessions.secret)
                self.assertEqual(0, reopened.by_subject(created["subject"])["multi_device"])
            finally:
                server.server_close()
                server.receipts.close()


if __name__ == "__main__":
    unittest.main()
