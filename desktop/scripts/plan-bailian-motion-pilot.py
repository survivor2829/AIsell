from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


DESKTOP_DIR = Path(__file__).resolve().parents[1]
SIDECAR_DIR = DESKTOP_DIR / "sidecars" / "content-engine"
sys.path.insert(0, str(SIDECAR_DIR))

from content_engine.creative_analysis import DashScopeMediaClient  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan a bounded Remotion pilot with Bailian.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    options = parser.parse_args()
    input_path = Path(options.input).resolve()
    output_path = Path(options.output).resolve()
    if not input_path.is_file() or input_path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("The motion pilot input is unavailable or too large.")
    manifest = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("The motion pilot input must be a JSON object.")
    captions = manifest.get("captions") or []
    transcript = str(manifest.get("transcript") or "").strip()
    if not transcript:
        transcript = "".join(
            str(item.get("text") or "") for item in captions if isinstance(item, dict)
        )
    api_key = sys.stdin.read(513).strip()
    if not api_key or len(api_key) > 512:
        raise ValueError("A valid Bailian API key is required.")
    plan = DashScopeMediaClient(api_key=api_key).plan_motion_events(
        transcript=transcript,
        duration_ms=int(manifest.get("durationMs") or 0),
        captions=captions,
        visual_context=manifest.get("visualContext") or [],
        style_id=str(manifest.get("styleId") or "social_pop"),
    )
    result = {
        key: manifest[key]
        for key in (
            "version",
            "styleId",
            "durationMs",
            "title",
            "sourceFile",
            "captions",
            "focusRects",
            "protectedRects",
        )
        if key in manifest
    }
    result["events"] = [
        {
            **{
                key: value
                for key, value in event.items()
                if key not in {"start_ms", "end_ms"}
            },
            "startMs": event["start_ms"],
            "endMs": event["end_ms"],
        }
        for event in plan["events"]
    ]
    result["director"] = {
        "version": plan["version"],
        "provider": plan["provider"],
        "model": plan["model"],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=output_path.parent, delete=False, suffix=".tmp"
    ) as temporary:
        json.dump(result, temporary, ensure_ascii=False, indent=2)
        temporary.write("\n")
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, output_path)
    print(json.dumps({"provider": plan["provider"], "events": len(plan["events"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
