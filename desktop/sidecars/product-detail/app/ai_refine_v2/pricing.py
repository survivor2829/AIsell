"""Read-only supplier quotes and a per-task cost journal, never a billing system.

Published prices bound requests; only a provider bill can establish actual cost.
The journal is written before POST, so an interrupted request cannot be repeated.
"""
from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from ai_refine_v2.image_profile import normalize_profile

IMAGE_PRICE_URL = "https://apimart.ai/api/pricing/model?model=gpt-image-2"
PLANNER_PRICE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing"
MAX_QUOTE_AGE = 60 * 60
_LOCK = threading.RLock()


class PricingRequired(RuntimeError):
    code = "AI_REFINE_PRICING_REQUIRED"
    do_not_retry = True


class RequestOutcomeUnknown(RuntimeError):
    code = "AI_REFINE_OUTCOME_UNKNOWN"
    do_not_retry = True
    outcome_unknown = True


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
    return diagnostic


def money(value):
    return math.ceil((float(value) - 1e-10) * 10000) / 10000


def _positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("invalid price")
    return number


def _read(url):
    from provider_transport import build_provider_opener
    gateway = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").strip().rstrip("/")
    base = os.environ.get("REFINE_API_BASE_URL", "").strip().rstrip("/")
    parsed = urlsplit(url)
    via_gateway = (gateway and base == gateway + "/v1/provider-gateway/apimart"
                   and parsed.scheme == "https" and parsed.netloc == "apimart.ai"
                   and parsed.path == "/api/pricing/model")
    headers = {"User-Agent": "xiaoxi-price-check/1.0"}
    target = url
    if via_gateway:
        models = parse_qs(parsed.query).get("model", [])
        token = os.environ.get("REFINE_API_KEY", "").strip()
        if len(models) != 1 or models[0] not in {"gpt-image-2", "gpt-image-2.5-ext"} or not token:
            raise ValueError("invalid gateway price request")
        target = gateway + "/v1/provider-gateway/capabilities?price_model=" + models[0]
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(target, headers=headers)
    with build_provider_opener(target, proxies={}).open(request, timeout=20) as response:
        if response.status != 200:
            raise ValueError("price status")
        content = response.read(1_000_001)
    if len(content) > 1_000_000:
        raise ValueError("price response too large")
    document = content.decode("utf-8")
    if via_gateway:
        result = json.loads(document)
        price = result.get("apimart_pricing", {})
        if (result.get("ok") is not True or price.get("source") != url
                or not isinstance(price.get("payload"), dict)
                or not -300 <= time.time() - float(price.get("checked_at", 0)) <= MAX_QUOTE_AGE):
            raise ValueError("gateway price unavailable or stale")
        return json.dumps(price["payload"], ensure_ascii=False)
    return document


def parse_planner_prices(document, model):
    # Models are matched by table columns. Legacy aliases are accepted only when
    # the current supplier page explicitly says they use Flash pricing.
    priced_model = model
    if model in {"deepseek-v4-flash", "deepseek-v4-flash-vision-exp"}:
        if model not in document or "Flash 价格计费" not in document:
            raise ValueError("unverified model alias")
        priced_model = "deepseek-flash"
    table = re.search(r"<table\b[^>]*>(.*?)</table>", document, re.S)
    if not table:
        raise ValueError("missing pricing table")
    rows = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table[1], re.S):
        cells = re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, re.S)
        rows.append([html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in cells])
    columns = [re.sub(r"\(\d+\)$", "", c) for c in rows[0][1:]]
    column = columns.index(priced_model)
    rates = {}
    kind = None
    for row in rows:
        label = "".join(row)
        if "百万tokens输入" in label:
            kind = "input" if "缓存未命中" in label else "cache"
        elif "百万tokens输出" in label:
            kind = "output"
        if kind and "高峰时段" in row:
            values = row[row.index("高峰时段") + 1:]
            if len(values) != len(columns):
                raise ValueError("ambiguous price columns")
            match = re.fullmatch(r"([0-9.]+)元", values[column])
            if not match:
                raise ValueError("invalid planner price")
            rates[kind] = _positive(match[1])
    if set(rates) != {"input", "cache", "output"}:
        raise ValueError("incomplete planner price")
    return rates


def read_quote(*, include_planner=True, image_profile=None, read=_read):
    from ai_refine_v2 import refine_planner
    try:
        profile = normalize_profile(image_profile)
        # A quote from a different supplier is not a quote for this connection.
        image = urlsplit(os.environ.get("REFINE_API_BASE_URL", ""))
        planner = urlsplit(refine_planner._API_URL)
        gateway = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").rstrip("/")
        def official_or_gateway(parsed, host, suffix):
            return parsed.hostname == host or (
                gateway and f"{parsed.scheme}://{parsed.netloc}" == gateway
                and parsed.path.rstrip("/").endswith(suffix)
            )
        if not official_or_gateway(image, "api.apimart.ai", "/apimart"):
            raise ValueError("unsupported image supplier")
        if include_planner and not official_or_gateway(planner, "api.deepseek.com", "/deepseek/v1/chat/completions"):
            raise ValueError("unsupported planner supplier")
        image_price_url = f"https://apimart.ai/api/pricing/model?model={profile['model']}"
        image_text = read(image_price_url)
        image_payload = json.loads(image_text)
        data = image_payload["data"]
        if image_payload.get("success") is not True or data.get("model_name") != profile["model"]:
            raise ValueError("image model mismatch")
        if profile.get("version") and data.get("billing_type") != "version_resolution":
            raise ValueError("image billing type changed")
        prices = data["version_resolution_prices"][profile["version"]] if profile.get("version") else data["resolution_prices"]
        usd = _positive(prices[profile["resolution"]])
        fx = _positive(os.environ.get("REFINE_BUDGET_CNY_PER_USD", "8"))
        quote = {"version": 1, "checked_at": time.time(), "image_model": profile["model"],
                 "image_resolution": profile["resolution"], "image_unit_usd": usd,
                 **({"image_version": profile["version"]} if profile.get("version") else {}),
                 "fx_cny_per_usd": fx, "image_unit_cny": money(usd * fx),
                 "sources": [image_price_url], "image_price_hash": hashlib.sha256(image_text.encode()).hexdigest(),
                 "note": "公开标价保守估算；美元采用预算汇率折算，优惠和实际扣款以供应商账单为准"}
        if include_planner:
            document = read(PLANNER_PRICE_URL)
            quote.update(planner_model=refine_planner._MODEL_DEFAULT,
                         planner_per_million_cny=parse_planner_prices(document, refine_planner._MODEL_DEFAULT),
                         planner_price_hash=hashlib.sha256(document.encode()).hexdigest())
            quote["sources"].append(PLANNER_PRICE_URL)
        return quote
    except Exception as exc:
        if isinstance(exc, PricingRequired):
            raise
        raise PricingRequired("当前供应商报价尚未核实，资料和已有方案已保留，未提交新的付费请求。") from None


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

    def set_plan(self, quote, count):
        if type(count) is not int or not 1 <= count <= 15:
            raise PricingRequired("方案图片数量无效，尚未提交生图。")
        with _LOCK:
            data = self.load()
            if any(name.startswith("image:") for name in data["operations"]):
                raise RequestOutcomeUnknown("原方案已有生图请求，只能恢复原结果，不能重新提交。")
            remaining = money(count * quote["image_unit_cny"])
            data.update(quote=quote, image_count=count,
                        estimated_cny=money(remaining + sum(op["reserved_cny"] for op in data["operations"].values())))
            _write(self.path, data)
            self._ensure_room(data, remaining)

    def begin(self, name, quote, reserve, **context):
        with _LOCK:
            data = self.load()
            if name in data["operations"]:
                raise RequestOutcomeUnknown("原请求已有费用记录，只能核对原结果，不能重复提交。")
            if not 0 <= time.time() - quote["checked_at"] < MAX_QUOTE_AGE:
                raise PricingRequired("报价已过期，方案已保留，请重新核价。")
            self._ensure_room(data, reserve)
            data["operations"][name] = {"status": "submitting", "reserved_cny": money(reserve), "started_at": time.time(), **context}
            data["quote"] = quote
            data["operations"][name]["quote"] = quote
            _write(self.path, data)

    def finish(self, name, status, **receipt):
        with _LOCK:
            data = self.load()
            data["operations"][name].update(status=status, **receipt)
            _write(self.path, data)

    def saved_planner_response(self):
        """Replay a durably saved paid response, including a crash before finish()."""
        with _LOCK:
            if "planner" not in self.load()["operations"]:
                return None
            path = self.path.parent / "_planner_response.json"
            if not path.exists():
                return None
            try:
                response = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(response, dict):
                    raise ValueError("planner response shape")
            except Exception:
                raise RequestOutcomeUnknown("已付费策划回执无法读取，禁止重新提交策划。") from None
            self._finish_planner(response)
            return response

    def _finish_planner(self, response):
        usage = response.get("usage") or {}
        safe_usage = {k: v for k, v in usage.items() if k in {"prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"} and isinstance(v, (int, float))}
        self.finish("planner", "completed", provider_request_id=str(response.get("id") or ""), usage=safe_usage)

    def planner_call(self, quote, body, key):
        from ai_refine_v2.refine_planner import _http_post_deepseek
        saved = self.saved_planner_response()
        if saved is not None:
            return saved
        # UTF-8 bytes conservatively bound BPE tokens; include chat framing.
        input_bound = len(json.dumps(body["messages"], ensure_ascii=False).encode("utf-8")) + 1024
        rates = quote["planner_per_million_cny"]
        reserve = money((input_bound * rates["input"] + body["max_tokens"] * rates["output"]) / 1_000_000)
        self.begin("planner", quote, reserve)
        try:
            response = _http_post_deepseek(body, key)
        except Exception:
            self.finish("planner", "outcome_unknown")
            raise RequestOutcomeUnknown("策划请求结果不明，已保留费用预留；不会自动重新策划。") from None
        # Retain the response before schema parsing: even invalid JSON was paid.
        _write(self.path.parent / "_planner_response.json", response)
        self._finish_planner(response)
        return response

    def image_call(self, quote, function, *args, block_id="", lifecycle_callback=None, **kwargs):
        if "image_profile" in kwargs:
            profile = normalize_profile(kwargs["image_profile"])
            if (quote.get("image_model") != profile["model"]
                    or quote.get("image_resolution") != profile["resolution"]
                    or quote.get("image_version") != profile.get("version")):
                raise PricingRequired("生图配置与核价不一致，未提交新的付费请求。")
        with _LOCK:
            data = self.load()
            previous = [op for name, op in data["operations"].items() if name.startswith("image:")]
            if any(op["status"] == "outcome_unknown" for op in previous):
                raise RequestOutcomeUnknown("已有生图结果不明，已停止后续付费请求。")
            if any(op.get("not_submitted") for op in previous):
                raise PricingRequired("原生图步骤在提交前失败，已停止后续请求；不会自动重新购买。")
            if len(previous) >= data.get("image_count", 0):
                raise PricingRequired("生成张数超出已核价方案，已停止新增请求。")
            operation = f"image:{len(previous) + 1}"
            self.begin(operation, quote, quote["image_unit_cny"], block_id=str(block_id))
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
                block["provider_status"] = "failed"
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
