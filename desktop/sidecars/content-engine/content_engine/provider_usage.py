"""An append-only journal of actual provider requests, never prompts or secrets.

The start event is flushed before sending. An unmatched start survives a crash
as outcome_unknown; it is not evidence that a provider request was unbilled.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import math
from email.utils import parsedate_to_datetime
from pathlib import Path
import os
import re
import ssl
import threading
import time
import uuid

from .errors import ContentEngineError

_context = ContextVar("provider_usage_context", default={})
_write_lock = threading.Lock()
_request_admission = ContextVar("provider_request_admission", default=None)


@contextmanager
def request_budget(admit):
    """Charge every actual HTTP attempt, including rate and structure retries."""
    marker = _request_admission.set(admit)
    try:
        yield
    finally:
        _request_admission.reset(marker)

METRICS = ("input_tokens", "output_tokens", "cached_tokens", "total_tokens",
           "requested_characters", "billed_characters", "requested_audio_ms", "audio_ms", "generated_audio_ms")
CONTEXT_KEYS = ("task_id", "task_type", "batch_id", "project_id", "run_id", "session_id", "operation_id", "purpose")
ERROR_ORIGINS = frozenset({
    "gateway_rate_limit", "maintenance_rate_limit", "upstream",
    "gateway_transport", "maintenance_transport", "gateway_response",
    "coalesced_timeout",
})
MAX_RETRY_AFTER_SECONDS = 3_600
MAX_429_BACKOFF_SECONDS = 8


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe(value, limit=160):
    text = str(value or "")
    if len(text) > limit or not re.fullmatch(r"[\w .:()（）-]*", text) or re.search(r"(?:sk-|ak-|ltai|bearer)", text, re.I):
        return ""
    return text


def _count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return round(value)


def _first_count(*values):
    return next((clean for value in values if (clean := _count(value)) is not None), None)


def _header(headers, name):
    if not hasattr(headers, "get"):
        return ""
    value = headers.get(name)
    if value is None:
        value = headers.get(name.lower())
    return str(value or "").strip()


def _parse_retry_after(value, now=None):
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{1,5}", raw):
        return min(MAX_RETRY_AFTER_SECONDS, int(raw))
    try:
        target = parsedate_to_datetime(raw)
        if target.tzinfo is None:
            return None
        return min(MAX_RETRY_AFTER_SECONDS, max(0, math.ceil(target.timestamp() - (now or time.time()))))
    except (TypeError, ValueError, OverflowError):
        return None


def retry_delay_seconds(headers, attempt):
    """Return a safe bounded delay, or None when Retry-After exceeds our retry budget."""
    retry_after = _parse_retry_after(_header(headers, "Retry-After"))
    if retry_after is not None:
        return retry_after if retry_after <= MAX_429_BACKOFF_SECONDS else None
    return min(MAX_429_BACKOFF_SECONDS, 2 ** max(0, int(attempt) - 1))


def current_usage_context():
    scope = _context.get()
    return {key: _safe(scope.get(key)) for key in CONTEXT_KEYS}


class ProviderRateLimitRetry(Exception):
    def __init__(self, delay_seconds):
        super().__init__("provider_429_retry")
        self.code = "provider_429_retry"
        self.delay_seconds = max(0, int(delay_seconds))


def _transport_error_kind(error):
    reason = getattr(error, "reason", None)
    candidate = reason if reason is not None else error
    if isinstance(candidate, ssl.SSLCertVerificationError):
        return "tls_certificate"
    if isinstance(candidate, TimeoutError):
        return "timeout"
    if isinstance(candidate, ConnectionResetError):
        return "connection_reset"
    if isinstance(candidate, ConnectionAbortedError):
        return "connection_aborted"
    if isinstance(candidate, ConnectionRefusedError):
        return "connection_refused"
    return "transport_error"


def _append_event(root, record, event):
    if root is None:
        return
    try:
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        value = json.dumps({**record, "event": event}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with _write_lock, (root / "provider-usage.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise ContentEngineError("provider_usage_write_failed", "调用记录无法保存，已停止继续请求，请检查磁盘可用空间。") from error


def record_response_validation(record, validation, data_dir=None):
    if not record:
        return
    if validation not in {"accepted", "empty_response", "invalid_json", "invalid_schema"}:
        raise ValueError("invalid response validation state")
    record["response_validation"] = validation
    record["outcome"] = "succeeded" if validation == "accepted" else "invalid_response"
    _append_event(_context.get().get("data_dir") or data_dir, record, "response_validated")


@contextmanager
def usage_scope(data_dir=None, **values):
    scope = dict(_context.get())
    if data_dir is not None:
        scope["data_dir"] = Path(data_dir)
    scope.update({key: _safe(value) for key, value in values.items() if key in CONTEXT_KEYS and value is not None})
    if "correction_attempt" in values:
        scope["correction_attempt"] = max(1, int(values["correction_attempt"]))
    marker = _context.set(scope)
    try:
        yield scope
    finally:
        _context.reset(marker)


class ProviderRequest:
    def __init__(self, *, provider, kind, model="", purpose="", request_id="", attempt=1, data_dir=None, **metrics):
        context = _context.get()
        self.root = context.get("data_dir") or (Path(data_dir) if data_dir else None)
        self.started = time.monotonic()
        self.record = {"schema": 1, "call_id": str(uuid.uuid4()), "provider": _safe(provider),
                       "kind": kind if kind in {"llm", "tts", "asr", "lookup", "upload"} else "other",
                       "model": _safe(model), "requested_model": _safe(model),
                       **{key: _safe(context.get(key)) for key in CONTEXT_KEYS},
                       "started_at": _now(), "finished_at": None, "elapsed_ms": None,
                       "attempt": max(1, int(attempt)), "correction_attempt": context.get("correction_attempt", 1),
                       "client_request_id": _safe(request_id), "request_id": "", "log_id": "", "http_status": None,
                       "provider_code": "", "error_origin": "", "retry_after_seconds": None,
                       "transport_error": "", "outcome": "outcome_unknown", "error_code": "",
                       **{key: _count(metrics.get(key)) for key in METRICS}}
        self.record["purpose"] = _safe(purpose) or self.record["purpose"] or self.record["kind"]
        self.record["operation_id"] = self.record["operation_id"] or self.record["call_id"]

    def _append(self, event):
        _append_event(self.root, self.record, event)

    def __enter__(self):
        admit = _request_admission.get()
        if admit is not None:
            admit(self.record)
        self._append("request_started")
        return self

    def observe(self, payload=None, *, headers=None, http_status=None, **metrics):
        body = payload if isinstance(payload, dict) else {}
        headers = headers if hasattr(headers, "get") else {}
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        input_details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
        if not isinstance(input_details, dict):
            input_details = {}
        counts = {
            "input_tokens": _first_count(usage.get("prompt_tokens"), usage.get("input_tokens")),
            "output_tokens": _first_count(usage.get("completion_tokens"), usage.get("output_tokens")),
            "cached_tokens": _first_count(input_details.get("cached_tokens"), usage.get("cache_read_input_tokens"), usage.get("prompt_cache_hit_tokens")),
            "total_tokens": _count(usage.get("total_tokens")),
            "billed_characters": _first_count(usage.get("text_words"), usage.get("characters")),
            "audio_ms": _count((body.get("audio_info") or {}).get("duration")) if isinstance(body.get("audio_info"), dict) else None,
        }
        for key, value in {**counts, **{key: _count(value) for key, value in metrics.items() if key in METRICS}}.items():
            if value is not None:
                self.record[key] = value
        request_id = body.get("request_id") or body.get("id") or headers.get("X-Request-Id") or headers.get("x-request-id")
        if _safe(request_id):
            self.record["request_id"] = _safe(request_id)
        returned_model = _safe(body.get("model"))
        if returned_model:
            self.record["model"] = returned_model
        log_id = headers.get("X-Tt-Logid") or headers.get("x-tt-logid")
        if _safe(log_id):
            self.record["log_id"] = _safe(log_id)
        error_body = body.get("error") if isinstance(body.get("error"), dict) else {}
        code = body.get("code") or error_body.get("code")
        code = code or headers.get("X-Api-Status-Code") or headers.get("x-api-status-code")
        if _safe(code):
            self.record["provider_code"] = _safe(code)
        if type(http_status) is int:
            self.record["http_status"] = http_status
        origin = _header(headers, "X-Xiaoxi-Error-Origin")
        if origin in ERROR_ORIGINS:
            self.record["error_origin"] = origin
        retry_after = _parse_retry_after(_header(headers, "Retry-After"))
        if retry_after is not None:
            self.record["retry_after_seconds"] = retry_after

    def observe_transport_error(self, error):
        self.record["transport_error"] = _transport_error_kind(error)

    def __exit__(self, error_type, error, _traceback):
        if error is None:
            self.record["outcome"] = "succeeded"
        else:
            code = _safe(getattr(error, "code", "")) or _safe(error_type.__name__)
            self.record["error_code"] = code
            status = self.record["http_status"]
            if "unknown" in code:
                self.record["outcome"] = "outcome_unknown"
            elif status and status >= 500:
                self.record["outcome"] = "failed"
            elif (status and 400 <= status < 500) or "rejected" in code:
                self.record["outcome"] = "rejected"
            else:
                self.record["outcome"] = "outcome_unknown"
        self.record.update(finished_at=_now(), elapsed_ms=max(0, round((time.monotonic() - self.started) * 1000)))
        self._append("request_finished")
        return False


def observe_http_error(meter, error):
    """Read a bounded rejection only to extract approved counters and codes."""
    meter.observe(headers=getattr(error, "headers", None), http_status=getattr(error, "code", None))
    try:
        raw = error.read(65536)
        if len(raw) < 65536:
            meter.observe(json.loads(raw))
    except (ValueError, OSError, AttributeError, TypeError):
        pass


def provider_usage_summary(data_dir, *, task_ids=None, batch_id=None, limit=100):
    """Read locally recorded counters; missing counters never mean zero usage."""
    selected_ids = {str(value) for value in task_ids} if task_ids is not None else None
    calls, malformed = {}, 0
    filename = Path(data_dir) / "provider-usage.jsonl"
    try:
        with filename.open("r", encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict) or row.get("schema") != 1 or not row.get("call_id"):
                        raise ValueError()
                except (ValueError, TypeError):
                    malformed += 1
                    continue
                if selected_ids is not None and row.get("task_id") not in selected_ids:
                    continue
                if batch_id is not None and row.get("batch_id") != batch_id:
                    continue
                calls[row["call_id"]] = row
    except FileNotFoundError:
        pass
    rows = sorted(calls.values(), key=lambda row: (row.get("started_at", ""), row["call_id"]), reverse=True)
    totals = {"calls": len(rows), "succeeded_calls": 0, "rejected_calls": 0, "failed_calls": 0, "outcome_unknown_calls": 0}
    for outcome in ("succeeded", "rejected", "failed", "invalid_response", "outcome_unknown"):
        totals[f"{outcome}_calls"] = sum(row.get("outcome") == outcome for row in rows)
    for kind in ("llm", "tts", "asr"):
        totals[f"{kind}_calls"] = sum(row.get("kind") == kind for row in rows)
    for key in METRICS:
        kinds = {"llm"} if "tokens" in key else {"tts"} if "characters" in key or key == "generated_audio_ms" else {"asr"}
        relevant = [row for row in rows if row.get("kind") in kinds]
        known = [_count(row.get(key)) for row in relevant if _count(row.get(key)) is not None]
        totals[key] = sum(known) if known or not relevant else None
        totals[f"unknown_{key}_calls"] = sum(_count(row.get(key)) is None for row in relevant)
    maximum = max(1, min(2000, int(limit)))
    return {"items": [{key: value for key, value in row.items() if key != "event"} for row in rows[:maximum]],
            "totals": totals, "truncated": len(rows) > maximum, "malformed_events": malformed,
            "amount": None, "cost_status": "provider_bill_required"}
