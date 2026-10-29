import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from content_engine import failure_journal
from content_engine.errors import ContentEngineError
from content_engine.protocol import serve_jsonl


class FailureJournalTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        failure_journal.configure(self.root)

    def tearDown(self):
        failure_journal._directory = None
        self.temporary.cleanup()

    def entries(self):
        file = self.root / "logs" / "failures.jsonl"
        return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines()]

    def test_records_code_details_context_and_traceback(self):
        try:
            raise ContentEngineError("auto_mix_music_not_audible", "听不到", details={"quietSpanMs": 900})
        except ContentEngineError as error:
            failure_journal.record(error, where="narrated_production", task_id="task_1", context={"batch_id": "b1"})
        [entry] = self.entries()
        self.assertEqual("auto_mix_music_not_audible", entry["code"])
        self.assertEqual({"quietSpanMs": 900}, entry["details"])
        self.assertEqual({"batch_id": "b1"}, entry["context"])
        self.assertEqual("task_1", entry["task_id"])
        self.assertIn("test_records_code_details_context_and_traceback", entry["traceback"])

    def test_unexpected_exception_is_internal_error_with_traceback(self):
        try:
            {}["missing"]
        except KeyError as error:
            failure_journal.record(error, where="request:x")
        [entry] = self.entries()
        self.assertEqual("internal_error", entry["code"])
        self.assertEqual("KeyError", entry["type"])
        self.assertIn("KeyError", entry["traceback"])

    def test_rotates_instead_of_growing_without_bound(self):
        file = self.root / "logs" / "failures.jsonl"
        file.write_text("x" * (failure_journal.MAX_BYTES + 1), encoding="utf-8")
        failure_journal.record(ValueError("boom"), where="request:x")
        self.assertTrue((self.root / "logs" / "failures.1.jsonl").exists())
        self.assertEqual(1, len(self.entries()))

    def test_unconfigured_journal_and_unwritable_values_never_raise(self):
        failure_journal._directory = None
        failure_journal.record(ValueError("ignored"), where="request:x")
        failure_journal.configure(self.root)
        failure_journal.record(ContentEngineError("x", "y", details={"bad": object()}), where="request:x")
        self.assertEqual("x", self.entries()[0]["code"])

    def test_failed_request_is_journaled_by_the_protocol(self):
        available = SimpleNamespace(available=True, capability={"available": True, "cloud_configured": True}, configured=True)
        service = SimpleNamespace(media_probe=available, mix_renderer=available, creative_analyzer=available,
                                  creative_renderer=available, creative_cover_client=available)
        output = io.StringIO()
        request = json.dumps({"id": 1, "method": "no_such_method", "params": {}})
        serve_jsonl(service, input_stream=io.StringIO(request + "\n"), output_stream=output)
        entry = self.entries()[-1]
        self.assertEqual("method_not_found", entry["code"])
        self.assertEqual("request:no_such_method", entry["where"])


if __name__ == "__main__":
    unittest.main()
