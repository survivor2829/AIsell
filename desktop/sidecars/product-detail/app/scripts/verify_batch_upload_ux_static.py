"""Static verifier for batch upload UX invariants.

This script intentionally uses only the Python standard library so it can run
in lightweight environments where pytest/project dependencies are unavailable.
It mirrors the high-value assertions in tests/test_batch_upload_ux.py.
"""
from __future__ import annotations

import re
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
UPLOAD_HTML = REPO / "templates" / "batch" / "upload.html"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    content = UPLOAD_HTML.read_text(encoding="utf-8")

    require(
        re.search(
            r"\.picker\s+\.icon\s*,\s*[\s\S]{0,80}?"
            r"\.picker\s+\.hint\s*,\s*[\s\S]{0,80}?"
            r"\.picker\s+\.sub\s*\{[\s\S]{0,80}?pointer-events\s*:\s*none\s*;",
            content,
        )
        is not None,
        "picker child elements must use pointer-events:none",
    )

    require(
        re.search(
            r"picker\.addEventListener\(\s*['\"]click['\"]\s*,\s*\(e\)\s*=>\s*\{"
            r"[\s\S]{0,220}?if\s*\(\s*e\.target\s*!==\s*folderInput\s*\)"
            r"[\s\S]{0,160}?e\.preventDefault\(\);"
            r"[\s\S]{0,120}?folderInput\.click\(\);",
            content,
        )
        is not None,
        "picker click fallback must preventDefault and call folderInput.click()",
    )

    require(
        "new XMLHttpRequest()" in content,
        "batch upload must use XMLHttpRequest for upload progress",
    )
    require(
        "xhr.upload.onprogress" in content,
        "batch upload must bind xhr.upload.onprogress",
    )
    require(
        "xhr.setRequestHeader('X-CSRFToken', csrfToken)" in content,
        "XHR upload must keep the CSRF header",
    )
    require(
        "fetch('/api/batch/upload'" not in content,
        "batch upload endpoint must not use fetch",
    )
    require("上传中 ${pct}%" in content, "progress text must include percent")
    require("formatBytesPerSecond" in content, "progress text must include speed")
    require("剩余 ${etaText}" in content, "progress text must include ETA")
    require(
        "上传失败 ${r.status}: ${data.error || r.statusText}" in content,
        "upload error status text must be preserved",
    )

    print("batch upload UX static checks passed")


if __name__ == "__main__":
    main()
