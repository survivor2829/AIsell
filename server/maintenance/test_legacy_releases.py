import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
import zipfile

from legacy_releases import publish, validate_embedded_target
from service import APP_IDS, Handler, Server


class LegacyRoutingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.folder = self.root / "releases" / "test"
        self.folder.mkdir(parents=True)
        self.private = self.root / "fixture-only-private.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(self.private)], check=True, capture_output=True)
        subprocess.run(["openssl", "pkey", "-in", str(self.private), "-pubout", "-out", str(self.folder / "signing-public.pem")],
                       check=True, capture_output=True)
        self.full = self.full_release("1.1.79", 79)
        self.final = self.full_release("1.1.81", 81)
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("files/resources/app/src/main/legacy-update-target.json", json.dumps(self.final))
        item = self.artifact(content.getvalue(), "components", "zip")
        components = {name: {**item, "name": name, "treeSha256": "b" * 64, "fileCount": 1, "expandedSize": 10}
                      for name in ("application", "content-engine", "product-detail", "video")}
        self.bridge = self.sign({**self.identity("1.1.80", 80, 2), "base": {"version": "1.1.58", "fingerprint": "a" * 64},
                                 "minBaseVersion": "1.1.58", "dataSchema": 1, "components": components})
        self.document = {"schema": 1, "channel": "test", "sourceVersion": "1.1.64", "legacyFull": self.full,
                         "legacyComponents": self.bridge, "finalFull": self.final}
        self.candidate = self.root / "candidate.json"
        self.write(self.candidate, self.document)
        self.write(self.folder / "latest.json", self.final)
        self.write(self.folder / "latest-components.json", {"empty": True})

    @staticmethod
    def write(file, document):
        file.write_text(json.dumps(document), encoding="utf-8")

    @staticmethod
    def identity(version, sequence, schema):
        return {"schema": schema, "version": version, "sequence": sequence, "channel": "test", "appId": APP_IDS["test"],
                "platform": "win32", "arch": "x64", "notes": "fixture"}

    def sign(self, manifest):
        payload = json.dumps(manifest)
        file = self.root / "signing-input"
        file.write_bytes(payload.encode())
        signature = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(self.private), "-in", str(file)],
                                   check=True, capture_output=True).stdout
        return {"payload": payload, "signature": base64.b64encode(signature).decode()}

    def artifact(self, data, kind, suffix):
        digest = hashlib.sha256(data).hexdigest()
        folder = self.root / kind
        folder.mkdir(exist_ok=True)
        (folder / f"{digest}.{suffix}").write_bytes(data)
        return {"sha256": digest, "size": len(data), "file": f"/{kind}/{digest}.{suffix}"}

    def full_release(self, version, sequence):
        return self.sign({**self.identity(version, sequence, 1), **self.artifact(version.encode(), "artifacts", "exe")})

    def serve(self):
        server = Server(("127.0.0.1", 0), Handler, SimpleNamespace(root=self.root))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}"

    @staticmethod
    def get(origin, protocol="1", channel="test", headers=None):
        request = urllib.request.Request(f"{origin}/v{protocol}/releases/{channel}/latest", headers=headers or {})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def test_atomic_pinned_pair_and_header_channel_isolation(self):
        origin = self.serve()
        self.assertEqual(self.get(origin), self.final, "No legacy configuration preserves existing latest")
        self.assertTrue(publish(self.candidate, self.root, APP_IDS, check_only=True)["checked"])
        self.assertFalse((self.folder / "legacy-routing.json").exists())
        publish(self.candidate, self.root, APP_IDS)
        self.assertEqual(self.get(origin), self.full)
        self.assertEqual(self.get(origin, "2"), self.bridge)
        modern = {"X-Xiaoxi-Update-Protocol": "3", "X-Xiaoxi-Version": "1.1.81",
                  "X-Xiaoxi-Base-Version": "1.1.81", "X-Xiaoxi-Base-Fingerprint": "c" * 64}
        self.assertEqual(self.get(origin, headers=modern), self.final)
        self.assertEqual(self.get(origin, "2", headers=modern), {"empty": True})
        self.assertEqual(self.get(origin, channel="delivery"), {"empty": True})
        later = self.full_release("2.0.0", 200)
        self.write(self.folder / "latest.json", later)
        self.assertEqual(self.get(origin), self.full, "Ordinary publication cannot change the legacy pair")
        self.assertEqual(self.get(origin, headers=modern), later)
        for invalid in ({"X-Xiaoxi-Version": "1.1.64"}, {"X-Xiaoxi-Update-Protocol": "3"},
                        {**modern, "X-Xiaoxi-Base-Fingerprint": "bad"}):
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.get(origin, headers=invalid)
            self.assertEqual(failure.exception.code, 400)
        self.write(self.folder / "legacy-routing.json", {"schema": 1})
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.get(origin)
        self.assertEqual(failure.exception.code, 503, "Broken pinned config must not silently expose regular latest")
        self.assertEqual(self.get(origin, headers=modern), later)

    def test_reject_bad_signature_order_incomplete_and_mismatched_embedded_target(self):
        publish(self.candidate, self.root, APP_IDS)
        before = (self.folder / "legacy-routing.json").read_bytes()
        bad_documents = []
        missing = copy.deepcopy(self.document)
        del missing["legacyFull"]
        bad_documents.append(missing)
        signature = copy.deepcopy(self.document)
        signature["legacyComponents"]["signature"] = base64.b64encode(b"x" * 64).decode()
        bad_documents.append(signature)
        order = copy.deepcopy(self.document)
        order["legacyFull"] = self.final
        bad_documents.append(order)
        channel = copy.deepcopy(self.document)
        manifest = json.loads(channel["legacyComponents"]["payload"])
        manifest["channel"] = "delivery"
        channel["legacyComponents"] = self.sign(manifest)
        bad_documents.append(channel)
        target = copy.deepcopy(self.document)
        target["finalFull"] = self.full_release("1.1.82", 82)
        bad_documents.append(target)
        for document in bad_documents:
            self.write(self.candidate, document)
            with self.assertRaises(ValueError):
                publish(self.candidate, self.root, APP_IDS)
            self.assertEqual((self.folder / "legacy-routing.json").read_bytes(), before)
        self.write(self.candidate, self.document)
        file = self.root / json.loads(self.full["payload"])["file"].lstrip("/")
        file.write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "legacy_artifact"):
            publish(self.candidate, self.root, APP_IDS)
        self.assertEqual((self.folder / "legacy-routing.json").read_bytes(), before)


class EmbeddedTargetArchiveTest(unittest.TestCase):
    def test_missing_or_malformed_target_has_stable_error(self):
        for entry, payload in (("files/src/main/legacy-update-target.json", "{}"),
                               ("files/resources/app/src/main/legacy-update-target.json", "not json")):
            with self.subTest(entry=entry, payload=payload):
                content = io.BytesIO()
                with zipfile.ZipFile(content, "w") as archive:
                    archive.writestr(entry, payload)
                content.seek(0)
                with self.assertRaisesRegex(ValueError, "^legacy_embedded_target_mismatch$"):
                    validate_embedded_target(content, {})
        with self.assertRaisesRegex(ValueError, "^legacy_embedded_target_mismatch$"):
            validate_embedded_target(io.BytesIO(b"invalid zip"), {})

    @unittest.skipUnless(os.environ.get("XIAOXI_LEGACY_BRIDGE_ARCHIVE"), "requires a bridge-builder output ZIP")
    def test_bridge_builder_archive_contract(self):
        # Consume the actual desktop builder output; do not manufacture its ZIP
        # layout here. This boundary check also verifies its descriptor's bytes.
        file = Path(os.environ["XIAOXI_LEGACY_BRIDGE_ARCHIVE"])
        with zipfile.ZipFile(file) as archive:
            descriptor = json.loads(archive.read("component.json"))
            self.assertEqual(descriptor["name"], "application")
            targets = [entry for entry in descriptor["files"]
                       if entry["path"].endswith("/legacy-update-target.json")]
            self.assertEqual(len(targets), 1)
            target = targets[0]
            self.assertEqual(target["path"], "resources/app/src/main/legacy-update-target.json")
            payload = archive.read("files/" + target["path"])
            self.assertEqual(len(payload), target["size"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), target["sha256"])
        validate_embedded_target(file, json.loads(payload))


if __name__ == "__main__":
    unittest.main()
