"""regen_single 单测.

所有 fixture 用 PIL 程序生成 + tempdir, 绝不依赖任何真实产品图.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from PIL import Image

from ai_refine_v2.regen_single import RegenResult, regenerate_screen


def _make_task_dir(tmp: Path, n_blocks: int = 12) -> Path:
    """造一个假的 v2 task_dir, 含 _planning.json + n 张 block_*.jpg + assembled.png.

    block_*.jpg 用随机像素噪点填充, 避免纯色被 PNG 压缩到 < 100KB 触发守门 raise.
    assembled.png 同样用随机噪点, 体积会超过 100KB.
    """
    import random
    task_dir = tmp / "v2_test_abc123"
    task_dir.mkdir()
    planning = {
        "version": "v2",
        "blocks": [
            {"block_id": f"b{i}", "visual_type": "screen",
             "prompt": f"测试 prompt {i} " * 30}
            for i in range(n_blocks)
        ],
    }
    (task_dir / "_planning.json").write_text(
        json.dumps(planning, ensure_ascii=False), encoding="utf-8"
    )
    for i in range(n_blocks):
        # 随机像素噪点确保 PNG 压缩后体积足够大 (> 100KB guard)
        rng = random.Random(i)
        pixels = bytes(rng.getrandbits(8) for _ in range(300 * 400 * 3))
        img = Image.frombytes("RGB", (300, 400), pixels)
        img.save(task_dir / f"block_{i}.jpg", quality=95)
    # assembled.png 也用噪点
    rng = random.Random(999)
    pixels = bytes(rng.getrandbits(8) for _ in range(300 * 4800 * 3))
    Image.frombytes("RGB", (300, 4800), pixels).save(task_dir / "assembled.png")
    return task_dir


class TestRegenResultDataclass(unittest.TestCase):
    """验返回 dataclass schema 跟 spec §3.3 D4 一致."""

    def test_regen_result_fields(self):
        r = RegenResult(
            new_block_path=Path("/tmp/x.jpg"),
            new_assembled_path=Path("/tmp/y.png"),
            cost_rmb=0.7,
        )
        self.assertEqual(r.cost_rmb, 0.7)
        self.assertTrue(str(r.new_block_path).endswith(".jpg"))


class TestRegenerateScreenSuccess(unittest.TestCase):
    """成功重生第 N 屏 (mock _generate_one_block_v2)."""

    def test_regenerate_block_4_replaces_jpg(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            old_block_4 = (task_dir / "block_4.jpg").read_bytes()

            new_jpg_bytes = Image.new("RGB", (300, 400), (255, 0, 0))
            buf = task_dir / "_mock_new.jpg"
            new_jpg_bytes.save(buf, quality=85)
            new_bytes_payload = buf.read_bytes()

            from ai_refine_v2.refine_generator import BlockResult
            mock_block_result = BlockResult(
                block_id="b4", visual_type="screen",
                prompt="测试 prompt 4", image_url=str(task_dir / "block_4.jpg"),
                placeholder=False,
            )

            with mock.patch(
                "ai_refine_v2.regen_single._generate_one_block_v2",
                return_value=(mock_block_result, 0.7),
            ) as mocked:
                from ai_refine_v2.regen_single import regenerate_screen
                # 也 mock 写文件 (mock 的 _generate_one_block_v2 拿到 image_url 但
                # 不真下载, 在测里我们把 new_bytes_payload 直接写到 block_4.jpg)
                with mock.patch(
                    "ai_refine_v2.regen_single._download_block_to_disk",
                    side_effect=lambda url, dst: dst.write_bytes(new_bytes_payload),
                ):
                    result = regenerate_screen(
                        task_dir=task_dir,
                        block_index=4,
                        cutout_path=None,
                        deepseek_key="fake",
                        gpt_image_key="fake",
                    )

            self.assertEqual(mocked.call_count, 1)
            self.assertEqual(result.cost_rmb, 0.7)
            new_block_4 = (task_dir / "block_4.jpg").read_bytes()
            self.assertNotEqual(old_block_4, new_block_4)
            self.assertEqual(result.new_block_path, task_dir / "block_4.jpg")
            self.assertTrue(result.new_assembled_path.exists())


class TestRegenerateScreenEdgeCases(unittest.TestCase):
    def test_task_dir_not_exist(self):
        with self.assertRaises(FileNotFoundError):
            regenerate_screen(
                task_dir=Path("/nonexistent/xxxx"),
                block_index=0, cutout_path=None,
                deepseek_key="x", gpt_image_key="x",
            )

    def test_planning_json_missing(self):
        with TemporaryDirectory() as tmp:
            task_dir = Path(tmp) / "v2_x"
            task_dir.mkdir()
            with self.assertRaises(FileNotFoundError):
                regenerate_screen(task_dir, 0, None, "x", "x")

    def test_block_index_out_of_range_negative(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            with self.assertRaises(IndexError):
                regenerate_screen(task_dir, -1, None, "x", "x")

    def test_block_index_out_of_range_too_large(self):
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            with self.assertRaises(IndexError):
                regenerate_screen(task_dir, 12, None, "x", "x")


class TestAssembleLongImage(unittest.TestCase):
    def test_assemble_no_blocks_raises(self):
        from ai_refine_v2.regen_single import _assemble_long_image
        with TemporaryDirectory() as tmp:
            empty_dir = Path(tmp) / "empty"
            empty_dir.mkdir()
            with self.assertRaises(FileNotFoundError):
                _assemble_long_image(empty_dir)

    def test_assemble_12_blocks_height_sum(self):
        from ai_refine_v2.regen_single import _assemble_long_image
        with TemporaryDirectory() as tmp:
            task_dir = _make_task_dir(Path(tmp), n_blocks=12)
            out = _assemble_long_image(task_dir)
            self.assertTrue(out.is_file())
            with Image.open(out) as assembled:
                h = assembled.height
            self.assertEqual(h, 12 * 400)  # 12 屏 × 400 height


if __name__ == "__main__":
    unittest.main()
