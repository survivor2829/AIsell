from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from workspace_results import public_url_to_path


@dataclass(frozen=True)
class CleanupCandidate:
    kind: str
    path: str
    bytes: int
    reason: str


def _as_utc(value: datetime | None = None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _newest_mtime(path: Path) -> float:
    if path.is_file():
        return path.stat().st_mtime
    newest = path.stat().st_mtime
    for child in path.rglob("*"):
        try:
            newest = max(newest, child.stat().st_mtime)
        except OSError:
            continue
    return newest


def _size_bytes(path: Path) -> int:
    try:
        if path.is_file():
            return path.stat().st_size
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    except OSError:
        return 0


def _older_than(path: Path, cutoff: datetime) -> bool:
    return _newest_mtime(path) < cutoff.timestamp()


def _history_files(root: Path) -> Iterable[Path]:
    outputs = root / "static" / "outputs"
    if not outputs.is_dir():
        return []
    return outputs.glob("*/workspace_results.json")


def _protected_paths(root: Path) -> set[Path]:
    protected: set[Path] = set()
    for history_file in _history_files(root):
        try:
            data = json.loads(history_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        results = data.get("results", []) if isinstance(data, dict) else []
        if not isinstance(results, list):
            continue
        for item in results:
            if not isinstance(item, dict):
                continue
            for key in ("image_url", "assembled_url"):
                path = public_url_to_path(str(item.get(key) or ""), root)
                if path is not None:
                    protected.add(path.resolve())
                    protected.add(path.parent.resolve())
    return protected


def _is_protected(path: Path, protected: set[Path]) -> bool:
    resolved = path.resolve()
    return any(resolved == p or p in resolved.parents for p in protected)


def _candidate(kind: str, path: Path, reason: str) -> CleanupCandidate:
    return CleanupCandidate(
        kind=kind,
        path=str(path.resolve()),
        bytes=_size_bytes(path),
        reason=reason,
    )


def collect_cleanup_plan(
    root: Path | str = ROOT,
    *,
    now: datetime | None = None,
    ai_bg_days: int = 2,
    ai_refine_days: int = 14,
    ai_compose_days: int = 14,
    keep_ai_compose_per_user: int = 5,
) -> dict:
    root = Path(root).resolve()
    now = _as_utc(now)
    candidates: list[CleanupCandidate] = []
    protected = _protected_paths(root)

    ai_bg_cutoff = now - timedelta(days=ai_bg_days)
    ai_bg_dir = root / "static" / "cache" / "ai_bg"
    if ai_bg_dir.is_dir():
        for path in ai_bg_dir.iterdir():
            if path.is_file() and _older_than(path, ai_bg_cutoff):
                candidates.append(_candidate(
                    "ai_bg_cache",
                    path,
                    f"AI background cache older than {ai_bg_days} days",
                ))

    ai_refine_cutoff = now - timedelta(days=ai_refine_days)
    ai_refine_dir = root / "static" / "ai_refine_v2"
    if ai_refine_dir.is_dir():
        for path in ai_refine_dir.iterdir():
            if not path.is_dir() or not path.name.startswith("v2_"):
                continue
            if _is_protected(path, protected):
                continue
            if _older_than(path, ai_refine_cutoff):
                candidates.append(_candidate(
                    "ai_refine_v2_task",
                    path,
                    f"AI refine v2 task older than {ai_refine_days} days",
                ))

    compose_cutoff = now - timedelta(days=ai_compose_days)
    outputs_dir = root / "static" / "outputs"
    if outputs_dir.is_dir():
        for compose_dir in outputs_dir.glob("*/ai_compose"):
            if not compose_dir.is_dir():
                continue
            files = sorted(
                [p for p in compose_dir.iterdir() if p.is_file()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            for path in files[max(0, keep_ai_compose_per_user):]:
                if _older_than(path, compose_cutoff):
                    candidates.append(_candidate(
                        "ai_compose_output",
                        path,
                        (
                            f"AI compose output older than {ai_compose_days} days "
                            f"and beyond newest {keep_ai_compose_per_user} per user"
                        ),
                    ))

    payload = [asdict(item) for item in candidates]
    return {
        "root": str(root),
        "dry_run": True,
        "candidate_count": len(payload),
        "total_bytes": sum(item["bytes"] for item in payload),
        "candidates": payload,
    }


def apply_cleanup_plan(plan: dict, root: Path | str = ROOT) -> dict:
    root = Path(root).resolve()
    deleted_count = 0
    deleted_bytes = 0
    for item in plan.get("candidates", []):
        path = Path(item.get("path", "")).resolve()
        if not _is_inside(path, root):
            raise ValueError(f"refusing to delete outside root: {path}")
        if not path.exists():
            continue
        deleted_bytes += _size_bytes(path)
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        deleted_count += 1
    return {"deleted_count": deleted_count, "deleted_bytes": deleted_bytes}


def _print_plan(plan: dict) -> None:
    print(f"DRY-RUN: {plan['candidate_count']} candidates, {plan['total_bytes']} bytes")
    for item in plan["candidates"][:100]:
        print(f"- [{item['kind']}] {item['path']} ({item['bytes']} bytes) {item['reason']}")
    if plan["candidate_count"] > 100:
        print(f"... {plan['candidate_count'] - 100} more")


def main() -> int:
    parser = argparse.ArgumentParser(description="Safe generated-file cleanup planner")
    parser.add_argument("--root", default=str(ROOT), help="project root, default: repo root")
    parser.add_argument("--apply", action="store_true", help="delete candidates from the plan")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--ai-bg-days", type=int, default=2)
    parser.add_argument("--ai-refine-days", type=int, default=14)
    parser.add_argument("--ai-compose-days", type=int, default=14)
    parser.add_argument("--keep-ai-compose-per-user", type=int, default=5)
    args = parser.parse_args()

    plan = collect_cleanup_plan(
        args.root,
        ai_bg_days=args.ai_bg_days,
        ai_refine_days=args.ai_refine_days,
        ai_compose_days=args.ai_compose_days,
        keep_ai_compose_per_user=args.keep_ai_compose_per_user,
    )

    if args.apply:
        result = apply_cleanup_plan(plan, args.root)
        output = {"plan": plan, "applied": True, "result": result}
    else:
        output = {"plan": plan, "applied": False}

    if args.json:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    elif args.apply:
        _print_plan(plan)
        print(f"APPLIED: deleted {result['deleted_count']} paths, {result['deleted_bytes']} bytes")
    else:
        _print_plan(plan)
        print("No files were deleted. Re-run with --apply to delete candidates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
