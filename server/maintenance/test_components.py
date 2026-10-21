import hashlib
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.request
import urllib.error
from service import Handler, Server
from promote_components import promote

class ComponentsTest(unittest.TestCase):
    def test_protocol5_dual_manifest_bridge_and_capability_routing(self):
        from legacy_releases import LegacyReleaseRouter
        from service import APP_IDS
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incoming, releases, artifacts = root / "incoming", root / "releases/test", root / "artifacts"
            for folder in (incoming, releases, artifacts):
                folder.mkdir(parents=True)
            data = b"protocol5 fixture"
            digest = hashlib.sha256(data).hexdigest()
            (incoming / (digest + ".zip")).write_bytes(data)
            (artifacts / (digest + ".exe")).write_bytes(data)
            base = {"version": "1.1.105", "fingerprint": "a" * 64}
            full = {"schema": 1, "appId": APP_IDS["test"], "channel": "test", "platform": "win32", "arch": "x64",
                    "version": "1.1.105", "sequence": 1, "sha256": digest, "size": len(data), "file": f"/artifacts/{digest}.exe",
                    "componentBaseProtocol": 5}
            wrap = lambda value: {"payload": json.dumps(value), "signature": "SSH-only-fixture"}
            envelope = {**wrap(full), "componentBaseEnvelope": wrap({**full, "componentBase": {**base, "dataSchema": 2, "updateProtocol": 5}})}
            (releases / "latest.json").write_text(json.dumps(envelope))
            target = {**full, "schema": 2, "version": "1.1.106", "sequence": 2, "updateProtocol": 5, "base": base, "dataSchema": 2,
                      "components": {name: {"name": name, "sha256": digest, "size": len(data), "file": f"/components/{digest}.zip"}
                                     for name in ("application", "content-engine", "product-detail", "video", "updater", "assets")}}
            candidate = incoming / "manifest.json"
            candidate.write_text(json.dumps(wrap(target)))
            self.assertTrue(promote(candidate, incoming, root)["published"])
            router = LegacyReleaseRouter(root, APP_IDS)
            modern = {"X-Xiaoxi-Update-Protocol": "5", "X-Xiaoxi-Version": "1.1.105",
                      "X-Xiaoxi-Base-Version": base["version"], "X-Xiaoxi-Base-Fingerprint": base["fingerprint"]}
            self.assertEqual(json.loads(router.latest("test", "2", modern)["payload"])["updateProtocol"], 5)
            for headers in ({}, {**modern, "X-Xiaoxi-Update-Protocol": "3"},
                            {**modern, "X-Xiaoxi-Update-Protocol": "3", "X-Xiaoxi-Bridge-Update": "1",
                             "X-Xiaoxi-Base-Version": base["version"], "X-Xiaoxi-Base-Fingerprint": base["fingerprint"]}):
                self.assertEqual(router.latest("test", "2", headers), {"empty": True})
                self.assertEqual(router.latest("test", "1", headers), envelope)
            before = (releases / "latest-components.json").read_bytes()
            for supplemental in (None, wrap({**full, "sequence": 100, "componentBase": {**base, "dataSchema": 2, "updateProtocol": 5}})):
                broken = {**envelope}
                if supplemental is None:
                    del broken["componentBaseEnvelope"]
                else:
                    broken["componentBaseEnvelope"] = supplemental
                (releases / "latest.json").write_text(json.dumps(broken))
                target.update(sequence=3, version="1.1.107")
                candidate.write_text(json.dumps(wrap(target)))
                with self.assertRaisesRegex(ValueError, "fallback|binding"):
                    promote(candidate, incoming, root)
                self.assertEqual((releases / "latest-components.json").read_bytes(), before)
            from promote import promote as promote_full
            with self.assertRaisesRegex(ValueError, "binding"):
                promote_full(releases / "latest.json", artifacts / (digest + ".exe"), root)
            later = {**full, "version": "1.1.108", "sequence": 9}
            later_envelope = {**wrap(later), "componentBaseEnvelope": wrap({**later, "componentBase": {**base, "dataSchema": 2, "updateProtocol": 5}})}
            candidate.write_text(json.dumps(later_envelope))
            self.assertTrue(promote_full(candidate, artifacts / (digest + ".exe"), root)["published"])
            self.assertEqual(json.loads((releases / "latest.json").read_text()), later_envelope)

    def test_compatible_base_bridge_and_old_client_routing(self):
        from legacy_releases import LegacyReleaseRouter
        from service import APP_IDS
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incoming, releases, artifacts = root / "incoming", root / "releases/test", root / "artifacts"
            for folder in (incoming, releases, artifacts):
                folder.mkdir(parents=True)
            data = b"verified fixture"
            digest = hashlib.sha256(data).hexdigest()
            (incoming / (digest + ".zip")).write_bytes(data)
            (artifacts / (digest + ".exe")).write_bytes(data)
            base = {"version": "1.1.90", "fingerprint": "a" * 64}
            full = {"schema": 1, "appId": APP_IDS["test"], "channel": "test", "platform": "win32", "arch": "x64",
                    "version": "1.1.97", "sequence": 1, "sha256": digest, "size": len(data), "file": f"/artifacts/{digest}.exe",
                    "componentBase": {**base, "dataSchema": 2, "updateProtocol": 4}}
            target = {**full, "schema": 2, "version": "1.1.98", "sequence": 2, "base": base, "dataSchema": 2,
                      "components": {name: {"name": name, "sha256": digest, "size": len(data), "file": f"/components/{digest}.zip"}
                                     for name in ("application", "content-engine", "product-detail", "video")}}
            wrap = lambda value: {"payload": json.dumps(value), "signature": "SSH-only-fixture"}
            (releases / "latest.json").write_text(json.dumps(wrap(full)))
            candidate = incoming / "manifest.json"
            candidate.write_text(json.dumps(wrap(target)))
            self.assertTrue(promote(candidate, incoming, root)["published"])
            router = LegacyReleaseRouter(root, APP_IDS)
            headers = {"X-Xiaoxi-Update-Protocol": "3", "X-Xiaoxi-Version": "1.1.96"}
            self.assertEqual(router.latest("test", "2", headers), {"empty": True})
            self.assertEqual(json.loads(router.latest("test", "1", headers)["payload"])["version"], "1.1.97")
            headers["X-Xiaoxi-Bridge-Update"] = "1"
            self.assertEqual(json.loads(router.latest("test", "2", headers)["payload"])["version"], "1.1.98")
            target["version"], target["sequence"], target["dataSchema"] = "1.1.99", 3, 3
            candidate.write_text(json.dumps(wrap(target)))
            with self.assertRaisesRegex(ValueError, "fallback_mismatch"):
                promote(candidate, incoming, root)

    def test_v2_pointer_range_and_monotonic_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incoming = root / "incoming"
            incoming.mkdir()
            data = b"component fixture bytes"
            digest = hashlib.sha256(data).hexdigest()
            (incoming / (digest + ".zip")).write_bytes(data)
            manifest = {"schema": 2, "appId": "com.aihuoke.desktop.test", "channel": "test", "version": "1.1.1",
                        "platform": "win32", "arch": "x64", "sequence": 1,
                        "components": {name: {"name": name, "sha256": digest, "size": len(data), "file": f"/components/{digest}.zip"}
                                       for name in ("application", "content-engine", "product-detail", "video")}}
            envelope = incoming / "manifest.json"
            def write_manifest():
                envelope.write_text(json.dumps({"payload": json.dumps(manifest), "signature": "SSH-only-fixture"}), encoding="utf-8")
            write_manifest()
            releases = root / "releases" / "test"
            releases.mkdir(parents=True)
            (releases / "latest.json").write_text('{"legacy":true}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "full_fallback_missing"):
                promote(envelope, incoming, root)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            (artifacts / (digest + ".exe")).write_bytes(data)
            def write_full():
                full = {**manifest, "schema": 1, "sha256": digest, "size": len(data), "file": f"/artifacts/{digest}.exe"}
                (releases / "latest.json").write_text(json.dumps({"payload": json.dumps(full), "signature": "SSH-only-fixture"}), encoding="utf-8")
            write_full()
            self.assertTrue(promote(envelope, incoming, root)["published"])
            with self.assertRaisesRegex(ValueError, "advance"):
                promote(envelope, incoming, root)
            (incoming / (digest + ".zip")).unlink()
            manifest.update(sequence=2, version="1.1.2")
            write_manifest()
            with self.assertRaisesRegex(ValueError, "full_fallback_mismatch"):
                promote(envelope, incoming, root)
            write_full()
            self.assertTrue(promote(envelope, incoming, root)["published"], "Already stored immutable archives are reusable")
            before = (releases / "latest-components.json").read_bytes()
            (root / "components" / (digest + ".zip")).write_bytes(b"corrupt")
            manifest.update(sequence=3, version="1.1.3")
            write_manifest()
            write_full()
            with self.assertRaisesRegex(ValueError, "hash"):
                promote(envelope, incoming, root)
            self.assertEqual((releases / "latest-components.json").read_bytes(), before)
            (root / "components" / (digest + ".zip")).write_bytes(data)
            server = Server(("127.0.0.1", 0), Handler, SimpleNamespace(root=root))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            try:
                with urllib.request.urlopen(origin + "/v1/releases/test/latest") as response:
                    self.assertEqual(json.loads(json.load(response)["payload"])["version"], "1.1.3")
                with urllib.request.urlopen(origin + "/v2/releases/test/latest") as response:
                    self.assertEqual(json.loads(json.load(response)["payload"])["version"], "1.1.2")
                artifacts = root / "artifacts"
                artifacts.mkdir(exist_ok=True)
                (artifacts / (digest + ".exe")).write_bytes(data)
                for route in (f"/components/{digest}.zip", f"/artifacts/{digest}.exe"):
                    request = urllib.request.Request(origin + route, headers={"Range": "bytes=4-"})
                    with urllib.request.urlopen(request) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.headers["Content-Range"], f"bytes 4-{len(data)-1}/{len(data)}")
                        self.assertEqual(response.read(), data[4:])
                    request = urllib.request.Request(origin + route, headers={"Range": f"bytes={len(data)}-"})
                    with self.assertRaises(urllib.error.HTTPError) as invalid:
                        urllib.request.urlopen(request)
                    self.assertEqual(invalid.exception.code, 416)
            finally:
                server.shutdown()
                server.server_close()

if __name__ == "__main__":
    unittest.main()
