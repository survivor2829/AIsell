import base64
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import capsules
from service import Handler, Server, Store
from feedback import validate_feedback
from service import validate_report, safe_token

CLIENT = {"schema": 1, "appId": "com.aihuoke.desktop.test", "channel": "test",
          "installId": "12345678-1234-1234-1234-123456789012", "version": "1.2.22", "platform": "win32", "arch": "x64"}
OTHER = {**CLIENT, "installId": "87654321-4321-4321-4321-210987654321"}
CAPSULE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
EVIDENCE_ID = "0123456789abcdef0123456789abcdef"
PNG = b"\x89PNG\r\n\x1a\nfixture"


def capsule(**fields):
    return {"schema": 1, "id": CAPSULE_ID, "createdAt": "2026-10-29T10:00:00.000Z", "lastSeenAt": "2026-10-29T10:00:00.000Z",
            "occurrences": 1, "source": "engine", "module": "content_engine", "code": "auto_mix_music_not_audible",
            "taskId": "task_7", "message": "背景音乐在大部分口播中听不到", "traceback": "Traceback ...",
            "details": {"quiet": [{"captionId": "c2", "musicLufs": None}]}, "breadcrumbs": [], **fields}


class CapsuleServiceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Store(self.directory.name)
        self.public = Server(("127.0.0.1", 0), Handler, self.store)
        self.admin = Server(("127.0.0.1", 0), Handler, self.store, admin=True)
        for server in (self.public, self.admin):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.origin = f"http://127.0.0.1:{self.public.server_port}"
        self.admin_origin = f"http://127.0.0.1:{self.admin.server_port}"

    def tearDown(self):
        for server in (self.public, self.admin):
            server.shutdown()
            server.server_close()
        self.directory.cleanup()

    def post(self, route, body):
        request = urllib.request.Request(self.origin + route, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def rejected(self, route, body):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post(route, body)
        return caught.exception.code

    def get(self, route, raw=False):
        with urllib.request.urlopen(self.admin_origin + route) as response:
            return response.read() if raw else json.load(response)

    def test_capsule_and_original_screenshot_reach_the_administrator(self):
        self.assertEqual({"id": CAPSULE_ID, "evidence": [], "attachments": []}, self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()}))
        evidence = {"client": CLIENT, "capsuleId": CAPSULE_ID, "evidenceId": EVIDENCE_ID, "png": base64.b64encode(PNG).decode()}
        self.assertEqual({"ok": True}, self.post("/v1/capsules/evidence", evidence))
        # A repeat of the same failure re-sends the capsule with a higher count.
        again = self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule(occurrences=3)})
        self.assertEqual([EVIDENCE_ID], again["evidence"], "screenshots already received are not sent twice")
        overview = self.get("/api/capsules")
        self.assertEqual(1, overview["total"])
        self.assertEqual(3, overview["items"][0]["occurrences"])
        self.assertNotIn("traceback", overview["items"][0], "the list stays light; the detail holds the rest")
        self.assertEqual([{"module": "content_engine", "code": "auto_mix_music_not_audible"}],
                         [{key: group[key] for key in ("module", "code")} for group in overview["groups"]])
        detail = self.get(f"/api/capsules/{CAPSULE_ID}")
        self.assertEqual("c2", detail["capsule"]["details"]["quiet"][0]["captionId"])
        self.assertEqual(PNG, self.get(f"/api/capsules/{CAPSULE_ID}/evidence/{EVIDENCE_ID}.png", raw=True))
        self.assertEqual(1, self.get("/api/capsules?module=content_engine")["total"])
        self.assertEqual(0, self.get("/api/capsules?code=other")["total"])

    def test_capsules_are_not_public(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        for route in ("/api/capsules", f"/api/capsules/{CAPSULE_ID}", f"/v1/capsules/{CAPSULE_ID}"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(self.origin + route)
            self.assertEqual(404, caught.exception.code, route)

    def test_only_the_sending_computer_can_change_a_capsule_or_add_screenshots(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        self.assertEqual(400, self.rejected("/v1/capsules", {"client": OTHER, "capsule": capsule(occurrences=9)}))
        evidence = {"client": OTHER, "capsuleId": CAPSULE_ID, "evidenceId": EVIDENCE_ID, "png": base64.b64encode(PNG).decode()}
        self.assertEqual(400, self.rejected("/v1/capsules/evidence", evidence))
        unknown = {**evidence, "client": CLIENT, "capsuleId": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"}
        self.assertEqual(400, self.rejected("/v1/capsules/evidence", unknown))

    def test_invalid_capsules_and_images_are_rejected(self):
        for invalid in (capsule(id="not-a-uuid"), capsule(code="bad code!"), capsule(schema=2), capsule(occurrences=0),
                        capsule(taskId="x" * 121), capsule(breadcrumbs=["x" * 1000] * 400)):
            self.assertEqual(400, self.rejected("/v1/capsules", {"client": CLIENT, "capsule": invalid}))
        self.assertEqual(400, self.rejected("/v1/capsules", {"client": {**CLIENT, "appId": "other"}, "capsule": capsule()}))
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        for png in (base64.b64encode(b"GIF89a").decode(), "!!!not-base64"):
            body = {"client": CLIENT, "capsuleId": CAPSULE_ID, "evidenceId": EVIDENCE_ID, "png": png}
            self.assertEqual(400, self.rejected("/v1/capsules/evidence", body))

    def test_retention_removes_expired_capsules_and_their_screenshots(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        self.post("/v1/capsules/evidence", {"client": CLIENT, "capsuleId": CAPSULE_ID, "evidenceId": EVIDENCE_ID,
                                            "png": base64.b64encode(PNG).decode()})
        stray = Path(self.directory.name) / "capsule-evidence" / "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        stray.mkdir()
        (stray / f"{EVIDENCE_ID}.png").write_bytes(PNG)
        self.store.prune()
        self.assertEqual([EVIDENCE_ID], self.store.evidence_ids(CAPSULE_ID))
        self.assertFalse(stray.exists(), "screenshots without a capsule are removed")
        with self.store.connect() as db:
            db.execute("UPDATE capsules SET received=?", (int(time.time()) - 31 * 86400,))
        self.store.prune()
        self.assertEqual(0, self.store.capsule_overview()["total"])
        self.assertEqual([], self.store.evidence_ids(CAPSULE_ID))

    def test_screenshot_space_is_capped_oldest_first(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        newer = "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule(id=newer)})
        for capsule_id in (CAPSULE_ID, newer):
            self.post("/v1/capsules/evidence", {"client": CLIENT, "capsuleId": capsule_id, "evidenceId": EVIDENCE_ID,
                                                "png": base64.b64encode(PNG).decode()})
        with self.store.connect() as db:
            db.execute("UPDATE capsules SET received=received-100 WHERE id=?", (CAPSULE_ID,))
        original = capsules.MAX_EVIDENCE_TOTAL
        capsules.MAX_EVIDENCE_TOTAL = len(PNG)
        try:
            self.store.prune()
        finally:
            capsules.MAX_EVIDENCE_TOTAL = original
        self.assertEqual([], self.store.evidence_ids(CAPSULE_ID))
        self.assertEqual([EVIDENCE_ID], self.store.evidence_ids(newer))

    def test_flight_record_and_passport_attachments_reach_the_administrator(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        jpeg = bytes([0xFF, 0xD8, 0xFF]) + b"frame"
        for name, data in (("flight.json", b'[{"step": "moments.menu_scan"}]'), ("20261029t074106580-1-0001-moments.menu_scan.png", PNG),
                           ("20261029t074107265-1-0002-failure.wx5-r001.jpg", jpeg)):
            self.assertEqual({"ok": True}, self.post("/v1/capsules/attachments", {"client": CLIENT, "capsuleId": CAPSULE_ID, "name": name,
                                                                                  "data": base64.b64encode(data).decode()}))
        again = self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule(occurrences=2)})
        self.assertEqual(3, len(again["attachments"]), "attachments already received are not sent twice")
        detail = self.get(f"/api/capsules/{CAPSULE_ID}")
        self.assertIn("flight.json", detail["attachments"])
        self.assertEqual(jpeg, self.get(f"/api/capsules/{CAPSULE_ID}/attachments/20261029t074107265-1-0002-failure.wx5-r001.jpg", raw=True))
        self.assertEqual(3, self.get("/api/capsules")["items"][0]["attachments"])

    def test_invalid_attachments_are_rejected(self):
        self.post("/v1/capsules", {"client": CLIENT, "capsule": capsule()})
        good = {"client": CLIENT, "capsuleId": CAPSULE_ID, "name": "flight.json", "data": base64.b64encode(b"[]").decode()}
        for invalid in ({"name": "../x.json"}, {"name": ".hidden.json"}, {"name": "x.exe"}, {"name": "x.png", "data": base64.b64encode(b"GIF89a").decode()},
                        {"name": "x.jpg", "data": base64.b64encode(PNG).decode()}, {"data": base64.b64encode(b"not json").decode()},
                        {"client": OTHER}, {"capsuleId": "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"}):
            self.assertEqual(400, self.rejected("/v1/capsules/attachments", {**good, **invalid}), invalid)
        original = capsules.MAX_ATTACHMENTS_PER_CAPSULE
        capsules.MAX_ATTACHMENTS_PER_CAPSULE = 1
        try:
            self.post("/v1/capsules/attachments", good)
            self.post("/v1/capsules/attachments", good)
            self.assertEqual(400, self.rejected("/v1/capsules/attachments", {**good, "name": "other.json"}))
        finally:
            capsules.MAX_ATTACHMENTS_PER_CAPSULE = original
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.origin + f"/api/capsules/{CAPSULE_ID}/attachments/flight.json")
        self.assertEqual(404, caught.exception.code, "attachments are not public")

    def test_task_successes_per_computer_and_version(self):
        def report(entry_id, event, kind, client=CLIENT):
            entry = {"id": entry_id * 64, "ts": "2026-10-29T10:00:00.000Z", "level": "info", "module": "wechat_workflow", "event": event,
                     "code": "ok", "details": {"task_kind": kind}}
            return self.post("/v1/reports", {**client, "entries": [entry]})
        report("a", "task.succeeded", "interact")
        report("b", "task.succeeded", "interact")
        report("c", "task.succeeded", "touch", {**CLIENT, "version": "1.2.23"})
        report("d", "task_step.finished", "interact")
        engine = {"id": "e" * 64, "ts": "2026-10-29T10:00:00.000Z", "level": "info", "module": "content_engine", "event": "task_completed",
                  "code": "ok", "details": {"task_kind": "product_one_click"}}
        self.post("/v1/reports", {**CLIENT, "entries": [engine]})
        health = {(row["installId"], row["version"], row["module"], row["taskKind"]): row["successes"] for row in self.get("/api/health")["successes"]}
        self.assertEqual({(CLIENT["installId"], "1.2.22", "wechat_workflow", "interact"): 2, (CLIENT["installId"], "1.2.23", "wechat_workflow", "touch"): 1,
                          (CLIENT["installId"], "1.2.22", "content_engine", "product_one_click"): 1}, health)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.origin + "/api/health")
        self.assertEqual(404, caught.exception.code)

    def test_feedback_carries_capsule_ids_without_changing_old_retries(self):
        base = {"schema": 2, "id": "12345678-1234-1234-1234-123456789011", "receiptToken": "1" * 64, "text": "还是卡在60%",
                "category": "problem", "createdAt": "2026-10-29T10:00:00.000Z", "client": CLIENT, "visibility": "private",
                "context": {"module": "content_engine", "taskId": "batch_9"}, "diagnostics": []}
        old, _ = validate_feedback(base, validate_report, safe_token)
        self.assertNotIn("capsules", old["context"], "feedback sent before capsules hashes exactly as before")
        self.assertNotIn("page", old["context"], "feedback without a page hashes exactly as before")
        paged, _ = validate_feedback({**base, "context": {**base["context"], "page": "ai-video"}}, validate_report, safe_token)
        self.assertEqual("ai-video", paged["context"]["page"], "the page the 吐槽 button was pressed on is kept")
        bound, _ = validate_feedback({**base, "context": {**base["context"], "capsules": [CAPSULE_ID, CAPSULE_ID]}}, validate_report, safe_token)
        self.assertEqual([CAPSULE_ID], bound["context"]["capsules"])
        for invalid in ([], ["x"], [CAPSULE_ID] * 6, "x"):
            with self.assertRaises(ValueError):
                validate_feedback({**base, "context": {**base["context"], "capsules": invalid}}, validate_report, safe_token)


if __name__ == "__main__":
    unittest.main()
