import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from service import Handler, Server, Store
from tutorials import TutorialsStore, MAX_VIDEO


class TutorialsTest(unittest.TestCase):
    def test_admin_upload_publish_seek_and_unpublish(self):
        # A real, existing 12-second MP4 exercises moov timing and byte ranges.
        seed = Path(__file__).resolve().parents[2] / "desktop/resources/official-materials"
        video = (seed / "robot-quadruped.mp4").read_bytes()
        cover = (seed / "robot-quadruped-thumb.jpg").read_bytes()
        with tempfile.TemporaryDirectory() as folder:
            store = Store(folder)
            admin = Server(("127.0.0.1", 0), Handler, store, admin=True)
            public = Server(("127.0.0.1", 0), Handler, store)
            for server in (admin, public):
                threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{admin.server_port}"
            api = f"http://127.0.0.1:{public.server_port}"

            def upload(raw, kind, mime, same_origin=True):
                headers = {"Content-Type": mime, **({"Origin": origin} if same_origin else {})}
                return json.load(urlopen(Request(origin + "/api/tutorials/files?kind=" + kind, data=raw, headers=headers)))

            def change(body):
                return json.load(urlopen(Request(origin + "/api/tutorials", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Origin": origin})))

            try:
                with self.assertRaises(HTTPError) as failure:
                    upload(cover, "cover", "image/jpeg", same_origin=False)
                self.assertEqual(failure.exception.code, 403)
                movie = upload(video, "video", "video/mp4")
                with self.assertRaises(HTTPError) as unsupported_codec:
                    upload(video.replace(b"avc1", b"hvc1"), "video", "video/mp4")
                self.assertEqual(unsupported_codec.exception.code, 400)
                image = upload(cover, "cover", "image/jpeg")
                self.assertGreater(movie["durationSeconds"], 12)
                self.assertLess(movie["durationSeconds"], 13)
                change(dict(action="save", id="first-guide", title="单项操作录屏", category="short-video", topic="digital-human", video=movie["file"], cover=image["file"]))
                self.assertEqual(json.load(urlopen(api + "/v1/tutorials/catalog"))["items"], [])
                change(dict(action="publish", id="first-guide"))
                catalog = json.load(urlopen(api + "/v1/tutorials/catalog"))
                self.assertEqual(catalog["items"][0]["title"], "单项操作录屏")
                video_url = api + catalog["items"][0]["video"]["url"]
                for header, expected in (("bytes=100-199", video[100:200]), ("bytes=-64", video[-64:])):
                    with urlopen(Request(video_url, headers={"Range": header})) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.read(), expected)
                with self.assertRaises(HTTPError) as invalid_range:
                    urlopen(Request(video_url, headers={"Range": "bytes=999999999-"}))
                self.assertEqual(invalid_range.exception.code, 416)
                change(dict(action="unpublish", id="first-guide"))
                with self.assertRaises(HTTPError) as missing:
                    urlopen(video_url)
                self.assertEqual(missing.exception.code, 404)
                self.assertTrue((Path(folder) / "tutorials" / movie["file"]).is_file())
                self.assertEqual(json.load(urlopen(origin + "/api/tutorials"))["items"][0]["published"], False)
                with self.assertRaises(HTTPError) as private:
                    urlopen(api + "/api/tutorials")
                self.assertEqual(private.exception.code, 404)
            finally:
                for server in (admin, public):
                    server.shutdown()
                    server.server_close()

    def test_incomplete_invalid_and_oversize_upload_leave_no_partial_file(self):
        with tempfile.TemporaryDirectory() as folder:
            store = TutorialsStore(folder)
            try:
                for raw, length in ((b"not-an-mp4", 10), (b"\0\0\0\x18ftyp", 100), (b"", MAX_VIDEO + 1)):
                    with self.assertRaises(ValueError):
                        store.upload(io.BytesIO(raw), length, "video", "video/mp4")
                self.assertEqual(list(store.root.glob("*.upload")), [])
                self.assertEqual(store.db.execute("SELECT COUNT(*) FROM files").fetchone()[0], 0)
            finally:
                store.db.close()


if __name__ == "__main__":
    unittest.main()
