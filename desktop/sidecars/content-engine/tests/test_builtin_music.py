from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.builtin_music import ASSET_ROOT, sync_builtin_music
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
            self.assertFalse(item["licenseSummary"]["evidencePresent"])
        domain = self.service.creative_domain
        selected = domain._select_auto_mix_music(
            {"bpmRange": [95, 128], "targetEnergy": .5, "moods": ["calm"]},
            required_duration_ms=60_000,
        )
        self.assertIsNotNone(selected)

    def test_all_automatic_video_paths_share_the_current_pool(self):
        domain = self.service.creative_domain
        rows = domain._music_catalog_rows()
        chosen = next(row for row in rows if "July" in row["display_name"])
        domain._automatic_music_fingerprints = (chosen["fingerprint"],)
        brief = {"moods": ["warm"], "targetEnergy": .35, "bpmRange": [80, 125]}
        self.assertEqual(chosen["track_id"], domain._select_auto_mix_music(brief, required_duration_ms=60_000)["track_id"])
        self.assertEqual(chosen["track_id"], domain.select_video_music(60)["trackId"])
        other = next(row for row in rows if row["track_id"] != chosen["track_id"])
        self.assertIsNone(domain._reusable_auto_mix_music({"music_mode": "auto", "music_track": {"track_id": other["track_id"]}}, brief, required_duration_ms=60_000, include_inactive=True))

    def test_deep_component_install_registers_all_three_recordings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / ("runtime-" + "x" * 210) / "assets"
            writable = Path("\\\\?\\" + str(root)) if os.name == "nt" else root
            try:
                shutil.copytree(ASSET_ROOT, writable)
                self.assertGreater(len(str(root / "builtin-music.v1.json")), 260)
                with patch("content_engine.builtin_music.ASSET_ROOT", root):
                    service = ContentEngineService(Path(folder) / "profile", creative_analyzer=_Analyzer(), creative_renderer=_Renderer(), start_background_jobs=False)
                try:
                    self.assertEqual(3, len(service.list_music_catalog_tracks()["items"]))
                    self.assertIsNotNone(service.creative_domain._select_auto_mix_music({}, required_duration_ms=300_000))
                finally:
                    service.close()
            finally:
                shutil.rmtree(writable.parent)

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

    def test_changed_audio_is_measured_instead_of_requiring_authorization_digest(self):
        manifest = json.loads((ASSET_ROOT / "builtin-music.v1.json").read_text(encoding="utf-8"))
        first = manifest["tracks"][0]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "builtin-music.v1.json").write_text(json.dumps({"tracks": [first]}), encoding="utf-8")
            audio = root / first["file"]
            audio.parent.mkdir(parents=True)
            audio.write_bytes(b"changed recording")
            renderer = self.service.creative_domain.renderer
            with patch("content_engine.builtin_music.ASSET_ROOT", root), patch.object(renderer, "probe_audio_duration_ms", return_value=42_000) as probe, patch.object(renderer, "measure_audio_quality", return_value={"integrated_lufs": -18.0, "true_peak_dbtp": -2.0}):
                sync_builtin_music(self.service.creative_domain)
            probe.assert_called_once()
            row = self.service.connection.execute("SELECT duration_ms FROM music_catalog_tracks_v1 WHERE fingerprint=?", (self.service.creative_domain._sha256_file(audio),)).fetchone()
            self.assertEqual(42_000, row["duration_ms"])

    def test_bad_or_missing_track_does_not_stop_fresh_engine_or_other_tracks(self):
        import shutil
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "assets"
            shutil.copytree(ASSET_ROOT, root)
            manifest = json.loads((root / "builtin-music.v1.json").read_text(encoding="utf-8"))
            (root / manifest["tracks"][0]["file"]).unlink()
            with patch("content_engine.builtin_music.ASSET_ROOT", root), self.assertLogs("content_engine.builtin_music", level="WARNING") as logs:
                service = ContentEngineService(Path(folder) / "profile", creative_analyzer=_Analyzer(), creative_renderer=_Renderer(), start_background_jobs=False)
            try:
                self.assertEqual(len(manifest["tracks"]) - 1, len(service.list_music_catalog_tracks()["items"]))
                self.assertEqual(1, len(logs.output))
            finally:
                service.close()

    def test_upgrade_deactivates_seven_old_tracks_without_deleting_records(self):
        domain = self.service.creative_domain
        retired = domain._retired_music_fingerprints[-7:]
        row = dict(self.service.connection.execute("SELECT * FROM music_catalog_tracks_v1 LIMIT 1").fetchone())
        for i, fingerprint in enumerate(retired):
            old = {**row, "id": f"old-{i}", "fingerprint": fingerprint, "managed_relative_path": f"music-catalog/old-{i}.mp3", "active": 1}
            keys = list(old)
            self.service.connection.execute("INSERT INTO music_catalog_tracks_v1(" + ",".join(keys) + ") VALUES(" + ",".join("?" for _ in keys) + ")", tuple(old[k] for k in keys))
        domain._sync_music_catalog_policy()
        self.assertEqual(3, len(self.service.list_music_catalog_tracks()["items"]))
        self.assertIsNone(domain._reusable_auto_mix_music({"music_mode": "selected", "music_track_ids": ["old-0"], "music_track": {"track_id": "old-0"}}, {}, required_duration_ms=5000, include_inactive=True))
        self.assertEqual(7, self.service.connection.execute("SELECT COUNT(*) FROM music_catalog_tracks_v1 WHERE id LIKE 'old-%' AND active=0").fetchone()[0])
        self.assertEqual(10, self.service.connection.execute("SELECT COUNT(*) FROM music_catalog_tracks_v1").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
