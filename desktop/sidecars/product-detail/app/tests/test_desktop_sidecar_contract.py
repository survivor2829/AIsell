from __future__ import annotations

import http.cookiejar
import json
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

import desktop_entry


APP_ROOT = Path(__file__).resolve().parents[1]
ENTRY = APP_ROOT / "desktop_entry.py"


def _clean_env() -> dict[str, str]:
    env = os.environ.copy()
    for name in (
        "DEEPSEEK_API_KEY",
        "REFINE_API_KEY",
        "REFINE_API_BASE_URL",
        "GPT_IMAGE_API_KEY",
        "SECRET_KEY",
        "FLASK_ENV",
    ):
        env.pop(name, None)
    env["PYTHONUTF8"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["NO_PROXY"] = "127.0.0.1,localhost"
    return env


def _cli_args(data_dir: Path, bootstrap_token: str, control_token: str) -> list[str]:
    return [
        sys.executable,
        str(ENTRY),
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--data-dir",
        str(data_dir),
        "--bootstrap-token",
        bootstrap_token,
        "--control-token",
        control_token,
    ]


def _readline_with_timeout(stream, timeout: float = 30.0) -> str:
    result: queue.Queue[str | BaseException] = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            result.put(stream.readline())
        except BaseException as exc:  # pragma: no cover - defensive pipe failure
            result.put(exc)

    threading.Thread(target=read, daemon=True).start()
    value = result.get(timeout=timeout)
    if isinstance(value, BaseException):
        raise value
    return value


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    request = urllib.request.Request(
        url,
        data=body if body is not None else (b"" if method == "POST" else None),
        method=method,
        headers=headers or {},
    )
    try:
        response = opener.open(request, timeout=10)
        return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def test_self_check_reports_isolated_paths_and_optional_capabilities(tmp_path):
    data_dir = tmp_path / "desktop-data"
    source_listing_before = sorted(
        str(path.relative_to(APP_ROOT))
        for path in APP_ROOT.rglob("*")
        if "__pycache__" not in path.parts
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(ENTRY),
            "--self-check",
            "--data-dir",
            str(data_dir),
        ],
        cwd=APP_ROOT,
        env=_clean_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    report = json.loads(completed.stdout)
    assert report["ok"] is True
    assert report["mode"] == "desktop"
    assert Path(report["resource_dir"]) == APP_ROOT
    assert Path(report["data_dir"]) == data_dir.resolve()
    assert report["capabilities"]["paid_ai_ready"] is False
    assert isinstance(report["capabilities"]["rembg"], bool)
    assert isinstance(report["capabilities"]["playwright"], bool)

    mutable_paths = [Path(value) for value in report["mutable_paths"].values()]
    assert mutable_paths
    assert all(path == data_dir.resolve() or data_dir.resolve() in path.parents for path in mutable_paths)
    assert all(path.exists() for path in mutable_paths)
    source_listing_after = sorted(
        str(path.relative_to(APP_ROOT))
        for path in APP_ROOT.rglob("*")
        if "__pycache__" not in path.parts
    )
    assert source_listing_after == source_listing_before
    assert completed.stderr == ""


@pytest.mark.parametrize(
    ("extra_args", "expected_fragment"),
    [
        (["--host", "0.0.0.0"], "loopback"),
        (["--data-dir", "relative-data"], "absolute"),
    ],
)
def test_cli_rejects_unsafe_bind_or_relative_data_dir(
    tmp_path, extra_args, expected_fragment
):
    args = [
        sys.executable,
        str(ENTRY),
        "--self-check",
        "--data-dir",
        str(tmp_path / "safe-data"),
        *extra_args,
    ]
    completed = subprocess.run(
        args,
        cwd=APP_ROOT,
        env=_clean_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert completed.returncode != 0
    assert expected_fragment in completed.stderr.lower()


def test_server_bootstrap_is_one_time_and_shutdown_is_authenticated(tmp_path):
    data_dir = tmp_path / "desktop-data"
    bootstrap_token = "bootstrap-" + ("a" * 48)
    wrong_bootstrap = "bootstrap-" + ("z" * 48)
    control_token = "control-" + ("b" * 48)
    wrong_control = "control-" + ("y" * 48)
    source_listing_before = sorted(
        str(path.relative_to(APP_ROOT))
        for path in APP_ROOT.rglob("*")
        if "__pycache__" not in path.parts
    )

    process = subprocess.Popen(
        _cli_args(data_dir, bootstrap_token, control_token),
        cwd=APP_ROOT,
        env=_clean_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdout is not None
    assert process.stderr is not None

    try:
        ready_line = _readline_with_timeout(process.stdout)
        assert ready_line, process.stderr.read()
        ready = json.loads(ready_line)
        assert ready["event"] == "ready"
        assert ready["host"] == "127.0.0.1"
        assert ready["port"] > 0
        assert ready["capabilities"]["paid_ai_ready"] is False
        assert bootstrap_token not in ready_line
        assert control_token not in ready_line

        base_url = f"http://127.0.0.1:{ready['port']}"
        cookies = http.cookiejar.CookieJar(
            policy=http.cookiejar.DefaultCookiePolicy(
                # Chromium treats loopback origins as trustworthy and accepts
                # Secure partitioned cookies there. Mirror that localhost
                # behavior in this HTTP-only contract client.
                secure_protocols=("http", "https", "wss"),
            )
        )
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cookies),
            _NoRedirect(),
        )

        status, body, _ = _request(opener, base_url + "/internal/health")
        assert status == 200
        health = json.loads(body)
        assert health["ok"] is True
        assert health["status"] == "ready"
        assert bootstrap_token.encode() not in body
        assert control_token.encode() not in body

        status, _, _ = _request(opener, base_url + "/static/uploads/1/private.png")
        assert status == 401
        status, _, _ = _request(opener, base_url + "/static/outputs/1/private.json")
        assert status == 401
        status, _, _ = _request(
            opener,
            base_url + "/static/ai_refine_v2/task/_summary.json",
        )
        assert status == 401
        status, _, _ = _request(
            opener,
            base_url + "/static/uploads/batches/batch/private.png",
        )
        assert status == 404
        status, _, _ = _request(
            opener,
            base_url + "/static/vendor/sortable-1.15.6.min.js",
        )
        assert status == 200

        bad_url = (
            base_url
            + "/desktop/bootstrap?token="
            + urllib.parse.quote(wrong_bootstrap, safe="")
        )
        status, body, _ = _request(opener, bad_url)
        assert status == 403
        assert wrong_bootstrap.encode() not in body

        bootstrap_url = (
            base_url
            + "/desktop/bootstrap?token="
            + urllib.parse.quote(bootstrap_token, safe="")
        )
        status, body, headers = _request(opener, bootstrap_url)
        assert status == 302
        assert headers["Location"].endswith("/")
        assert bootstrap_token.encode() not in body
        session_cookie = headers.get("Set-Cookie", "").lower()
        assert session_cookie.startswith("xiaoxi_product_detail_session=")
        assert "httponly" in session_cookie
        assert "secure" in session_cookie
        assert "samesite=none" in session_cookie
        assert "partitioned" in session_cookie

        status, body, headers = _request(opener, bootstrap_url)
        assert status == 302
        assert headers["Location"].endswith("/")
        assert bootstrap_token.encode() not in body

        fresh_opener = urllib.request.build_opener(_NoRedirect())
        status, body, _ = _request(fresh_opener, bootstrap_url)
        assert status == 409
        assert bootstrap_token.encode() not in body

        status, workspace_body, _ = _request(opener, base_url + "/")
        assert status == 200
        assert b'data-desktop-paid-disabled="true"' in workspace_body
        assert b'onclick="generateAiHtmlV2()"' not in workspace_body

        csrf_match = re.search(
            rb'<meta name="csrf-token" content="([^"]+)"', workspace_body
        )
        assert csrf_match is not None
        local_payload = json.dumps(
            {
                "product_title": "本地测试洗地机",
                "text": (
                    "品牌：测试品牌\n产品名称：本地测试洗地机\n"
                    "型号：LOCAL-500\n工作效率：5000㎡/h\n"
                    "清洗宽度：860mm\n优势：参数真实、无需联网"
                ),
            },
            ensure_ascii=False,
        ).encode("utf-8")
        status, body, _ = _request(
            opener,
            base_url + "/api/build/%E8%AE%BE%E5%A4%87%E7%B1%BB/parse-text",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-CSRFToken": csrf_match.group(1).decode("utf-8"),
            },
            body=local_payload,
        )
        assert status == 200, body.decode("utf-8", errors="replace")
        local_result = json.loads(body)
        assert local_result["model_name"] == "LOCAL-500"
        assert local_result["param_1_value"] == "5000㎡/h"
        assert local_result["_raw_parsed"]["brand"] == "测试品牌"

        boundary = "----xiaoxi-desktop-upload"
        multipart_body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="auto_rembg"\r\n\r\n'
            "1\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="offline.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode("utf-8") + b"offline-image-fixture" + (
            f"\r\n--{boundary}--\r\n"
        ).encode("utf-8")
        status, body, _ = _request(
            opener,
            base_url + "/api/upload",
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "X-CSRFToken": csrf_match.group(1).decode("utf-8"),
            },
            body=multipart_body,
        )
        assert status == 200, body.decode("utf-8", errors="replace")
        upload_result = json.loads(body)
        assert upload_result["rembg"] is False
        assert upload_result["cutout_status"] == "failed"
        assert upload_result["cutout_code"] == "CUTOUT_PROCESSING_FAILED"
        assert "path" not in upload_result
        assert upload_result["url"].startswith("/static/uploads/1/")
        status, _, _ = _request(opener, base_url + upload_result["url"])
        assert status == 200

        status, _, _ = _request(opener, base_url + "/static/uploads/999/private.png")
        assert status == 403
        # Removing provider keys must not hide already completed local results.
        owner_task = "history-owner"
        owner_dir = data_dir / "static" / "ai_refine_v2" / owner_task
        owner_dir.mkdir(parents=True)
        # Completed history must be a decodable PNG, not arbitrary text bytes.
        from PIL import Image
        Image.new("RGB", (256, 256), "white").save(owner_dir / "assembled.png", compress_level=0)
        (owner_dir / "_summary.json").write_text(
            json.dumps(
                {
                    "user_id": 1,
                    "mode": "real",
                    "total_cost_rmb": 0,
                    "blocks": [],
                    "raw_urls": [],
                }
            ),
            encoding="utf-8",
        )
        status, body, _ = _request(
            opener, base_url + f"/api/ai-refine-v2/status/{owner_task}"
        )
        assert status == 200, body.decode("utf-8", errors="replace")
        assert json.loads(body)["task_id"] == owner_task
        status, _, _ = _request(
            opener,
            base_url + f"/static/ai_refine_v2/{owner_task}/assembled.png",
        )
        assert status == 200
        status, body, _ = _request(
            opener,
            base_url + f"/api/workspace-results/ai-refine-v2/{owner_task}",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-CSRFToken": csrf_match.group(1).decode("utf-8"),
            },
            body=b"{}",
        )
        assert status == 200, body.decode("utf-8", errors="replace")
        status, body, _ = _request(
            opener,
            base_url + "/api/workspace-results/latest?kind=ai_refine_v2",
        )
        assert status == 200, body.decode("utf-8", errors="replace")
        latest = json.loads(body)
        assert latest["ok"] is True
        assert latest["result"]["task_id"] == owner_task

        foreign_task = "history-foreign"
        foreign_dir = data_dir / "static" / "ai_refine_v2" / foreign_task
        foreign_dir.mkdir(parents=True)
        (foreign_dir / "assembled.png").write_bytes(b"foreign-history")
        (foreign_dir / "_summary.json").write_text(
            json.dumps(
                {
                    "user_id": 999,
                    "mode": "real",
                    "total_cost_rmb": 0,
                    "blocks": [],
                    "raw_urls": [],
                }
            ),
            encoding="utf-8",
        )
        status, _, _ = _request(
            opener,
            base_url + f"/static/ai_refine_v2/{foreign_task}/assembled.png",
        )
        assert status == 403
        status, _, _ = _request(
            opener, base_url + f"/api/ai-refine-v2/status/{foreign_task}"
        )
        assert status == 403
        paid_paths = {
            "/api/generate-ai-images": "DESKTOP_PAID_ACTION_DISABLED",
            "/api/generate-ai-detail": "DESKTOP_PAID_ACTION_DISABLED",
            "/api/generate-ai-detail-html": "DESKTOP_PAID_ACTION_DISABLED",
            "/api/ai-refine-v2/execute": "DESKTOP_AI_REFINE_NOT_CONFIGURED",
        }
        for paid_path, expected_code in paid_paths.items():
            status, body, _ = _request(
                opener,
                base_url + paid_path,
                method="POST",
            )
            assert status == 503
            assert json.loads(body)["code"] == expected_code

        status, _, _ = _request(opener, base_url + "/auth/register")
        assert status == 404
        status, _, _ = _request(opener, base_url + "/admin/")
        assert status == 404

        status, body, _ = _request(
            opener,
            base_url + "/internal/shutdown",
            method="POST",
            headers={"x-xiaoxi-control-token": wrong_control},
        )
        assert status == 403
        assert wrong_control.encode() not in body

        status, body, _ = _request(
            opener,
            base_url + "/internal/shutdown",
            method="POST",
            headers={"x-xiaoxi-control-token": control_token},
        )
        assert status == 202
        assert json.loads(body)["ok"] is True
        process.wait(timeout=15)

        assert (data_dir / "database" / "wubaoyun.db").is_file()
        with sqlite3.connect(data_dir / "database" / "wubaoyun.db") as connection:
            desktop_user = connection.execute(
                "SELECT is_approved, is_admin, is_paid FROM users WHERE username = ?",
                ("xiaoxi-desktop",),
            ).fetchone()
        assert desktop_user == (1, 0, 1)
        for expected in (
            data_dir / "static" / "uploads",
            data_dir / "output",
            data_dir / "static" / "outputs",
            data_dir / "static" / "cache",
            data_dir / "static" / "ai_refine_v2",
        ):
            assert expected.is_dir(), expected

        source_listing_after = sorted(
            str(path.relative_to(APP_ROOT))
            for path in APP_ROOT.rglob("*")
            if "__pycache__" not in path.parts
        )
        assert source_listing_after == source_listing_before

        stderr = process.stderr.read()
        remaining_stdout = process.stdout.read()
        assert bootstrap_token not in stderr + remaining_stdout
        assert wrong_bootstrap not in stderr + remaining_stdout
        assert control_token not in stderr + remaining_stdout
        assert wrong_control not in stderr + remaining_stdout
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


def test_internal_routes_reject_non_loopback_and_expired_bootstrap(tmp_path):
    data_dir = tmp_path / "desktop-data"
    bootstrap_token = "bootstrap-" + ("c" * 48)
    control_token = "control-" + ("d" * 48)
    code = r"""
import json
import time
from pathlib import Path
import desktop_entry

config = desktop_entry.DesktopConfig(
    host="127.0.0.1",
    port=0,
    data_dir=Path(__import__("os").environ["TEST_DATA_DIR"]),
    bootstrap_token=__import__("os").environ["TEST_BOOTSTRAP_TOKEN"],
    control_token=__import__("os").environ["TEST_CONTROL_TOKEN"],
)
flask_app, contract = desktop_entry.create_desktop_application(
    config,
    shutdown_callback=lambda: None,
)
client = flask_app.test_client()
non_loopback_health = client.get(
    "/internal/health",
    environ_overrides={"REMOTE_ADDR": "198.51.100.10"},
).status_code
non_loopback_bootstrap = client.get(
    "/desktop/bootstrap",
    query_string={"token": config.bootstrap_token},
    environ_overrides={"REMOTE_ADDR": "198.51.100.10"},
).status_code
contract.bootstrap_expires_at = time.monotonic() - 1
expired = client.get(
    "/desktop/bootstrap",
    query_string={"token": config.bootstrap_token},
    environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
).status_code
print(json.dumps({
    "non_loopback_health": non_loopback_health,
    "non_loopback_bootstrap": non_loopback_bootstrap,
    "expired": expired,
}))
"""
    env = _clean_env()
    env.update(
        {
            "TEST_DATA_DIR": str(data_dir),
            "TEST_BOOTSTRAP_TOKEN": bootstrap_token,
            "TEST_CONTROL_TOKEN": control_token,
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=APP_ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result == {
        "non_loopback_health": 403,
        "non_loopback_bootstrap": 403,
        "expired": 410,
    }
    combined = completed.stdout + completed.stderr
    assert bootstrap_token not in combined
    assert control_token not in combined


def test_runtime_path_builder_syncs_immutable_assets_and_preserves_mutable_data(tmp_path):
    data_dir = tmp_path / "desktop-data"
    immutable_asset = data_dir / "static" / "css" / "design-system.css"
    immutable_asset.parent.mkdir(parents=True)
    immutable_asset.write_text("stale-packaged-asset", encoding="utf-8")
    preserved_upload = data_dir / "static" / "uploads" / "user-product.png"
    preserved_upload.parent.mkdir(parents=True)
    preserved_upload.write_bytes(b"user-preserved")
    paths = desktop_entry.prepare_runtime_paths(data_dir)

    assert paths.resource_dir == APP_ROOT
    assert paths.templates_dir == APP_ROOT / "templates"
    assert paths.data_dir == data_dir.resolve()
    assert paths.resource_dir not in paths.data_dir.parents
    assert all(
        path == paths.data_dir or paths.data_dir in path.parents
        for path in paths.mutable_paths().values()
    )
    assert immutable_asset.read_bytes() == (
        APP_ROOT / "static" / "css" / "design-system.css"
    ).read_bytes()
    assert preserved_upload.read_bytes() == b"user-preserved"


def test_packaged_workspace_has_no_runtime_cdn_dependencies():
    checked_files = [
        APP_ROOT / "static" / "css" / "design-system.css",
        APP_ROOT / "templates" / "assembled_base.html",
        APP_ROOT / "templates" / "workspace.html",
        APP_ROOT / "templates" / "batch" / "upload.html",
    ]
    forbidden_hosts = (
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "cdnjs.cloudflare.com",
        "cdn.jsdelivr.net",
        "unpkg.com",
    )

    for path in checked_files:
        source = path.read_text(encoding="utf-8")
        for host in forbidden_hosts:
            assert host not in source, f"{path.relative_to(APP_ROOT)} still depends on {host}"

    assert (APP_ROOT / "static" / "vendor" / "sortable-1.15.6.min.js").is_file()
    assert (APP_ROOT / "static" / "vendor" / "jszip-3.10.1.min.js").is_file()

def test_runtime_browser_launch_does_not_disable_sandbox_or_web_security():
    runtime_files = [
        APP_ROOT / "app.py",
        APP_ROOT / "batch_processor.py",
        APP_ROOT / "ai_compose_pipeline.py",
        APP_ROOT / "ai_refine_v2" / "pipeline_runner.py",
    ]
    for path in runtime_files:
        source = path.read_text(encoding="utf-8")
        assert "--no-sandbox" not in source, path.relative_to(APP_ROOT)
        assert "--disable-web-security" not in source, path.relative_to(APP_ROOT)
