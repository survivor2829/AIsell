import json
import tempfile
import threading
import unittest
import urllib.request
from service import Handler, Server, Store, validate_report

class ServiceTest(unittest.TestCase):
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
