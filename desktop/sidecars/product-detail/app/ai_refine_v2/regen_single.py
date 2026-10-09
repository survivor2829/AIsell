"""单屏重生成模块 (v3.3 reroll). Spec: 2026-04-30-regenerate-screen-design.md"""
from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image

from ai_refine_v2.color_extractor import extract_color_anchor
from ai_refine_v2.refine_generator import (
    _default_api_call,
    _generate_one_block_v2,
    _to_data_url,
)


@dataclass(frozen=True)
class RegenResult:
    """单屏重生成结果. spec §3.3 D4."""

    new_block_path: Path
    new_assembled_path: Path
    cost_rmb: float
    costs: dict | None = None


def _download_block_to_disk(url: str, dst: Path) -> None:
    """下载 image_url (可能是 http(s)/data:/local path) 到 dst."""
    if url.startswith(("http://", "https://")):
        with urllib.request.urlopen(url, timeout=30) as r:
            dst.write_bytes(r.read())
    elif url.startswith("data:"):
        # data:image/jpeg;base64,xxx  ← _to_data_url 反向
        import base64
        _, b64 = url.split(",", 1)
        dst.write_bytes(base64.b64decode(b64))
    else:
        # 视为本地路径
        dst.write_bytes(Path(url).read_bytes())


def _assemble_long_image(task_dir: Path) -> Path:
    """把 task_dir 下所有 block_*.jpg 按 index 顺序竖向拼成 assembled.png.

    DRY 原则: 复用 pipeline_runner._run_assembler_v2 + _validate_assembled_png,
    避免拼接逻辑漂移 (paste 左对齐 / 体积守门 / 100KB 防纯白等). pipeline 内部用
    `canvas.paste(im, (0, y))` 左对齐, 不是居中 — 必须保持一致, 否则 rerolled
    assembled.png 排版会跟原始 assembled.png 不同, 用户视觉混乱.

    实现细节: _run_assembler_v2 期望 blocks 是 **runtime state** (含 file/success
    字段), 不是 _planning.json 的 raw planning. 所以扫盘上的 block_*.jpg, 构造
    synthetic block dicts 喂给它. 这等价于 "所有 on-disk 的 block 都进拼接", 比
    依赖 _planning.json/_summary.json 鲁棒.
    """
    from ai_refine_v2.pipeline_runner import _run_assembler_v2, _validate_assembled_png

    block_files = sorted(
        task_dir.glob("block_*.jpg"),
        key=lambda p: int(p.stem.split("_")[1]),
    )
    if not block_files:
        raise FileNotFoundError(f"无 block_*.jpg in {task_dir}")
    synthetic_blocks = [
        {"file": p.name, "success": True} for p in block_files
    ]
    _run_assembler_v2(task_dir, synthetic_blocks)
    out = task_dir / "assembled.png"
    _validate_assembled_png(out)
    return out


def regenerate_screen(
    task_dir: Path,
    block_index: int,
    cutout_path: Optional[Path],
    deepseek_key: str,
    gpt_image_key: str,
) -> RegenResult:
    """重生第 block_index 屏, 重拼长图.

    raises:
        FileNotFoundError: task_dir / _planning.json / block_<idx>.jpg 缺
        IndexError: block_index 越界
        RuntimeError: gpt-image-2 调用失败 (透传 _generate_one_block_v2 错)
    """
    if not task_dir.is_dir():
        raise FileNotFoundError(f"task_dir 不存在: {task_dir}")
    planning_path = task_dir / "_planning.json"
    if not planning_path.is_file():
        raise FileNotFoundError(f"_planning.json 不在: {planning_path}")
    planning = json.loads(planning_path.read_text(encoding="utf-8"))
    blocks = planning.get("blocks") or []
    if not (0 <= block_index < len(blocks)):
        raise IndexError(
            f"block_index={block_index} 越界 (0..{len(blocks) - 1})"
        )
    block = blocks[block_index]

    color_anchor = None
    image_data_url = None
    if cutout_path and cutout_path.is_file():
        try:
            color_anchor = extract_color_anchor(cutout_path)
        except Exception:
            color_anchor = None
        try:
            image_data_url = _to_data_url(str(cutout_path))
        except Exception:
            image_data_url = None

    from ai_refine_v2.pricing import CostJournal, RequestOutcomeUnknown, read_quote, _write
    import uuid
    pointer = task_dir / "rerolls" / f"block_{block_index}.json"
    if pointer.exists():
        try:
            previous = json.loads(pointer.read_text(encoding="utf-8"))
            if not re.fullmatch(r"[a-f0-9]{32}", str(previous.get("attempt_id") or "")):
                raise ValueError("invalid attempt")
            old_dir = task_dir / "rerolls" / previous["attempt_id"]
            old_journal = CostJournal(old_dir)
            old = old_journal.load()
        except Exception:
            raise RequestOutcomeUnknown("原重做记录无法读取，请先核对原请求。") from None
        if not (old_dir / "_assembled.json").is_file() and old["operations"]:
            operation = next(iter(old["operations"].values()))
            raw_url = operation.get("raw_url")
            if not raw_url and operation.get("provider_task_id"):
                from ai_image_apimart import poll_image_task
                raw_url = poll_image_task(operation["provider_task_id"], gpt_image_key)
            if not raw_url:
                raise RequestOutcomeUnknown("原重做请求结果不明，禁止再次下单。")
            block_jpg = task_dir / f"block_{block_index}.jpg"
            _download_block_to_disk(raw_url, block_jpg)
            assembled = _assemble_long_image(task_dir)
            old_journal.finish(next(iter(old["operations"])), "completed", raw_url=raw_url)
            _write(old_dir / "_assembled.json", {"completed": True})
            return RegenResult(block_jpg, assembled, old["quote"]["image_unit_cny"], old_journal.summary())
    quote = read_quote(include_planner=False)
    attempt_id = uuid.uuid4().hex
    journal = CostJournal(task_dir / "rerolls" / attempt_id)
    journal.set_plan(quote, 1)
    _write(pointer, {"attempt_id": attempt_id})
    block_result, _ = _generate_one_block_v2(
        block=block,
        image_data_url=image_data_url,
        api_key=gpt_image_key,
        api_call_fn=lambda *args, **kwargs: journal.image_call(quote, _default_api_call, *args, block_id=block["block_id"], **kwargs),
        max_retries=0,
        thinking="medium",
        size="3:4",
        color_anchor=color_anchor,
    )
    if block_result.image_url is None:
        raise RuntimeError(
            f"_generate_one_block_v2 失败: {block_result.error or 'unknown'}"
        )

    block_jpg = task_dir / f"block_{block_index}.jpg"
    _download_block_to_disk(block_result.image_url, block_jpg)
    new_assembled = _assemble_long_image(task_dir)
    _write(journal.path.parent / "_assembled.json", {"completed": True})
    return RegenResult(
        new_block_path=block_jpg,
        new_assembled_path=new_assembled,
        cost_rmb=quote["image_unit_cny"],
        costs=journal.summary(),
    )
