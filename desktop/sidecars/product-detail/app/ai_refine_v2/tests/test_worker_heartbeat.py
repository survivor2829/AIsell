"""A worker waiting on the image service stays visibly alive (2026-11-17).

The desktop treats a task silent for 5 minutes as stuck and let a new click buy the whole
page again while the first was still drawing; APIMart took up to 13.5 minutes per image.
"""
import time

from ai_refine_v2 import pipeline_runner as runner


def test_waiting_worker_reports_in_and_says_why(monkeypatch):
    monkeypatch.setattr(runner, "HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(runner, "SLOW_NOTICE_SECONDS", 0.2)
    task_id = "v2_heartbeat_test"
    runner._TASKS[task_id] = runner.TaskState(task_id=task_id)
    try:
        runner._LAST_PROGRESS[task_id] = time.time() - 3600  # left from an earlier run
        with runner._keep_alive(task_id):
            runner._set(task_id, progress_msg="生成第 1 屏")
            progress_at = runner._LAST_PROGRESS[task_id]
            assert time.time() - progress_at < 1, "a new wait never reuses an old timestamp"
            first_update = runner._TASKS[task_id].updated_at
            time.sleep(0.12)
            assert runner._TASKS[task_id].updated_at > first_update, "alive while it waits"
            assert runner._TASKS[task_id].progress_msg == "生成第 1 屏", "no notice for a short wait"
            time.sleep(0.25)
            assert "生图服务较忙" in runner._TASKS[task_id].progress_msg
            assert "不要重新点生成" in runner._TASKS[task_id].progress_msg
            assert runner._LAST_PROGRESS[task_id] == progress_at, "a heartbeat is not progress"
            runner._set(task_id, blocks=[])
            assert runner._LAST_PROGRESS[task_id] > progress_at, "real progress resets the wait"
            time.sleep(0.12)
            assert runner._TASKS[task_id].progress_msg == "生成第 1 屏", "the wait notice gives way to the real message"
            with runner._keep_alive(task_id):
                assert runner._KEEP_ALIVE_DEPTH[task_id] == 2, "a nested wait shares the one heartbeat"
            runner._set(task_id, progress_msg="完成")
        stopped_at = runner._TASKS[task_id].updated_at
        time.sleep(0.2)
        assert runner._TASKS[task_id].updated_at == stopped_at, "no heartbeat after the wait ends"
        assert runner._TASKS[task_id].progress_msg == "完成", "a late beat never covers the result"
        assert task_id not in runner._LAST_PROGRESS and task_id not in runner._KEEP_ALIVE_DEPTH
    finally:
        runner._TASKS.pop(task_id, None)
        runner._LAST_PROGRESS.pop(task_id, None)


def test_generation_and_recovery_run_inside_the_heartbeat():
    import inspect

    assert "_keep_alive(task_dir.name)" in inspect.getsource(runner._run_real_generator_v2)
    assert "_keep_alive(task_id)" in inspect.getsource(runner._recovery_worker)
    assert "_keep_alive(task_id)" in inspect.getsource(runner._continue_after_slow_screens)
