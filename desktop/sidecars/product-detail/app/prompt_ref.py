"""Prompt wording is kept on the server (user decision 2026-11-25).

The engine writes a token where a prompt used to be; the provider gateway replaces it with the stored text before the
request reaches a model (server/provider-gateway/prompt_library.py). The customer's own data is still filled in here,
around the tokens. The brackets never clash with ``str.format`` braces or JSON escaping.

Run from the source repository (development machine, CI), the server's ``prompt-library.json`` sits beside the code,
so tests and local runs see the real wording; ``XIAOXI_PROMPT_LIBRARY`` can name another file. The file is never
packaged, so a customer computer only ever produces tokens. ``XIAOXI_PROMPT_TOKENS=1`` forces tokens (to test that path).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

_ID = re.compile(r"[a-z0-9][a-z0-9_.-]{0,99}")
_LIBRARY = None


def _repo_library() -> Path | None:
    # desktop/sidecars/<engine>/<package>/prompt_ref.py -> repository root; a packaged copy has no such file.
    parents = Path(__file__).resolve().parents
    return parents[4] / "server" / "provider-gateway" / "prompt-library.json" if len(parents) > 4 else None


_REPO_LIBRARY = _repo_library()


def _library():
    global _LIBRARY
    if os.environ.get("XIAOXI_PROMPT_TOKENS") == "1":
        return None
    path = os.environ.get("XIAOXI_PROMPT_LIBRARY", "") or (str(_REPO_LIBRARY) if _REPO_LIBRARY and _REPO_LIBRARY.is_file() else "")
    if not path:
        return None
    if _LIBRARY is None or _LIBRARY[0] != path:
        with open(path, encoding="utf-8") as handle:
            _LIBRARY = (path, json.load(handle))
    return _LIBRARY[1]


def prompt_ref(prompt_id: str, version: int = 1, *, formatted: bool = False) -> str:
    """The token for a stored prompt. ``formatted``: the result goes through ``str.format`` afterwards."""
    if not _ID.fullmatch(str(prompt_id)) or not isinstance(version, int) or not 1 <= version <= 9999:
        raise ValueError(f"invalid prompt id: {prompt_id}@{version}")
    library = _library()
    if library is not None:
        text = library[f"{prompt_id}@{version}"]
        return text.replace("{", "{{").replace("}", "}}") if formatted else text
    return f"⟦xiaoxi-prompt:{prompt_id}@{version}⟧"


_TOKEN = re.compile("⟦xiaoxi-prompt:([a-z0-9][a-z0-9_.-]{0,99})@([1-9][0-9]{0,3})⟧")


def prompt_bytes(text: str) -> int:
    """UTF-8 size of ``text`` once the gateway has put every prompt back, for estimates (a token is far shorter)."""
    library = _library()
    if library is None:
        try:
            from prompt_sizes import SIZES  # type: ignore
        except ImportError:
            from .prompt_sizes import SIZES  # type: ignore
    total, last = 0, 0
    for match in _TOKEN.finditer(text):
        key = f"{match.group(1)}@{match.group(2)}"
        total += len(text[last:match.start()].encode("utf-8"))
        total += len(library[key].encode("utf-8")) if library is not None else SIZES[key]
        last = match.end()
    return total + len(text[last:].encode("utf-8"))
