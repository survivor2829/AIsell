from __future__ import annotations

from pathlib import Path
import sys
import unittest


SIDECAR_ROOT = Path(__file__).resolve().parents[1]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


from content_engine.auto_mix_v2 import (
    align_material_timeline_to_captions,
    build_speech_captions,
)
from content_engine.creative_domain import CreativeDomain


class AutoMixAnalysisTimelineTests(unittest.TestCase):
    @staticmethod
    def _timeline(duration_ms: int):
        return {
            "usable_material_duration_ms": duration_ms * 2,
            "selected_duration_ms": duration_ms * 2,
            "selected_segments": [
                {
                    "segment_id": "timeline-a",
                    "evidence_ref": "evidence-a",
                    "asset_id": "asset-a",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": duration_ms,
                    "target_duration_ms": duration_ms,
                    "timeline_start_ms": 0,
                    "timeline_end_ms": duration_ms,
                    "role": "process",
                    "shot_type": "function_demo",
                },
                {
                    "segment_id": "timeline-b",
                    "evidence_ref": "evidence-b",
                    "asset_id": "asset-b",
                    "media_kind": "video",
                    "source_start_ms": 0,
                    "source_end_ms": duration_ms,
                    "target_duration_ms": duration_ms,
                    "timeline_start_ms": duration_ms,
                    "timeline_end_ms": duration_ms * 2,
                    "role": "result",
                    "shot_type": "dynamic_action",
                },
            ],
            "shortened_to_ceiling": False,
            "padded": False,
            "looped": False,
        }

    def test_regeneration_prefers_full_analysis_timeline_over_first_final_cut(self):
        full_analysis = self._timeline(10_000)
        first_final_cut = self._timeline(2_000)
        private_state = {
            "analysis_material_timeline": full_analysis,
            "material_timeline": first_final_cut,
            "voice_audio_path": "auto_mix_voice/first.wav",
        }
        phrases = [
            {"text": "第一句", "evidenceRefs": ["evidence-a:description"]},
            {"text": "第二句", "evidenceRefs": ["evidence-b:description"]},
        ]
        captions = build_speech_captions(phrases, [3_000, 3_000], pause_ms=160)

        source = CreativeDomain._auto_mix_analysis_timeline(
            {"speechCaptions": captions}, private_state
        )
        aligned = align_material_timeline_to_captions(source, phrases, captions)

        self.assertIs(source, full_analysis)
        self.assertEqual(captions[-1]["end_ms"], aligned["selected_duration_ms"])

    def test_unaligned_legacy_timeline_is_promoted_without_reanalysis(self):
        full_analysis = self._timeline(10_000)
        private_state = {"material_timeline": full_analysis}

        source = CreativeDomain._auto_mix_analysis_timeline({}, private_state)

        self.assertIs(source, full_analysis)
        self.assertIs(private_state["analysis_material_timeline"], full_analysis)

    def test_aligned_legacy_timeline_is_not_mistaken_for_full_analysis(self):
        first_final_cut = self._timeline(2_000)
        private_state = {
            "material_timeline": first_final_cut,
            "voice_audio_path": "auto_mix_voice/first.wav",
        }

        source = CreativeDomain._auto_mix_analysis_timeline(
            {"speechCaptions": [{"start_ms": 0, "end_ms": 4_000}]},
            private_state,
        )

        self.assertIsNone(source)
        self.assertNotIn("analysis_material_timeline", private_state)


if __name__ == "__main__":
    unittest.main()
