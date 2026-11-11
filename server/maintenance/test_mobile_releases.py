import hashlib
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from mobile_releases import latest, validate_envelope
from promote_mobile import promote
from service import Handler, Server, Store


def manifest(apk, **changes):
    data = apk.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    m = {"schema": 1, "appId": "com.xiaoxi.mobile", "channel": "test", "platform": "android",
         "versionCode": 2, "versionName": "0.2.0", "minVersionCode": 1, "sequence": 1,
         "sha256": digest, "size": len(data), "file": f"/artifacts/{digest}.apk", "certSha256": "c" * 64,
         "publishedAt": "2026-11-11T08:00:00.000Z", "notes": "更新说明", "paused": []}
    m.update(changes)
    return {"payload": json.dumps(m, ensure_ascii=False), "signature": "c2lnbmF0dXJl"}


class MobileReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.root = self.dir / "maintenance"
        self.apk = self.dir / "app.apk"
        self.apk.write_bytes(b"PK fake apk 0.2.0")

    def tearDown(self):
        self.temp.cleanup()

    def publish(self, envelope, apk="default"):
        file = self.dir / "latest.json"
        file.write_text(json.dumps(envelope), encoding="utf-8")
        return promote(file, self.apk if apk == "default" else apk, self.root)

    def test_publishes_apk_and_pointer(self):
        envelope = manifest(self.apk)
        result = self.publish(envelope)
        digest = json.loads(envelope["payload"])["sha256"]
        self.assertEqual(result["versionCode"], 2)
        self.assertEqual((self.root / "artifacts" / f"{digest}.apk").read_bytes(), self.apk.read_bytes())
        self.assertEqual(latest(self.root, "test"), envelope)
        self.assertTrue((self.root / "releases" / "mobile-test" / "1.json").is_file())
        self.assertFalse((self.root / "releases" / "test").exists(), "desktop channel must stay untouched")

    def test_switches_only_reuse_the_published_apk(self):
        self.publish(manifest(self.apk))
        paused = [{"platform": "douyin", "reason": "抖音改版，修复中"}]
        self.publish(manifest(self.apk, sequence=2, minVersionCode=2, paused=paused), apk=None)
        self.assertEqual(json.loads(latest(self.root, "test")["payload"])["paused"], paused)

    def test_switches_only_need_the_apk_on_the_server(self):
        with self.assertRaisesRegex(ValueError, "artifact_missing"):
            self.publish(manifest(self.apk), apk=None)

    def test_release_must_advance(self):
        self.publish(manifest(self.apk, sequence=5))
        with self.assertRaisesRegex(ValueError, "release_must_advance"):
            self.publish(manifest(self.apk, sequence=5))
        with self.assertRaisesRegex(ValueError, "release_must_advance"):
            self.publish(manifest(self.apk, sequence=6, versionCode=1, minVersionCode=1))
        other = self.dir / "other.apk"
        other.write_bytes(b"PK another build")
        with self.assertRaisesRegex(ValueError, "same_version_different_apk"):
            self.publish(manifest(other, sequence=6), apk=other)

    def test_new_version_needs_new_apk_and_same_key(self):
        self.publish(manifest(self.apk, sequence=1))
        # A higher version pointing at the APK already live would offer an update that can never install.
        with self.assertRaisesRegex(ValueError, "new_version_needs_new_apk"):
            self.publish(manifest(self.apk, sequence=2, versionCode=3, versionName="0.3.0"), apk=None)
        newer = self.dir / "newer.apk"
        newer.write_bytes(b"PK fake apk 0.3.0")
        with self.assertRaisesRegex(ValueError, "new_version_needs_new_apk"):
            self.publish(manifest(newer, sequence=2, versionCode=3, versionName="0.1.9"), apk=newer)
        with self.assertRaisesRegex(ValueError, "signing_certificate_changed"):
            self.publish(manifest(newer, sequence=2, versionCode=3, versionName="0.3.0", certSha256="d" * 64), apk=newer)
        with self.assertRaisesRegex(ValueError, "same_version_different_apk"):
            self.publish(manifest(self.apk, sequence=2, versionName="0.2.1"), apk=None)
        self.publish(manifest(newer, sequence=2, versionCode=3, versionName="0.3.0"), apk=newer)

    def test_damaged_apk_on_server_is_replaced(self):
        envelope = manifest(self.apk)
        digest = json.loads(envelope["payload"])["sha256"]
        (self.root / "artifacts").mkdir(parents=True)
        (self.root / "artifacts" / f"{digest}.apk").write_bytes(b"PK trunc")
        self.publish(envelope)
        self.assertEqual((self.root / "artifacts" / f"{digest}.apk").read_bytes(), self.apk.read_bytes())

    def test_odd_types_are_refused_not_crashed(self):
        for changes in ({"channel": ["test"]}, {"paused": [{"platform": ["douyin"], "reason": "x"}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_envelope(manifest(self.apk, **changes))

    def test_apk_must_match_manifest(self):
        envelope = manifest(self.apk)
        self.apk.write_bytes(b"PK tampered")
        with self.assertRaisesRegex(ValueError, "artifact_hash"):
            self.publish(envelope)
        self.assertEqual(latest(self.root, "test"), {"empty": True})

    def test_rejects_wrong_identity(self):
        for changes in ({"appId": "com.aihuoke.desktop.test"}, {"platform": "win32"}, {"channel": "delivery"},
                        {"file": "/artifacts/x.apk"}, {"minVersionCode": 3}, {"versionName": "0.2"},
                        {"paused": [{"platform": "weibo", "reason": "x"}]},
                        {"paused": [{"platform": "douyin", "reason": ""}]},
                        {"paused": [{"platform": "douyin", "reason": "a"}, {"platform": "douyin", "reason": "b"}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_envelope(manifest(self.apk, **changes))

    def test_served_over_http_with_ranges(self):
        envelope = manifest(self.apk)
        self.publish(envelope)
        digest = json.loads(envelope["payload"])["sha256"]
        public = Server(("127.0.0.1", 0), Handler, Store(str(self.root)))
        threading.Thread(target=public.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{public.server_port}"
        try:
            with urllib.request.urlopen(base + "/v1/mobile/releases/test/latest") as response:
                self.assertEqual(json.load(response), envelope)
            with urllib.request.urlopen(base + f"/artifacts/{digest}.apk") as response:
                self.assertEqual(response.headers["Content-Type"], "application/vnd.android.package-archive")
                self.assertEqual(response.read(), self.apk.read_bytes())
            request = urllib.request.Request(base + f"/artifacts/{digest}.apk", headers={"Range": "bytes=3-"})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.read(), self.apk.read_bytes()[3:])
            head = urllib.request.Request(base + f"/artifacts/{digest}.apk", method="HEAD")
            with urllib.request.urlopen(head) as response:
                self.assertEqual(int(response.headers["Content-Length"]), self.apk.stat().st_size)
            for path in ("/v1/mobile/releases/delivery/latest", f"/components/{digest}.apk"):
                with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base + path)
                self.assertEqual(error.exception.code, 404)
        finally:
            public.shutdown()
            public.server_close()


if __name__ == "__main__":
    unittest.main()
