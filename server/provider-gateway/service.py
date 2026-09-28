"""Authenticated, fixed-route provider gateway for the desktop test channel.

The public maintenance process forwards the gateway prefix to this service over
loopback. Provider credentials stay in the server environment; desktop clients
receive only a short-lived session token after presenting a valid license.
"""

from __future__ import annotations

import argparse
import base64
import collections
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener, urlopen


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
OPERATION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
RUNTIME_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 180
MIN_UPSTREAM_TIMEOUT_SECONDS = 30
MAX_UPSTREAM_TIMEOUT_SECONDS = 180
RECEIPT_MAX_BYTES = 4 * 1024 * 1024
RECEIPT_RETENTION_SECONDS = 24 * 60 * 60
RECEIPT_TOMBSTONE_SECONDS = 90 * 24 * 60 * 60

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


def _bounded_timeout(value, default=DEFAULT_UPSTREAM_TIMEOUT_SECONDS) -> int:
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        candidate = default
    return max(MIN_UPSTREAM_TIMEOUT_SECONDS, min(MAX_UPSTREAM_TIMEOUT_SECONDS, candidate))


class _NoProviderRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise URLError("provider_redirect_rejected")


class _FixedApimartProxy(ProxyHandler):
    def __init__(self, proxy_url, parsed):
        super().__init__({"https": proxy_url})
        self._proxy_host = parsed.netloc.rsplit("@", 1)[-1]
        self._proxy_auth = ""
        if parsed.username is not None:
            credentials = f"{unquote(parsed.username)}:{unquote(parsed.password or '')}"
            self._proxy_auth = "Basic " + base64.b64encode(credentials.encode()).decode("ascii")

    def proxy_open(self, req, proxy, type):
        # An explicit route must not silently fall back through NO_PROXY or
        # the system proxy settings. HTTPSConnection keeps verified TLS inside CONNECT.
        if self._proxy_auth:
            req.add_unredirected_header("Proxy-Authorization", self._proxy_auth)
        req.set_proxy(self._proxy_host, "http")
        return None


def _apimart_proxy_open(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = urlsplit(raw)
        # urllib does not provide TLS-to-proxy for an https:// proxy URL.
        # Reject it instead of silently sending proxy credentials over plaintext.
        if (len(raw) > 4096 or re.search(r"[\x00-\x20\x7f]", raw)
                or parsed.scheme != "http" or not parsed.hostname or "%" in parsed.hostname
                or parsed.port == 0 or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
            raise ValueError()
        return build_opener(_FixedApimartProxy(raw, parsed),
                            HTTPSHandler(context=ssl.create_default_context()),
                            _NoProviderRedirect()).open
    except (ValueError, TypeError):
        raise ValueError("apimart_proxy_config_invalid") from None


def _runtime_revision(value) -> str:
    candidate = str(value or "").strip()
    if candidate and RUNTIME_REVISION.fullmatch(candidate):
        return candidate
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
    except OSError:
        return "unversioned"


class SessionStore:
    def __init__(self, secret: str = "", ttl_seconds: int = 24 * 60 * 60):
        self.secret = str(secret or "").encode("utf-8") or secrets.token_bytes(32)
        self.ttl_seconds = max(300, min(7 * 24 * 60 * 60, int(ttl_seconds)))
        self._sessions: dict[bytes, tuple[float, str]] = {}
        self._lock = threading.Lock()
        self.receipts = None

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
            if self.receipts is not None:
                self.receipts.store_session(digest, expiry, license_id)
        return token, datetime.fromtimestamp(expiry, timezone.utc)

    def validate(self, token: str) -> bool:
        return self.subject(token) is not None

    def subject(self, token: str) -> str | None:
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            return None
        now = time.time()
        digest = self._digest(token)
        with self._lock:
            self._cleanup_locked(now)
            entry = self._sessions.get(digest)
            if entry and entry[0] > now:
                return entry[1]
            return self.receipts.lookup_session(digest, now) if self.receipts is not None else None

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
    apimart_open: object = field(default=None, repr=False)
    max_request_bytes: int = 32 * 1024 * 1024
    max_response_bytes: int = 96 * 1024 * 1024
    session_ttl_seconds: int = 24 * 60 * 60
    session_secret: str = ""
    upstream_timeout_seconds: int = DEFAULT_UPSTREAM_TIMEOUT_SECONDS
    runtime_revision: str = ""
    receipt_db_path: str = ""

    @classmethod
    def from_environment(cls, environ=None):
        env = os.environ if environ is None else environ
        volcengine_key = str(env.get("XIAOXI_GATEWAY_VOLCENGINE_API_KEY", "")).strip()
        # Ark and speech are separate Volcengine products.  A generic/Ark API
        # key must not be advertised as speech-capable. TTS requires its own API
        # key; ASR supports its own API key or the legacy APP ID + Access Token pair.
        volcengine_asr_key = str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY", "")).strip()
        keys = {
            "deepseek": str(env.get("XIAOXI_GATEWAY_DEEPSEEK_API_KEY", "")).strip(),
            "bailian": str(env.get("XIAOXI_GATEWAY_BAILIAN_API_KEY", "")).strip(),
            "volcengine_ark": str(env.get("XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY", "")).strip() or volcengine_key,
            "volcengine_tts": str(env.get("XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY", "")).strip(),
            "volcengine_asr": volcengine_asr_key,
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
            upstream_timeout_seconds=_bounded_timeout(
                env.get("XIAOXI_GATEWAY_UPSTREAM_TIMEOUT_SECONDS", DEFAULT_UPSTREAM_TIMEOUT_SECONDS)
            ),
            runtime_revision=_runtime_revision(env.get("XIAOXI_GATEWAY_RUNTIME_REVISION", "")),
            apimart_open=_apimart_proxy_open(env.get("XIAOXI_GATEWAY_APIMART_PROXY_URL", "")),
        )

    def __post_init__(self):
        self.keys = {str(key): str(value or "").strip() for key, value in (self.keys or {}).items()}
        self.upstream_timeout_seconds = _bounded_timeout(self.upstream_timeout_seconds)
        self.runtime_revision = _runtime_revision(self.runtime_revision)
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
            # These advertise installed fixed routes, not a guarantee that an
            # upstream account/model or an individual face has been approved.
            "apimart_video": bool(self.keys.get("apimart")),
            "apimart_avatar_assets": bool(self.keys.get("apimart")),
        }

    def configured(self, provider: str) -> bool:
        return self.capabilities().get(provider, False)


class ReceiptStore:
    """Bounded, subject-scoped result receipts; never persists request bodies."""

    def __init__(self, path, secret):
        self.lock = threading.Lock()
        self.secret = secret
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("""CREATE TABLE IF NOT EXISTS operation_receipts (
            subject_hash TEXT NOT NULL, operation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL, state TEXT NOT NULL,
            response_status INTEGER, headers_json TEXT, raw BLOB,
            created_at REAL NOT NULL, updated_at REAL NOT NULL,
            PRIMARY KEY(subject_hash, operation_id, fingerprint))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS gateway_sessions (
            token_digest BLOB PRIMARY KEY, expires_at REAL NOT NULL,
            subject TEXT NOT NULL)""")
        self.db.commit()

    def store_session(self, digest, expiry, subject):
        with self.lock:
            self.db.execute("DELETE FROM gateway_sessions WHERE expires_at<=?", (time.time(),))
            self.db.execute("""INSERT OR REPLACE INTO gateway_sessions
                (token_digest, expires_at, subject) VALUES (?,?,?)""", (digest, expiry, subject))
            self.db.commit()

    def lookup_session(self, digest, now):
        with self.lock:
            row = self.db.execute("""SELECT subject FROM gateway_sessions
                WHERE token_digest=? AND expires_at>?""", (digest, now)).fetchone()
            return row[0] if row else None

    def close(self):
        with self.lock:
            self.db.close()

    def _subject(self, subject):
        return hmac.new(self.secret, subject.encode("utf-8"), hashlib.sha256).hexdigest()

    @staticmethod
    def _result(row):
        if row[0] != "completed":
            return None
        return {"status": row[1], "headers": json.loads(row[2] or "{}"), "raw": row[3] or b""}

    def _expire(self, now):
        self.db.execute("""UPDATE operation_receipts
            SET state='expired', raw=NULL, headers_json=NULL, updated_at=?
            WHERE state='completed' AND created_at<?""",
            (now, now - RECEIPT_RETENTION_SECONDS))
        self.db.execute("DELETE FROM operation_receipts WHERE created_at<?",
                        (now - RECEIPT_TOMBSTONE_SECONDS,))

    def begin(self, subject, operation_id, fingerprint):
        now = time.time()
        subject_hash = self._subject(subject)
        with self.lock:
            self._expire(now)
            row = self.db.execute("""SELECT fingerprint,state,response_status,headers_json,raw
                FROM operation_receipts WHERE subject_hash=? AND operation_id=? AND fingerprint=?""",
                (subject_hash, operation_id, fingerprint)).fetchone()
            if row:
                self.db.commit()
                return row[1], self._result(row[1:])
            self.db.execute("""INSERT INTO operation_receipts
                (subject_hash,operation_id,fingerprint,state,created_at,updated_at)
                VALUES (?,?,?,'pending',?,?)""",
                (subject_hash, operation_id, fingerprint, now, now))
            self.db.commit()
            return "new", None

    def finish(self, subject, operation_id, fingerprint, result):
        raw = result.get("raw", b"")
        state = "completed" if isinstance(raw, bytes) and len(raw) <= RECEIPT_MAX_BYTES else "unrecoverable"
        now = time.time()
        with self.lock:
            if int(result.get("status", 503)) == 429:
                # A rate limit is a known rejection, not a billable unknown outcome.
                # Keep the existing bounded retry contract for the same operation.
                self.db.execute("""DELETE FROM operation_receipts WHERE subject_hash=?
                    AND operation_id=? AND fingerprint=? AND state='pending'""",
                    (self._subject(subject), operation_id, fingerprint))
                self.db.commit()
                return
            self.db.execute("""UPDATE operation_receipts SET state=?,response_status=?,
                headers_json=?,raw=?,updated_at=? WHERE subject_hash=? AND operation_id=?
                AND fingerprint=? AND state='pending'""",
                (state, int(result.get("status", 503)),
                 json.dumps(result.get("headers", {})) if state == "completed" else None,
                 raw if state == "completed" else None, now,
                 self._subject(subject), operation_id, fingerprint))
            self.db.commit()

    def lookup(self, subject, operation_id):
        now = time.time()
        with self.lock:
            self._expire(now)
            rows = self.db.execute("""SELECT fingerprint,state,response_status,headers_json,raw
                FROM operation_receipts WHERE subject_hash=? AND operation_id=? LIMIT 2""",
                (self._subject(subject), operation_id)).fetchall()
            self.db.commit()
        if len(rows) > 1:
            return "ambiguous", None, None
        row = rows[0] if rows else None
        return (row[1], self._result(row[1:]), row[0]) if row else ("missing", None, None)


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, config: GatewayConfig):
        super().__init__(address, handler)
        self.config = config
        self.slots = threading.BoundedSemaphore(16)
        self.rate_lock = threading.Lock()
        self.rates = collections.OrderedDict()
        self.inflight_lock = threading.Lock()
        self.inflight = {}
        self.receipts = ReceiptStore(config.receipt_db_path or ":memory:", config.sessions.secret)
        config.sessions.receipts = self.receipts

    def server_close(self):
        try:
            self.receipts.close()
        finally:
            super().server_close()

    def begin_operation(self, subject, operation_id, fingerprint):
        with self.inflight_lock:
            state, result = self.receipts.begin(subject, operation_id, fingerprint)
            if state == "new":
                entry = {"event": threading.Event(), "result": None}
                self.inflight[fingerprint] = entry
                return state, entry, None
            return state, self.inflight.get(fingerprint), result

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

    def rate_limit(self, address):
        minute = int(time.time() / 60)
        retry_after = max(1, int((minute + 1) * 60 - time.time()))
        with self.rate_lock:
            for key, limit in (("global", 300), (address, 60)):
                stamp, count = self.rates.get(key, (minute, 0))
                if stamp == minute and count >= limit:
                    return {"allowed": False, "scope": key, "retry_after": retry_after}
            for key, _limit in (("global", 300), (address, 60)):
                stamp, count = self.rates.get(key, (minute, 0))
                self.rates[key] = (minute, count + 1 if stamp == minute else 1)
                self.rates.move_to_end(key)
            while len(self.rates) > 2048:
                self.rates.popitem(last=False)
        return {"allowed": True, "scope": "", "retry_after": None}

    def allowed(self, address):
        return self.rate_limit(address)["allowed"]

    def acquire_inflight(self, key):
        with self.inflight_lock:
            entry = self.inflight.get(key)
            if entry is not None:
                return entry, False
            entry = {"event": threading.Event(), "result": None}
            self.inflight[key] = entry
            return entry, True

    def finish_inflight(self, key, entry, result):
        with self.inflight_lock:
            if self.inflight.get(key) is entry:
                self.inflight.pop(key, None)
            entry["result"] = result
            entry["event"].set()


class Handler(BaseHTTPRequestHandler):
    server_version = "ProviderGateway/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(self.config.upstream_timeout_seconds + 60)

    def log_message(self, *_args):
        # Provider bodies, license codes and bearer tokens must never enter logs.
        pass

    @property
    def config(self) -> GatewayConfig:
        return self.server.config

    def _reply_json(self, status: int, value: dict, headers=None):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, header_value in (headers or {}).items():
            if (
                isinstance(name, str)
                and isinstance(header_value, str)
                and SAFE_HEADER_VALUE.fullmatch(header_value)
                and name in {"X-Xiaoxi-Error-Origin", "Retry-After"}
            ):
                self.send_header(name, header_value)
        self.end_headers()
        self.wfile.write(data)

    def _json_result(self, status: int, value: dict, headers=None):
        return {
            "status": int(status),
            "headers": {str(name): str(header_value) for name, header_value in (headers or {}).items()},
            "raw": json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        }

    def _send_result(self, result):
        status = int(result.get("status", 503))
        raw = result.get("raw", b"")
        headers = result.get("headers", {})
        self.send_response(status)
        content_type = headers.get("Content-Type", "application/octet-stream")
        if not isinstance(content_type, str) or not SAFE_HEADER_VALUE.fullmatch(content_type):
            content_type = "application/octet-stream"
        self.send_header("Content-Type", content_type)
        for name in ("X-Api-Status-Code", "X-Request-Id", "X-Xiaoxi-Error-Origin", "Retry-After", "Cache-Control"):
            value = headers.get(name)
            if isinstance(value, str) and SAFE_HEADER_VALUE.fullmatch(value):
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

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
        match = re.fullmatch(r"/apimart/(videos/generations|seedance2/private-avatar/assets)", suffix)
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

    def _proxy_upstream(self, method, provider, target, body):
        operation = Request(target, data=body, headers=self._upstream_headers(provider), method=method)
        response = None
        try:
            upstream_open = self.config.upstream_open
            if provider == "apimart" and self.config.apimart_open is not None:
                upstream_open = self.config.apimart_open
            response = upstream_open(
                operation,
                timeout=self.config.upstream_timeout_seconds,
            )
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
            return self._json_result(
                504, {"error": "provider_timeout"},
                {"X-Xiaoxi-Error-Origin": "gateway_transport"},
            )
        except (URLError, OSError):
            return self._json_result(
                503, {"error": "provider_unavailable"},
                {"X-Xiaoxi-Error-Origin": "gateway_transport"},
            )
        except Exception:
            return self._json_result(
                503, {"error": "provider_unavailable"},
                {"X-Xiaoxi-Error-Origin": "gateway_transport"},
            )
        finally:
            try:
                if response is not None:
                    response.close()
            except (AttributeError, OSError):
                pass
        if not isinstance(raw, (bytes, bytearray)) or len(raw) > self.config.max_response_bytes:
            return self._json_result(
                502, {"error": "provider_response_too_large"},
                {"X-Xiaoxi-Error-Origin": "gateway_response"},
            )
        headers = {}
        content_type = response_headers.get("Content-Type", "application/octet-stream")
        if isinstance(content_type, str) and SAFE_HEADER_VALUE.fullmatch(content_type):
            headers["Content-Type"] = content_type
        for name in ("X-Api-Status-Code", "X-Request-Id", "Retry-After", "Cache-Control"):
            value = response_headers.get(name)
            if isinstance(value, str) and SAFE_HEADER_VALUE.fullmatch(value):
                headers[name] = value
        if status < 200 or status >= 300:
            headers["X-Xiaoxi-Error-Origin"] = "upstream"
        return {"status": status, "headers": headers, "raw": bytes(raw)}

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
        avatar_library = provider == "apimart" and parsed.path.endswith("/seedance2/private-avatar/assets")
        avatar_prefix = None
        avatar_group = None
        if avatar_library:
            token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            subject = self.config.sessions.subject(token)
            if subject is None:
                return self._reply_json(401, {"error": "session_required"})
            # The upstream key is shared. Bind submitted names to this license,
            # then strip the prefix only after filtering its own library rows.
            avatar_prefix = "xh_" + self.server.receipts._subject(subject)[:24] + "_"
            if method == "GET" and query:
                groups = query.get("group") if set(query) == {"group"} else None
                if not groups or len(groups) != 1 or not re.fullmatch(r"dh_(?:[a-f0-9]{24}|[a-f0-9-]{36})", groups[0]):
                    return self._reply_json(400, {"error": "invalid_query"})
                avatar_group = avatar_prefix + groups[0]
        if provider == "apimart" and ("/videos/" in parsed.path or "/private-avatar/" in parsed.path):
            is_video = parsed.path.endswith("/videos/generations")
            is_asset_collection = parsed.path.endswith("/private-avatar/assets")
            if query and avatar_group is None:
                return self._reply_json(400, {"error": "invalid_query"})
            if (is_video and method != "POST") or (not is_video and method not in ({"GET", "POST"} if is_asset_collection else {"GET"})):
                return self._reply_json(405, {"error": "method_not_allowed"})
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
            if avatar_library:
                try:
                    payload = json.loads(body)
                    if not isinstance(payload, dict) or set(payload) - {"model", "group", "asset_type", "assets"}:
                        raise ValueError("fields")
                    assets = payload.get("assets")
                    group = payload.get("group")
                    if payload.get("model") != "seedance-2.5" or payload.get("asset_type") != "Image" or not isinstance(assets, list) or not 1 <= len(assets) <= 20:
                        raise ValueError("assets")
                    if (not isinstance(group, dict) or set(group) != {"name"}
                            or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(group["name"]))
                            or len(avatar_prefix + group["name"]) > 64):
                        raise ValueError("group")
                    group["name"] = avatar_prefix + group["name"]
                    for asset in assets:
                        if (not isinstance(asset, dict) or set(asset) != {"url", "name"}
                                or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(asset["name"]))
                                or len(avatar_prefix + asset["name"]) > 64):
                            raise ValueError("asset")
                        if not isinstance(asset["url"], str):
                            raise ValueError("asset_url")
                        source = urlsplit(asset["url"])
                        if source.scheme != "https" or not source.hostname or source.username or source.password:
                            raise ValueError("asset_url")
                        asset["name"] = avatar_prefix + asset["name"]
                    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                except (ValueError, TypeError, KeyError, UnicodeError):
                    return self._reply_json(400, {"error": "invalid_avatar_submission"})

        operation_id = self.headers.get("X-Xiaoxi-Operation-Id", "").strip()
        key = None
        entry = None
        owner = True
        subject = None
        if method == "POST" and OPERATION_ID.fullmatch(operation_id):
            token = self.headers.get('Authorization', '').removeprefix('Bearer ').strip()
            subject = self.config.sessions.subject(token)
            if subject is None:
                return self._reply_json(401, {'error': 'session_required'})
            # Include every result-affecting header forwarded upstream. The digest keeps
            # credentials and tenant identifiers out of the in-flight map and logs.
            parameters = {name.lower(): value for name, value in self.headers.items()
                          if name.lower() not in {'authorization', 'connection', 'content-length',
                              'host', 'user-agent', 'x-request-id', 'x-xiaoxi-operation-id'}}
            key = hashlib.sha256(json.dumps([subject, operation_id, method, provider, target,
                parameters, hashlib.sha256(body or b'').hexdigest()], sort_keys=True).encode()).hexdigest()
            state, entry, stored = self.server.begin_operation(subject, operation_id, key)
            if state == "completed":
                return self._send_result(stored)
            if state in {"expired", "unrecoverable"} or state == "pending" and entry is None:
                return self._reply_json(409, {"error": "operation_outcome_unknown"})
            owner = state == "new"
            if not owner:
                if not entry["event"].wait(self.config.upstream_timeout_seconds + 60):
                    return self._send_result(self._json_result(
                        504, {"error": "provider_request_coalesced_timeout"},
                        {"X-Xiaoxi-Error-Origin": "coalesced_timeout"},
                    ))
                return self._send_result(entry["result"] or self._json_result(
                    503, {"error": "provider_unavailable"},
                    {"X-Xiaoxi-Error-Origin": "gateway_transport"},
                ))
        try:
            if avatar_group:
                group_target = self.config.origins["apimart"] + "/v1/seedance2/private-avatar/groups?name=" + quote(avatar_group, safe="")
                group_result = self._proxy_upstream("GET", "apimart", group_target, None)
                if not 200 <= group_result["status"] < 300:
                    return self._reply_json(502, {"error": "avatar_group_lookup_failed"})
                try:
                    groups_payload = json.loads(group_result["raw"])
                    groups_data = groups_payload.get("Result", groups_payload.get("data", groups_payload))
                    groups_rows = groups_data.get("Items", groups_data.get("items"))
                    if not isinstance(groups_rows, list):
                        raise ValueError("unsupported_group_response")
                    owned_groups = [row for row in groups_rows if isinstance(row, dict)
                                    and row.get("Name", row.get("name")) == avatar_group]
                    if not owned_groups:
                        return self._reply_json(200, {"data": {"items": []}})
                    if len(owned_groups) != 1:
                        raise ValueError("ambiguous_group")
                    group_id = owned_groups[0].get("Id", owned_groups[0].get("id"))
                    if not isinstance(group_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,255}", group_id):
                        raise ValueError("invalid_group_id")
                    target += "?group_id=" + quote(group_id, safe="")
                except (ValueError, TypeError, AttributeError):
                    return self._reply_json(502, {"error": "avatar_group_response_invalid"})
            result = self._proxy_upstream(method, provider, target, body)
            if avatar_library and method == "GET" and 200 <= result["status"] < 300:
                try:
                    payload = json.loads(result["raw"])
                    if not isinstance(payload, dict):
                        raise ValueError("unsupported_library_response")
                    data = payload.get("Result", payload.get("data", payload))
                    rows = data if isinstance(data, list) else data.get("Items", data.get("items", data.get("assets", data.get("list"))))
                    if not isinstance(rows, list):
                        raise ValueError("unsupported_library_response")
                    owned = []
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        name = str(row.get("Name", row.get("name", row.get("asset_name", ""))))
                        if name.startswith(avatar_prefix):
                            item = {
                                "id": row.get("Id", row.get("id", row.get("asset_id"))),
                                "status": row.get("Status", row.get("status", row.get("moderation_status"))),
                            }
                            if not isinstance(item["id"], str) or not isinstance(item["status"], str):
                                continue
                            item["name"] = name[len(avatar_prefix):]
                            owned.append(item)
                    result = self._json_result(200, {"data": {"items": owned}}, {"Content-Type": "application/json"})
                except (ValueError, TypeError, AttributeError):
                    result = self._json_result(502, {"error": "avatar_library_response_invalid"})
        except Exception:
            result = self._json_result(
                503, {"error": "provider_unavailable"},
                {"X-Xiaoxi-Error-Origin": "gateway_transport"},
            )
        finally:
            if key is not None and entry is not None and owner:
                try:
                    self.server.receipts.finish(subject, operation_id, key, result)
                finally:
                    self.server.finish_inflight(key, entry, result)
        return self._send_result(result)

    def do_GET(self):
        limit = self.server.rate_limit(self.client_address[0])
        if not limit["allowed"]:
            return self._reply_json(
                429,
                {"error": "rate_limit", "scope": limit["scope"]},
                {"X-Xiaoxi-Error-Origin": "gateway_rate_limit", "Retry-After": str(limit["retry_after"])},
            )
        route = urlsplit(self.path).path
        if route == PREFIX + "/health":
            return self._reply_json(200, {
                "ok": True,
                "service": "provider-gateway",
                "schema": 1,
                "runtime_revision": self.config.runtime_revision,
                "upstream_timeout_seconds": self.config.upstream_timeout_seconds,
            })
        if route == PREFIX + "/capabilities":
            if not self._session():
                return self._reply_json(401, {"error": "session_required"})
            return self._reply_json(200, {"ok": True, "schema": 1, "capabilities": self.config.capabilities()})
        operation = route.removeprefix(PREFIX + "/operations/") if route.startswith(PREFIX + "/operations/") else ""
        if operation:
            if not OPERATION_ID.fullmatch(operation):
                return self._reply_json(404, {"error": "not_found"})
            token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            subject = self.config.sessions.subject(token)
            if subject is None:
                return self._reply_json(401, {"error": "session_required"})
            state, result, fingerprint = self.server.receipts.lookup(subject, operation)
            if state == "completed":
                return self._send_result(result)
            if state == "pending":
                with self.server.inflight_lock:
                    active = fingerprint in self.server.inflight
                return self._reply_json(202 if active else 409,
                                        {"status": "pending"} if active else {"error": "operation_outcome_unknown"})
            return self._reply_json(404 if state == "missing" else 409,
                                    {"error": "receipt_not_found" if state == "missing" else "operation_outcome_unknown"})
        if route.startswith(PREFIX + "/"):
            return self._proxy("GET")
        return self._reply_json(404, {"error": "not_found"})

    def do_POST(self):
        limit = self.server.rate_limit(self.client_address[0])
        if not limit["allowed"]:
            return self._reply_json(
                429,
                {"error": "rate_limit", "scope": limit["scope"]},
                {"X-Xiaoxi-Error-Origin": "gateway_rate_limit", "Retry-After": str(limit["retry_after"])},
            )
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
    config.receipt_db_path = "/var/lib/ai-provider-gateway/operation-receipts.sqlite3"
    server = GatewayServer((args.host, args.port), Handler, config)
    server.serve_forever()


if __name__ == "__main__":
    main()
