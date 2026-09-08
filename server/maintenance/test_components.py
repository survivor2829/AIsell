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
            self.assertTrue(promote(envelope, incoming, root)["published"])
            with self.assertRaisesRegex(ValueError, "advance"):
                promote(envelope, incoming, root)
            (incoming / (digest + ".zip")).unlink()
            manifest.update(sequence=2, version="1.1.2")
            write_manifest()
            self.assertTrue(promote(envelope, incoming, root)["published"], "Already stored immutable archives are reusable")
            before = (releases / "latest-components.json").read_bytes()
            (root / "components" / (digest + ".zip")).write_bytes(b"corrupt")
            manifest.update(sequence=3, version="1.1.3")
            write_manifest()
            with self.assertRaisesRegex(ValueError, "hash"):
                promote(envelope, incoming, root)
            self.assertEqual((releases / "latest-components.json").read_bytes(), before)
            (root / "components" / (digest + ".zip")).write_bytes(data)
            server = Server(("127.0.0.1", 0), Handler, SimpleNamespace(root=root))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            try:
                with urllib.request.urlopen(origin + "/v1/releases/test/latest") as response:
                    self.assertTrue(json.load(response)["legacy"])
                with urllib.request.urlopen(origin + "/v2/releases/test/latest") as response:
                    self.assertEqual(json.loads(json.load(response)["payload"])["version"], "1.1.2")
                artifacts = root / "artifacts"
                artifacts.mkdir()
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
