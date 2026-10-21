import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from acquisition_sync import AcquisitionSync


def operation(op_id="op-1", version=0, name="customer", collection="enterprise"):
    return {"opId": op_id, "collection": collection, "id": "record-1", "baseVersion": version, "data": {"name": name}}


class SyncTest(unittest.TestCase):
    def test_restart_isolation_receipts_conflicts_and_atomicity(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "sync.db")
            sync = AcquisitionSync(path)
            a, b = (sync.identity(subject)["namespace"] for subject in ("A", "B"))
            first = sync.push(a, {"operations": [operation()]})
            sync.close()
            sync = AcquisitionSync(path)
            try:
                self.assertEqual(first, sync.push(a, {"operations": [operation()]}))
                self.assertEqual([], sync.pull(b, {})["records"])
                conflict = sync.push(a, {"operations": [operation("stale", name="other computer")]})
                self.assertEqual("conflict", conflict["results"][0]["status"])
                self.assertEqual("customer", conflict["results"][0]["record"]["data"]["name"])
                self.assertEqual(conflict, sync.push(a, {"operations": [operation("stale", name="other computer")]}))
                # A changed reused operation rolls back earlier operations in this transaction.
                with self.assertRaises(ValueError):
                    sync.push(a, {"operations": [operation("next", 1, "new"), operation(name="changed reuse")]})
                self.assertEqual(1, len(sync.pull(a, {})["records"]))
                sync.push(a, {"operations": [operation("next", 1, "new")]})
                page = sync.pull(a, {"limit": 1})
                self.assertTrue(page["hasMore"])
                self.assertEqual(2, sync.pull(a, {"cursor": page["cursor"]})["records"][0]["version"])
                sync.push(b, {"operations": [operation()]})  # same IDs safely belong to another account
                self.assertEqual(1, len(sync.pull(b, {})["records"]))
            finally:
                sync.close()

    def test_events_append_only_and_runtime_fields_rejected(self):
        sync = AcquisitionSync()
        try:
            for collection in ("followup", "copyEvent"):
                sync.push("A", {"operations": [operation(collection, collection=collection)]})
                rejected = sync.push("A", {"operations": [operation(collection + "-edit", 1, collection=collection)]})
                self.assertEqual("conflict", rejected["results"][0]["status"])
            for field in ("cookies", "checkpoint", "api_key", "localPath"):
                op = operation(); op["data"] = {"nested": {field: "never upload"}}
                with self.assertRaises(ValueError):
                    sync.push("A", {"operations": [op]})
            with self.assertRaises(ValueError):
                sync.handle("push", "A", {"expectedNamespace": sync.identity("B")["namespace"], "operations": [operation()]})
            with self.assertRaises(ValueError):
                sync.push("A", {"tenant": "B", "operations": [operation()]})
        finally:
            sync.close()

    def test_http_authentication_and_account_switch(self):
        from service import GatewayConfig, GatewayServer, Handler
        with tempfile.TemporaryDirectory() as folder:
            config = GatewayConfig(keys={})
            config.receipt_db_path = str(Path(folder) / "receipts")
            server = GatewayServer(("127.0.0.1", 0), Handler, config)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}/v1/provider-gateway/local-acquisition/sync/"

            def invoke(action, body, token=""):
                request = urllib.request.Request(origin + action, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
                with urllib.request.urlopen(request) as response:
                    return json.load(response)

            try:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    invoke("identity", {})
                self.assertEqual(401, error.exception.code)
                expiry = datetime.now(timezone.utc) + timedelta(hours=1)
                a = config.sessions.issue("account-A", expiry)[0]
                b = config.sessions.issue("account-B", expiry)[0]
                identity = invoke("identity", {}, a)
                self.assertNotIn("account-A", json.dumps(identity))
                namespace = identity["namespace"]
                push = {"expectedNamespace": namespace, "operations": [operation()]}
                invoke("push", push, a)
                with self.assertRaises(urllib.error.HTTPError) as error:
                    invoke("push", push, b)
                self.assertEqual(400, error.exception.code)
                b_namespace = invoke("identity", {}, b)["namespace"]
                self.assertEqual([], invoke("pull", {"expectedNamespace": b_namespace}, b)["records"])
                self.assertEqual(1, len(invoke("pull", {"expectedNamespace": namespace}, a)["records"]))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
