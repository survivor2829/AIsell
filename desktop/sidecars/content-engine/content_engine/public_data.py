from __future__ import annotations

import re
from typing import Any


_PRIVATE_KEY_PARTS = ("path", "directory", "folder")
_WINDOWS_ABSOLUTE = re.compile(
    r"(?i)(?<![\w:])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)[^\r\n\t\"'<>|]*"
)
_POSIX_ABSOLUTE = re.compile(r"(?<![\w:])/(?:[^/\s]+/)*[^/\s]*")


def redact_text(value: str) -> str:
    value = _WINDOWS_ABSOLUTE.sub("[redacted path]", value)
    return _POSIX_ABSOLUTE.sub("[redacted path]", value)


def sanitize_public_value(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized = {}
        for key, child in value.items():
            safe_key = str(key)
            lowered = safe_key.casefold()
            if any(part in lowered for part in _PRIVATE_KEY_PARTS):
                continue
            sanitized[safe_key] = sanitize_public_value(child)
        return sanitized
    if isinstance(value, list):
        return [sanitize_public_value(child) for child in value]
    if isinstance(value, tuple):
        return [sanitize_public_value(child) for child in value]
    if isinstance(value, str):
        return redact_text(value)
    return value
