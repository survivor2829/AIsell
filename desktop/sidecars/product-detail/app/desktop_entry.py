"""Desktop sidecar entry point for the product-detail Flask application.

The desktop process owns the lifecycle.  This module keeps the inherited Flask
application intact while enforcing a loopback-only server, isolated writable
state, one-time session bootstrap, and an authenticated shutdown endpoint.
"""

from __future__ import annotations

import argparse
import contextlib
import filecmp
import hashlib
import hmac
import importlib
import importlib.util
import ipaddress
import json
import os
import secrets
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from browser_runtime import playwright_available

from werkzeug.serving import WSGIRequestHandler, make_server


VERSION = "2.0.0-desktop"
RESOURCE_DIR = Path(__file__).resolve().parent
_MUTABLE_STATIC_ROOTS = {"uploads", "outputs", "cache", "ai_refine_v2"}
_TOKEN_MIN_LENGTH = 32


@dataclass(frozen=True)
class RuntimePaths:
    resource_dir: Path
    data_dir: Path
    templates_dir: Path
    static_dir: Path
    database_dir: Path
    database_file: Path
    uploads_dir: Path
    output_dir: Path
    static_outputs_dir: Path
    cache_dir: Path
    ai_refine_dir: Path

    def mutable_paths(self) -> dict[str, Path]:
        return {
            "data": self.data_dir,
            "database": self.database_dir,
            "uploads": self.uploads_dir,
            "output": self.output_dir,
            "static_outputs": self.static_outputs_dir,
            "cache": self.cache_dir,
            "ai_refine_v2": self.ai_refine_dir,
        }


@dataclass(frozen=True)
class DesktopConfig:
    host: str
    port: int
    data_dir: Path
    bootstrap_token: str
    control_token: str


@dataclass
class DesktopContract:
    bootstrap_digest: bytes
    control_digest: bytes
    bootstrap_expires_at: float
    bootstrap_consumed: bool
    bootstrap_in_progress: bool
    shutdown_callback: Callable[[], None]
    capabilities: dict[str, bool]
    lock: threading.Lock


class QuietRequestHandler(WSGIRequestHandler):
    """Disable access logging so query-string bootstrap tokens never leak."""

    def log_request(self, code="-", size="-") -> None:
        return None

    def log_error(self, format, *args) -> None:
        return None


def _resolve_data_dir(value: str | os.PathLike[str] | Path) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise ValueError("data-dir must be an absolute path")
    resolved = candidate.resolve()
    if resolved == RESOURCE_DIR or RESOURCE_DIR in resolved.parents:
        raise ValueError("data-dir must be outside the read-only resource directory")
    return resolved


def _is_loopback_address(value: str | None) -> bool:
    if not value:
        return False
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_loopback


def _sync_packaged_static_assets(source: Path, destination: Path) -> None:
    """Version immutable packaged assets while preserving user-owned runtime data."""

    destination.mkdir(parents=True, exist_ok=True)
    if not source.is_dir():
        return
    for source_path in source.rglob("*"):
        relative = source_path.relative_to(source)
        if relative.parts and relative.parts[0] in _MUTABLE_STATIC_ROOTS:
            continue
        destination_path = destination / relative
        if source_path.is_dir():
            destination_path.mkdir(parents=True, exist_ok=True)
        elif source_path.is_file():
            destination_path.parent.mkdir(parents=True, exist_ok=True)
            if destination_path.exists() and filecmp.cmp(
                source_path, destination_path, shallow=False
            ):
                continue
            temporary_path = destination_path.with_name(
                f".{destination_path.name}.sync-{os.getpid()}"
            )
            try:
                shutil.copy2(source_path, temporary_path)
                os.replace(temporary_path, destination_path)
            finally:
                temporary_path.unlink(missing_ok=True)


def prepare_runtime_paths(data_dir: str | os.PathLike[str] | Path) -> RuntimePaths:
    resolved = _resolve_data_dir(data_dir)
    paths = RuntimePaths(
        resource_dir=RESOURCE_DIR,
        data_dir=resolved,
        templates_dir=RESOURCE_DIR / "templates",
        static_dir=resolved / "static",
        database_dir=resolved / "database",
        database_file=resolved / "database" / "wubaoyun.db",
        uploads_dir=resolved / "static" / "uploads",
        output_dir=resolved / "output",
        static_outputs_dir=resolved / "static" / "outputs",
        cache_dir=resolved / "static" / "cache",
        ai_refine_dir=resolved / "static" / "ai_refine_v2",
    )
    for path in paths.mutable_paths().values():
        path.mkdir(parents=True, exist_ok=True)
    _sync_packaged_static_assets(RESOURCE_DIR / "static", paths.static_dir)
    return paths


def detect_capabilities(
    environ: Mapping[str, str] | None = None,
    *,
    verify_browser: bool = False,
) -> dict[str, bool]:
    values = environ or os.environ
    deepseek = bool(values.get("DEEPSEEK_API_KEY", "").strip())
    refine = bool(
        values.get("REFINE_API_KEY", "").strip()
        or values.get("GPT_IMAGE_API_KEY", "").strip()
    )
    refine_base = bool(values.get("REFINE_API_BASE_URL", "").strip())
    rembg_installed = importlib.util.find_spec("rembg") is not None
    rembg_model_dir = Path(
        values.get("U2NET_HOME", str(Path.home() / ".u2net"))
    ).expanduser()
    rembg_model = (rembg_model_dir / "isnet-general-use.onnx").is_file()
    return {
        "offline_workspace": True,
        "desktop_bootstrap": True,
        "deepseek_api": deepseek,
        "refine_api": refine,
        "paid_ai_ready": deepseek and refine and refine_base,
        "rembg_installed": rembg_installed,
        "rembg_model": rembg_model,
        "rembg": rembg_installed and rembg_model,
        "playwright": playwright_available(verify_launch=verify_browser),
    }


def _configure_environment(paths: RuntimePaths) -> None:
    os.environ["XIAOXI_PRODUCT_DETAIL_DESKTOP"] = "1"
    os.environ["XIAOXI_PRODUCT_DETAIL_DATA_DIR"] = str(paths.data_dir)
    os.environ["XIAOXI_PRODUCT_DETAIL_RESOURCE_DIR"] = str(paths.resource_dir)
    os.environ["DATABASE_URL"] = f"sqlite:///{paths.database_file.as_posix()}"
    os.environ["SECRET_KEY"] = secrets.token_hex(32)


def _token_digest(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def _token_matches(expected_digest: bytes, supplied: str) -> bool:
    return hmac.compare_digest(expected_digest, _token_digest(supplied))


def _validate_config(config: DesktopConfig) -> DesktopConfig:
    if not _is_loopback_address(config.host):
        raise ValueError("host must be a loopback address")
    if not 0 <= int(config.port) <= 65535:
        raise ValueError("port must be between 0 and 65535")
    data_dir = _resolve_data_dir(config.data_dir)
    if len(config.bootstrap_token) < _TOKEN_MIN_LENGTH:
        raise ValueError("bootstrap-token must contain at least 32 characters")
    if len(config.control_token) < _TOKEN_MIN_LENGTH:
        raise ValueError("control-token must contain at least 32 characters")
    return DesktopConfig(
        host=config.host,
        port=int(config.port),
        data_dir=data_dir,
        bootstrap_token=config.bootstrap_token,
        control_token=config.control_token,
    )


def _install_desktop_contract(
    flask_app,
    *,
    config: DesktopConfig,
    shutdown_callback: Callable[[], None],
    capabilities: dict[str, bool],
) -> DesktopContract:
    from flask import abort, g, jsonify, redirect, request, url_for
    from flask_login import current_user, login_user

    app_module = sys.modules["app"]
    db = app_module.db
    user_model = app_module.User
    csrf = app_module.csrf
    contract = DesktopContract(
        bootstrap_digest=_token_digest(config.bootstrap_token),
        control_digest=_token_digest(config.control_token),
        bootstrap_expires_at=time.monotonic() + 300,
        bootstrap_consumed=False,
        bootstrap_in_progress=False,
        shutdown_callback=shutdown_callback,
        capabilities=dict(capabilities),
        lock=threading.Lock(),
    )
    flask_app.extensions["xiaoxi_desktop_contract"] = contract

    def require_loopback() -> None:
        if not _is_loopback_address(request.remote_addr):
            abort(403)

    always_disabled_paid_endpoints = {
        "generate_ai_images",
        "generate_ai_detail",
        "generate_ai_detail_html",
        "regenerate_block_api",
    }
    paid_ai_ready = bool(contract.capabilities.get("paid_ai_ready"))
    csrf_exempt_endpoints = set(always_disabled_paid_endpoints)
    if not paid_ai_ready:
        csrf_exempt_endpoints.add("ai_refine_v2_execute")
    for endpoint in csrf_exempt_endpoints:
        view = flask_app.view_functions.get(endpoint)
        if view is not None:
            csrf.exempt(view)

    ledger_path = config.data_dir / "database" / "desktop-ai-refine-ledger.json"
    ledger_lock = threading.RLock()
    update_lock = threading.RLock()
    update_state = {"hold": False, "requests": 0}
    refine_terminal_states = {"success", "partial_success", "failed"}
    refine_blocking_states = {"outcome_unknown", "recovery_required"}
    def unreadable_refine_ledger() -> dict:
        return {
            "state": "outcome_unknown",
            "reason": "ledger_unreadable",
        }

    def read_refine_ledger() -> dict:
        with ledger_lock:
            try:
                value = json.loads(ledger_path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return {}
            except (OSError, json.JSONDecodeError):
                return unreadable_refine_ledger()
            return value if isinstance(value, dict) else unreadable_refine_ledger()

    def write_refine_ledger(value: dict) -> None:
        with ledger_lock:
            ledger_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = ledger_path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(temporary, ledger_path)

    def task_state(task_id: str) -> dict | None:
        if not task_id:
            return None
        from ai_refine_v2 import pipeline_runner
        return pipeline_runner.get_task_status(task_id)

    def refresh_refine_ledger() -> dict:
        with ledger_lock:
            ledger = read_refine_ledger()
            if ledger.get("state") not in {
                "pending", "outcome_unknown", "recovery_required",
            }:
                return ledger
            current = task_state(str(ledger.get("task_id") or ""))
            if current and current.get("status") in {
                *refine_terminal_states,
                *refine_blocking_states,
            }:
                ledger["state"] = str(current["status"])
                ledger[
                    "finished_at"
                    if current["status"] in refine_terminal_states
                    else "updated_at"
                ] = int(time.time())
                write_refine_ledger(ledger)
            elif ledger.get("task_id") and current is None:
                ledger["state"] = "outcome_unknown"
                write_refine_ledger(ledger)
            return ledger

    startup_ledger = read_refine_ledger()
    if startup_ledger.get("state") == "pending" and not startup_ledger.get("task_id"):
        startup_ledger["state"] = "outcome_unknown"
        write_refine_ledger(startup_ledger)
    @flask_app.context_processor
    def desktop_template_contract():
        return {"desktop_capabilities": dict(contract.capabilities)}

    @flask_app.before_request
    def desktop_enforce_boundaries():
        require_loopback()
        if request.method not in ("GET", "HEAD", "OPTIONS") and not request.path.startswith("/internal/"):
            with update_lock:
                if update_state["hold"]:
                    return jsonify({"ok": False, "error": "软件正在准备更新，请稍后再操作。"}), 503
                update_state["requests"] += 1
                g.xiaoxi_update_tracked = True
        endpoint = request.endpoint or ""
        if endpoint == "auth.register" or endpoint.startswith("admin."):
            abort(404)

        request_path = request.path
        if request_path.startswith("/static/ai_refine_v2/"):
            if not current_user.is_authenticated:
                abort(401)
            task_id = request_path[len("/static/ai_refine_v2/"):].split("/", 1)[0]
            state = task_state(task_id)
            if state is None:
                abort(404)
            owner_id = state.get("user_id")
            if owner_id != current_user.id and not current_user.is_admin:
                abort(403)
        if request_path.startswith("/static/uploads/batches/"):
            abort(404)

        for prefix in ("/static/uploads/", "/static/outputs/"):
            if not request_path.startswith(prefix):
                continue
            if not current_user.is_authenticated:
                abort(401)
            owner_part = request_path[len(prefix):].split("/", 1)[0]
            if not owner_part.isdigit():
                abort(404)
            if int(owner_part) != int(current_user.id):
                abort(403)

        if request_path.startswith("/static/cache/") and not current_user.is_authenticated:
            abort(401)

        if endpoint in always_disabled_paid_endpoints:
            if not current_user.is_authenticated:
                abort(401)
            return jsonify(
                {
                    "ok": False,
                    "code": "DESKTOP_PAID_ACTION_DISABLED",
                    "error": "该旧版付费 AI 操作未向桌面版开放。",
                }
            ), 503

        if endpoint == "ai_refine_v2_execute" and not paid_ai_ready:
            if not current_user.is_authenticated:
                abort(401)
            return jsonify(
                {
                    "ok": False,
                    "code": "DESKTOP_AI_REFINE_NOT_CONFIGURED",
                    "error": "请先配置 DeepSeek 和 APIMart 后重启产品详情图服务。",
                }
            ), 503
        if endpoint == "ai_refine_v2_execute":
            if not current_user.is_authenticated:
                abort(401)
            with ledger_lock:
                ledger = refresh_refine_ledger()
                if ledger.get("state") == "pending":
                    return jsonify(
                        {
                            "ok": False,
                            "code": "DESKTOP_AI_REFINE_ALREADY_RUNNING",
                            "error": "已有 AI 精修任务正在运行，请等待当前任务结束。",
                            "task_id": ledger.get("task_id") or "",
                        }
                    ), 409
                if ledger.get("state") == "outcome_unknown":
                    return jsonify(
                        {
                            "ok": False,
                            "code": "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN",
                            "error": "上次付费任务结果不明。为避免重复扣费，已停止新建任务。",
                            "task_id": ledger.get("task_id") or "",
                        }
                    ), 409
                if ledger.get("state") == "recovery_required":
                    return jsonify(
                        {
                            "ok": False,
                            "code": "DESKTOP_AI_REFINE_RECOVERY_REQUIRED",
                            "error": "上次付费任务已有结果，但本地下载或拼装尚未完成。请恢复原任务，不要重复提交。",
                            "task_id": ledger.get("task_id") or "",
                        }
                    ), 409
                request_bytes = request.get_data(cache=True) or b""
                write_refine_ledger(
                    {
                        "state": "pending",
                        "task_id": "",
                        "request_fingerprint": hashlib.sha256(request_bytes).hexdigest(),
                        "started_at": int(time.time()),
                    }
                )
                g.xiaoxi_ai_refine_started = True
        return None

    @flask_app.after_request
    def desktop_track_ai_refine(response):
        endpoint = request.endpoint or ""
        if (
            endpoint == "ai_refine_v2_status"
            and response.status_code == 404
            and current_user.is_authenticated
        ):
            task_id = str((request.view_args or {}).get("task_id") or "")
            with ledger_lock:
                ledger = read_refine_ledger()
                ledger_task_id = str(ledger.get("task_id") or "")
            if (
                ledger.get("state") == "outcome_unknown"
                and task_id
                and ledger_task_id
                and hmac.compare_digest(task_id, ledger_task_id)
            ):
                safe_response = jsonify(
                    {
                        "ok": False,
                        "code": "DESKTOP_AI_REFINE_OUTCOME_UNKNOWN",
                        "error": "原付费任务的本地状态已丢失，必须先人工核对 APIMart，不能自动重提。",
                        "task_id": task_id,
                    }
                )
                safe_response.status_code = 409
                return safe_response
        if endpoint == "ai_refine_v2_execute" and getattr(
            g, "xiaoxi_ai_refine_started", False
        ):
            with ledger_lock:
                ledger = read_refine_ledger()
                if 200 <= response.status_code < 300:
                    payload = response.get_json(silent=True) or {}
                    task_id = str(payload.get("task_id") or "")
                    if task_id and payload.get("mode") == "real":
                        ledger["task_id"] = task_id
                        ledger["state"] = "pending"
                    else:
                        ledger["state"] = "outcome_unknown"
                    write_refine_ledger(ledger)
                elif 400 <= response.status_code < 500:
                    ledger["state"] = "failed"
                    ledger["reason"] = "not_started"
                    ledger["finished_at"] = int(time.time())
                    write_refine_ledger(ledger)
                else:
                    ledger["state"] = "outcome_unknown"
                    ledger["reason"] = "server_error_after_admission"
                    write_refine_ledger(ledger)
        elif endpoint in {
            "ai_refine_v2_status", "ai_refine_v2_recover",
        } and response.status_code == 200:
            payload = response.get_json(silent=True) or {}
            if payload.get("status") in {
                *refine_terminal_states,
                *refine_blocking_states,
            }:
                with ledger_lock:
                    ledger = read_refine_ledger()
                    if str(ledger.get("task_id") or "") == str(payload.get("task_id") or ""):
                        ledger["state"] = str(payload["status"])
                        ledger[
                            "finished_at"
                            if payload["status"] in refine_terminal_states
                            else "updated_at"
                        ] = int(time.time())
                        write_refine_ledger(ledger)
        return response

    @flask_app.teardown_request
    def desktop_complete_update_request(_error):
        if getattr(g, "xiaoxi_update_tracked", False):
            with update_lock:
                update_state["requests"] = max(0, update_state["requests"] - 1)

    def internal_update_state():
        require_loopback()
        if not _token_matches(contract.control_digest, request.headers.get("x-xiaoxi-control-token", "")):
            return jsonify({"ok": False, "error": "forbidden"}), 403
        import batch_queue
        with update_lock:
            update_state["hold"] = (request.get_json(silent=True) or {}).get("hold") is True
            pending_requests = update_state["requests"]
        pools = batch_queue.get_pool_stats()
        ledger = refresh_refine_ledger()
        busy = pending_requests > 0 or any(pools[name]["active"] or pools[name]["queued"] for name in ("batch_pool", "single_pool", "refine_pool"))
        busy = busy or ledger.get("state") in ("pending", "running", "submitting", "queued", "starting")
        return jsonify({"ok": True, "busy": bool(busy)})

    flask_app.add_url_rule("/internal/update-state", endpoint="xiaoxi_internal_update_state", view_func=internal_update_state, methods=["POST"])
    csrf.exempt(internal_update_state)

    def internal_health():
        require_loopback()
        return jsonify(
            {
                "ok": True,
                "status": "ready",
                "version": VERSION,
                "mode": "desktop",
                "capabilities": contract.capabilities,
            }
        )

    def desktop_bootstrap():
        require_loopback()
        if current_user.is_authenticated:
            return redirect(url_for("index"))
        supplied = request.args.get("token", "")
        with contract.lock:
            if contract.bootstrap_consumed or contract.bootstrap_in_progress:
                return jsonify({"ok": False, "error": "bootstrap_unavailable"}), 409
            if time.monotonic() > contract.bootstrap_expires_at:
                return jsonify({"ok": False, "error": "bootstrap_expired"}), 410
            if not _token_matches(contract.bootstrap_digest, supplied):
                return jsonify({"ok": False, "error": "forbidden"}), 403
            contract.bootstrap_in_progress = True

        try:
            user = user_model.query.filter_by(username="xiaoxi-desktop").first()
            if user is None:
                user = user_model(
                    username="xiaoxi-desktop",
                    is_admin=False,
                    is_paid=True,
                    is_approved=True,
                )
                user.set_password(secrets.token_urlsafe(48))
                db.session.add(user)
            else:
                user.is_admin = False
                user.is_paid = True
                user.is_approved = True
            db.session.commit()
            login_user(user, remember=False, force=True, fresh=True)
        except Exception:
            db.session.rollback()
            with contract.lock:
                contract.bootstrap_in_progress = False
            raise

        with contract.lock:
            contract.bootstrap_consumed = True
            contract.bootstrap_in_progress = False
        return redirect(url_for("index"))

    def resolve_ai_refine_unknown():
        require_loopback()
        if not current_user.is_authenticated:
            abort(401)
        data = request.get_json(silent=True) or {}
        if data.get("confirm_new_task") is not True:
            return jsonify({"ok": False, "error": "需要明确确认后才能解除。"}), 400
        with ledger_lock:
            ledger = refresh_refine_ledger()
            if ledger.get("state") != "outcome_unknown":
                return jsonify({"ok": False, "error": "当前没有结果不明的任务。"}), 409
            ledger["state"] = "resolved_unknown"
            ledger["resolved_at"] = int(time.time())
            write_refine_ledger(ledger)
        return jsonify({"ok": True, "status": "resolved_unknown"})
    def internal_shutdown():
        require_loopback()
        supplied = request.headers.get("x-xiaoxi-control-token", "")
        if not _token_matches(contract.control_digest, supplied):
            return jsonify({"ok": False, "error": "forbidden"}), 403
        contract.shutdown_callback()
        return jsonify({"ok": True, "status": "stopping"}), 202

    flask_app.add_url_rule(
        "/internal/health",
        endpoint="xiaoxi_internal_health",
        view_func=internal_health,
        methods=["GET"],
    )
    flask_app.add_url_rule(
        "/desktop/bootstrap",
        endpoint="xiaoxi_desktop_bootstrap",
        view_func=desktop_bootstrap,
        methods=["GET"],
    )
    flask_app.add_url_rule(
        "/desktop/ai-refine-v2/resolve-unknown",
        endpoint="xiaoxi_ai_refine_resolve_unknown",
        view_func=resolve_ai_refine_unknown,
        methods=["POST"],
    )
    flask_app.add_url_rule(
        "/internal/shutdown",
        endpoint="xiaoxi_internal_shutdown",
        view_func=internal_shutdown,
        methods=["POST"],
    )
    csrf.exempt(internal_shutdown)
    return contract


def create_desktop_application(
    config: DesktopConfig,
    *,
    shutdown_callback: Callable[[], None],
):
    config = _validate_config(config)
    paths = prepare_runtime_paths(config.data_dir)
    _configure_environment(paths)
    # A packaged sidecar must prove the shared Chromium can start before it
    # advertises browser features. Merely finding chrome.exe lets a partial
    # portable extraction fail later during an export.
    capabilities = detect_capabilities(verify_browser=True)
    with contextlib.redirect_stdout(sys.stderr):
        app_module = importlib.import_module("app")
    app_module.app.config.update(
        # The packaged renderer is file:// and embeds this loopback service.
        # A partitioned cookie keeps the desktop login session available in
        # that iframe without weakening the application's CSRF protection.
        SESSION_COOKIE_NAME="xiaoxi_product_detail_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="None",
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_PARTITIONED=True,
    )
    contract = _install_desktop_contract(
        app_module.app,
        config=config,
        shutdown_callback=shutdown_callback,
        capabilities=capabilities,
    )
    return app_module.app, contract


def self_check(data_dir: Path) -> dict:
    paths = prepare_runtime_paths(data_dir)
    return {
        "ok": True,
        "mode": "desktop",
        "version": VERSION,
        "resource_dir": str(paths.resource_dir),
        "data_dir": str(paths.data_dir),
        "templates_dir": str(paths.templates_dir),
        "static_dir": str(paths.static_dir),
        "mutable_paths": {
            name: str(path) for name, path in paths.mutable_paths().items()
        },
        "capabilities": detect_capabilities(verify_browser=True),
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Xiaoxi product-detail desktop sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--bootstrap-token", default="")
    parser.add_argument("--control-token", default="")
    parser.add_argument("--self-check", action="store_true")
    return parser


def _parse_args(argv: list[str] | None = None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        args.data_dir = _resolve_data_dir(args.data_dir)
        if not _is_loopback_address(args.host):
            raise ValueError("host must be a loopback address")
        if not 0 <= args.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        if not args.self_check:
            if len(args.bootstrap_token) < _TOKEN_MIN_LENGTH:
                raise ValueError("bootstrap-token must contain at least 32 characters")
            if len(args.control_token) < _TOKEN_MIN_LENGTH:
                raise ValueError("control-token must contain at least 32 characters")
    except ValueError as exc:
        parser.error(str(exc))
    return args


def _run_server(config: DesktopConfig, protocol_stdout) -> int:
    holder: dict[str, object] = {}

    def request_shutdown() -> None:
        server = holder.get("server")
        if server is None:
            return
        threading.Thread(target=server.shutdown, daemon=True).start()

    flask_app, contract = create_desktop_application(
        config,
        shutdown_callback=request_shutdown,
    )
    server = make_server(
        config.host,
        config.port,
        flask_app,
        threaded=True,
        request_handler=QuietRequestHandler,
    )
    holder["server"] = server
    ready = {
        "event": "ready",
        "host": config.host,
        "port": server.server_port,
        "version": VERSION,
        "capabilities": contract.capabilities,
    }
    protocol_stdout.write(json.dumps(ready, ensure_ascii=False) + "\n")
    protocol_stdout.flush()
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.self_check:
        sys.stdout.write(json.dumps(self_check(args.data_dir), ensure_ascii=False) + "\n")
        return 0

    config = DesktopConfig(
        host=args.host,
        port=args.port,
        data_dir=args.data_dir,
        bootstrap_token=args.bootstrap_token,
        control_token=args.control_token,
    )
    protocol_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        return _run_server(config, protocol_stdout)


if __name__ == "__main__":
    raise SystemExit(main())
