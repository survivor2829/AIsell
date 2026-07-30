from __future__ import annotations

import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock
import sys


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.database import Database
from content_engine.errors import ContentEngineError
from content_engine.media_probe import (
    FFprobeAdapter,
    MAX_DURATION_MS,
    parse_ffprobe_payload,
)
from content_engine.protocol import METHODS, serve_jsonl
from content_engine.service import ContentEngineService


def assert_public_payload(test_case: unittest.TestCase, payload, private_path: Path):
    encoded = json.dumps(payload, ensure_ascii=False)
    test_case.assertNotIn(str(private_path.resolve()), encoded)
    test_case.assertNotIn("absolute_path", encoded)


class AssetMetadataMigrationTests(unittest.TestCase):
    def test_existing_v1_database_is_upgraded_idempotently(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = Path(temp_dir)
            db_path = data_dir / "content-engine.sqlite3"
            connection = sqlite3.connect(db_path)
            connection.executescript(
                """
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT (
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    )
                );
                INSERT INTO schema_migrations(version, name)
                VALUES (1, 'initial_content_engine_schema');
                CREATE TABLE assets (
                    id TEXT PRIMARY KEY,
                    fingerprint TEXT NOT NULL,
                    full_fingerprint TEXT,
                    media_kind TEXT NOT NULL CHECK (media_kind IN ('video', 'image')),
                    extension TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
                    display_name TEXT NOT NULL,
                    rights_status TEXT NOT NULL DEFAULT 'unknown',
                    archived_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO assets(
                    id, fingerprint, media_kind, extension, size_bytes,
                    display_name, rights_status, created_at, updated_at
                ) VALUES (
                    'asset_legacy', 'fingerprint', 'video', '.mp4', 12,
                    'legacy.mp4', 'consented', '2026-01-01T00:00:00Z',
                    '2026-01-01T00:00:00Z'
                );
                """
            )
            connection.commit()
            connection.close()

            first = Database(data_dir).open()
            columns = {
                row["name"] for row in first.connection.execute("PRAGMA table_info(assets)")
            }
            legacy = first.connection.execute(
                """
                SELECT probe_status, duration_ms, width, height, fps, has_audio,
                       probe_error_code, probed_at, rights_status
                FROM assets WHERE id = 'asset_legacy'
                """
            ).fetchone()
            first.close()

            second = Database(data_dir).open()
            migration_count = second.connection.execute(
                "SELECT COUNT(*) FROM schema_migrations WHERE version IN (2, 3)"
            ).fetchone()[0]
            second.close()

            self.assertTrue(
                {
                    "probe_status",
                    "duration_ms",
                    "width",
                    "height",
                    "fps",
                    "has_audio",
                    "probe_error_code",
                    "probed_at",
                }.issubset(columns)
            )
            self.assertEqual("pending", legacy["probe_status"])
            self.assertIsNone(legacy["duration_ms"])
            self.assertEqual("unknown", legacy["rights_status"])
            self.assertEqual(2, migration_count)


class MediaMetadataServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.source_dir = self.root / "source"
        self.source_dir.mkdir()
        self.fake_probe = self.root / "fake-ffprobe.exe"
        self.fake_probe.write_bytes(b"fake executable")
        self.unavailable_probe = FFprobeAdapter(auto_discover=False)
        self.service = ContentEngineService(
            self.root / "data", media_probe=self.unavailable_probe
        )

    def tearDown(self):
        self.service.close()
        self.temp_dir.cleanup()

    def _import(self, name: str = "lesson.mp4"):
        source = self.source_dir / name
        source.write_bytes(("video bytes:" + name).encode("utf-8"))
        asset = self.service.import_files([str(source)])["items"][0]
        return source, asset

    @staticmethod
    def _video_payload():
        return {
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30000/1001",
                    "duration": "12.345",
                },
                {"codec_type": "audio"},
            ],
            "format": {"duration": "12.345"},
        }

    def _use_fake_probe(self):
        self.service.media_probe = FFprobeAdapter(self.fake_probe)

    def test_fake_probe_saves_safe_video_metadata_without_exposing_paths(self):
        source, asset = self._import()
        self._use_fake_probe()
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps(self._video_payload()), stderr=""
        )
        with mock.patch(
            "content_engine.media_probe.subprocess.run", return_value=completed
        ) as run:
            result = self.service.probe_asset(asset["asset_id"])

        self.assertEqual("ok", result["probe_status"])
        self.assertEqual(12_345, result["duration_ms"])
        self.assertEqual(1920, result["width"])
        self.assertEqual(1080, result["height"])
        self.assertAlmostEqual(29.97003, result["fps"], places=5)
        self.assertTrue(result["has_audio"])
        self.assertIsNone(result["probe_error_code"])
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertIsInstance(run.call_args.args[0], list)
        assert_public_payload(self, result, source)

    def test_capability_gate_preserves_pending_then_failures_are_bounded(self):
        source, asset = self._import()

        with self.assertRaises(ContentEngineError) as unavailable:
            self.service.probe_asset(asset["asset_id"])
        self.assertEqual("capability_unavailable", unavailable.exception.code)
        pending = self.service.list_assets()["items"][0]
        self.assertEqual("pending", pending["probe_status"])
        self.assertIsNone(pending["probe_error_code"])

        self._use_fake_probe()
        with mock.patch(
            "content_engine.media_probe.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["ffprobe"], timeout=1),
        ):
            timed_out = self.service.probe_asset(asset["asset_id"])
        self.assertEqual("failed", timed_out["probe_status"])
        self.assertEqual("ffprobe_timeout", timed_out["probe_error_code"])

        invalid = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="{not-json", stderr=str(source)
        )
        with mock.patch(
            "content_engine.media_probe.subprocess.run", return_value=invalid
        ):
            bad_output = self.service.probe_asset(asset["asset_id"])
        self.assertEqual("failed", bad_output["probe_status"])
        self.assertEqual("ffprobe_invalid_output", bad_output["probe_error_code"])
        for payload in (pending, timed_out, bad_output):
            assert_public_payload(self, payload, source)

    def test_probe_pending_requires_capability_and_has_a_hard_limit(self):
        first, _ = self._import("first.mp4")
        second, _ = self._import("second.mp4")

        with self.assertRaises(ContentEngineError) as unavailable:
            self.service.probe_pending()
        self.assertEqual("capability_unavailable", unavailable.exception.code)
        self.assertTrue(
            all(
                item["probe_status"] == "pending"
                for item in self.service.list_assets()["items"]
            )
        )

        self._use_fake_probe()
        with self.assertRaises(ContentEngineError) as too_large:
            self.service.probe_pending(limit=11)
        self.assertEqual("invalid_limit", too_large.exception.code)

        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps(self._video_payload()), stderr=""
        )
        with mock.patch(
            "content_engine.media_probe.subprocess.run", return_value=completed
        ):
            first_batch = self.service.probe_pending(limit=1)
            second_batch = self.service.probe_pending()

        self.assertEqual(1, first_batch["processed_count"])
        self.assertEqual(1, first_batch["remaining_count"])
        self.assertEqual(1, second_batch["processed_count"])
        self.assertEqual(0, second_batch["remaining_count"])
        self.assertTrue(
            all(
                item["probe_status"] == "ok"
                for item in first_batch["items"] + second_batch["items"]
            )
        )
        assert_public_payload(self, first_batch, first)
        assert_public_payload(self, second_batch, second)

    def test_rights_whitelist_and_probe_metadata_survive_restart(self):
        source, asset = self._import()
        licensed = self.service.update_asset_rights(asset["asset_id"], " LICENSED ")
        self.assertEqual("licensed", licensed["rights_status"])
        with self.assertRaisesRegex(ContentEngineError, "allowed"):
            self.service.update_asset_rights(asset["asset_id"], "public-domain-ish")
        with self.assertRaises(ContentEngineError) as consented:
            self.service.update_asset_rights(asset["asset_id"], "consented")
        self.assertEqual("invalid_rights_status", consented.exception.code)

        self._use_fake_probe()
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps(self._video_payload()), stderr=""
        )
        with mock.patch(
            "content_engine.media_probe.subprocess.run", return_value=completed
        ):
            self.service.probe_asset(asset["asset_id"])
        self.service.close()
        self.service = ContentEngineService(
            self.root / "data", media_probe=self.unavailable_probe
        )

        restored = self.service.list_assets()["items"][0]
        self.assertEqual("licensed", restored["rights_status"])
        self.assertEqual("ok", restored["probe_status"])
        self.assertEqual(12_345, restored["duration_ms"])
        assert_public_payload(self, restored, source)

    def test_removed_source_is_refreshed_as_unavailable_without_copying(self):
        source, asset = self._import()
        source.unlink()

        listed = self.service.list_assets()["items"][0]

        self.assertEqual(0, listed["available_location_count"])
        self.assertEqual("pending", listed["probe_status"])
        self.assertFalse(any((self.root / "data").rglob("lesson.mp4")))
        assert_public_payload(self, listed, source)

    def test_moved_source_is_refreshed_as_unavailable_without_touching_new_path(self):
        source, _ = self._import()
        moved = self.source_dir / "moved-lesson.mp4"
        source.rename(moved)

        listed = self.service.list_assets()["items"][0]

        self.assertEqual(0, listed["available_location_count"])
        self.assertTrue(moved.is_file())
        self.assertEqual(b"video bytes:lesson.mp4", moved.read_bytes())
        self.assertFalse(any((self.root / "data").rglob("moved-lesson.mp4")))
        assert_public_payload(self, listed, source)
        assert_public_payload(self, listed, moved)

    def test_protocol_exposes_probe_and_rights_methods_without_paths(self):
        source, asset = self._import()
        requests = "\n".join(
            [
                json.dumps(
                    {
                        "id": "rights-1",
                        "method": "update_asset_rights",
                        "params": {
                            "asset_id": asset["asset_id"],
                            "rights_status": "owned",
                        },
                    }
                ),
                json.dumps(
                    {
                        "id": "probe-1",
                        "method": "probe_asset",
                        "params": {"asset_id": asset["asset_id"]},
                    }
                ),
                json.dumps({"id": "stop-1", "method": "shutdown"}),
            ]
        )
        output = io.StringIO()
        serve_jsonl(self.service, input_stream=io.StringIO(requests), output_stream=output)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]

        self.assertTrue({"probe_asset", "probe_pending", "update_asset_rights"} <= METHODS.keys())
        self.assertEqual(
            self.service.media_probe.available,
            responses[0]["capabilities"]["asset_media_probe"],
        )
        self.assertEqual("owned", responses[1]["result"]["rights_status"])
        self.assertFalse(responses[2]["ok"])
        self.assertEqual("capability_unavailable", responses[2]["error"]["code"])
        self.assertEqual(
            "pending", self.service.list_assets()["items"][0]["probe_status"]
        )
        for response in responses:
            assert_public_payload(self, response, source)


class MediaPayloadBoundsTests(unittest.TestCase):
    def test_image_uses_only_dimensions_and_never_claims_audio(self):
        result = parse_ffprobe_payload(
            {
                "streams": [
                    {"codec_type": "video", "width": "800", "height": "600"},
                    {"codec_type": "audio"},
                ],
                "format": {"duration": "999"},
            },
            "image",
        )
        self.assertEqual("ok", result.status)
        self.assertEqual(800, result.width)
        self.assertEqual(600, result.height)
        self.assertIsNone(result.duration_ms)
        self.assertIsNone(result.fps)
        self.assertFalse(result.has_audio)

    def test_out_of_range_numbers_are_rejected(self):
        payloads = (
            {
                "streams": [
                    {"codec_type": "video", "width": 32_769, "height": 1080}
                ]
            },
            {
                "streams": [
                    {
                        "codec_type": "video",
                        "width": 1920,
                        "height": 1080,
                        "avg_frame_rate": "1001",
                    }
                ]
            },
            {
                "streams": [
                    {"codec_type": "video", "width": 1920, "height": 1080}
                ],
                "format": {"duration": str(MAX_DURATION_MS / 1000 + 1)},
            },
        )
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                parse_ffprobe_payload(payload, "video")


if __name__ == "__main__":
    unittest.main()
