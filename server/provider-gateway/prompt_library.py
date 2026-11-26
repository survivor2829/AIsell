"""Prompt library: the prompt text lives on the server, the app only names it (user decision 2026-11-25).

The desktop app writes a token such as ``⟦xiaoxi-prompt:detail.planner.system@1⟧`` where a prompt used to be.
Before a request goes to a model provider, the gateway replaces every token inside the JSON strings of the
request body with the stored text. The customer's own data (product facts, chat lines) is still filled in by the
app, around the tokens, so the app's assembly logic does not change; only the prompt wording leaves the package.

Versions are kept side by side (``id@1``, ``id@2``): an app that was not updated keeps the wording it was tested
with. A token the library does not know stops the request before anything is paid for.
"""
from __future__ import annotations

import json
import os
import re
import threading

# Bodies are scanned for the ASCII part, so a token the app wrote as ⟦ (JSON escaping) is found too.
MARK = b"xiaoxi-prompt:"
OPEN = "⟦xiaoxi-prompt:"
TOKEN = re.compile("⟦xiaoxi-prompt:([a-z0-9][a-z0-9_.-]{0,99})@([1-9][0-9]{0,3})⟧")
MAX_EXPANDED_BYTES = 8 * 1024 * 1024


class PromptError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _validate(entries) -> dict[str, str]:
    if not isinstance(entries, dict):
        raise ValueError("prompt library must be an object")
    library = {}
    for key, text in entries.items():
        match = re.fullmatch(r"([a-z0-9][a-z0-9_.-]{0,99})@([1-9][0-9]{0,3})", str(key))
        if not match or not isinstance(text, str) or not text:
            raise ValueError(f"invalid prompt entry: {key!r}")
        if OPEN in text:
            raise ValueError(f"prompt {key} contains a token")
        library[key] = text
    return library


class PromptLibrary:
    """Loads ``prompt-library.json`` (``{"id@version": "text"}``) and expands tokens in request bodies."""

    def __init__(self, path: str | None):
        self.path = path
        self._entries: dict[str, str] = {}
        self._mtime = None
        self._lock = threading.Lock()
        self.reload()

    def reload(self) -> None:
        if not self.path or not os.path.exists(self.path):
            with self._lock:
                self._entries, self._mtime = {}, None
            return
        mtime = os.path.getmtime(self.path)
        with open(self.path, encoding="utf-8") as handle:
            entries = _validate(json.load(handle))
        with self._lock:
            self._entries, self._mtime = entries, mtime

    def _current(self) -> dict[str, str]:
        # A deployed library update is picked up without restarting the gateway.
        try:
            if self.path and os.path.exists(self.path) and os.path.getmtime(self.path) != self._mtime:
                self.reload()
        except (OSError, ValueError):
            pass  # Keep serving the last good library; a broken file never empties it.
        with self._lock:
            return self._entries

    def __len__(self) -> int:
        return len(self._current())

    def text(self, key: str) -> str:
        entries = self._current()
        if key not in entries:
            raise PromptError("prompt_unknown")
        return entries[key]

    def expand_text(self, value: str) -> str:
        entries = self._current()

        def replace(match):
            key = f"{match.group(1)}@{match.group(2)}"
            if key not in entries:
                raise PromptError("prompt_unknown")
            return entries[key]

        expanded = TOKEN.sub(replace, value)
        if OPEN in expanded:
            raise PromptError("prompt_token_invalid")
        return expanded

    def expand(self, body: bytes) -> bytes:
        """Returns the body with every token replaced. A body without tokens is returned as it came."""
        if not body or MARK not in body:
            return body
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise PromptError("prompt_body_unsupported") from error

        def walk(value):
            if isinstance(value, str):
                return self.expand_text(value) if OPEN in value else value
            if isinstance(value, list):
                return [walk(item) for item in value]
            if isinstance(value, dict):
                return {key: walk(item) for key, item in value.items()}
            return value

        expanded = json.dumps(walk(payload), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(expanded) > MAX_EXPANDED_BYTES:
            raise PromptError("prompt_body_too_large")
        return expanded
