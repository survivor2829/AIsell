"""Built-in supplier list prices and a per-task cost journal, never a billing system.

List prices bound requests; only a provider bill can establish actual cost.
The journal is written before POST, so an interrupted request cannot be repeated.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
import urllib.error
import uuid
from pathlib import Path
from ai_refine_v2.image_profile import normalize_profile

# A screen the provider plainly failed (or that was never sent) gets one more
# try. An unknown outcome is never retried.
MAX_ATTEMPTS_PER_SCREEN = 2
_LOCK = threading.RLock()


class PricingRequired(RuntimeError):
    code = "AI_REFINE_PRICING_REQUIRED"
    do_not_retry = True


class RequestOutcomeUnknown(RuntimeError):
    code = "AI_REFINE_OUTCOME_UNKNOWN"
    do_not_retry = True
    outcome_unknown = True

    def __init__(self, message, *, not_submitted=False):
        super().__init__(message)
        self.not_submitted = not_submitted


def _image_failure_diagnostic(exc):
    """Keep bounded metadata only; exception messages can contain keys or bodies."""
    allowed_types = {"APIMartError", "APIMartNotSubmitted", "APIMartOutcomeUnknown",
                     "APIMartTaskFailed", "APIMartReferenceUploadTransportError",
                     "TypeError", "ValueError", "RuntimeError", "TimeoutError", "URLError", "OSError"}
    error_type = type(exc).__name__
    stage = getattr(exc, "stage", "unknown")
    diagnostic = {"error_type": error_type if error_type in allowed_types else "Exception",
                  "stage": stage if stage in {"reference_prepare", "reference_upload", "submit", "poll", "checkpoint", "receipt"} else "unknown"}
    status = getattr(exc, "http_status", None)
    if type(status) is int and 100 <= status <= 599:
        diagnostic["http_status"] = status
    poll_reason = getattr(exc, "poll_reason", None)
    if poll_reason in {"timeout", "connection"}:
        diagnostic["poll_reason"] = poll_reason
    return diagnostic


def money(value):
    return math.ceil((float(value) - 1e-10) * 10000) / 10000


def _positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("invalid price")
    return number


# Built-in list prices (USD per image / CNY per million tokens), read 2026-11-03
# from the suppliers' public price pages. Used only to bound spend against the
# per-task cap; the supplier bill is the real cost. Prices are no longer fetched
# live: a slow or changed price page must never block the customer.
IMAGE_LIST_USD = {
    ("gpt-image-2", None, "1K"): 0.2109,
    ("gpt-image-2.5-ext", "sunburst", "2K"): 0.0375,
}
PLANNER_PER_MILLION_CNY = {"input": 2.0, "cache": 0.04, "output": 8.0}
PRICE_TABLE_DATE = "2026-11-03"


def read_quote(*, include_planner=True, image_profile=None):
    from ai_refine_v2 import refine_planner
    try:
        profile = normalize_profile(image_profile)
        usd = _positive(IMAGE_LIST_USD[(profile["model"], profile.get("version"), profile["resolution"])])
        fx = _positive(os.environ.get("REFINE_BUDGET_CNY_PER_USD", "8"))
    except Exception:
        raise PricingRequired("生图配置不可识别，未提交新的付费请求。") from None
    quote = {"version": 1, "checked_at": time.time(), "image_model": profile["model"],
             "image_resolution": profile["resolution"], "image_unit_usd": usd,
             **({"image_version": profile["version"]} if profile.get("version") else {}),
             "fx_cny_per_usd": fx, "image_unit_cny": money(usd * fx),
             "sources": [f"built-in:{PRICE_TABLE_DATE}"],
             "note": "内置公开标价保守估算；实际扣款以供应商账单为准"}
    if include_planner:
        quote.update(planner_model=refine_planner._MODEL_DEFAULT,
                     planner_per_million_cny=dict(PLANNER_PER_MILLION_CNY))
    return quote


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class CostJournal:
    @staticmethod
    def _request_error(exc):
        # Never persist exception strings, URLs, headers or supplier messages:
        # they can contain credentials or echoed customer inputs.
        result = {"type": type(exc).__name__, "at": time.time()}
        if isinstance(exc, urllib.error.HTTPError):
            result["http_status"] = exc.code
            origin = exc.headers.get("X-Xiaoxi-Error-Origin", "") if exc.headers else ""
            if origin in {"gateway_transport", "gateway_rate_limit", "coalesced_timeout", "upstream"}:
                result["origin"] = origin
            try:
                raw = exc.read(65536)
            except Exception:
                return result
            result["body_sha256"] = hashlib.sha256(raw).hexdigest()
            try:
                data = json.loads(raw)
                error = data.get("error")
                code = error.get("code") if isinstance(error, dict) else error
                if code in ("provider_unavailable", "receipt_not_found", "operation_outcome_unknown",
                            "session_required", "rate_limit", "provider_request_coalesced_timeout",
                            "invalid_request_error", "authentication_error", "insufficient_balance",
                            "invalid_api_key", "context_length_exceeded"):
                    result["code"] = code
            except (ValueError, AttributeError):
                pass
        elif isinstance(exc, urllib.error.URLError):
            result["reason_type"] = type(exc.reason).__name__
        return result

    @staticmethod
    def is_unsubmitted(operation):
        return (operation.get("status") == "failed" and operation.get("not_submitted") is True
                and not operation.get("provider_task_id") and not operation.get("raw_url"))

    def __init__(self, task_dir: Path):
        self.path = task_dir / "_costs.json"

    def load(self):
        if not self.path.exists():
            return {"version": 1, "operations": {}, "estimated_cny": None}
        try:
            result = json.loads(self.path.read_text(encoding="utf-8"))
            if result.get("version") != 1 or not isinstance(result.get("operations"), dict):
                raise ValueError("journal shape")
            for operation in result["operations"].values():
                _positive(operation["reserved_cny"])
                if operation.get("status") not in {"submitting", "outcome_unknown", "completed", "failed"}:
                    raise ValueError("journal operation")
            return result
        except Exception:
            raise RequestOutcomeUnknown("费用记录无法读取，已停止提交；请先核对原任务。") from None

    def summary(self):
        data = self.load()
        operations = list(data["operations"].values())
        in_flight = sum(op["reserved_cny"] for op in operations if op["status"] in {"submitting", "outcome_unknown"})
        pending_bill = sum(op["reserved_cny"] for op in operations if op["status"] in {"completed", "failed"} and not op.get("not_submitted"))
        return {"version": 1, "estimated_cny": data.get("estimated_cny"),
                "reserved_cny": money(in_flight), "pending_bill_cny": money(pending_bill),
                "actual_cny": None, "bill_status": "pending" if any(not op.get("not_submitted") for op in operations) else "not_submitted",
                "quote": data.get("quote"), "note": "预留和估算不是实际扣款，账单待核对"}

    def _ensure_room(self, data, addition):
        from pricing_config import MAX_REFINE_COST_PER_RUN
        cap = _positive(MAX_REFINE_COST_PER_RUN)
        committed = sum(op["reserved_cny"] for op in data["operations"].values() if not op.get("not_submitted"))
        if money(committed + addition) > cap:
            raise PricingRequired(f"当前方案保守预留约 ¥{committed + addition:.2f}，超过后台单任务上限 ¥{cap:.2f}；方案已保留，尚未提交后续生图。")

    def set_plan(self, quote, count, *, completed_blocks=None):
        if type(count) is not int or not 1 <= count <= 18:  # 15 detail screens + 3 squares
            raise PricingRequired("方案图片数量无效，尚未提交生图。")
        with _LOCK:
            data = self.load()
            images = [op for name, op in data["operations"].items() if name.startswith("image:")]
            if images:
                # Continuation may purchase only blocks with no prior operation.
                # Fail closed on legacy receipts without stable block identity.
                if (completed_blocks is None or any(
                        not op.get("block_id") or not (
                            (op["status"] == "completed" and op["block_id"] in completed_blocks)
                            or self.is_unsubmitted(op)) for op in images)
                        or len({op["block_id"] for op in images}) != len(images)):
                    raise RequestOutcomeUnknown("原方案已有付费请求待核对，禁止重复提交。")
            remaining = money((count - len(completed_blocks or {})) * quote["image_unit_cny"])
            data.update(quote=quote, image_count=count,
                        estimated_cny=money(remaining + sum(op["reserved_cny"] for op in data["operations"].values() if not op.get("not_submitted"))))
            _write(self.path, data)
            self._ensure_room(data, remaining)

    def begin(self, name, quote, reserve, *, retry_not_submitted=False, **context):
        with _LOCK:
            data = self.load()
            previous = data["operations"].get(name)
            if previous and not (retry_not_submitted and self.is_unsubmitted(previous)):
                raise RequestOutcomeUnknown("原请求已有费用记录，只能核对原结果，不能重复提交。")
            self._ensure_room(data, reserve)
            data["operations"][name] = {"status": "submitting", "reserved_cny": money(reserve), "started_at": time.time(), **context}
            if previous:
                data["operations"][name]["previous_attempts"] = [
                    *previous.get("previous_attempts", []),
                    {k: v for k, v in previous.items() if k != "previous_attempts"},
                ]
            data["quote"] = quote
            data["operations"][name]["quote"] = quote
            _write(self.path, data)

    def finish(self, name, status, **receipt):
        with _LOCK:
            data = self.load()
            data["operations"][name].update(status=status, **receipt)
            _write(self.path, data)

    def _planner_response_path(self, operation):
        if operation not in {"planner", "semantic_review"}:
            raise ValueError("unsupported planning operation")
        return self.path.parent / f"_{operation}_response.json"

    def saved_planner_response(self, operation="planner"):
        """Replay a durably saved paid response, including a crash before finish()."""
        with _LOCK:
            path = self._planner_response_path(operation)
            if operation not in self.load()["operations"]:
                return None
            if not path.exists():
                return None
            try:
                response = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(response, dict):
                    raise ValueError("planner response shape")
            except Exception:
                raise RequestOutcomeUnknown("已付费策划回执无法读取，禁止重新提交策划。") from None
            self._finish_planner(response, operation)
            return response

    def _finish_planner(self, response, operation="planner"):
        usage = response.get("usage") or {}
        safe_usage = {k: v for k, v in usage.items() if k in {"prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"} and isinstance(v, (int, float))}
        self.finish(operation, "completed", provider_request_id=str(response.get("id") or ""), usage=safe_usage)

    def planner_call(self, quote, body, key, *, operation="planner"):
        from ai_refine_v2.refine_planner import _http_post_deepseek, _planner_receipt_origin
        response_path = self._planner_response_path(operation)
        request_hash = hashlib.sha256(json.dumps(body["messages"], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        saved = self.saved_planner_response(operation)
        if saved is not None:
            if operation == "semantic_review" and self.load()["operations"][operation].get("request_sha256") != request_hash:
                raise RequestOutcomeUnknown("原语义评审与当前输入不一致，保留回执，禁止静默复用或重提。")
            return saved
        # UTF-8 bytes conservatively bound BPE tokens; include chat framing.
        input_bound = len(json.dumps(body["messages"], ensure_ascii=False).encode("utf-8")) + 1024
        rates = quote["planner_per_million_cny"]
        reserve = money((input_bound * rates["input"] + body["max_tokens"] * rates["output"]) / 1_000_000)
        operation_id = uuid.uuid4().hex
        self.begin(operation, quote, reserve, request_sha256=request_hash,
                   gateway_operation_id=operation_id, gateway_origin=_planner_receipt_origin())
        try:
            # Persist the exact payload, but never the credential, before sending.
            _write(self.path.parent / f"_{operation}_request.json", body)
            response = _http_post_deepseek(body, key, operation_id)
        except Exception as exc:
            self.finish(operation, "outcome_unknown", request_error=self._request_error(exc))
            raise RequestOutcomeUnknown("策划请求结果不明，已保留费用预留；不会自动重新策划。") from None
        # Retain the response before schema parsing: even invalid JSON was paid.
        _write(response_path, response)
        self._finish_planner(response, operation)
        return response

    def query_planner_response(self, key, operation="planner"):
        from ai_refine_v2.refine_planner import _query_deepseek_receipt, _planner_receipt_origin
        saved = self.saved_planner_response(operation)
        if saved is not None:
            return "recovered"
        entry = self.load()["operations"].get(operation)
        if not entry:
            return "not_submitted"
        origin = _planner_receipt_origin()
        if not entry.get("gateway_operation_id") or not origin or entry.get("gateway_origin") != origin:
            return "receipt_unavailable"
        try:
            response = _query_deepseek_receipt(entry["gateway_operation_id"], key)
            if response is None:
                return "pending"
            if not isinstance(response, dict) or not isinstance(response.get("choices"), list) or not response["choices"]:
                raise ValueError("invalid_planner_receipt")
            _write(self._planner_response_path(operation), response)
            self._finish_planner(response, operation)
            return "recovered"
        except Exception as exc:
            self.finish(operation, entry["status"], query_error=self._request_error(exc),
                        last_query_at=time.time())
            return "outcome_unknown"

    def image_call(self, quote, function, *args, block_id="", lifecycle_callback=None, retry_not_submitted=False, **kwargs):
        if "image_profile" in kwargs:
            profile = normalize_profile(kwargs["image_profile"])
            if (quote.get("image_model") != profile["model"]
                    or quote.get("image_resolution") != profile["resolution"]
                    or quote.get("image_version") != profile.get("version")):
                raise PricingRequired("生图配置与核价不一致，未提交新的付费请求。")
        with _LOCK:
            data = self.load()
            previous = [op for name, op in data["operations"].items() if name.startswith("image:")]
            existing = [(name, op) for name, op in data["operations"].items()
                        if name.startswith("image:") and block_id and op.get("block_id") == block_id]
            retry = (len(existing) == 1 and retry_not_submitted and self.is_unsubmitted(existing[0][1]))
            # Every earlier attempt at this screen plainly failed: try it again.
            # Continuing a task is the customer's own request, so it may try again.
            another_try = (bool(existing) and not retry
                           and (retry_not_submitted or len(existing) < MAX_ATTEMPTS_PER_SCREEN)
                           and all(op["status"] == "failed" for _, op in existing))
            if existing and not (retry or another_try):
                raise RequestOutcomeUnknown("该屏已有付费记录，只能恢复原结果，不能重复提交。")
            if any(op["status"] == "outcome_unknown" for op in previous):
                raise RequestOutcomeUnknown("已有生图结果不明，已停止后续付费请求。", not_submitted=True)
            # A plainly failed attempt does not use up one of the planned screens;
            # the per-task cost cap still bounds every attempt.
            used = [op for op in previous if op["status"] != "failed"]
            if not retry and len(used) >= data.get("image_count", 0):
                raise PricingRequired("生成张数超出已核价方案，已停止新增请求。")
            operation = existing[0][0] if retry else f"image:{len(previous) + 1}"
            self.begin(operation, quote, quote["image_unit_cny"], block_id=str(block_id), retry_not_submitted=retry)
        receipt = {}
        def checkpoint(event):
            receipt.update({key: event[key] for key in ("provider_task_id", "raw_url", "gateway_operation_id") if event.get(key)})
            if event.get("provider_receipt"):
                receipt["provider_receipt"] = event["provider_receipt"]
            self.finish(operation, "submitting", **receipt)
            if lifecycle_callback:
                lifecycle_callback(event)
        try:
            result = function(*args, lifecycle_callback=checkpoint, **kwargs)
        except Exception as exc:
            from ai_image_apimart import APIMartNotSubmitted, APIMartTaskFailed
            if getattr(exc, "task_id", ""):
                receipt.setdefault("provider_task_id", exc.task_id)
            not_submitted = isinstance(exc, APIMartNotSubmitted) and not any(receipt.get(key) for key in ("provider_task_id", "raw_url"))
            known_failure = not_submitted or isinstance(exc, APIMartTaskFailed)
            diagnostic = _image_failure_diagnostic(exc)
            self.finish(operation, "failed" if known_failure else "outcome_unknown",
                        not_submitted=not_submitted, diagnostic=diagnostic, **receipt)
            if known_failure:
                raise
            detail = "/".join(str(value) for value in diagnostic.values())
            raise RequestOutcomeUnknown(f"生图请求结果尚未确认（{detail}），已保留原回执与预留费用，禁止重提。") from None
        receipt.setdefault("raw_url", result)
        self.finish(operation, "completed", **receipt)
        return result

    def record_provider_receipt(self, provider_task_id, receipt):
        """Recovery writes the same original task's accounting fields, not a bill."""
        with _LOCK:
            data = self.load()
            for operation in data["operations"].values():
                if operation.get("provider_task_id") == provider_task_id:
                    operation["provider_receipt"] = receipt
            _write(self.path, data)

    def restore_receipts(self, blocks, api_key=""):
        """Merge journal-first receipts into the older pipeline checkpoint."""
        by_block = {str(b.get("block_id") or ""): b for b in blocks}
        by_provider = {str(b["provider_task_id"]): b for b in blocks if b.get("provider_task_id")}
        unknown = []
        for name, operation in self.load()["operations"].items():
            if not name.startswith("image:"):
                continue
            block_id = str(operation.get("block_id") or "")
            provider_id = str(operation.get("provider_task_id") or "")
            block = by_block.get(block_id) if block_id else by_provider.get(provider_id)
            if block is None or (provider_id and block.get("provider_task_id") not in (None, "", provider_id)):
                unknown.append(f"{name}: 原付费回执无法对应图片，需核对原任务")
                continue
            if not provider_id and block.get("provider_task_id"):
                provider_id = str(block["provider_task_id"])
                self.finish(name, operation["status"], provider_task_id=provider_id)
            if (not provider_id and not operation.get("raw_url") and operation["status"] != "failed"
                    and operation.get("gateway_operation_id") and api_key):
                from ai_image_apimart import recover_gateway_task_id, APIMartOutcomeUnknown
                try:
                    provider_id = recover_gateway_task_id(operation["gateway_operation_id"], api_key)
                    # Journal first again: a second process exit must retain the recovered ID.
                    self.finish(name, "submitting", provider_task_id=provider_id)
                except APIMartOutcomeUnknown:
                    block["provider_status"] = "outcome_unknown"
                    unknown.append(f"{name}: 原网关回执尚不可确认，未重新提交")
            if provider_id:
                block["provider_task_id"] = provider_id
            if operation.get("raw_url"):
                block["raw_url"] = operation["raw_url"]
            if operation["status"] == "failed":
                block["provider_status"] = "not_submitted" if self.is_unsubmitted(operation) else "failed"
            elif not block.get("provider_task_id") and not block.get("raw_url"):
                block["provider_status"] = "outcome_unknown"
        return unknown

    def reconcile(self, blocks):
        if not self.path.exists():
            return
        by_id = {b.get("provider_task_id"): b for b in blocks if b.get("provider_task_id")}
        with _LOCK:
            data = self.load()
            for operation in data["operations"].values():
                block = by_id.get(operation.get("provider_task_id"))
                if block and (block.get("raw_url") or block.get("provider_status") == "failed"):
                    operation["status"] = "completed" if block.get("raw_url") else "failed"
                    if block.get("raw_url"):
                        operation["raw_url"] = block["raw_url"]
            _write(self.path, data)
