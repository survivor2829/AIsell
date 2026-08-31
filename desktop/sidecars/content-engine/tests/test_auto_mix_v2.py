from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import json
import re
import shutil
import sys
import unittest
from unittest import mock
import uuid
import wave


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.auto_mix_v2 import (
    AUTO_MIX_CAPTION_CHARS,
    AUTO_MIX_SPEC_VERSION,
    AutoMixV2ContractError,
    align_material_timeline_to_captions,
    build_grounded_text_tracks,
    build_material_evidence_facts,
    build_material_timeline,
    build_music_brief,
    build_speech_captions,
    guided_script_audience_copy_issue,
    invalidated_stages_for_layer,
    normalize_text_tracks,
    public_auto_mix_plan,
    select_licensed_music,
    validate_create_auto_mix_v2,
    validate_formal_recipe,
    validate_quality_report,
    verify_spoken_phrase,
)
from content_engine.apimart_cover import APIMartOutcomeUnknown
from content_engine.database import Database
from content_engine.creative_domain import AUTO_MIX_MAX_TTS_PHRASES
from content_engine.errors import ContentEngineError
from content_engine.service import ContentEngineService


class _FakeAnalyzer:
    capability = {
        "available": True,
        "cloud_configured": False,
        "provider": "test",
    }

    @staticmethod
    def analysis_version_for(_asset, _profile=None):
        return "test-analysis-v1"


class _FailingCurrentAnalyzer(_FakeAnalyzer):
    def __init__(self):
        self.calls = 0

    @staticmethod
    def analysis_version_for(_asset, _profile=None):
        return "test-analysis-v2"

    def analyze(self, **_kwargs):
        self.calls += 1
        raise ContentEngineError(
            "analysis_timeout", "Current analysis version timed out."
        )


class _FakeRenderer:
    capability = {"available": True}

    @staticmethod
    def probe_audio_duration_ms(_path):
        return 30_000

    @staticmethod
    def measure_audio_quality(_path):
        return {
            "integrated_lufs": -19.0,
            "true_peak_dbtp": -2.0,
        }

    def close(self, timeout_seconds=3.0):
        return None


class _HappyCloud:
    configured = True

    def __init__(self, texts_by_path):
        self.texts_by_path = texts_by_path
        self.calls = []

    def transcribe(self, audio_path, _should_stop):
        self.calls.append(str(Path(audio_path).resolve()))
        return [{"transcript": self.texts_by_path[str(Path(audio_path).resolve())]}]


class _GuidedScriptCloud(_HappyCloud):
    def __init__(self, texts_by_path):
        super().__init__(texts_by_path)
        self.script_briefs = []
        self.script_assets = []

    def generate_product_script(self, brief, assets, *, count=1):
        del count
        self.script_briefs.append(dict(brief))
        self.script_assets.append([dict(item) for item in assets])
        product_name = str(brief.get("product_name") or "产品")
        minimum_chars = int(brief.get("voiceover_min_chars") or 8)
        maximum_chars = int(brief.get("voiceover_max_chars") or 260)
        minimum_sentences = int(brief.get("voiceover_min_sentence_count") or 2)
        hook = f"{product_name}开始现场清洁。"
        cta = f"这就是{product_name}的现场作业。"
        candidates = [
            "它沿着现场路线持续移动。",
            "遇到需要清洁的位置时，它继续完成当前作业。",
            "在开阔区域里，设备保持稳定行进。",
            "转弯之后，它会接着处理相邻地面。",
            "从工厂通道到室内区域，清洁过程连续进行。",
            "设备经过的区域逐步恢复整洁。",
            "整个过程清楚展示了它的移动和清洁状态。",
            "需要长时间重复清洁时，自动作业可以减少人工看守。",
            "不同场景下的真实表现，都以现场画面为准。",
            "从开始移动到完成当前区域，作业节奏保持连贯。",
            "清洁中的每一步，都能在画面里直接看到。",
            "它继续沿着既定路线完成剩余区域。",
        ]
        sentences = [hook]
        character_count = len(hook)
        for candidate in candidates:
            if character_count + len(candidate) + len(cta) > maximum_chars:
                continue
            sentences.append(candidate)
            character_count += len(candidate)
            if (
                character_count + len(cta) >= minimum_chars
                and len(sentences) + 1 >= minimum_sentences
            ):
                break
        sentences.append(cta)
        return {
            "provider": "bailian",
            "title_candidates": [f"{product_name}真实展示"],
            "hook": hook,
            "voiceover": "".join(sentences),
            "shots": [
                {
                    "asset_id": str(assets[0]["asset_id"]),
                    "asset_tags": list(assets[0].get("asset_tags") or []),
                    "caption": "真实现场",
                    "action": "cut_to_detail",
                }
            ],
            "cta": cta,
            "bgm_mood": "clean_tech_product",
        }


class _RejectedGuidedScriptCloud(_GuidedScriptCloud):
    def __init__(self, texts_by_path):
        super().__init__(texts_by_path)
        self.script_attempts = 0

    def generate_product_script(self, brief, _assets, *, count=1):
        del count
        self.script_attempts += 1
        self.script_briefs.append(dict(brief))
        raise ContentEngineError(
            "product_copy_invalid", "AI 脚本未通过结构化校验。"
        )


class _AmbiguousCloud:
    configured = True

    def __init__(self):
        self.calls = []

    def transcribe(self, audio_path, _should_stop):
        self.calls.append(str(Path(audio_path).resolve()))
        raise ContentEngineError(
            "cloud_transcription_timeout",
            "The transcription result is ambiguous.",
        )


class _HappyAnalyzer:
    capability = {
        "available": True,
        "cloud_configured": True,
        "provider": "bailian",
    }

    def __init__(self):
        self.texts_by_path = {}
        self.cloud_client = _HappyCloud(self.texts_by_path)
        self.synthesized = []
        self.designed = []

    @staticmethod
    def analysis_version_for(_asset, _profile=None):
        return "test-analysis-v1"

    def synthesize_auto_mix_phrase(self, text, output_path, _persona_private):
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x01\x00" * 19_200)
        self.texts_by_path[str(output_path.resolve())] = text
        self.synthesized.append(text)
        return {"provider": "bailian", "model": "cosyvoice-v3.5-plus"}

    def design_auto_mix_voice(self, output_path, persona_private):
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x01\x00" * 19_200)
        self.designed.append(str(persona_private.get("voice_prefix") or ""))
        return {
            "provider": "bailian",
            "model": "cosyvoice-v3.5-plus",
            "provider_voice_id": "private-auto-business-voice",
        }


class _UnknownVoiceDesignAnalyzer(_HappyAnalyzer):
    def design_auto_mix_voice(self, _output_path, persona_private):
        self.designed.append(str(persona_private.get("voice_prefix") or ""))
        raise ContentEngineError(
            "auto_mix_voice_design_outcome_unknown",
            "design result unknown",
        )


class _RecoverableUnknownVoiceDesignAnalyzer(_UnknownVoiceDesignAnalyzer):
    def __init__(self):
        super().__init__()
        self.reconciliation_ready = False
        self.reconciled = []

    def reconcile_auto_mix_voice_design(self, persona_private):
        self.reconciled.append(str(persona_private.get("voice_prefix") or ""))
        if not self.reconciliation_ready:
            return {"status": "not_found"}
        return {
            "status": "recovered",
            "provider_voice_id": "private-auto-business-voice-recovered",
        }


class _RejectedUnknownVoiceDesignAnalyzer(_UnknownVoiceDesignAnalyzer):
    def reconcile_auto_mix_voice_design(self, _persona_private):
        return {"status": "rejected"}


class _MutableVersionAnalyzer(_HappyAnalyzer):
    def __init__(self, version="test-analysis-v1", *, emit_segments=True):
        super().__init__()
        self.version = version
        self.emit_segments = emit_segments
        self.analyze_calls = []

    def analysis_version_for(self, _asset, _profile=None):
        return self.version

    def analyze(self, **_kwargs):
        self.analyze_calls.append(self.version)
        is_second_version = self.version.endswith("v2")
        return {
            "analysis_version": self.version,
            "provider": "test",
            "segments": (
                [
                    {
                        "start_ms": 0,
                        "end_ms": 18_000,
                        "transcript": (
                            "第二版机器人完成转向"
                            if is_second_version
                            else "第一版机器人沿墙移动"
                        ),
                        "role": "result" if is_second_version else "process",
                        "shot_type": (
                            "dynamic_action" if is_second_version else "function_demo"
                        ),
                        "tags": ["第二版", "转向"] if is_second_version else ["第一版"],
                        "quality_score": 0.94,
                        "metadata": {
                            "visual_caption": (
                                "第二版现场展示机器人转向"
                                if is_second_version
                                else "第一版现场展示机器人移动"
                            ),
                            "visual_signal_status": "measured",
                            "black_screen": False,
                            "severe_blur": False,
                            "frozen": False,
                            "meaningless": False,
                            "content_signature": (
                                "test-sequence-v2"
                                if is_second_version
                                else "test-sequence-v1"
                            ),
                        },
                    }
                ]
                if self.emit_segments
                else []
            ),
        }


class _GuidedScriptAnalyzer(_MutableVersionAnalyzer):
    def __init__(self, version="test-analysis-v1"):
        super().__init__(version)
        self.cloud_client = _GuidedScriptCloud(self.texts_by_path)


class _RejectedGuidedScriptAnalyzer(_GuidedScriptAnalyzer):
    def __init__(self, version="test-analysis-v1"):
        super().__init__(version)
        self.cloud_client = _RejectedGuidedScriptCloud(self.texts_by_path)


class _ExplicitOnlyAnalyzer(_MutableVersionAnalyzer):
    analysis_version_for = None


class _AmbiguousAnalyzer(_HappyAnalyzer):
    def __init__(self):
        super().__init__()
        self.cloud_client = _AmbiguousCloud()


class _MismatchedCloud:
    configured = True

    def __init__(self):
        self.calls = []

    def transcribe(self, audio_path, _should_stop):
        self.calls.append(str(Path(audio_path).resolve()))
        return [{"transcript": "完全不同的回听内容"}]


class _MismatchedAnalyzer(_HappyAnalyzer):
    def __init__(self):
        super().__init__()
        self.cloud_client = _MismatchedCloud()


class _HappyRenderer(_FakeRenderer):
    def __init__(self):
        self.rendered_recipes = []

    def begin_task(self):
        return None

    def render(self, *, video_id, recipe, output_dir, resolve_asset_path):
        del video_id, resolve_asset_path
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        video = output_dir / "video.mp4"
        cover = output_dir / "cover.jpg"
        video.write_bytes(b"formal-remotion-video")
        cover.write_bytes(b"local-keyframe-cover")
        recipe["packaging"]["visualRenderer"]["actualEngine"] = "remotion"
        recipe["packaging"]["visualRenderer"]["actualStyleVersion"] = 1
        self.rendered_recipes.append(json.loads(json.dumps(recipe)))
        return {
            "video_path": video,
            "thumbnail_path": cover,
            "audioQualityReport": {
                "integrated_lufs": -15.1,
                "true_peak_dbtp": -1.2,
                "speech_music_margin_lu": 10.0,
            },
        }


class _InvalidQualityRenderer(_HappyRenderer):
    def render(self, **kwargs):
        rendered = super().render(**kwargs)
        rendered["audioQualityReport"]["speech_music_margin_lu"] = 5.0
        return rendered


class _GuidedSupplementalImageClient:
    configured = True

    def __init__(self, *, submit_unknown=False):
        self.submit_unknown = submit_unknown
        self.submit_calls = []
        self.poll_calls = []

    def submit(self, prompt, *, reference_path=None):
        self.submit_calls.append(
            {"prompt": str(prompt), "reference_path": reference_path}
        )
        if self.submit_unknown:
            raise APIMartOutcomeUnknown("", "submission outcome is unknown")
        return "supplemental-provider-task-1"

    def poll(self, task_id, *, should_stop=None):
        self.poll_calls.append(str(task_id))
        if should_stop is not None and should_stop():
            raise RuntimeError("poll should not be stopped in this fixture")
        return "https://example.test/guided-supplemental.png"

    @staticmethod
    def download(_url, target):
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        # A compact PNG signature is enough for the sidecar's own MIME and
        # digest validation; no raster decoder is exercised in this unit test.
        target.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        return target


class AutoMixV2ContractTests(unittest.TestCase):
    def test_text_track_normalization_retains_all_bounded_evidence_references(self):
        references = [f"segment-{index}:description" for index in range(1, 19)]
        tracks = normalize_text_tracks(
            {
                "spokenPhrases": [
                    {"text": "真实素材按顺序展示。", "evidenceRefs": references}
                ],
                "visualTextItems": [
                    {
                        "type": "callout",
                        "text": "真实素材展示",
                        "evidenceRefs": references,
                    }
                ],
            }
        )

        self.assertEqual(references, tracks["spoken_phrases"][0]["evidenceRefs"])
        self.assertEqual(
            references, tracks["visual_text_items"][0]["evidenceRefs"]
        )

    def test_create_contract_accepts_legacy_or_confirmed_guided_script(self):
        request = validate_create_auto_mix_v2(
            {
                "specVersion": AUTO_MIX_SPEC_VERSION,
                "assetIds": ["asset-1", "asset-2"],
                "title": "清洁机器人真实作业",
                "copyFramework": "先看现场结果，再讲自动作业，最后给出咨询入口。",
            }
        )

        self.assertEqual(1, request["output_count"])
        self.assertEqual("tts_only", request["voice_policy"])
        self.assertEqual("licensed_auto", request["music_policy"])
        self.assertEqual(["asset-1", "asset-2"], request["asset_ids"])
        self.assertEqual("legacy", request["mode"])

        guided = validate_create_auto_mix_v2(
            {
                "specVersion": AUTO_MIX_SPEC_VERSION,
                "guidedSessionId": "guided_auto_mix_session_11111111111111111111111111111111",
                "scriptRevision": 2,
            }
        )
        self.assertEqual("guided", guided["mode"])
        self.assertEqual(
            "guided_auto_mix_session_11111111111111111111111111111111",
            guided["guided_session_id"],
        )
        self.assertEqual(2, guided["script_revision"])

        with self.assertRaises(AutoMixV2ContractError):
            validate_create_auto_mix_v2(
                {
                    "specVersion": AUTO_MIX_SPEC_VERSION,
                    "guidedSessionId": "guided_auto_mix_session_11111111111111111111111111111111",
                    "scriptRevision": 2,
                    "title": "不允许混入旧字段",
                }
            )

        for legacy_field in (
            "durationMs",
            "targetCount",
            "bgmAssetId",
            "sourceAudioPolicy",
        ):
            with self.subTest(field=legacy_field):
                with self.assertRaises(AutoMixV2ContractError):
                    validate_create_auto_mix_v2(
                        {
                            "specVersion": AUTO_MIX_SPEC_VERSION,
                            "assetIds": ["asset-1"],
                            "title": "标题",
                            "copyFramework": "真实框架",
                            legacy_field: 1,
                        }
                    )

    def test_material_timeline_shortens_naturally_and_never_reuses_a_range(self):
        short = build_material_timeline(
            [
                {
                    "asset_id": "asset-1",
                    "media_kind": "video",
                    "usable_intervals": [
                        {"start_ms": 1_000, "end_ms": 8_000, "quality_score": 0.92},
                    ],
                },
                {
                    "asset_id": "asset-2",
                    "media_kind": "video",
                    "usable_intervals": [
                        {"start_ms": 0, "end_ms": 6_000, "quality_score": 0.81},
                    ],
                },
            ]
        )
        self.assertEqual(13_000, short["usable_material_duration_ms"])
        self.assertEqual(13_000, short["selected_duration_ms"])
        self.assertFalse(short["padded"])
        self.assertFalse(short["looped"])

        long_assets = [
            {
                "asset_id": f"asset-{index}",
                "media_kind": "video",
                "usable_intervals": [
                    {
                        "start_ms": 0,
                        "end_ms": 18_000,
                        "quality_score": 0.9 - index / 100,
                        "content_signature": f"scene-{index}",
                    }
                ],
            }
            for index in range(10)
        ]
        long_plan = build_material_timeline(long_assets)
        self.assertEqual(120_000, long_plan["selected_duration_ms"])
        self.assertTrue(long_plan["shortened_to_ceiling"])

        ranges_by_asset: dict[str, list[tuple[int, int]]] = {}
        for segment in long_plan["selected_segments"]:
            ranges_by_asset.setdefault(segment["asset_id"], []).append(
                (segment["source_start_ms"], segment["source_end_ms"])
            )
            self.assertEqual(
                segment["source_end_ms"] - segment["source_start_ms"],
                segment["target_duration_ms"],
            )
            self.assertNotIn("speed", segment)
        for ranges in ranges_by_asset.values():
            for index, current in enumerate(ranges):
                for other in ranges[index + 1 :]:
                    self.assertFalse(
                        current[0] < other[1] and other[0] < current[1]
                    )

        overlapping = build_material_timeline(
            [
                {
                    "asset_id": "asset-overlap",
                    "media_kind": "video",
                    "usable_intervals": [
                        {"start_ms": 0, "end_ms": 8_000, "quality_score": 0.9},
                        {"start_ms": 4_000, "end_ms": 10_000, "quality_score": 0.7},
                    ],
                }
            ]
        )
        self.assertEqual(8_000, overlapping["usable_material_duration_ms"])

        medium = build_material_timeline(
            [
                {
                    "asset_id": f"asset-medium-{index}",
                    "media_kind": "video",
                    "usable_intervals": [
                        {
                            "start_ms": 0,
                            "end_ms": 12_000,
                            "quality_score": 0.8,
                            "content_signature": f"medium-scene-{index}",
                        }
                    ],
                }
                for index in range(6)
            ]
        )
        self.assertEqual(72_000, medium["selected_duration_ms"])

    def test_spoken_and_visual_text_tracks_are_separate_and_measured(self):
        framework = "先展示自动清扫。再展示贴边作业。最后邀请了解详情。"
        evidence_facts = [
            {
                "factId": "fact-1",
                "text": "机器人沿墙移动",
                "kind": "visual",
                "role": "process",
                "timelineStartMs": 0,
                "qualityScore": 0.92,
                "evidenceRefs": ["segment-1:description"],
            },
            {
                "factId": "fact-2",
                "text": "画面出现充电座",
                "kind": "visual",
                "role": "result",
                "timelineStartMs": 5_000,
                "qualityScore": 0.88,
                "evidenceRefs": ["segment-2:description"],
            },
        ]
        tracks = build_grounded_text_tracks(
            title="清洁机器人真实作业",
            copy_framework=framework,
            evidence_facts=evidence_facts,
        )
        self.assertTrue(tracks["spoken_phrases"])
        self.assertTrue(all(len(item["text"]) <= 14 for item in tracks["spoken_phrases"]))
        self.assertEqual(
            {"hook", "callout", "cta"},
            {item["type"] for item in tracks["visual_text_items"]},
        )
        self.assertNotIn(
            framework,
            {item["text"] for item in tracks["visual_text_items"]},
        )
        all_output_text = " ".join(
            item["text"]
            for item in [
                *tracks["spoken_phrases"],
                *tracks["visual_text_items"],
            ]
        )
        self.assertNotIn("先展示自动清扫", all_output_text)
        self.assertNotIn("贴边作业", all_output_text)
        self.assertTrue(
            all(
                item["evidenceRefs"] == [f"segment-{index + 1}:description"]
                for index, item in enumerate(tracks["spoken_phrases"][:2])
            )
        )

        regenerated = build_grounded_text_tracks(
            title="清洁机器人真实作业",
            copy_framework=framework,
            evidence_facts=evidence_facts,
            generation=2,
        )
        self.assertNotEqual(
            [item["text"] for item in tracks["spoken_phrases"]],
            [item["text"] for item in regenerated["spoken_phrases"]],
        )

        captions = build_speech_captions(
            tracks["spoken_phrases"][:2], [1_120, 980], pause_ms=160
        )
        self.assertEqual("audio_measured", captions[0]["timing"])
        self.assertEqual(0, captions[0]["start_ms"])
        self.assertEqual(1_120, captions[0]["end_ms"])
        self.assertEqual(1_280, captions[1]["start_ms"])
        self.assertEqual(2_260, captions[1]["end_ms"])

    def test_normalized_spoken_tracks_never_emit_punctuation_only_phrases(self):
        tracks = normalize_text_tracks(
            {
                "spoken_phrases": [
                    {"text": "先看自动清洁机器人的真实素材。"},
                    {"text": "画面来自工厂车间的实际片段。"},
                ],
                "visual_text_items": [
                    {"type": "hook", "text": "自动清洁机器人"}
                ],
            }
        )

        source_text = "先看自动清洁机器人的真实素材。画面来自工厂车间的实际片段。"
        spoken_texts = [item["text"] for item in tracks["spoken_phrases"]]
        self.assertEqual(
            source_text,
            "".join(spoken_texts),
        )
        self.assertTrue(
            all(re.search(r"[A-Za-z0-9\u4e00-\u9fff]", item["text"])
                for item in tracks["spoken_phrases"])
        )
        self.assertTrue(all(len(item) <= AUTO_MIX_CAPTION_CHARS for item in spoken_texts))

    def test_normalized_spoken_tracks_do_not_leave_tiny_tts_tails(self):
        source = (
            "也适合设备多、通道窄的室内环境。"
            "光滑地板、硬质地面，它都适应。"
            "窄工业走廊里，贴着管道匀速穿行。"
            "避开管道和支架。脏一点？AI识别后自动增强吸力，重点洗。"
        )
        tracks = normalize_text_tracks(
            {
                "spoken_phrases": [{"text": source}],
                "visual_text_items": [{"type": "hook", "text": "自动清洁"}],
            }
        )

        phrases = [item["text"] for item in tracks["spoken_phrases"]]
        self.assertEqual(source, "".join(phrases))
        self.assertTrue(all(len(item) <= 14 for item in phrases))
        self.assertTrue(
            all(
                len(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", item)) >= 5
                for item in phrases
            )
        )

    def test_guided_script_rejects_internal_material_labels(self):
        issue = guided_script_audience_copy_issue(
            "自动清洁机器人开始工作。",
            "自动清洁机器人开始工作。素材画面记录了机器人移动。"
            "这就是自动清洁机器人的现场作业。",
            "这就是自动清洁机器人的现场作业。",
        )

        self.assertIn("素材画面记录了", issue)

    def test_caption_evidence_alignment_covers_uneven_phrase_windows(self):
        timeline = {
            "usable_material_duration_ms": 9_000,
            "selected_duration_ms": 9_000,
            "selected_segments": [
                {
                    "segment_id": "timeline-a",
                    "evidence_ref": "evidence-a",
                    "asset_id": "asset-a",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 6_000,
                    "timeline_start_ms": 0,
                    "timeline_end_ms": 6_000,
                    "target_duration_ms": 6_000,
                    "role": "process",
                },
                {
                    "segment_id": "timeline-b",
                    "evidence_ref": "evidence-b",
                    "asset_id": "asset-b",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 3_000,
                    "timeline_start_ms": 6_000,
                    "timeline_end_ms": 9_000,
                    "target_duration_ms": 3_000,
                    "role": "result",
                },
            ],
            "padded": False,
            "looped": False,
        }
        phrases = [
            {
                "phraseId": f"phrase-{index + 1}",
                "text": f"真实短句{index + 1}",
                "evidenceRefs": [
                    "evidence-a:description" if index < 3 else "evidence-b:description"
                ],
            }
            for index in range(4)
        ]
        captions = build_speech_captions(phrases, [1_000] * 4, pause_ms=160)

        aligned = align_material_timeline_to_captions(timeline, phrases, captions)

        self.assertEqual(captions[-1]["end_ms"], aligned["selected_duration_ms"])
        self.assertEqual(
            ["evidence-a", "evidence-b"],
            [item["evidence_ref"] for item in aligned["selected_segments"]],
        )
        for phrase, caption in zip(phrases, captions):
            evidence_key = phrase["evidenceRefs"][0].split(":", 1)[0]
            matching = [
                item
                for item in aligned["selected_segments"]
                if item["evidence_ref"] == evidence_key
            ]
            cursor = caption["start_ms"]
            for item in matching:
                if item["timeline_end_ms"] <= cursor:
                    continue
                if item["timeline_start_ms"] > cursor:
                    break
                cursor = max(cursor, item["timeline_end_ms"])
                if cursor >= caption["end_ms"]:
                    break
            self.assertGreaterEqual(cursor, caption["end_ms"])

        source_ranges = {}
        for item in aligned["selected_segments"]:
            ranges = source_ranges.setdefault(item["asset_id"], [])
            current = (item["source_start_ms"], item["source_end_ms"])
            self.assertTrue(
                all(
                    current[1] <= previous[0] or previous[1] <= current[0]
                    for previous in ranges
                )
            )
            ranges.append(current)

    def test_caption_alignment_uses_spare_material_for_inter_phrase_pause(self):
        timeline = {
            "usable_material_duration_ms": 11_000,
            "selected_duration_ms": 11_000,
            "selected_segments": [
                {
                    "segment_id": "timeline-a",
                    "evidence_ref": "evidence-a",
                    "asset_id": "asset-a",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 4_900,
                    "timeline_start_ms": 0,
                    "timeline_end_ms": 4_900,
                    "target_duration_ms": 4_900,
                    "role": "process",
                },
                {
                    "segment_id": "timeline-gap",
                    "evidence_ref": "transition-gap",
                    "asset_id": "asset-gap",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 1_200,
                    "timeline_start_ms": 4_900,
                    "timeline_end_ms": 6_100,
                    "target_duration_ms": 1_200,
                    "role": "process",
                },
                {
                    "segment_id": "timeline-b",
                    "evidence_ref": "evidence-b",
                    "asset_id": "asset-b",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 4_900,
                    "timeline_start_ms": 6_100,
                    "timeline_end_ms": 11_000,
                    "target_duration_ms": 4_900,
                    "role": "result",
                },
            ],
            "padded": False,
            "looped": False,
        }
        phrases = [
            {
                "phraseId": "phrase-a",
                "text": "第一句真实口播",
                "evidenceRefs": ["evidence-a:description"],
            },
            {
                "phraseId": "phrase-b",
                "text": "第二句真实口播",
                "evidenceRefs": ["evidence-b:description"],
            },
        ]
        captions = build_speech_captions(phrases, [4_900, 4_900], pause_ms=160)

        aligned = align_material_timeline_to_captions(timeline, phrases, captions)

        self.assertEqual(9_960, aligned["selected_duration_ms"])
        self.assertFalse(aligned["padded"])
        self.assertFalse(aligned["looped"])
        self.assertEqual(
            [
                ("evidence-a", 0, 4_900),
                ("transition-gap", 4_900, 5_060),
                ("evidence-b", 5_060, 9_960),
            ],
            [
                (
                    item["evidence_ref"],
                    item["timeline_start_ms"],
                    item["timeline_end_ms"],
                )
                for item in aligned["selected_segments"]
            ],
        )
        source_ranges = {}
        for item in aligned["selected_segments"]:
            ranges = source_ranges.setdefault(item["asset_id"], [])
            current = (item["source_start_ms"], item["source_end_ms"])
            self.assertTrue(
                all(
                    current[1] <= previous[0] or previous[1] <= current[0]
                    for previous in ranges
                )
            )
            ranges.append(current)

        speech_too_long = build_speech_captions(
            phrases, [4_901, 4_900], pause_ms=160
        )
        with self.assertRaises(AutoMixV2ContractError) as context:
            align_material_timeline_to_captions(
                timeline, phrases, speech_too_long
            )
        self.assertEqual(
            "auto_mix_material_evidence_too_short", context.exception.code
        )

    def test_caption_alignment_assigns_multi_evidence_phrases_globally(self):
        timeline = {
            "usable_material_duration_ms": 10_000,
            "selected_duration_ms": 10_000,
            "selected_segments": [
                {
                    "segment_id": "timeline-a",
                    "evidence_ref": "evidence-a",
                    "asset_id": "asset-shared",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": 5_000,
                    "timeline_start_ms": 0,
                    "timeline_end_ms": 5_000,
                    "target_duration_ms": 5_000,
                    "role": "process",
                },
                {
                    "segment_id": "timeline-b",
                    "evidence_ref": "evidence-b",
                    "asset_id": "asset-shared",
                    "media_kind": "video",
                    "source_start_ms": 5_000,
                    "source_end_ms": 10_000,
                    "timeline_start_ms": 5_000,
                    "timeline_end_ms": 10_000,
                    "target_duration_ms": 5_000,
                    "role": "result",
                },
            ],
            "padded": False,
            "looped": False,
        }
        phrases = [
            {
                "phraseId": "phrase-flexible",
                "text": "第一句可由两段素材承载",
                "evidenceRefs": [
                    "evidence-a:description",
                    "evidence-b:description",
                ],
            },
            {
                "phraseId": "phrase-constrained",
                "text": "第二句只能由第一段素材承载",
                "evidenceRefs": ["evidence-a:description"],
            },
        ]
        captions = [
            {
                "phraseId": "phrase-flexible",
                "text": phrases[0]["text"],
                "start_ms": 0,
                "end_ms": 5_000,
                "timing": "audio_measured",
            },
            {
                "phraseId": "phrase-constrained",
                "text": phrases[1]["text"],
                "start_ms": 5_000,
                "end_ms": 10_000,
                "timing": "audio_measured",
            },
        ]

        aligned = align_material_timeline_to_captions(timeline, phrases, captions)

        self.assertEqual(
            [
                ("evidence-b", 0, 5_000),
                ("evidence-a", 5_000, 10_000),
            ],
            [
                (
                    item["evidence_ref"],
                    item["timeline_start_ms"],
                    item["timeline_end_ms"],
                )
                for item in aligned["selected_segments"]
            ],
        )
        self.assertEqual(
            [
                {"phrase_id": "phrase-flexible", "evidence_ref": "evidence-b"},
                {"phrase_id": "phrase-constrained", "evidence_ref": "evidence-a"},
            ],
            aligned["spoken_evidence_refs"],
        )
        self.assertFalse(aligned["padded"])
        self.assertFalse(aligned["looped"])
        source_ranges = [
            (item["source_start_ms"], item["source_end_ms"])
            for item in aligned["selected_segments"]
        ]
        self.assertTrue(
            all(
                current[1] <= previous[0] or previous[1] <= current[0]
                for index, current in enumerate(source_ranges)
                for previous in source_ranges[:index]
            )
        )

    def test_material_facts_only_come_from_selected_traceable_signals(self):
        facts = build_material_evidence_facts(
            {
                "selected_segments": [
                    {
                        "segment_id": "timeline-1",
                        "evidence_ref": "source-segment-1",
                        "timeline_start_ms": 0,
                        "description": "机器人沿墙移动",
                        "verifiable_text": "屏幕显示百分之八十",
                        "tags": ["室内", "清扫"],
                        "shot_type": "function_demo",
                        "role": "process",
                        "quality_score": 0.91,
                    }
                ]
            }
        )
        self.assertEqual(
            {
                "屏幕显示百分之八十",
                "机器人沿墙移动",
                "室内、清扫",
                "功能演示镜头",
            },
            {item["text"] for item in facts},
        )
        self.assertTrue(
            all(
                item["evidenceRefs"][0].startswith("source-segment-1:")
                for item in facts
            )
        )
        with self.assertRaises(AutoMixV2ContractError) as context:
            build_grounded_text_tracks(
                title="只有标题",
                copy_framework="先讲卖点，再邀请咨询。",
                evidence_facts=[],
            )
        self.assertEqual(
            "auto_mix_material_facts_insufficient", context.exception.code
        )

    def test_music_selection_requires_current_commercial_evidence(self):
        brief = build_music_brief(
            title="真实清扫现场",
            copy_framework="节奏稳健，先展示过程，再展示结果。",
            transition_points_ms=[0, 8_000, 16_000],
        )
        now = datetime(2026, 8, 24, tzinfo=timezone.utc)
        tracks = [
            {
                "track_id": "expired",
                "display_name": "已过期",
                "license_status": "valid",
                "commercial_scope": "commercial",
                "commercial_use_allowed": True,
                "evidence_present": True,
                "expires_at": "2026-08-23T00:00:00Z",
                "analysis_status": "ready",
                "bpm": 100,
                "moods": ["steady"],
                "energy": 0.5,
                "duration_ms": 90_000,
            },
            {
                "track_id": "missing-proof",
                "display_name": "无凭证",
                "license_status": "valid",
                "commercial_scope": "commercial",
                "commercial_use_allowed": True,
                "evidence_present": False,
                "analysis_status": "ready",
                "bpm": 100,
                "moods": ["steady"],
                "energy": 0.5,
                "duration_ms": 90_000,
            },
        ]
        self.assertIsNone(
            select_licensed_music(tracks, brief, required_duration_ms=30_000, now=now)
        )

        tracks.append(
            {
                "track_id": "licensed",
                "display_name": "稳健节奏",
                "license_status": "valid",
                "commercial_scope": "commercial",
                "commercial_use_allowed": True,
                "evidence_present": True,
                "expires_at": None,
                "analysis_status": "ready",
                "bpm": 104,
                "moods": ["steady", "credible"],
                "energy": 0.56,
                "duration_ms": 90_000,
                "integrated_lufs": -19.2,
                "true_peak_dbtp": -2.1,
            }
        )
        selected = select_licensed_music(
            tracks, brief, required_duration_ms=30_000, now=now
        )
        self.assertEqual("licensed", selected["track_id"])
        self.assertNotIn("managed_relative_path", selected["public"])

        tracks[-1]["commercial_scope"] = "non-commercial / 禁止商用"
        tracks[-1]["commercial_use_allowed"] = False
        self.assertIsNone(
            select_licensed_music(tracks, brief, required_duration_ms=30_000, now=now)
        )

    def test_material_structure_changes_music_brief_and_selected_track(self):
        energetic_signals = [
            {
                "role": role,
                "shot_type": "dynamic_action",
                "tags": ["速度", "运动"],
                "quality_score": 0.94,
                "timeline_start_ms": index * 1_000,
                "timeline_end_ms": (index + 1) * 1_000,
            }
            for index, role in enumerate(("hook", "process", "process", "result"))
        ]
        calm_signals = [
            {
                "role": "process",
                "shot_type": "detail_close_up",
                "tags": ["静态", "细节"],
                "quality_score": 0.82,
                "timeline_start_ms": index * 4_000,
                "timeline_end_ms": (index + 1) * 4_000,
            }
            for index in range(3)
        ]
        energetic = build_music_brief(
            title="同一标题",
            copy_framework="先看素材，再看结果。",
            transition_points_ms=[0, 1_000, 2_000, 3_000],
            material_signals=energetic_signals,
        )
        calm = build_music_brief(
            title="同一标题",
            copy_framework="先看素材，再看结果。",
            transition_points_ms=[0, 4_000, 8_000],
            material_signals=calm_signals,
        )
        self.assertGreater(energetic["targetEnergy"], calm["targetEnergy"])
        self.assertNotEqual(energetic["bpmRange"], calm["bpmRange"])
        self.assertEqual(
            {"hook": 1, "process": 2, "result": 1},
            energetic["materialSignals"]["roles"],
        )
        self.assertTrue(energetic["musicSectionHints"])

        common = {
            "license_status": "valid",
            "commercial_scope": "commercial",
            "commercial_use_allowed": True,
            "evidence_present": True,
            "expires_at": None,
            "analysis_status": "ready",
            "duration_ms": 30_000,
        }
        tracks = [
            {
                **common,
                "track_id": "calm-track",
                "display_name": "舒缓",
                "bpm": 90,
                "moods": ["calm", "warm"],
                "energy": 0.32,
            },
            {
                **common,
                "track_id": "action-track",
                "display_name": "动感",
                "bpm": 120,
                "moods": ["energetic", "driving"],
                "energy": 0.82,
            },
        ]
        selected_energetic = select_licensed_music(
            tracks, energetic, required_duration_ms=12_000
        )
        selected_calm = select_licensed_music(
            tracks, calm, required_duration_ms=12_000
        )
        self.assertEqual("action-track", selected_energetic["track_id"])
        self.assertEqual("calm-track", selected_calm["track_id"])

    def test_music_mood_aliases_match_without_rewriting_public_tags(self):
        common = {
            "license_status": "valid",
            "commercial_scope": "commercial",
            "commercial_use_allowed": True,
            "evidence_present": True,
            "expires_at": None,
            "analysis_status": "ready",
            "bpm": 104,
            "energy": 0.56,
            "duration_ms": 30_000,
        }
        cases = (
            (["舒缓", "明亮"], ["calm", "warm"]),
            (["可靠"], ["steady", "credible"]),
            (["轻快", "励志"], ["energetic", "driving"]),
            (["relaxed", "lighthearted"], ["calm", "warm"]),
            (["positive", "futuristic", "technology"], ["steady", "credible"]),
            (["dramatic", "cinematic", "motivational"], ["energetic", "driving"]),
            (["humorous", "quirky", "comedy"], ["energetic", "driving"]),
        )
        for aliases, brief_moods in cases:
            with self.subTest(aliases=aliases):
                tracks = [
                    {
                        **common,
                        "track_id": "alias-track",
                        "display_name": "标签兼容曲",
                        "moods": aliases,
                    },
                    {
                        **common,
                        "track_id": "unrelated-track",
                        "display_name": "无关标签曲",
                        "moods": ["unrelated"],
                    },
                ]
                selected = select_licensed_music(
                    tracks,
                    {
                        "moods": brief_moods,
                        "targetEnergy": 0.56,
                        "bpmRange": [92, 116],
                        "energyCurve": [{"position": 0, "energy": 0.56}],
                        "transitionPointsMs": [],
                    },
                    required_duration_ms=12_000,
                )
                self.assertEqual("alias-track", selected["track_id"])
                self.assertEqual(aliases, selected["public"]["moods"])

    def test_regeneration_invalidates_only_the_requested_layer_and_downstream(self):
        self.assertEqual(
            (
                "text",
                "tts",
                "voice_alignment",
                "mix",
                "render",
                "quality_check",
            ),
            invalidated_stages_for_layer("text"),
        )
        self.assertEqual(
            ("tts", "voice_alignment", "mix", "render", "quality_check"),
            invalidated_stages_for_layer("voice"),
        )
        self.assertEqual(
            ("music_selection", "mix", "render", "quality_check"),
            invalidated_stages_for_layer("music"),
        )

    def test_voice_verification_keeps_brand_and_number_tokens_fail_closed(self):
        matched = verify_spoken_phrase(
            "谷小智 AI 已完成 30 次真实测试",
            "谷小智AI已完成三十次真实测试",
            title="谷小智 AI",
        )
        self.assertFalse(matched["matched"])
        self.assertIn("30", matched["missingCriticalTokens"])

        passed = verify_spoken_phrase(
            "谷小智 AI 已完成 30 次真实测试",
            "谷小智 AI 已完成 30 次真实测试",
            title="谷小智 AI",
        )
        self.assertTrue(passed["matched"])

    def test_voice_verification_does_not_treat_generic_ai_as_brand(self):
        result = verify_spoken_phrase(
            "AI会自动加大清洁力。",
            "会自动加大清洁力。",
            title="工厂现场自动清洁机器人自动作业",
        )

        self.assertGreaterEqual(result["similarity"], 0.72)
        self.assertEqual([], result["missingCriticalTokens"])
        self.assertEqual(0, result["criticalTokenCount"])
        self.assertTrue(result["matched"])

    def test_voice_verification_tolerates_short_same_length_asr_homophones_without_critical_terms(self):
        result = verify_spoken_phrase(
            "它绕过红柱子和闸机。",
            "他绕过红柱子和炸鸡。",
        )

        self.assertEqual(0.6667, result["similarity"])
        self.assertEqual([], result["missingCriticalTokens"])
        self.assertEqual(0, result["criticalTokenCount"])
        self.assertTrue(result["matched"])

        shorter = verify_spoken_phrase(
            "它绕过红柱和闸机。",
            "他绕过红柱和炸鸡。",
        )
        self.assertEqual(0.625, shorter["similarity"])
        self.assertEqual([], shorter["missingCriticalTokens"])
        self.assertEqual(0, shorter["criticalTokenCount"])
        self.assertTrue(shorter["matched"])

    def test_voice_verification_uses_confirmed_brand_terms(self):
        result = verify_spoken_phrase(
            "知了AI正在清扫。",
            "正在清扫。",
            title="工厂现场自动清洁机器人自动作业",
            critical_terms=["知了AI"],
        )

        self.assertFalse(result["matched"])
        self.assertEqual(["知了ai"], result["missingCriticalTokens"])
        self.assertEqual(1, result["criticalTokenCount"])

        unrelated = verify_spoken_phrase(
            "设备正在清扫。",
            "设备正在清扫。",
            critical_terms=["知了AI"],
        )
        self.assertTrue(unrelated["matched"])
        self.assertEqual(0, unrelated["criticalTokenCount"])

    def test_public_plan_is_allowlisted_and_formal_recipe_fails_closed(self):
        public = public_auto_mix_plan(
            {
                "run_id": "run-1",
                "project_id": "project-1",
                "status": "planned",
                "spec_version": AUTO_MIX_SPEC_VERSION,
                "input_hash": "input-hash",
                "input_asset_ids": [
                    "asset-1",
                    "asset-2",
                    "asset-1",
                    "C:/private/video.mp4",
                ],
                "public_plan": {
                    "usableMaterialDurationMs": 20_000,
                    "selectedSegments": [],
                    "speechCaptions": [],
                    "visualTextItems": [],
                    "voicePersona": {"voicePersonaId": "natural-life@1"},
                    "music": None,
                    "absolutePath": "C:/private/video.mp4",
                    "providerVoiceId": "secret-voice",
                    "apiKey": "sk-secret",
                    "inputAssetIds": ["asset-model-plan"],
                },
                "private_state": {"managed_relative_path": "music/private.mp3"},
            }
        )
        encoded = str(public)
        self.assertNotIn("C:/private", encoded)
        self.assertNotIn("secret-voice", encoded)
        self.assertNotIn("sk-secret", encoded)
        self.assertNotIn("input-hash", encoded)
        self.assertEqual(["asset-1", "asset-2"], public["inputAssetIds"])
        self.assertNotIn("asset-model-plan", encoded)

        with self.assertRaises(AutoMixV2ContractError):
            validate_formal_recipe(
                {
                    "product_workflow": "one_click_v2",
                    "captions": [
                        {
                            "text": "估算字幕",
                            "start_ms": 0,
                            "end_ms": 900,
                            "timing": "estimated",
                        }
                    ],
                    "packaging": {
                        "visualRenderer": {
                            "requestedEngine": "remotion",
                            "actualEngine": "ffmpeg",
                        }
                    },
                }
            )

        report = validate_quality_report(
            {
                "integrated_lufs": -15.1,
                "true_peak_dbtp": -1.2,
                "speech_music_margin_lu": 10.0,
            }
        )
        self.assertTrue(report["passed"])
        with self.assertRaises(AutoMixV2ContractError):
            validate_quality_report(
                {
                    "integrated_lufs": -13.5,
                    "true_peak_dbtp": -0.4,
                    "speech_music_margin_lu": 5.0,
                }
            )


class AutoMixV2MigrationTests(unittest.TestCase):
    def test_v9_tables_are_additive_and_preserve_v1_rows(self):
        root = SIDECAR_ROOT / f".auto-mix-v2-migration-{uuid.uuid4().hex}"
        root.mkdir()
        try:
            database = Database(root).open()
            now = "2026-08-24T00:00:00.000Z"
            database.connection.execute(
                """
                INSERT INTO creative_projects(
                    id, mode, name, theme, status, settings_json, result_json,
                    created_at, updated_at
                ) VALUES (?, 'mix', ?, ?, 'queued', ?, '{}', ?, ?)
                """,
                (
                    "legacy-product-project",
                    "旧商品一键成片",
                    "旧商品",
                    json.dumps({"workflow": "product_one_click"}),
                    now,
                    now,
                ),
            )
            database.close()

            reopened = Database(root).open()
            tables = {
                row[0]
                for row in reopened.connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            versions = [
                row[0]
                for row in reopened.connection.execute(
                    "SELECT version FROM schema_migrations ORDER BY version"
                )
            ]
            legacy = reopened.connection.execute(
                "SELECT settings_json FROM creative_projects WHERE id = ?",
                ("legacy-product-project",),
            ).fetchone()
            reopened.close()

            self.assertTrue(
                {
                    "auto_mix_runs_v2",
                    "auto_mix_stage_artifacts_v2",
                    "music_catalog_tracks_v1",
                    "voice_personas_v1",
                    "auto_mix_voice_previews_v1",
                    "auto_mix_voice_designs_v1",
                    "guided_auto_mix_sessions_v1",
                    "guided_auto_mix_supplemental_images_v1",
                }.issubset(tables)
            )
            self.assertIn(9, versions)
            self.assertIn(10, versions)
            self.assertIn(11, versions)
            self.assertIn(14, versions)
            self.assertIn(15, versions)
            self.assertIn(16, versions)
            self.assertEqual(
                "product_one_click", json.loads(legacy["settings_json"])["workflow"]
            )
        finally:
            shutil.rmtree(root, ignore_errors=True)


class AutoMixV2ServiceTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".auto-mix-v2-service-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.source = self.root / "material.mp4"
        self.source.write_bytes(b"test-material")
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=_FakeAnalyzer(),
                creative_renderer=_FakeRenderer(),
                start_background_jobs=False,
            )
        now = "2026-08-24T00:00:00.000Z"
        with self.service.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO assets(
                    id, fingerprint, full_fingerprint, media_kind, extension,
                    size_bytes, display_name, rights_status, probe_status,
                    duration_ms, width, height, fps, has_audio,
                    created_at, updated_at
                ) VALUES (
                    'asset-v2', 'fingerprint-v2', 'full-fingerprint-v2',
                    'video', '.mp4', ?, 'V2 素材', 'owned', 'ok',
                    18000, 1080, 1920, 30, 1, ?, ?
                )
                """,
                (self.source.stat().st_size, now, now),
            )
            connection.execute(
                """
                INSERT INTO asset_locations(
                    id, asset_id, absolute_path, size_bytes, modified_ns,
                    is_available, created_at, last_seen_at
                ) VALUES (
                    'location-v2', 'asset-v2', ?, ?, ?, 1, ?, ?
                )
                """,
                (
                    str(self.source),
                    self.source.stat().st_size,
                    self.source.stat().st_mtime_ns,
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO media_segments(
                    id, asset_id, start_ms, end_ms, transcript_text, speaker,
                    role, shot_type, tags_json, quality_score,
                    analysis_version, provider, metadata_json,
                    created_at, updated_at
                ) VALUES (
                    'segment-v2', 'asset-v2', 0, 18000,
                    '机器人沿墙移动', '', 'process', 'function_demo',
                    '["室内", "清扫"]', 0.92, 'test-analysis-v1', 'test',
                    '{"description":"画面出现清洁机器人和充电座","visual_signal_status":"measured","black_screen":false,"severe_blur":false,"frozen":false,"meaningless":false,"content_signature":"test-sequence-base"}', ?, ?
                )
                """,
                (now, now),
            )

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def _request(**extra):
        return {
            "specVersion": "2",
            "assetIds": ["asset-v2"],
            "title": "真实素材一键混剪",
            "copyFramework": "先展示真实现场，再说明核心价值，最后邀请了解详情。",
            **extra,
        }

    def _install_approved_voice(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, approved_at,
                active, created_at, updated_at
            ) VALUES (
                'natural-life@1', 1, '自然生活', 'natural_life',
                'test-catalog-v1', 'bailian', 'cosyvoice-v3.5-plus',
                'private-provider-voice', '自然口播', ?, 1, ?, ?
            )
            """,
            (now, now, now),
        )

    def _install_auto_voice_template(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, voice_prompt,
                voice_prefix, catalog_source, approved_at, active, created_at,
                updated_at
            ) VALUES (
                'reliable-business@1', 1, '可靠商务', 'reliable_business',
                'test-catalog-v1', 'bailian', 'cosyvoice-v3.5-plus', '',
                '可靠、克制、重点明确。', '自然可靠的中文男声', 'biz26',
                'configured', NULL, 1, ?, ?
            )
            """,
            (now, now),
        )

    def _import_valid_music(self, *, with_loop=False):
        music = self.root / "valid-licensed.wav"
        with wave.open(str(music), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x00\x00" * 24_000)
        evidence = self.root / "valid-license.txt"
        evidence.write_text("commercial", encoding="utf-8")
        return self.service.import_music_catalog_track(
            {
                "sourcePath": str(music),
                "displayName": "稳健节奏",
                "source": "用户授权曲库",
                "commercialScope": "commercial social media",
                "commercialUseAllowed": True,
                "licenseStatus": "valid",
                "expiresAt": None,
                "credentialReference": "valid-license-record",
                "evidencePath": str(evidence),
                "bpm": 104,
                "moods": ["steady", "credible"],
                "energy": 0.56,
                "loopStartMs": 1_000 if with_loop else None,
                "loopEndMs": 2_000 if with_loop else None,
            }
        )

    def _use_pipeline(self, analyzer, renderer):
        self.service.creative_analyzer = analyzer
        self.service.creative_renderer = renderer
        self.service.creative_domain.analyzer = analyzer
        self.service.creative_domain.renderer = renderer

    def _complete_happy_v2(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        renderer = _HappyRenderer()
        self._use_pipeline(analyzer, renderer)
        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        self.assertEqual("completed", task["status"])
        plan = self.service.get_auto_mix_plan_v2(project_id=created["projectId"])
        self.assertEqual("completed", plan["state"])
        return plan, renderer

    def test_legacy_regeneration_rejects_v2_before_creating_state_or_rendering(self):
        plan, renderer = self._complete_happy_v2()
        task_count = self.service.connection.execute(
            "SELECT COUNT(*) FROM content_tasks"
        ).fetchone()[0]
        candidate_count = self.service.connection.execute(
            "SELECT COUNT(*) FROM generated_videos"
        ).fetchone()[0]
        render_count = len(renderer.rendered_recipes)

        for status in ("completed", "queued"):
            with self.subTest(status=status):
                self.service.connection.execute(
                    "UPDATE generated_videos SET status = ? WHERE id = ?",
                    (status, plan["generatedVideoId"]),
                )
                with self.assertRaises(ContentEngineError) as context:
                    self.service.regenerate_video(plan["generatedVideoId"])

                self.assertEqual(
                    "auto_mix_v2_layer_regeneration_required", context.exception.code
                )
                self.assertIn("text", context.exception.message)
                self.assertIn("voice", context.exception.message)
                self.assertIn("music", context.exception.message)
        self.assertEqual(
            task_count,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM content_tasks"
            ).fetchone()[0],
        )
        self.assertEqual(
            candidate_count,
            self.service.connection.execute(
                "SELECT COUNT(*) FROM generated_videos"
            ).fetchone()[0],
        )
        self.assertEqual(render_count, len(renderer.rendered_recipes))

    def test_v2_render_rejects_tampered_voice_before_calling_renderer(self):
        plan, renderer = self._complete_happy_v2()
        candidate_id = plan["generatedVideoId"]
        row = self.service.connection.execute(
            "SELECT recipe_json FROM generated_videos WHERE id = ?", (candidate_id,)
        ).fetchone()
        recipe = json.loads(row["recipe_json"])
        voice_path = self.root / recipe["voice_audio_path"]
        payload = bytearray(voice_path.read_bytes())
        payload[-1] = (payload[-1] + 1) % 256
        voice_path.write_bytes(payload)
        self.service.connection.execute(
            """
            UPDATE generated_videos
            SET status = 'queued', output_path = NULL, thumbnail_path = NULL
            WHERE id = ?
            """,
            (candidate_id,),
        )
        render_count = len(renderer.rendered_recipes)

        with self.assertRaises(ContentEngineError) as context:
            self.service.creative_domain._render_generated(candidate_id)

        self.assertEqual("auto_mix_voice_cache_changed", context.exception.code)
        self.assertEqual(render_count, len(renderer.rendered_recipes))
        failed = self.service.connection.execute(
            "SELECT status, error_code FROM generated_videos WHERE id = ?",
            (candidate_id,),
        ).fetchone()
        self.assertEqual("failed", failed["status"])
        self.assertEqual("auto_mix_voice_cache_changed", failed["error_code"])

    def test_v2_render_rechecks_music_revocation_and_expiry_before_renderer(self):
        plan, renderer = self._complete_happy_v2()
        candidate_id = plan["generatedVideoId"]
        track_id = plan["music"]["trackId"]
        render_count = len(renderer.rendered_recipes)

        invalid_catalog_states = (
            {
                "commercial_use_allowed": 0,
                "license_status": "valid",
                "expires_at": None,
            },
            {
                "commercial_use_allowed": 1,
                "license_status": "valid",
                "expires_at": "2000-01-01T00:00:00Z",
            },
        )
        for state in invalid_catalog_states:
            with self.subTest(state=state):
                self.service.connection.execute(
                    """
                    UPDATE music_catalog_tracks_v1
                    SET commercial_use_allowed = ?, license_status = ?, expires_at = ?
                    WHERE id = ?
                    """,
                    (
                        state["commercial_use_allowed"],
                        state["license_status"],
                        state["expires_at"],
                        track_id,
                    ),
                )
                self.service.connection.execute(
                    """
                    UPDATE generated_videos
                    SET status = 'queued', output_path = NULL, thumbnail_path = NULL,
                        error_code = NULL, error_message = NULL
                    WHERE id = ?
                    """,
                    (candidate_id,),
                )

                with self.assertRaises(ContentEngineError) as context:
                    self.service.creative_domain._render_generated(candidate_id)

                self.assertEqual(
                    "auto_mix_music_authorization_changed", context.exception.code
                )
                self.assertEqual(render_count, len(renderer.rendered_recipes))
                failed = self.service.connection.execute(
                    "SELECT status, error_code FROM generated_videos WHERE id = ?",
                    (candidate_id,),
                ).fetchone()
                self.assertEqual("failed", failed["status"])
                self.assertEqual(
                    "auto_mix_music_authorization_changed", failed["error_code"]
                )

    def test_v2_render_rechecks_music_audio_and_evidence_digests(self):
        plan, renderer = self._complete_happy_v2()
        candidate_id = plan["generatedVideoId"]
        track = self.service.connection.execute(
            """
            SELECT managed_relative_path, managed_evidence_relative_path
            FROM music_catalog_tracks_v1 WHERE id = ?
            """,
            (plan["music"]["trackId"],),
        ).fetchone()
        render_count = len(renderer.rendered_recipes)
        managed_paths = (
            self.root / track["managed_relative_path"],
            self.root / track["managed_evidence_relative_path"],
        )

        for managed_path in managed_paths:
            with self.subTest(managed_path=managed_path.name):
                original = managed_path.read_bytes()
                changed = bytearray(original)
                changed[-1] = (changed[-1] + 1) % 256
                managed_path.write_bytes(changed)
                try:
                    self.service.connection.execute(
                        """
                        UPDATE generated_videos
                        SET status = 'queued', output_path = NULL,
                            thumbnail_path = NULL, error_code = NULL,
                            error_message = NULL
                        WHERE id = ?
                        """,
                        (candidate_id,),
                    )

                    with self.assertRaises(ContentEngineError) as context:
                        self.service.creative_domain._render_generated(candidate_id)

                    self.assertEqual(
                        "auto_mix_music_authorization_changed",
                        context.exception.code,
                    )
                    self.assertEqual(render_count, len(renderer.rendered_recipes))
                finally:
                    managed_path.write_bytes(original)

    def test_create_and_get_plan_are_idempotent_and_v2_only(self):
        created = self.service.create_auto_mix_v2(self._request())
        repeated = self.service.create_auto_mix_v2(self._request())

        self.assertEqual("analyzing", created["state"])
        self.assertEqual(created["taskId"], repeated["taskId"])
        self.assertEqual(created["projectId"], repeated["projectId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("analyzing", plan["state"])
        self.assertEqual(1, plan["outputCount"])
        self.assertEqual(created["taskId"], plan["taskId"])
        for response in (created, repeated, plan):
            self.assertEqual(["asset-v2"], response["inputAssetIds"])
        stored_plan = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (created["runId"],),
        ).fetchone()
        self.assertNotIn("inputAssetIds", json.loads(stored_plan["public_plan_json"]))

        with self.assertRaises(AutoMixV2ContractError):
            self.service.create_auto_mix_v2(self._request(durationMs=60_000))

    def test_interrupted_guided_script_is_marked_unknown_and_never_resubmitted(self):
        self._use_pipeline(_MutableVersionAnalyzer("test-analysis-v1"), _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        completed_analysis = self.service.run_creative_task(analysis_task_id)
        self.assertEqual("completed", completed_analysis["status"])

        ready = self.service.get_guided_auto_mix_session_v2(
            task_id=analysis_task_id
        )
        self.assertEqual("ready_for_answers", ready["status"])
        drafting = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"],
            "工厂清扫现场",
            {
                "companyName": "示例公司",
                "productName": "无人清洁机器人",
                "targetScene": "工厂车间",
                "keyMessage": "减少人工看守",
                "extraNotes": "不写未经验证的参数",
            },
        )
        draft_task_id = drafting["draft_task"]["task_id"]
        self.service.update_task(draft_task_id, "analyzing")

        self.service._recover_inflight_tasks()

        recovered = self.service.get_guided_auto_mix_session_v2(
            task_id=draft_task_id
        )
        self.assertEqual("outcome_unknown", recovered["status"])
        task = self.service._get_public_task(draft_task_id)
        self.assertEqual("paused", task["status"])
        with self.assertRaises(ContentEngineError) as caught:
            self.service.resume_creative_task(draft_task_id)
        self.assertEqual("guided_auto_mix_outcome_unknown", caught.exception.code)

    def test_known_guided_script_validation_failure_never_writes_a_local_script(self):
        analyzer = _RejectedGuidedScriptAnalyzer("test-analysis-v1")
        self._use_pipeline(analyzer, _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        self.service.run_creative_task(analysis_task_id)
        ready = self.service.get_guided_auto_mix_session_v2(task_id=analysis_task_id)
        answers = {
            "companyName": "示例公司",
            "productName": "无人清洁机器人",
            "targetScene": "工厂车间",
            "keyMessage": "减少人工看守",
            "extraNotes": "不写未经验证的参数",
        }
        drafting = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"], "工厂清扫现场", answers
        )
        draft_task_id = drafting["draft_task"]["task_id"]
        failed = self.service.run_creative_task(draft_task_id)

        self.assertEqual("failed", failed["status"])
        self.assertEqual("product_copy_invalid", failed["error_code"])
        self.assertEqual(1, analyzer.cloud_client.script_attempts)
        recovered = self.service.get_guided_auto_mix_session_v2(
            session_id=ready["session_id"]
        )
        self.assertEqual("ready_for_answers", recovered["status"])
        self.assertEqual(answers, recovered["answers"])
        self.assertEqual("failed", recovered["draft_task"]["status"])
        self.assertEqual(
            "product_copy_invalid", recovered["draft_task"]["error_code"]
        )
        self.assertEqual(0, recovered["draft"]["scriptRevision"])
        self.assertIsNone(recovered["draft"]["provider"])
        self.assertEqual("", recovered["draft"]["voiceover"])
        self.assertEqual([], recovered["draft"]["spokenPhrases"])
        self.assertIsNone(recovered["draft"]["draftHash"])

    def test_guided_task_stop_keeps_queued_work_recoverable_and_running_work_unknown(self):
        self._use_pipeline(_MutableVersionAnalyzer("test-analysis-v1"), _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        self.service.run_creative_task(analysis_task_id)
        ready = self.service.get_guided_auto_mix_session_v2(task_id=analysis_task_id)
        answers = {
            "companyName": "示例公司",
            "productName": "无人清洁机器人",
            "targetScene": "工厂车间",
            "keyMessage": "减少人工看守",
            "extraNotes": "不写未经验证的参数",
        }
        queued = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"], "工厂清扫现场", answers
        )
        queued_task_id = queued["draft_task"]["task_id"]
        self.service.update_task(queued_task_id, "cancelled")
        restored = self.service.get_guided_auto_mix_session_v2(
            session_id=ready["session_id"]
        )
        self.assertEqual("ready_for_answers", restored["status"])

        running = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"], "工厂清扫现场", answers
        )
        running_task_id = running["draft_task"]["task_id"]
        self.service.update_task(running_task_id, "analyzing")
        self.service.update_task(running_task_id, "paused")
        unknown = self.service.get_guided_auto_mix_session_v2(
            session_id=ready["session_id"]
        )
        self.assertEqual("outcome_unknown", unknown["status"])

    def test_guided_analysis_exposes_editable_material_prefill_without_confirming_answers(self):
        self._use_pipeline(_MutableVersionAnalyzer("test-analysis-v1"), _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        self.service.run_creative_task(session["analysis_task"]["task_id"])

        ready = self.service.get_guided_auto_mix_session_v2(
            task_id=session["analysis_task"]["task_id"]
        )

        self.assertEqual("ready_for_answers", ready["status"])
        self.assertEqual({}, ready["answers"])
        self.assertEqual("机器人", ready["prefill"]["answers"]["productName"])
        self.assertEqual("现场机器人展示", ready["prefill"]["title"])
        self.assertEqual("", ready["prefill"]["answers"]["companyName"])
        self.assertIn("仅使用素材中", ready["prefill"]["answers"]["extraNotes"])

    def test_guided_script_plans_multisentence_duration_before_tts(self):
        analyzer = _GuidedScriptAnalyzer("test-analysis-v1")
        self._use_pipeline(analyzer, _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        self.service.run_creative_task(analysis_task_id)
        ready = self.service.get_guided_auto_mix_session_v2(task_id=analysis_task_id)
        drafting = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"],
            "工厂清扫现场",
            {
                "companyName": "示例公司",
                "productName": "无人清洁机器人",
                "targetScene": "工厂车间",
                "keyMessage": "减少人工看守",
                "extraNotes": "不写未经验证的参数",
            },
        )
        self.service.run_creative_task(drafting["draft_task"]["task_id"])

        brief = analyzer.cloud_client.script_briefs[0]
        script_assets = analyzer.cloud_client.script_assets[0]
        self.assertTrue(brief["guided_storyboard"])
        self.assertIn(
            "第一版现场展示机器人移动",
            script_assets[0]["visual_evidence"],
        )
        self.assertEqual(16_560, brief["target_duration_ms"])
        self.assertGreaterEqual(brief["voiceover_min_chars"], 8)
        self.assertLessEqual(
            brief["voiceover_min_chars"], brief["voiceover_max_chars"]
        )
        self.assertGreaterEqual(brief["voiceover_min_sentence_count"], 3)
        scripted = self.service.get_guided_auto_mix_session_v2(
            session_id=ready["session_id"]
        )
        duration_plan = scripted["draft"]["durationPlan"]
        self.assertEqual(16_560, duration_plan["target_duration_ms"])
        self.assertGreaterEqual(
            len(scripted["draft"]["voiceover"]), brief["voiceover_min_chars"]
        )
        self.assertGreaterEqual(
            len(scripted["draft"]["spokenPhrases"]),
            brief["voiceover_min_sentence_count"],
        )

    def test_guided_duration_plan_caps_long_material_at_one_minute(self):
        plan = self.service.creative_domain._guided_auto_mix_duration_plan(
            {"selected_duration_ms": 82_646}
        )

        self.assertEqual("auto", plan["policy"])
        self.assertEqual(82_646, plan["material_capacity_ms"])
        self.assertEqual(60_000, plan["target_duration_ms"])
        self.assertGreaterEqual(plan["minimum_duration_ms"], 50_000)
        self.assertLessEqual(plan["maximum_duration_ms"], 60_000)
        self.assertGreaterEqual(plan["voiceover_min_sentence_count"], 8)

    def test_guided_script_is_the_only_input_used_for_v2_creation(self):
        self._use_pipeline(_GuidedScriptAnalyzer("test-analysis-v1"), _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        self.service.run_creative_task(analysis_task_id)
        ready = self.service.get_guided_auto_mix_session_v2(
            task_id=analysis_task_id
        )
        drafting = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"],
            "工厂清扫现场",
            {
                "companyName": "示例公司",
                "productName": "无人清洁机器人",
                "targetScene": "工厂车间",
                "keyMessage": "减少人工看守",
                "extraNotes": "不写未经验证的参数",
            },
        )
        draft_task_id = drafting["draft_task"]["task_id"]
        self.service.run_creative_task(draft_task_id)
        scripted = self.service.get_guided_auto_mix_session_v2(task_id=draft_task_id)
        self.assertEqual("ready_for_render", scripted["status"])
        self.assertEqual(1, scripted["draft"]["scriptRevision"])

        plan = self.service.create_auto_mix_v2(
            {
                "specVersion": "2",
                "guidedSessionId": scripted["session_id"],
                "scriptRevision": scripted["draft"]["scriptRevision"],
            }
        )
        row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (plan["runId"],),
        ).fetchone()
        private_state = json.loads(row["private_state_json"])
        self.assertEqual(scripted["session_id"], private_state["guided_session_id"])
        self.assertEqual(1, private_state["guided_script_revision"])
        self.assertTrue(private_state["text_tracks"]["spoken_phrases"])
        self.assertEqual(
            scripted["draft"]["durationPlan"]["target_duration_ms"],
            private_state["duration_plan"]["target_duration_ms"],
        )
        self.assertEqual(
            ["示例公司", "无人清洁机器人"],
            private_state["guided_critical_terms"],
        )
        self.assertNotIn("copy_framework", private_state)

    def test_legacy_guided_voice_recovery_restores_confirmed_brand_terms(self):
        self._install_approved_voice()
        self._use_pipeline(_GuidedScriptAnalyzer("test-analysis-v1"), _HappyRenderer())
        session = self.service.prepare_guided_auto_mix_v2(["asset-v2"])
        analysis_task_id = session["analysis_task"]["task_id"]
        self.service.run_creative_task(analysis_task_id)
        ready = self.service.get_guided_auto_mix_session_v2(
            task_id=analysis_task_id
        )
        drafting = self.service.generate_guided_auto_mix_script_v2(
            ready["session_id"],
            "工厂清扫现场",
            {
                "companyName": "示例公司",
                "productName": "无人清洁机器人",
                "targetScene": "工厂车间",
                "keyMessage": "减少人工看守",
                "extraNotes": "不写未经验证的参数",
            },
        )
        draft_task_id = drafting["draft_task"]["task_id"]
        self.service.run_creative_task(draft_task_id)
        scripted = self.service.get_guided_auto_mix_session_v2(task_id=draft_task_id)
        created = self.service.create_auto_mix_v2(
            {
                "specVersion": "2",
                "guidedSessionId": scripted["session_id"],
                "scriptRevision": scripted["draft"]["scriptRevision"],
            }
        )
        row = self.service.connection.execute(
            """
            SELECT public_plan_json, private_state_json
            FROM auto_mix_runs_v2 WHERE id = ?
            """,
            (created["runId"],),
        ).fetchone()
        public_plan = json.loads(row["public_plan_json"])
        private_state = json.loads(row["private_state_json"])
        private_state.pop("guided_critical_terms", None)
        public_plan["attention"] = {
            "code": "auto_mix_voice_verification_failed",
            "layer": "voice",
            "message": "关键品牌词与回听结果不一致。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'needs_attention', public_plan_json = ?,
                private_state_json = ?, selected_voice_persona_id = 'natural-life@1'
            WHERE id = ?
            """,
            (
                json.dumps(public_plan, ensure_ascii=False),
                json.dumps(private_state, ensure_ascii=False),
                created["runId"],
            ),
        )

        original_answers = self.service.connection.execute(
            "SELECT answers_json FROM guided_auto_mix_sessions_v1 WHERE id = ?",
            (scripted["session_id"],),
        ).fetchone()["answers_json"]
        changed_answers = json.loads(original_answers)
        changed_answers["companyName"] = "另一家公司"
        changed_answers["productName"] = "另一款设备"
        self.service.connection.execute(
            "UPDATE guided_auto_mix_sessions_v1 SET answers_json = ? WHERE id = ?",
            (
                json.dumps(changed_answers, ensure_ascii=False),
                scripted["session_id"],
            ),
        )
        with self.assertRaises(ContentEngineError) as changed_context:
            self.service.regenerate_auto_mix_layer(
                created["projectId"], "voice", expected_run_id=created["runId"]
            )
        self.assertEqual(
            "auto_mix_guided_script_required", changed_context.exception.code
        )
        self.service.connection.execute(
            "UPDATE guided_auto_mix_sessions_v1 SET answers_json = ? WHERE id = ?",
            (original_answers, scripted["session_id"]),
        )

        recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice", expected_run_id=created["runId"]
        )
        recovered = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (recovery["runId"],),
        ).fetchone()
        recovered_private = json.loads(recovered["private_state_json"])

        self.assertEqual(
            ["示例公司", "无人清洁机器人"],
            recovered_private["guided_critical_terms"],
        )

    def test_layer_regeneration_creates_a_new_generation_and_never_retries_unknown(self):
        created = self.service.create_auto_mix_v2(self._request())
        first = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        with self.assertRaises(ContentEngineError) as running_context:
            self.service.regenerate_auto_mix_layer(
                created["projectId"], "music"
            )
        self.assertEqual(
            "auto_mix_regeneration_unavailable", running_context.exception.code
        )

        self.service.connection.execute(
            "UPDATE auto_mix_runs_v2 SET status = 'completed' WHERE id = ?",
            (first["runId"],),
        )
        regenerated = self.service.regenerate_auto_mix_layer(
            created["projectId"], "music"
        )
        second = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("selecting_music", regenerated["state"])
        self.assertEqual(2, second["generation"])
        self.assertEqual(first["runId"], second["parentRunId"])
        self.assertEqual("music", second["cache"]["regeneratedLayer"])
        self.assertEqual(first["inputAssetIds"], second["inputAssetIds"])

        self.service.connection.execute(
            "UPDATE auto_mix_runs_v2 SET status = 'outcome_unknown' WHERE id = ?",
            (second["runId"],),
        )
        with self.assertRaises(ContentEngineError) as context:
            self.service.regenerate_auto_mix_layer(
                created["projectId"], "music"
            )
        self.assertEqual("auto_mix_outcome_unknown", context.exception.code)

    def test_stale_run_recovery_is_rejected_without_creating_a_generation(self):
        created = self.service.create_auto_mix_v2(self._request())
        first = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        first_row = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first["runId"],),
        ).fetchone()
        first_failed_plan = json.loads(first_row["public_plan_json"])
        first_failed_plan["attention"] = {
            "code": "auto_mix_voice_music_margin_failed",
            "layer": "music",
            "message": "说话窗口的人声与音乐余量未达到 8 到 12 LU。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'failed', public_plan_json = ?
            WHERE id = ?
            """,
            (json.dumps(first_failed_plan), first["runId"]),
        )

        self.service.regenerate_auto_mix_layer(
            created["projectId"],
            "music",
            expected_run_id=first["runId"],
        )
        latest = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        latest_row = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (latest["runId"],),
        ).fetchone()
        latest_attention_plan = json.loads(latest_row["public_plan_json"])
        latest_attention_plan["attention"] = {
            "code": "auto_mix_material_evidence_too_short",
            "layer": "text",
            "message": "引用素材不足以覆盖对应口播的真实时间窗口。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'needs_attention', public_plan_json = ?
            WHERE id = ?
            """,
            (json.dumps(latest_attention_plan), latest["runId"]),
        )
        counts_before = self.service.connection.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM auto_mix_runs_v2 WHERE project_id = ?) AS runs,
              (SELECT COUNT(*) FROM content_tasks) AS tasks
            """,
            (created["projectId"],),
        ).fetchone()

        with self.assertRaises(ContentEngineError) as context:
            self.service.regenerate_auto_mix_layer(
                created["projectId"],
                "music",
                expected_run_id=first["runId"],
            )

        counts_after = self.service.connection.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM auto_mix_runs_v2 WHERE project_id = ?) AS runs,
              (SELECT COUNT(*) FROM content_tasks) AS tasks
            """,
            (created["projectId"],),
        ).fetchone()
        self.assertEqual("auto_mix_run_stale", context.exception.code)
        self.assertEqual(tuple(counts_before), tuple(counts_after))

    def test_timing_failure_recovery_reuses_selected_voice_and_cached_audio(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("completed", first_task["status"])
        synthesized_before = list(analyzer.synthesized)
        transcriptions_before = list(analyzer.cloud_client.calls)
        current = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first_plan["runId"],),
        ).fetchone()
        failed_plan = json.loads(current["public_plan_json"])
        failed_plan["attention"] = {
            "code": "auto_mix_voice_timing_invalid",
            "layer": "voice",
            "message": "拼接配音的真实时长与字幕边界不一致。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'failed', public_plan_json = ?
            WHERE id = ?
            """,
            (json.dumps(failed_plan), first_plan["runId"]),
        )

        recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        recovered_task = self.service.run_creative_task(recovery["taskId"])
        recovered_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", recovered_task["status"])
        self.assertEqual("completed", recovered_plan["state"])
        self.assertEqual(
            first_plan["voicePersona"]["voicePersonaId"],
            recovered_plan["voicePersona"]["voicePersonaId"],
        )
        self.assertEqual(synthesized_before, analyzer.synthesized)
        self.assertEqual(transcriptions_before, analyzer.cloud_client.calls)

    def test_voice_verification_recovery_reuses_selected_voice_and_cached_audio(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("completed", first_task["status"])
        synthesized_before = list(analyzer.synthesized)
        transcriptions_before = list(analyzer.cloud_client.calls)
        current = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first_plan["runId"],),
        ).fetchone()
        failed_plan = json.loads(current["public_plan_json"])
        failed_plan["attention"] = {
            "code": "auto_mix_voice_verification_failed",
            "layer": "voice",
            "message": "关键品牌词或数字与回听结果不一致。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'needs_attention', public_plan_json = ?
            WHERE id = ?
            """,
            (json.dumps(failed_plan, ensure_ascii=False), first_plan["runId"]),
        )

        recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice", expected_run_id=first_plan["runId"]
        )
        recovered_task = self.service.run_creative_task(recovery["taskId"])
        recovered_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", recovered_task["status"])
        self.assertEqual("completed", recovered_plan["state"])
        self.assertEqual(
            first_plan["voicePersona"]["voicePersonaId"],
            recovered_plan["voicePersona"]["voicePersonaId"],
        )
        self.assertEqual(synthesized_before, analyzer.synthesized)
        self.assertEqual(transcriptions_before, analyzer.cloud_client.calls)

    def test_legacy_alignment_recovery_keeps_text_voice_and_verified_audio(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("completed", first_task["status"])
        first_text = list(first_plan["spokenPhrases"])
        synthesized_before = list(analyzer.synthesized)
        transcriptions_before = list(analyzer.cloud_client.calls)
        current = self.service.connection.execute(
            "SELECT public_plan_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first_plan["runId"],),
        ).fetchone()
        failed_plan = json.loads(current["public_plan_json"])
        failed_plan["attention"] = {
            "code": "auto_mix_material_too_short",
            "layer": "text",
            "message": "引用素材不足以覆盖对应口播的真实时间窗口。",
        }
        self.service.connection.execute(
            """
            UPDATE auto_mix_runs_v2
            SET status = 'needs_attention', public_plan_json = ?
            WHERE id = ?
            """,
            (json.dumps(failed_plan), first_plan["runId"]),
        )

        recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        recovered_task = self.service.run_creative_task(recovery["taskId"])
        recovered_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", recovered_task["status"])
        self.assertEqual("completed", recovered_plan["state"])
        self.assertEqual(["segment-v2:text"], first_text[0]["evidenceRefs"])
        self.assertEqual(
            ["segment-v2:text"],
            recovered_plan["spokenPhrases"][0]["evidenceRefs"],
        )
        self.assertEqual(first_text, recovered_plan["spokenPhrases"])
        self.assertEqual(
            first_plan["voicePersona"]["voicePersonaId"],
            recovered_plan["voicePersona"]["voicePersonaId"],
        )
        self.assertEqual(synthesized_before, analyzer.synthesized)
        self.assertEqual(transcriptions_before, analyzer.cloud_client.calls)
        self.assertEqual("voice", recovered_plan["cache"]["regeneratedLayer"])

    def test_run_stops_at_attention_when_no_approved_voice_exists(self):
        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", task["status"])
        self.assertEqual("needs_attention", plan["state"])
        self.assertEqual(
            "auto_mix_voice_persona_approval_required",
            plan["attention"]["code"],
        )
        self.assertEqual("voice", plan["attention"]["layer"])
        self.assertTrue(plan["selectedSegments"])
        self.assertEqual([], plan["speechCaptions"])
        with self.assertRaises(ContentEngineError) as mismatch_context:
            self.service.regenerate_auto_mix_layer(
                created["projectId"], "music"
            )
        self.assertEqual(
            "auto_mix_recovery_layer_mismatch", mismatch_context.exception.code
        )

    def test_run_auto_prepares_recommended_voice_without_manual_resource_steps(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        renderer = _HappyRenderer()
        self._use_pipeline(analyzer, renderer)

        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", task["status"])
        self.assertEqual("completed", plan["state"])
        self.assertEqual(
            "reliable-business@1", plan["voicePersona"]["voicePersonaId"]
        )
        self.assertEqual("approved", plan["voicePersona"]["approvalStatus"])
        self.assertEqual(["biz26"], analyzer.designed)
        row = self.service.connection.execute(
            """
            SELECT provider_voice_id, approved_at
            FROM voice_personas_v1 WHERE id = 'reliable-business@1'
            """
        ).fetchone()
        self.assertEqual("private-auto-business-voice", row["provider_voice_id"])
        self.assertIsNotNone(row["approved_at"])

        repeated = self.service.create_auto_mix_v2(self._request())
        self.assertEqual(created["taskId"], repeated["taskId"])
        self.assertEqual(["biz26"], analyzer.designed)

    def test_auto_voice_unknown_stops_and_is_never_retried(self):
        self._install_auto_voice_template()
        analyzer = _UnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", first_task["status"])
        self.assertEqual("outcome_unknown", first_plan["state"])
        self.assertEqual(["biz26"], analyzer.designed)

        with self.assertRaises(ContentEngineError) as blocked:
            self.service.regenerate_auto_mix_layer(created["projectId"], "voice")
        self.assertEqual("auto_mix_alternate_voice_required", blocked.exception.code)

        self.service.connection.execute(
            "UPDATE content_tasks SET status = 'queued' WHERE id = ?",
            (created["taskId"],),
        )
        second_task = self.service.run_creative_task(created["taskId"])
        second_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("paused", second_task["status"])
        self.assertEqual("outcome_unknown", second_plan["state"])
        self.assertEqual(["biz26"], analyzer.designed)

        self._install_approved_voice()
        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        replacement_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual("synthesizing", replacement["state"])
        self.assertEqual("synthesizing", replacement_plan["state"])
        self.assertEqual(["biz26"], analyzer.designed)

    def test_auto_voice_unknown_is_reconciled_without_recreating_remote_voice(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RecoverableUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", first_task["status"])
        self.assertEqual("outcome_unknown", first_plan["state"])
        self.assertEqual(["biz26"], analyzer.designed)
        self.assertEqual(["biz26"], analyzer.reconciled)

        analyzer.reconciliation_ready = True
        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        completed_task = self.service.run_creative_task(replacement["taskId"])
        completed_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", completed_task["status"])
        self.assertEqual("completed", completed_plan["state"])
        self.assertEqual(["biz26"], analyzer.designed)
        self.assertGreaterEqual(analyzer.reconciled.count("biz26"), 2)
        self.assertEqual(
            "reliable-business@1",
            completed_plan["voicePersona"]["voicePersonaId"],
        )

    def test_auto_voice_unknown_missing_after_grace_can_retry_on_user_action(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RecoverableUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        self.assertEqual("paused", first_task["status"])
        self.assertEqual(["biz26"], analyzer.designed)
        self.service.connection.execute(
            """
            UPDATE auto_mix_voice_designs_v1
            SET created_at = '2026-01-01T00:00:00.000Z',
                updated_at = '2026-01-01T00:00:00.000Z'
            WHERE status = 'outcome_unknown'
            """
        )

        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        second_task = self.service.run_creative_task(replacement["taskId"])

        self.assertEqual("paused", second_task["status"])
        self.assertEqual(["biz26", "biz26"], analyzer.designed)

    def test_auto_voice_submitted_before_restart_is_reconciled(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RecoverableUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        self.service.run_creative_task(created["taskId"])
        self.service.connection.execute(
            "UPDATE auto_mix_voice_designs_v1 SET status = 'submitted'"
        )
        analyzer.reconciliation_ready = True

        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        completed_task = self.service.run_creative_task(replacement["taskId"])

        self.assertEqual("completed", completed_task["status"])
        self.assertEqual(["biz26"], analyzer.designed)

    def test_auto_voice_submitted_missing_after_grace_can_retry(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RecoverableUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        self.service.run_creative_task(created["taskId"])
        self.service.connection.execute(
            """
            UPDATE auto_mix_voice_designs_v1
            SET status = 'submitted',
                updated_at = '2026-01-01T00:00:00.000Z'
            """
        )

        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )

        self.assertEqual("synthesizing", replacement["state"])
        self.assertEqual(["biz26"], analyzer.designed)

    def test_auto_voice_retry_grace_uses_latest_unknown_time(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RecoverableUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        self.service.run_creative_task(created["taskId"])
        self.service.connection.execute(
            """
            UPDATE auto_mix_voice_designs_v1
            SET created_at = '2026-01-01T00:00:00.000Z'
            WHERE status = 'outcome_unknown'
            """
        )

        with self.assertRaises(ContentEngineError) as blocked:
            self.service.regenerate_auto_mix_layer(created["projectId"], "voice")

        self.assertEqual("auto_mix_alternate_voice_required", blocked.exception.code)
        self.assertEqual(["biz26"], analyzer.designed)

    def test_auto_voice_rejected_result_can_be_replaced_but_never_completes(self):
        self._install_auto_voice_template()
        self._import_valid_music()
        analyzer = _RejectedUnknownVoiceDesignAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", first_task["status"])
        self.assertEqual("outcome_unknown", first_plan["state"])
        replacement = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        self.assertEqual("synthesizing", replacement["state"])
        self.assertEqual(["biz26"], analyzer.designed)

    def test_failed_current_analysis_never_falls_back_to_old_segments(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO media_segments(
                id, asset_id, start_ms, end_ms, transcript_text, speaker,
                role, shot_type, tags_json, quality_score,
                analysis_version, provider, metadata_json, created_at, updated_at
            ) VALUES (
                'segment-v2-before-failure', 'asset-v2', 0, 18000,
                '本次失败前的第二版旧片段', '', 'process', 'function_demo',
                '["旧片段"]', 0.9, 'test-analysis-v2', 'test',
                '{"description":"本次失败前的第二版旧画面","visual_signal_status":"measured","black_screen":false,"severe_blur":false,"frozen":false,"meaningless":false,"content_signature":"test-sequence-stale-v2"}', ?, ?
            )
            """,
            (now, now),
        )
        self._use_pipeline(_MutableVersionAnalyzer("test-analysis-v1"), _FakeRenderer())
        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        self.assertEqual("paused", first_task["status"])

        analyzer = _FailingCurrentAnalyzer()
        self._use_pipeline(analyzer, _FakeRenderer())
        self.service.resume_creative_task(created["taskId"])
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(project_id=created["projectId"])

        self.assertEqual(1, analyzer.calls)
        self.assertEqual("paused", task["status"])
        self.assertEqual("needs_attention", plan["state"])
        self.assertEqual(
            "auto_mix_material_facts_insufficient", plan["attention"]["code"]
        )
        self.assertEqual([], plan["selectedSegments"])
        self.assertEqual([], plan["spokenPhrases"])
        self.assertIn(
            "auto_mix_assets_skipped",
            {
                item.get("code")
                for item in plan.get("qualityWarnings") or []
                if isinstance(item, dict)
            },
        )

    def test_explicit_analysis_version_with_zero_segments_never_uses_latest(self):
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO media_segments(
                id, asset_id, start_ms, end_ms, transcript_text, speaker,
                role, shot_type, tags_json, quality_score,
                analysis_version, provider, metadata_json, created_at, updated_at
            ) VALUES (
                'segment-v2-stale', 'asset-v2', 0, 18000,
                '不能复用的旧第二版片段', '', 'process', 'function_demo',
                '["旧片段"]', 0.9, 'test-analysis-v2', 'test',
                '{"description":"不能复用的旧第二版画面","visual_signal_status":"measured","black_screen":false,"severe_blur":false,"frozen":false,"meaningless":false,"content_signature":"test-sequence-explicit-stale"}', ?, ?
            )
            """,
            (now, now),
        )
        analyzer = _ExplicitOnlyAnalyzer(
            "test-analysis-v2", emit_segments=False
        )
        self._use_pipeline(analyzer, _FakeRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual(["test-analysis-v2"], analyzer.analyze_calls)
        self.assertEqual("paused", first_task["status"])
        self.assertEqual("needs_attention", first_plan["state"])
        self.assertEqual(
            "auto_mix_material_facts_insufficient",
            first_plan["attention"]["code"],
        )
        self.assertEqual([], first_plan["selectedSegments"])

        self.service.resume_creative_task(created["taskId"])
        self.service.run_creative_task(created["taskId"])
        second_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        self.assertEqual(
            ["test-analysis-v2", "test-analysis-v2"], analyzer.analyze_calls
        )
        self.assertEqual([], second_plan["selectedSegments"])

    def test_analysis_version_drift_rebuilds_a_paused_run_before_resume(self):
        analyzer = _MutableVersionAnalyzer("test-analysis-v1")
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        self.assertEqual("paused", first_task["status"])
        first_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (created["runId"],),
        ).fetchone()
        first_private = json.loads(first_row["private_state_json"])
        self.assertEqual(
            {"asset-v2": "test-analysis-v1"},
            first_private["analysis_versions"],
        )
        self.assertTrue(first_private["analysis_config_hash"])

        analyzer.version = "test-analysis-v2"
        self._install_approved_voice()
        self._import_valid_music()
        self.service.resume_creative_task(created["taskId"])
        resumed_task = self.service.run_creative_task(created["taskId"])
        resumed_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", resumed_task["status"])
        self.assertEqual(["test-analysis-v2"], analyzer.analyze_calls)
        self.assertIn(
            "第二版", " ".join(item["text"] for item in resumed_plan["spokenPhrases"])
        )
        resumed_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (created["runId"],),
        ).fetchone()
        resumed_private = json.loads(resumed_row["private_state_json"])
        self.assertEqual(
            {"asset-v2": "test-analysis-v2"},
            resumed_private["analysis_versions"],
        )
        self.assertNotEqual(
            first_private["analysis_config_hash"],
            resumed_private["analysis_config_hash"],
        )

    def test_analysis_version_drift_invalidates_voice_regeneration_downstream(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _MutableVersionAnalyzer("test-analysis-v1")
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        first_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first_plan["runId"],),
        ).fetchone()
        first_private = json.loads(first_row["private_state_json"])
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, approved_at,
                active, created_at, updated_at
            ) VALUES (
                'reliable-business@1', 1, '可靠商务', 'reliable_business',
                'test-catalog-v2', 'bailian', 'cosyvoice-v3.5-plus',
                'private-provider-voice-2', '自然可靠口播', ?, 1, ?, ?
            )
            """,
            (now, now, now),
        )

        analyzer.version = "test-analysis-v2"
        regenerated = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice"
        )
        regenerated_task = self.service.run_creative_task(regenerated["taskId"])
        regenerated_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", regenerated_task["status"])
        self.assertEqual(["test-analysis-v2"], analyzer.analyze_calls)
        self.assertIn(
            "第二版",
            " ".join(item["text"] for item in regenerated_plan["spokenPhrases"]),
        )
        regenerated_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (regenerated_plan["runId"],),
        ).fetchone()
        regenerated_private = json.loads(regenerated_row["private_state_json"])
        self.assertEqual(
            {"asset-v2": "test-analysis-v2"},
            regenerated_private["analysis_versions"],
        )
        self.assertNotEqual(
            first_private["analysis_config_hash"],
            regenerated_private["analysis_config_hash"],
        )

    def test_final_timeline_is_the_single_source_for_text_and_music(self):
        now = "2026-08-24T00:00:00.000Z"
        with self.service.database.transaction() as connection:
            connection.execute(
                "DELETE FROM media_segments WHERE asset_id = 'asset-v2'"
            )
            connection.executemany(
                """
                INSERT INTO media_segments(
                    id, asset_id, start_ms, end_ms, transcript_text, speaker,
                    role, shot_type, tags_json, quality_score,
                    analysis_version, provider, metadata_json,
                    created_at, updated_at
                ) VALUES (?, 'asset-v2', ?, ?, ?, '', ?, ?, ?, 0.92,
                          'test-analysis-v1', 'test', ?, ?, ?)
                """,
                [
                    (
                        "segment-v2-calm",
                        0,
                        9_000,
                        "前段展示静态机身",
                        "hook",
                        "static_close_up",
                        '["静态", "细节"]',
                        '{"description":"前段只有静态产品",'
                        '"visual_signal_status":"measured","black_screen":false,'
                        '"severe_blur":false,"frozen":false,"meaningless":false,'
                        '"content_signature":"test-sequence-calm"}',
                        now,
                        now,
                    ),
                    (
                        "segment-v2-action",
                        9_000,
                        18_000,
                        "后段展示机器快速运动",
                        "result",
                        "dynamic_action",
                        '["速度", "运动"]',
                        '{"description":"后段机器快速运动",'
                        '"visual_signal_status":"measured","black_screen":false,'
                        '"severe_blur":false,"frozen":false,"meaningless":false,'
                        '"content_signature":"test-sequence-action"}',
                        now,
                        now,
                    ),
                ],
            )
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        renderer = _HappyRenderer()
        self._use_pipeline(analyzer, renderer)

        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(project_id=created["projectId"])

        self.assertEqual("completed", task["status"])
        self.assertEqual("completed", plan["state"])
        final_refs = {
            str(item.get("evidence_ref") or item.get("segment_id") or "")
            for item in plan["selectedSegments"]
        }
        self.assertEqual(
            {"segment-v2-calm", "segment-v2-action"}, final_refs
        )
        persisted = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (plan["runId"],),
        ).fetchone()
        private_state = json.loads(persisted["private_state_json"])
        timeline_starts = {
            str(item.get("evidence_ref") or item.get("segment_id") or ""): int(
                item["timeline_start_ms"]
            )
            for item in plan["selectedSegments"]
        }
        for fact in private_state["evidence_facts"]:
            fact_key = str(fact["evidenceRefs"][0]).split(":", 1)[0]
            self.assertEqual(
                timeline_starts[fact_key], int(fact["timelineStartMs"])
            )
        for phrase in plan["spokenPhrases"]:
            self.assertTrue(
                {
                    str(reference).split(":", 1)[0]
                    for reference in phrase.get("evidenceRefs") or []
                }.issubset(final_refs)
            )
        for item in plan["visualTextItems"]:
            if item["type"] == "callout":
                self.assertTrue(
                    {
                        str(reference).split(":", 1)[0]
                        for reference in item.get("evidenceRefs") or []
                    }.issubset(final_refs)
                )
        expected_roles = {}
        for item in plan["selectedSegments"]:
            role = item["role"]
            expected_roles[role] = expected_roles.get(role, 0) + 1
        self.assertEqual(
            expected_roles, plan["musicBrief"]["materialSignals"]["roles"]
        )
        self.assertEqual(1, expected_roles["hook"])
        self.assertEqual(1, expected_roles["result"])
        self.assertLess(
            max(plan["musicBrief"]["transitionPointsMs"]),
            plan["selectedDurationMs"],
        )

    def test_callouts_are_confined_to_their_evidence_shot_intervals(self):
        timeline = {
            "selected_segments": [
                {
                    "segment_id": "timeline-a",
                    "evidence_ref": "evidence-a",
                    "timeline_start_ms": 0,
                    "timeline_end_ms": 3_000,
                },
                {
                    "segment_id": "timeline-b",
                    "evidence_ref": "evidence-b",
                    "timeline_start_ms": 3_000,
                    "timeline_end_ms": 8_000,
                },
            ]
        }
        items = [
            {
                "type": "callout",
                "text": "素材 A",
                "evidenceRefs": ["evidence-a:description"],
            },
            {
                "type": "callout",
                "text": "素材 B",
                "evidenceRefs": ["evidence-b:description"],
            },
        ]

        events = self.service.creative_domain._auto_mix_visual_events(
            items, 8_000, timeline=timeline
        )

        self.assertEqual(2, len(events))
        for event in events:
            key = event["evidenceRefs"][0].split(":", 1)[0]
            interval = next(
                item
                for item in timeline["selected_segments"]
                if item["evidence_ref"] == key
            )
            self.assertGreaterEqual(event["start_ms"], interval["timeline_start_ms"])
            self.assertLessEqual(event["end_ms"], interval["timeline_end_ms"])

    def test_music_catalog_import_is_real_analyzed_and_publicly_redacted(self):
        music = self.root / "licensed.wav"
        with wave.open(str(music), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x00\x00" * 2_400)
        evidence = self.root / "license-proof.txt"
        evidence.write_text("commercial authorization fixture", encoding="utf-8")

        imported = self.service.import_music_catalog_track(
            {
                "sourcePath": str(music),
                "displayName": "稳健节奏",
                "source": "用户授权曲库",
                "commercialScope": "commercial all social platforms",
                "commercialUseAllowed": True,
                "licenseStatus": "valid",
                "expiresAt": None,
                "credentialReference": "license-record-001",
                "evidencePath": str(evidence),
                "bpm": 104,
                "moods": ["steady", "credible"],
                "energy": 0.56,
                "loopStartMs": None,
                "loopEndMs": None,
            }
        )
        listed = self.service.list_music_catalog_tracks()

        self.assertEqual("ready", imported["analysisStatus"])
        self.assertEqual(30_000, imported["durationMs"])
        self.assertEqual(imported["trackId"], listed["items"][0]["trackId"])
        encoded = json.dumps(listed, ensure_ascii=False)
        self.assertNotIn(str(music), encoded)
        self.assertNotIn(str(evidence), encoded)
        self.assertNotIn("license-record-001", encoded)

    def test_ambiguous_asr_result_is_not_resubmitted_after_restart_and_resume(self):
        self._install_approved_voice()
        analyzer = _AmbiguousAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        first_task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", first_task["status"])
        self.assertEqual("outcome_unknown", first_plan["state"])
        self.assertEqual(
            "auto_mix_voice_outcome_unknown", first_plan["attention"]["code"]
        )
        self.assertEqual(1, len(analyzer.synthesized))
        self.assertEqual(1, len(analyzer.cloud_client.calls))

        self.service.close()
        recovered_analyzer = _AmbiguousAnalyzer()
        self.service = ContentEngineService(
            self.root,
            creative_analyzer=recovered_analyzer,
            creative_renderer=_HappyRenderer(),
            start_background_jobs=False,
        )
        recovered = self.service.create_auto_mix_v2(self._request())
        self.assertEqual(first_plan["runId"], recovered["runId"])
        self.assertEqual("outcome_unknown", recovered["state"])

        self.service.resume_creative_task(created["taskId"])
        resumed_task = self.service.run_creative_task(created["taskId"])
        resumed_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", resumed_task["status"])
        self.assertEqual("outcome_unknown", resumed_plan["state"])
        self.assertEqual([], recovered_analyzer.synthesized)
        self.assertEqual([], recovered_analyzer.cloud_client.calls)

    def test_asr_mismatch_does_not_repeat_identical_paid_tts(self):
        self._install_approved_voice()
        analyzer = _MismatchedAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        first_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("paused", task["status"])
        self.assertEqual("needs_attention", first_plan["state"])
        self.assertEqual(
            "auto_mix_voice_verification_failed", first_plan["attention"]["code"]
        )
        self.assertEqual(1, len(analyzer.synthesized))
        self.assertEqual(1, len(analyzer.cloud_client.calls))

        recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice", expected_run_id=first_plan["runId"]
        )
        recovered_task = self.service.run_creative_task(recovery["taskId"])
        recovered_plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        recovered_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (recovered_plan["runId"],),
        ).fetchone()
        recovered_private = json.loads(recovered_row["private_state_json"])

        self.assertEqual("paused", recovered_task["status"])
        self.assertEqual(1, len(analyzer.synthesized))
        self.assertEqual(2, len(analyzer.cloud_client.calls))
        self.assertTrue(recovered_private["voice_recheck_used"])

        next_recovery = self.service.regenerate_auto_mix_layer(
            created["projectId"], "voice", expected_run_id=recovered_plan["runId"]
        )
        next_row = self.service.connection.execute(
            """
            SELECT selected_voice_persona_id, private_state_json
            FROM auto_mix_runs_v2 WHERE id = ?
            """,
            (next_recovery["runId"],),
        ).fetchone()
        next_private = json.loads(next_row["private_state_json"])

        self.assertIsNone(next_row["selected_voice_persona_id"])
        self.assertEqual(
            first_plan["voicePersona"]["voicePersonaId"],
            next_private["excluded_voice_persona_id"],
        )

    def test_invalid_formal_audio_quality_can_never_complete(self):
        self._install_approved_voice()
        self._import_valid_music()
        self._use_pipeline(_HappyAnalyzer(), _InvalidQualityRenderer())

        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        generated = self.service.connection.execute(
            """
            SELECT status, error_code FROM generated_videos
            WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
            """,
            (created["projectId"],),
        ).fetchone()

        self.assertEqual("failed", task["status"])
        self.assertEqual("failed", plan["state"])
        self.assertNotEqual("completed", plan["state"])
        self.assertEqual(
            "auto_mix_voice_music_margin_failed", plan["attention"]["code"]
        )
        self.assertIsNotNone(generated)
        self.assertEqual("failed", generated["status"])
        self.assertEqual(
            "auto_mix_voice_music_margin_failed", generated["error_code"]
        )

    def test_music_revoked_during_render_pauses_and_marks_candidate_failed(self):
        self._install_approved_voice()
        imported = self._import_valid_music()
        test_case = self

        class _RevokingRenderer(_HappyRenderer):
            def render(self, **kwargs):
                rendered = super().render(**kwargs)
                test_case.service.connection.execute(
                    """
                    UPDATE music_catalog_tracks_v1
                    SET license_status = 'restricted'
                    WHERE id = ?
                    """,
                    (imported["trackId"],),
                )
                return rendered

        self._use_pipeline(_HappyAnalyzer(), _RevokingRenderer())
        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        generated = self.service.connection.execute(
            """
            SELECT status, error_code FROM generated_videos
            WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
            """,
            (created["projectId"],),
        ).fetchone()

        self.assertEqual("paused", task["status"])
        self.assertEqual("needs_attention", plan["state"])
        self.assertEqual(
            "auto_mix_music_authorization_changed", plan["attention"]["code"]
        )
        self.assertEqual("music", plan["attention"]["layer"])
        self.assertEqual("failed", generated["status"])
        self.assertEqual(
            "auto_mix_music_authorization_changed", generated["error_code"]
        )

    def test_generation_two_candidate_insert_is_idempotent(self):
        created = self.service.create_auto_mix_v2(self._request())
        recipe = {
            "product_workflow": "one_click_v2",
            "packaging": {"cover": {"mode": "local_frame"}},
        }
        domain = self.service.creative_domain
        first_id = domain._insert_generated(
            created["projectId"],
            created["taskId"],
            "mix",
            recipe,
            {"total": 90.0},
            "generation 2",
            18_000,
            recommended=True,
            signature="stable-generation-two-signature",
            generation=2,
        )
        repeated_id = domain._insert_generated(
            created["projectId"],
            created["taskId"],
            "mix",
            recipe,
            {"total": 91.0},
            "generation 2 retry",
            18_000,
            recommended=True,
            signature="stable-generation-two-signature",
            generation=2,
        )
        count = self.service.connection.execute(
            """
            SELECT COUNT(*) FROM generated_videos
            WHERE project_id = ? AND selection_signature = ? AND generation = 2
            """,
            (created["projectId"], "stable-generation-two-signature"),
        ).fetchone()[0]

        self.assertEqual(first_id, repeated_id)
        self.assertEqual(1, count)

    def test_long_copy_on_120_second_material_caps_tts_and_asr_calls(self):
        self.service.connection.execute(
            "UPDATE assets SET duration_ms = 120000 WHERE id = 'asset-v2'"
        )
        self.service.connection.execute(
            "UPDATE media_segments SET end_ms = 120000 WHERE id = 'segment-v2'"
        )
        self._install_approved_voice()
        self._import_valid_music(with_loop=True)
        analyzer = _HappyAnalyzer()
        self._use_pipeline(analyzer, _HappyRenderer())
        long_copy = "".join(
            f"第{index}段真实现场。" for index in range(1, 121)
        )

        created = self.service.create_auto_mix_v2(
            self._request(copyFramework=long_copy)
        )
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )
        warning_codes = {
            item.get("code")
            for item in plan.get("qualityWarnings") or []
            if isinstance(item, dict)
        }

        self.assertEqual("completed", task["status"])
        self.assertEqual("completed", plan["state"])
        self.assertLessEqual(len(analyzer.synthesized), AUTO_MIX_MAX_TTS_PHRASES)
        self.assertEqual(len(analyzer.synthesized), len(analyzer.cloud_client.calls))
        self.assertEqual(
            len(analyzer.synthesized), plan["cache"]["ttsPhraseCount"]
        )
        self.assertNotIn("第1段真实现场", " ".join(analyzer.synthesized))
        self.assertNotIn("第120段真实现场", " ".join(analyzer.synthesized))
        self.assertNotIn("auto_mix_copy_shortened_before_tts", warning_codes)

    def test_text_layer_generation_two_is_grounded_and_deterministically_different(self):
        self._install_approved_voice()
        self._import_valid_music()
        analyzer = _HappyAnalyzer()
        renderer = _HappyRenderer()
        self._use_pipeline(analyzer, renderer)

        created = self.service.create_auto_mix_v2(self._request())
        self.service.run_creative_task(created["taskId"])
        first = self.service.get_auto_mix_plan_v2(project_id=created["projectId"])
        first_text = [item["text"] for item in first["spokenPhrases"]]
        first_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (first["runId"],),
        ).fetchone()
        first_private = json.loads(first_row["private_state_json"])
        self.assertGreater(
            first_private["analysis_material_timeline"]["selected_duration_ms"],
            first_private["material_timeline"]["selected_duration_ms"],
        )

        regenerated = self.service.regenerate_auto_mix_layer(
            created["projectId"], "text"
        )
        self.service.run_creative_task(regenerated["taskId"])
        second = self.service.get_auto_mix_plan_v2(project_id=created["projectId"])
        second_text = [item["text"] for item in second["spokenPhrases"]]
        second_row = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (second["runId"],),
        ).fetchone()
        second_private = json.loads(second_row["private_state_json"])

        self.assertEqual(2, second["generation"])
        self.assertEqual("completed", second["state"])
        self.assertEqual(
            first_private["analysis_material_timeline"],
            second_private["analysis_material_timeline"],
        )
        self.assertNotEqual(first_text, second_text)
        self.assertNotIn(
            self._request()["copyFramework"], " ".join([*first_text, *second_text])
        )
        self.assertTrue(
            all(
                item.get("evidenceRefs")
                and "copyFramework" not in item["evidenceRefs"]
                for item in second["spokenPhrases"]
            )
        )

    def test_full_v2_pipeline_completes_only_with_verified_voice_music_remotion_and_qc(self):
        analyzer = _HappyAnalyzer()
        renderer = _HappyRenderer()
        self.service.creative_analyzer = analyzer
        self.service.creative_renderer = renderer
        self.service.creative_domain.analyzer = analyzer
        self.service.creative_domain.renderer = renderer
        now = "2026-08-24T00:00:00.000Z"
        self.service.connection.execute(
            """
            INSERT INTO voice_personas_v1(
                id, version, display_name, style, catalog_version, provider,
                provider_model, provider_voice_id, instruction, approved_at,
                active, created_at, updated_at
            ) VALUES (
                'natural-life@1', 1, '自然生活', 'natural_life',
                'test-catalog-v1', 'bailian', 'cosyvoice-v3.5-plus',
                'private-provider-voice', '自然口播', ?, 1, ?, ?
            )
            """,
            (now, now, now),
        )
        music = self.root / "happy-licensed.wav"
        with wave.open(str(music), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24_000)
            stream.writeframes(b"\x00\x00" * 24_000)
        evidence = self.root / "happy-license.txt"
        evidence.write_text("commercial", encoding="utf-8")
        self.service.import_music_catalog_track(
            {
                "sourcePath": str(music),
                "displayName": "稳健节奏",
                "source": "用户授权曲库",
                "commercialScope": "commercial social media",
                "commercialUseAllowed": True,
                "licenseStatus": "valid",
                "expiresAt": None,
                "credentialReference": "happy-license-record",
                "evidencePath": str(evidence),
                "bpm": 104,
                "moods": ["steady", "credible"],
                "energy": 0.56,
                "loopStartMs": None,
                "loopEndMs": None,
            }
        )

        created = self.service.create_auto_mix_v2(self._request())
        task = self.service.run_creative_task(created["taskId"])
        plan = self.service.get_auto_mix_plan_v2(
            project_id=created["projectId"]
        )

        self.assertEqual("completed", task["status"])
        self.assertEqual("completed", plan["state"])
        self.assertTrue(plan["speechCaptions"])
        self.assertTrue(
            all(item["timing"] == "audio_measured" for item in plan["speechCaptions"])
        )
        self.assertEqual("natural-life@1", plan["voicePersona"]["voicePersonaId"])
        self.assertEqual("valid", plan["music"]["licenseSummary"]["status"])
        self.assertTrue(plan["qualityReport"]["passed"])
        self.assertEqual("tts_only", renderer.rendered_recipes[0]["audio_mode"])
        self.assertFalse(
            renderer.rendered_recipes[0]["packaging"]["visualRenderer"]["allowFallback"]
        )
        audio_plan = renderer.rendered_recipes[0]["packaging"]["audio"]
        self.assertTrue(audio_plan["energy_curve"])
        self.assertTrue(audio_plan["music_section_hints"])
        self.assertEqual(
            plan["musicBrief"]["transitionPointsMs"],
            audio_plan["transition_points_ms"],
        )
        callout_starts = [
            item["start_ms"]
            for item in renderer.rendered_recipes[0]["packaging"]["events"]
            if item["reason"] == "callout"
        ]
        if len(callout_starts) > 1:
            duration_ms = renderer.rendered_recipes[0]["captions"][-1]["end_ms"]
            thirds = {
                min(2, int(3 * start / max(1, duration_ms)))
                for start in callout_starts
            }
            self.assertGreaterEqual(len(thirds), 2)
        encoded = json.dumps(plan, ensure_ascii=False)
        self.assertNotIn("private-provider-voice", encoded)
        self.assertNotIn("happy-license-record", encoded)

        first_run_id = plan["runId"]
        self.service.close()
        resumed_analyzer = _HappyAnalyzer()
        self.service = ContentEngineService(
            self.root,
            creative_analyzer=resumed_analyzer,
            creative_renderer=_HappyRenderer(),
            start_background_jobs=False,
        )
        resumed = self.service.create_auto_mix_v2(self._request())
        self.assertEqual("completed", resumed["state"])
        self.assertEqual(first_run_id, resumed["runId"])
        self.assertEqual([], resumed_analyzer.synthesized)


class GuidedAutoMixSupplementalImageTests(unittest.TestCase):
    def setUp(self):
        self.root = SIDECAR_ROOT / f".guided-supplemental-image-{uuid.uuid4().hex}"
        self.root.mkdir()
        self.source = self.root / "material.mp4"
        self.source.write_bytes(b"guided-supplemental-material")
        self.cover_client = _GuidedSupplementalImageClient()
        with mock.patch(
            "content_engine.creative_domain.configured_voice_personas",
            return_value=[],
        ):
            self.service = ContentEngineService(
                self.root,
                creative_analyzer=_FakeAnalyzer(),
                creative_renderer=_FakeRenderer(),
                creative_cover_client=self.cover_client,
                start_background_jobs=False,
            )
        self.session_id = f"guided_auto_mix_session_{uuid.uuid4().hex}"
        self.draft_hash = "a" * 64
        self.now = "2026-08-26T00:00:00.000Z"
        snapshot = [
            {
                "asset_id": "guided-supplemental-asset",
                "fingerprint": "guided-supplemental-full-fingerprint",
                "duration_ms": 18_000,
                "media_kind": "video",
            }
        ]
        draft = {
            "revision": 1,
            "title": "工厂清扫现场",
            "duration_plan": self.service.creative_domain._guided_auto_mix_duration_plan(
                {"selected_duration_ms": 18_000}
            ),
            "script": {
                "hook": "无人清洁机器人正在现场作业",
                "voiceover": "从现场画面看清洁流程。",
                "cta": "查看真实素材",
            },
            "text_tracks": {
                "spoken_phrases": [
                    {
                        "text": "无人清洁机器人正在现场作业。",
                        "evidence_refs": ["material-result"],
                    }
                ],
                "visual_text_items": [
                    {"type": "hook", "text": "现场清洁展示"},
                    {"type": "cta", "text": "查看真实素材"},
                ],
            },
        }
        analysis = {
            "evidence_facts": [
                {"text": "工厂室内通道出现清洁机器人", "kind": "visual"},
                {"text": "画面为干净明亮的工业现场", "kind": "visual"},
            ]
        }
        with self.service.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO assets(
                    id, fingerprint, full_fingerprint, media_kind, extension,
                    size_bytes, display_name, rights_status, probe_status,
                    duration_ms, width, height, fps, has_audio,
                    created_at, updated_at
                ) VALUES (?, ?, ?, 'video', '.mp4', ?, '补图测试素材', 'owned',
                    'ok', 18000, 1080, 1920, 30, 1, ?, ?)
                """,
                (
                    "guided-supplemental-asset",
                    "guided-supplemental-fingerprint",
                    "guided-supplemental-full-fingerprint",
                    self.source.stat().st_size,
                    self.now,
                    self.now,
                ),
            )
            connection.execute(
                """
                INSERT INTO asset_locations(
                    id, asset_id, absolute_path, size_bytes, modified_ns,
                    is_available, created_at, last_seen_at
                ) VALUES (?, 'guided-supplemental-asset', ?, ?, ?, 1, ?, ?)
                """,
                (
                    f"guided-supplemental-location-{uuid.uuid4().hex}",
                    str(self.source),
                    self.source.stat().st_size,
                    self.source.stat().st_mtime_ns,
                    self.now,
                    self.now,
                ),
            )
            connection.execute(
                """
                INSERT INTO guided_auto_mix_sessions_v1(
                    id, status, asset_ids_json, asset_snapshot_json,
                    analysis_profile_json, analysis_versions_json,
                    analysis_summary_json, answers_json, draft_json, draft_hash,
                    created_at, updated_at
                ) VALUES (?, 'ready_for_render', ?, ?, '{}', '{}', ?, '{}', ?, ?, ?, ?)
                """,
                (
                    self.session_id,
                    json.dumps(["guided-supplemental-asset"]),
                    json.dumps(snapshot),
                    json.dumps(analysis, ensure_ascii=False),
                    json.dumps(draft, ensure_ascii=False),
                    self.draft_hash,
                    self.now,
                    self.now,
                ),
            )

    def tearDown(self):
        self.service.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _create(self, confirm_paid_calls=True):
        return self.service.creative_domain.create_guided_auto_mix_supplemental_image(
            self.session_id,
            1,
            self.draft_hash,
            confirm_paid_calls,
        )

    def test_paid_supplemental_image_is_versioned_idempotent_and_path_safe(self):
        estimate = self.service.creative_domain.estimate_guided_auto_mix_supplemental_image(
            self.session_id, 1, self.draft_hash
        )
        self.assertEqual("not_requested", estimate["status"])
        self.assertEqual(1, estimate["estimatedImageCalls"])
        self.assertTrue(estimate["confirmationRequired"])
        with self.assertRaises(ContentEngineError) as denied:
            self._create(False)
        self.assertEqual(
            "guided_auto_mix_supplemental_image_confirmation_required",
            denied.exception.code,
        )
        with self.assertRaises(ContentEngineError) as stale:
            self.service.creative_domain.estimate_guided_auto_mix_supplemental_image(
                self.session_id, 1, "b" * 64
            )
        self.assertEqual("guided_auto_mix_script_stale", stale.exception.code)

        first = self._create()
        restored = self.service.get_guided_auto_mix_session_v2(task_id=first["task_id"])
        repeated = self._create()
        self.assertEqual("guided_auto_mix_supplemental_image", first["task_type"])
        self.assertEqual(self.session_id, restored["session_id"])
        self.assertEqual(first["task_id"], repeated["task_id"])
        self.assertEqual(first["operationId"], repeated["operationId"])
        self.assertEqual([], self.cover_client.submit_calls)

        completed_task = self.service.run_creative_task(first["task_id"])
        self.assertEqual("completed", completed_task["status"])
        self.assertEqual(1, len(self.cover_client.submit_calls))
        self.assertIsNone(self.cover_client.submit_calls[0]["reference_path"])
        prompt = self.cover_client.submit_calls[0]["prompt"]
        self.assertIn("scene-and-atmosphere", prompt)
        self.assertIn("Do not include text", prompt)
        self.assertIn("Do not show fabricated product features", prompt)

        public = self.service.creative_domain.get_guided_auto_mix_supplemental_image(
            self.session_id, 1
        )
        operation = public["operation"]
        self.assertEqual("completed", public["status"])
        self.assertTrue(operation["paidCallPerformed"])
        self.assertTrue(operation["imageReady"])
        self.assertEqual(1, operation["estimatedImageCalls"])
        self.assertNotIn("absolute_path", operation)
        self.assertNotIn("managed_relative_path", operation)
        resolved = self.service.creative_domain.resolve_guided_auto_mix_supplemental_image_path(
            operation["operationId"]
        )
        self.assertTrue(Path(resolved["absolute_path"]).is_file())
        self.assertEqual("image/png", resolved["mime_type"])
        completed_ref = (
            self.service.creative_domain.completed_guided_auto_mix_supplemental_image_for_draft(
                self.session_id, 1, self.draft_hash
            )
        )
        self.assertEqual(operation["operationId"], completed_ref["operation_id"])
        self.assertNotIn(
            "guided_auto_mix_supplemental_image",
            {
                row["id"]
                for row in self.service.connection.execute("SELECT id FROM assets")
            },
        )

    def test_unknown_submit_is_terminal_and_never_resubmits(self):
        self.cover_client.submit_unknown = True
        created = self._create()
        failed_task = self.service.run_creative_task(created["task_id"])
        self.assertEqual("failed", failed_task["status"])
        self.assertEqual(1, len(self.cover_client.submit_calls))
        state = self.service.creative_domain.get_guided_auto_mix_supplemental_image(
            self.session_id, 1
        )
        self.assertEqual("outcome_unknown", state["status"])
        self.assertTrue(state["operation"]["paidCallPerformed"])

        repeated = self._create()
        self.assertEqual(created["task_id"], repeated["task_id"])
        self.assertEqual("failed", repeated["status"])
        retried = self.service.run_creative_task(repeated["task_id"])
        self.assertEqual("failed", retried["status"])
        self.assertEqual(1, len(self.cover_client.submit_calls))

    def test_existing_provider_task_is_polled_without_a_second_submit(self):
        created = self._create()
        self.service.creative_domain._update_guided_auto_mix_supplemental_image_operation(
            created["operationId"],
            "submitted",
            external_task_id="persisted-provider-task",
        )

        completed_task = self.service.run_creative_task(created["task_id"])

        self.assertEqual("completed", completed_task["status"])
        self.assertEqual([], self.cover_client.submit_calls)
        self.assertEqual(["persisted-provider-task"], self.cover_client.poll_calls)

    def test_paused_submitted_supplemental_image_resumes_by_polling_only(self):
        created = self._create()
        self.service.creative_domain._update_guided_auto_mix_supplemental_image_operation(
            created["operationId"],
            "submitted",
            external_task_id="persisted-provider-task",
        )
        self.service.update_task(created["task_id"], "analyzing")
        paused = self.service.update_task(created["task_id"], "cancelled")
        self.assertEqual("paused", paused["status"])

        resumed = self.service.resume_creative_task(created["task_id"])
        self.assertEqual("queued", resumed["status"])
        completed = self.service.run_creative_task(created["task_id"])

        self.assertEqual("completed", completed["status"])
        self.assertEqual([], self.cover_client.submit_calls)
        self.assertEqual(["persisted-provider-task"], self.cover_client.poll_calls)

    def test_completed_supplemental_image_is_a_non_evidence_ending_visual(self):
        created = self._create()
        self.service.run_creative_task(created["task_id"])
        reference = (
            self.service.creative_domain.completed_guided_auto_mix_supplemental_image_for_draft(
                self.session_id, 1, self.draft_hash
            )
        )
        visuals = [
            {
                "role": "result",
                "segment_id": "material-result",
                "asset_id": "guided-supplemental-asset",
                "start_ms": 0,
                "end_ms": 8_000,
                "target_duration_ms": 8_000,
                "media_kind": "video",
            }
        ]

        inserted = self.service.creative_domain._append_guided_supplemental_image_visual(
            visuals, reference, 8_000
        )

        self.assertIsNotNone(inserted)
        self.assertEqual(5_000, visuals[0]["target_duration_ms"])
        self.assertEqual(3_000, visuals[-1]["target_duration_ms"])
        self.assertEqual("image", visuals[-1]["media_kind"])
        self.assertTrue(visuals[-1]["non_evidence"])
        self.assertEqual(
            self.service.creative_domain.resolve_guided_auto_mix_supplemental_image_path(
                created["operationId"]
            )["absolute_path"],
            self.service.creative_domain._resolve_render_asset_path(
                reference["managed_image_id"]
            ),
        )

        run = self.service.create_auto_mix_v2(
            {
                "specVersion": "2",
                "guidedSessionId": self.session_id,
                "scriptRevision": 1,
            }
        )
        stored = self.service.connection.execute(
            "SELECT private_state_json FROM auto_mix_runs_v2 WHERE id = ?",
            (run["runId"],),
        ).fetchone()
        private_state = json.loads(stored["private_state_json"])
        self.assertEqual(
            reference["operation_id"],
            private_state["guided_supplemental_image"]["operation_id"],
        )
        plan = self.service.get_auto_mix_plan_v2(run_id=run["runId"])
        self.assertTrue(plan["supplementalImage"]["used"])


if __name__ == "__main__":
    unittest.main()
