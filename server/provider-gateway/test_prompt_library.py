import json
import os
import tempfile
import time
import unittest

from prompt_library import PromptError, PromptLibrary


class PromptLibraryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "prompt-library.json")
        self.write({"demo.system@1": "你是测试助手。", "demo.rule@1": "只回答\"是\"或\"否\"。", "demo.system@2": "新版说明"})
        self.library = PromptLibrary(self.path)

    def tearDown(self):
        self.dir.cleanup()

    def write(self, entries):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, ensure_ascii=False)

    def test_body_without_tokens_is_untouched(self):
        body = b'{"messages":[{"role":"user","content":"hi"}],  "x": 1}'
        self.assertIs(self.library.expand(body), body)

    def test_tokens_inside_strings_are_replaced_and_customer_text_is_kept(self):
        body = json.dumps({"model": "m", "messages": [
            {"role": "system", "content": "⟦xiaoxi-prompt:demo.system@1⟧"},
            {"role": "user", "content": "产品：扫地机\n⟦xiaoxi-prompt:demo.rule@1⟧"}]}, ensure_ascii=False).encode()
        payload = json.loads(self.library.expand(body))
        self.assertEqual(payload["messages"][0]["content"], "你是测试助手。")
        self.assertEqual(payload["messages"][1]["content"], "产品：扫地机\n只回答\"是\"或\"否\"。")
        self.assertEqual(payload["model"], "m")

    def test_tokens_escaped_by_the_app_json_encoder_are_found(self):
        body = json.dumps({"prompt": "⟦xiaoxi-prompt:demo.system@1⟧ 产品"}).encode()  # ensure_ascii: \u27e6...
        self.assertIn(b"\u27e6", body)
        self.assertEqual(json.loads(self.library.expand(body))["prompt"], "你是测试助手。 产品")

    def test_versions_live_side_by_side(self):
        self.assertEqual(self.library.expand_text("⟦xiaoxi-prompt:demo.system@2⟧"), "新版说明")
        self.assertEqual(self.library.expand_text("⟦xiaoxi-prompt:demo.system@1⟧"), "你是测试助手。")

    def test_unknown_or_malformed_token_stops_the_request(self):
        for text in ("⟦xiaoxi-prompt:demo.missing@1⟧", "⟦xiaoxi-prompt:Demo.System@1⟧", "⟦xiaoxi-prompt:demo.system⟧"):
            body = json.dumps({"prompt": text}).encode()
            with self.assertRaises(PromptError):
                self.library.expand(body)
        with self.assertRaises(PromptError) as caught:
            self.library.expand("⟦xiaoxi-prompt:demo.system@1⟧ not json".encode())
        self.assertEqual(caught.exception.code, "prompt_body_unsupported")

    def test_a_deployed_update_is_picked_up_and_a_broken_file_keeps_the_last_good_one(self):
        time.sleep(0.02)
        self.write({"demo.system@1": "改过的", "demo.rule@1": "r"})
        os.utime(self.path, (time.time() + 5, time.time() + 5))
        self.assertEqual(self.library.text("demo.system@1"), "改过的")
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{broken")
        os.utime(self.path, (time.time() + 10, time.time() + 10))
        self.assertEqual(self.library.text("demo.system@1"), "改过的")

    def test_entries_are_validated(self):
        for bad in ({"Bad@1": "x"}, {"a@0": "x"}, {"a@1": ""}, {"a@1": "⟦xiaoxi-prompt:b@1⟧"}):
            self.write(bad)
            with self.assertRaises(ValueError):
                PromptLibrary(self.path)

    def test_missing_library_knows_nothing(self):
        library = PromptLibrary(os.path.join(self.dir.name, "none.json"))
        self.assertEqual(len(library), 0)
        with self.assertRaises(PromptError):
            library.expand('{"p":"⟦xiaoxi-prompt:demo.system@1⟧"}'.encode())


if __name__ == "__main__":
    unittest.main()
