from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import json
import shutil
import sys
import unittest
from unittest import mock
import uuid


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from content_engine.creative_analysis import (  # noqa: E402
    LOCAL_VISUAL_SIGNAL_VERSION,
    FFmpegCreativeAnalyzer,
)
from content_engine.auto_mix_v2 import build_material_timeline  # noqa: E402
from content_engine.creative_domain import CreativeDomain  # noqa: E402
from content_engine.database import Database  # noqa: E402


class OfflineCloudClient:
    configured = False
    asr_model = "offline-asr"
    vision_model = "offline-vision"


def checkerboard(*, brighten: int = 0) -> bytes:
    pixels = []
    for row in range(64):
        for column in range(64):
            value = 32 if (row // 4 + column // 4) % 2 else 220
            pixels.append(min(255, value + brighten))
    return bytes(pixels)


class CreativeVisualSignalTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".auto-mix-visual-signals-{uuid.uuid4().hex}"
        self.root.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_local_frame_evidence_detects_black_blur_and_real_visual_content(self):
        black = FFmpegCreativeAnalyzer._frame_visual_evidence(bytes(64 * 64))
        blurred = FFmpegCreativeAnalyzer._frame_visual_evidence(
            bytes(96 + column // 8 for _row in range(64) for column in range(64))
        )
        detailed = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())

        self.assertTrue(black["black_screen"])
        self.assertFalse(black["severe_blur"])
        self.assertTrue(black["meaningless"])
        self.assertTrue(blurred["severe_blur"])
        self.assertFalse(blurred["black_screen"])
        self.assertFalse(detailed["black_screen"])
        self.assertFalse(detailed["severe_blur"])
        self.assertFalse(detailed["meaningless"])
        self.assertRegex(detailed["perceptual_hash"], r"^[0-9a-f]{16}$")

    def test_perceptual_signature_is_stable_across_assets_and_small_brightness_change(self):
        first = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())
        second = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())
        slightly_brighter = FFmpegCreativeAnalyzer._frame_visual_evidence(
            checkerboard(brighten=2)
        )

        self.assertEqual(first["perceptual_hash"], second["perceptual_hash"])
        self.assertEqual(first["perceptual_hash"], slightly_brighter["perceptual_hash"])
        self.assertEqual(
            f"dhash64:{first['perceptual_hash']}", first["content_signature"]
        )

    def test_identical_temporal_samples_mark_freeze_from_real_pixel_evidence(self):
        def fake_ffmpeg(args, **_kwargs):
            output = Path(args[-1])
            if "rawvideo" in args:
                output.write_bytes(checkerboard())
            else:
                output.write_bytes(b"image-fixture")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        analyzer = FFmpegCreativeAnalyzer(
            self.root / "data",
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=OfflineCloudClient(),
            command_runner=fake_ffmpeg,
        )
        frames = analyzer._extract_frames(
            self.root / "source.mp4", self.root / "frames", 30_000
        )

        self.assertEqual(3, len(frames))
        self.assertTrue(all(item["visual_evidence"]["status"] == "measured" for item in frames))
        self.assertTrue(all(item["visual_evidence"]["frozen"] for item in frames))
        self.assertEqual(
            1,
            len({item["visual_evidence"]["content_signature"] for item in frames}),
        )

    def test_analysis_populates_every_segment_with_measured_visual_signals(self):
        def fake_ffmpeg(args, **_kwargs):
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            if "rawvideo" in args:
                if output.name == "visual-evidence.gray":
                    frame_count = int(args[args.index("-frames:v") + 1])
                    output.write_bytes(checkerboard() * frame_count)
                else:
                    output.write_bytes(checkerboard())
            else:
                output.write_bytes(b"media-fixture")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        source = self.root / "source.mp4"
        source.write_bytes(b"source-fixture")
        analyzer = FFmpegCreativeAnalyzer(
            self.root / "data",
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=OfflineCloudClient(),
            command_runner=fake_ffmpeg,
        )

        outcome = analyzer.analyze(
            asset={
                "id": "asset-one",
                "fingerprint": "fingerprint-one",
                "media_kind": "video",
                "duration_ms": 30_000,
                "has_audio": False,
            },
            source_path=source,
            task_id="task-one",
            profile={"workflow": "auto_mix_v2"},
            should_stop=lambda: False,
        )

        self.assertGreater(len(outcome["segments"]), 0)
        self.assertEqual(6, len(outcome["segments"]))
        for segment in outcome["segments"]:
            metadata = segment["metadata"]
            self.assertEqual(LOCAL_VISUAL_SIGNAL_VERSION, metadata["visual_signal_version"])
            self.assertEqual("measured", metadata["visual_signal_status"])
            self.assertIsInstance(metadata["black_screen"], bool)
            self.assertIsInstance(metadata["severe_blur"], bool)
            self.assertIsInstance(metadata["frozen"], bool)
            self.assertIsInstance(metadata["meaningless"], bool)
            self.assertRegex(metadata["perceptual_hash"], r"^[0-9a-f]{16}$")
            self.assertEqual(
                f"dhash64-sequence:{metadata['perceptual_hash']}",
                metadata["content_signature"],
            )
            self.assertGreaterEqual(
                metadata["visual_signal_evidence"]["sample_count"], 2
            )

    def test_segment_evidence_catches_black_lead_and_avoids_single_frame_dedupe(self):
        black = FFmpegCreativeAnalyzer._frame_visual_evidence(bytes(64 * 64))
        middle = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())
        alternate = FFmpegCreativeAnalyzer._frame_visual_evidence(
            bytes(
                48 if (row // 8 + column // 2) % 2 else 204
                for row in range(64)
                for column in range(64)
            )
        )
        for evidence in (black, middle, alternate):
            evidence["frozen"] = False

        def one_segment(last_evidence):
            return FFmpegCreativeAnalyzer._segments(
                5_000,
                [],
                [],
                [
                    {"timestamp_ms": 0, "visual_evidence": black},
                    {"timestamp_ms": 2_500, "visual_evidence": middle},
                    {"timestamp_ms": 4_999, "visual_evidence": last_evidence},
                ],
                fallback_step_ms=5_000,
            )[0]

        first = one_segment(middle)
        second = one_segment(alternate)

        self.assertTrue(first["metadata"]["black_screen"])
        self.assertTrue(first["metadata"]["meaningless"])
        self.assertNotEqual(
            first["metadata"]["content_signature"],
            second["metadata"]["content_signature"],
        )

    def test_v2_uses_visual_windows_and_never_signs_one_in_range_sample(self):
        black = FFmpegCreativeAnalyzer._frame_visual_evidence(bytes(64 * 64))
        middle = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())
        alternate = FFmpegCreativeAnalyzer._frame_visual_evidence(
            bytes(
                48 if (row // 8 + column // 2) % 2 else 204
                for row in range(64)
                for column in range(64)
            )
        )
        for evidence in (black, middle, alternate):
            evidence["frozen"] = False
        sentences = [
            {
                "start_ms": 100,
                "end_ms": 900,
                "transcript": "第一句",
                "speaker": "甲",
                "metadata": {},
            },
            {
                "start_ms": 1_000,
                "end_ms": 1_800,
                "transcript": "第二句",
                "speaker": "甲",
                "metadata": {},
            },
            {
                "start_ms": 5_100,
                "end_ms": 5_800,
                "transcript": "第三句",
                "speaker": "乙",
                "metadata": {},
            },
        ]
        frames = [
            {"timestamp_ms": 0, "visual_evidence": black},
            {"timestamp_ms": 2_500, "visual_evidence": middle},
            {"timestamp_ms": 4_999, "visual_evidence": alternate},
            {"timestamp_ms": 5_000, "visual_evidence": middle},
        ]

        segments = FFmpegCreativeAnalyzer._segments(
            6_000,
            sentences,
            [],
            frames,
            {},
            fallback_step_ms=5_000,
            fixed_visual_windows=True,
        )

        self.assertEqual(
            [(0, 5_000), (5_000, 6_000)],
            [(item["start_ms"], item["end_ms"]) for item in segments],
        )
        self.assertEqual("第一句 第二句", segments[0]["transcript"])
        self.assertEqual("第三句", segments[1]["transcript"])
        self.assertTrue(segments[0]["metadata"]["black_screen"])
        self.assertEqual(
            [0, 2_500, 4_999],
            segments[0]["metadata"]["visual_signal_evidence"]["timestamps_ms"],
        )
        self.assertIsNotNone(segments[0]["metadata"]["content_signature"])
        self.assertEqual(
            [5_000],
            segments[1]["metadata"]["visual_signal_evidence"]["timestamps_ms"],
        )
        self.assertEqual(
            1,
            segments[1]["metadata"]["visual_signal_evidence"]["measured_count"],
        )
        self.assertIsNone(segments[1]["metadata"]["content_signature"])

    def test_v2_bulk_evidence_covers_every_full_window_after_240_seconds(self):
        calls = []

        def fake_ffmpeg(args, **_kwargs):
            calls.append(list(args))
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            frame_count = int(args[args.index("-frames:v") + 1])
            output.write_bytes(
                b"".join(
                    checkerboard(brighten=index % 2)
                    for index in range(frame_count)
                )
            )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        analyzer = FFmpegCreativeAnalyzer(
            self.root / "data",
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=OfflineCloudClient(),
            command_runner=fake_ffmpeg,
        )
        duration_ms = 245_000
        evidence_frames = analyzer._extract_visual_evidence_frames(
            self.root / "long-source.mp4", self.root / "bulk", duration_ms
        )

        self.assertEqual(1, len(calls))
        self.assertIn("fps=fps=1/2:start_time=0", calls[0][calls[0].index("-vf") + 1])
        self.assertEqual(123, len(evidence_frames))
        thumbnails = [
            {"timestamp_ms": round(duration_ms * (index + 1) / 13)}
            for index in range(12)
        ]
        segments = FFmpegCreativeAnalyzer._segments(
            duration_ms,
            [
                {
                    "start_ms": 100,
                    "end_ms": 900,
                    "transcript": "开场事实",
                    "speaker": "",
                    "metadata": {},
                },
                {
                    "start_ms": 241_000,
                    "end_ms": 241_800,
                    "transcript": "结尾事实",
                    "speaker": "",
                    "metadata": {},
                },
            ],
            [],
            thumbnails,
            {},
            fallback_step_ms=5_000,
            fixed_visual_windows=True,
            evidence_frames=evidence_frames,
        )

        self.assertEqual(49, len(segments))
        for segment in segments:
            timestamps = segment["metadata"]["visual_signal_evidence"][
                "timestamps_ms"
            ]
            self.assertGreaterEqual(len(timestamps), 2)
            self.assertTrue(
                all(
                    segment["start_ms"] <= timestamp < segment["end_ms"]
                    for timestamp in timestamps
                )
            )
            self.assertIsNotNone(segment["metadata"]["content_signature"])
        self.assertEqual("开场事实", segments[0]["transcript"])
        self.assertEqual("结尾事实", segments[-1]["transcript"])

    def test_v1_keeps_asr_sentence_boundaries(self):
        evidence = FFmpegCreativeAnalyzer._frame_visual_evidence(checkerboard())
        sentences = [
            {
                "start_ms": 100,
                "end_ms": 900,
                "transcript": "第一句",
                "speaker": "",
                "metadata": {},
            },
            {
                "start_ms": 1_000,
                "end_ms": 1_800,
                "transcript": "第二句",
                "speaker": "",
                "metadata": {},
            },
        ]
        segments = FFmpegCreativeAnalyzer._segments(
            3_000,
            sentences,
            [],
            [{"timestamp_ms": 0, "visual_evidence": evidence}],
            {},
        )

        self.assertEqual(
            [(100, 900), (1_000, 1_800)],
            [(item["start_ms"], item["end_ms"]) for item in segments],
        )

    def test_failed_optional_probe_is_explicitly_unknown_and_never_claims_bad_media(self):
        def fake_ffmpeg(args, **_kwargs):
            output = Path(args[-1])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"not-a-4096-byte-gray-frame")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        source = self.root / "source.mp4"
        source.write_bytes(b"source-fixture")
        analyzer = FFmpegCreativeAnalyzer(
            self.root / "data",
            ffmpeg_path="ffmpeg-fixture",
            cloud_client=OfflineCloudClient(),
            command_runner=fake_ffmpeg,
        )

        outcome = analyzer.analyze(
            asset={
                "id": "asset-unknown",
                "fingerprint": "fingerprint-unknown",
                "media_kind": "video",
                "duration_ms": 30_000,
                "has_audio": False,
            },
            source_path=source,
            task_id="task-unknown",
            profile={"workflow": "auto_mix_v2"},
            should_stop=lambda: False,
        )

        for segment in outcome["segments"]:
            metadata = segment["metadata"]
            self.assertEqual("unavailable", metadata["visual_signal_status"])
            for key in (
                "black_screen",
                "severe_blur",
                "frozen",
                "meaningless",
                "perceptual_hash",
                "content_signature",
            ):
                self.assertIsNone(metadata[key])

    def test_v2_asset_cards_fail_closed_for_unmeasured_visual_windows(self):
        data_dir = self.root / "domain"
        database = Database(data_dir).open()
        try:
            with mock.patch(
                "content_engine.creative_domain.configured_voice_personas",
                return_value=[],
            ):
                domain = CreativeDomain(
                    database,
                    new_id=lambda prefix: f"{prefix}-test",
                    now=lambda: "2026-08-24T00:00:00.000Z",
                    analyzer=SimpleNamespace(capability={"provider": "test"}),
                    renderer=SimpleNamespace(capability={"available": True}),
                )
            now = "2026-08-24T00:00:00.000Z"
            database.connection.execute(
                """
                INSERT INTO assets(
                    id, fingerprint, full_fingerprint, media_kind, extension,
                    size_bytes, display_name, rights_status, probe_status,
                    duration_ms, width, height, fps, has_audio,
                    created_at, updated_at
                ) VALUES (
                    'visual-card-asset', 'visual-card-fingerprint',
                    'visual-card-full-fingerprint', 'video', '.mp4', 1,
                    '视觉卡片素材', 'owned', 'ok', 10000, 1080, 1920, 30, 0,
                    ?, ?
                )
                """,
                (now, now),
            )
            measured = {
                "visual_signal_status": "measured",
                "content_signature": None,
                "perceptual_hash": "1111111111111111",
                "black_screen": False,
                "severe_blur": False,
                "frozen": False,
                "meaningless": False,
                "description": "已测量窗口",
            }
            unavailable = {
                "visual_signal_status": "unavailable",
                "content_signature": None,
                "perceptual_hash": "2222222222222222",
                "black_screen": None,
                "severe_blur": None,
                "frozen": None,
                "meaningless": None,
                "description": "未测量窗口",
            }
            for segment_id, start_ms, end_ms, metadata in (
                ("measured-segment", 0, 5_000, measured),
                ("unavailable-segment", 5_000, 10_000, unavailable),
            ):
                database.connection.execute(
                    """
                    INSERT INTO media_segments(
                        id, asset_id, start_ms, end_ms, transcript_text,
                        speaker, role, shot_type, tags_json, quality_score,
                        analysis_version, provider, metadata_json,
                        created_at, updated_at
                    ) VALUES (?, 'visual-card-asset', ?, ?, '素材事实', '',
                              'process', 'function_demo', '[]', 0.9,
                              'visual-card-v1', 'test', ?, ?, ?)
                    """,
                    (
                        segment_id,
                        start_ms,
                        end_ms,
                        json.dumps(metadata),
                        now,
                        now,
                    ),
                )

            cards = domain._auto_mix_asset_cards(
                ["visual-card-asset"],
                analysis_versions={"visual-card-asset": "visual-card-v1"},
            )
            intervals = cards[0]["usable_intervals"]
            self.assertEqual(2, len(intervals))
            self.assertTrue(intervals[0]["usable"])
            self.assertEqual("", intervals[0]["content_signature"])
            self.assertEqual(
                {
                    "black_screen": False,
                    "severe_blur": False,
                    "frozen": False,
                    "meaningless": False,
                },
                {
                    key: intervals[0]["metadata"][key]
                    for key in (
                        "black_screen",
                        "severe_blur",
                        "frozen",
                        "meaningless",
                    )
                },
            )
            self.assertFalse(intervals[1]["usable"])
            self.assertEqual("", intervals[1]["content_signature"])
            self.assertTrue(
                all(
                    intervals[1]["metadata"][key] is None
                    for key in (
                        "black_screen",
                        "severe_blur",
                        "frozen",
                        "meaningless",
                    )
                )
            )
            timeline = build_material_timeline(cards)
            self.assertTrue(timeline["selected_segments"])
            self.assertTrue(
                all(
                    item["source_end_ms"] <= 5_000
                    for item in timeline["selected_segments"]
                )
            )
        finally:
            database.close()


if __name__ == "__main__":
    unittest.main()
