from __future__ import annotations

import hashlib
import io
import json
import os
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
    POPULAR_VOICE_PREVIEW_SAMPLE,
    VOICE_PREVIEW_SAMPLE,
    voice_preview_cache_key,
    voice_preview_sample,
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
        templates = [item for item in values if item["provider"] == "bailian"]

        self.assertEqual(
            {
                "natural-life@1",
                "reliable-business@1",
                "steady-story@1",
                "playful-abstract@1",
            },
            {item["persona_id"] for item in templates},
        )
        for item in templates:
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

    def test_volc_candidates_keep_manual_approval_and_reuse_generated_preview_after_local_failure(self):
        domain = self.service.creative_domain
        domain._sync_configured_voice_persona_rows(domain._now(), configured_voice_personas({}))
        items = domain.list_auto_mix_voice_personas()["items"]
        new = [item for item in items if item["provider"] == "volcengine"]
        configured = {item["persona_id"]: item for item in configured_voice_personas({}) if item["provider"] == "volcengine"}
        self.assertEqual(set(configured), {item["voicePersonaId"] for item in new})
        self.assertEqual("seed-tts-2.0", configured["volc-xiaohe-2@1"]["provider_model"])
        self.assertEqual("zh_female_xiaohe_uranus_bigtts", configured["volc-xiaohe-2@1"]["provider_voice_id"])
        self.assertTrue(all(item["approvalStatus"] == "pending" for item in new))
        self.assertTrue(all(item["previewText"] == POPULAR_VOICE_PREVIEW_SAMPLE for item in new))
        self.assertEqual(VOICE_PREVIEW_SAMPLE, voice_preview_sample({"provider": "bailian"}))
        self.assertTrue(all("provider_voice_id" not in item for item in new))
        persona_id = new[0]["voicePersonaId"]
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": ""}):
            with self.assertRaises(ContentEngineError) as error:
                domain.preview_auto_mix_voice_persona(persona_id)
            self.assertEqual("provider_gateway_unavailable", error.exception.code)
        self.assertEqual([], self.analyzer.calls)
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": "offline-test"}), \
                mock.patch("content_engine.creative_domain.voice_preview_ffmpeg", return_value="fake-ffmpeg"), \
                mock.patch("content_engine.creative_domain.normalize_voice_preview", side_effect=[
                    ContentEngineError("auto_mix_voice_preview_normalization_failed", "local-only failure"), None]):
            with self.assertRaises(ContentEngineError):
                domain.preview_auto_mix_voice_persona(persona_id)
            preview = domain.preview_auto_mix_voice_persona(persona_id)
        self.assertEqual(1, len(self.analyzer.calls), "A local normalization retry must not submit TTS again")
        self.assertEqual(POPULAR_VOICE_PREVIEW_SAMPLE, self.analyzer.calls[0]["text"])
        self.assertEqual("completed", preview["previewStatus"])
        self.assertEqual("pending", preview["voicePersona"]["approvalStatus"])
        self.assertIsNone(domain._approved_auto_mix_voice_persona(selected_id=persona_id))
        domain.approve_auto_mix_voice_persona(persona_id)
        self.assertEqual(persona_id, domain._approved_auto_mix_voice_persona(selected_id=persona_id)["id"])

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
        # Intentional since CE2: retiring only deactivates. The approval and the
        # preview stay on the inactive row, where the active = 1 filter keeps them
        # unusable; they count again only if the same configuration returns.
        self.assertIsNotNone(retired["approved_at"])
        self.assertIsNotNone(retired_preview)
        self.assertIsNone(
            self.service.creative_domain._approved_auto_mix_voice_persona(
                selected_id="steady-story@2"
            )
        )
        self.assertEqual("manual", manual["catalog_source"])
        self.assertEqual(1, manual["active"])
        listed_ids = {
            item["voicePersonaId"]
            for item in self.service.list_auto_mix_voice_personas()["items"]
        }
        self.assertNotIn("steady-story@2", listed_ids)

    def _sync(self, personas):
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=personas,
        ):
            self.service.creative_domain._sync_configured_voice_persona()

    def _restart(self, personas):
        """Reopen the engine the way the app starts it, with a fresh provider fake."""
        self.service.close()
        self.analyzer = _PreviewAnalyzer()
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=personas,
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=self.analyzer,
                creative_renderer=_Renderer(),
                start_background_jobs=False,
            )

    def _row(self, table, persona_id):
        column = "id" if table == "voice_personas_v1" else "persona_id"
        return self.service.connection.execute(
            f"SELECT * FROM {table} WHERE {column} = ?", (persona_id,)
        ).fetchone()

    def _saved_preview_path(self, persona_id):
        persona = self._row("voice_personas_v1", persona_id)
        return (
            self.root / "auto-mix-cache" / "voice-previews"
            / f"{voice_preview_cache_key(persona)}.wav"
        )

    def _preview_volc_voice(self, persona_id, **kwargs):
        # Stands in for the cloud call and the loudness pass; the fake analyzer
        # writes the WAV where preview() expects it.
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": "offline-test"}), \
                mock.patch("content_engine.creative_domain.voice_preview_ffmpeg", return_value="fake-ffmpeg"), \
                mock.patch("content_engine.creative_domain.normalize_voice_preview", side_effect=_normalize_like_ffmpeg):
            return self.service.preview_auto_mix_voice_persona(persona_id, **kwargs)

    def test_unchanged_configured_voice_keeps_its_approval_across_a_catalog_absence(self):
        configured = {
            "persona_id": "steady-story@2",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "provider_voice_id": "steady-provider-voice",
            "instruction": "沉稳但不拖沓。",
        }
        self._sync([configured])
        self.service.preview_auto_mix_voice_persona("steady-story@2")
        self.service.approve_auto_mix_voice_persona("steady-story@2")
        approved_at = self._row("voice_personas_v1", "steady-story@2")["approved_at"]
        self.assertIsNotNone(approved_at)
        calls = len(self.analyzer.calls)

        # Absent from the catalog: not listed, not usable, not auditionable.
        self._sync([])
        domain = self.service.creative_domain
        self.assertNotIn(
            "steady-story@2",
            {item["voicePersonaId"] for item in self.service.list_auto_mix_voice_personas()["items"]},
        )
        self.assertIsNone(domain._approved_auto_mix_voice_persona(selected_id="steady-story@2"))
        self.assertIsNone(domain._approved_auto_mix_voice_persona(excluded_id="natural-life@1"))
        for attempt in (
            lambda: self.service.preview_auto_mix_voice_persona("steady-story@2"),
            lambda: self.service.preview_auto_mix_voice_persona("steady-story@2", cache_only=True),
            lambda: self.service.approve_auto_mix_voice_persona("steady-story@2"),
        ):
            with self.assertRaises(ContentEngineError) as caught:
                attempt()
            self.assertEqual("auto_mix_voice_persona_not_found", caught.exception.code)

        # Back with the same configuration: the user's approval and preview stand.
        self._sync([configured])
        listed = {
            item["voicePersonaId"]: item
            for item in self.service.list_auto_mix_voice_personas()["items"]
        }
        self.assertEqual("approved", listed["steady-story@2"]["approvalStatus"])
        self.assertEqual("completed", listed["steady-story@2"]["previewStatus"])
        self.assertEqual(approved_at, self._row("voice_personas_v1", "steady-story@2")["approved_at"])
        self.assertEqual(
            "steady-story@2",
            domain._approved_auto_mix_voice_persona(selected_id="steady-story@2")["id"],
        )
        self.assertTrue(
            self.service.preview_auto_mix_voice_persona("steady-story@2", cache_only=True)["cacheHit"]
        )
        self.assertEqual(calls, len(self.analyzer.calls))
        self.assertEqual([], self.analyzer.design_calls)

    def test_changed_configuration_on_return_still_revokes_approval_and_preview(self):
        # Regression protection: this held before CE2 and must keep holding.
        self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.service.approve_auto_mix_voice_persona("natural-life@1")
        manual_approved_at = self._row("voice_personas_v1", "natural-life@1")["approved_at"]
        for index, field in enumerate(("catalog_version", "provider_voice_id", "instruction")):
            with self.subTest(changed=field):
                persona_id = f"steady-story@{index + 3}"
                configured = {
                    "persona_id": persona_id,
                    "display_name": f"沉稳叙事 {index}",
                    "style": "steady_narration",
                    "catalog_version": "2026.08",
                    "provider_voice_id": f"steady-provider-voice-{index}",
                    "instruction": "沉稳但不拖沓。",
                }
                self._sync([configured])
                self.service.preview_auto_mix_voice_persona(persona_id)
                self.service.approve_auto_mix_voice_persona(persona_id)
                self._sync([])
                self._sync([{**configured, field: f"{configured[field]}-v2"}])
                self.assertIsNone(self._row("voice_personas_v1", persona_id)["approved_at"])
                self.assertIsNone(self._row("auto_mix_voice_previews_v1", persona_id))
                with self.assertRaises(ContentEngineError) as caught:
                    self.service.approve_auto_mix_voice_persona(persona_id)
                self.assertEqual("auto_mix_voice_preview_required", caught.exception.code)
                calls = len(self.analyzer.calls)
                self.assertFalse(self.service.preview_auto_mix_voice_persona(persona_id)["cacheHit"],
                                 "the old preview is not replayed for the changed configuration")
                self.assertEqual(calls + 1, len(self.analyzer.calls))
        manual = self._row("voice_personas_v1", "natural-life@1")
        self.assertEqual(("manual", 1, manual_approved_at),
                         (manual["catalog_source"], manual["active"], manual["approved_at"]))
        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "natural-life@1")["status"])

    def test_every_other_compared_field_revokes_approval_and_preview_on_return(self):
        # Retiring keeps the approval (CE2), so for a returning voice the comparison in
        # _sync_configured_voice_persona_rows (private_configuration_changed) is the only
        # revocation. catalog_version, provider_voice_id and instruction are changed alone
        # above; here each other field it compares is changed alone.
        plain = {
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "instruction": "沉稳但不拖沓。",
        }
        designed = {
            **plain,
            "provider_voice_id": "",
            "voice_prompt": "温暖沉稳的中文男声，语气自然，适合真实项目讲述。",
            "voice_prefix": "story26",
        }
        cases = (
            ("provider", plain, {"provider": "volcengine"}),
            ("provider_model", plain, {"provider_model": "cosyvoice-v3.5-flash"}),
            ("voice_prompt", designed, {"voice_prompt": "沉稳自然的中文男声，重点清楚。"}),
            ("voice_prefix", designed, {"voice_prefix": "story27"}),
        )
        for index, (field, base, change) in enumerate(cases):
            with self.subTest(changed=field):
                persona_id = f"compared-field-{index}@1"
                configured = {
                    "provider_voice_id": f"compared-provider-voice-{index}",
                    **base,
                    "persona_id": persona_id,
                    "display_name": f"比对字段 {index}",
                }
                self._sync([configured])
                if base is designed:
                    self.service.design_auto_mix_voice_persona(persona_id)
                    self.assertIsNotNone(self._row("auto_mix_voice_designs_v1", persona_id))
                self.service.preview_auto_mix_voice_persona(persona_id)
                self.service.approve_auto_mix_voice_persona(persona_id)
                self._sync([])
                self.assertIsNotNone(self._row("voice_personas_v1", persona_id)["approved_at"],
                                     "retiring alone keeps the approval")
                self._sync([{**configured, **change}])
                self.assertIsNone(self._row("voice_personas_v1", persona_id)["approved_at"])
                self.assertIsNone(self._row("auto_mix_voice_previews_v1", persona_id))
                if base is designed:
                    self.assertIsNone(self._row("auto_mix_voice_designs_v1", persona_id))
                with self.assertRaises(ContentEngineError) as caught:
                    self.service.approve_auto_mix_voice_persona(persona_id)
                self.assertEqual("auto_mix_voice_preview_required", caught.exception.code)

        # catalog_source: a manual voice the catalog now configures under the same id and
        # with the same settings is still not the voice the user approved. Its saved WAV
        # has the same cache key (the private configuration is the same), so the same start
        # would record it again as a free replay (_register_saved_voice_previews), never the
        # approval; the file is moved aside here to see the row itself go.
        self.service.preview_auto_mix_voice_persona("natural-life@1")
        self.service.approve_auto_mix_voice_persona("natural-life@1")
        manual = self._row("voice_personas_v1", "natural-life@1")
        self._saved_preview_path("natural-life@1").unlink()
        self._sync([{key: manual[key] for key in (
            "display_name", "style", "catalog_version", "provider", "provider_model",
            "provider_voice_id", "instruction", "voice_prompt", "voice_prefix")} | {"persona_id": "natural-life@1"}])
        taken_over = self._row("voice_personas_v1", "natural-life@1")
        self.assertEqual("configured", taken_over["catalog_source"])
        self.assertIsNone(taken_over["approved_at"])
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "natural-life@1"))

    def test_retiring_keeps_a_designed_voice_s_design_and_preview(self):
        # Retiring only deactivates: it deletes neither the preview row nor the design row
        # (what the provider created for this voice). The unchanged voice comes back with
        # both, with its designed provider voice and its approval, and is not designed again.
        designed = {
            "persona_id": "steady-story@1",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "provider_voice_id": "",
            "instruction": "沉稳但不拖沓。",
            "voice_prompt": "温暖沉稳的中文男声，语气自然，适合真实项目讲述。",
            "voice_prefix": "story26",
        }
        self._sync([designed])
        self.service.design_auto_mix_voice_persona("steady-story@1")
        self.service.preview_auto_mix_voice_persona("steady-story@1")
        self.service.approve_auto_mix_voice_persona("steady-story@1")
        approved_at = self._row("voice_personas_v1", "steady-story@1")["approved_at"]
        design = tuple(self._row("auto_mix_voice_designs_v1", "steady-story@1"))
        preview = tuple(self._row("auto_mix_voice_previews_v1", "steady-story@1"))
        self.assertEqual("completed", design[2])

        self._sync([])
        retired = self._row("voice_personas_v1", "steady-story@1")
        self.assertEqual((0, approved_at), (retired["active"], retired["approved_at"]))
        self.assertEqual(design, tuple(self._row("auto_mix_voice_designs_v1", "steady-story@1")),
                         "retiring leaves the design row alone")
        self.assertEqual(preview, tuple(self._row("auto_mix_voice_previews_v1", "steady-story@1")),
                         "and the preview row")

        self._sync([designed])
        back = self._row("voice_personas_v1", "steady-story@1")
        self.assertEqual((1, approved_at, "private-designed-voice-id"),
                         (back["active"], back["approved_at"], back["provider_voice_id"]))
        self.assertEqual(design, tuple(self._row("auto_mix_voice_designs_v1", "steady-story@1")))
        self.assertEqual(preview, tuple(self._row("auto_mix_voice_previews_v1", "steady-story@1")))
        listed = {
            item["voicePersonaId"]: item
            for item in self.service.list_auto_mix_voice_personas()["items"]
        }["steady-story@1"]
        self.assertEqual(("approved", "completed", "ready"),
                         (listed["approvalStatus"], listed["previewStatus"], listed["provisioningStatus"]))
        self.assertEqual(1, len(self.analyzer.design_calls))
        self.assertEqual([], self.analyzer.calls)

    def test_saved_preview_recording_skips_a_retired_voice_and_a_manual_voice(self):
        # Only a listed voice (active = 1) from the catalog (catalog_source = 'configured')
        # gets a saved preview recorded: a retired voice is offered nowhere, and a manual
        # voice is not the catalog's to restore. The control voice, and the retired one once
        # it is back unchanged, show that the files themselves would be recorded.
        retired, control = self._volc("volc-retired@1"), self._volc("volc-control@1")
        self._sync([retired, control])
        for persona_id in ("volc-retired@1", "volc-control@1", "natural-life@1"):
            path = self._saved_preview_path(persona_id)
            _write_test_wav(path)
            _normalize_like_ffmpeg(path)
        manual = self._row("voice_personas_v1", "natural-life@1")
        self.assertEqual(("manual", 1, ""), (manual["catalog_source"], manual["active"], manual["voice_prompt"]))
        self.assertTrue(manual["provider_voice_id"])

        self._restart([control])  # volc-retired@1 leaves the catalog at this start

        self.assertEqual(0, self._row("voice_personas_v1", "volc-retired@1")["active"])
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "volc-retired@1"),
                          "a retired voice gets nothing recorded")
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "natural-life@1"),
                          "nor does a manual voice")
        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "volc-control@1")["status"])

        self._restart([retired, control])

        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "volc-retired@1")["status"],
                         "back in the catalog unchanged, its file is recorded")
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "natural-life@1"))
        self.assertEqual([], self.analyzer.calls)

    def test_saved_preview_is_recorded_again_after_an_old_build_cleared_it(self):
        monkey = {
            "persona_id": "volc-monkey-brother-2@1",
            "provider": "volcengine",
            "provider_model": "seed-tts-2.0",
            "display_name": "猴哥 2.0",
            "style": "playful",
            "catalog_version": "2026.09.21-volcengine-monkey-2",
            "provider_voice_id": "volc-monkey-private-voice",
            "instruction": "",
        }
        self._sync([monkey])
        self._preview_volc_voice("volc-monkey-brother-2@1")
        self.service.approve_auto_mix_voice_persona("volc-monkey-brother-2@1")
        saved = self._saved_preview_path("volc-monkey-brother-2@1")
        self.assertTrue(saved.is_file())
        saved_bytes = saved.read_bytes()

        # What a build without this voice ran at its start (the retire branch
        # from fc0d1ac up to CE2): approval cleared, preview row deleted, the WAV
        # itself left on disk.
        now = "2026-09-22T00:00:00.000Z"
        connection = self.service.connection
        connection.execute(
            "UPDATE voice_personas_v1 SET active = 0, approved_at = NULL, updated_at = ? "
            "WHERE id = ? AND catalog_source = 'configured'",
            (now, "volc-monkey-brother-2@1"),
        )
        connection.execute(
            "DELETE FROM auto_mix_voice_previews_v1 WHERE persona_id = ? "
            "AND status NOT IN ('submitted', 'outcome_unknown')",
            ("volc-monkey-brother-2@1",),
        )

        # The current build starts again, with no Volcengine key at all.
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": ""}):
            self._restart([monkey])
            preview = self._row("auto_mix_voice_previews_v1", "volc-monkey-brother-2@1")
            persona = self._row("voice_personas_v1", "volc-monkey-brother-2@1")
            self.assertEqual("completed", preview["status"])
            self.assertEqual(hashlib.sha256(saved_bytes).hexdigest(), preview["audio_digest"])
            self.assertEqual(
                str(Path("auto-mix-cache") / "voice-previews" / saved.name),
                preview["managed_relative_path"],
            )
            self.assertEqual(1, persona["active"])
            self.assertIsNone(persona["approved_at"], "recording a preview never approves")
            listed = {
                item["voicePersonaId"]: item
                for item in self.service.list_auto_mix_voice_personas()["items"]
            }
            self.assertEqual("pending", listed["volc-monkey-brother-2@1"]["approvalStatus"])
            self.assertEqual("completed", listed["volc-monkey-brother-2@1"]["previewStatus"])

            replay = self.service.preview_auto_mix_voice_persona(
                "volc-monkey-brother-2@1", cache_only=True
            )
            self.assertTrue(replay["cacheHit"])
            self.assertTrue(replay["audioDataUrl"].startswith("data:audio/wav;base64,"))
            self.assertEqual([], self.analyzer.calls)
            approved = self.service.approve_auto_mix_voice_persona("volc-monkey-brother-2@1")
        self.assertEqual("approved", approved["approvalStatus"])
        self.assertEqual(saved_bytes, saved.read_bytes())

    def test_saved_preview_recording_skips_unknown_invalid_oversized_and_designed_voices(self):
        def volc(persona_id):
            return {
                "persona_id": persona_id,
                "provider": "volcengine",
                "provider_model": "seed-tts-2.0",
                "display_name": persona_id.split("@")[0],
                "style": "natural_life",
                "catalog_version": "2026.09",
                "provider_voice_id": f"{persona_id.split('@')[0]}-private",
                "instruction": "",
            }
        designed = {
            "persona_id": "steady-story@1",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "provider_voice_id": "",
            "instruction": "沉稳但不拖沓。",
            "voice_prompt": "温暖沉稳的中文男声，语气自然，适合真实项目讲述。",
            "voice_prefix": "story26",
        }
        personas = [volc("volc-control@1"), volc("volc-unknown@1"), volc("volc-broken@1"),
                    volc("volc-oversized@1"), volc("volc-fmt-overrun@1"), designed]
        self._sync(personas)
        self.service.design_auto_mix_voice_persona("steady-story@1")
        self.service.connection.execute(
            "DELETE FROM auto_mix_voice_previews_v1 WHERE persona_id = 'steady-story@1'"
        )
        for persona_id in ("volc-control@1", "volc-unknown@1", "steady-story@1"):
            _write_test_wav(self._saved_preview_path(persona_id))
        for persona_id in ("volc-control@1", "volc-unknown@1"):
            _normalize_like_ffmpeg(self._saved_preview_path(persona_id))
        self._saved_preview_path("volc-broken@1").write_bytes(b"RIFF-but-not-a-wave" * 64)
        _write_test_wav(self._saved_preview_path("volc-oversized@1"), frame_count=4_300_000)
        self.assertGreater(self._saved_preview_path("volc-oversized@1").stat().st_size, 8 * 1024 * 1024)
        # A fmt chunk whose length runs past the end of the file: Python's wave module
        # raises a bare RuntimeError (from its chunk seek), which _wav_duration_ms does not
        # turn into ContentEngineError. Recording must skip it, not stop the engine starting.
        overrun = self._saved_preview_path("volc-fmt-overrun@1")
        _write_test_wav(overrun)
        _normalize_like_ffmpeg(overrun)
        damaged = bytearray(overrun.read_bytes())
        self.assertEqual(b"fmt ", bytes(damaged[12:16]))
        damaged[16:20] = (0xE410).to_bytes(4, "little")
        overrun.write_bytes(bytes(damaged))
        with self.assertRaises(RuntimeError, msg="the case this pins: wave raises a bare RuntimeError"):
            self.service.creative_domain._wav_duration_ms(overrun)
        unknown = ("volc-unknown@1", "an-earlier-request", "outcome_unknown", None, None,
                   "auto_mix_voice_preview_outcome_unknown", "2026-09-01T00:00:00.000Z",
                   "2026-09-01T00:00:00.000Z")
        self.service.connection.execute(
            "INSERT INTO auto_mix_voice_previews_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?)", unknown
        )
        design_calls = len(self.analyzer.design_calls)

        self._restart(personas)

        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "volc-control@1")["status"],
                         "the control voice shows a valid saved preview is recorded")
        self.assertEqual(unknown, tuple(self._row("auto_mix_voice_previews_v1", "volc-unknown@1")))
        for persona_id in ("volc-broken@1", "volc-oversized@1", "volc-fmt-overrun@1", "steady-story@1"):
            with self.subTest(persona_id=persona_id):
                self.assertIsNone(self._row("auto_mix_voice_previews_v1", persona_id))
        self.assertEqual([], self.analyzer.calls)
        self.assertEqual([], self.analyzer.design_calls[design_calls:])

    @staticmethod
    def _volc(persona_id, provider_voice_id=None):
        return {
            "persona_id": persona_id,
            "provider": "volcengine",
            "provider_model": "seed-tts-2.0",
            "display_name": persona_id.split("@")[0],
            "style": "natural_life",
            "catalog_version": "2026.09",
            "provider_voice_id": f"{persona_id.split('@')[0]}-private" if provider_voice_id is None else provider_voice_id,
            "instruction": "",
        }

    def test_saved_preview_recording_leaves_a_current_row_and_a_voice_without_an_id_alone(self):
        current, unbound, control = (self._volc("volc-current@1"), self._volc("volc-unbound@1", ""),
                                     self._volc("volc-control@1"))
        personas = [current, unbound, control]
        self._sync(personas)
        # volc-current@1 was heard: its row already carries the current cache key.
        self._preview_volc_voice("volc-current@1")
        row = tuple(self._row("auto_mix_voice_previews_v1", "volc-current@1"))
        saved = self._saved_preview_path("volc-current@1")
        heard = saved.read_bytes()
        # Its file is then replaced by other valid, loudness-marked audio. preview()
        # checks the digest and no longer replays it; recording the replacement under
        # its new digest would make it a free replay the user never heard.
        _write_test_wav(saved, sample=b"\x05\x00", frame_count=4_800)
        _normalize_like_ffmpeg(saved)
        self.assertNotEqual(hashlib.sha256(heard).hexdigest(), hashlib.sha256(saved.read_bytes()).hexdigest())
        # volc-unbound@1 has no private provider voice, so its cache key binds nothing.
        for persona_id in ("volc-unbound@1", "volc-control@1"):
            _write_test_wav(self._saved_preview_path(persona_id))
            _normalize_like_ffmpeg(self._saved_preview_path(persona_id))
        calls = len(self.analyzer.calls)

        self._restart(personas)

        self.assertEqual(row, tuple(self._row("auto_mix_voice_previews_v1", "volc-current@1")),
                         "a row with the current cache key is left as it is")
        with self.assertRaises(ContentEngineError) as replaced:
            self.service.preview_auto_mix_voice_persona("volc-current@1", cache_only=True)
        self.assertEqual("auto_mix_voice_preview_not_cached", replaced.exception.code)
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "volc-unbound@1"))
        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "volc-control@1")["status"],
                         "the control voice shows the files themselves would be recorded")
        self.assertEqual([], self.analyzer.calls[calls:])

    def test_saved_preview_recording_ignores_a_file_outside_the_data_directory(self):
        persona = self._volc("volc-outside@1")
        self._sync([persona])
        outside = SIDECAR_ROOT / f".auto-mix-voice-resources-outside-{uuid.uuid4().hex}"
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside, True)
        audio = outside / self._saved_preview_path("volc-outside@1").name
        _write_test_wav(audio)
        _normalize_like_ffmpeg(audio)
        previews = self.root / "auto-mix-cache" / "voice-previews"
        previews.parent.mkdir(parents=True, exist_ok=True)
        if previews.exists():
            previews.rmdir()
        _link_directory(previews, outside, self)
        try:
            self.assertTrue(self._saved_preview_path("volc-outside@1").is_file(), "the path inside resolves outside")
            self._restart([persona])
            self.assertIsNone(self._row("auto_mix_voice_previews_v1", "volc-outside@1"))
        finally:
            _remove_directory_link(previews)
        # The same file inside the data directory is recorded.
        previews.mkdir()
        shutil.copyfile(audio, previews / audio.name)
        self._restart([persona])
        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "volc-outside@1")["status"])
        self.assertEqual([], self.analyzer.calls)

    def test_the_engine_advertises_cache_only_and_honours_it_over_the_protocol(self):
        # The sidecar sends cache_only only to an engine whose ready message declares
        # voice_preview_cache_only (content-engine-sidecar.cjs); an engine that dropped
        # the flag would turn every 不计费 click into a capability error, and one that
        # declared it without honouring it would bill it.
        from content_engine.protocol import serve_jsonl

        request = {"id": "replay-1", "method": "preview_auto_mix_voice_persona",
                   "params": {"voice_persona_id": "natural-life@1", "cache_only": True}}
        output = io.StringIO()
        serve_jsonl(self.service, input_stream=io.StringIO(json.dumps(request) + "\n"), output_stream=output)
        ready, reply = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual("ready", ready["type"])
        self.assertIs(True, ready["capabilities"]["voice_preview_cache_only"])
        self.assertEqual(("replay-1", False, "auto_mix_voice_preview_not_cached"),
                         (reply["id"], reply["ok"], reply["error"]["code"]))
        self.assertIsNone(self._row("auto_mix_voice_previews_v1", "natural-life@1"))
        self.assertEqual([], self.analyzer.calls)

    def test_raw_volcengine_audio_is_put_back_as_pending_loudness_not_as_a_saved_preview(self):
        # The loudness pass failed, so the row was failed/normalization_failed and the
        # file on disk was the provider's raw audio. The older build deleted that row too.
        monkey = {
            "persona_id": "volc-monkey-brother-2@1",
            "provider": "volcengine",
            "provider_model": "seed-tts-2.0",
            "display_name": "猴哥 2.0",
            "style": "playful",
            "catalog_version": "2026.09.21-volcengine-monkey-2",
            "provider_voice_id": "volc-monkey-private-voice",
            "instruction": "",
        }
        bailian = {
            "persona_id": "steady-story@2",
            "display_name": "沉稳叙事",
            "style": "steady_narration",
            "catalog_version": "2026.08",
            "provider_voice_id": "steady-provider-voice",
            "instruction": "沉稳但不拖沓。",
        }
        self._sync([monkey, bailian])
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": "offline-test"}), \
                mock.patch("content_engine.creative_domain.voice_preview_ffmpeg", return_value="fake-ffmpeg"), \
                mock.patch("content_engine.creative_domain.normalize_voice_preview", side_effect=ContentEngineError(
                    "auto_mix_voice_preview_normalization_failed", "local-only failure")):
            with self.assertRaises(ContentEngineError):
                self.service.preview_auto_mix_voice_persona("volc-monkey-brother-2@1")
        self.assertEqual("auto_mix_voice_preview_normalization_failed",
                         self._row("auto_mix_voice_previews_v1", "volc-monkey-brother-2@1")["error_code"])
        raw = self._saved_preview_path("volc-monkey-brother-2@1")
        raw_bytes = raw.read_bytes()
        self.assertFalse(self.service.creative_domain._ffmpeg_wrote_wav(raw))
        # Bailian audio is never rewritten: its saved file is the preview as heard.
        _write_test_wav(self._saved_preview_path("steady-story@2"))
        self.service.connection.execute(
            "DELETE FROM auto_mix_voice_previews_v1 WHERE status NOT IN ('submitted', 'outcome_unknown')")

        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": ""}):
            self._restart([monkey, bailian])
        row = self._row("auto_mix_voice_previews_v1", "volc-monkey-brother-2@1")
        self.assertEqual(("failed", "auto_mix_voice_preview_normalization_pending", hashlib.sha256(raw_bytes).hexdigest()),
                         (row["status"], row["error_code"], row["audio_digest"]))
        self.assertEqual("completed", self._row("auto_mix_voice_previews_v1", "steady-story@2")["status"])
        listed = {item["voicePersonaId"]: item for item in self.service.list_auto_mix_voice_personas()["items"]}
        self.assertNotEqual("completed", listed["volc-monkey-brother-2@1"]["previewStatus"])
        with self.assertRaises(ContentEngineError) as held:
            self.service.preview_auto_mix_voice_persona("volc-monkey-brother-2@1", cache_only=True)
        self.assertEqual("auto_mix_voice_preview_not_cached", held.exception.code)
        with self.assertRaises(ContentEngineError) as unheard:
            self.service.approve_auto_mix_voice_persona("volc-monkey-brother-2@1")
        self.assertEqual("auto_mix_voice_preview_required", unheard.exception.code)

        # The next preview finishes only the local loudness pass: no provider call.
        finished = self._preview_volc_voice("volc-monkey-brother-2@1")
        self.assertEqual("completed", finished["previewStatus"])
        self.assertEqual([], self.analyzer.calls)
        self.assertTrue(self.service.creative_domain._ffmpeg_wrote_wav(raw))
        self.assertEqual("approved", self.service.approve_auto_mix_voice_persona("volc-monkey-brother-2@1")["approvalStatus"])

    def test_the_ffmpeg_mark_matches_what_normalize_voice_preview_writes(self):
        from content_engine.auto_mix_resources import normalize_voice_preview, voice_preview_ffmpeg
        try:
            ffmpeg = voice_preview_ffmpeg()
        except ContentEngineError:
            self.skipTest("FFmpeg is not available on this machine")
        path = self.root / "raw-provider-audio.wav"
        tone = b"".join(int(8000 * ((index // 27) % 2 * 2 - 1)).to_bytes(2, "little", signed=True)
                        for index in range(24_000))
        with wave.open(str(path), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(tone)
        domain = self.service.creative_domain
        self.assertFalse(domain._ffmpeg_wrote_wav(path), "the provider's raw audio carries no ffmpeg mark")
        normalize_voice_preview(path, ffmpeg)
        self.assertTrue(domain._ffmpeg_wrote_wav(path), "the loudness pass leaves ffmpeg's mark")

    def test_only_ffmpeg_s_own_tag_marks_a_normalized_preview(self):
        wrote = self.service.creative_domain._ffmpeg_wrote_wav
        raw = self.root / "raw.wav"
        _write_test_wav(raw)
        self.assertFalse(wrote(raw))
        normalized = self.root / "normalized.wav"
        _write_test_wav(normalized)
        _normalize_like_ffmpeg(normalized)
        self.assertTrue(wrote(normalized))
        # Other writers' INFO tags, or ffmpeg's name under another tag, are not the mark.
        for name, tag, value in (("other-encoder", b"ISFT", b"Audition"),
                                 ("title-only", b"INAM", b"Lavf62.12.101\x00")):
            with self.subTest(name):
                path = self.root / f"{name}.wav"
                _write_test_wav(path)
                _normalize_like_ffmpeg(path, tag=tag, value=value)
                self.assertGreater(self.service.creative_domain._wav_duration_ms(path), 0, "still a valid WAV")
                self.assertFalse(wrote(path))
        not_wave = self.root / "not-a-wave.wav"
        not_wave.write_bytes(b"RIFF\x00\x00\x00\x00AVI LIST")
        self.assertFalse(wrote(not_wave))

    def test_cache_only_preview_without_a_saved_preview_never_reaches_the_provider(self):
        from content_engine.protocol import METHODS

        monkey = {
            "persona_id": "volc-monkey-brother-2@1",
            "provider": "volcengine",
            "provider_model": "seed-tts-2.0",
            "display_name": "猴哥 2.0",
            "style": "playful",
            "catalog_version": "2026.09.21-volcengine-monkey-2",
            "provider_voice_id": "volc-monkey-private-voice",
            "instruction": "",
        }
        self._sync([monkey])
        for persona_id, key in (("natural-life@1", "offline-test"),
                                ("volc-monkey-brother-2@1", "offline-test"),
                                ("volc-monkey-brother-2@1", "")):
            with self.subTest(persona_id=persona_id, volcengine_key=bool(key)), \
                    mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": key}):
                with self.assertRaises(ContentEngineError) as caught:
                    METHODS["preview_auto_mix_voice_persona"](
                        self.service, {"voice_persona_id": persona_id, "cache_only": True}
                    )
                self.assertEqual("auto_mix_voice_preview_not_cached", caught.exception.code)
                self.assertIn("计费", caught.exception.message)
                self.assertIsNone(self._row("auto_mix_voice_previews_v1", persona_id))
        self.assertEqual([], self.analyzer.calls)

        with self.assertRaises(ContentEngineError) as invalid:
            METHODS["preview_auto_mix_voice_persona"](
                self.service, {"voice_persona_id": "natural-life@1", "cache_only": "true"}
            )
        self.assertEqual("invalid_params", invalid.exception.code)
        self.assertEqual([], self.analyzer.calls)

        # A preview whose audio was produced but not yet loudness-normalized is not
        # a saved preview either: replaying it for free is not on offer.
        with mock.patch.dict("os.environ", {"XIAOXI_VOLCENGINE_TTS_API_KEY": "offline-test"}), \
                mock.patch("content_engine.creative_domain.voice_preview_ffmpeg", return_value="fake-ffmpeg"), \
                mock.patch("content_engine.creative_domain.normalize_voice_preview", side_effect=ContentEngineError(
                    "auto_mix_voice_preview_normalization_failed", "local-only failure")):
            with self.assertRaises(ContentEngineError):
                self.service.preview_auto_mix_voice_persona("volc-monkey-brother-2@1")
        pending = tuple(self._row("auto_mix_voice_previews_v1", "volc-monkey-brother-2@1"))
        with self.assertRaises(ContentEngineError) as held:
            self.service.preview_auto_mix_voice_persona("volc-monkey-brother-2@1", cache_only=True)
        self.assertEqual("auto_mix_voice_preview_not_cached", held.exception.code)
        self.assertEqual(pending, tuple(self._row("auto_mix_voice_previews_v1", "volc-monkey-brother-2@1")))
        self.assertEqual(1, len(self.analyzer.calls))

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


def _link_directory(link, target, test):
    """A directory link at link pointing to target: a symlink, or on Windows a junction
    (which needs no symlink privilege)."""
    try:
        os.symlink(target, link, target_is_directory=True)
        return
    except (OSError, NotImplementedError):
        pass
    if sys.platform == "win32":
        import _winapi
        try:
            _winapi.CreateJunction(str(target), str(link))
            return
        except OSError:
            pass
    test.skipTest("this machine cannot create a directory link")


def _remove_directory_link(link):
    # Removes the link itself, never what it points to.
    try:
        os.unlink(link)
    except OSError:
        os.rmdir(link)


def _write_test_wav(path, *, sample=b"\x01\x00", frame_count=2_400):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24_000)
        stream.writeframes(sample * frame_count)


def _normalize_like_ffmpeg(path, executable=None, *, tag=b"ISFT", value=b"Lavf62.12.101\x00"):
    """What normalize_voice_preview leaves: the audio rewritten by ffmpeg's WAV muxer,
    which adds LIST/INFO/ISFT "Lavf..." between fmt and data (as in the saved
    previews on the development machine). tag and value (even length) vary the tag."""
    path = Path(path)
    with wave.open(str(path), "rb") as stream:
        channels, width, rate = stream.getnchannels(), stream.getsampwidth(), stream.getframerate()
        frames = stream.readframes(stream.getnframes())
    fmt = b"".join((
        (1).to_bytes(2, "little"), channels.to_bytes(2, "little"), rate.to_bytes(4, "little"),
        (rate * channels * width).to_bytes(4, "little"), (channels * width).to_bytes(2, "little"),
        (width * 8).to_bytes(2, "little"),
    ))
    info = b"INFO" + tag + len(value).to_bytes(4, "little") + value
    chunks = b"".join((
        b"fmt ", len(fmt).to_bytes(4, "little"), fmt,
        b"LIST", len(info).to_bytes(4, "little"), info,
        b"data", len(frames).to_bytes(4, "little"), frames,
    ))
    path.write_bytes(b"RIFF" + (4 + len(chunks)).to_bytes(4, "little") + b"WAVE" + chunks)


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
            "provider": "bailian",
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
            configured = {item["persona_id"]: item for item in configured_voice_personas({})}
            self.assertEqual(set(configured), {item["voicePersonaId"] for item in listed})
            for item in listed:
                expected = "ready" if configured[item["voicePersonaId"]].get("provider_voice_id") else "not_created"
                self.assertEqual(expected, item["provisioningStatus"])
                self.assertEqual("not_ready", item["previewStatus"])
                self.assertEqual("pending", item["approvalStatus"])
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
            # Intentional since CE2: the approval stays on the inactive row and is
            # unusable there; only the same configuration returning revives it.
            self.assertEqual(now, row["approved_at"])
            self.assertIsNone(
                service.creative_domain._approved_auto_mix_voice_persona(
                    selected_id="removed-config@1"
                )
            )
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
