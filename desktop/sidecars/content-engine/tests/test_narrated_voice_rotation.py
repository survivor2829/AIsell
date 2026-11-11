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


class FakeRows:
    def __init__(self, approved):
        self.approved = approved

    def execute(self, _sql, params):
        rows = [{"id": pid} for pid, row in self.approved.items()
                if row["provider"] == "volcengine" and row["provider_model"] == params[0]]
        return SimpleNamespace(fetchall=lambda: rows)


def batch_of(count, voice="volc-xiaohe-2@1"):
    return {"settings": {"voice_persona_id": voice},
            "candidates": [{"candidate_id": f"c{i}"} for i in range(count)]}


class VoiceRotationTests(unittest.TestCase):
    def setUp(self):
        catalog = {item["persona_id"]: item for item in configured_voice_personas({})}
        approved = {pid: persona(pid, item["provider_model"], item["provider_voice_id"])
                    for pid, item in catalog.items() if item.get("product_approved")}
        self.domain = SimpleNamespace(d=FakeCreative(approved), db=FakeRows(approved), _store=lambda _b: None)

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
        batch = batch_of(5)
        voices = self.assign(batch)
        self.assertEqual("volc-xiaohe-2@1", voices[0])
        self.assertEqual(5, len(set(voices)))
        genders = {item["persona_id"]: item["gender"] for item in rotation_voice_personas({})}
        self.assertEqual(["female", "male", "female", "male", "female"], [genders[v] for v in voices])
        self.assertNotIn("voice_persona_id", batch["candidates"][0])

    def test_assignment_is_stable_when_a_video_is_retried(self):
        batch = batch_of(3)
        first = self.assign(batch)
        self.assertEqual(first, self.assign(batch))

    def test_a_cheaper_or_other_model_voice_is_never_rotated_in(self):
        self.domain.d.approved["volc-straight-yingzi@1"] = persona(
            "volc-straight-yingzi@1", "seed-tts-1.0", "zh_female_naying_mars_bigtts")
        batch = batch_of(3, "volc-straight-yingzi@1")
        self.assertEqual(["volc-straight-yingzi@1"] * 3, self.assign(batch))

    def test_unapproved_rotation_voice_is_skipped(self):
        self.domain.d.approved.pop("volc-yunzhou-2@1")
        batch = batch_of(2)
        self.assertNotEqual("volc-yunzhou-2@1", self.assign(batch)[1])

    def test_without_rotation_voices_every_video_keeps_the_batch_voice(self):
        batch = batch_of(3)
        with patch("content_engine.narrated_batch.rotation_voice_personas", return_value=[]):
            self.assertEqual(["volc-xiaohe-2@1"] * 3, self.assign(batch))

    def test_a_reloaded_copy_of_a_video_is_still_found_by_id(self):
        batch = batch_of(3)
        copies = [dict(c) for c in batch["candidates"]]
        voices = [NarratedBatchDomain._candidate_voice(self.domain, batch, c) for c in copies]
        self.assertEqual(3, len(set(voices)))

    def test_a_saved_voice_of_another_model_is_reassigned(self):
        batch = batch_of(2)
        batch["candidates"][1]["voice_persona_id"] = "volc-straight-yingzi@1"
        self.domain.d.approved["volc-straight-yingzi@1"] = persona(
            "volc-straight-yingzi@1", "seed-tts-1.0", "zh_female_naying_mars_bigtts")
        voice = NarratedBatchDomain._candidate_voice(self.domain, batch, batch["candidates"][1])
        self.assertNotEqual("volc-straight-yingzi@1", voice)
        self.assertEqual(voice, batch["candidates"][1]["voice_persona_id"])


if __name__ == "__main__":
    unittest.main()
