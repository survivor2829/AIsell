"""Operator-published viral script library: session-gated, read-only, strict schema."""
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from service import GatewayConfig, GatewayServer, Handler, VIRAL_LIBRARY_MAX_BYTES, _viral_library
import test_service


def library(**patch):
    return {"schema": 1, "updatedAt": "2026-10-24T08:00:00Z",
            "stats": {"collected": 64, "duplicates": 7, "final": 15, "ready": 2},
            "flow": {"strands": [{"id": "1", "title": "t", "source": "抖音", "group": "1", "outcome": "pass", "reason": "高赞"}]},
            "items": [{"id": "7400000000000000001", "platform": "douyin", "title": "物业经理别再为招保洁发愁", "script": "夜班保洁排不开人？先看地面材质。",
                       "emphasisPhrases": ["地面材质"], "source": {"title": "原标题", "likes": 83900, "tags": [{"id": "high_likes", "label": "高赞", "value": 83900}]}}],
            **patch}


class ViralLibraryTest(unittest.TestCase):
    post_json = test_service.GatewayTest.post_json
    session = test_service.GatewayTest.session

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "viral-library.json"
        expires = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        self.config = GatewayConfig(keys={"deepseek": "k"}, session_secret="library-secret", receipt_db_path=self.directory.name + "/r.db",
                                    viral_library_path=str(self.path), license_validator=lambda _: {"license_id": "customer", "expires_at": expires})
        self.server = GatewayServer(("127.0.0.1", 0), Handler, self.config)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def get(self, token=None):
        headers = {"Authorization": "Bearer " + token} if token else {}
        request = urllib.request.Request(self.origin + "/v1/provider-gateway/viral-library", headers=headers)
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_requires_session_and_reports_missing_library(self):
        self.assertEqual(self.get(), (401, {"error": "session_required"}))
        self.assertEqual(self.get(self.session()), (404, {"error": "viral_library_empty"}))

    def test_serves_published_library(self):
        self.path.write_text(json.dumps(library(), ensure_ascii=False), encoding="utf-8")
        status, body = self.get(self.session())
        self.assertEqual(status, 200)
        self.assertEqual(body["items"][0]["script"], "夜班保洁排不开人？先看地面材质。")
        self.assertEqual(body["stats"]["ready"], 2)

    def test_rejects_incomplete_or_oversized_documents(self):
        token = self.session()
        for bad in ("not json", json.dumps({"schema": 2, "items": []}), json.dumps(library(items=[])),
                    json.dumps(library(items=[{"id": "1", "title": "x" * 25, "script": "s"}])),
                    json.dumps(library(items=[{"id": "1", "title": "t", "script": ""}])), json.dumps([1, 2])):
            self.path.write_text(bad, encoding="utf-8")
            self.assertEqual(self.get(token), (503, {"error": "viral_library_invalid"}), bad[:40])
        self.path.write_bytes(b" " * (VIRAL_LIBRARY_MAX_BYTES + 1))
        self.assertEqual(self.get(token)[0], 503)
        with self.assertRaises(FileNotFoundError):
            _viral_library("")


if __name__ == "__main__":
    unittest.main()
