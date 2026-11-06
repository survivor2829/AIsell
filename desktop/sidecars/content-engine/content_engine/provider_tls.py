"""TLS configuration for the private provider gateway, plus compute-credit job tags."""

from __future__ import annotations

import json
import os
import ssl
import threading
import time
import urllib.request

from .errors import ContentEngineError


GATEWAY_ORIGIN_ENV = "XIAOXI_PROVIDER_GATEWAY_ORIGIN"
GATEWAY_CA_ENV = "XIAOXI_PROVIDER_GATEWAY_CA_PEM"
GATEWAY_PREFIX = "/v1/provider-gateway/"


def billing_feature(task_type: str) -> str:
    task_type = str(task_type or "")
    if task_type.startswith("product_"):
        return "product_video"
    if task_type == "import_base_video":
        return "digital_human"
    return "mix"


def billing_job(task_id: str) -> str:
    return f"ce:{task_id}" if task_id else ""


def tag_billing(operation) -> None:
    """Mark a gateway request with the content task it belongs to. The gateway holds the
    task's charges until the task finishes and drops them if it fails."""
    from .provider_usage import current_usage_context

    origin = os.environ.get(GATEWAY_ORIGIN_ENV, "").strip().rstrip("/")
    url = operation.full_url if isinstance(operation, urllib.request.Request) else ""
    if not origin or not url.startswith(origin + GATEWAY_PREFIX):
        return
    context = current_usage_context()
    if context.get("task_id"):
        operation.add_header("X-Xiaoxi-Billing-Job", billing_job(context["task_id"]))
        operation.add_header("X-Xiaoxi-Billing-Feature", billing_feature(context.get("task_type")))


def settle_billing_job(task_id: str, outcome: str) -> None:
    """Tell the gateway a task succeeded (charge it) or failed (free). Runs in the background;
    an unreported task is treated as failed by the gateway after a day."""
    origin = os.environ.get(GATEWAY_ORIGIN_ENV, "").strip().rstrip("/")
    token = (os.environ.get("XIAOXI_PROVIDER_GATEWAY_TOKEN", "") or os.environ.get("DEEPSEEK_API_KEY", "")).strip()
    if not origin or not token or not task_id or outcome not in {"succeeded", "failed"}:
        return
    body = json.dumps({"jobId": billing_job(task_id), "outcome": outcome}).encode("utf-8")

    def send():
        ca_pem = os.environ.get(GATEWAY_CA_ENV, "").strip()
        try:
            handlers = [urllib.request.HTTPSHandler(context=ssl.create_default_context(cadata=ca_pem))] if ca_pem else []
        except (ssl.SSLError, ValueError):
            return
        opener = urllib.request.build_opener(*handlers)
        for attempt in range(3):
            request = urllib.request.Request(origin + GATEWAY_PREFIX + "billing/settle", data=body, method="POST",
                                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            try:
                with opener.open(request, timeout=15) as response:
                    if 200 <= response.status < 300:
                        return
            except Exception:
                pass
            time.sleep(2 * (attempt + 1))

    threading.Thread(target=send, name="billing-settle", daemon=True).start()


def gateway_tls_context(url: str, *, method: str = "POST"):
    """Return a verified TLS context for private gateway URLs only."""

    if os.environ.get("XIAOXI_DISABLE_PAID_CALLS") == "1" and method.upper() not in {"GET", "HEAD"}:
        raise ContentEngineError(
            "paid_calls_disabled", "本轮验收禁止外部付费调用，未提交请求。"
        )
    origin = os.environ.get(GATEWAY_ORIGIN_ENV, "").strip().rstrip("/")
    if not origin or not str(url).startswith(f"{origin}/v1/provider-gateway/"):
        return None
    ca_pem = os.environ.get(GATEWAY_CA_ENV, "").strip()
    if not ca_pem:
        raise ContentEngineError(
            "provider_gateway_tls_not_configured",
            "统一 AI 网关证书未配置，已停止请求。",
        )
    try:
        return ssl.create_default_context(cadata=ca_pem)
    except (ssl.SSLError, ValueError):
        raise ContentEngineError(
            "provider_gateway_tls_invalid",
            "统一 AI 网关证书无效，已停止请求。",
        ) from None
