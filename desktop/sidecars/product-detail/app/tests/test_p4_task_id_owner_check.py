"""P4 §A.6 task_id IDOR 越权访问修复 — 守护测试.

per `docs/superpowers/specs/_stubs/A6-task-id-idor-stub.md` 方案 A.

漏洞:
  - /api/ai-refine-v2/status/<task_id> (app.py:4543)
  - /api/single/<task_id>/status (app.py:1915)
  仅 @login_required, 不验证 task_id 是否属于当前用户.
  task_id (时间戳+hex) 中等可预测, 攻击者可枚举读其他用户的精修任务进度
  (含产品文案 / 图片 URL).

修复 (per audit stub A6 方案 A):
  - TaskState 加 user_id 字段
  - start_task 接收 user_id 参数, 写入 state
  - 两路由读 state.user_id, 与 current_user.id 不符 + 非 admin → 403

本测试组防止未来 PR 把 owner check 删掉或 user_id 字段去掉.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_PY = REPO_ROOT / "app.py"
PIPELINE_RUNNER = REPO_ROOT / "ai_refine_v2" / "pipeline_runner.py"


class TestTaskStateHasUserId:
    """守护: TaskState 必须有 user_id 字段."""

    def test_task_state_dataclass_has_user_id(self):
        content = PIPELINE_RUNNER.read_text(encoding="utf-8")
        # 检 TaskState 类定义体内必须有 user_id 字段
        match = re.search(
            r'class TaskState:(.*?)(?=\n\n|class\s|\ndef\s)',
            content,
            re.DOTALL,
        )
        assert match, "找不到 TaskState 类定义"
        body = match.group(1)
        assert "user_id" in body, (
            "TaskState 必须有 user_id 字段, 用于 owner 校验. "
            "添加: user_id: int | None = None"
        )

    def test_start_task_accepts_user_id(self):
        """start_task 必须接收 user_id 参数 (kwargs 或 positional)."""
        content = PIPELINE_RUNNER.read_text(encoding="utf-8")
        # 用 ast 不易匹配多行签名, 直接 regex
        match = re.search(
            r'def\s+start_task\s*\((.*?)\)\s*(?:->|:)',
            content,
            re.DOTALL,
        )
        assert match, "找不到 start_task 函数"
        sig = match.group(1)
        assert "user_id" in sig, (
            "start_task 必须接受 user_id 参数, 才能写入 TaskState 做 owner 校验."
        )


class TestRefineV2StatusHasOwnerCheck:
    """守护: /api/ai-refine-v2/status/<task_id> 必须做 owner 校验."""

    def test_route_has_owner_check(self):
        """ai_refine_v2_status 函数体必须包含 user_id 比较 + abort/403."""
        content = APP_PY.read_text(encoding="utf-8")
        # 抓 ai_refine_v2_status 函数体
        match = re.search(
            r'def ai_refine_v2_status\s*\([^)]*\):(.*?)(?=\n@|\ndef\s)',
            content,
            re.DOTALL,
        )
        assert match, "找不到 ai_refine_v2_status 函数"
        body = match.group(1)
        # 必须有 user_id 比较 + 403 / abort
        has_user_check = "user_id" in body and "current_user.id" in body
        has_forbid = "403" in body or "abort(" in body
        assert has_user_check and has_forbid, (
            "ai_refine_v2_status 必须比 state.user_id 与 current_user.id, "
            "不符 (且非 admin) 时 abort(403) 防 IDOR."
        )


class TestSingleTaskStatusHasOwnerCheck:
    """守护: /api/single/<task_id>/status 必须做 owner 校验."""

    def test_single_task_status_has_owner_check(self):
        content = APP_PY.read_text(encoding="utf-8")
        match = re.search(
            r'def single_task_status\s*\([^)]*\):(.*?)(?=\n@|\ndef\s)',
            content,
            re.DOTALL,
        )
        assert match, "找不到 single_task_status 函数"
        body = match.group(1)
        has_user_check = "user_id" in body and "current_user.id" in body
        has_forbid = "403" in body or "abort(" in body
        assert has_user_check and has_forbid, (
            "single_task_status 必须做 owner 校验防 IDOR."
        )


class TestStartTaskCallSitesPassUserId:
    """守护: app.py 调 start_task 时必须传 current_user.id."""

    def test_app_py_passes_user_id_to_start_task(self):
        content = APP_PY.read_text(encoding="utf-8")
        # 找 pipeline_runner.start_task( 调用
        # 后续上下文 200 字符内必须有 current_user.id 或 user_id=
        for match in re.finditer(r'pipeline_runner\.start_task\s*\(', content):
            # 取调用块
            start = match.start()
            # 找匹配 ) 的位置 (简化: 取 500 字符内首个不在引号内的 ))
            chunk = content[start:start + 800]
            close_paren = chunk.find(")\n")
            if close_paren < 0:
                close_paren = 800
            call = chunk[:close_paren]
            assert "current_user.id" in call or "user_id=" in call, (
                f"pipeline_runner.start_task 调用必须传 user_id (current_user.id). "
                f"调用片段:\n{call[:200]}"
            )
