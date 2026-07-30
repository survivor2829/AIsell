"""Schema smoke · pipeline_runner._run_real_generator ↔ refine_generator 对齐验证.

不调任何真 API (DeepSeek / APIMart 都不动), 纯本地 mock. 专治:
  - 2026-04-24 出的 `Unknown format code 'd' for object of type 'str'`
    (BlockResult.block_id 是 str 但被 {:02d} 格式化)
  - 进度条 1/6 → 7/6 越界 (硬编码分母 6 vs 实际 len(block_order))
  - 潜伏 AttributeError: BlockResult 没有 is_hero/success 字段

用法:
    python scripts/smoke_pipeline_schema.py

返回:
    exit=0 全部通过 / exit=1 某一项断言失败 (打印具体哪一项)
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest import mock

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))


def _build_fake_generation_result(n_blocks: int = 7):
    """造一个 n_blocks 个 block 的 GenerationResult, 故意用 7 来触发老代码的 /6 越界."""
    from ai_refine_v2.refine_generator import BlockResult, GenerationResult

    ids = ["hero"] + [f"selling_point_{i}" for i in range(1, n_blocks)]
    brs = [
        BlockResult(
            block_id=bid,
            visual_type="product_in_scene" if bid == "hero" else "product_closeup",
            prompt=f"(fake prompt for {bid})",
            image_url=f"https://fake.cdn/{bid}.jpg",
            error=None,
            placeholder=False,
        )
        for bid in ids
    ]
    return GenerationResult(
        blocks=brs, hero_success=True, total_cost_rmb=0.70 * n_blocks,
        total_elapsed_s=1.23, errors=[],
    )


def main() -> int:
    from ai_refine_v2 import pipeline_runner

    n = 7  # 故意 >6, 验证分母从 planning.block_order 拿
    planning = {
        "product_meta": {"name": "TESTBOT"},
        "planning": {
            "total_blocks": n,
            "block_order": ["hero"] + [f"selling_point_{i}" for i in range(1, n)],
        },
    }
    progress_events: list[tuple[int, str]] = []

    def fake_progress_cb(pct: int, msg: str) -> None:
        progress_events.append((pct, msg))

    fake_result = _build_fake_generation_result(n_blocks=n)

    with tempfile.TemporaryDirectory() as td:
        task_dir = Path(td) / "task_schema_test"

        # 替换 generate() 返回假结果, 替换 urlretrieve 为 no-op (避免真下载)
        with mock.patch(
            "ai_refine_v2.refine_generator.generate",
            return_value=fake_result,
        ), mock.patch(
            "urllib.request.urlretrieve",
            side_effect=lambda url, dst: Path(dst).write_bytes(b""),
        ):
            # 还要顺手触发一下 wrapped_api_call, 让 progress 报被调用 n 次
            # (mock 了 generate 就不会真触发, 所以手动喂 progress)
            # 为了让 progress 也经过 _run_real_generator 内部包装,
            # 我们改 mock 策略: 让 generate 这个 mock 在被调用时,
            # 先调用传入的 api_call_fn n 次 (每次喂假 URL), 再返回结果.
            pass

        def fake_generate(**kwargs):
            # kwargs["api_call_fn"] 是 _run_real_generator 包装过的 wrapped_api_call.
            # 调 n 次模拟"每个 block 成功调一次 API".
            cb = kwargs.get("api_call_fn")
            for bid in planning["planning"]["block_order"]:
                cb("fake prompt", None, "fake-key", "medium", "1:1")
            return fake_result

        with mock.patch(
            "ai_refine_v2.refine_generator.generate", side_effect=fake_generate,
        ), mock.patch(
            "ai_refine_v2.refine_generator._default_api_call",
            return_value="https://fake.cdn/x.jpg",
        ), mock.patch(
            "urllib.request.urlretrieve",
            side_effect=lambda url, dst: Path(dst).write_bytes(b""),
        ):
            blocks, cost = pipeline_runner._run_real_generator(
                planning=planning,
                product_image_url="https://fake.cdn/product.jpg",
                gpt_image_key="fake-gpt-key",
                task_dir=task_dir,
                progress_cb=fake_progress_cb,
            )

    # ── 断言 ────────────────────────────────────────
    fails: list[str] = []

    if len(blocks) != n:
        fails.append(f"blocks 数量: 期望 {n}, 实际 {len(blocks)}")

    required_keys = {
        "block_id", "visual_type", "is_hero", "file",
        "image_url", "success", "placeholder",
    }
    for i, b in enumerate(blocks):
        missing = required_keys - set(b.keys())
        if missing:
            fails.append(f"blocks[{i}] 缺 key: {missing}")
        # 文件名里不能再出现 :02d 对 str 的失败痕迹, 必须是干净字符串
        fn = b.get("file", "")
        if not fn or ".jpg" not in fn:
            fails.append(f"blocks[{i}].file 不合法: {fn!r}")
        # block_id 是 str, 允许
        if not isinstance(b["block_id"], str):
            fails.append(f"blocks[{i}].block_id 不是 str: {type(b['block_id'])}")

    # 第一个必须是 hero
    if blocks and blocks[0]["is_hero"] is not True:
        fails.append(f"blocks[0].is_hero 应为 True, 实际 {blocks[0]['is_hero']!r}")
    for b in blocks[1:]:
        if b["is_hero"] is not False:
            fails.append(f"非 hero block is_hero 应 False: {b['block_id']} → {b['is_hero']!r}")

    # 进度事件: 应恰好 n 次, 最后一个分母与 n 一致 ("x/7"), 不再出现 "/6"
    if len(progress_events) != n:
        fails.append(f"progress 回调次数: 期望 {n}, 实际 {len(progress_events)}")
    for i, (pct, msg) in enumerate(progress_events, start=1):
        if not (20 <= pct <= 80):
            fails.append(f"progress[{i}] pct={pct} 超出 [20,80] 区间")
        if f"{i}/{n}" not in msg:
            fails.append(f"progress[{i}] msg 应含 '{i}/{n}', 实际 {msg!r}")
        if "/6" in msg and n != 6:
            fails.append(f"progress[{i}] msg 仍硬编码 '/6': {msg!r}")

    # ── 结果 ────────────────────────────────────────
    print("=" * 64)
    print(f"[smoke-schema] n_blocks={n}, progress_events={len(progress_events)}, "
          f"blocks_out={len(blocks)}, cost={cost}")
    for i, (pct, msg) in enumerate(progress_events, 1):
        print(f"  progress[{i}] {pct:>3}%  {msg}")
    print(f"  blocks[0]={blocks[0] if blocks else '(empty)'}")
    if blocks:
        print(f"  blocks[-1]={blocks[-1]}")
    print("=" * 64)

    if fails:
        print("[smoke-schema] FAIL")
        for f in fails:
            print(f"  ✗ {f}")
        return 1
    print("[smoke-schema] PASS — schema 对齐, 无 :02d/AttributeError/进度越界")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
