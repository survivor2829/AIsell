"""Moves chosen prompt literals of a Python file to the server prompt library (user decision 2026-11-25).

Usage: python prompt_migrate.py <file.py> <import-line> <spec.json>
spec: [{"line": 69, "id": "detail.planner.system_v2", "formatted": false}, ...]

Each literal starting on ``line`` is replaced:
- a plain string: the whole text goes to the library, the code calls ``prompt_ref(id)``;
- ``formatted: true`` (the string is a ``str.format`` template): every longer fixed run between ``{fields}`` goes to the
  library as ``id.pN``; the fields stay in the code, so the app still fills in the customer's data;
- an f-string: every longer fixed run becomes ``{prompt_ref('id.pN')}``; the expressions stay as they were.
After rewriting, the file is parsed again and each literal is rebuilt from the library to check it reads exactly as
before. The library (server/provider-gateway/prompt-library.json) refuses a changed text under an existing id.
"""
from __future__ import annotations

import ast
import json
import os
import re
import string
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIBRARY = Path(os.environ["XIAOXI_PROMPT_LIBRARY_OUT"]) if os.environ.get("XIAOXI_PROMPT_LIBRARY_OUT") else REPO / "server" / "provider-gateway" / "prompt-library.json"
HAN = re.compile(r"[一-鿿]")


def significant(text: str) -> bool:
    return len(HAN.findall(text)) >= 4 or len(text.strip()) >= 24


def load_library() -> dict:
    return json.loads(LIBRARY.read_text(encoding="utf-8")) if LIBRARY.exists() else {}


def store(library: dict, key: str, text: str) -> None:
    if key in library and library[key] != text:
        raise SystemExit(f"{key} already holds different text; use a new version")
    library[key] = text


def line_offsets(data: bytes) -> list[int]:
    offsets, position = [0], 0
    for line in data.split(b"\n")[:-1]:
        position += len(line) + 1
        offsets.append(position)
    return offsets


def span(node, offsets):
    return offsets[node.lineno - 1] + node.col_offset, offsets[node.end_lineno - 1] + node.end_col_offset


def find_literal(tree, line):
    inside = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            inside.update(id(value) for value in node.values)
    candidates = [node for node in ast.walk(tree)
                  if node.__dict__.get("lineno") == line and id(node) not in inside
                  and (isinstance(node, ast.JoinedStr) or isinstance(node, ast.Constant) and isinstance(node.value, str))]
    if not candidates:
        raise SystemExit(f"no string literal starts on line {line}")
    return max(candidates, key=lambda node: (node.end_lineno - node.lineno, node.end_col_offset))


def call(key_id: str, formatted=False, quote='"') -> str:
    return f"prompt_ref({quote}{key_id}{quote}{', formatted=True' if formatted else ''})"


def rewrite_constant(node, entry, library):
    text = node.value
    if entry.get("split_at"):
        # Code slices the prompt from a marker on: store the two halves so the slice can name the second one.
        index = text.index(entry["split_at"])
        store(library, f"{entry['id']}.head@1", text[:index])
        store(library, f"{entry['id']}.tail@1", text[index:])
        return f"({call(entry['id'] + '.head')} + {call(entry['id'] + '.tail')})", [("plain", entry["id"], text)]
    if not entry.get("formatted"):
        store(library, f"{entry['id']}@1", text)
        return call(entry["id"]), [("plain", entry["id"], text)]
    pieces, parts, n = [], [], 0
    for literal, field, spec, conversion in string.Formatter().parse(text):
        if literal:
            if significant(literal):
                n += 1
                key = f"{entry['id']}.p{n}"
                store(library, f"{key}@1", literal)
                pieces.append(call(key, formatted=True))
            else:
                pieces.append(json.dumps(literal.replace("{", "{{").replace("}", "}}"), ensure_ascii=False))
        if field is not None:
            pieces.append(json.dumps("{" + field + (f"!{conversion}" if conversion else "") + (f":{spec}" if spec else "") + "}", ensure_ascii=False))
        parts.append((literal, field, spec, conversion))
    if not n:
        raise SystemExit(f"{entry['id']}: no fixed text long enough to move")
    return "(" + " + ".join(pieces) + ")", [("format", entry["id"], text)]


def rewrite_fstring(node, entry, library, data, offsets):
    """The whole f-string is written again as one: fixed runs become {prompt_ref('…')} or escaped text, and each
    expression is copied from the source as it was. (Editing pieces in place breaks implicitly joined literals.)"""
    source = data.decode("utf-8")
    parts, n = [], 0
    for value in node.values:
        if isinstance(value, ast.Constant):
            if significant(value.value):
                n += 1
                key = f"{entry['id']}.p{n}"
                store(library, f"{key}@1", value.value)
                parts.append("{" + call(key, quote="'") + "}")
            else:
                parts.append(json.dumps(value.value, ensure_ascii=False)[1:-1].replace("{", "{{").replace("}", "}}"))
        else:
            segment = ast.get_source_segment(source, value)
            if not segment or not segment.startswith("{"):
                raise SystemExit(f"{entry['id']}: cannot copy an expression of the f-string on line {node.lineno}")
            parts.append(segment)
    if not n:
        raise SystemExit(f"{entry['id']}: no fixed text long enough to move")
    start, end = span(node, offsets)
    return [(start, end, 'f"' + "".join(parts) + '"')]


def normalized(node, library):
    """An f-string as fixed text and expressions, with prompt_ref(...) put back as its stored text."""
    out = []
    for value in node.values:
        if isinstance(value, ast.Constant):
            out.append(("t", value.value))
        elif isinstance(value.value, ast.Call) and getattr(value.value.func, "id", "") == "prompt_ref":
            out.append(("t", library[value.value.args[0].value + "@1"]))
        else:
            out.append(("e", ast.dump(value)))
    merged = []
    for kind, item in out:
        if merged and kind == "t" == merged[-1][0]:
            merged[-1] = ("t", merged[-1][1] + item)
        else:
            merged.append((kind, item))
    return merged


def main(path, import_line, spec_path):
    file = Path(path)
    data = file.read_bytes()
    text = data.decode("utf-8")
    tree = ast.parse(text)
    offsets = line_offsets(data)
    library = load_library()
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    # The library text put back exactly where prompt_ref(...) will put it (same rules as the gateway).
    def resolve(key, version=1, formatted=False):
        text = library[f"{key}@{version}"]
        return text.replace("{", "{{").replace("}", "}}") if formatted else text

    edits, checks = [], []
    for entry in spec:
        node = find_literal(tree, entry["line"])
        a, b = span(node, offsets)
        if isinstance(node, ast.JoinedStr):
            fstring_edits = rewrite_fstring(node, entry, library, data, offsets)
            edits += fstring_edits
            # Rebuild the whole f-string's new source, then compare its normalized form to the original's.
            rebuilt = bytearray(data[a:b])
            for ea, eb, replacement in sorted(fstring_edits, reverse=True):
                rebuilt[ea - a:eb - a] = replacement.encode("utf-8")
            checks.append(("fstring", normalized(node, library), rebuilt.decode("utf-8")))
        else:
            replacement, _ = rewrite_constant(node, entry, library)
            edits.append((a, b, replacement))
            checks.append(("expr", node.value, replacement, bool(entry.get("formatted"))))
    # Check before writing: every replacement, with the library text put back, reads exactly as the original.
    namespace = {"prompt_ref": resolve}
    for check in checks:
        if check[0] == "fstring":
            _, before, new_source = check
            after = ast.parse(new_source).body[0].value
            assert normalized(after, library) == before, "an f-string changed"
        else:
            _, before, replacement, formatted = check
            value = eval(replacement, namespace)
            if formatted:
                assert value.format_map(_Keep()) == before.format_map(_Keep()), "a template changed"
            else:
                assert value == before, "a constant changed"
    for a, b, replacement in sorted(edits, reverse=True):
        data = data[:a] + replacement.encode("utf-8") + data[b:]
    new_text = data.decode("utf-8")
    if import_line not in new_text:
        lines = new_text.split("\n")
        uses = [n.lineno - 1 for n in ast.walk(ast.parse(new_text)) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "prompt_ref"]
        first_use = min(uses) if uses else len(lines)
        # Module-level imports that come before the first use (a file may import again further down).
        import_lines = [i for i, line in enumerate(lines) if i < first_use and re.match(r"(from \S+ import |import )", line)]
        if import_lines:
            index = max(import_lines) + 1  # After the last top-level import, before the prompt constants.
        else:
            # No imports: after the module docstring, so a module-level prompt_ref(...) still has the name.
            module = ast.parse(new_text).body
            index = module[0].end_lineno if module and isinstance(module[0], ast.Expr) and isinstance(module[0].value, ast.Constant) else 0
        lines.insert(index, import_line)
        new_text = "\n".join(lines)
    ast.parse(new_text)  # The rewritten file still parses.
    # The import name is available before the first use (a module-level prompt constant runs at import time).
    first_ref = next((n for n in ast.walk(ast.parse(new_text)) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "prompt_ref"), None)
    import_at = next(i for i, line in enumerate(new_text.split("\n")) if import_line in line)
    assert first_ref is None or import_at < first_ref.lineno, "the prompt_ref import must come before the first use"
    file.write_text(new_text, encoding="utf-8", newline="")
    LIBRARY.write_text(json.dumps(dict(sorted(library.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{file.name}: moved {len(spec)} literal(s); library has {len(library)} entries")


class _Keep(dict):
    def __missing__(self, key):
        return "§" + key


if __name__ == "__main__":
    main(*sys.argv[1:4])
