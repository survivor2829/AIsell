import json
import tempfile
import threading
import unittest
import urllib.request
import time
from service import Handler, Server, Store, validate_report

class ServiceTest(unittest.TestCase):
    def test_feedback_receipt_access_retention_and_admin_status(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            public = Server(("127.0.0.1", 0), Handler, store)
            admin = Server(("127.0.0.1", 0), Handler, store, admin=True)
            for server in (public, admin):
                threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{public.server_port}"
            admin_origin = f"http://127.0.0.1:{admin.server_port}"
            feedback = {"schema": 1, "id": "12345678-1234-1234-1234-123456789011", "receiptToken": "1" * 64,
                        "text": "制作失败 <img src=x onerror=alert(1)>", "category": "problem", "createdAt": "2026-09-08T10:00:00.000Z",
                        "client": {"schema": 1, "appId": "com.aihuoke.desktop.test", "channel": "test", "installId": "12345678-1234-1234-1234-123456789012", "version": "1.0.0", "platform": "win32", "arch": "x64"},
                        "context": {"module": "content_engine", "taskId": "task_1"}, "diagnostics": [{"id": "a" * 64, "ts": "2026-09-08T10:00:00.000Z", "level": "error", "module": "app", "event": "failed", "message": "never-upload-this"}]}
            def post(base, route, body, with_origin=False):
                headers = {"Content-Type": "application/json"}
                if with_origin:
                    headers["Origin"] = base
                request = urllib.request.Request(base + route, json.dumps(body).encode(), headers)
                with urllib.request.urlopen(request) as response:
                    return json.load(response)
            try:
                receipt = post(origin, "/v1/feedback", feedback)
                self.assertEqual(receipt["status"], "pending")
                self.assertEqual(post(origin, "/v1/feedback", feedback), receipt)
                self.assertEqual(store.feedback_overview()["total"], 1)
                with self.assertRaises(urllib.error.HTTPError) as conflict:
                    post(origin, "/v1/feedback", {**feedback, "text": "changed"})
                self.assertEqual(conflict.exception.code, 409)
                query = {"items": [{"id": feedback["id"], "receiptToken": feedback["receiptToken"]}]}
                for invalid in ({"items": [{"id": feedback["id"]}]}, {"items": [{"id": feedback["id"], "receiptToken": "2" * 64}]}):
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post(origin, "/v1/feedback/status", invalid)
                    self.assertEqual(denied.exception.code, 403)
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    post(admin_origin, "/api/feedback/status", {"id": feedback["id"], "status": "resolved"})
                self.assertEqual(denied.exception.code, 403)
                post(admin_origin, "/api/feedback/status", {"id": feedback["id"], "status": "resolved"}, True)
                resolved = post(origin, "/v1/feedback/status", query)["items"][0]
                self.assertEqual(resolved["status"], "resolved")
                self.assertGreater(resolved["updatedAt"], receipt["updatedAt"])
                post(admin_origin, "/api/feedback/status", {"id": feedback["id"], "status": "resolved"}, True)
                self.assertEqual(post(origin, "/v1/feedback/status", query)["items"][0], resolved, "A repeated status update keeps its revision")
                with urllib.request.urlopen(admin_origin + "/api/feedback") as response:
                    details = json.load(response)
                self.assertIn("<img", details["items"][0]["text"], "Feedback stays plain text and is rendered via textContent")
                self.assertNotIn("never-upload-this", json.dumps(details))
                self.assertNotIn(feedback["receiptToken"], json.dumps(details))
                with store.connect() as db:
                    stored = dict(db.execute("SELECT * FROM feedback").fetchone())
                    self.assertNotIn(feedback["receiptToken"], json.dumps(stored))
                    db.execute("UPDATE feedback SET diagnostics_expires=?", (int(time.time()) - 1,))
                store.prune()
                retained = store.feedback_overview()["items"][0]
                self.assertEqual(retained["text"], feedback["text"])
                self.assertEqual(retained["status"], "resolved")
                self.assertEqual(retained["diagnostics"], [])
                self.assertEqual(post(origin, "/v1/feedback", feedback)["status"], "resolved", "Late retry remains idempotent after diagnostic pruning")
                text_only = {**feedback, "id": "12345678-1234-1234-1234-123456789010", "diagnostics": []}
                self.assertEqual(post(origin, "/v1/feedback", text_only)["status"], "pending")
                for route in ("/api/feedback", "/v1/feedback", "/v1/feedback/status"):
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        urllib.request.urlopen(origin + route)
                    self.assertEqual(denied.exception.code, 404)
            finally:
                for server in (public, admin):
                    server.shutdown()
                    server.server_close()

    def test_ingestion_dedupe_and_private_admin(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            server = Server(("127.0.0.1", 0), Handler, store)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}"
            report = {"schema": 1, "appId": "com.aihuoke.desktop.test", "channel": "test", "installId": "12345678-1234-1234-1234-123456789012", "version": "1.0.0", "platform": "win32", "arch": "x64", "secret": "never-store", "entries": [{"id": "a" * 64, "ts": "2026-09-07T10:00:00.000Z", "level": "error", "module": "app", "event": "test.failed", "code": "test_error", "message": "customer content", "details": {"password": "secret"}}]}
            try:
                for _ in range(2):
                    request = urllib.request.Request(origin + "/v1/reports", json.dumps(report).encode(), {"Content-Type": "application/json"})
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(json.load(response)["accepted"], ["a" * 64])
                overview = store.overview()
                self.assertEqual(len(overview["reports"]), 1)
                self.assertNotIn("never-store", json.dumps(overview))
                self.assertNotIn("customer content", json.dumps(overview))
                self.assertEqual(overview["issues"][0]["occurrences"], 1)
                issue_id = overview["issues"][0]["id"]
                with store.connect() as db:
                    db.execute("INSERT INTO issues VALUES (?, 'fixed', '1.0.0')", (issue_id,))
                store.insert(validate_report(report))
                self.assertEqual(store.overview()["issues"][0]["status"], "fixed", "Duplicate retry must not reopen a fixed issue")
                report["entries"][0]["id"] = "b" * 64
                store.insert(validate_report(report))
                self.assertEqual(store.overview()["issues"][0]["status"], "reopened")
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(origin + "/api/overview")
                self.assertEqual(error.exception.code, 404)
                with self.assertRaises(ValueError):
                    validate_report({**report, "appId": "other"})
            finally:
                server.shutdown()
                server.server_close()

if __name__ == "__main__":
    unittest.main()
