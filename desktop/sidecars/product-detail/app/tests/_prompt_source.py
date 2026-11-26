"""Source files as they read with the prompt wording put back (the wording is stored on the server since
2026-11-25). Tests that look for wording in a source file read it through here."""
import json
import re
from pathlib import Path

LIBRARY = Path(__file__).resolve().parents[5] / "server" / "provider-gateway" / "prompt-library.json"
_REF = re.compile(r"""prompt_ref\(\s*["']([a-z0-9][a-z0-9_.-]{0,99})["'](?:\s*,\s*(\d+))?(?:\s*,\s*formatted=True)?\s*\)""")


def prompt_source(path) -> str:
    library = json.loads(LIBRARY.read_text(encoding="utf-8"))
    text = Path(path).read_text(encoding="utf-8")
    # The wording goes in as it was written in the source (quotes unescaped), so wording checks read as before.
    return _REF.sub(lambda m: library[f"{m.group(1)}@{m.group(2) or 1}"], text)
