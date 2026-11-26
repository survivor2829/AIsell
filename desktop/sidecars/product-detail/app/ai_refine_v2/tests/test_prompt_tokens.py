"""Prompt wording lives on the server (user decision 2026-11-25): what a customer computer sends (tokens, expanded by
the gateway) must be exactly what the development wording run sends, through every place code adjusts a prompt."""
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
LIBRARY = APP.parents[3] / "server" / "provider-gateway" / "prompt-library.json"
TOKEN = re.compile("⟦xiaoxi-prompt:([a-z0-9][a-z0-9_.-]{0,99})@([1-9][0-9]{0,3})⟧")


def expand(text, library):
    return TOKEN.sub(lambda match: library[f"{match.group(1)}@{match.group(2)}"], text)


class PromptTokenEquivalenceTest(unittest.TestCase):
    def test_token_run_sends_the_same_text_as_the_wording_run(self):
        library = json.loads(LIBRARY.read_text(encoding="utf-8"))
        environment = {**os.environ, "XIAOXI_PROMPT_TOKENS": "1", "PYTHONUTF8": "1"}
        environment.pop("XIAOXI_PROMPT_LIBRARY", None)
        tokens = json.loads(subprocess.run(
            [sys.executable, "-m", "ai_refine_v2.tests.prompt_builders"], cwd=APP, env=environment,
            capture_output=True, text=True, encoding="utf-8", check=True).stdout)
        from ai_refine_v2.tests.prompt_builders import builders
        for name, build in builders().items():
            with self.subTest(name):
                self.assertIn("⟦xiaoxi-prompt:", tokens[name], "a customer computer sends tokens, not wording")
                self.assertEqual(expand(tokens[name], library), build())

    def test_compact_variants_are_current(self):
        result = subprocess.run([sys.executable, str(APP.parents[2] / "scripts" / "prompt_variants.py"), "--check"],
                                cwd=APP, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
