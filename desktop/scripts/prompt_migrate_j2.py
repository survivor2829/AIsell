"""Moves the fixed wording of Jinja prompt templates to the server prompt library (user decision 2026-11-25).

Usage: python prompt_migrate_j2.py <template.j2> <id-prefix> <contexts.json>
Each fixed run between Jinja tags becomes ``{{ prompt_ref('<prefix>.pN') }}``; leading and trailing whitespace stays in
the template, so trim_blocks / lstrip_blocks treat it exactly as before. Every context in contexts.json is rendered
before and after (wording from the library) and must give the same text.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from jinja2 import Environment, StrictUndefined

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompt_migrate import LIBRARY, load_library, significant, store  # noqa: E402

MARKUP = re.compile(r"(\{\{.*?\}\}|\{%-?.*?-?%\}|\{#.*?#\})", re.S)


def environment(library=None):
    env = Environment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True, autoescape=False)
    if library is not None:
        env.globals["prompt_ref"] = lambda key, version=1: library[f"{key}@{version}"]
    return env


def main(path, prefix, contexts_path):
    file = Path(path)
    source = file.read_text(encoding="utf-8")
    library = load_library()
    pieces, n = [], 0
    for piece in MARKUP.split(source):
        if MARKUP.fullmatch(piece) or not significant(piece):
            pieces.append(piece)
            continue
        core = piece.strip()
        lead, trail = piece[:len(piece) - len(piece.lstrip())], piece[len(piece.rstrip()):]
        n += 1
        key = f"{prefix}.p{n}"
        store(library, f"{key}@1", core)
        pieces.append(f"{lead}{{{{ prompt_ref('{key}') }}}}{trail}")
    new_source = "".join(pieces)
    for context in json.loads(Path(contexts_path).read_text(encoding="utf-8")):
        before = environment().from_string(source).render(**context)
        after = environment(library).from_string(new_source).render(**context)
        assert before == after, f"{file.name} renders differently for {context}"
    file.write_text(new_source, encoding="utf-8", newline="")
    LIBRARY.write_text(json.dumps(dict(sorted(library.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{file.name}: moved {n} run(s); library has {len(library)} entries")


if __name__ == "__main__":
    main(*sys.argv[1:4])
