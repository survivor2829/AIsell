from __future__ import annotations

import argparse
from pathlib import Path
import sys

from content_engine.errors import ContentEngineError
from content_engine.protocol import serve_jsonl
from content_engine.service import ContentEngineService, has_unsafe_component


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Local content metadata engine")
    parser.add_argument("--data-dir", required=True)
    return parser.parse_args(argv)


def validate_data_dir(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        raise ContentEngineError("invalid_data_dir", "data-dir must be absolute.")
    nearest_existing = path
    while not nearest_existing.exists() and nearest_existing.parent != nearest_existing:
        nearest_existing = nearest_existing.parent
    if has_unsafe_component(nearest_existing):
        raise ContentEngineError(
            "invalid_data_dir", "data-dir cannot traverse a symbolic link or junction."
        )
    path.mkdir(parents=True, exist_ok=True)
    if has_unsafe_component(path):
        raise ContentEngineError(
            "invalid_data_dir", "data-dir cannot traverse a symbolic link or junction."
        )
    return path.resolve(strict=True)


def main(argv=None) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = parse_args(argv)
    try:
        data_dir = validate_data_dir(args.data_dir)
        service = ContentEngineService(data_dir)
    except Exception:
        print("content-engine failed to initialize", file=sys.stderr)
        return 2
    try:
        serve_jsonl(service)
        return 0
    finally:
        service.close()


if __name__ == "__main__":
    raise SystemExit(main())
