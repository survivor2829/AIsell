from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import unittest
from unittest import mock
import uuid
import wave


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.auto_mix_resources import configured_voice_personas
from content_engine.database import Database
from content_engine.errors import ContentEngineError
from content_engine.service import ContentEngineService
from content_engine.auto_mix_resources import (
    BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES,
)


class _Renderer:
    capability = {"available": True}

    def close(self, timeout_seconds=3.0):
        return None


class _PreviewAnalyzer:
    capability = {
        "available": True,
        "cloud_configured": True,
        "provider": "bailian",
    }

    def __init__(self, *, outcome_unknown=False):
        self.calls = []
        self.design_calls = []
        self.outcome_unknown = outcome_unknown

    def design_auto_mix_voice(self, output_path, persona_private):
        self.design_calls.append(dict(persona_private))
        if self.outcome_unknown:
            raise ContentEngineError(
                "auto_mix_voice_design_outcome_unknown", "design result unknown"
            )
        _write_test_wav(
            output_path, sample=b"\x02\x00", frame_count=24_000
        )
        return {
            "provider": "bailian",
            "model": "cosyvoice-v3.5-plus",
            "provider_voice_id": "private-designed-voice-id",
        }

    def synthesize_auto_mix_phrase(self, text, output_path, persona_private):
        self.calls.append(
            {
                "text": text,
                "provider_voice_id": persona_private["provider_voice_id"],
            }
        )
        if self.outcome_unknown:
            raise ContentEngineError(
                "auto_mix_voice_outcome_unknown", "preview result unknown"
            )
        _write_test_wav(
            output_path, sample=b"\x01\x00", frame_count=24_000
        )
        return {"provider": "bailian", "model": "cosyvoice-v3.5-plus"}


class _VerificationCloud:
    configured = True

    def __init__(self):
        self.calls = []
        self.transcript = ""

    def transcribe(self, audio_path, _should_stop):
        self.calls.append(str(Path(audio_path).resolve()))
        return [{"transcript": self.transcript}]


class _VerificationAnalyzer:
    capability = {
        "available": True,
        "cloud_configured": True,
        "provider": "bailian",
    }

    def __init__(self):
        self.calls = 0
        self.cloud_client = _VerificationCloud()

    def synthesize_auto_mix_phrase(self, text, output_path, _persona_private):
        self.calls += 1
        self.cloud_client.transcript = text
        _write_test_wav(
            output_path,
            sample=bytes((self.calls, 0)),
        )
        return {"provider": "bailian", "model": "cosyvoice-v3.5-plus"}


class AutoMixVoiceResourceTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".auto-mix-voice-resources-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.analyzer = _PreviewAnalyzer()
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=self.analyzer,
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )
        self._insert_persona()

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _insert_persona(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT OR REPLACE INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, approved_at,
                active, created_at, updated_at
            ) VALUES (
                'natural-life@1', 1, '自然生活', 'natural_life', '2026.08',
                'bailian', 'cosyvoice-v3.5-plus', 'private-provider-voice',
                '自然、松弛、短句清晰。', NULL, 1, ?, ?
            )
            """,
            (now, now),
        )

    def test_configured_catalog_is_versioned_and_private(self):
        values = configured_voice_personas(
            {
                "XIAOXI_TTS_PERSONA_CATALOG_JSON": json.dumps(
                    [
                        {
                            "voicePersonaId": "steady-story@2",
                            "displayName": "沉稳叙事",
                            "category": "steady_narration",
                            "catalogVersion": "2026.08",
                            "providerVoiceId": "vendor-private-id",
                            "instruction": "沉稳但不拖沓。",
                            "approved": True,
                        }
                    ]
                ),
                "XIAOXI_TTS_PERSONA_APPROVED": "true",
            }
        )
        self.assertEqual("steady-story@2", values[0]["persona_id"])
        self.assertNotIn("approved", values[0])
        self.assertEqual("vendor-private-id", values[0]["provider_voice_id"])

    def test_default_catalog_contains_design_templates_without_supplier_ids(self):
        values = configured_voice_personas({})

        self.assertEqual(
            {
                "natural-life@1",
                "reliable-business@1",
                "steady-story@1",
                "playful-abstract@1",
            },
            {item["persona_id"] for item in values},
        )
        for item in values:
            self.assertEqual("", item["provider_voice_id"])
            self.assertTrue(item["voice_prompt"])
            self.assertRegex(item["voice_prefix"], r"^[A-Za-z0-9]{1,10}$")
        priorities = {
            item["persona_id"]: item["auto_select_priority"] for item in values
        }
        self.assertGreater(
            priorities["reliable-business@1"],
            max(
                priority
                for persona_id, priority in priorities.items()
                if persona_id != "reliable-business@1"
            ),
        )

    def test_design_template_creates_private_voice_before_preview(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT OR REPLACE INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, voice_prompt,
                voice_prefix, catalog_source, approved_at, active, created_at,
                updated_at
            ) VALUES (
                'steady-story@1', 1, '沉稳叙事', 'steady_narration', '2026.08',
                'bailian', 'cosyvoice-v3.5-plus', '', '沉稳但不拖沓。',
                '温暖沉稳的中文男声，语气自然，适合真实项目讲述。',
                'story26', 'configured', NULL, 1, ?, ?
            )
            """,
            (now, now),
        )

        designed = self.service.design_auto_mix_voice_persona("steady-story@1")
        first = self.service.preview_auto_mix_voice_persona("steady-story@1")
        second = self.service.preview_auto_mix_voice_persona("steady-story@1")

        self.assertEqual("ready", designed["provisioningStatus"])
        self.assertTrue(first["cacheHit"])
        self.assertTrue(second["cacheHit"])
        self.assertEqual(1, len(self.analyzer.design_calls))
        self.assertEqual(0, len(self.analyzer.calls))
        row = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'steady-story@1'"
        ).fetchone()
        self.assertEqual("private-designed-voice-id", row["provider_voice_id"])
        self.assertNotIn("private-designed-voice-id", json.dumps(first))
        approved = self.service.approve_auto_mix_voice_persona("steady-story@1")
        self.assertEqual("approved", approved["approvalStatus"])

    def test_design_outcome_unknown_is_not_resubmitted(self):
        now = "2026-08-24T00:00:00.000Z"
        self.analyzer.outcome_unknown = True
        self.service.connection.execute(
            """
            INSERT OR REPLACE INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, voice_prompt,
                voice_prefix, catalog_source, approved_at, active, created_at,
                updated_at
            ) VALUES (
                'steady-story@1', 1, '沉稳叙事', 'steady_narration', '2026.08',
                'bailian', 'cosyvoice-v3.5-plus', '', '沉稳但不拖沓。',
                '温暖沉稳的中文男声，语气自然，适合真实项目讲述。',
                'story26', 'configured', NULL, 1, ?, ?
            )
            """,
            (now, now),
        )

        for _ in range(2):
            with self.assertRaises(ContentEngineError) as caught:
                self.service.design_auto_mix_voice_persona("steady-story@1")
            self.assertEqual(
                "auto_mix_voice_design_outcome_unknown", caught.exception.code
            )
        self.assertEqual(1, len(self.analyzer.design_calls))

    def test_design_outcome_unknown_survives_catalog_change(self):
        now = "2026-08-24T00:00:00.000Z"
        self.analyzer.outcome_unknown = True
        self.service.connection.execute(
            """
            INSERT OR REPLACE INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, voice_prompt,
                voice_prefix, catalog_source, approved_at, active, created_at,
                updated_at
            ) VALUES (
                'steady-story@1', 1, '沉稳叙事', 'steady_narration', '2026.08',
                'bailian', 'cosyvoice-v3.5-plus', '', '沉稳但不拖沓。',
                '温暖沉稳的中文男声，语气自然，适合真实项目讲述。',
                'story26', 'configured', NULL, 1, ?, ?
            )
            """,
            (now, now),
        )

        with self.assertRaises(ContentEngineError):
            self.service.design_auto_mix_voice_persona("steady-story@1")

        changed = {
            "persona_id": "steady-story@1",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.09",
            "provider_voice_id": "",
            "instruction": "沉稳自然，停顿更清楚。",
            "voice_prompt": "沉稳自然的中文男声，重点清楚。",
            "voice_prefix": "story26",
        }
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[changed],
        ):
            self.service.creative_domain._sync_configured_voice_persona()

        with self.assertRaises(ContentEngineError) as caught:
            self.service.design_auto_mix_voice_persona("steady-story@1")
        self.assertEqual(
            "auto_mix_voice_design_outcome_unknown", caught.exception.code
        )
        self.assertEqual(1, len(self.analyzer.design_calls))

    def test_preview_must_complete_before_approval_and_is_cached(self):
        listed = self.service.list_auto_mix_voice_personas()["items"]
        self.assertEqual("pending", listed[0]["approvalStatus"])
        self.assertEqual("not_ready", listed[0]["previewStatus"])
        self.assertNotIn("private-provider-voice", json.dumps(listed))

        with self.assertRaises(ContentEngineError) as caught:
            self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("auto_mix_voice_preview_required", caught.exception.code)

        first = self.service.preview_auto_mix_voice_persona("natural-life@1")
        second = self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.assertFalse(first["cacheHit"])
        self.assertTrue(second["cacheHit"])
        self.assertTrue(first["audioDataUrl"].startswith("data:audio/wav;base64,"))
        self.assertEqual(1, len(self.analyzer.calls))
        self.assertNotIn("private-provider-voice", json.dumps(first))

        approved = self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("approved", approved["approvalStatus"])
        self.assertEqual("completed", approved["previewStatus"])

    def test_private_configuration_change_revokes_approval_and_preview(self):
        self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.service.approve_auto_mix_voice_persona("natural-life@1")
        changed = {
            "persona_id": "natural-life@1",
            "display_name": "自然生活",
            "style": "natural_life",
            "catalog_version": "2026.09",
            "provider_voice_id": "private-provider-voice-v2",
            "instruction": "更自然、更松弛，重点词轻微加重。",
            "approved": True,
        }
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[changed],
        ):
            self.service.creative_domain._sync_configured_voice_persona()

        row = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'natural-life@1'"
        ).fetchone()
        preview = self.service.connection.execute(
            "SELECT * FROM auto_mix_voice_previews_v1 WHERE persona_id = 'natural-life@1'"
        ).fetchone()
        self.assertEqual("configured", row["catalog_source"])
        self.assertEqual("private-provider-voice-v2", row["provider_voice_id"])
        self.assertIsNone(row["approved_at"])
        self.assertIsNone(preview)
        with self.assertRaises(ContentEngineError) as caught:
            self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("auto_mix_voice_preview_required", caught.exception.code)

        refreshed = self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.assertFalse(refreshed["cacheHit"])
        self.assertEqual(
            "private-provider-voice-v2", self.analyzer.calls[-1]["provider_voice_id"]
        )
        approved = self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("approved", approved["approvalStatus"])

    def test_catalog_sync_rolls_back_persona_and_preview_together(self):
        self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.service.approve_auto_mix_voice_persona("natural-life@1")
        changed = {
            "persona_id": "natural-life@1",
            "display_name": "自然生活",
            "style": "natural_life",
            "catalog_version": "2026.09",
            "provider_voice_id": "private-provider-voice-v2",
            "instruction": "更自然、更松弛。",
            "voice_prompt": "",
            "voice_prefix": "",
        }
        conflicting = {
            **changed,
            "persona_id": "conflicting-life@1",
            "provider_voice_id": "another-private-provider-voice",
        }

        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[changed, conflicting],
        ):
            with self.assertRaises(sqlite3.IntegrityError):
                self.service.creative_domain._sync_configured_voice_persona()

        row = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'natural-life@1'"
        ).fetchone()
        preview = self.service.connection.execute(
            "SELECT * FROM auto_mix_voice_previews_v1 WHERE persona_id = 'natural-life@1'"
        ).fetchone()
        self.assertEqual("private-provider-voice", row["provider_voice_id"])
        self.assertIsNotNone(row["approved_at"])
        self.assertIsNotNone(preview)

    def test_preview_cache_rechecks_digest_and_wav_structure(self):
        self.service.preview_auto_mix_voice_persona("natural-life@1")
        preview = self.service.connection.execute(
            "SELECT * FROM auto_mix_voice_previews_v1 WHERE persona_id = 'natural-life@1'"
        ).fetchone()
        preview_path = self.root / preview["managed_relative_path"]

        preview_path.write_bytes(preview_path.read_bytes() + b"tampered")
        with self.assertRaises(ContentEngineError) as digest_error:
            self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual(
            "auto_mix_voice_preview_required", digest_error.exception.code
        )
        regenerated = self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.assertFalse(regenerated["cacheHit"])

        invalid_wav = b"digest-matches-but-not-a-wave"
        preview_path.write_bytes(invalid_wav)
        self.service.connection.execute(
            """
            UPDATE auto_mix_voice_previews_v1
            SET audio_digest = ? WHERE persona_id = 'natural-life@1'
            """,
            (hashlib.sha256(invalid_wav).hexdigest(),),
        )
        with self.assertRaises(ContentEngineError) as wav_error:
            self.service.approve_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("auto_mix_voice_preview_required", wav_error.exception.code)
        regenerated_again = self.service.preview_auto_mix_voice_persona(
            "natural-life@1"
        )
        self.assertFalse(regenerated_again["cacheHit"])
        self.assertEqual(3, len(self.analyzer.calls))

    def test_removed_configured_persona_is_retired_without_touching_manual_rows(self):
        configured = {
            "persona_id": "steady-story@2",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "provider_voice_id": "steady-provider-voice",
            "instruction": "沉稳但不拖沓。",
            "approved": True,
        }
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[configured],
        ):
            self.service.creative_domain._sync_configured_voice_persona()
        configured_row = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'steady-story@2'"
        ).fetchone()
        self.assertEqual("configured", configured_row["catalog_source"])
        self.assertEqual(1, configured_row["active"])
        self.assertIsNone(configured_row["approved_at"])
        self.service.preview_auto_mix_voice_persona("steady-story@2")
        self.service.approve_auto_mix_voice_persona("steady-story@2")

        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service.creative_domain._sync_configured_voice_persona()
        retired = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'steady-story@2'"
        ).fetchone()
        manual = self.service.connection.execute(
            "SELECT * FROM voice_personas_v1 WHERE id = 'natural-life@1'"
        ).fetchone()
        retired_preview = self.service.connection.execute(
            "SELECT * FROM auto_mix_voice_previews_v1 WHERE persona_id = 'steady-story@2'"
        ).fetchone()
        self.assertEqual(0, retired["active"])
        self.assertIsNone(retired["approved_at"])
        self.assertIsNone(retired_preview)
        self.assertEqual("manual", manual["catalog_source"])
        self.assertEqual(1, manual["active"])
        listed_ids = {
            item["voicePersonaId"]
            for item in self.service.list_auto_mix_voice_personas()["items"]
        }
        self.assertNotIn("steady-story@2", listed_ids)

    def test_unknown_preview_is_never_resubmitted_even_after_restart(self):
        self.service.close()
        self.analyzer = _PreviewAnalyzer(outcome_unknown=True)
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=self.analyzer,
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )
        with self.assertRaises(ContentEngineError) as first:
            self.service.preview_auto_mix_voice_persona("natural-life@1")
        with self.assertRaises(ContentEngineError) as second:
            self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.assertEqual("auto_mix_voice_preview_outcome_unknown", first.exception.code)
        self.assertEqual("auto_mix_voice_preview_outcome_unknown", second.exception.code)
        self.assertEqual(1, len(self.analyzer.calls))

        self.service.close()
        resumed_analyzer = _PreviewAnalyzer()
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=resumed_analyzer,
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )
        with self.assertRaises(ContentEngineError) as resumed:
            self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.assertEqual(
            "auto_mix_voice_preview_outcome_unknown", resumed.exception.code
        )
        self.assertEqual([], resumed_analyzer.calls)


def _write_test_wav(path, *, sample=b"\x01\x00", frame_count=2_400):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24_000)
        stream.writeframes(sample * frame_count)


def _write_streaming_placeholder_wav(path):
    _write_test_wav(path)
    raw = bytearray(Path(path).read_bytes())
    if raw[36:40] != b"data":
        raise AssertionError("test WAV data chunk moved")
    riff_size, data_size = BAILIAN_STREAMING_WAV_PLACEHOLDER_SIZES
    raw[4:8] = riff_size.to_bytes(4, "little")
    raw[40:44] = data_size.to_bytes(4, "little")
    Path(path).write_bytes(raw)


class AutoMixVoiceCacheIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".auto-mix-voice-integrity-{uuid.uuid4().hex}"
        self.root.mkdir()
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=_PreviewAnalyzer(),
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO creative_projects(
                id, mode, name, theme, status, settings_json, result_json,
                created_at, updated_at
            ) VALUES (
                'voice-integrity-project', 'mix', '缓存完整性', '缓存完整性',
                'rendering', '{}', '{}', ?, ?
            )
            """,
            (now, now),
        )
        self.service.connection.execute(
            """
            INSERT INTO auto_mix_runs_v2(
                id, project_id, generation, spec_version, input_hash, status,
                asset_ids_json, title, copy_framework, public_plan_json,
                private_state_json, quality_warnings_json, created_at, updated_at
            ) VALUES (
                'voice-integrity-run', 'voice-integrity-project', 1, '2',
                'voice-integrity-input', 'synthesizing', '[]', '缓存完整性',
                '先展示事实', '{}', '{}', '[]', ?, ?
            )
            """,
            (now, now),
        )

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _insert_cached_tts(
        self, *, cache_key, relative_path, audio_digest, duration_ms=None
    ):
        now = "2026-08-24T00:00:00.000Z"
        private_metadata = {"audio_digest": audio_digest}
        if duration_ms is not None:
            private_metadata["duration_ms"] = duration_ms
        self.service.connection.execute(
            """
            INSERT INTO auto_mix_stage_artifacts_v2(
                id, run_id, stage, cache_key, status, relative_path,
                public_metadata_json, private_metadata_json, revision,
                created_at, updated_at
            ) VALUES (?, 'voice-integrity-run', 'tts', ?, 'completed', ?,
                      '{}', ?, 1, ?, ?)
            """,
            (
                f"artifact-{cache_key}",
                cache_key,
                str(relative_path),
                json.dumps(private_metadata),
                now,
                now,
            ),
        )

    def test_cached_tts_requires_matching_digest_and_valid_wav(self):
        cases = []

        changed_relative = Path("auto-mix-cache") / "tts" / "changed.wav"
        changed_path = self.root / changed_relative
        _write_test_wav(changed_path, sample=b"\x01\x00")
        changed_digest = hashlib.sha256(changed_path.read_bytes()).hexdigest()
        self._insert_cached_tts(
            cache_key="changed-audio",
            relative_path=changed_relative,
            audio_digest=changed_digest,
        )
        _write_test_wav(changed_path, sample=b"\x02\x00")
        cases.append("changed-audio")

        invalid_relative = Path("auto-mix-cache") / "tts" / "invalid.wav"
        invalid_path = self.root / invalid_relative
        invalid_path.parent.mkdir(parents=True, exist_ok=True)
        invalid_path.write_bytes(b"digest-matches-but-not-a-wave")
        self._insert_cached_tts(
            cache_key="invalid-wave",
            relative_path=invalid_relative,
            audio_digest=hashlib.sha256(invalid_path.read_bytes()).hexdigest(),
        )
        cases.append("invalid-wave")

        for cache_key in cases:
            with self.subTest(cache_key=cache_key):
                self.assertIsNone(
                    self.service.creative_domain._cached_auto_mix_artifact(
                        "tts", cache_key
                    )
                )
                status = self.service.connection.execute(
                    """
                    SELECT status FROM auto_mix_stage_artifacts_v2
                    WHERE stage = 'tts' AND cache_key = ?
                    """,
                    (cache_key,),
                ).fetchone()
                self.assertEqual("invalidated", status["status"])

    def test_streaming_placeholder_tts_cache_reuses_actual_payload_duration(self):
        relative = Path("auto-mix-cache") / "tts" / "streaming-placeholder.wav"
        path = self.root / relative
        _write_streaming_placeholder_wav(path)
        with wave.open(str(path), "rb") as stream:
            declared_duration_ms = round(
                stream.getnframes() * 1_000 / stream.getframerate()
            )
        self.assertGreater(declared_duration_ms, 120_000)
        original_digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self._insert_cached_tts(
            cache_key="streaming-placeholder",
            relative_path=relative,
            audio_digest=original_digest,
            duration_ms=declared_duration_ms,
        )

        cached = self.service.creative_domain._cached_auto_mix_artifact(
            "tts", "streaming-placeholder"
        )

        self.assertIsNotNone(cached)
        self.assertEqual(
            100, self.service.creative_domain._wav_duration_ms(path)
        )
        self.assertEqual(original_digest, hashlib.sha256(path.read_bytes()).hexdigest())
        status = self.service.connection.execute(
            """
            SELECT status FROM auto_mix_stage_artifacts_v2
            WHERE stage = 'tts' AND cache_key = 'streaming-placeholder'
            """
        ).fetchone()
        self.assertEqual("completed", status["status"])

    def test_cached_concat_cannot_reuse_different_same_length_audio(self):
        first_relative = Path("auto-mix-cache") / "tts" / "phrase-1.wav"
        second_relative = Path("auto-mix-cache") / "tts" / "phrase-2.wav"
        _write_test_wav(self.root / first_relative, sample=b"\x01\x00")
        _write_test_wav(self.root / second_relative, sample=b"\x02\x00")
        phrases = [
            {
                "relative_path": str(first_relative),
                "audio_digest": hashlib.sha256(
                    (self.root / first_relative).read_bytes()
                ).hexdigest(),
                "duration_ms": 100,
            },
            {
                "relative_path": str(second_relative),
                "audio_digest": hashlib.sha256(
                    (self.root / second_relative).read_bytes()
                ).hexdigest(),
                "duration_ms": 100,
            },
        ]
        relative = self.service.creative_domain._concat_auto_mix_phrases(
            "voice-integrity-run", phrases, pause_ms=10
        )
        output = self.root / relative
        verified_digest = hashlib.sha256(output.read_bytes()).hexdigest()

        _write_test_wav(output, sample=b"\x09\x00", frame_count=5_040)
        tampered_digest = hashlib.sha256(output.read_bytes()).hexdigest()
        self.assertNotEqual(verified_digest, tampered_digest)

        try:
            reused_relative = self.service.creative_domain._concat_auto_mix_phrases(
                "voice-integrity-run", phrases, pause_ms=10
            )
        except ContentEngineError as error:
            self.assertIn(
                error.code,
                {"auto_mix_voice_cache_invalid", "auto_mix_voice_invalid"},
            )
        else:
            self.assertEqual(relative, reused_relative)
            self.assertEqual(
                verified_digest,
                hashlib.sha256((self.root / reused_relative).read_bytes()).hexdigest(),
            )

    def test_changed_tts_digest_requires_a_new_asr_verification(self):
        analyzer = _VerificationAnalyzer()
        self.service.creative_domain.analyzer = analyzer
        persona = {
            "id": "verified-cache@1",
            "catalog_version": "test-catalog-v1",
            "provider_model": "cosyvoice-v3.5-plus",
            "provider_voice_id": "private-provider-voice",
            "instruction": "自然口播",
        }
        phrase = {"phraseId": "phrase-1", "text": "机器人沿墙移动"}
        run = {
            "id": "voice-integrity-run",
            "title": "缓存完整性",
        }

        first = self.service.creative_domain._synthesize_and_verify_auto_mix_phrase(
            "unused-task", run, persona, phrase
        )
        cached_path = self.root / first["relative_path"]
        _write_test_wav(cached_path, sample=b"\x09\x00")
        second = self.service.creative_domain._synthesize_and_verify_auto_mix_phrase(
            "unused-task", run, persona, phrase
        )

        self.assertNotEqual(first["audio_digest"], second["audio_digest"])
        self.assertEqual(2, analyzer.calls)
        self.assertEqual(2, len(analyzer.cloud_client.calls))


class AutoMixVoiceMigrationTests(unittest.TestCase):
    def test_fresh_service_exposes_design_templates_without_private_fields(self):
        root = SIDECAR_ROOT / f".auto-mix-voice-fresh-{uuid.uuid4().hex}"
        root.mkdir()
        service = None
        try:
            service = ContentEngineService(
                root,
                creative_analyzer=_PreviewAnalyzer(),
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )
            listed = service.list_auto_mix_voice_personas()["items"]
            self.assertEqual(4, len(listed))
            self.assertTrue(
                all(
                    item["provisioningStatus"] == "not_created"
                    and item["previewStatus"] == "not_ready"
                    and item["approvalStatus"] == "pending"
                    for item in listed
                )
            )
            encoded = json.dumps(listed, ensure_ascii=False)
            self.assertNotIn("provider_voice", encoded)
            self.assertNotIn("voice_prompt", encoded)
        finally:
            if service is not None:
                service.close()
            shutil.rmtree(root, ignore_errors=True)

    def test_v14_database_adds_voice_design_state_without_touching_personas(self):
        root = SIDECAR_ROOT / f".auto-mix-voice-v14-{uuid.uuid4().hex}"
        root.mkdir()
        reopened = None
        try:
            database = Database(root).open()
            now = "2026-08-24T00:00:00.000Z"
            database.connection.execute(
                """
                INSERT INTO voice_personas_v1(
                    id, version, display_name, style, catalog_version, provider,
                    provider_model, provider_voice_id, instruction,
                    catalog_source, approved_at, active, created_at, updated_at
                ) VALUES (
                    'legacy-voice@1', 1, '旧声音', 'natural_life', 'legacy-v1',
                    'bailian', 'cosyvoice-v3.5-plus', 'legacy-private-id',
                    '自然口播', 'manual', ?, 1, ?, ?
                )
                """,
                (now, now, now),
            )
            database.close()

            legacy = sqlite3.connect(root / "content-engine.sqlite3")
            try:
                legacy.execute("DROP TABLE auto_mix_voice_designs_v1")
                legacy.execute("ALTER TABLE voice_personas_v1 DROP COLUMN voice_prompt")
                legacy.execute("ALTER TABLE voice_personas_v1 DROP COLUMN voice_prefix")
                legacy.execute("DELETE FROM schema_migrations WHERE version = 14")
                legacy.commit()
            finally:
                legacy.close()

            reopened = Database(root).open()
            columns = {
                row[1]
                for row in reopened.connection.execute(
                    "PRAGMA table_info(voice_personas_v1)"
                ).fetchall()
            }
            tables = {
                row[0]
                for row in reopened.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            persona = reopened.connection.execute(
                "SELECT * FROM voice_personas_v1 WHERE id = 'legacy-voice@1'"
            ).fetchone()
            self.assertTrue({"voice_prompt", "voice_prefix"}.issubset(columns))
            self.assertIn("auto_mix_voice_designs_v1", tables)
            self.assertEqual("legacy-private-id", persona["provider_voice_id"])
        finally:
            if reopened is not None:
                reopened.close()
            shutil.rmtree(root, ignore_errors=True)

    def test_v12_configured_persona_is_backfilled_and_retired_when_removed(self):
        root = SIDECAR_ROOT / f".auto-mix-voice-migration-{uuid.uuid4().hex}"
        root.mkdir()
        service = None
        try:
            database = Database(root).open()
            now = "2026-08-24T00:00:00.000Z"
            database.connection.execute(
                """
                INSERT INTO voice_personas_v1(
                    id, version, display_name, style, catalog_version, provider,
                    provider_model, provider_voice_id, instruction,
                    catalog_source, approved_at, active, created_at, updated_at
                ) VALUES (
                    'removed-config@1', 1, '已移除配置音色', 'natural_life',
                    'legacy-config', 'bailian', 'cosyvoice-v3.5-plus',
                    'legacy-private-provider-id', '自然口播', 'configured', ?, 1, ?, ?
                )
                """,
                (now, now, now),
            )
            database.close()

            legacy = sqlite3.connect(root / "content-engine.sqlite3")
            try:
                legacy.execute("ALTER TABLE voice_personas_v1 DROP COLUMN catalog_source")
                legacy.execute("DELETE FROM schema_migrations WHERE version = 13")
                legacy.commit()
            finally:
                legacy.close()

            with mock.patch(
                "content_engine.creative_domain.configured_voice_personas",
                return_value=[],
            ):
                service = ContentEngineService(
                    root,
                    creative_analyzer=_PreviewAnalyzer(),
                    creative_renderer=_Renderer(),
                    start_background_jobs=False,
                )
            row = service.connection.execute(
                "SELECT * FROM voice_personas_v1 WHERE id = 'removed-config@1'"
            ).fetchone()
            self.assertEqual("configured", row["catalog_source"])
            self.assertEqual(0, row["active"])
            self.assertIsNone(row["approved_at"])
            self.assertNotIn(
                "removed-config@1",
                {
                    item["voicePersonaId"]
                    for item in service.list_auto_mix_voice_personas()["items"]
                },
            )
        finally:
            if service is not None:
                service.close()
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
