from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid
from typing import Any

from .errors import ContentEngineError
from .render_mix import _windows_process_options


RENDER_FAILURE_TAXONOMY_VERSION = 1
RENDER_FAILURE_CLASSES = frozenset(
    {"capability", "transient-local", "contract", "security", "output-quality"}
)
MAX_WORKER_ENVELOPE_BYTES = 2 * 1024 * 1024
MAX_WORKER_RESPONSE_BYTES = 64 * 1024
MAX_PRIVATE_STDERR_BYTES = 16 * 1024
MAX_WORKER_RECOVERY_DIAGNOSTICS = 8
SAFE_CODE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
SAFE_RUNTIME_HASH = re.compile(r"^[a-f0-9]{64}$")
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400


class RemotionRenderError(ContentEngineError):
    def __init__(self, failure_class: str, code: str):
        if failure_class not in RENDER_FAILURE_CLASSES:
            failure_class = "contract"
        safe_code = code if SAFE_CODE.fullmatch(str(code or "")) else "renderer_failed"
        super().__init__(safe_code, f"Remotion render failed ({safe_code}).")
        self.failure_class = failure_class
        self.taxonomy_version = RENDER_FAILURE_TAXONOMY_VERSION


class RenderCancelledError(ContentEngineError):
    """A local control outcome, not a renderer failure eligible for fallback."""

    def __init__(self):
        super().__init__("render_cancelled", "The render was cancelled locally.")


def _is_unc_or_device(value: str) -> bool:
    normalized = str(value or "").replace("/", "\\")
    return normalized.startswith("\\\\") or normalized.startswith("\\?\\") or normalized.startswith("\\.\\")


def _has_reparse_component(path: Path) -> bool:
    current = path
    while True:
        try:
            stat = current.lstat()
        except OSError:
            return False
        if current.is_symlink() or bool(
            getattr(stat, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT
        ):
            return True
        if current.parent == current:
            return False
        current = current.parent


def _trusted_runtime_path(value: str | Path | None, *, directory: bool, code: str) -> Path:
    raw = str(value or "").strip()
    if not raw or _is_unc_or_device(raw):
        raise RemotionRenderError("capability" if not raw else "security", code)
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise RemotionRenderError("security", code)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise RemotionRenderError("capability", code) from error
    if _has_reparse_component(candidate):
        raise RemotionRenderError("security", "runtime_reparse_rejected")
    if directory and not resolved.is_dir():
        raise RemotionRenderError("capability", code)
    if not directory and not resolved.is_file():
        raise RemotionRenderError("capability", code)
    return resolved


def _kill_process_tree(process) -> None:
    if os.name == "nt" and isinstance(getattr(process, "pid", None), int):
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            shell=False,
            timeout=5,
            **_windows_process_options(),
        )
        return
    process.kill()


class RemotionWorkerClient:
    """One lazy, single-flight worker. Private paths only cross bounded stdin."""

    def __init__(
        self,
        *,
        data_dir: Path,
        node_path: str | Path | None = None,
        worker_path: str | Path | None = None,
        bundle_path: str | Path | None = None,
        browser_path: str | Path | None = None,
        popen_factory=subprocess.Popen,
        request_timeout_seconds: float = 2 * 60 * 60,
        electron_run_as_node: bool = False,
        tree_killer=_kill_process_tree,
    ):
        self.data_dir = Path(data_dir).resolve()
        self._configured = {
            "node": node_path or os.environ.get("XIAOXI_REMOTION_NODE_PATH"),
            "worker": worker_path or os.environ.get("XIAOXI_REMOTION_WORKER_PATH"),
            "bundle": bundle_path or os.environ.get("XIAOXI_REMOTION_BUNDLE_PATH"),
            "browser": browser_path or os.environ.get("XIAOXI_REMOTION_BROWSER_PATH"),
        }
        self._electron_run_as_node = electron_run_as_node or os.environ.get(
            "XIAOXI_REMOTION_ELECTRON_RUN_AS_NODE"
        ) == "1"
        self._popen = popen_factory
        self._tree_killer = tree_killer
        self._timeout = max(1.0, float(request_timeout_seconds))
        self._state_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._responses: queue.Queue[dict[str, Any] | None] = queue.Queue()
        self._process = None
        self._reader = None
        self._stderr_reader = None
        self._stderr_tail = bytearray()
        # These codes are deliberately content-free: the Electron diagnostics
        # path may surface them, whereas private stderr must never leave this
        # worker boundary. Keeping a tiny in-memory tail is enough to explain
        # a later fallback without retaining paths, prompts, or provider keys.
        self._worker_recovery_diagnostics = deque(
            maxlen=MAX_WORKER_RECOVERY_DIAGNOSTICS
        )
        self._closed = False
        self._runtime = None
        self._cancel_requested = threading.Event()

    @property
    def worker_recovery_diagnostics(self) -> tuple[str, ...]:
        """A bounded, safe-only record of worker lifecycle recoveries."""

        with self._state_lock:
            return tuple(self._worker_recovery_diagnostics)

    @property
    def capability(self) -> dict[str, Any]:
        if self._closed:
            return {
                "available": False,
                "code": "worker_closed",
                "failure_class": "transient-local",
                "taxonomy_version": RENDER_FAILURE_TAXONOMY_VERSION,
                "runtime_hash": None,
                "runtime_hash_includes_bundle": False,
            }
        try:
            runtime = self._resolve_runtime()
            result = self._request_result(
                {
                    "version": 1,
                    "id": uuid.uuid4().hex,
                    "method": "capability",
                    "private": {
                        "bundlePath": str(runtime["bundle"]),
                        "browserPath": str(runtime["browser"]),
                    },
                }
            )
            runtime_hash = str(result.get("runtime_hash") or "")
            if not SAFE_RUNTIME_HASH.fullmatch(runtime_hash):
                raise RemotionRenderError("contract", "runtime_hash_invalid")
            return {
                "available": True,
                "code": "ready",
                "failure_class": None,
                "taxonomy_version": RENDER_FAILURE_TAXONOMY_VERSION,
                "runtime_hash": runtime_hash,
                "runtime_hash_includes_bundle": True,
            }
        except RemotionRenderError as error:
            return {
                "available": False,
                "code": error.code,
                "failure_class": error.failure_class,
                "taxonomy_version": error.taxonomy_version,
                "runtime_hash": None,
                "runtime_hash_includes_bundle": False,
            }

    def _resolve_runtime(self):
        if self._runtime is not None:
            return self._runtime
        self._runtime = {
            "node": _trusted_runtime_path(
                self._configured["node"], directory=False, code="node_runtime_unavailable"
            ),
            "worker": _trusted_runtime_path(
                self._configured["worker"], directory=False, code="worker_unavailable"
            ),
            "bundle": _trusted_runtime_path(
                self._configured["bundle"], directory=True, code="bundle_unavailable"
            ),
            "browser": _trusted_runtime_path(
                self._configured["browser"], directory=False, code="browser_unavailable"
            ),
        }
        if not (self._runtime["bundle"] / "index.html").is_file():
            self._runtime = None
            raise RemotionRenderError("capability", "bundle_unavailable")
        return self._runtime

    def _child_environment(self) -> dict[str, str]:
        environment = {}
        # Chrome is launched by the worker as a child process. Keep the
        # environment allowlisted, but retain the Windows process-resolution
        # and profile variables that the browser launch pipe needs.
        for key in (
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "PATHEXT",
            "PATH",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ):
            value = str(os.environ.get(key) or "").strip()
            if value:
                environment[key] = value
        runtime_temp = self.data_dir / ".remotion-runtime"
        runtime_temp.mkdir(parents=True, exist_ok=True)
        environment.update(
            {
                "TEMP": str(runtime_temp),
                "TMP": str(runtime_temp),
                "NODE_ENV": "production",
                "NO_PROXY": "127.0.0.1,localhost",
                "PYTHONIOENCODING": "utf-8",
            }
        )
        if self._electron_run_as_node:
            environment["ELECTRON_RUN_AS_NODE"] = "1"
        return environment

    def _detach_worker_locked(self, expected_process=None):
        """Detach one session while holding ``_state_lock``.

        Reader threads must retain their own queue/tail objects. Otherwise a
        late EOF from a dead worker can be delivered into a replacement
        worker's response queue and make the fresh retry fail immediately.
        """

        process = self._process
        if process is None or (
            expected_process is not None and process is not expected_process
        ):
            return None
        session = (
            process,
            self._reader,
            self._stderr_reader,
            self._responses,
            self._stderr_tail,
        )
        self._process = None
        self._reader = None
        self._stderr_reader = None
        self._responses = queue.Queue()
        self._stderr_tail = bytearray()
        return session

    def _dispose_worker_session(
        self,
        session,
        *,
        terminate: bool,
        timeout_seconds: float = 0.25,
    ) -> None:
        """Close one detached session without affecting a replacement worker."""

        if session is None:
            return
        process, reader, stderr_reader, _responses, _stderr_tail = session
        try:
            running = process.poll() is None
        except (AttributeError, OSError):
            running = False
        if terminate and running:
            try:
                process.terminate()
            except (AttributeError, OSError):
                pass
            try:
                process.wait(timeout=max(0.01, float(timeout_seconds)))
            except (AttributeError, OSError):
                pass
            except subprocess.TimeoutExpired:
                try:
                    self._tree_killer(process)
                except (AttributeError, OSError, subprocess.TimeoutExpired):
                    pass
                try:
                    process.wait(timeout=1.0)
                except (AttributeError, OSError, subprocess.TimeoutExpired):
                    pass
        for worker_reader in (reader, stderr_reader):
            if worker_reader is not None and worker_reader.is_alive():
                worker_reader.join(timeout=0.25)
        for stream_name in ("stdin", "stdout", "stderr"):
            stream = getattr(process, stream_name, None)
            if stream is not None:
                try:
                    stream.close()
                except (AttributeError, OSError, ValueError):
                    pass

    def _reset_worker(self, *, reason: str, expected_process=None) -> bool:
        """Drop a broken worker session but keep this client usable.

        A pipe failure can occur before the child process updates its exit
        status on Windows. Treat its stdin as terminal either way, dispose of
        just that session, and let the caller's single retry start a genuinely
        fresh worker.
        """

        code = reason if reason in {"worker_pipe_failed", "worker_exited"} else "worker_restart"
        with self._state_lock:
            if self._closed:
                return False
            session = self._detach_worker_locked(expected_process)
            if session is None:
                return False
            self._worker_recovery_diagnostics.append(code)
        self._dispose_worker_session(session, terminate=True)
        return True

    def _start(self):
        stale_session = None
        spawn_error = None
        with self._state_lock:
            if self._closed:
                raise RemotionRenderError("transient-local", "worker_closed")
            if self._process is not None and self._process.poll() is None:
                return self._process
            stale_session = self._detach_worker_locked()
            runtime = self._resolve_runtime()
            try:
                process = self._popen(
                    [str(runtime["node"]), str(runtime["worker"])],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    shell=False,
                    env=self._child_environment(),
                    **_windows_process_options(),
                )
            except OSError as error:
                spawn_error = error
            else:
                responses: queue.Queue[dict[str, Any] | None] = queue.Queue()
                stderr_tail = bytearray()
                self._process = process
                self._responses = responses
                self._stderr_tail = stderr_tail
                self._reader = threading.Thread(
                    target=self._read_responses,
                    args=(process, responses),
                    name="xiaoxi-remotion-worker-output",
                    daemon=True,
                )
                self._reader.start()
                self._stderr_reader = threading.Thread(
                    target=self._drain_stderr,
                    args=(process, stderr_tail),
                    name="xiaoxi-remotion-worker-stderr",
                    daemon=True,
                )
                self._stderr_reader.start()
        # A worker observed as exited is no longer usable. Detach it before
        # starting the replacement, then dispose it outside the state lock so
        # a slow stream close cannot block the new session.
        self._dispose_worker_session(stale_session, terminate=False)
        if spawn_error is not None:
            raise RemotionRenderError("capability", "worker_spawn_failed") from spawn_error
        return process

    def _read_responses(self, process, responses):
        try:
            for line in process.stdout or ():
                if len(line.encode("utf-8", errors="replace")) > MAX_WORKER_RESPONSE_BYTES:
                    responses.put({"ok": False, "failureClass": "contract", "code": "worker_response_oversized"})
                    return
                try:
                    value = json.loads(line)
                except (TypeError, ValueError):
                    value = {"ok": False, "failureClass": "contract", "code": "worker_response_invalid"}
                responses.put(value if isinstance(value, dict) else None)
        finally:
            responses.put(None)

    def _drain_stderr(self, process, stderr_tail):
        stream = process.stderr
        if stream is None:
            return
        while True:
            try:
                chunk = stream.read(4096)
            except (OSError, ValueError):
                return
            if not chunk:
                return
            encoded = (
                chunk.encode("utf-8", errors="replace")
                if isinstance(chunk, str)
                else bytes(chunk)
            )
            stderr_tail.extend(encoded)
            if len(stderr_tail) > MAX_PRIVATE_STDERR_BYTES:
                del stderr_tail[:-MAX_PRIVATE_STDERR_BYTES]

    def _send(
        self, envelope: dict[str, Any]
    ) -> tuple[Any, queue.Queue[dict[str, Any] | None]]:
        encoded = json.dumps(
            envelope, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        if len(encoded.encode("utf-8")) > MAX_WORKER_ENVELOPE_BYTES:
            raise RemotionRenderError("contract", "worker_request_oversized")
        process = self._start()
        with self._state_lock:
            responses = self._responses
        try:
            with self._write_lock:
                process.stdin.write(encoded + "\n")
                process.stdin.flush()
        except (AttributeError, BrokenPipeError, OSError) as error:
            try:
                worker_exited = process.poll() is not None
            except (AttributeError, OSError):
                worker_exited = False
            code = "worker_exited" if worker_exited else "worker_pipe_failed"
            self._reset_worker(reason=code, expected_process=process)
            raise RemotionRenderError("transient-local", code) from error
        return process, responses

    def _request_result(self, envelope: dict[str, Any]) -> dict[str, Any]:
        request_id = str(envelope.get("id") or "")
        with self._request_lock:
            process, responses = self._send(envelope)
            deadline = time.monotonic() + self._timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.cancel()
                    raise RemotionRenderError("transient-local", "worker_timeout")
                try:
                    response = responses.get(timeout=min(remaining, 0.25))
                except queue.Empty:
                    if process.poll() is not None:
                        if self._cancel_requested.is_set():
                            raise RenderCancelledError()
                        self._reset_worker(
                            reason="worker_exited", expected_process=process
                        )
                        raise RemotionRenderError("transient-local", "worker_exited")
                    continue
                if response is None:
                    if self._cancel_requested.is_set():
                        raise RenderCancelledError()
                    self._reset_worker(
                        reason="worker_exited", expected_process=process
                    )
                    raise RemotionRenderError("transient-local", "worker_exited")
                if str(response.get("id") or "") != request_id:
                    continue
                if response.get("ok") is True:
                    result = response.get("result")
                    return result if isinstance(result, dict) else {}
                if (
                    self._cancel_requested.is_set()
                    or str(response.get("code") or "") == "render_cancelled"
                ):
                    raise RenderCancelledError()
                raise RemotionRenderError(
                    str(response.get("failureClass") or "contract"),
                    str(response.get("code") or "worker_failed"),
                )

    def render(
        self,
        *,
        source_path: Path,
        output_path: Path,
        public_props: dict[str, Any],
        expected_runtime_hash: str | None = None,
    ):
        source = Path(source_path).resolve(strict=True)
        output_candidate = Path(output_path)
        if output_candidate.is_symlink() or (
            output_candidate.exists() and _has_reparse_component(output_candidate)
        ):
            raise RemotionRenderError("security", "output_reparse_rejected")
        if output_candidate.exists():
            raise RemotionRenderError("contract", "output_already_exists")
        output = output_candidate.resolve()
        staging = output.parent.resolve(strict=True)
        if source.parent != staging or output.parent != staging:
            raise RemotionRenderError("security", "task_path_outside_staging")
        if source.is_symlink() or _has_reparse_component(source):
            raise RemotionRenderError("security", "task_reparse_rejected")
        expected_runtime_hash = str(expected_runtime_hash or "")
        if not SAFE_RUNTIME_HASH.fullmatch(expected_runtime_hash):
            raise RemotionRenderError("contract", "runtime_hash_invalid")
        runtime = self._resolve_runtime()
        envelope = {
            "version": 1,
            "id": uuid.uuid4().hex,
            "method": "render",
            "private": {
                "bundlePath": str(runtime["bundle"]),
                "browserPath": str(runtime["browser"]),
                "sourcePath": str(source),
                "outputPath": str(output),
                "expectedRuntimeHash": expected_runtime_hash,
            },
            "publicProps": public_props,
        }
        result = self._request_result(envelope)
        if not output.is_file():
            raise RemotionRenderError("output-quality", "worker_output_missing")
        if str(result.get("runtime_hash") or "") != expected_runtime_hash:
            raise RemotionRenderError("contract", "runtime_hash_mismatch")
        return result

    def cancel(self) -> None:
        self._cancel_requested.set()
        process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            encoded = json.dumps(
                {"version": 1, "id": uuid.uuid4().hex, "method": "cancel"},
                separators=(",", ":"),
            )
            with self._write_lock:
                process.stdin.write(encoded + "\n")
                process.stdin.flush()
        except (AttributeError, BrokenPipeError, OSError):
            pass

    def begin_task(self) -> None:
        self._cancel_requested.clear()

    def close(self, timeout_seconds: float = 3.0) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            session = self._detach_worker_locked()
        if session is None:
            return
        process, _reader, _stderr_reader, _responses, _stderr_tail = session
        try:
            running = process.poll() is None
        except (AttributeError, OSError):
            running = False
        if running:
            try:
                encoded = json.dumps(
                    {"version": 1, "id": uuid.uuid4().hex, "method": "close"},
                    separators=(",", ":"),
                )
                with self._write_lock:
                    process.stdin.write(encoded + "\n")
                process.stdin.flush()
            except (AttributeError, BrokenPipeError, OSError):
                pass
            try:
                process.wait(timeout=max(0.01, float(timeout_seconds)))
            except subprocess.TimeoutExpired:
                self._dispose_worker_session(
                    session, terminate=True, timeout_seconds=timeout_seconds
                )
                return
            except (AttributeError, OSError):
                pass
        self._dispose_worker_session(session, terminate=False)
