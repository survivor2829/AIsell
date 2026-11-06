"""Compute credit (算力): content tasks tag their gateway calls and settle when they finish."""
import io
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from content_engine.errors import ContentEngineError
from content_engine.provider_tls import billing_feature, settle_billing_job, tag_billing
from content_engine.provider_usage import observe_http_error, usage_scope


class _Recorder(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Recorder.received.append((self.path, self.headers.get("Authorization"), json.loads(body)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_args):
        pass


class ProviderBillingTest(unittest.TestCase):
    def test_gateway_requests_inside_a_task_carry_its_job(self):
        with mock.patch.dict(os.environ, {"XIAOXI_PROVIDER_GATEWAY_ORIGIN": "https://gw.example"}):
            inside = urllib.request.Request("https://gw.example/v1/provider-gateway/deepseek/chat/completions", data=b"{}")
            with usage_scope(task_id="task_1", task_type="narrated_batch_v1"):
                tag_billing(inside)
            self.assertEqual("ce:task_1", inside.get_header("X-xiaoxi-billing-job"))
            self.assertEqual("mix", inside.get_header("X-xiaoxi-billing-feature"))
            outside = urllib.request.Request("https://gw.example/v1/provider-gateway/deepseek/chat/completions", data=b"{}")
            tag_billing(outside)
            self.assertIsNone(outside.get_header("X-xiaoxi-billing-job"), "no task, no job: charged at once")
            other_host = urllib.request.Request("https://api.deepseek.com/chat/completions", data=b"{}")
            with usage_scope(task_id="task_1", task_type="narrated_batch_v1"):
                tag_billing(other_host)
            self.assertIsNone(other_host.get_header("X-xiaoxi-billing-job"), "only gateway requests are tagged")
        self.assertEqual("product_video", billing_feature("product_generation"))
        self.assertEqual("digital_human", billing_feature("import_base_video"))

    def test_finished_task_is_reported_to_the_gateway(self):
        _Recorder.received = []
        server = HTTPServer(("127.0.0.1", 0), _Recorder)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            env = {"XIAOXI_PROVIDER_GATEWAY_ORIGIN": f"http://127.0.0.1:{server.server_port}",
                   "XIAOXI_PROVIDER_GATEWAY_TOKEN": "t" * 40, "XIAOXI_PROVIDER_GATEWAY_CA_PEM": ""}
            with mock.patch.dict(os.environ, env):
                settle_billing_job("task_9", "succeeded")
                deadline = time.time() + 5
                while not _Recorder.received and time.time() < deadline:
                    time.sleep(0.05)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual([("/v1/provider-gateway/billing/settle", "Bearer " + "t" * 40,
                           {"jobId": "ce:task_9", "outcome": "succeeded"})], _Recorder.received)

    def test_used_up_credit_becomes_a_clear_message(self):
        meter = mock.Mock()
        error = urllib.error.HTTPError("https://gw", 402, "Payment Required", {},
                                       io.BytesIO(json.dumps({"error": "credit_exhausted"}).encode()))
        with self.assertRaises(ContentEngineError) as raised:
            observe_http_error(meter, error)
        self.assertEqual("credit_exhausted", raised.exception.code)
        self.assertIn("充值", raised.exception.message)


if __name__ == "__main__":
    unittest.main()
