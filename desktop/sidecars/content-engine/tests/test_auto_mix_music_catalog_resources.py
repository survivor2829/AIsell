from __future__ import annotations

from pathlib import Path
import shutil
import sys
import unittest
import uuid
import wave


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.service import ContentEngineService


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
        self.root = SIDECAR_ROOT / f".auto-mix-music-catalog-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.service = ContentEngineService(
            self.root,
            creative_analyzer=_Analyzer(),
            creative_renderer=_Renderer(),
            start_background_jobs=False,
        )
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

    def test_managed_audio_and_evidence_survive_source_deletion_and_are_rechecked(self):
        imported = self.service.import_music_catalog_track(self._request())
        row = self._private_row()
        managed_audio = (self.root / row["managed_relative_path"]).resolve()
        managed_evidence = (
            self.root / row["managed_evidence_relative_path"]
        ).resolve()
        self.assertIn(self.root.resolve(), managed_audio.parents)
        self.assertIn(self.root.resolve(), managed_evidence.parents)
        self.assertTrue(managed_audio.is_file())
        self.assertTrue(managed_evidence.is_file())

        public_strings = self._public_strings(imported)
        for private_value in (
            str(self.music),
            str(self.evidence),
            "private-license-reference",
            row["managed_relative_path"],
            row["managed_evidence_relative_path"],
            row["fingerprint"],
            row["evidence_digest"],
        ):
            self.assertFalse(
                any(private_value in value for value in public_strings),
                private_value,
            )

        self.music.unlink()
        self.evidence.unlink()
        listed = self.service.list_music_catalog_tracks()["items"][0]
        self.assertEqual("ready", listed["analysisStatus"])
        self.assertTrue(listed["licenseSummary"]["evidencePresent"])
        selected = self.service.creative_domain._select_auto_mix_music(
            self._brief(), required_duration_ms=5_000
        )
        self.assertIsNotNone(selected)

        managed_evidence.write_bytes(b"tampered-license")
        listed = self.service.list_music_catalog_tracks()["items"][0]
        self.assertFalse(listed["licenseSummary"]["evidencePresent"])
        self.assertIsNone(
            self.service.creative_domain._select_auto_mix_music(
                self._brief(), required_duration_ms=5_000
            )
        )
        self.assertIsNone(
            self.service.creative_domain._reusable_auto_mix_music(
                {"music_track": {"track_id": selected["track_id"]}},
                self._brief(),
                required_duration_ms=5_000,
            )
        )

        managed_evidence.write_bytes(self.evidence_bytes)
        managed_audio.write_bytes(b"tampered-audio")
        listed = self.service.list_music_catalog_tracks()["items"][0]
        self.assertEqual("failed", listed["analysisStatus"])
        self.assertEqual(
            "music_managed_audio_invalid", listed["analysisErrorCode"]
        )
        self.assertIsNone(
            self.service.creative_domain._select_auto_mix_music(
                self._brief(), required_duration_ms=5_000
            )
        )
        self.assertIsNone(
            self.service.creative_domain._reusable_auto_mix_music(
                {"music_track": {"track_id": selected["track_id"]}},
                self._brief(),
                required_duration_ms=5_000,
            )
        )

    def test_reimport_is_idempotent_and_repairs_managed_copies(self):
        first = self.service.import_music_catalog_track(self._request())
        row = self._private_row()
        managed_audio = self.root / row["managed_relative_path"]
        managed_evidence = self.root / row["managed_evidence_relative_path"]
        managed_audio.write_bytes(b"tampered-audio")
        managed_evidence.write_bytes(b"tampered-license")

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
        self.assertEqual(
            repaired["evidence_digest"],
            self.service.creative_domain._sha256_file(managed_evidence),
        )
        self.assertEqual("ready", second["analysisStatus"])
        self.assertTrue(second["licenseSummary"]["evidencePresent"])


if __name__ == "__main__":
    unittest.main()
