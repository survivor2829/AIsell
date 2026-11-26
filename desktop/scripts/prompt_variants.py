"""Writes the stored variants of prompts the app adjusts by wording (user decision 2026-11-25: wording on the server).

Compact categories (配件类/耗材类/工具类) swap screen-count wording in the planning system prompt
(visual_merchandising.fit_category). On a customer computer the prompt is a token, so the swapped wording is stored
beside it as ``<id>.compact``. Usage: python scripts/prompt_variants.py [--check]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
LIBRARY = DESKTOP.parent / "server" / "provider-gateway" / "prompt-library.json"
sys.path.insert(0, str(DESKTOP / "sidecars" / "product-detail" / "app"))


def variants(library: dict) -> dict:
    from ai_refine_v2.visual_merchandising import _COMPACT_WORDING  # noqa: E402 (the module's own wording rules)
    out = {}
    for key, text in library.items():
        base, version = key.rsplit("@", 1)
        if base.endswith(".compact"):
            continue
        compact = text
        for old, new in _COMPACT_WORDING:
            compact = compact.replace(old, new)
        if compact != text:
            out[f"{base}.compact@{version}"] = compact
    return out


def main(check: bool) -> int:
    library = json.loads(LIBRARY.read_text(encoding="utf-8"))
    wanted = variants(library)
    current = {key: text for key, text in library.items() if key.rsplit("@", 1)[0].endswith(".compact")}
    if current == wanted:
        print(f"prompt variants current ({len(wanted)})")
        return 0
    if check:
        print("prompt variants out of date: run python scripts/prompt_variants.py", file=sys.stderr)
        return 1
    merged = {key: text for key, text in library.items() if key not in current}
    merged.update(wanted)
    LIBRARY.write_text(json.dumps(dict(sorted(merged.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"prompt variants written ({len(wanted)})")
    return 0


if __name__ == "__main__":
    sys.exit(main("--check" in sys.argv))
