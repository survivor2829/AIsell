"""Mock 覆盖 pipeline_runner 的下载 / 校验 / 救图链路.

验证 2026-04-24 第一刀修复:
  A 下载绕代理 (静态 grep 源码确认用 ProxyHandler({}))
  B 下载失败重试耗尽 → RuntimeError, pipeline 走 failed
  D raw_url 保留到 blocks[*] + TaskState.raw_urls + _summary.json
  E assembled.png < 100KB → _validate_assembled_png raise

全程无真 API 调用 (APIMart / DeepSeek / Playwright 都 mock).
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
from ai_refine_v2.refine_generator import BlockResult, GenerationResult

def _fake_generation_result(n: int = 3) -> GenerationResult:
    """n 个 block, image_url 带 APIMart 前缀便于断言."""
    ids = ["hero"] + [f"selling_point_{i}" for i in range(1, n)]
    brs = [
        BlockResult(
            block_id=bid,
            visual_type="product_in_scene",
            prompt=f"(fake) {bid}",
            image_url=f"https://apimart.test/cdn/{bid}.jpg",
            error=None,
            placeholder=False,
        )
        for bid in ids
    ]
    return GenerationResult(
        blocks=brs, hero_success=True,
        total_cost_rmb=round(n * 0.70, 2),
        total_elapsed_s=1.0,
    )


def _fake_generate(result: GenerationResult):
    """返回一个 fake refine_generator.generate(), 并顺带调 progress 回调."""
    def _inner(**kw):
        cb = kw.get("api_call_fn")
        planning = kw.get("planning", {})
        order = (planning.get("planning") or {}).get("block_order") or []
        if cb:
            for _ in order:
                cb("prompt", None, "k", "medium", "1:1")
        return result
    return _inner


# ────────────────────────────────────────────────────────────────
# B: 下载失败 → RuntimeError, 不再 placeholder 静默
# ────────────────────────────────────────────────────────────────
class TestDownloadFailureRaises(unittest.TestCase):
    """付费结果下载失败必须进入 recovery_required。"""

    def test_run_real_generator_bubbles_download_error(self):
        fake_result = _fake_generation_result(n=3)
        planning = {
            "planning": {
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "total_blocks": 3,
            },
        }

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_b"
            with mock.patch.object(
                pipeline_runner, "_download_image",
                side_effect=ConnectionError("mock dns fail"),
            ), mock.patch(
                "ai_refine_v2.refine_generator.generate",
                side_effect=_fake_generate(fake_result),
            ), mock.patch(
                # _fake_generate 会把 cb 调回来, 里面会穿透到 _default_api_call;
                # 不 mock 它就会撞真 APIMart 401. 这里塞个假 URL 即可.
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    pipeline_runner._run_real_generator(
                        planning=planning,
                        product_image_url="p",
                        gpt_image_key="fake",
                        task_dir=task_dir,
                        progress_cb=lambda p, m: None,
                    )
        msg = str(ctx.exception)
        self.assertIn("下载", msg)
        self.assertIn("3/3", msg)  # 3 张全挂
        self.assertTrue(
            getattr(ctx.exception, "recovery_required", False),
            "付费结果 URL 已返回后，本地下载失败必须进入可恢复状态，不能是普通 failed",
        )

    def test_run_real_generator_rejects_non_image_download(self):
        """HTTP 下载成功不等于图片成功；HTML/损坏内容必须进入恢复态。"""
        fake_result = _fake_generation_result(n=1)
        planning = {
            "planning": {"block_order": ["hero"], "total_blocks": 1},
        }

        def fake_download(_url, destination, **_kwargs):
            destination.write_bytes(b"<html>provider error</html>" + (b"x" * 2048))
            return "system"

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_invalid_image"
            with mock.patch.object(
                pipeline_runner, "_download_image", side_effect=fake_download,
            ), mock.patch(
                "ai_refine_v2.refine_generator.generate",
                side_effect=_fake_generate(fake_result),
            ), mock.patch(
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    pipeline_runner._run_real_generator(
                        planning=planning,
                        product_image_url="p",
                        gpt_image_key="fake",
                        task_dir=task_dir,
                        progress_cb=lambda _p, _m: None,
                    )

            recovery = json.loads(
                (task_dir / "_recovery.json").read_text(encoding="utf-8")
            )

        self.assertTrue(getattr(ctx.exception, "recovery_required", False))
        self.assertIn("无法解码", str(ctx.exception))
        self.assertEqual(recovery["status"], "recovery_required")
        self.assertFalse(recovery["blocks"][0]["success"])


class TestProviderResultDownloadRoute(unittest.TestCase):
    """CDN 下载沿用 APIMart submit/poll 已验证路由，且不产生新提交。"""

    def test_default_api_call_remembers_route_for_result_url(self):
        import ai_image_apimart as adapter

        with mock.patch.object(
            adapter, "_submit_image_task_for_route", return_value=("task-1", True),
        ), mock.patch.object(
            adapter, "poll_image_task", return_value="https://cdn.invalid/result.png",
        ):
            url = adapter.default_api_call("prompt", None, "secret")

        self.assertEqual(adapter.get_result_route(url), "direct")

    def test_download_result_uses_remembered_route_without_resubmit(self):
        import ai_image_apimart as adapter

        calls = []

        class _Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return b"\x89PNG\r\n" + (b"x" * 2048)

        def fake_open(_request, *, timeout, direct=False):
            calls.append((timeout, direct))
            return _Response()

        with tempfile.TemporaryDirectory() as td, mock.patch.object(
            adapter, "_open_apimart", side_effect=fake_open,
        ), mock.patch.object(adapter, "_http_post_json") as submit:
            dst = Path(td) / "result.png"
            selected = adapter.download_result_image(
                "https://cdn.invalid/result.png",
                dst,
                preferred_route="direct",
                retries=0,
            )

        self.assertEqual(selected, "direct")
        self.assertEqual(calls, [(60, True)])
        submit.assert_not_called()


class TestProviderCheckpointAndRecovery(unittest.TestCase):
    def test_restart_preserves_outcome_unknown_with_completed_url_and_provider_task(self):
        task_id = f"unknown_{uuid.uuid4().hex[:8]}"
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(
            task_id=task_id, user_id=7, mode="real",
        )
        try:
            with tempfile.TemporaryDirectory() as td, mock.patch.object(
                pipeline_runner, "_OUTPUT_BASE", Path(td),
            ):
                task_dir = Path(td) / task_id
                pipeline_runner._persist_recovery(
                    task_dir,
                    [
                        {
                            "block_id": "hero",
                            "file": "block_01_hero.jpg",
                            "raw_url": "https://cdn.invalid/hero.png",
                            "provider_task_id": "provider-hero",
                            "success": False,
                            "placeholder": False,
                        },
                        {
                            "block_id": "selling_point_1",
                            "file": "block_02_sp.jpg",
                            "raw_url": "",
                            "provider_task_id": "provider-unknown",
                            "success": False,
                            "placeholder": False,
                        },
                    ],
                    0.7,
                    2,
                    status="outcome_unknown",
                    error="synthetic poll timeout",
                    schema_mode="v1",
                )
                pipeline_runner._TASKS.pop(task_id, None)

                restored = pipeline_runner.get_task_status(task_id)

            self.assertIsNotNone(restored)
            self.assertEqual(restored["status"], "outcome_unknown")
            self.assertEqual(restored["raw_urls"], ["https://cdn.invalid/hero.png", ""])
            self.assertEqual(
                restored["blocks"][1]["provider_task_id"], "provider-unknown",
            )
        finally:
            pipeline_runner._TASKS.pop(task_id, None)

    def test_nonbillable_recovery_polls_known_task_and_never_submits(self):
        import ai_image_apimart as adapter
        from PIL import Image

        task_id = f"recover_{uuid.uuid4().hex[:8]}"
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(
            task_id=task_id, user_id=9, mode="real", status="outcome_unknown",
        )
        try:
            with tempfile.TemporaryDirectory() as td, mock.patch.object(
                pipeline_runner, "_OUTPUT_BASE", Path(td),
            ):
                task_dir = Path(td) / task_id
                task_dir.mkdir(parents=True)
                (task_dir / "_planning.json").write_text(
                    json.dumps({"product_meta": {"name": "T"}, "screens": [{}, {}, {}]}),
                    encoding="utf-8",
                )
                pipeline_runner._persist_recovery(
                    task_dir,
                    [
                        {
                            "block_id": "screen_01_hero", "visual_type": "hero",
                            "is_hero": True, "file": "block_01_hero.jpg",
                            "image_url": f"/static/ai_refine_v2/{task_id}/block_01_hero.jpg",
                            "raw_url": "https://cdn.invalid/hero.png",
                            "provider_task_id": "provider-hero",
                            "download_route": "system", "success": False,
                            "placeholder": False, "error": "",
                        },
                        {
                            "block_id": "screen_02_feature", "visual_type": "feature",
                            "is_hero": False, "file": "block_02_feature.jpg",
                            "image_url": f"/static/ai_refine_v2/{task_id}/block_02_feature.jpg",
                            "raw_url": "", "provider_task_id": "provider-feature",
                            "download_route": "direct", "success": False,
                            "placeholder": False, "error": "",
                        },
                        {
                            "block_id": "screen_03_cancelled", "visual_type": "feature",
                            "is_hero": False, "file": "block_03_cancelled.jpg",
                            "image_url": f"/static/ai_refine_v2/{task_id}/block_03_cancelled.jpg",
                            "raw_url": "", "provider_task_id": "",
                            "provider_status": "cancelled",
                            "download_route": "unknown", "success": False,
                            "placeholder": False, "error": "",
                        },
                    ],
                    1.4,
                    3,
                    status="outcome_unknown",
                    schema_mode="v2",
                )

                def fake_download(_url, destination, **_kwargs):
                    Image.new("RGB", (400, 400), (30, 60, 90)).save(destination, "JPEG")
                    return "system"

                def fake_assemble(directory, _blocks):
                    image = Image.frombytes(
                        "RGB", (400, 800), os.urandom(400 * 800 * 3),
                    )
                    image.save(directory / "assembled.png", "PNG")
                    return f"/static/ai_refine_v2/{task_id}/assembled.png"

                with mock.patch.object(
                    adapter, "poll_image_task",
                    return_value="https://cdn.invalid/feature.png",
                ) as poll, mock.patch.object(
                    pipeline_runner, "_download_image", side_effect=fake_download,
                ), mock.patch.object(
                    pipeline_runner, "_run_assembler_v2", side_effect=fake_assemble,
                ), mock.patch.object(
                    adapter, "default_api_call",
                    side_effect=AssertionError("recovery must not generate"),
                ) as generate, mock.patch.object(
                    adapter, "submit_image_task",
                    side_effect=AssertionError("recovery must not submit"),
                ) as submit:
                    recovered = pipeline_runner._recover_task(task_id, "secret")

                self.assertEqual(recovered["status"], "partial_success")
                self.assertEqual(recovered["failed_count"], 1)
                poll.assert_called_once_with(
                    "provider-feature", "secret", direct=True,
                )
                generate.assert_not_called()
                submit.assert_not_called()
                checkpoint = json.loads(
                    (task_dir / "_recovery.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    checkpoint["blocks"][1]["raw_url"],
                    "https://cdn.invalid/feature.png",
                )
                self.assertTrue((task_dir / "_summary.json").is_file())
        finally:
            pipeline_runner._TASKS.pop(task_id, None)


# ────────────────────────────────────────────────────────────────
# D: raw_url 保留 (blocks dict + TaskState + _summary.json)
# ────────────────────────────────────────────────────────────────
class TestRawUrlsPreserved(unittest.TestCase):
    """D 验证: 下载成功后 blocks[*].raw_url 保留, _worker 写入 state + summary.json."""

    def test_run_real_generator_preserves_raw_url(self):
        fake_result = _fake_generation_result(n=3)
        planning = {
            "planning": {
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "total_blocks": 3,
            },
        }

        def _fake_download(_url, dst, **_kwargs):
            from PIL import Image

            Image.frombytes(
                "RGB", (64, 64), os.urandom(64 * 64 * 3),
            ).save(dst, "JPEG", quality=95)
            return "direct"

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_d"
            with mock.patch.object(
                pipeline_runner, "_download_image", side_effect=_fake_download,
            ), mock.patch(
                "ai_refine_v2.refine_generator.generate",
                side_effect=_fake_generate(fake_result),
            ), mock.patch(
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ):
                blocks, cost = pipeline_runner._run_real_generator(
                    planning=planning,
                    product_image_url="p",
                    gpt_image_key="fake",
                    task_dir=task_dir,
                    progress_cb=lambda p, m: None,
                )

        expected = [
            "https://apimart.test/cdn/hero.jpg",
            "https://apimart.test/cdn/selling_point_1.jpg",
            "https://apimart.test/cdn/selling_point_2.jpg",
        ]
        self.assertEqual([b["raw_url"] for b in blocks], expected)
        for b in blocks:
            self.assertTrue(b["success"])
            self.assertFalse(b["placeholder"])

    def test_all_raw_urls_are_atomically_checkpointed_before_first_download(self):
        """拿到 provider 结果后，必须先一次性落盘，再开始任何 CDN 下载。"""
        fake_result = _fake_generation_result(n=3)
        planning = {
            "planning": {
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "total_blocks": 3,
            },
        }

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_checkpoint"

            def assert_checkpoint_then_download(_url, dst, **_kwargs):
                from PIL import Image

                recovery_path = task_dir / "_recovery.json"
                self.assertTrue(recovery_path.is_file())
                recovery = json.loads(recovery_path.read_text(encoding="utf-8"))
                self.assertEqual(len(recovery["raw_urls"]), 3)
                self.assertTrue(all(recovery["raw_urls"]))
                Image.frombytes(
                    "RGB", (64, 64), os.urandom(64 * 64 * 3),
                ).save(dst, "JPEG", quality=95)

            with mock.patch(
                "ai_refine_v2.refine_generator.generate",
                side_effect=_fake_generate(fake_result),
            ), mock.patch(
                "ai_refine_v2.refine_generator._default_api_call",
                return_value="https://apimart.test/mocked.jpg",
            ), mock.patch.object(
                pipeline_runner, "_download_image",
                side_effect=assert_checkpoint_then_download,
            ):
                blocks, _cost = pipeline_runner._run_real_generator(
                    planning=planning,
                    product_image_url="p",
                    gpt_image_key="fake",
                    task_dir=task_dir,
                    progress_cb=lambda p, m: None,
                )

            recovery = json.loads(
                (task_dir / "_recovery.json").read_text(encoding="utf-8")
            )
            self.assertEqual(recovery["status"], "ready_for_assembly")
            self.assertEqual(recovery["success_count"], 3)
            self.assertEqual(recovery["failed_count"], 0)
            self.assertEqual(len(blocks), 3)

    def test_worker_writes_raw_urls_to_state_and_summary(self):
        """端到端 _worker: 断言 TaskState.raw_urls + _summary.json 都有完整 URL 列表."""
        task_id = f"test_d_{uuid.uuid4().hex[:6]}"
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(task_id=task_id)

        fake_blocks = [
            {"block_id": "hero", "visual_type": "product_in_scene", "is_hero": True,
             "file": "block_01_hero.jpg",
             "image_url": "/static/ai_refine_v2/x/block_01_hero.jpg",
             "raw_url": "https://apimart.test/cdn/hero.jpg",
             "success": True, "placeholder": False},
            {"block_id": "selling_point_1", "visual_type": "product_closeup", "is_hero": False,
             "file": "block_02_sp1.jpg",
             "image_url": "/static/ai_refine_v2/x/block_02_sp1.jpg",
             "raw_url": "https://apimart.test/cdn/sp1.jpg",
             "success": True, "placeholder": False},
        ]
        fake_planning = {
            "product_meta": {"name": "测试机"},
            "planning": {"block_order": ["hero", "selling_point_1"], "total_blocks": 2},
        }

        def _fake_assembler(task_dir, _blocks, _product_meta):
            from PIL import Image

            image = Image.frombytes(
                "RGB", (400, 800), os.urandom(400 * 800 * 3),
            )
            image.save(task_dir / "assembled.png", "PNG")
            return f"/static/ai_refine_v2/{task_dir.name}/assembled.png"

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(pipeline_runner, "_OUTPUT_BASE", Path(td)), \
                 mock.patch.object(pipeline_runner, "_load_mock_planning", return_value=fake_planning), \
                  mock.patch.object(pipeline_runner, "_run_real_generator",
                                    return_value=(fake_blocks, 1.40)), \
                  mock.patch.object(pipeline_runner, "_run_assembler",
                                    side_effect=_fake_assembler):
                pipeline_runner._worker(
                    task_id=task_id,
                    product_text="x",
                    product_image_url="p",
                    product_title="测试机",
                    deepseek_key="",     # → mock planning 路径
                    gpt_image_key="fake",  # → _run_real_generator
                )

            state = pipeline_runner._TASKS[task_id]
            self.assertEqual(state.status, "success")
            self.assertEqual(state.raw_urls, [
                "https://apimart.test/cdn/hero.jpg",
                "https://apimart.test/cdn/sp1.jpg",
            ])

            # _summary.json 在 _OUTPUT_BASE / task_id
            summary_path = Path(td) / task_id / "_summary.json"
            self.assertTrue(summary_path.exists(),
                            f"_summary.json 应存在于 {summary_path}")
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertIn("raw_urls", summary)
            self.assertEqual(summary["raw_urls"], [
                "https://apimart.test/cdn/hero.jpg",
                "https://apimart.test/cdn/sp1.jpg",
            ])
        # 清场: 删测试 TaskState
        pipeline_runner._TASKS.pop(task_id, None)


# ────────────────────────────────────────────────────────────────
# E: assembled.png 体积 guard
# ────────────────────────────────────────────────────────────────
class TestAssembledSizeGuard(unittest.TestCase):
    """E 验证: _validate_assembled_png 小于阈值 → raise; 足够大 → 通过."""

    def test_tiny_png_raises(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "tiny.png"
            # 11841 字节就是 2026-04-24 那张纯白 PNG 的实际大小
            p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 11000)
            with self.assertRaises(RuntimeError) as ctx:
                pipeline_runner._validate_assembled_png(p)
            self.assertIn("太小", str(ctx.exception))

    def test_missing_png_raises(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(RuntimeError) as ctx:
                pipeline_runner._validate_assembled_png(Path(td) / "missing.png")
            self.assertIn("不存在", str(ctx.exception))

    def test_normal_png_passes(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ok.png"
            image = Image.frombytes(
                "RGB", (400, 400), os.urandom(400 * 400 * 3),
            )
            image.save(p, "PNG")
            pipeline_runner._validate_assembled_png(p)  # 不 raise 就 pass

    def test_assembled_png_raises_in_worker(self):
        """端到端: 付费结果拼装失败 → recovery_required 且无 summary."""
        task_id = f"test_e_{uuid.uuid4().hex[:6]}"
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(task_id=task_id)

        fake_blocks = [
            {"block_id": "hero", "visual_type": "product_in_scene", "is_hero": True,
             "file": "block_01_hero.jpg",
             "image_url": "/static/ai_refine_v2/x/block_01_hero.jpg",
             "raw_url": "https://apimart.test/cdn/hero.jpg",
             "success": True, "placeholder": False},
        ]
        fake_planning = {
            "product_meta": {"name": "T"},
            "planning": {"block_order": ["hero"], "total_blocks": 1},
        }

        def _real_assembler_but_tiny_png(task_dir, blocks, product_meta):
            """调真 _validate_assembled_png, 但 png 是 1KB 的假图."""
            out_png = task_dir / "assembled.png"
            out_png.write_bytes(b"\x89PNG" + b"\0" * 1000)
            pipeline_runner._validate_assembled_png(out_png)  # 应该 raise
            return "/x"

        def _fake_paid_generation(_planning, _image, _key, task_dir, _progress):
            pipeline_runner._persist_recovery(
                task_dir,
                fake_blocks,
                0.70,
                1,
                status="ready_for_assembly",
                schema_mode="v1",
            )
            return fake_blocks, 0.70

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(pipeline_runner, "_OUTPUT_BASE", Path(td)), \
                 mock.patch.object(pipeline_runner, "_load_mock_planning", return_value=fake_planning), \
                  mock.patch.object(pipeline_runner, "_run_real_generator",
                                    side_effect=_fake_paid_generation), \
                 mock.patch.object(pipeline_runner, "_run_assembler",
                                   side_effect=_real_assembler_but_tiny_png):
                pipeline_runner._worker(
                    task_id=task_id,
                    product_text="x", product_image_url="p",
                    product_title="T", deepseek_key="", gpt_image_key="fake",
                )

            state = pipeline_runner._TASKS[task_id]
            self.assertEqual(state.status, "recovery_required",
                             f"付费 checkpoint 存在时应可恢复, 实际 {state.status}; error={state.error}")
            self.assertIn("太小", state.error)
            self.assertFalse(
                (Path(td) / task_id / "_summary.json").exists(),
                "assembled.png 校验失败前不能留下会被磁盘 fallback 当成功的 summary",
            )
        pipeline_runner._TASKS.pop(task_id, None)


# ────────────────────────────────────────────────────────────────
# Safety Valve: V2_ALLOW_REAL_API (PRD §阶段五真测前的临时保护)
# ────────────────────────────────────────────────────────────────
class TestV2SafetyValve(unittest.TestCase):
    """临时安全阀: 防止 UI 误点烧钱 (生产 .env 里有真 key 也拦得住).

    机制:
      - 默认 / V2_ALLOW_REAL_API=false → _detect_mode 返 'mock',
        start_task 把 keys 清空后才传给 _worker (生产唯一入口都被卡住).
      - V2_ALLOW_REAL_API=true → 解锁, 真 key 透传.

    PRD §阶段五三关阶梯式真测通过后, 删除 _is_real_api_allowed /
    _apply_safety_valve / _detect_mode 顶部 safety 分支 / 此测试类即可.
    """

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

    # ── _detect_mode 闸门 ─────────────────────────────────────
    def test_unset_forces_mock_even_with_real_keys(self):
        """未设 V2_ALLOW_REAL_API + 真 key 齐 → 强制 mock"""
        os.environ.pop("V2_ALLOW_REAL_API", None)
        self.assertEqual(
            pipeline_runner._detect_mode("real_ds_key", "real_gpt_key"),
            "mock",
        )

    def test_production_default_allows_real_api(self):
        """生产环境不再被临时安全阀强制 mock."""
        os.environ["FLASK_ENV"] = "production"
        os.environ.pop("V2_ALLOW_REAL_API", None)

        self.assertEqual(
            pipeline_runner._detect_mode("real_ds_key", "real_gpt_key"),
            "real",
        )
        self.assertEqual(
            pipeline_runner._apply_safety_valve("real_ds_key", "real_gpt_key"),
            ("real_ds_key", "real_gpt_key"),
        )

    def test_explicit_false_forces_mock(self):
        os.environ["V2_ALLOW_REAL_API"] = "false"
        self.assertEqual(
            pipeline_runner._detect_mode("real_ds_key", "real_gpt_key"),
            "mock",
        )

    def test_true_unlocks_real_when_keys_present(self):
        os.environ["V2_ALLOW_REAL_API"] = "true"
        self.assertEqual(
            pipeline_runner._detect_mode("real_ds_key", "real_gpt_key"),
            "real",
        )

    def test_true_partial_keys_returns_partial_mock(self):
        """V2_ALLOW_REAL_API=true + 只有 gpt key → partial-mock"""
        os.environ["V2_ALLOW_REAL_API"] = "true"
        self.assertEqual(
            pipeline_runner._detect_mode("", "real_gpt_key"),
            "partial-mock",
        )

    def test_true_no_keys_returns_mock(self):
        """V2_ALLOW_REAL_API=true + 无 key → 仍 mock (与原逻辑一致)"""
        os.environ["V2_ALLOW_REAL_API"] = "true"
        self.assertEqual(pipeline_runner._detect_mode("", ""), "mock")

    def test_case_insensitive_true(self):
        for value in ("true", "TRUE", "True", "TrUe"):
            os.environ["V2_ALLOW_REAL_API"] = value
            self.assertEqual(
                pipeline_runner._detect_mode("real_ds", "real_gpt"),
                "real",
                f"V2_ALLOW_REAL_API={value!r} 应解锁",
            )

    # ── _apply_safety_valve 闸门 ──────────────────────────────
    def test_apply_safety_valve_clears_keys_when_locked(self):
        os.environ.pop("V2_ALLOW_REAL_API", None)
        self.assertEqual(
            pipeline_runner._apply_safety_valve("ds", "gpt"),
            ("", ""),
        )

    def test_apply_safety_valve_passes_through_when_unlocked(self):
        os.environ["V2_ALLOW_REAL_API"] = "true"
        self.assertEqual(
            pipeline_runner._apply_safety_valve("ds", "gpt"),
            ("ds", "gpt"),
        )

    # ── start_task 端到端: keys 在送进 _worker 前必须被清空 ────
    def test_start_task_strips_keys_when_safety_locked(self):
        """安全阀关 → start_task 调 _worker 时 keys 应已清空."""
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
                deepseek_key="real_ds_key", gpt_image_key="real_gpt_key",
            )
            for _ in range(200):  # 等 daemon thread 跑完 (mock 后 ~瞬间)
                if "ds" in seen:
                    break
                _time.sleep(0.005)
        pipeline_runner._TASKS.pop(tid, None)

        self.assertIn("ds", seen, "_worker 未被调用 (线程超时)")
        self.assertEqual(seen["ds"], "", "安全阀关时 deepseek_key 应被清空")
        self.assertEqual(seen["gpt"], "", "安全阀关时 gpt_image_key 应被清空")

    def test_start_task_passes_keys_when_unlocked(self):
        """V2_ALLOW_REAL_API=true → start_task 透传真 key 给 _worker."""
        os.environ["V2_ALLOW_REAL_API"] = "true"
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
                deepseek_key="real_ds_key", gpt_image_key="real_gpt_key",
            )
            for _ in range(200):
                if "ds" in seen:
                    break
                _time.sleep(0.005)
        pipeline_runner._TASKS.pop(tid, None)

        self.assertEqual(seen["ds"], "real_ds_key")
        self.assertEqual(seen["gpt"], "real_gpt_key")


if __name__ == "__main__":
    unittest.main()
