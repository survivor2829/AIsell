from __future__ import annotations

import re
import shutil
import unittest
import uuid
from pathlib import Path
from unittest import mock

from app import BASE_DIR, STATIC_OUTPUTS, app, db
from ai_refine_v2.tests.conftest import cleanup_user
from models import User


REPO = Path(__file__).resolve().parent.parent
WORKSPACE_HTML = REPO / "templates" / "workspace.html"


def _uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _make_authed_client(test_case: unittest.TestCase):
    username = _uid("workspace_result_user")
    client = app.test_client()
    with app.app_context():
        user = User(username=username, is_approved=True, is_paid=True)
        user.set_password("x")
        db.session.add(user)
        db.session.commit()
        uid = user.id
        test_case.addCleanup(cleanup_user, username)
    with client.session_transaction() as sess:
        sess["_user_id"] = str(uid)
    return client, uid


class TestWorkspaceAiResultPersistence(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_save_completed_ai_refine_result_and_restore_latest(self):
        client, uid = _make_authed_client(self)
        task_id = f"v2_{uuid.uuid4().hex[:10]}"
        task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "assembled.png").write_bytes(b"fake png")
        self.addCleanup(lambda: shutil.rmtree(task_dir, ignore_errors=True))

        history_file = STATIC_OUTPUTS / str(uid) / "workspace_results.json"
        self.addCleanup(lambda: history_file.unlink(missing_ok=True))

        state = {
            "task_id": task_id,
            "user_id": uid,
            "status": "success",
            "mode": "real",
            "blocks": [{"id": "hero"}, {"id": "specs"}],
            "assembled_url": f"/static/ai_refine_v2/{task_id}/assembled.png",
            "elapsed_s": 12.4,
            "cost_rmb": 3.21,
        }
        with mock.patch("ai_refine_v2.pipeline_runner.get_task_status", return_value=state):
            resp = client.post(
                f"/api/workspace-results/ai-refine-v2/{task_id}",
                json={"product_category": "设备类", "product_title": "T300"},
            )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        saved = resp.get_json()["result"]
        self.assertEqual(saved["task_id"], task_id)
        self.assertEqual(saved["image_url"], state["assembled_url"])
        self.assertEqual(saved["blocks_count"], 2)

        latest = client.get("/api/workspace-results/latest?kind=ai_refine_v2")
        self.assertEqual(latest.status_code, 200, latest.get_data(as_text=True))
        body = latest.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["result"]["task_id"], task_id)
        self.assertEqual(body["result"]["image_url"], state["assembled_url"])

    def test_partial_success_persists_counts_but_recovery_required_is_rejected(self):
        client, uid = _make_authed_client(self)
        task_id = f"v2_{uuid.uuid4().hex[:10]}"
        task_dir = BASE_DIR / "static" / "ai_refine_v2" / task_id
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "assembled.png").write_bytes(b"fake partial png")
        self.addCleanup(lambda: shutil.rmtree(task_dir, ignore_errors=True))

        history_file = STATIC_OUTPUTS / str(uid) / "workspace_results.json"
        self.addCleanup(lambda: history_file.unlink(missing_ok=True))

        state = {
            "task_id": task_id,
            "user_id": uid,
            "status": "recovery_required",
            "mode": "real",
            "blocks": [{"success": True}] * 6 + [{"success": False}] * 2,
            "assembled_url": f"/static/ai_refine_v2/{task_id}/assembled.png",
            "planned_count": 8,
            "success_count": 6,
            "failed_count": 2,
        }
        endpoint = f"/api/workspace-results/ai-refine-v2/{task_id}"

        with mock.patch(
            "ai_refine_v2.pipeline_runner.get_task_status",
            return_value=state,
        ):
            rejected = client.post(endpoint, json={"product_category": "设备类"})
        self.assertEqual(rejected.status_code, 400)

        state["status"] = "partial_success"
        with mock.patch(
            "ai_refine_v2.pipeline_runner.get_task_status",
            return_value=state,
        ):
            response = client.post(endpoint, json={"product_category": "设备类"})

        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        saved = response.get_json()["result"]
        self.assertEqual(saved["planned_count"], 8)
        self.assertEqual(saved["success_count"], 6)
        self.assertEqual(saved["failed_count"], 2)

        latest = client.get("/api/workspace-results/latest?kind=ai_refine_v2")
        restored = latest.get_json()["result"]
        self.assertEqual(restored["planned_count"], 8)
        self.assertEqual(restored["success_count"], 6)
        self.assertEqual(restored["failed_count"], 2)


class TestWorkspaceFrontendPersistenceHooks:
    def test_frontend_saves_and_restores_latest_ai_refine_result(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "rememberAiRefineResult(taskId" in content
        assert "/api/workspace-results/ai-refine-v2/" in content
        assert "restoreLatestAiResult()" in content
        assert "/api/workspace-results/latest?kind=ai_refine_v2" in content

    def test_frontend_passes_current_category_to_v2_execute(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "product_category:" in content
        assert "currentProductType" in content

    def test_hidden_modules_have_direct_and_global_recovery_controls(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert 'id="hidden_modules_bar"' in content
        assert 'onclick="showAllModules()"' in content
        assert "function showModule(btn, moduleId)" in content
        assert "function showAllModules()" in content
        assert "function updateHiddenModulesBar()" in content

    def test_missing_data_is_explained_separately_from_hidden_modules(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert 'id="module_generation_note"' in content
        assert "module_generation_note')?.classList.toggle" not in content
        assert "generationNote.dataset.hasModules" in content

    def test_main_image_preview_fits_the_available_center_panel(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "function fitMainImageToPanel()" in content
        assert "viewer.style.zoom = scale.toFixed(4)" in content
        assert "new ResizeObserver(queueMainImageFit)" in content
        assert "if (tab === 'main_img') queueMainImageFit()" in content

    def test_desktop_module_paid_controls_are_not_actionable(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "const DESKTOP_MODE = {{ desktop_mode|tojson }}" in content
        assert "paidModuleButton.dataset.desktopPaidDisabled = 'true'" in content
        assert "paidModuleButton.removeAttribute('onclick')" in content
        assert "paidModuleButton.hidden = true" in content
        assert "if (DESKTOP_MODE) return;" in content

    def test_detail_preview_fits_the_available_center_panel(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "const PREVIEW_CANVAS_WIDTH = 750" in content
        assert "container.style.zoom = scale.toFixed(4)" in content
        assert "new ResizeObserver(queuePreviewFit)" in content
        assert "if (tab === 'detail') queuePreviewFit()" in content
        assert "const defaultLayout = window.innerWidth >= 1024 ? 'preview' : 'balance'" in content
        assert "name === 'preview' && window.innerWidth < 1280" not in content
        assert "initPreviewFit()" in content

    def test_desktop_paid_ai_control_is_explained_and_disabled(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "{% if desktop_mode %}" in content
        assert 'data-desktop-paid-disabled="true"' in content
        assert "DeepSeek 与 APIMart" in content
        assert "{% else %}" in content
        assert "{% endif %}" in content


class TestWorkspaceFrontendPaidTaskSafety:
    def test_active_task_survives_reload_and_is_resumed_on_init(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "AI_REFINE_ACTIVE_TASK_KEY" in content
        assert "function persistAiRefineTask(" in content
        assert "function aiRefineStorages(" in content
        assert "sessionStorage" in content and "localStorage" in content
        assert "storage.setItem(AI_REFINE_ACTIVE_TASK_KEY" in content
        assert "function loadPersistedAiRefineTask(" in content
        assert "function resumePersistedAiRefineTask(" in content
        assert "resumePersistedAiRefineTask()" in content
        assert "input_digest" in content
        assert "input_summary" in content
        assert "const remembered = await rememberAiRefineResult(taskId)" in content
        assert "if (remembered) clearPersistedAiRefineTask" in content

    def test_already_running_response_reconnects_instead_of_starting_again(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "DESKTOP_AI_REFINE_ALREADY_RUNNING" in content
        assert "startError.taskId" in content
        assert "resumeAiRefineTask" in content
        assert "服务未返回可接管的 task_id" in content

    def test_continue_original_task_calls_nonbillable_recovery_endpoint(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "/api/ai-refine-v2/recover/" in content
        assert "recoverOriginal" in content
        assert "继续检查原任务" in content

    def test_polling_fails_fast_for_nonretryable_http_statuses(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "AI_REFINE_NON_RETRYABLE_POLL_STATUSES" in content
        for status in (400, 401, 403, 409, 429):
            assert str(status) in content
        assert re.search(
            r"if \(resp\.status === 404\).*?"
            r"missing\.code = 'AI_REFINE_TASK_NOT_FOUND'.*?"
            r"if \(AI_REFINE_NON_RETRYABLE_POLL_STATUSES\.has\(resp\.status\)\).*?"
            r"rejected\.code = payload\.code.*?rejected\.nonRetryable = true.*?"
            r"throw rejected",
            content,
            re.DOTALL,
        ), "普通 404 必须保持任务缺失；409 unknown 才能携带服务端安全代码退出轮询"
        assert re.search(
            r"if \(activeError\.code === 'DESKTOP_AI_REFINE_OUTCOME_UNKNOWN'\).*?"
            r"await confirmInWorkspace\(.*?if \(confirmed\).*?"
            r"postJson\('/desktop/ai-refine-v2/resolve-unknown'",
            content,
            re.DOTALL,
        ), "结果不明只能先人工确认，再调用桌面解锁端点"
        assert "await handleAiRefineRunError(error, ui.results)" in content

    def test_all_paid_task_terminal_states_are_handled_explicitly(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "partial_success" in content
        assert "recovery_required" in content
        assert "outcome_unknown" in content
        assert "successCount" in content
        assert "totalCount" in content
        assert "成功 ${successCount}/${totalCount} 屏" in content

    def test_paid_generation_requires_a_cost_and_retry_confirmation(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "预计生成 8–15 屏" in content
        assert "实际费用以 APIMart 账单为准" in content
        assert "失败或结果不明时不会自动重提" in content
        assert "await confirmInWorkspace(" in content
        assert "开始付费生成" in content

    def test_product_copy_is_required_and_bounded_before_paid_generation(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        textarea_match = re.search(r'<textarea\s+[^>]*id="text_input"[^>]*>', content)
        assert textarea_match, "产品文案输入框不存在"
        textarea = textarea_match.group(0)
        assert "required" in textarea
        assert 'maxlength="20000"' in textarea
        title_match = re.search(r'<input\s+[^>]*id="product_title_input"[^>]*>', content)
        assert title_match, "产品标题输入框不存在"
        assert 'maxlength="120"' in title_match.group(0)
        assert "if (!productText)" in content
        assert "请填写产品文案" in content

    def test_user_error_summary_does_not_leak_raw_technical_details(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert "function renderAiRefineError(" in content
        assert "技术详情" in content
        assert "sanitizeAiRefineTechnicalDetail" in content
        assert "AI 精修失败: ${escapeHtml(e.message)}" not in content

    def test_hidden_recovery_bar_and_template_images_are_accessible(self):
        content = WORKSPACE_HTML.read_text(encoding="utf-8")
        assert 'id="hidden_modules_bar"' in content
        assert "bar.inert = !visible" in content
        assert "function initAnnouncementAccessibility(" in content
        assert "panel.inert = panel.hidden" in content
        assert "panel.setAttribute('aria-hidden', panel.hidden ? 'true' : 'false')" in content
        assert 'alt="${escapeHtml(t.name)}模板预览"' in content
