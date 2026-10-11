import base64
import tempfile
import unittest
import json
import threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from service import Server, Handler, Store
from materials import MaterialsStore


class MaterialsTest(unittest.TestCase):
    def test_admin_origin_and_public_catalog_http(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(folder)
            admin = Server(("127.0.0.1", 0), Handler, store, admin=True)
            public = Server(("127.0.0.1", 0), Handler, store)
            for server in (admin, public):
                threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                origin = "http://127.0.0.1:" + str(admin.server_port)
                body = dict(action="categories", categories=[{"id": "factory", "label": "工厂"}])
                request = Request(origin + "/api/materials", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
                with self.assertRaises(HTTPError) as failure:
                    urlopen(request)
                self.assertEqual(failure.exception.code, 403)
                request.add_header("Origin", origin)
                with urlopen(request) as response:
                    self.assertTrue(json.load(response)["ok"])
                with urlopen("http://127.0.0.1:" + str(public.server_port) + "/v1/materials/catalog") as response:
                    catalog = json.load(response)
                    self.assertEqual(catalog["categories"], body["categories"])
            finally:
                for server in (admin, public):
                    server.shutdown()
                    server.server_close()
                    server.materials.db.close()

    def test_publish_unpublish_and_content_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            store = MaterialsStore(folder)
            item = dict(action="upload", id="factory-example", title="工厂", category="factory", kind="image", description="示例", sourceUrl="https://example.com/source", author="Author", license="CC0", extension=".png", data=base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode())
            with self.assertRaises(ValueError):
                store.change(item)
            item.update(thumbnailData=base64.b64encode(b"\x89PNG\r\n\x1a\nthumbnail").decode(), thumbnailExtension=".png")
            store.change(item)
            self.assertEqual(store.catalog()["items"], [])
            store.change(dict(action="publish", id=item["id"]))
            published = store.catalog()["items"][0]
            self.assertNotEqual(published["thumbnailUrl"], published["downloadUrl"])
            filename = published["downloadUrl"].split("/")[-1]
            target = store.public_file(filename)
            self.assertTrue(target.is_file())
            store.change(dict(action="unpublish", id=item["id"]))
            self.assertIsNone(store.public_file(filename))
            self.assertTrue(target.is_file())
            self.assertIsNone(store.public_file("../catalog.sqlite3"))
            self.assertEqual(store.catalog()["revision"], 4)
            store.db.close()


if __name__ == "__main__":
    unittest.main()
