"""pipeline_runner v2 路径单测 (PRD §阶段二·任务 2.2).

跟 test_pipeline_runner.py (v1 路径 60 单测) 完全独立, 验证 v2 新增内容:
  - dispatcher: _worker(mode='v1'|'v2'|invalid) 路由到 _worker_v1 / _worker_v2
  - _run_real_generator_v2: 4 刀 A/B/D guard 复用 v1 实现
  - _run_assembler_v2: 4 刀 E (size guard) PIL stub 拼接
  - _load_mock_planning_v2 + _copy_mock_images_v2: mock 路径
  - _worker_v2 端到端: mock 模式跑通完整管线
  - 安全阀 V2_ALLOW_REAL_API 对 v2 mode 同样生效

全程 0 真调 gpt-image-2 / DeepSeek / APIMart, 全 mock.
"""
from __future__ import annotations

import json
import os
import tempfile
import time as _time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from ai_refine_v2 import pipeline_runner

_REPO = Path(__file__).resolve().parents[2]


# ────────────────────────────────────────────────────────────────
# A. Dispatcher: _worker(mode=...) 路由
# ────────────────────────────────────────────────────────────────
class TestModeDispatcher(unittest.TestCase):
    """_worker(mode='v1'|'v2'|invalid) 行为."""

    def test_dispatcher_routes_v2_to_worker_v2(self):
        """mode='v2' → _worker_v2 调用, _worker_v1 不调用."""
        seen = {}

        def fake_v2(*args, **kwargs):
            seen["who"] = "v2"
            seen["args"] = args

        with mock.patch.object(pipeline_runner, "_worker_v2", side_effect=fake_v2), \
             mock.patch.object(pipeline_runner, "_worker_v1") as v1:
            pipeline_runner._worker(
                "tid", "txt", "img", "title", "ds", "gpt", mode="v2",
            )
            v1.assert_not_called()
        self.assertEqual(seen.get("who"), "v2")
        # _worker_v2 收到 6 个位置参数 (不含 mode)
        self.assertEqual(seen["args"][0], "tid")

    def test_dispatcher_default_routes_v1(self):
        """不传 mode → 默认 'v1' → _worker_v1 调用 (兼容直调 _worker 的老测试)."""
        seen = {}

        def fake_v1(*args, **kwargs):
            seen["who"] = "v1"

        with mock.patch.object(pipeline_runner, "_worker_v1", side_effect=fake_v1), \
             mock.patch.object(pipeline_runner, "_worker_v2") as v2:
            pipeline_runner._worker(
                "tid", "txt", "img", "title", "ds", "gpt",
            )
            v2.assert_not_called()
        self.assertEqual(seen.get("who"), "v1")

    def test_dispatcher_invalid_mode_sets_failed_state(self):
        """无效 mode → _set(status='failed', error=...) + 不调任何 worker."""
        seen = {}

        def fake_set(task_id, **kwargs):
            seen.update(kwargs)

        with mock.patch.object(pipeline_runner, "_set", side_effect=fake_set), \
             mock.patch.object(pipeline_runner, "_worker_v1") as v1, \
             mock.patch.object(pipeline_runner, "_worker_v2") as v2:
            pipeline_runner._worker(
                "tid", "txt", "img", "title", "ds", "gpt", mode="v3",
            )
            v1.assert_not_called()
            v2.assert_not_called()
        self.assertEqual(seen.get("status"), "failed")
        self.assertIn("v3", seen.get("error", ""))

    def test_start_task_invalid_mode_raises(self):
        """start_task(mode='invalid') → ValueError 在线程启动前."""
        with self.assertRaises(ValueError) as ctx:
            pipeline_runner.start_task(
                product_text="x", product_image_url="p",
                product_title="t",
                deepseek_key="ds", gpt_image_key="gpt",
                mode="invalid",
            )
        self.assertIn("v1", str(ctx.exception))
        self.assertIn("v2", str(ctx.exception))


# ────────────────────────────────────────────────────────────────
# B. _run_real_generator_v2: 4 刀 A/B/D guard
# ────────────────────────────────────────────────────────────────
def _fake_v2_result(n: int):
    """造一个 generate_v2() 返回的 GenerationResult."""
    from ai_refine_v2.refine_generator import BlockResult, GenerationResult
    roles = ["hero", "feature_wall", "scenario", "vs_compare", "spec_table",
             "brand_quality", "value_story", "detail_zoom"]
    brs = [
        BlockResult(
            block_id=f"screen_{i:02d}_{roles[(i-1) % len(roles)]}",
            visual_type=roles[(i-1) % len(roles)],
            prompt=f"(fake v2 prompt for screen {i}) " + ("p" * 200),
            image_url=f"https://apimart.test/cdn/v2_screen_{i}.jpg",
            error=None,
            placeholder=False,
        )
        for i in range(1, n + 1)
    ]
    return GenerationResult(
        blocks=brs, hero_success=True,
        total_cost_rmb=round(n * 0.70, 2),
        total_elapsed_s=1.0,
    )


def _fake_generate_v2_factory(result):
    """造一个 fake refine_generator.generate_v2() 函数, 顺带触 progress 回调."""
    def _inner(**kw):
        cb = kw.get("api_call_fn")
        screens = kw["planning_v2"].get("screens") or []
        if cb:
            for _ in screens:
                cb("prompt", None, "k", "medium", "3:4")
        return result
    return _inner


def _planning_v2_for_n(n: int) -> dict:
    """造一个最小合规 v2 planning (n 屏)."""
    return {
        "screens": [
            {
                "idx": i,
                "role": ["hero", "feature_wall", "scenario", "vs_compare",
                         "spec_table", "brand_quality"][(i-1) % 6],
                "title": f"屏 {i}",
                "prompt": "p" * 250,
            }
            for i in range(1, n + 1)
        ],
    }


class TestV2RunRealGeneratorGuards(unittest.TestCase):
    """_run_real_generator_v2 的 4 刀 A/B/D 复用验证."""

    def setUp(self):
        self.src = (_REPO / "ai_refine_v2" / "pipeline_runner.py").read_text(encoding="utf-8")

    def test_v2_a_guard_uses_noproxy_opener_in_source(self):
        """A 刀 (源码 grep): _run_real_generator_v2 必须用 _build_noproxy_opener."""
        v2_section = self.src.split("def _run_real_generator_v2")[1].split("\ndef ")[0]
        self.assertIn(
            "_build_noproxy_opener", v2_section,
            "_run_real_generator_v2 必须复用 v1 的绕代理 opener (A 刀)",
        )
        self.assertIn(
            "_download_image", v2_section,
            "_run_real_generator_v2 必须用 _download_image (绕代理 + 重试)",
        )

    def test_v2_b_guard_download_failure_raises(self):
        """B 刀: 下载全失败 → RuntimeError 含 'v2 下载'."""
        fake_result = _fake_v2_result(n=3)
        planning = _planning_v2_for_n(3)

        class _StubOpener:
            def open(self, url, timeout=None):
                raise ConnectionError("mock dns fail")

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_v2_b"
            with mock.patch.object(
                pipeline_runner, "_build_noproxy_opener", return_value=_StubOpener(),
            ), mock.patch(
                "ai_refine_v2.refine_generator.generate_v2",
                side_effect=_fake_generate_v2_factory(fake_result),
            ), mock.patch(
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    pipeline_runner._run_real_generator_v2(
                        planning_v2=planning,
                        product_image_url="p",
                        gpt_image_key="fake",
                        task_dir=task_dir,
                        progress_cb=lambda p, m: None,
                    )
        self.assertIn("v2 下载", str(ctx.exception))
        self.assertIn("3/3", str(ctx.exception))

    def test_v2_d_guard_raw_url_preserved(self):
        """D 刀: 下载成功后 blocks[i].raw_url 保留 APIMart 原始 URL."""
        fake_result = _fake_v2_result(n=3)
        planning = _planning_v2_for_n(3)

        class _OkOpener:
            def open(self, url, timeout=None):
                return _FakeResp(url)

        class _FakeResp:
            def __init__(self, url): self._url = url
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self):
                # > 1KB payload, 让 _download_image 的 size guard 通过
                return b"\x89PNG\r\n" + (b"\0" * 2048)

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_v2_d"
            with mock.patch.object(
                pipeline_runner, "_build_noproxy_opener", return_value=_OkOpener(),
            ), mock.patch(
                "ai_refine_v2.refine_generator.generate_v2",
                side_effect=_fake_generate_v2_factory(fake_result),
            ), mock.patch(
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ):
                blocks, cost = pipeline_runner._run_real_generator_v2(
                    planning_v2=planning,
                    product_image_url="p",
                    gpt_image_key="fake",
                    task_dir=task_dir,
                    progress_cb=lambda p, m: None,
                )

        expected_raw = [
            "https://apimart.test/cdn/v2_screen_1.jpg",
            "https://apimart.test/cdn/v2_screen_2.jpg",
            "https://apimart.test/cdn/v2_screen_3.jpg",
        ]
        self.assertEqual([b["raw_url"] for b in blocks], expected_raw)
        self.assertTrue(all(b["success"] for b in blocks))
        self.assertFalse(any(b["placeholder"] for b in blocks))
        # 第 1 屏 (idx 0) is_hero
        self.assertTrue(blocks[0]["is_hero"])
        for b in blocks[1:]:
            self.assertFalse(b["is_hero"])


# ────────────────────────────────────────────────────────────────
# C. _run_assembler_v2: 4 刀 E (size guard) PIL stub 拼接
# ────────────────────────────────────────────────────────────────
class TestV2AssemblerSizeGuard(unittest.TestCase):
    """_run_assembler_v2 的 PIL 拼接 + E 刀."""

    def test_v2_assembler_no_successful_blocks_raises(self):
        """没有任何成功 block → raise (反向 E 刀, 0 张图也算 fail)."""
        with tempfile.TemporaryDirectory() as td:
            blocks = [
                {"block_id": "x", "file": "non_existent.jpg", "success": False},
            ]
            with self.assertRaises(RuntimeError) as ctx:
                pipeline_runner._run_assembler_v2(Path(td), blocks)
            self.assertIn("无可用 block 图", str(ctx.exception))

    def test_v2_assembler_normal_concat_passes_size_guard(self):
        """正常拼接 N 张真 PNG → assembled.png > 100KB, E 刀通过.

        用 random noise 而非单色, 否则 PNG 高效压缩单色 → 几 KB 触发 E 刀
        (单色 400×400 PNG ≈ 1KB, 跟生产真出图的 1-3MB 完全不同).
        """
        from PIL import Image
        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td)
            blocks = []
            # 3 张 400×400 random noise PNG, 拼出 400×1200 → 模拟真 AI 图压缩特性
            for i in range(1, 4):
                fn = f"block_{i:02d}.jpg"
                noise_bytes = os.urandom(400 * 400 * 3)
                im = Image.frombytes("RGB", (400, 400), noise_bytes)
                im.save(task_dir / fn, "PNG")
                blocks.append({
                    "block_id": f"screen_{i:02d}_test",
                    "file": fn,
                    "success": True,
                })
            url = pipeline_runner._run_assembler_v2(task_dir, blocks)
            self.assertIn("assembled.png", url)
            assembled = task_dir / "assembled.png"
            self.assertTrue(assembled.is_file())
            self.assertGreater(assembled.stat().st_size, 100_000,
                               "正常拼接结果应 > 100KB, E 刀阈值")

    def test_v2_assembler_e_guard_triggers_on_tiny_concat(self):
        """1×1 单色 PNG 拼接 → 太小 → E 刀 raise '太小'."""
        from PIL import Image
        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td)
            fn = "block_01.jpg"
            im = Image.new("RGB", (1, 1), (255, 255, 255))
            im.save(task_dir / fn, "PNG")
            blocks = [{
                "block_id": "screen_01_test",
                "file": fn,
                "success": True,
            }]
            with self.assertRaises(RuntimeError) as ctx:
                pipeline_runner._run_assembler_v2(task_dir, blocks)
            self.assertIn("太小", str(ctx.exception),
                          "1×1 PNG 拼接结果应 < 100KB, E 刀触发")


# ────────────────────────────────────────────────────────────────
# D. v2 mock helpers + 端到端 mock 模式
# ────────────────────────────────────────────────────────────────
class TestV2MockMode(unittest.TestCase):
    """v2 mock 模式: 缺 key 时仍能跑通 (PRD §阶段二·任务 2.2 硬要求).

    [auto-routine 2026-05-11] _MOCK_IMAGES_DIR 指向 static/smoke_output_v2/,
    那目录被 .gitignore (47:smoke_output_v2/), CI/沙箱里没有 → 测试只在本机
    跑过过 demo 时才绿. 这里 setUp 显式造 6 张 600×600 合成 JPG 灌进 tmpdir
    并 patch _MOCK_IMAGES_DIR, 让测试自闭包, 任何 clean checkout 都能跑.
    """

    def setUp(self):
        import os as _os
        from PIL import Image
        self._mock_dir = tempfile.mkdtemp(prefix="v2_mock_imgs_")
        # 6 张占位图够覆盖 6-10 屏 (n>6 时 _copy_mock_images_v2 循环复用).
        # 用随机噪声而不是纯色 — _run_assembler_v2 后 4 刀 E (size guard)
        # 要求 assembled.png > 100KB, 纯色合成图压缩后只剩 ~5KB 过不了关.
        for i in range(1, 7):
            noise = _os.urandom(900 * 900 * 3)
            img = Image.frombytes("RGB", (900, 900), noise)
            img.save(Path(self._mock_dir) / f"block_{i:02d}.jpg", "JPEG", quality=85)
        self._patcher = mock.patch.object(
            pipeline_runner, "_MOCK_IMAGES_DIR", Path(self._mock_dir),
        )
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()
        import shutil
        shutil.rmtree(self._mock_dir, ignore_errors=True)

    def test_load_mock_planning_v2_returns_valid_v2_schema(self):
        """_load_mock_planning_v2 输出必须满足 _validate_schema_v2 (零 warning)."""
        from ai_refine_v2.refine_planner import _validate_schema_v2
        planning = pipeline_runner._load_mock_planning_v2("test text", "MyProduct")
        warnings = _validate_schema_v2(planning)
        self.assertEqual(warnings, [],
                         f"v2 mock planning 不合规 schema_v2: {warnings}")
        self.assertEqual(planning["product_meta"]["name"], "MyProduct")
        # v3 (PRD AI_refine_v3.1): 6 → 8 屏 (含必出 3 屏)
        self.assertEqual(planning["screen_count"], 8)
        self.assertEqual(len(planning["screens"]), 8)

    def test_copy_mock_images_v2_uses_v2_block_id_format(self):
        """_copy_mock_images_v2 返回 v2 风格 blocks (block_id 'screen_NN_role')."""
        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_v2_mock"
            blocks = pipeline_runner._copy_mock_images_v2(task_dir, n=8)
        self.assertEqual(len(blocks), 8)
        for b in blocks:
            self.assertTrue(b["block_id"].startswith("screen_"),
                            f"v2 block_id 应以 screen_ 开头, 实际 {b['block_id']}")
            self.assertTrue(b["placeholder"], "mock 图必须 placeholder=True")
            self.assertEqual(b["raw_url"], "", "mock 图无 APIMart 原始 URL")
        self.assertTrue(blocks[0]["is_hero"])
        self.assertIn("hero", blocks[0]["block_id"])

    def test_worker_v2_full_mock_end_to_end(self):
        """缺 deepseek + gpt key → _worker_v2 走全 mock 路径, status=success."""
        task_id = f"test_v2_e2e_{uuid.uuid4().hex[:6]}"
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(task_id=task_id)

        try:
            with tempfile.TemporaryDirectory() as td:
                with mock.patch.object(pipeline_runner, "_OUTPUT_BASE", Path(td)):
                    pipeline_runner._worker_v2(
                        task_id=task_id,
                        product_text="x",
                        product_image_url="p",
                        product_title="MockTest",
                        deepseek_key="",     # → mock planning_v2
                        gpt_image_key="",    # → mock images_v2
                    )
                state = pipeline_runner._TASKS[task_id]
                self.assertEqual(state.status, "success",
                                 f"应 success, 实际 {state.status}; error={state.error}")
                # v3 (PRD AI_refine_v3.1): mock screen_count 6 → 8
                self.assertEqual(state.planning.get("screen_count"), 8)
                self.assertEqual(len(state.blocks), 8)
                self.assertTrue(all(b.get("placeholder") for b in state.blocks),
                                "全 mock 模式下所有 blocks 应 placeholder=True")
                self.assertEqual(state.cost_rmb, 0.0, "mock 模式下 cost=0")
                # assembled.png 真存在
                assembled = Path(td) / task_id / "assembled.png"
                self.assertTrue(assembled.is_file(),
                                f"v2 assembled.png 应存在: {assembled}")
                self.assertGreater(assembled.stat().st_size, 100_000,
                                   "v2 mock 拼接结果应通过 E 刀阈值")
        finally:
            pipeline_runner._TASKS.pop(task_id, None)


# ────────────────────────────────────────────────────────────────
# E. 安全阀对 v2 mode 同样生效 (V2_ALLOW_REAL_API)
# ────────────────────────────────────────────────────────────────
class TestSafetyValveCoversV2(unittest.TestCase):
    """V2_ALLOW_REAL_API 关 + mode='v2' + 真 keys → keys 仍被清, 走 mock."""

    def setUp(self):
        self._saved = os.environ.pop("V2_ALLOW_REAL_API", None)
        self._saved_flask_env = os.environ.get("FLASK_ENV")
        os.environ["FLASK_ENV"] = "development"

    def tearDown(self):
        if self._saved is not None:
            os.environ["V2_ALLOW_REAL_API"] = self._saved
        else:
            os.environ.pop("V2_ALLOW_REAL_API", None)
        if self._saved_flask_env is not None:
            os.environ["FLASK_ENV"] = self._saved_flask_env
        else:
            os.environ.pop("FLASK_ENV", None)

    def test_safety_valve_locked_strips_keys_for_v2_mode(self):
        """安全阀关 → start_task(mode='v2') 也清空 keys, mode='v2' 透传."""
        os.environ.pop("V2_ALLOW_REAL_API", None)
        seen: dict = {}

        def _capture(task_id, product_text, product_image_url,
                     product_title, deepseek_key, gpt_image_key, mode="v1", **_kwargs):
            seen["ds"] = deepseek_key
            seen["gpt"] = gpt_image_key
            seen["mode"] = mode

        with mock.patch.object(pipeline_runner, "_worker", side_effect=_capture):
            tid = pipeline_runner.start_task(
                product_text="x", product_image_url="p",
                product_title="t",
                deepseek_key="real_ds_key",
                gpt_image_key="real_gpt_key",
                mode="v2",  # 即便显式 v2
            )
            for _ in range(200):
                if "ds" in seen:
                    break
                _time.sleep(0.005)
        pipeline_runner._TASKS.pop(tid, None)

        self.assertIn("ds", seen)
        self.assertEqual(seen["ds"], "",
                         "v2 mode 下安全阀仍应清空 deepseek_key (UI 误点防线)")
        self.assertEqual(seen["gpt"], "",
                         "v2 mode 下安全阀仍应清空 gpt_image_key")
        self.assertEqual(seen["mode"], "v2",
                         "mode='v2' 应透传给 _worker, 不被安全阀改")


if __name__ == "__main__":
    unittest.main()
