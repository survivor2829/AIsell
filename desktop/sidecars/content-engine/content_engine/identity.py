from __future__ import annotations

import hashlib
from pathlib import Path

from .errors import ContentEngineError
from .hashing import sampled_sha256


FULL_HASH_CHUNK_BYTES = 4 * 1024 * 1024


def _stable_stat(path: Path):
    file_stat = path.stat()
    return file_stat.st_size, file_stat.st_mtime_ns


def stable_sampled_sha256(path: Path) -> tuple[str, tuple[int, int]]:
    before = _stable_stat(path)
    fingerprint = sampled_sha256(path)
    after = _stable_stat(path)
    if before != after:
        raise ContentEngineError(
            "file_changed", "The media file changed while it was being indexed."
        )
    return fingerprint, after


def stable_full_sha256(path: Path) -> str:
    before = _stable_stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(FULL_HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    after = _stable_stat(path)
    if before != after:
        raise ContentEngineError(
            "file_changed", "The media file changed while it was being verified."
        )
    return digest.hexdigest()
