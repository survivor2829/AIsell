from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.builtin_music import ASSET_ROOT, sync_builtin_music
from content_engine.errors import ContentEngineError
from content_engine.service import ContentEngineService


class _Analyzer:
    capability = {"available": True, "cloud_configured": False, "provider": "test"}


class _Renderer:
    capability = {"available": True}

    def probe_audio_duration_ms(self, _path):
        raise AssertionError("Bundled recordings must use hash-bound offline measurements")

    measure_audio_quality = probe_audio_duration_ms

    def close(self, timeout_seconds=3.0):
        pass


class BuiltinMusicTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.service = ContentEngineService(
            Path(self.temporary.name), creative_analyzer=_Analyzer(),
            creative_renderer=_Renderer(), start_background_jobs=False,
        )
        self.addCleanup(self.service.close)

    def test_fresh_directory_has_verified_licensed_music_for_automatic_selection(self):
        manifest = json.loads((ASSET_ROOT / "builtin-music.v1.json").read_text(encoding="utf-8"))
        items = self.service.list_music_catalog_tracks()["items"]
        self.assertEqual(len(manifest["tracks"]), len(items))
        self.assertGreater(len(items), 0)
        for item in items:
            self.assertEqual("ready", item["analysisStatus"])
            self.assertTrue(item["licenseSummary"]["evidencePresent"])
        domain = self.service.creative_domain
        selected = domain._select_auto_mix_music(
            {"bpmRange": [95, 128], "targetEnergy": .5, "moods": ["calm"]},
            required_duration_ms=60_000,
        )
        self.assertIsNotNone(selected)

    def test_upgrade_does_not_overwrite_existing_fingerprint_or_reactivate_retirement(self):
        connection = self.service.connection
        row = connection.execute("SELECT * FROM music_catalog_tracks_v1 ORDER BY id LIMIT 1").fetchone()
        connection.execute(
            "UPDATE music_catalog_tracks_v1 SET display_name=?, source=?, active=0 WHERE id=?",
            ("客户保留的曲名", "客户导入", row["id"]),
        )
        before = [tuple(item) for item in connection.execute("SELECT * FROM music_catalog_tracks_v1 ORDER BY id")]
        sync_builtin_music(self.service.creative_domain)
        after = [tuple(item) for item in connection.execute("SELECT * FROM music_catalog_tracks_v1 ORDER BY id")]
        self.assertEqual(before, after)

    def test_changed_bundle_cannot_reuse_trusted_measurements(self):
        manifest = json.loads((ASSET_ROOT / "builtin-music.v1.json").read_text(encoding="utf-8"))
        first = manifest["tracks"][0]
        self.service.connection.execute("DELETE FROM music_catalog_tracks_v1 WHERE fingerprint=?", (first["sha256"],))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "builtin-music.v1.json").write_text(json.dumps({"tracks": [first]}), encoding="utf-8")
            audio = root / first["file"]
            audio.parent.mkdir(parents=True)
            audio.write_bytes(b"changed recording")
            with patch("content_engine.builtin_music.ASSET_ROOT", root):
                with self.assertRaises(ContentEngineError) as error:
                    sync_builtin_music(self.service.creative_domain)
            self.assertEqual("builtin_music_invalid", error.exception.code)


if __name__ == "__main__":
    unittest.main()
