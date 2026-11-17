"""线索视频混剪：图片和视频一起、只有图片时也要出片（2026-11-17 客户要图片+视频混剪）。"""
import unittest

from tests.test_narrated_batch import NarratedBatchTests


class MixedMediaTests(NarratedBatchTests):
    def _make_images(self, asset_ids):
        db = self.s.connection
        for asset_id in asset_ids:
            path = self.fixture.root / f"{asset_id}.jpg"
            try:
                from PIL import Image
                Image.new("RGB", (720, 1280), "#55ad81").save(path, "JPEG")
            except ImportError:
                path.write_bytes(b"\xff\xd8\xff\xd9")
            db.execute("UPDATE assets SET media_kind='image', extension='.jpg' WHERE id=?", (asset_id,))
            db.execute("UPDATE asset_locations SET absolute_path=?, size_bytes=?, modified_ns=? WHERE asset_id=?",
                       (str(path), path.stat().st_size, path.stat().st_mtime_ns, asset_id))
            db.execute("UPDATE assets SET size_bytes=? WHERE id=?", (path.stat().st_size, asset_id))
            db.execute("UPDATE media_segments SET start_ms=0, end_ms=3000 WHERE asset_id=?", (asset_id,))

    def _samples_complete(self, label):
        b = self.run_samples(self.create(3))
        done = [c for c in b["candidates"] if c["status"] == "completed"]
        self.assertTrue(done, f"{label}: no video was made — status {b['status']}, "
                              f"reasons {b.get('reasons')}, errors {[c.get('error') for c in b['candidates']]}")
        return b

    def test_images_and_videos_together(self):
        self._make_images(self.ids[1::2])
        self._samples_complete("图片+视频")

    def test_images_only(self):
        self._make_images(self.ids)
        self._samples_complete("只有图片")

    def test_videos_only_still_works(self):
        self._samples_complete("只有视频")


# Only the cases above: the inherited NarratedBatchTests cases already run in their own module.
for _name in [n for n in dir(NarratedBatchTests) if n.startswith("test_")]:
    if _name not in MixedMediaTests.__dict__:
        setattr(MixedMediaTests, _name, None)
del NarratedBatchTests

if __name__ == "__main__":
    unittest.main()
