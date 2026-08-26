from __future__ import annotations

import json
import ipaddress
import mimetypes
import os
from pathlib import Path
import re
import socket
import time
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request
import uuid


DEFAULT_BASE_URL = "https://api.apimart.ai/v1"
DEFAULT_MODEL = "gpt-image-2"
ACTIVE_STATUSES = frozenset(
    {"submitted", "pending", "queued", "processing", "in_progress"}
)
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_REFERENCE_BYTES = 20 * 1024 * 1024
REFERENCE_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
_SECRET_PATTERNS = (
    re.compile(r"(?i)\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"),
    re.compile(
        r"(?i)((?:api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*)"
        r"[\"']?[^\s,;\"']+"
    ),
)


class APIMartError(RuntimeError):
    pass


class APIMartOutcomeUnknown(APIMartError):
    def __init__(self, task_id: str, message: str):
        self.task_id = str(task_id or "")
        super().__init__(message)


class APIMartTaskFailed(APIMartError):
    pass


class APIMartPollingStopped(APIMartError):
    pass


class ProviderResponseTooLarge(APIMartError):
    pass


class ProviderResponseIncomplete(APIMartError):
    pass


class ProviderUrlError(ValueError):
    pass


def _url_origin(url: str) -> tuple[str, str, int]:
    parsed = urllib.parse.urlsplit(str(url or ""))
    hostname = str(parsed.hostname or "").casefold()
    try:
        port = parsed.port or (443 if parsed.scheme.casefold() == "https" else 80)
    except ValueError as error:
        raise ProviderUrlError("Provider URL port is invalid.") from error
    return parsed.scheme.casefold(), hostname, port


def _resolved_addresses(hostname: str, port: int, resolver=socket.getaddrinfo):
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            results = resolver(hostname, port, type=socket.SOCK_STREAM)
        except OSError as error:
            raise ProviderUrlError("Provider download hostname could not be resolved.") from error
        addresses = []
        for result in results:
            sockaddr = result[4] if len(result) > 4 else None
            if not sockaddr:
                continue
            try:
                addresses.append(ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0]))
            except ValueError as error:
                raise ProviderUrlError("Provider download address is invalid.") from error
        if not addresses:
            raise ProviderUrlError("Provider download hostname has no usable address.")
        return addresses
    return [literal]


def validate_public_https_url(
    url: str,
    *,
    resolver=socket.getaddrinfo,
    resolve_dns: bool = True,
) -> str:
    if not isinstance(url, str) or len(url) > 4_096:
        raise ProviderUrlError("Provider download URL is invalid.")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or "%" in parsed.hostname
    ):
        raise ProviderUrlError("Provider download URL must be a public HTTPS URL.")
    hostname = parsed.hostname.casefold().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise ProviderUrlError("Provider download URL resolves to a local hostname.")
    try:
        port = parsed.port or 443
    except ValueError as error:
        raise ProviderUrlError("Provider download URL port is invalid.") from error
    if port != 443:
        raise ProviderUrlError("Provider download URL must use the HTTPS port.")
    if not resolve_dns:
        try:
            literal = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            return url
        addresses = [literal]
    else:
        addresses = _resolved_addresses(parsed.hostname, port, resolver)
    if any(not address.is_global for address in addresses):
        raise ProviderUrlError("Provider download URL resolves to a non-public address.")
    return url


class _ProviderRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, *, resolver=socket.getaddrinfo):
        super().__init__()
        self._resolver = resolver

    def redirect_request(self, request, fp, code, message, headers, new_url):
        target = urllib.parse.urljoin(request.full_url, str(new_url or ""))
        if request.get_header("Authorization") and _url_origin(target) != _url_origin(
            request.full_url
        ):
            raise urllib.error.HTTPError(
                request.full_url,
                code,
                "Cross-origin authenticated redirect blocked.",
                headers,
                fp,
            )
        public_download = bool(
            getattr(request, "_xiaoxi_public_download", False)
        )
        if public_download:
            validate_public_https_url(target, resolver=self._resolver)
        redirected = super().redirect_request(
            request, fp, code, message, headers, target
        )
        if redirected is not None and public_download:
            redirected._xiaoxi_public_download = True
        return redirected


# The content engine is a dedicated sidecar process. Installing one provider-safe
# opener here keeps existing urlopen call sites and test seams while applying the
# redirect policy consistently to both APIMart and DashScope requests.
_PROVIDER_OPENER = urllib.request.build_opener(_ProviderRedirectHandler())
urllib.request.install_opener(_PROVIDER_OPENER)


def provider_urlopen(operation, *, timeout):
    # Reassert the sidecar-wide policy in case another dependency replaced the
    # process opener after this module was imported.
    urllib.request.install_opener(_PROVIDER_OPENER)
    return urllib.request.urlopen(operation, timeout=timeout)


def _read_limited(response, max_bytes: int) -> bytes:
    raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ProviderResponseTooLarge("Provider response exceeds the allowed size.")
    return raw


def _read_complete_limited(response, max_bytes: int) -> bytes:
    try:
        value = response.headers.get("Content-Length")
    except AttributeError:
        value = None
    try:
        declared_size = int(value) if isinstance(value, (str, int)) else None
    except ValueError:
        declared_size = None
    if declared_size is not None and declared_size > max_bytes:
        raise ProviderResponseTooLarge("Provider response exceeds the allowed size.")
    raw = _read_limited(response, max_bytes)
    if declared_size is not None and declared_size >= 0 and len(raw) != declared_size:
        raise ProviderResponseIncomplete(
            "Provider response ended before its declared Content-Length."
        )
    return raw


def public_https_get(
    url: str,
    *,
    timeout: int,
    max_bytes: int,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    validate_public_https_url(url)
    operation = urllib.request.Request(
        url,
        method="GET",
        headers=headers or {},
    )
    operation._xiaoxi_public_download = True
    try:
        with provider_urlopen(operation, timeout=timeout) as response:
            final_url = str(response.geturl() or url)
            validate_public_https_url(final_url)
            return response.status, _read_complete_limited(response, max_bytes)
    except urllib.error.HTTPError as error:
        try:
            raw = _read_limited(error, max_bytes)
        except (APIMartError, AttributeError):
            raw = b""
        return error.code, raw


def _detected_image_mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in {b"GIF87a", b"GIF89a"}:
        return "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _scrub_provider_detail(value: Any, *, api_key: str = "") -> str:
    result = str(value or "provider_error")[:1_000]
    if api_key:
        result = result.replace(api_key, "[redacted secret]")
    for pattern in _SECRET_PATTERNS:
        result = pattern.sub(
            lambda match: (
                f"{match.group(1)}[redacted secret]"
                if match.lastindex
                else "[redacted secret]"
            ),
            result,
        )
    return result[:240]


def _stdlib_request(
    method,
    url,
    *,
    payload=None,
    body=None,
    headers=None,
    timeout=30,
    max_bytes=MAX_RESPONSE_BYTES,
):
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        method=method,
        data=body,
        headers=headers or {},
    )
    try:
        with provider_urlopen(request, timeout=timeout) as response:
            return response.status, response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        return error.code, error.read(max_bytes + 1)


class APIMartCoverClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        request_fn: Callable[..., tuple[int, bytes]] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.api_key = str(
            api_key if api_key is not None else os.environ.get("APIMART_API_KEY", "")
        ).strip()
        self.base_url = str(
            base_url
            if base_url is not None
            else os.environ.get("APIMART_API_BASE_URL", DEFAULT_BASE_URL)
        ).strip().rstrip("/")
        self.model = str(
            model
            if model is not None
            else os.environ.get("APIMART_IMAGE_MODEL", DEFAULT_MODEL)
        ).strip()
        self._request = request_fn or _stdlib_request
        self._uses_stdlib_request = request_fn is None
        self._sleep = sleep
        self._monotonic = monotonic

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "Xiaoxi-Creative-Workbench/1.0",
        }

    @staticmethod
    def _json_body(raw: bytes) -> Any:
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _safe_detail(self, body: Any) -> str:
        if not isinstance(body, dict):
            return "provider_error"
        error = body.get("error")
        if isinstance(error, dict):
            value = error.get("message") or error.get("type")
        else:
            value = body.get("message") or body.get("code")
        return _scrub_provider_detail(value, api_key=self.api_key)

    @staticmethod
    def _task_id(body: Any) -> str:
        if not isinstance(body, dict):
            return ""
        data = body.get("data") or []
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if isinstance(node, dict):
                task_id = node.get("task_id") or node.get("id")
                if task_id:
                    return str(task_id)[:255]
        return ""

    def _upload_reference(self, reference_path: Path) -> str:
        reference_path = Path(reference_path).resolve(strict=True)
        size = reference_path.stat().st_size
        mime = mimetypes.guess_type(reference_path.name)[0] or ""
        if not size or size > MAX_REFERENCE_BYTES or mime not in REFERENCE_MIME_TYPES:
            raise APIMartError(
                "APIMart reference image must be a supported image no larger than 20MB."
            )
        if self._uses_stdlib_request:
            with reference_path.open("rb") as reference_file:
                detected_mime = _detected_image_mime(reference_file.read(16))
            if detected_mime != mime:
                raise APIMartError(
                    "APIMart reference image content does not match its file type."
                )
        boundary = f"----xiaoxi-cover-{uuid.uuid4().hex}"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", reference_path.name)[:120]
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("ascii") + reference_path.read_bytes() + (
            f"\r\n--{boundary}--\r\n"
        ).encode("ascii")
        try:
            status, raw = self._request(
                "POST",
                f"{self.base_url}/uploads/images",
                body=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                    "User-Agent": "Xiaoxi-Creative-Workbench/1.0",
                },
                timeout=60,
            )
        except Exception as error:
            raise APIMartError("APIMart reference image upload failed.") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise APIMartError("APIMart reference upload response is too large.")
        response = self._json_body(raw)
        node = response.get("data") if isinstance(response, dict) else None
        url = (
            response.get("url")
            if isinstance(response, dict)
            else None
        ) or (node.get("url") if isinstance(node, dict) else None)
        if not 200 <= int(status) < 300 or not isinstance(url, str) or not url.startswith(
            "https://"
        ):
            raise APIMartError(
                f"APIMart reference image upload failed: {self._safe_detail(response)}"
            )
        return url

    def submit(self, prompt: str, *, reference_path: Path | None = None) -> str:
        if not self.configured:
            raise APIMartError("APIMart cover generation is not configured.")
        payload = {
            "model": self.model,
            "prompt": str(prompt or "")[:5_000],
            "n": 1,
            "size": "9:16",
            "resolution": "1k",
        }
        if reference_path is not None:
            payload["image_urls"] = [self._upload_reference(reference_path)]
        try:
            status, raw = self._request(
                "POST",
                f"{self.base_url}/images/generations",
                payload=payload,
                headers=self._headers(),
                timeout=30,
            )
        except Exception as error:
            raise APIMartOutcomeUnknown(
                "", "APIMart submission response was not confirmed."
            ) from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise APIMartOutcomeUnknown(
                "", "APIMart submission response exceeded the allowed size."
            )
        body = self._json_body(raw)
        task_id = self._task_id(body)
        if task_id:
            return task_id
        if 400 <= int(status) < 500:
            raise APIMartError(
                f"APIMart rejected the cover request: {self._safe_detail(body)}"
            )
        raise APIMartOutcomeUnknown(
            "", f"APIMart submission outcome is unknown: {self._safe_detail(body)}"
        )

    def poll(
        self,
        task_id: str,
        *,
        poll_interval: float = 3,
        poll_timeout: float = 480,
        should_stop: Callable[[], bool] | None = None,
    ) -> str:
        if not self.configured:
            raise APIMartError("APIMart cover generation is not configured.")
        task_id = str(task_id or "").strip()
        if not task_id:
            raise APIMartOutcomeUnknown("", "APIMart provider task ID is missing.")
        started = self._monotonic()
        consecutive_errors = 0
        while True:
            if should_stop is not None and should_stop():
                raise APIMartPollingStopped(
                    "APIMart cover polling was paused locally."
                )
            if self._monotonic() - started > poll_timeout:
                raise APIMartOutcomeUnknown(task_id, "APIMart cover polling timed out.")
            try:
                status_code, raw = self._request(
                    "GET",
                    f"{self.base_url}/tasks/{task_id}?language=en",
                    headers=self._headers(),
                    timeout=30,
                )
            except Exception as error:
                consecutive_errors += 1
                if consecutive_errors >= 3:
                    raise APIMartOutcomeUnknown(
                        task_id, "APIMart cover polling repeatedly failed."
                    ) from error
                self._interruptible_sleep(poll_interval, should_stop)
                continue
            consecutive_errors = 0
            if len(raw) > MAX_RESPONSE_BYTES:
                raise APIMartOutcomeUnknown(
                    task_id, "APIMart cover status response exceeded the allowed size."
                )
            body = self._json_body(raw)
            if not 200 <= int(status_code) < 300 or not isinstance(body, dict):
                raise APIMartOutcomeUnknown(task_id, "APIMart cover status is invalid.")
            node = body.get("data") or body
            if not isinstance(node, dict):
                raise APIMartOutcomeUnknown(task_id, "APIMart cover status is invalid.")
            status = str(node.get("status") or "").lower()
            if status == "completed":
                result = node.get("result") or {}
                images = result.get("images") if isinstance(result, dict) else None
                first = images[0] if isinstance(images, list) and images else None
                url = first.get("url") if isinstance(first, dict) else ""
                if isinstance(url, list):
                    url = url[0] if url else ""
                if isinstance(url, str) and url.startswith("https://"):
                    return url
                raise APIMartOutcomeUnknown(
                    task_id, "APIMart completed without a usable cover URL."
                )
            if status in {"failed", "cancelled"}:
                raise APIMartTaskFailed(
                    f"APIMart cover task {status}: {self._safe_detail(node)}"
                )
            if status not in ACTIVE_STATUSES:
                raise APIMartOutcomeUnknown(
                    task_id, "APIMart returned an unknown cover status."
                )
            self._interruptible_sleep(poll_interval, should_stop)

    def _interruptible_sleep(self, seconds, should_stop):
        remaining = max(0.0, float(seconds))
        while remaining > 0:
            if should_stop is not None and should_stop():
                raise APIMartPollingStopped(
                    "APIMart cover polling was paused locally."
                )
            interval = min(0.25, remaining)
            self._sleep(interval)
            remaining -= interval

    def download(self, url: str, target: Path) -> Path:
        try:
            validate_public_https_url(
                url,
                resolve_dns=self._uses_stdlib_request,
            )
        except ProviderUrlError as error:
            raise APIMartOutcomeUnknown(
                "", "APIMart cover URL is invalid."
            ) from error
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f"{target.suffix}.downloading")
        try:
            if self._uses_stdlib_request:
                try:
                    status, raw = public_https_get(
                        url,
                        timeout=60,
                        max_bytes=MAX_DOWNLOAD_BYTES,
                        headers={"User-Agent": "Xiaoxi-Creative-Workbench/1.0"},
                    )
                except (ProviderResponseTooLarge, ProviderUrlError) as error:
                    raise APIMartOutcomeUnknown(
                        "", "APIMart cover download is invalid."
                    ) from error
            else:
                status, raw = self._request(
                    "GET",
                    url,
                    headers={"User-Agent": "Xiaoxi-Creative-Workbench/1.0"},
                    timeout=60,
                )
            if not 200 <= int(status) < 300 or not raw or len(raw) > MAX_DOWNLOAD_BYTES:
                raise APIMartOutcomeUnknown("", "APIMart cover download is invalid.")
            if self._uses_stdlib_request and not _detected_image_mime(raw[:16]):
                raise APIMartOutcomeUnknown("", "APIMart cover download is not an image.")
            temporary.write_bytes(raw)
            temporary.replace(target)
            return target
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
