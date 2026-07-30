"""守护测: batch/upload 文件夹选择和上传进度反馈不能退化.

真实痛点:
- 点击 picker 图标/文字在部分 Windows Chrome 场景下不稳定.
- 大批次 zip 上传使用 fetch 时没有 upload progress, 用户会以为页面卡死.

这些测试只做源码模式检查, 不需要真实上传或调用 AI API.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
UPLOAD_HTML = REPO / "templates" / "batch" / "upload.html"


def _read_upload_html() -> str:
    return UPLOAD_HTML.read_text(encoding="utf-8")


class TestFolderPickerClickTarget:
    """守护: picker 图标/文字点击必须稳定触发文件夹选择."""

    def test_picker_children_do_not_capture_clicks(self):
        content = _read_upload_html()
        assert re.search(
            r"\.picker\s+\.icon\s*,\s*[\s\S]{0,80}?"
            r"\.picker\s+\.hint\s*,\s*[\s\S]{0,80}?"
            r"\.picker\s+\.sub\s*\{[\s\S]{0,80}?pointer-events\s*:\s*none\s*;",
            content,
        ), (
            "templates/batch/upload.html: .picker 的 icon/hint/sub 必须 "
            "pointer-events:none, 否则点击 emoji/文字在部分浏览器下不会冒泡到 label."
        )

    def test_picker_click_fallback_opens_folder_input_once(self):
        content = _read_upload_html()
        assert re.search(
            r"picker\.addEventListener\(\s*['\"]click['\"]\s*,\s*\(e\)\s*=>\s*\{"
            r"[\s\S]{0,220}?if\s*\(\s*e\.target\s*!==\s*folderInput\s*\)"
            r"[\s\S]{0,160}?e\.preventDefault\(\);"
            r"[\s\S]{0,120}?folderInput\.click\(\);",
            content,
        ), (
            "picker click 兜底必须在非 input 点击时 preventDefault 后调用 "
            "folderInput.click(), 既覆盖 label 默认失效, 又避免 label 默认行为二次触发."
        )


class TestUploadProgressTransport:
    """守护: /api/batch/upload 必须使用 XHR 以获得 upload progress."""

    def test_upload_uses_xmlhttprequest(self):
        content = _read_upload_html()
        assert "new XMLHttpRequest()" in content, (
            "批量上传必须使用 XMLHttpRequest, fetch 不能稳定提供 upload progress."
        )
        assert "xhr.upload.onprogress" in content, (
            "批量上传必须绑定 xhr.upload.onprogress, 否则无法显示上传百分比/速度/ETA."
        )
        assert "xhr.setRequestHeader('X-CSRFToken', csrfToken)" in content, (
            "XHR 上传必须继续带 X-CSRFToken, 否则后端 CSRFProtect 会拒绝请求."
        )

    def test_upload_endpoint_is_not_sent_with_fetch(self):
        content = _read_upload_html()
        assert "fetch('/api/batch/upload'" not in content, (
            "/api/batch/upload 不应再使用 fetch, 否则会丢失 upload progress."
        )

    def test_progress_message_includes_percent_speed_and_eta(self):
        content = _read_upload_html()
        assert "上传中 ${pct}%" in content, "上传文案必须包含百分比."
        assert "formatBytesPerSecond" in content, "上传文案必须包含速度计算 helper."
        assert "剩余 ${etaText}" in content, "上传文案必须包含 ETA."
        assert "e.lengthComputable" in content, (
            "必须处理 lengthComputable=false 的浏览器边界, 退化显示已上传 MB."
        )

    def test_existing_error_status_shape_is_preserved(self):
        content = _read_upload_html()
        assert "上传失败 ${r.status}: ${data.error || r.statusText}" in content, (
            "上传失败文案要保留 status + 后端 error/statusText, 方便用户和开发定位."
        )
