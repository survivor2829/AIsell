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

_REPO = Path(__file__).resolve().parents[2]


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
# A: 下载绕代理 (静态验证源码)
# ────────────────────────────────────────────────────────────────
class TestDownloadProxyBypass(unittest.TestCase):
    """A 验证: pipeline_runner 源码里下载路径必须用 ProxyHandler({}) 空代理 opener."""

    def setUp(self):
        self.src = (_REPO / "ai_refine_v2" / "pipeline_runner.py").read_text(encoding="utf-8")

    def test_source_uses_proxyhandler_empty(self):
        self.assertIn("ProxyHandler({})", self.src,
                      "下载路径必须 ProxyHandler({}) 显式空掉 env 代理")

    def test_source_uses_build_opener(self):
        self.assertIn("build_opener", self.src,
                      "下载必须通过 build_opener, 不能用默认 urlretrieve")

    def test_no_legacy_urlretrieve(self):
        # 老实现是 urllib.request.urlretrieve(br.image_url, ...), 会读 env 代理
        self.assertNotIn("urlretrieve(br.image_url", self.src,
                         "仍残留老的 urlretrieve 调用, 不会绕代理")

    def test_noproxy_opener_addheaders_contains_browser_user_agent(self):
        """A 刀延伸: opener 必须设浏览器 UA, 防 APIMart CDN 403.

        2026-04-27 stage5 step1 真测验证: urllib 默认 'Python-urllib/3.x' UA
        被 upload.apimart.ai 直接 403; curl -A Mozilla 试下来 200 OK.
        修法: _build_noproxy_opener 在 build_opener 后调 .addheaders 设 UA.
        """
        opener = pipeline_runner._build_noproxy_opener()
        headers = dict(opener.addheaders)
        self.assertIn("User-Agent", headers,
                      "opener 必须通过 addheaders 设 User-Agent (默认 UA 会被 CDN 挡)")
        ua = headers["User-Agent"]
        self.assertIn("Mozilla", ua, f"UA 必须像浏览器, 实际 {ua!r}")
        self.assertNotIn("Python-urllib", ua,
                         "UA 不能是 urllib 默认 'Python-urllib/3.x' (会被 APIMart CDN 403)")

    def test_source_documents_browser_ua_rationale(self):
        """A 刀延伸: 源码注释必须解释 UA 选择 (防未来误删 addheaders 那行).

        Mozilla / CDN 关键词同时出现 = 注释里说清楚了"为啥要 UA + 不设会被 CDN 挡".
        """
        self.assertIn("Mozilla", self.src,
                      "_build_noproxy_opener 源码应含 Mozilla UA 字符串")
        self.assertIn("CDN", self.src,
                      "源码注释应解释 'CDN 拒绝 urllib 默认 UA' 用意")


# ────────────────────────────────────────────────────────────────
# B: 下载失败 → RuntimeError, 不再 placeholder 静默
# ────────────────────────────────────────────────────────────────
class TestDownloadFailureRaises(unittest.TestCase):
    """B 验证: _download_image 重试耗尽 raise; _run_real_generator 再汇总 raise."""

    def test_download_image_retries_then_raises(self):
        calls = {"n": 0}

        class _StubOpener:
            def open(self, url, timeout=None):
                calls["n"] += 1
                raise ConnectionError("ECONNREFUSED (mock)")

        with tempfile.TemporaryDirectory() as td:
            dst = Path(td) / "x.jpg"
            with self.assertRaises(RuntimeError) as ctx:
                pipeline_runner._download_image(
                    "https://apimart.test/x.jpg", dst,
                    retries=2, opener=_StubOpener(),
                )
        self.assertIn("下载失败", str(ctx.exception))
        # retries=2 → 1 + 2 次重试 = 3 次调用
        self.assertEqual(calls["n"], 3)

    def test_run_real_generator_bubbles_download_error(self):
        fake_result = _fake_generation_result(n=3)
        planning = {
            "planning": {
                "block_order": ["hero", "selling_point_1", "selling_point_2"],
                "total_blocks": 3,
            },
        }

        class _StubOpener:
            def open(self, url, timeout=None):
                raise ConnectionError("mock dns fail")

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_b"
            with mock.patch.object(
                pipeline_runner, "_build_noproxy_opener", return_value=_StubOpener(),
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

        class _OkOpener:
            def open(self, url, timeout=None):
                return _FakeResp(url)

        class _FakeResp:
            def __init__(self, url): self._url = url
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self):
                # 返回 > 1KB payload 让 _download_image 的尺寸 guard 通过
                return b"\x89PNG\r\n" + (b"\0" * 2048)

        with tempfile.TemporaryDirectory() as td:
            task_dir = Path(td) / "task_d"
            with mock.patch.object(
                pipeline_runner, "_build_noproxy_opener", return_value=_OkOpener(),
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

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(pipeline_runner, "_OUTPUT_BASE", Path(td)), \
                 mock.patch.object(pipeline_runner, "_load_mock_planning", return_value=fake_planning), \
                 mock.patch.object(pipeline_runner, "_run_real_generator",
                                   return_value=(fake_blocks, 1.40)), \
                 mock.patch.object(pipeline_runner, "_run_assembler",
                                   return_value="/static/ai_refine_v2/x/assembled.png"):
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
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "ok.png"
            p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 200_000)  # 200KB > 100KB
            pipeline_runner._validate_assembled_png(p)  # 不 raise 就 pass

    def test_assembled_png_raises_in_worker(self):
        """端到端: _worker 拼装出小 PNG → status=failed."""
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

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(pipeline_runner, "_OUTPUT_BASE", Path(td)), \
                 mock.patch.object(pipeline_runner, "_load_mock_planning", return_value=fake_planning), \
                 mock.patch.object(pipeline_runner, "_run_real_generator",
                                   return_value=(fake_blocks, 0.70)), \
                 mock.patch.object(pipeline_runner, "_run_assembler",
                                   side_effect=_real_assembler_but_tiny_png):
                pipeline_runner._worker(
                    task_id=task_id,
                    product_text="x", product_image_url="p",
                    product_title="T", deepseek_key="", gpt_image_key="fake",
                )

            state = pipeline_runner._TASKS[task_id]
            self.assertEqual(state.status, "failed",
                             f"应 failed, 实际 {state.status}; error={state.error}")
            self.assertIn("太小", state.error)
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
