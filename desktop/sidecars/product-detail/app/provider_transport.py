"""Verified TLS for the desktop gateway, isolated from other provider traffic."""

import json
import os
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def gateway_tls_context(url: str):
    origin = os.environ.get("XIAOXI_PROVIDER_GATEWAY_ORIGIN", "").strip().rstrip("/")
    if not origin or not str(url).startswith(f"{origin}/v1/provider-gateway/"):
        return None
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise ValueError("统一 AI 网关地址无效，已停止请求。")
    ca_pem = os.environ.get("XIAOXI_PROVIDER_GATEWAY_CA_PEM", "").strip()
    if not ca_pem:
        raise ValueError("统一 AI 网关证书未配置，已停止请求。")
    try:
        return ssl.create_default_context(cadata=ca_pem)
    except (ssl.SSLError, ValueError):
        raise ValueError("统一 AI 网关证书无效，已停止请求。") from None


class _GatewayNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Fixed gateway routes must not forward their session token elsewhere.
        raise urllib.error.HTTPError(request.full_url, code, "Gateway redirect rejected", headers, fp)


def build_provider_opener(url: str, *, proxies=None):
    handlers = [urllib.request.ProxyHandler(proxies)]
    context = gateway_tls_context(url)
    if context is not None:
        handlers.extend((urllib.request.HTTPSHandler(context=context), _GatewayNoRedirect()))
    return urllib.request.build_opener(*handlers)


def post_provider_json(url: str, payload: dict, *, headers: dict, timeout: int):
    request = urllib.request.Request(
        url, method="POST", data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
    )
    with build_provider_opener(url, proxies={}).open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))
