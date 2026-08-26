from __future__ import annotations

import json
import uuid
from pathlib import Path
from unittest import mock
from urllib.parse import unquote, urlparse

from app import OUTPUT_DIR, STATIC_OUTPUTS, _sanitize_parameter_export_data, app, db
from models import GenerationLog, User


REPO = Path(__file__).resolve().parent.parent
WORKSPACE_HTML = REPO / "templates" / "workspace.html"


def _make_authed_client():
    username = f"parameter_sheet_{uuid.uuid4().hex[:8]}"
    client = app.test_client()
    with app.app_context():
        user = User(username=username, is_approved=True, is_paid=True)
        user.set_password("x")
        db.session.add(user)
        db.session.commit()
        user_id = user.id
    with client.session_transaction() as session:
        session["_user_id"] = str(user_id)
        session["_fresh"] = True
    return client, username, user_id


def _cleanup_user(username: str, user_id: int) -> None:
    with app.app_context():
        GenerationLog.query.filter_by(user_id=user_id).delete()
        user = User.query.filter_by(username=username).first()
        if user is not None:
            db.session.delete(user)
        db.session.commit()


def test_parameter_export_whitelists_fields_and_static_upload_urls():
    data, error = _sanitize_parameter_export_data(
        {
            "title": "产品参数",
            "subtitle": "真实规格",
            "red_bar_text": "创新升级",
            "dim_length": "1200mm",
            "specs": [
                {"name": "电池容量", "value": "20AH"},
                {"name": "", "value": "忽略空行"},
            ],
            "product_image": "/static/uploads/1/robot.png",
            "unexpected": "must not reach Jinja",
        }
    )

    assert error is None
    assert data == {
        "specs": [{"name": "电池容量", "value": "20AH"}],
        "title": "产品参数",
        "subtitle": "真实规格",
        "red_bar_text": "创新升级",
        "dim_height": "",
        "dim_width": "",
        "dim_length": "1200mm",
        "footnote": "",
        "product_image": "/static/uploads/1/robot.png",
    }

    _, error = _sanitize_parameter_export_data(
        {
            "specs": [{"name": "电池容量", "value": "20AH"}],
            "product_image": "https://example.invalid/robot.png",
        }
    )
    assert error == "产品图片来源无效，请重新上传产品图"


def test_parameter_export_rejects_more_than_configured_specs(monkeypatch):
    monkeypatch.setitem(app.config, "PARAMETER_EXPORT_LIMITS", {
        **app.config["PARAMETER_EXPORT_LIMITS"],
        "spec_count": 1,
    })

    _, error = _sanitize_parameter_export_data(
        {
            "specs": [
                {"name": "电池容量", "value": "20AH"},
                {"name": "清扫宽度", "value": "430mm"},
            ]
        }
    )

    assert "最多支持 1 条" in error


def test_parameter_export_only_screenshots_block_e_for_png_and_jpg():
    app.config["TESTING"] = True
    app.config["WTF_CSRF_ENABLED"] = False
    client, username, user_id = _make_authed_client()
    preview_path = OUTPUT_DIR / str(user_id) / "_last_设备类_preview.json"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    preview_path.write_text(
        json.dumps(
            {
                "block_a": {"model_name": "DZ50X"},
                "block_e": {"specs": [{"name": "旧参数", "value": "旧值"}]},
                "fixed_selling_images": ["/static/SHOULD_NOT_APPEAR.png"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    captured: list[dict] = []

    class FakeLocator:
        def __init__(self, run):
            self.run = run

        def wait_for(self, **kwargs):
            self.run["locator_wait"] = kwargs

        def screenshot(self, **kwargs):
            output_path = Path(kwargs["path"])
            output_path.write_bytes(b"fake-parameter-image")
            self.run["output_path"] = output_path
            self.run["locator_screenshot"] = dict(kwargs)

    class FakePlaywright:
        chromium = None

        def __init__(self):
            self.chromium = self
            self.run = {"page_screenshot_calls": 0}
            captured.append(self.run)

        def launch(self, **_kwargs):
            return self

        def new_context(self, **_kwargs):
            return self

        def new_page(self):
            return self

        def goto(self, uri, **_kwargs):
            raw_path = unquote(urlparse(uri).path)
            if len(raw_path) > 2 and raw_path[0] == "/" and raw_path[2] == ":":
                raw_path = raw_path[1:]
            temp_path = Path(raw_path)
            self.run["temp_path"] = temp_path
            self.run["html"] = temp_path.read_text(encoding="utf-8")

        def wait_for_timeout(self, _milliseconds):
            return None

        def locator(self, selector):
            self.run["locator_selector"] = selector
            return FakeLocator(self.run)

        def screenshot(self, **_kwargs):
            self.run["page_screenshot_calls"] += 1
            raise AssertionError("参数图应截取参数根元素，不应截取整页")

        def close(self):
            return None

    class FakeSyncPlaywright:
        def __enter__(self):
            return FakePlaywright()

        def __exit__(self, *_args):
            return False

    def render_block(block_id, block_data):
        assert block_id == "block_e"
        value = block_data["specs"][0]["value"]
        return f'<div id="parameter-only">{value}</div>'

    try:
        with mock.patch("app._render_single_block", side_effect=render_block), mock.patch(
            "playwright.sync_api.sync_playwright", return_value=FakeSyncPlaywright()
        ):
            for export_format, expected_mimetype in (("png", "image/png"), ("jpg", "image/jpeg")):
                response = client.post(
                    "/export/设备类",
                    json={
                        "scope": "parameter",
                        "parameter_data": {
                            "title": "产品参数",
                            "specs": [{"name": "电池容量", "value": "20AH"}],
                        },
                        "format": export_format,
                    },
                )
                run = captured[-1]
                assert response.status_code == 200, response.get_data(as_text=True)
                assert response.mimetype == expected_mimetype
                assert f".{export_format}" in response.headers["Content-Disposition"].lower()
                assert 'id="parameter-only">20AH' in run["html"]
                assert "SHOULD_NOT_APPEAR" not in run["html"]
                assert run["locator_selector"] == "#parameter-export-root"
                assert run["locator_wait"] == {"state": "visible"}
                assert run["page_screenshot_calls"] == 0
                if export_format == "jpg":
                    assert run["locator_screenshot"]["type"] == "jpeg"
                    assert run["locator_screenshot"]["quality"] == 90
                else:
                    assert "type" not in run["locator_screenshot"]
                    assert "quality" not in run["locator_screenshot"]
                response.close()
    finally:
        preview_path.unlink(missing_ok=True)
        for run in captured:
            for key in ("temp_path", "output_path"):
                path = run.get(key)
                if path:
                    path.unlink(missing_ok=True)
        _cleanup_user(username, user_id)
        output_dir = STATIC_OUTPUTS / str(user_id)
        if output_dir.exists():
            for path in output_dir.glob("*_产品参数_*.png"):
                path.unlink(missing_ok=True)
            for path in output_dir.glob("*_产品参数_*.jpg"):
                path.unlink(missing_ok=True)


def test_parameter_sheet_frontend_keeps_desktop_safety_and_fit_contracts():
    content = WORKSPACE_HTML.read_text(encoding="utf-8")

    for required in (
        'id="btn_generate_parameter"',
        'data-tab="parameter"',
        'id="parameter_wrapper"',
        'id="parameter_container"',
        'id="parameter_export_bar"',
        "generateParameterSheet()",
        "renderParameterSheet(preview.modules)",
        "doParameterExport('png')",
        "doParameterExport('jpg')",
        "scope = 'parameter'",
        "parameter_data = moduleDataMap.block_e || null",
        "queueParameterFit()",
    ):
        assert required in content

    assert "/static/vendor/sortable-1.15.6.min.js" in content
    assert "cdnjs.cloudflare.com/ajax/libs/Sortable" not in content
    assert "data-desktop-paid-disabled" in content
