"""TLS configuration for the private provider gateway."""

from __future__ import annotations

import os
import ssl

from .errors import ContentEngineError


GATEWAY_ORIGIN_ENV = "XIAOXI_PROVIDER_GATEWAY_ORIGIN"
GATEWAY_CA_ENV = "XIAOXI_PROVIDER_GATEWAY_CA_PEM"


def gateway_tls_context(url: str):
    """Return a verified TLS context for private gateway URLs only."""

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
