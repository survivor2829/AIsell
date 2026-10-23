from __future__ import annotations

from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch
import uuid
import wave


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.service import ContentEngineService
from content_engine.errors import ContentEngineError


class _Analyzer:
    capability = {
        "available": True,
        "cloud_configured": False,
        "provider": "test",
    }


class _Renderer:
    capability = {"available": True}

    @staticmethod
    def probe_audio_duration_ms(_path):
        return 30_000

    @staticmethod
    def measure_audio_quality(_path):
        return {"integrated_lufs": -19.0, "true_peak_dbtp": -2.0}

    def close(self, timeout_seconds=3.0):
        return None


class AutoMixMusicCatalogResourceTests(unittest.TestCase):
    def setUp(self):
        builtin_sync = patch("content_engine.builtin_music.sync_builtin_music")
        builtin_sync.start()
        self.addCleanup(builtin_sync.stop)
        self.root = SIDECAR_ROOT / f".auto-mix-music-catalog-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.service = ContentEngineService(
            self.root,
            creative_analyzer=_Analyzer(),
            creative_renderer=_Renderer(),
            start_background_jobs=False,
        )
        self.service.creative_domain._automatic_music_fingerprints = ()
        self.music = self.root / "licensed-source.wav"
        self.evidence = self.root / "commercial-license.txt"
        self._write_wave(self.music)
        self.evidence_bytes = b"commercial-license-fixture-v1"
        self.evidence.write_bytes(self.evidence_bytes)

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def _write_wave(path):
        with wave.open(str(path), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x01\x00" * 24_000)

    def _request(self):
        return {
            "sourcePath": str(self.music),
            "displayName": "舒缓可信节奏",
            "source": "用户授权曲库",
            "commercialScope": "commercial social media",
            "commercialUseAllowed": True,
            "licenseStatus": "valid",
            "expiresAt": None,
            "credentialReference": "private-license-reference",
            "evidencePath": str(self.evidence),
            "bpm": 100,
            "moods": ["calm", "credible"],
            "energy": 0.5,
            "loopStartMs": None,
            "loopEndMs": None,
        }

    @staticmethod
    def _brief():
        return {
            "bpmRange": [80, 120],
            "targetEnergy": 0.5,
            "moods": ["calm"],
            "energyCurve": [],
            "transitionPointsMs": [],
        }

    def _private_row(self):
        return self.service.connection.execute(
            "SELECT * FROM music_catalog_tracks_v1"
        ).fetchone()

    @staticmethod
    def _public_strings(value):
        if isinstance(value, dict):
            return [
                item
                for child in value.values()
                for item in AutoMixMusicCatalogResourceTests._public_strings(child)
            ]
        if isinstance(value, list):
            return [
                item
                for child in value
                for item in AutoMixMusicCatalogResourceTests._public_strings(child)
            ]
        return [value] if isinstance(value, str) else []

    def test_managed_audio_survives_source_deletion_and_ignores_missing_evidence(self):
        request = {**self._request(), "evidencePath": str(self.root / "nonexistent-license.txt")}
        imported = self.service.import_music_catalog_track(request)
        row = self._private_row()
        managed_audio = (self.root / row["managed_relative_path"]).resolve()
        self.assertIn(self.root.resolve(), managed_audio.parents)
        self.assertTrue(managed_audio.is_file())
        self.assertIsNone(row["managed_evidence_relative_path"])
        self.assertFalse(imported["licenseSummary"]["evidencePresent"])
        self.music.unlink()
        self.evidence.unlink()
        selected = self.service.creative_domain._select_auto_mix_music(self._brief(), required_duration_ms=5000)
        self.assertIsNotNone(selected)
        for private_value in (str(self.music), "private-license-reference", row["managed_relative_path"], row["fingerprint"]):
            self.assertFalse(any(private_value in value for value in self._public_strings(imported)))
        managed_audio.write_bytes(b"tampered-audio")
        listed = self.service.list_music_catalog_tracks()["items"][0]
        self.assertEqual("failed", listed["analysisStatus"])
        self.assertIsNone(self.service.creative_domain._select_auto_mix_music(self._brief(), required_duration_ms=5000))
        self.assertIsNone(self.service.creative_domain._reusable_auto_mix_music({"music_track": {"track_id": selected["track_id"]}}, self._brief(), required_duration_ms=5000))

    def test_retired_recording_stays_out_of_new_selection_without_revoking_history(self):
        item = self.service.import_music_catalog_track(self._request())
        row = self._private_row()
        domain = self.service.creative_domain
        domain._retired_music_fingerprints = (row["fingerprint"],)
        domain._sync_music_catalog_policy()
        self.assertEqual([], self.service.list_music_catalog_tracks()["items"])
        self.assertIsNone(domain._select_auto_mix_music(self._brief(), required_duration_ms=5000))
        state = {"music_track": {"track_id": item["trackId"]}}
        self.assertIsNone(domain._reusable_auto_mix_music(state, self._brief(), required_duration_ms=5000))
        self.assertIsNone(domain._reusable_auto_mix_music(state, self._brief(), required_duration_ms=5000, include_inactive=True))
        self.assertEqual("valid", self._private_row()["license_status"])
        self.assertTrue((self.root / row["managed_relative_path"]).is_file())
        with self.assertRaises(ContentEngineError) as error:
            self.service.import_music_catalog_track(self._request())
        self.assertEqual("music_track_retired", error.exception.code)
        settings = {"music_mode": "selected", "music_track_ids": [item["trackId"]]}
        self.assertTrue(domain.normalize_music_settings(settings))
        self.assertEqual({"music_mode": "auto", "music_track_ids": []}, settings)
        self.service.close()
        self.service = ContentEngineService(self.root, creative_analyzer=_Analyzer(), creative_renderer=_Renderer(), start_background_jobs=False)
        self.assertEqual([], self.service.list_music_catalog_tracks()["items"])

    def test_reimport_is_idempotent_and_repairs_managed_copies(self):
        first = self.service.import_music_catalog_track(self._request())
        row = self._private_row()
        managed_audio = self.root / row["managed_relative_path"]
        managed_audio.write_bytes(b"tampered-audio")

        second = self.service.import_music_catalog_track(self._request())
        count = self.service.connection.execute(
            "SELECT COUNT(*) FROM music_catalog_tracks_v1"
        ).fetchone()[0]
        repaired = self._private_row()
        self.assertEqual(first["trackId"], second["trackId"])
        self.assertEqual(1, count)
        self.assertEqual(
            repaired["fingerprint"],
            self.service.creative_domain._sha256_file(managed_audio),
        )
        self.assertEqual("ready", second["analysisStatus"])
        self.assertFalse(second["licenseSummary"]["evidencePresent"])

    def test_user_authorized_import_needs_no_evidence_file(self):
        request = self._request()
        request.pop("credentialReference")
        request.pop("evidencePath")
        item = self.service.import_music_catalog_track(request)
        self.assertEqual("ready", item["analysisStatus"])
        self.assertFalse(item["licenseSummary"]["evidencePresent"])
        self.assertIsNotNone(self.service.creative_domain._select_auto_mix_music(self._brief(), required_duration_ms=5_000))


if __name__ == "__main__":
    unittest.main()
