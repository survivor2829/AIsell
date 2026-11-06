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

from billing import JOB_EXPIRY_SECONDS
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
