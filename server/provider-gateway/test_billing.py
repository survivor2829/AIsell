"""Compute credit (算力) metering, settlement and blocking, against fake suppliers only."""
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from billing import JOB_EXPIRY_SECONDS, POINTS_PER_CNY
from service import GatewayConfig, GatewayServer, Handler

ADMIN = "admin-token-fixture-0123456789"
INSTALL = "11111111-1111-1111-1111-111111111111"
PREFIX = "/v1/provider-gateway"


class FakeResponse:
    def __init__(self, body, status=200, content_type="application/json"):
        self.status = self.code = status
        self.headers = {"Content-Type": content_type}
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode()

    def read(self, _limit=-1):
        return self._body

    def close(self):
        pass


def deepseek_reply(prompt=1_000_000, output=0, cached=0):
    return {"model": "deepseek-v4-flash", "choices": [{"message": {"content": "ok"}}],
            "usage": {"prompt_tokens": prompt, "completion_tokens": output, "prompt_cache_hit_tokens": cached}}


class BillingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = GatewayConfig(keys={"deepseek": "k", "bailian": "k", "apimart": "k", "volcengine_tts": "k",
                                          "volcengine_asr": "k", "volcengine_ark": "k"})
        self.config.receipt_db_path = str(Path(self.temp.name) / "receipts.sqlite3")
        self.config.accounts_admin_token = ADMIN
        expiry = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        self.config.license_validator = lambda code: {"license_id": "lic-" + code[-4:], "expires_at": expiry}
        self.replies = []
        self.sent = []

        def upstream(request, timeout):
            self.sent.append(request)
            return self.replies.pop(0) if self.replies else FakeResponse(deepseek_reply())

        self.config.upstream_open = upstream
        self.server = GatewayServer(("127.0.0.1", 0), Handler, self.config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.server.server_address[1]}"
        status, session = self.call(PREFIX + "/session", {"appId": "com.aihuoke.desktop.test", "channel": "test",
                                                          "version": "1.2.64", "installId": INSTALL,
                                                          "licenseCode": "signed-license-abcd"})
        self.assertEqual(200, status, session)
        self.token = session["token"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def call(self, route, body=None, token="", admin=None, headers=None):
        merged = {"Content-Type": "application/json", **(headers or {})}
        if token:
            merged["Authorization"] = f"Bearer {token}"
        if admin is not None:
            merged["X-Xiaoxi-Accounts-Admin"] = admin
        request = urllib.request.Request(self.origin + route, data=None if body is None else json.dumps(body).encode(),
                                         headers=merged, method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw.startswith(b"{") else raw
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def chat(self, job="", feature=""):
        headers = {}
        if job:
            headers["X-Xiaoxi-Billing-Job"] = job
        if feature:
            headers["X-Xiaoxi-Billing-Feature"] = feature
        return self.call(PREFIX + "/deepseek/chat/completions", {"model": "deepseek-v4-flash", "messages": []},
                         self.token, headers=headers)

    def balance(self):
        status, body = self.call(PREFIX + "/billing/balance", token=self.token)
        self.assertEqual(200, status, body)
        return body["balance"]

    def account_id(self):
        return self.call(f"/v1/accounts-admin/accounts", admin=ADMIN)[1]["accounts"][0]["id"]

    def test_every_account_starts_with_the_grant_and_a_plain_call_is_charged_at_once(self):
        self.assertEqual(20_000_000, self.balance())
        status, _ = self.chat(feature="wechat")
        self.assertEqual(200, status)
        # 1M input tokens of DeepSeek = 2 元 cost; x1.3 x 40,000 = 104,000 算力.
        self.assertEqual(20_000_000 - 104_000, self.balance())

    def test_a_video_is_charged_only_when_it_succeeds(self):
        self.chat(job="ce:video-1", feature="mix")
        self.chat(job="ce:video-1", feature="mix")
        self.assertEqual(20_000_000, self.balance(), "held until the video is settled")
        status, settled = self.call(PREFIX + "/billing/settle", {"jobId": "ce:video-1", "outcome": "succeeded"}, self.token)
        self.assertEqual(200, status, settled)
        self.assertEqual(208_000, settled["charged"])
        self.assertEqual(20_000_000 - 208_000, self.balance())
        # A repeated report charges nothing more.
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:video-1", "outcome": "succeeded"}, self.token)
        self.assertEqual(20_000_000 - 208_000, self.balance())

    def test_past_the_debt_floor_even_a_running_video_stops(self):
        # 负数底线 负 50 元 (user 2026-11-24): a reused open job id cannot keep charging without limit.
        account = self.account_id()
        self.chat(job="ce:keep")
        # −45 元 plus the 2.6 元 already held on the job: above the floor, the running video goes on.
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": -20_000_000 - 45 * POINTS_PER_CNY, "note": "test"}, admin=ADMIN)
        self.assertEqual(-45 * POINTS_PER_CNY, self.balance())
        self.assertEqual(200, self.chat(job="ce:keep")[0], "above the floor a running video finishes")
        # Now −45 − 5.2 held = −50.2 元: past the floor.
        status, refused = self.chat(job="ce:keep")
        self.assertEqual(402, status)
        self.assertEqual("credit_exhausted", refused["error"])
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": 60 * POINTS_PER_CNY, "note": "test"}, admin=ADMIN)
        self.assertEqual(200, self.chat(job="ce:keep")[0], "a recharge above zero opens it again")

    def test_charges_held_on_an_open_job_count_toward_the_floor(self):
        # A client that keeps one job open and never settles must not stay above the floor.
        account = self.account_id()
        self.chat(job="ce:held")
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": -20_000_000 - 40 * POINTS_PER_CNY, "note": "test"}, admin=ADMIN)
        statuses = [self.chat(job="ce:held")[0] for _ in range(6)]
        # Each held call is 104,000 算力 (2.6 元): the first held ones pass, then −40 − held reaches −50 and the job stops.
        self.assertIn(402, statuses, statuses)
        self.assertEqual(200, statuses[0])
        alert = self.call("/v1/gateway-internal/usage-alerts")[1]["usage_alerts"]
        self.assertTrue(any(item.get("debtFloor") for item in alert), alert)

    def test_one_account_starting_paid_work_too_fast_is_held_for_a_minute(self):
        self.server.config.account_paid_per_minute = 3
        for _ in range(3):
            self.assertEqual(200, self.chat()[0])
        status, refused = self.chat()
        self.assertEqual(429, status)
        self.assertEqual("account_rate_limited", refused["error"])
        self.assertIn("稍等", refused["message"])
        self.assertEqual(200, self.call(PREFIX + "/billing/balance", token=self.token)[0], "reading the balance is not paid work")
        alerts = self.call("/v1/gateway-internal/usage-alerts")[1]["usage_alerts"]
        self.assertEqual(1, alerts[0]["rateLimited"])
        subject = self.call(PREFIX + "/account", token=self.token)[1]["account"]["id"]
        self.assertEqual(subject, alerts[0]["accountId"], "named by the id the admin back end lists")
        self.assertGreater(alerts[0]["todayCny"], 0, "a rate-limited account shows its real spend")
        # Yesterday's hits are not reported as today's.
        self.server.account_rate_day -= 1
        self.assertEqual([], self.call("/v1/gateway-internal/usage-alerts")[1]["usage_alerts"])

    def test_usage_alerts_name_spikes_and_accounts_at_the_floor(self):
        billing = self.server.billing
        subject = self.call(PREFIX + "/account", token=self.token)[1]["account"]["id"]
        now = time.time()
        with billing.lock:
            for days_ago, cny in ((3, 4), (2, 6), (0, 120)):
                billing.db.execute("""INSERT INTO billing_charges (subject, dedupe, job_id, feature, provider, model, unit,
                    quantity, cost_cny, points, state, created_at, settled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (subject, f"t{days_ago}", None, "video", "bailian", "m", "s", 1, cny, cny * POINTS_PER_CNY, "charged",
                     now - days_ago * 86400, now))
            billing.db.commit()
        status, body = self.call("/v1/gateway-internal/usage-alerts")
        self.assertEqual(200, status)
        spike = body["usage_alerts"][0]
        self.assertEqual("spike", spike["reason"])
        self.assertEqual(120, spike["todayCny"])
        self.assertNotIn("subject", spike, "the report names the account by id and phone tail only")
        self.assertEqual(subject, spike["accountId"])
        self.assertIn("phoneTail", spike)
        # A quiet account is not reported.
        with billing.lock:
            billing.db.execute("DELETE FROM billing_charges WHERE dedupe='t0'")
            billing.db.commit()
        self.assertEqual([], self.call("/v1/gateway-internal/usage-alerts")[1]["usage_alerts"])

    def demo_session(self, install="33333333-3333-3333-3333-333333333333"):
        return self.call(PREFIX + "/session", {"appId": "com.aihuoke.desktop.test", "channel": "test",
                                               "version": "1.3.40", "installId": install, "demo": True})

    def test_the_trial_account_enters_without_a_password_and_never_spends(self):
        status, session = self.demo_session()
        self.assertEqual(200, status, session)
        self.assertTrue(session["account"]["demo"])
        self.assertFalse(session["account"]["setupRequired"], "the trial is never asked to choose a phone")
        token = session["token"]
        sent_before = len(self.sent)
        status, refused = self.call(PREFIX + "/deepseek/chat/completions", {"model": "deepseek-v4-flash", "messages": []}, token)
        self.assertEqual(402, status)
        self.assertEqual("demo_account", refused["error"])
        self.assertIn("体验账号", refused["message"])
        self.assertEqual(sent_before, len(self.sent), "nothing reaches the paid supplier")
        status, balance = self.call(PREFIX + "/billing/balance", token=token)
        self.assertEqual((200, 0, True), (status, balance["balance"], balance["demo"]))
        self.assertEqual(403, self.call(PREFIX + "/account/setup", {"phone": "13800000009", "password": "abc12345"}, token)[0])
        self.assertEqual(403, self.call(PREFIX + "/account/password", {"currentPassword": "", "newPassword": "abc12345"}, token)[0])
        # Many computers at once; a second computer does not sign the first out.
        other = self.demo_session("44444444-4444-4444-4444-444444444444")[1]["token"]
        self.assertEqual(200, self.call(PREFIX + "/capabilities", token=token)[0])
        self.assertEqual(200, self.call(PREFIX + "/capabilities", token=other)[0])
        # A real account is unaffected.
        self.assertEqual(200, self.chat()[0])

    def test_the_trial_keeps_a_bounded_list_of_computers_without_pushing_anyone_out(self):
        import accounts
        previous, accounts.DEMO_DEVICE_LIMIT = accounts.DEMO_DEVICE_LIMIT, 3
        try:
            store = self.server.accounts
            tokens = []
            for index in range(3):
                store.failures.clear()
                status, session = self.demo_session(f"5555555{index}-5555-5555-5555-555555555555")
                self.assertEqual(200, status)
                tokens.append(session["token"])
            store.failures.clear()
            self.assertEqual(429, self.demo_session("55555559-5555-5555-5555-555555555555")[0],
                             "a full list of computers in use is never emptied by new logins")
            demo = store._row("subject=?", (accounts.DEMO_SUBJECT,))
            for token in tokens:
                self.assertEqual(200, self.call(PREFIX + "/billing/balance", token=token)[0], "people using the trial stay signed in")
            store.db.execute("UPDATE account_devices SET last_seen_at=last_seen_at-200000 WHERE account_id=? AND install_id=?",
                             (demo["id"], "55555550-5555-5555-5555-555555555555"))
            store.db.commit()
            store.failures.clear()
            self.assertEqual(200, self.demo_session("55555559-5555-5555-5555-555555555555")[0], "a computer idle for a day makes room")
            count = store.db.execute("SELECT COUNT(*) FROM account_devices WHERE account_id=?", (demo["id"],)).fetchone()[0]
            self.assertEqual(3, count)
            store.failures.clear()
            self.assertEqual(200, self.demo_session("55555551-5555-5555-5555-555555555555")[0], "a known computer signs in again")
        finally:
            accounts.DEMO_DEVICE_LIMIT = previous

    def test_the_trial_is_limited_per_address_and_can_be_switched_off(self):
        for _ in range(30):
            self.assertEqual(200, self.demo_session()[0])
        self.assertEqual(429, self.demo_session()[0], "the no-password door cannot be hammered")
        self.server.accounts.failures.clear()
        demo = next(item for item in self.call("/v1/accounts-admin/accounts", admin=ADMIN)[1]["accounts"] if item["displayName"] == "体验账号")
        self.assertEqual(200, self.call(f"/v1/accounts-admin/accounts/{demo['id']}/status", {"status": "disabled"}, admin=ADMIN)[0])
        self.assertEqual(403, self.demo_session()[0], "an administrator can switch the trial off")

    def test_a_failed_video_is_free_and_late_calls_for_it_stay_free(self):
        self.chat(job="ce:video-2")
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:video-2", "outcome": "failed"}, self.token)
        self.chat(job="ce:video-2")
        self.assertEqual(20_000_000, self.balance())

    def test_an_unsettled_video_counts_as_failed_after_a_day(self):
        self.chat(job="ce:video-3")
        billing = self.server.billing
        with billing.lock:
            billing.db.execute("UPDATE billing_jobs SET updated_at=?", (time.time() - JOB_EXPIRY_SECONDS - 1,))
            billing.db.commit()
        billing._last_expiry = 0
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:video-3", "outcome": "succeeded"}, self.token)
        self.assertEqual(20_000_000, self.balance())

    def test_empty_balance_blocks_new_work_but_lets_running_videos_finish(self):
        account = self.account_id()
        self.chat(job="ce:running")
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": -20_000_000, "note": "test"}, admin=ADMIN)
        self.assertEqual(0, self.balance())
        status, refused = self.chat()
        self.assertEqual(402, status)
        self.assertEqual("credit_exhausted", refused["error"])
        self.assertIn("充值", refused["message"])
        self.assertEqual(402, self.chat(job="ce:new-video")[0])
        self.assertEqual(200, self.chat(job="ce:running")[0], "an open video keeps going")
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:running", "outcome": "succeeded"}, self.token)
        self.assertEqual(-208_000, self.balance(), "the balance may go negative")
        self.assertTrue(self.call(PREFIX + "/billing/balance", token=self.token)[1]["blocked"])
        # A recharge pays the negative first: 10 元 = 400,000 算力.
        status, body = self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"amountCny": 10, "note": "转账"}, admin=ADMIN)
        self.assertEqual(200, status, body)
        self.assertEqual(192_000, body["balance"])
        self.assertEqual(200, self.chat()[0])

    def test_a_rerun_of_a_failed_task_is_charged_when_it_succeeds(self):
        self.chat(job="ce:rerun")
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:rerun", "outcome": "failed"}, self.token)
        self.chat(job="ce:rerun")
        self.call(PREFIX + "/billing/settle", {"jobId": "ce:rerun", "outcome": "succeeded"}, self.token)
        self.assertEqual(20_000_000 - 104_000, self.balance(), "only the successful run is charged")

    def test_a_reused_operation_id_with_new_content_cannot_skip_an_empty_balance(self):
        account = self.account_id()
        headers = {"X-Xiaoxi-Operation-Id": "op-1"}
        route = PREFIX + "/deepseek/chat/completions"
        self.assertEqual(200, self.call(route, {"model": "deepseek-v4-flash", "messages": []}, self.token, headers=headers)[0])
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": -20_000_000}, admin=ADMIN)
        sent = len(self.sent)
        status, replay = self.call(route, {"model": "deepseek-v4-flash", "messages": []}, self.token, headers=headers)
        self.assertEqual(200, status, "the same request replays its receipt")
        status, _ = self.call(route, {"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "new"}]},
                              self.token, headers=headers)
        self.assertEqual(402, status)
        self.assertEqual(sent, len(self.sent), "nothing reached the supplier")
        status, _ = self.call(route, {"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "new"}]},
                              self.token, headers=headers)
        self.assertEqual(402, status, "a refused request leaves no receipt behind")

    def test_a_repeated_recharge_request_is_applied_once(self):
        account = self.account_id()
        for _ in range(2):
            self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"amountCny": 10, "requestId": "rc-1"}, admin=ADMIN)
        self.assertEqual(20_400_000, self.balance())

    def test_async_transcription_is_never_priced_as_video(self):
        self.replies = [FakeResponse({"output": {"task_id": "asr-1", "task_status": "PENDING"}}),
                        FakeResponse({"output": {"task_id": "asr-1", "task_status": "SUCCEEDED"}, "usage": {"duration": 60}})]
        self.call(PREFIX + "/bailian/api/v1/services/audio/asr/transcription", {"model": "paraformer-v2"},
                  self.token, headers={"X-DashScope-Async": "enable"})
        self.call(PREFIX + "/bailian/api/v1/tasks/asr-1", token=self.token)
        self.assertEqual(20_000_000, self.balance())

    def test_unblocked_accounts_are_metered_but_never_refused(self):
        account = self.account_id()
        self.call(f"/v1/accounts-admin/accounts/{account}/recharge", {"points": -20_000_000}, admin=ADMIN)
        self.call(f"/v1/accounts-admin/accounts/{account}/billing-access", {"unblocked": True}, admin=ADMIN)
        self.assertEqual(200, self.chat()[0])
        self.assertEqual(-104_000, self.balance())

    def test_async_video_is_priced_once_from_the_finished_task(self):
        self.replies = [FakeResponse({"output": {"task_id": "task-abc", "task_status": "PENDING"}})]
        status, _ = self.call(PREFIX + "/bailian/api/v1/services/aigc/video-generation/video-synthesis",
                              {"model": "wan3.0-video", "parameters": {"resolution": "480P", "duration": 10}},
                              self.token, headers={"X-DashScope-Async": "enable", "X-Xiaoxi-Billing-Job": "pv:1",
                                                   "X-Xiaoxi-Billing-Feature": "product_video"})
        self.assertEqual(200, status)
        done = {"output": {"task_id": "task-abc", "task_status": "SUCCEEDED"}, "usage": {"video_duration": 10}}
        self.replies = [FakeResponse({"output": {"task_status": "RUNNING"}}), FakeResponse(done), FakeResponse(done)]
        for _ in range(3):
            self.call(PREFIX + "/bailian/api/v1/tasks/task-abc", token=self.token)
        self.call(PREFIX + "/billing/settle", {"jobId": "pv:1", "outcome": "succeeded"}, self.token)
        # 10 s x 0.3 元 = 3 元; x1.3 x 40,000 = 156,000, charged once despite two polls.
        self.assertEqual(20_000_000 - 156_000, self.balance())
        detail = self.call(f"/v1/accounts-admin/accounts/{self.account_id()}/billing", admin=ADMIN)[1]
        self.assertEqual([("product_video", 156_000)], [(row["feature"], row["totalPoints"]) for row in detail["features"]])

    def test_apimart_images_use_the_supplier_reported_cost(self):
        self.replies = [FakeResponse({"code": 200, "data": [{"task_id": "img-1", "status": "submitted"}]})]
        self.call(PREFIX + "/apimart/images/generations", {"model": "gpt-image-2.5-ext", "size": "2:3", "resolution": "1K", "n": 1},
                  self.token)
        self.replies = [FakeResponse({"data": {"status": "completed", "cost": 0.0085}})]
        self.call(PREFIX + "/apimart/tasks/img-1?language=en", token=self.token)
        # $0.0085 x 8 = 0.068 元; x1.3 x 40,000 = 3,536.
        self.assertEqual(20_000_000 - 3_536, self.balance())

    def test_tts_and_asr_are_metered_from_supplier_usage(self):
        sse = b'data: {"code":0,"data":"AAAA"}\n\ndata: {"code":20000000,"usage":{"text_words":100}}\n\n'
        self.replies = [FakeResponse(sse, content_type="text/event-stream"),
                        FakeResponse({"audio_info": {"duration": 3_600_000}, "result": {"text": "x"}})]
        self.call(PREFIX + "/volcengine/tts/sse", {"req_params": {"text": "x" * 100}}, self.token,
                  headers={"X-Api-Resource-Id": "seed-tts-2.0"})
        self.call(PREFIX + "/volcengine/asr/recognize/flash", {"audio": {}}, self.token)
        # TTS 100 chars x 3 元/万 = 0.03 元 -> 1,560; ASR 1 hour = 4.5 元 -> 234,000.
        self.assertEqual(20_000_000 - 1_560 - 234_000, self.balance())

    def test_streamed_bailian_speech_is_metered_by_characters(self):
        sse = (b'data: {"output":{"audio":{"data":"AAAA"}}}\n\n'
               b'data: {"output":{"finish_reason":"stop"},"usage":{"characters":10000}}\n\n')
        self.replies = [FakeResponse(sse, content_type="text/event-stream")]
        self.call(PREFIX + "/bailian/api/v1/services/audio/tts/SpeechSynthesizer",
                  {"model": "cosyvoice-v3.5-flash", "input": {"text": "x"}}, self.token,
                  headers={"X-DashScope-SSE": "enable", "X-Xiaoxi-Operation-Id": "voice-1"})
        # 10,000 chars x 0.8 元/万 = 0.8 元 -> 41,600.
        self.assertEqual(20_000_000 - 41_600, self.balance())

    def test_admin_list_shows_balance_and_usage(self):
        self.chat()
        account = self.call("/v1/accounts-admin/accounts", admin=ADMIN)[1]["accounts"][0]
        billing = account["usage"]["billing"]
        self.assertEqual(20_000_000 - 104_000, billing["balance"])
        self.assertEqual(104_000, billing["monthPoints"])
        self.assertEqual(104_000, billing["totalPoints"])
        self.assertFalse(billing["unblocked"])
        self.assertEqual(400, self.call(f"/v1/accounts-admin/accounts/{account['id']}/recharge", {"amountCny": -5}, admin=ADMIN)[0])
        self.assertEqual(404, self.call(f"/v1/accounts-admin/accounts/{account['id']}/billing")[0], "admin token required")


if __name__ == "__main__":
    unittest.main()
