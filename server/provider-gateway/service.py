"""Authenticated, fixed-route provider gateway for the desktop test channel.

The public maintenance process forwards the gateway prefix to this service over
loopback. Provider credentials stay in the server environment; desktop clients
receive only a short-lived session token after presenting a valid license.
"""

from __future__ import annotations

import argparse
import base64
import collections
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


PREFIX = "/v1/provider-gateway"
APP_IDS = {
    "test": "com.aihuoke.desktop.test",
    "delivery": "com.aihuoke.desktop",
}
PRODUCT_ID = "ai-huoke-desktop"
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z", re.I)
VERSION = re.compile(r"(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}\Z")
TOKEN = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
LICENSE_PART = re.compile(r"[A-Za-z0-9_-]{8,4096}\Z")
SAFE_HEADER_VALUE = re.compile(r"[\x20-\x7e]{1,512}\Z")

PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsPhBY7urbSK6OeM6CkL0
3c4v6TE1RKzwn8VlUFeAHQs8/KqmzrEQfaps9SIlUa4BMf8td8Bh3RBSHf+XGDrM
GrM2KU7PDY9bac3Fw0gAQGcvgCV/wg5kAgsnZ85yA8lBmuiw8o/w4YIs/Zq7MDWR
o+esPPP1W2YVNCmLtVIdlfzaPP8y7RmRxG3UZU5GV+YsNPc7QSZEu64S8dHbOGtL
2DXgibn3jikGs15mUkPBmBMsRjGn9ghHJxpn4/9EOWhhRhjnbuNY0lg0b2zxC1+D
axGaWo3mf+e/DgoRvWtvjketmbtIxnMkyn4u0acguvTYOAiYNrqsonBmTjNalWcn
LQIDAQAB
-----END PUBLIC KEY-----"""


def _base64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not LICENSE_PART.fullmatch(value):
        raise ValueError("license_part")
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _parse_expiry(value: str) -> datetime:
    raw = str(value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def validate_license(code: str, now: datetime | None = None) -> dict[str, str] | None:
    """Verify the same RSA-SHA256 license format used by the desktop app."""

    parts = str(code or "").strip().split(".")
    if len(parts) != 2 or not all(LICENSE_PART.fullmatch(part) for part in parts):
        return None
    payload_part, signature_part = parts
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        public_key = serialization.load_pem_public_key(PUBLIC_KEY.encode("ascii"))
        public_key.verify(
            _base64url_decode(signature_part),
            payload_part.encode("ascii"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        payload = json.loads(_base64url_decode(payload_part).decode("utf-8"))
        if not isinstance(payload, dict):
            return None
        license_id = str(payload.get("license_id") or "").strip()
        expires_at = _parse_expiry(payload.get("expires_at"))
        current = now or datetime.now(timezone.utc)
        if (
            payload.get("product") != PRODUCT_ID
            or not license_id
            or len(license_id) > 256
            or expires_at <= current.astimezone(timezone.utc)
        ):
            return None
        return {"license_id": license_id, "expires_at": expires_at.isoformat()}
    except Exception:
        # License material and cryptographic failure details must never reach a
        # public response or the service log.
        return None


def _official_origin(value: str, default: str, hostname: str) -> str:
    raw = str(value or default).strip().rstrip("/")
    parsed = urlsplit(raw)
    if (
        parsed.scheme != "https"
        or parsed.hostname != hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.port not in (None, 443)
        or parsed.path not in ("", "/")
    ):
        return default
    return f"https://{hostname}"


class SessionStore:
    def __init__(self, secret: str = "", ttl_seconds: int = 24 * 60 * 60):
        self.secret = str(secret or "").encode("utf-8") or secrets.token_bytes(32)
        self.ttl_seconds = max(300, min(7 * 24 * 60 * 60, int(ttl_seconds)))
        self._sessions: dict[bytes, tuple[float, str]] = {}
        self._lock = threading.Lock()

    def _digest(self, token: str) -> bytes:
        return hmac.new(self.secret, token.encode("utf-8"), hashlib.sha256).digest()

    def issue(self, license_id: str, expires_at: datetime) -> tuple[str, datetime]:
        now = time.time()
        expiry = min(expires_at.timestamp(), now + self.ttl_seconds)
        if expiry <= now:
            raise ValueError("session_expired")
        token = secrets.token_urlsafe(32)
        digest = self._digest(token)
        with self._lock:
            self._cleanup_locked(now)
            if len(self._sessions) >= 4096:
                self._sessions.pop(next(iter(self._sessions)))
            self._sessions[digest] = (expiry, license_id)
        return token, datetime.fromtimestamp(expiry, timezone.utc)

    def validate(self, token: str) -> bool:
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            return False
        now = time.time()
        digest = self._digest(token)
        with self._lock:
            self._cleanup_locked(now)
            return digest in self._sessions and self._sessions[digest][0] > now

    def _cleanup_locked(self, now: float) -> None:
        for digest, (expires, _license_id) in list(self._sessions.items()):
            if expires <= now:
                self._sessions.pop(digest, None)


@dataclass
class GatewayConfig:
    keys: dict[str, str]
    asr_app_id: str = ""
    asr_access_token: str = ""
    origins: dict[str, str] | None = None
    license_validator: object = validate_license
    upstream_open: object = urlopen
    max_request_bytes: int = 32 * 1024 * 1024
    max_response_bytes: int = 96 * 1024 * 1024
    session_ttl_seconds: int = 24 * 60 * 60
    session_secret: str = ""

    @classmethod
    def from_environment(cls, environ=None):
        env = os.environ if environ is None else environ
        volcengine_key = str(env.get("XIAOXI_GATEWAY_VOLCENGINE_API_KEY", "")).strip()
        keys = {
            "deepseek": str(env.get("XIAOXI_GATEWAY_DEEPSEEK_API_KEY", "")).strip(),
            "bailian": str(env.get("XIAOXI_GATEWAY_BAILIAN_API_KEY", "")).strip(),
            "volcengine_ark": str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY", "")).strip() or volcengine_key,
            "volcengine_tts": str(env.get("XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY", "")).strip() or volcengine_key,
            "volcengine_asr": str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY", "")).strip() or volcengine_key,
            "apimart": str(env.get("XIAOXI_GATEWAY_APIMART_API_KEY", "")).strip(),
        }
        return cls(
            keys=keys,
            asr_app_id=str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ASR_APP_ID", "")).strip(),
            asr_access_token=str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ASR_ACCESS_TOKEN", "")).strip(),
            origins={
                "deepseek": _official_origin(env.get("XIAOXI_GATEWAY_DEEPSEEK_ORIGIN", ""), "https://api.deepseek.com", "api.deepseek.com"),
                "bailian": _official_origin(env.get("XIAOXI_GATEWAY_BAILIAN_ORIGIN", ""), "https://dashscope.aliyuncs.com", "dashscope.aliyuncs.com"),
                "ark": _official_origin(env.get("XIAOXI_GATEWAY_VOLCENGINE_ORIGIN", ""), "https://ark.cn-beijing.volces.com", "ark.cn-beijing.volces.com"),
                "speech": _official_origin(env.get("XIAOXI_GATEWAY_VOLCENGINE_SPEECH_ORIGIN", ""), "https://openspeech.bytedance.com", "openspeech.bytedance.com"),
                "apimart": _official_origin(env.get("XIAOXI_GATEWAY_APIMART_ORIGIN", ""), "https://api.apimart.ai", "api.apimart.ai"),
            },
            session_ttl_seconds=int(env.get("XIAOXI_GATEWAY_SESSION_TTL_SECONDS", 24 * 60 * 60)),
            session_secret=str(env.get("XIAOXI_GATEWAY_SESSION_SECRET", "")),
        )

    def __post_init__(self):
        self.keys = {str(key): str(value or "").strip() for key, value in (self.keys or {}).items()}
        if self.origins is None:
            self.origins = {
                "deepseek": "https://api.deepseek.com",
                "bailian": "https://dashscope.aliyuncs.com",
                "ark": "https://ark.cn-beijing.volces.com",
                "speech": "https://openspeech.bytedance.com",
                "apimart": "https://api.apimart.ai",
            }
        self.sessions = SessionStore(self.session_secret, self.session_ttl_seconds)

    def capabilities(self) -> dict[str, bool]:
        return {
            "deepseek": bool(self.keys.get("deepseek")),
            "bailian": bool(self.keys.get("bailian")),
            "volcengine_ark": bool(self.keys.get("volcengine_ark")),
            "volcengine_tts": bool(self.keys.get("volcengine_tts")),
            "volcengine_asr": bool(self.keys.get("volcengine_asr") or (self.asr_app_id and self.asr_access_token)),
            "apimart": bool(self.keys.get("apimart")),
        }

    def configured(self, provider: str) -> bool:
        return self.capabilities().get(provider, False)


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, config: GatewayConfig):
        super().__init__(address, handler)
        self.config = config
        self.slots = threading.BoundedSemaphore(16)
        self.rate_lock = threading.Lock()
        self.rates = collections.OrderedDict()

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def allowed(self, address):
        minute = int(time.time() / 60)
        with self.rate_lock:
            for key, limit in (("global", 300), (address, 60)):
                stamp, count = self.rates.get(key, (minute, 0))
                count = count + 1 if stamp == minute else 1
                self.rates[key] = (minute, count)
                self.rates.move_to_end(key)
                if count > limit:
                    return False
            while len(self.rates) > 2048:
                self.rates.popitem(last=False)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "ProviderGateway/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(240)

    def log_message(self, *_args):
        # Provider bodies, license codes and bearer tokens must never enter logs.
        pass

    @property
    def config(self) -> GatewayConfig:
        return self.server.config

    def _reply_json(self, status: int, value: dict):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self, maximum: int | None = None) -> bytes:
        raw_length = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"\d{1,12}", raw_length):
            raise ValueError("content_length")
        length = int(raw_length)
        limit = maximum or self.config.max_request_bytes
        if length <= 0 or length > limit:
            raise ValueError("body_size")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("body_incomplete")
        return data

    def _read_json(self, maximum: int = 64 * 1024) -> dict:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("content_type")
        value = json.loads(self._read_body(maximum).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("json_object")
        return value

    def _session(self) -> bool:
        value = self.headers.get("Authorization", "")
        match = re.fullmatch(r"Bearer\s+(.+)", value, re.I)
        return bool(match and self.config.sessions.validate(match.group(1).strip()))

    def _route(self):
        parsed = urlsplit(self.path)
        route = parsed.path
        suffix = route[len(PREFIX):] if route.startswith(PREFIX) else ""
        if suffix == "/deepseek/chat/completions":
            return "deepseek", self.config.origins["deepseek"] + "/chat/completions"
        if suffix == "/deepseek/v1/chat/completions":
            return "deepseek", self.config.origins["deepseek"] + "/v1/chat/completions"
        if suffix.startswith("/bailian/") and len(suffix) > len("/bailian/"):
            rest = suffix[len("/bailian"):]
            return "bailian", self.config.origins["bailian"] + rest
        if suffix in ("/volcengine/ark/chat/completions", "/volcengine/ark/images/generations"):
            return "volcengine_ark", self.config.origins["ark"] + "/api/v3" + suffix[len("/volcengine/ark"):]
        if suffix == "/volcengine/asr/recognize/flash":
            return "volcengine_asr", self.config.origins["speech"] + "/api/v3/auc/bigmodel/recognize/flash"
        if suffix == "/volcengine/tts/sse":
            return "volcengine_tts", self.config.origins["speech"] + "/api/v3/tts/unidirectional/sse"
        match = re.fullmatch(r"/apimart/(uploads/images|images/generations|tasks/[A-Za-z0-9._-]{1,255})", suffix)
        if match:
            return "apimart", self.config.origins["apimart"] + "/v1/" + match.group(1)
        return None

    def _upstream_headers(self, provider: str) -> dict[str, str]:
        headers = {"User-Agent": "Xiaoxi-Provider-Gateway/1"}
        for name in (
            "Content-Type",
            "Accept",
            "X-Api-Resource-Id",
            "X-Api-Request-Id",
            "X-Api-Sequence",
            "X-Control-Require-Usage-Tokens-Return",
        ):
            value = self.headers.get(name)
            if value and SAFE_HEADER_VALUE.fullmatch(value):
                headers[name] = value
        if provider in {"deepseek", "bailian", "volcengine_ark", "apimart"}:
            headers["Authorization"] = f"Bearer {self.config.keys[provider]}"
        elif provider == "volcengine_tts":
            headers["X-Api-Key"] = self.config.keys[provider]
        elif provider == "volcengine_asr":
            if self.config.asr_app_id and self.config.asr_access_token:
                headers["X-Api-App-Key"] = self.config.asr_app_id
                headers["X-Api-Access-Key"] = self.config.asr_access_token
            else:
                headers["X-Api-Key"] = self.config.keys[provider]
        return headers

    def _proxy(self, method: str):
        route = self._route()
        if route is None:
            return self._reply_json(404, {"error": "not_found"})
        provider, target = route
        if not self._session():
            return self._reply_json(401, {"error": "session_required"})
        if not self.config.configured(provider):
            return self._reply_json(503, {"error": "provider_not_configured", "provider": provider})
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if provider == "apimart" and "/tasks/" in parsed.path:
            if any(key != "language" for key in query) or any(value != ["en"] for value in query.values()):
                return self._reply_json(400, {"error": "invalid_query"})
            if query:
                target += "?language=en"
        body = None
        if method == "POST":
            try:
                body = self._read_body()
            except (ValueError, UnicodeError):
                return self._reply_json(400, {"error": "invalid_body"})
        operation = Request(target, data=body, headers=self._upstream_headers(provider), method=method)
        try:
            response = self.config.upstream_open(operation, timeout=180 if provider in {"volcengine_asr", "volcengine_tts"} else 60)
            status = int(getattr(response, "status", getattr(response, "code", 200)))
            response_headers = getattr(response, "headers", {}) or {}
            raw = response.read(self.config.max_response_bytes + 1)
        except HTTPError as error:
            status = int(error.code or 502)
            response_headers = error.headers or {}
            try:
                raw = error.read(self.config.max_response_bytes + 1)
            except Exception:
                raw = b""
        except (TimeoutError, socket.timeout):
            return self._reply_json(504, {"error": "provider_timeout"})
        except (URLError, OSError):
            return self._reply_json(503, {"error": "provider_unavailable"})
        except Exception:
            return self._reply_json(503, {"error": "provider_unavailable"})
        finally:
            try:
                response.close()
            except (UnboundLocalError, AttributeError):
                pass
        if not isinstance(raw, (bytes, bytearray)) or len(raw) > self.config.max_response_bytes:
            return self._reply_json(502, {"error": "provider_response_too_large"})
        self.send_response(status)
        content_type = response_headers.get("Content-Type", "application/octet-stream")
        if not isinstance(content_type, str) or not SAFE_HEADER_VALUE.fullmatch(content_type):
            content_type = "application/octet-stream"
        self.send_header("Content-Type", content_type)
        for name in ("X-Api-Status-Code", "X-Request-Id", "Retry-After", "Cache-Control"):
            value = response_headers.get(name)
            if isinstance(value, str) and SAFE_HEADER_VALUE.fullmatch(value):
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self.server.allowed(self.client_address[0]):
            return self._reply_json(429, {"error": "rate_limit"})
        route = urlsplit(self.path).path
        if route == PREFIX + "/health":
            return self._reply_json(200, {"ok": True, "service": "provider-gateway", "schema": 1})
        if route == PREFIX + "/capabilities":
            if not self._session():
                return self._reply_json(401, {"error": "session_required"})
            return self._reply_json(200, {"ok": True, "schema": 1, "capabilities": self.config.capabilities()})
        if route.startswith(PREFIX + "/"):
            return self._proxy("GET")
        return self._reply_json(404, {"error": "not_found"})

    def do_POST(self):
        if not self.server.allowed(self.client_address[0]):
            return self._reply_json(429, {"error": "rate_limit"})
        route = urlsplit(self.path).path
        if route == PREFIX + "/session":
            try:
                body = self._read_json()
            except (ValueError, UnicodeError, json.JSONDecodeError):
                return self._reply_json(400, {"error": "invalid_session_request"})
            channel = body.get("channel")
            if (
                channel not in APP_IDS
                or body.get("appId") != APP_IDS[channel]
                or not UUID.fullmatch(str(body.get("installId", "")))
                or not VERSION.fullmatch(str(body.get("version", "")))
                or not isinstance(body.get("licenseCode"), str)
                or not LICENSE_PART.fullmatch(body["licenseCode"].split(".")[0])
            ):
                return self._reply_json(400, {"error": "invalid_session_request"})
            try:
                license_info = self.config.license_validator(body["licenseCode"])
            except Exception:
                license_info = None
            if not isinstance(license_info, dict):
                return self._reply_json(401, {"error": "license_invalid"})
            try:
                license_id = str(license_info["license_id"])
                expires_at = _parse_expiry(license_info["expires_at"])
                token, session_expiry = self.config.sessions.issue(license_id, expires_at)
            except Exception:
                return self._reply_json(401, {"error": "license_invalid"})
            return self._reply_json(200, {
                "ok": True,
                "schema": 1,
                "token": token,
                "expiresAt": session_expiry.isoformat(),
                "capabilities": self.config.capabilities(),
            })
        if route.startswith(PREFIX + "/"):
            return self._proxy("POST")
        return self._reply_json(404, {"error": "not_found"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8444)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        raise SystemExit("provider gateway must bind to loopback")
    config = GatewayConfig.from_environment()
    server = GatewayServer((args.host, args.port), Handler, config)
    server.serve_forever()


if __name__ == "__main__":
    main()
