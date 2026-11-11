"""Each video of a multi-video batch gets its own voice of the same price tier."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from content_engine.auto_mix_resources import configured_voice_personas, rotation_voice_personas
from content_engine.narrated_batch import NarratedBatchDomain


def persona(persona_id, model="seed-tts-2.0", voice="zh_female_xiaohe_uranus_bigtts", provider="volcengine"):
    return {"id": persona_id, "provider": provider, "provider_model": model, "provider_voice_id": voice}


class FakeCreative:
    def __init__(self, approved):
        self.approved = approved

    def _approved_auto_mix_voice_persona(self, *, selected_id=None, excluded_id=""):
        if selected_id is None:
            return self.approved.get("volc-xiaohe-2@1")
        return self.approved.get(selected_id)


class VoiceRotationTests(unittest.TestCase):
    def setUp(self):
        catalog = {item["persona_id"]: item for item in configured_voice_personas({})}
        approved = {pid: persona(pid, item["provider_model"], item["provider_voice_id"])
                    for pid, item in catalog.items() if item.get("product_approved")}
        self.domain = SimpleNamespace(d=FakeCreative(approved))

    def assign(self, batch):
        return [NarratedBatchDomain._candidate_voice(self.domain, batch, c) for c in batch["candidates"]]

    def test_catalog_rotation_is_twelve_seed_tts_2_voices_with_both_genders(self):
        rotation = rotation_voice_personas({})
        self.assertEqual(12, len(rotation))
        self.assertEqual({"seed-tts-2.0"}, {item["provider_model"] for item in rotation})
        self.assertEqual(6, sum(item["gender"] == "female" for item in rotation))
        self.assertEqual(6, sum(item["gender"] == "male" for item in rotation))
        self.assertIn("volc-monkey-brother-2@1", {item["persona_id"] for item in rotation})

    def test_first_keeps_batch_voice_then_alternates_gender_without_repeats(self):
        batch = {"settings": {"voice_persona_id": "volc-xiaohe-2@1"}, "candidates": [{} for _ in range(5)]}
        voices = self.assign(batch)
        self.assertEqual("volc-xiaohe-2@1", voices[0])
        self.assertEqual(5, len(set(voices)))
        genders = {item["persona_id"]: item["gender"] for item in rotation_voice_personas({})}
        self.assertEqual(["female", "male", "female", "male", "female"], [genders[v] for v in voices])
        self.assertNotIn("voice_persona_id", batch["candidates"][0])

    def test_assignment_is_stable_when_a_video_is_retried(self):
        batch = {"settings": {"voice_persona_id": "volc-xiaohe-2@1"}, "candidates": [{} for _ in range(3)]}
        first = self.assign(batch)
        self.assertEqual(first, self.assign(batch))

    def test_a_cheaper_or_other_model_voice_is_never_rotated_in(self):
        self.domain.d.approved["volc-straight-yingzi@1"] = persona(
            "volc-straight-yingzi@1", "seed-tts-1.0", "zh_female_naying_mars_bigtts")
        batch = {"settings": {"voice_persona_id": "volc-straight-yingzi@1"}, "candidates": [{} for _ in range(3)]}
        self.assertEqual(["volc-straight-yingzi@1"] * 3, self.assign(batch))

    def test_unapproved_rotation_voice_is_skipped(self):
        self.domain.d.approved.pop("volc-yunzhou-2@1")
        batch = {"settings": {"voice_persona_id": "volc-xiaohe-2@1"}, "candidates": [{} for _ in range(2)]}
        self.assertNotEqual("volc-yunzhou-2@1", self.assign(batch)[1])

    def test_without_rotation_voices_every_video_keeps_the_batch_voice(self):
        batch = {"settings": {"voice_persona_id": "volc-xiaohe-2@1"}, "candidates": [{} for _ in range(3)]}
        with patch("content_engine.narrated_batch.rotation_voice_personas", return_value=[]):
            self.assertEqual(["volc-xiaohe-2@1"] * 3, self.assign(batch))


if __name__ == "__main__":
    unittest.main()
