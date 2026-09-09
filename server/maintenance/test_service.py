import json
import tempfile
import threading
import unittest
import urllib.request
import time
import hashlib
import http.client
import sqlite3
from contextlib import closing
from pathlib import Path
from service import Handler, Server, Store, validate_report, safe_token
from feedback import validate_feedback

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
                def get(base, route):
                    with urllib.request.urlopen(base + route) as response:
                        return json.load(response)
                self.assertEqual(get(origin, "/v1/feedback/public")["total"], 0, "Legacy feedback stays private")
                community = {**feedback, "schema": 2, "visibility": "public", "id": "12345678-1234-1234-1234-123456789099"}
                post(origin, "/v1/feedback", community)
                private = {**community, "visibility": "private", "id": "12345678-1234-1234-1234-123456789098"}
                post(origin, "/v1/feedback", private)
                visible = get(origin, "/v1/feedback/public?offset=0&limit=99")
                self.assertEqual(visible["total"], 1)
                self.assertEqual(set(visible["items"][0]), {"id", "text", "category", "createdAt", "receivedAt", "updatedAt", "status", "officialReply"})
                initial_time = visible["items"][0]["updatedAt"]
                post(admin_origin, "/api/feedback/status", {"id": community["id"], "status": "in_progress", "officialReply": "已复现，下一版修复", "hidden": False}, True)
                visible = get(origin, "/v1/feedback/public")["items"][0]
                self.assertEqual(visible["officialReply"], "已复现，下一版修复")
                self.assertGreater(visible["updatedAt"], initial_time)
                self.assertEqual(get(admin_origin, "/api/feedback?status=in_progress")["total"], 1)
                post(admin_origin, "/api/feedback/status", {"id": community["id"], "status": "in_progress", "officialReply": "修复正在验收"}, True)
                revised = get(origin, "/v1/feedback/public")["items"][0]
                self.assertGreater(revised["updatedAt"], visible["updatedAt"], "Reply-only changes increment the revision")
                self.assertEqual(revised["officialReply"], "修复正在验收")
                for invalid in ({"officialReply": "x" * 2001}, {"hidden": "false"}):
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post(admin_origin, "/api/feedback/status", {"id": community["id"], "status": "in_progress", **invalid}, True)
                    self.assertEqual(denied.exception.code, 400)
                post(admin_origin, "/api/feedback/status", {"id": community["id"], "status": "in_progress", "hidden": True}, True)
                self.assertEqual(get(origin, "/v1/feedback/public")["total"], 0)
                post(admin_origin, "/api/feedback/status", {"id": community["id"], "status": "in_progress", "hidden": False}, True)
                author = {"id": community["id"], "receiptToken": community["receiptToken"], "visibility": "private"}
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    post(origin, "/v1/feedback/visibility", {**author, "receiptToken": "f" * 64})
                self.assertEqual(denied.exception.code, 403)
                withdrawn = post(origin, "/v1/feedback/visibility", author)
                self.assertEqual(withdrawn["visibility"], "private")
                self.assertGreater(withdrawn["updatedAt"], visible["updatedAt"])
                self.assertEqual(post(origin, "/v1/feedback", community), withdrawn, "An upload retry cannot republish withdrawn feedback")
                self.assertEqual(post(origin, "/v1/feedback/visibility", author), withdrawn)
                self.assertEqual(get(origin, "/v1/feedback/public")["total"], 0)
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    post(origin, "/v1/feedback/visibility", {**author, "visibility": "public"})
                self.assertEqual(denied.exception.code, 400)
                for base, route, origin_header, expected in ((origin, "/api/feedback/status", True, 404), (admin_origin, "/api/feedback/status", False, 403)):
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        post(base, route, {"id": community["id"], "status": "resolved"}, origin_header)
                    self.assertEqual(denied.exception.code, expected)
                connection = http.client.HTTPConnection("127.0.0.1", admin.server_port)
                try:
                    connection.request("GET", "/api/feedback", headers={"Host": "evil.example"})
                    self.assertEqual(connection.getresponse().status, 403)
                finally:
                    connection.close()
            finally:
                for server in (public, admin):
                    server.shutdown()
                    server.server_close()

    def test_legacy_database_migration_preserves_original_retry_hash(self):
        # This fixture is the old schema and canonical object, independent of the
        # new validator. Changing schema-1 defaults would break its saved hash.
        with tempfile.TemporaryDirectory() as directory:
            clean = {"schema": 1, "id": "12345678-1234-1234-1234-123456789011", "text": "旧版本反馈", "category": "problem",
                     "createdAt": "2026-09-08T10:00:00.000Z", "client": {"schema": 1, "appId": "com.aihuoke.desktop.test", "channel": "test",
                     "installId": "12345678-1234-1234-1234-123456789012", "version": "1.0.2", "platform": "win32", "arch": "x64", "buildId": "", "osRelease": ""},
                     "context": {"module": "", "taskId": ""}, "diagnostics": []}
            secret = "a" * 64
            payload_hash = hashlib.sha256(json.dumps(clean, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            with closing(sqlite3.connect(Path(directory) / "reports.sqlite3")) as db:
                db.execute("CREATE TABLE feedback(id TEXT PRIMARY KEY,received INTEGER,updated INTEGER,status TEXT,token_hash TEXT,payload_hash TEXT,body TEXT,diagnostics TEXT,diagnostics_expires INTEGER)")
                db.execute("INSERT INTO feedback VALUES (?,?,?,?,?,?,?,?,?)", (clean["id"], 1, 2, "resolved", hashlib.sha256(secret.encode()).hexdigest(), payload_hash,
                           json.dumps({k: v for k, v in clean.items() if k != "diagnostics"}), None, 3))
                db.commit()
            store = Store(directory)
            Store(directory)  # Migration may run on every service startup.
            validated, token = validate_feedback({**clean, "receiptToken": secret}, validate_report, safe_token)
            receipt = store.insert_feedback(validated, token)
            self.assertEqual(receipt["status"], "resolved")
            self.assertEqual(receipt["updatedAt"], 2)
            self.assertEqual(receipt["visibility"], "private")
            self.assertEqual(store.public_feedback()["total"], 0)
            with store.connect() as db:
                self.assertEqual(db.execute("SELECT payload_hash FROM feedback").fetchone()[0], payload_hash)

    def test_ingestion_dedupe_and_private_admin(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            server = Server(("127.0.0.1", 0), Handler, store)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}"
            report = {"schema": 1, "appId": "com.aihuoke.desktop.test", "channel": "test", "installId": "12345678-1234-1234-1234-123456789012", "version": "1.0.0", "platform": "win32", "arch": "x64", "secret": "never-store", "entries": [{"id": "a" * 64, "ts": "2026-09-07T10:00:00.000Z", "level": "error", "module": "app", "event": "test.failed", "code": "test_error", "message": "customer content", "details": {"password": "secret"}}]}
            try:
                report["entries"][0]["details"].update(stage="capture_timeout_wx_hook", wx_hook_stage="init_failed", helper_configured=True, wechat_exe_configured=True, wechat_root_configured=False)
                report["entries"][0]["details"].update(wechat_version="4.1.3.12", stop_verified=False, send_attempted=None, is_new=False, input_empty=True, elapsed_ms=1234, candidate_count=0, messageText="never-store-proof-text")
                window_details = {"window_stage": "enumerate", "window_class_code": "mmui::MainWindow", "window_candidate_count": 2, "window_compile_ms": 200, "window_total_ms": 20001}
                report["entries"][0]["details"].update(window_details, window_title="never-store-window-title")
                for _ in range(2):
                    request = urllib.request.Request(origin + "/v1/reports", json.dumps(report).encode(), {"Content-Type": "application/json"})
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(json.load(response)["accepted"], ["a" * 64])
                overview = store.overview()
                self.assertEqual(len(overview["reports"]), 1)
                self.assertNotIn("never-store", json.dumps(overview))
                self.assertNotIn("customer content", json.dumps(overview))
                self.assertEqual(overview["reports"][0]["entries"][0]["details"], {"stage": "capture_timeout_wx_hook", "wx_hook_stage": "init_failed", "helper_configured": True, "wechat_exe_configured": True, "wechat_root_configured": False, "wechat_version": "4.1.3.12", "stop_verified": False, "send_attempted": None, "is_new": False, "input_empty": True, "elapsed_ms": 1234, "candidate_count": 0, **window_details})
                self.assertNotIn("never-store-proof-text", json.dumps(overview))
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
