from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.errors import ContentEngineError
from content_engine.protocol import METHODS
from content_engine.render_mix import FFmpegMixRenderer, PLATFORM_PRESETS
from content_engine.service import ContentEngineService, utc_now


class FakeRenderer:
    def __init__(self, data_dir: Path, *, fail: bool = False):
        self.data_dir = data_dir
        self.fail = fail
        self.calls = []

    @property
    def capability(self):
        return {"available": True, "code": "ready"}

    def render(self, package_id, segments, platforms, metadata):
        self.calls.append((package_id, segments, platforms, metadata))
        temp_dir = self.data_dir / "render-temp" / package_id
        temp_dir.mkdir(parents=True, exist_ok=True)
        (temp_dir / "partial.mp4").write_bytes(b"partial")
        if self.fail:
            raise ContentEngineError("render_failed", "fake renderer failure")
        package_dir = self.data_dir / "exports" / package_id
        package_dir.mkdir(parents=True, exist_ok=False)
        outputs = {}
        for platform in platforms:
            name = f"{platform}.mp4"
            (package_dir / name).write_bytes(platform.encode("ascii"))
            outputs[platform] = name
        (package_dir / "cover.jpg").write_bytes(b"cover")
        manifest = {
            "packageId": package_id,
            "title": metadata["title"],
            "description": metadata["description"],
            "platforms": list(platforms),
            "outputs": outputs,
        }
        (package_dir / "manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        for child in temp_dir.iterdir():
            child.unlink()
        temp_dir.rmdir()
        return {
            "directory": package_dir,
            "outputs": outputs,
            "cover": "cover.jpg",
            "manifest": "manifest.json",
        }


class MixRenderTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.renderer = FakeRenderer(self.data_dir)
        self.service = ContentEngineService(self.data_dir, mix_renderer=self.renderer)
        self.video_path = Path(self.temp_dir.name) / "clip.mp4"
        self.image_path = Path(self.temp_dir.name) / "still.jpg"
        self.video_path.write_bytes(b"video")
        self.image_path.write_bytes(b"image")
        self._insert_asset("asset_video", self.video_path, "video", 8_000, True)
        self._insert_asset("asset_image", self.image_path, "image", None, False)

    def tearDown(self):
        self.service.close()
        self.temp_dir.cleanup()

    def _insert_asset(self, asset_id, source, media_kind, duration_ms, has_audio):
        now = utc_now()
        self.service.connection.execute(
            """
            INSERT INTO assets(
                id, fingerprint, media_kind, extension, size_bytes, display_name,
                rights_status, created_at, updated_at, probe_status, duration_ms,
                has_audio
            ) VALUES (?, ?, ?, ?, ?, ?, 'owned', ?, ?, 'ok', ?, ?)
            """,
            (
                asset_id,
                asset_id,
                media_kind,
                source.suffix,
                source.stat().st_size,
                source.name,
                now,
                now,
                duration_ms,
                int(has_audio),
            ),
        )
        self.service.connection.execute(
            """
            INSERT INTO asset_locations(
                id, asset_id, absolute_path, size_bytes, modified_ns,
                is_available, created_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                f"location_{asset_id}",
                asset_id,
                str(source.resolve()),
                source.stat().st_size,
                source.stat().st_mtime_ns,
                now,
                now,
            ),
        )

    def _approved_candidate(self):
        project = self.service.create_mix_project(
            "render",
            [
                {
                    "name": "video",
                    "required": True,
                    "fixed_asset_id": "asset_video",
                    "target_duration_ms": 5_000,
                },
                {
                    "name": "image",
                    "required": True,
                    "fixed_asset_id": "asset_image",
                    "target_duration_ms": 3_000,
                },
            ],
            {},
        )
        candidate = self.service.generate_mix_candidates(
            project["project_id"], limit=1, seed="render"
        )["items"][0]
        self.service.review_mix_candidate(candidate["candidate_id"], "approved")
        return project, candidate

    def test_v5_target_duration_is_independent_and_estimate_caps_video(self):
        project, candidate = self._approved_candidate()

        self.assertEqual(5_000, project["slots"][0]["target_duration_ms"])
        self.assertEqual(3_000, project["slots"][1]["target_duration_ms"])
        self.assertEqual(8_000, candidate["duration_ms"])
        versions = {
            row["version"]
            for row in self.service.connection.execute(
                "SELECT version FROM schema_migrations"
            )
        }
        self.assertIn(4, versions)
        self.assertIn(5, versions)

    def test_render_persists_redacted_multiplatform_package_and_exports_queue(self):
        _project, candidate = self._approved_candidate()

        package = self.service.render_mix_candidate(
            candidate["candidate_id"], platforms=["wechat", "douyin", "kuaishou"]
        )
        listed = self.service.list_export_packages(candidate_id=candidate["candidate_id"])
        queue = self.service.list_publish_queue()["items"][0]

        self.assertEqual("exported", queue["status"])
        self.assertEqual(package["package_id"], listed["items"][0]["package_id"])
        self.assertEqual(
            {"wechat", "douyin", "kuaishou"}, set(package["platforms"])
        )
        self.assertNotIn(str(self.data_dir), json.dumps(package))
        self.assertNotIn("absolute_path", json.dumps(package))
        _package_id, segments, _platforms, metadata = self.renderer.calls[0]
        self.assertEqual([5_000, 3_000], [item["target_duration_ms"] for item in segments])
        self.assertEqual("", metadata["title"])
        self.assertEqual("", metadata["description"])

        resolved = self.service.resolve_export_package_path(package["package_id"])
        self.assertTrue(Path(resolved["absolute_path"]).is_dir())

    def test_render_failure_marks_queue_failed_cleans_partial_state_and_can_retry(self):
        _project, candidate = self._approved_candidate()
        self.renderer.fail = True

        with self.assertRaises(ContentEngineError) as raised:
            self.service.render_mix_candidate(candidate["candidate_id"])
        self.assertEqual("render_failed", raised.exception.code)
        queue = self.service.list_publish_queue()["items"][0]
        self.assertEqual("failed", queue["status"])
        self.assertEqual([], self.service.list_export_packages()["items"])
        self.assertFalse(any((self.data_dir / "render-temp").glob("*")))

        self.renderer.fail = False
        retried = self.service.render_mix_candidate(candidate["candidate_id"])
        self.assertTrue(retried["package_id"])
        self.assertEqual("exported", self.service.list_publish_queue()["items"][0]["status"])

    def test_protocol_and_presets_expose_only_supported_render_contract(self):
        self.assertEqual({"wechat", "douyin", "kuaishou"}, set(PLATFORM_PRESETS))
        for preset in PLATFORM_PRESETS.values():
            self.assertEqual((1080, 1920), (preset.width, preset.height))
            self.assertEqual(30, preset.fps)
            self.assertEqual("libx264", preset.video_codec)
            self.assertEqual("aac", preset.audio_codec)
            self.assertEqual("yuv420p", preset.pixel_format)
            self.assertTrue(preset.faststart)
        self.assertTrue(
            {
                "render_mix_candidate",
                "list_export_packages",
                "resolve_export_package_path",
            }.issubset(METHODS)
        )

    def test_ffmpeg_subprocess_is_bounded_hidden_and_never_uses_a_shell(self):
        calls = []

        def runner(args, **options):
            calls.append((args, options))
            return type("Result", (), {"returncode": 0, "stderr": ""})()

        renderer = FFmpegMixRenderer(
            self.data_dir,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            timeout_seconds=7,
            command_runner=runner,
        )
        renderer._command(["fixture-ffmpeg.exe", "-version"])

        self.assertEqual(7, calls[0][1]["timeout"])
        self.assertFalse(calls[0][1]["shell"])
        self.assertEqual("fixture-ffmpeg.exe", calls[0][0][0])

    def test_video_normalization_honors_source_time_range(self):
        calls = []

        def runner(args, **options):
            calls.append((args, options))
            return type("Result", (), {"returncode": 0, "stderr": ""})()

        renderer = FFmpegMixRenderer(
            self.data_dir,
            ffmpeg_path="fixture-ffmpeg.exe",
            ffprobe_path="fixture-ffprobe.exe",
            command_runner=runner,
        )
        source = self.data_dir / "source.mp4"
        source.write_bytes(b"video")
        output_dir = self.data_dir / "normalized"
        output_dir.mkdir()
        renderer._normalize_segment(
            {
                "path": str(source),
                "media_kind": "video",
                "has_audio": True,
                "source_start_ms": 12_500,
                "source_end_ms": 17_500,
                "target_duration_ms": 5_000,
            },
            PLATFORM_PRESETS["wechat"],
            output_dir,
            0,
        )
        command = calls[0][0]
        self.assertEqual("12.500", command[command.index("-ss") + 1])
        self.assertEqual("5.000", command[command.index("-t") + 1])


if __name__ == "__main__":
    unittest.main()
