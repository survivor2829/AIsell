from __future__ import annotations

import hashlib
from pathlib import Path
import struct


DEFAULT_SAMPLE_BYTES = 1024 * 1024
open_file = open


def sampled_sha256(path: Path, sample_bytes: int = DEFAULT_SAMPLE_BYTES) -> str:
    """Hash file size plus bounded first/middle/last samples.

    This intentionally does not read a multi-GB source file in full. Offsets and
    sample lengths are included so overlapping samples remain unambiguous.
    """

    if sample_bytes <= 0:
        raise ValueError("sample_bytes must be positive")

    size = path.stat().st_size
    max_offset = max(0, size - sample_bytes)
    offsets = sorted({0, max_offset // 2, max_offset})
    digest = hashlib.sha256()
    digest.update(struct.pack(">Q", size))

    with open_file(path, "rb") as handle:
        for offset in offsets:
            handle.seek(offset)
            chunk = handle.read(min(sample_bytes, max(0, size - offset)))
            digest.update(struct.pack(">Q", offset))
            digest.update(struct.pack(">Q", len(chunk)))
            digest.update(chunk)

    return digest.hexdigest()
