"""守护测: get_task_status 必须能从磁盘 _summary.json fallback 重建状态.

真实场景 (2026-05-07):
- 用户 task v2_1778126382035_b3cca1 实际 8 屏成功 + assembled.png 13MB 都在磁盘
- 但 in-memory _TASKS 内存丢失 (worker 重启 / 内存被清等)
- get_task_status() 返 None → endpoint 返 404 → 前端误报"AI精修失败"
- 用户重点一次新任务才看到成功 (但已浪费 ¥5.6 + 用户体验差)

修复: in-memory 缺失时, 读磁盘 _summary.json 重建 status='success' dict.
"""
from __future__ import annotations
import json
from pathlib import Path
import pytest


@pytest.fixture
def isolated_tasks_dir(tmp_path, monkeypatch):
    """每个测试独立的 _OUTPUT_BASE + 清空 _TASKS module-level dict."""
    from ai_refine_v2 import pipeline_runner
    monkeypatch.setattr(pipeline_runner, "_OUTPUT_BASE", tmp_path)
    monkeypatch.setattr(pipeline_runner, "_TASKS", {})
    return tmp_path


class TestGetTaskStatusInMemory:
    """守护: 内存有 state 时, 行为不变 (向后兼容)."""

    def test_in_memory_returns_dict(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        # 模拟 in-memory state 存在
        st = pipeline_runner.TaskState(
            task_id="test_001", user_id=42, status="success",
            mode="real", progress_pct=100, cost_rmb=5.6,
        )
        pipeline_runner._TASKS["test_001"] = st

        result = pipeline_runner.get_task_status("test_001")
        assert result is not None
        assert result["task_id"] == "test_001"
        assert result["user_id"] == 42
        assert result["status"] == "success"
        assert result["cost_rmb"] == 5.6


class TestGetTaskStatusDiskFallback:
    """守护: 内存无 state + 磁盘有 _summary.json → fallback 重建 status='success'."""

    def _write_summary(self, task_dir: Path, **overrides):
        """工具: 创建一个真实形态的 _summary.json + assembled.png placeholder."""
        task_dir.mkdir(parents=True, exist_ok=True)
        summary = {
            "product": "测试产品",
            "mode": "real",
            "schema_mode": "v2",
            "total_cost_rmb": 5.6,
            "raw_urls": [
                "https://upload.apimart.ai/f/image/abc-1.png",
                "https://upload.apimart.ai/f/image/abc-2.png",
            ],
            "blocks": [
                {
                    "block_id": "screen_01_hero",
                    "visual_type": "hero",
                    "is_hero": True,
                    "file": "block_01_screen_01_hero.jpg",
                    "image_url": f"/static/ai_refine_v2/{task_dir.name}/block_01_screen_01_hero.jpg",
                    "raw_url": "https://upload.apimart.ai/f/image/abc-1.png",
                    "success": True,
                    "placeholder": False,
                },
                {
                    "block_id": "screen_02_brand_quality",
                    "visual_type": "brand_quality",
                    "is_hero": False,
                    "file": "block_02_screen_02_brand_quality.jpg",
                    "image_url": f"/static/ai_refine_v2/{task_dir.name}/block_02_screen_02_brand_quality.jpg",
                    "raw_url": "https://upload.apimart.ai/f/image/abc-2.png",
                    "success": True,
                    "placeholder": False,
                },
            ],
            **overrides,
        }
        (task_dir / "_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False), encoding="utf-8"
        )
        # assembled.png placeholder (只验证存在, 不验证内容)
        (task_dir / "assembled.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    def test_disk_fallback_returns_success(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_disk_only"
        self._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        assert result is not None, (
            "_summary.json 在磁盘时, get_task_status 必须 fallback 重建 dict"
        )
        assert result["status"] == "success", (
            "_summary.json 存在等于任务已完成, status 必须是 'success'"
        )
        assert result["task_id"] == task_id

    def test_disk_fallback_blocks_preserved(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_disk_blocks"
        self._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        assert result is not None
        blocks = result.get("blocks", [])
        assert len(blocks) == 2, (
            "磁盘 fallback 必须把 _summary.json 的 blocks 全部恢复"
        )
        assert blocks[0]["block_id"] == "screen_01_hero"
        assert blocks[0]["success"] is True

    def test_disk_fallback_cost_preserved(self, isolated_tasks_dir):
        """磁盘 _summary.json 的 total_cost_rmb 必须映射到 dict.cost_rmb."""
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_disk_cost"
        self._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        assert result["cost_rmb"] == 5.6, (
            f"cost_rmb 应映射 _summary.json.total_cost_rmb=5.6, 实际 {result.get('cost_rmb')!r}"
        )

    def test_disk_fallback_assembled_url_set(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_disk_assembled"
        self._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        # assembled.png 在磁盘 → assembled_url 应指向 /static/...
        assert result["assembled_url"], (
            "assembled.png 存在时 assembled_url 应非空"
        )
        assert task_id in result["assembled_url"]
        assert result["assembled_url"].endswith("assembled.png")

    def test_disk_fallback_user_id_none_for_p4_compat(self, isolated_tasks_dir):
        """P4 §A.6 owner check: 磁盘任务无 owner 标记, user_id=None → 仅 admin 可读.

        端点 ai_refine_v2_status (app.py:4763) 校验:
            if owner_id != current_user.id and not current_user.is_admin: abort(403)
        所以 user_id=None 的历史任务只有 admin 能看, 普通用户 403, 与现有逻辑一致.
        """
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_disk_no_owner"
        self._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        assert result["user_id"] is None, (
            "磁盘 fallback 重建的 task user_id 必须是 None (P4 admin-only 历史任务标记)"
        )


class TestGetTaskStatusBothMissing:
    """守护: 内存无 + 磁盘也无 _summary.json → 必须返 None (404 行为不变)."""

    def test_both_missing_returns_none(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        result = pipeline_runner.get_task_status("v2_does_not_exist")
        assert result is None, (
            "task 完全不存在时必须返 None (端点会返 404, 这是合法的'真不存在')"
        )

    def test_dir_exists_but_no_summary_returns_none(self, isolated_tasks_dir):
        """task_dir 存在但 _summary.json 不在 (任务进行中崩了) → None."""
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_partial_dir"
        (isolated_tasks_dir / task_id).mkdir()
        # 没有 _summary.json
        result = pipeline_runner.get_task_status(task_id)
        assert result is None, (
            "任务中崩了 (无 _summary.json) 也应返 None, 不假装 success"
        )


class TestInMemoryPriorityOverDisk:
    """守护: 内存有 state 时优先用内存, 不读磁盘 (避免覆盖正在跑的任务)."""

    def test_in_memory_running_not_overwritten_by_disk(self, isolated_tasks_dir):
        from ai_refine_v2 import pipeline_runner
        task_id = "v2_running"
        # 内存中标记 running_generator
        pipeline_runner._TASKS[task_id] = pipeline_runner.TaskState(
            task_id=task_id, user_id=42, status="running_generator", progress_pct=50,
        )
        # 同时磁盘有半成品 _summary.json (理论上不该有但模拟边界)
        TestGetTaskStatusDiskFallback()._write_summary(isolated_tasks_dir / task_id)

        result = pipeline_runner.get_task_status(task_id)
        assert result["status"] == "running_generator", (
            "内存有 state 时必须返内存值, 不能被磁盘覆盖"
        )
        assert result["progress_pct"] == 50
