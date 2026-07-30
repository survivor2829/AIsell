"""静态验证: pipeline_runner 调 refine_planner.plan 的 kwargs 全在签名里.

用法:
    python scripts/verify_refine_v2_kwargs.py

用途:
    2026-04-24 出过 `plan() got an unexpected keyword argument 'product_name_hint'`
    这种纯静态问题 (调用方 kwargs vs 被调方签名不匹配). 这个脚本把校验搬成可重放的:
    每次改 plan() 签名或 pipeline_runner 调用处,跑一下即可.

    纯 AST + inspect, 不真调 DeepSeek, 不花钱, 退出码 0 = ok / 1 = fail.
"""
from __future__ import annotations

import ast
import inspect
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))


def _extract_plan_call_kwargs(source_path: Path) -> list[str]:
    """AST 扫 source_path, 找所有 refine_planner.plan(...) 调用点, 返回 kwargs 名集合."""
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        is_plan = (
            (isinstance(fn, ast.Attribute) and fn.attr == "plan")
            or (isinstance(fn, ast.Name) and fn.id == "plan")
        )
        if not is_plan:
            continue
        for kw in node.keywords:
            if kw.arg:  # 忽略 **kwargs 展开
                found.append(kw.arg)
    return found


def main() -> int:
    from ai_refine_v2 import refine_planner

    sig = inspect.signature(refine_planner.plan)
    allowed = set(sig.parameters.keys())
    print(f"[verify] refine_planner.plan signature kwargs: {sorted(allowed)}")

    runner = _REPO / "ai_refine_v2" / "pipeline_runner.py"
    used = _extract_plan_call_kwargs(runner)
    print(f"[verify] pipeline_runner 调 plan() 用到的 kwargs: {sorted(set(used))}")

    bad = [k for k in used if k not in allowed]
    if bad:
        print(f"[verify] FAIL — 这些 kwargs 在签名里不存在: {bad}")
        print(f"[verify] 修法: 要么从调用方删掉, 要么给 plan() 加参数.")
        return 1

    print("[verify] PASS — 所有 kwargs 都在 plan() 签名里.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
