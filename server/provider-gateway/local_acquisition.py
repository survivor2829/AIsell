"""Precise acquisition: independent paid reservations and bounded public evidence.

No browser credentials, arbitrary proxying, or model-generated URL execution.
"""
import base64
import hashlib
import html
from html.parser import HTMLParser
import http.client
import io
import ipaddress
import os
import re
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit, urljoin
from material_search import MaterialSearch, public_url

MAX_BYTES = 20 * 1024 * 1024


class TextPage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.parts = []
        self.dates = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        values = dict(attrs)
        if tag == "meta" and values.get("property", values.get("name", "")).lower() in ("article:published_time", "date", "pubdate"):
            self.dates.append(values.get("content", ""))
        if tag in ("p", "div", "br", "li", "tr", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def parse_document(raw, kind):
    if len(raw) > MAX_BYTES:
        raise ValueError("document_too_large")
    if kind == "pdf" or raw.startswith(b"%PDF"):
        if "--pdf-worker" not in sys.argv:
            try:
                result = subprocess.run([sys.executable, __file__, "--pdf-worker"], input=raw, capture_output=True, timeout=20, check=True)
                return __import__("json").loads(result.stdout)
            except (subprocess.SubprocessError, ValueError):
                return {"status": "incomplete", "text": "", "parseIncomplete": True, "reason": "pdf_worker_failed"}
        try:
            from pypdf import PdfReader
        except ImportError:
            return {"status": "incomplete", "text": "", "parseIncomplete": True, "reason": "pdf_parser_not_installed"}
        try:
            reader = PdfReader(io.BytesIO(raw))
            pages = len(reader.pages)
            content = "\n".join(page.extract_text() or "" for page in reader.pages[:100])
            return {"status": "completed" if content.strip() else "incomplete", "text": content[:120000], "parseIncomplete": pages > 100 or not content.strip() or len(content) > 120000,
                    "reason": "ocr_required" if not content.strip() else "", "pages": min(pages, 100)}
        except Exception:
            return {"status": "incomplete", "text": "", "parseIncomplete": True, "reason": "pdf_unreadable"}
    content = raw.decode("utf-8-sig", errors="replace")
    dates = []
    if kind == "html" or re.search(r"<html|<!doctype", content[:1000], re.I):
        page = TextPage()
        page.feed(content)
        content, dates = "".join(page.parts), page.dates
    content = re.sub(r"[ \t]+", " ", html.unescape(content))
    return {"status": "completed", "text": content[:120000], "parseIncomplete": len(content) > 120000 or '\ufffd' in content, "publishedHints": dates[:5]}


def public_addresses(host, port, resolver=socket.getaddrinfo):
    answers = resolver(host, port, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(row[4][0] for row in answers))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ValueError("non_public_destination")
    return addresses


def read_public(url, hosts, resolver=socket.getaddrinfo):
    for _ in range(4):
        if not public_url(url):
            raise ValueError("invalid_source_url")
        target = urlsplit(url)
        host = target.hostname.lower()
        if host not in hosts:
            raise ValueError("source_not_authorized")
        port = target.port or (443 if target.scheme == "https" else 80)
        addresses = public_addresses(host, port, resolver)
        # Pin the validated address. Do not resolve it again inside urllib or
        # accept machine proxy settings; TLS still verifies the original host.
        sock = socket.create_connection((addresses[0], port), timeout=20)
        connection = None
        try:
            if target.scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            connection = http.client.HTTPConnection(host, port, timeout=20)
            connection.sock = sock
            route = target.path or "/"
            if target.query:
                route += "?" + target.query
            connection.request("GET", route, headers={"Host": target.netloc, "Accept": "text/html,application/pdf,text/plain", "User-Agent": "XiaoxiEvidence/1.0"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                url = urljoin(url, response.getheader("Location", ""))
                continue
            if response.status != 200:
                return {"status": "unavailable", "reason": "source_http_" + str(response.status), "text": ""}
            content_type = response.getheader("Content-Type", "").lower()
            if not any(t in content_type for t in ("text/", "application/pdf", "application/xhtml+xml")):
                raise ValueError("unsupported_document")
            raw = response.read(MAX_BYTES + 1)
            result = parse_document(raw, "pdf" if "pdf" in content_type else "html" if "html" in content_type else "text")
            result["resolvedUrl"] = url
            return result
        finally:
            if connection:
                connection.close()
            sock.close()
    raise ValueError("too_many_redirects")


class LocalAcquisition:
    def __init__(self, path, env=None, transport=None, reader=None):
        env = os.environ if env is None else env
        # Deliberately separate from the materials budget. Existing Bocha keys
        # or enabled material search never authorize this product's paid calls.
        mapped = {"XIAOXI_BOCHA_API_KEY": env.get("XIAOXI_BOCHA_API_KEY", "")}
        for suffix in ("ENABLED", "BUDGET_MICROS", "COST_MICROS", "DAILY_LIMIT"):
            mapped["XIAOXI_MATERIAL_SEARCH_" + suffix] = env.get("XIAOXI_PRECISE_SEARCH_" + suffix, "0")
        self.searcher = MaterialSearch(path, env=mapped, transport=transport)
        self.read_enabled = env.get("XIAOXI_PRECISE_PUBLIC_READ_ENABLED") == "1"
        self.hosts = {h.strip().lower() for h in env.get("XIAOXI_PRECISE_SOURCE_HOSTS", "").split(",") if h.strip()}
        self.reader = reader or read_public

    def status(self):
        try:
            import pypdf  # noqa: F401
            pdf = True
        except ImportError:
            pdf = False
        search = self.searcher.status()["enabled"]
        return {"search": search and self.read_enabled and bool(self.hosts), "read": self.read_enabled and bool(self.hosts), "pdf": pdf,
                "professional": False, "reason": "" if search and self.read_enabled and self.hosts else "搜索预算、来源授权或原文读取尚未接通；可先导入资料"}

    def handle(self, action, subject, body):
        if action == "status":
            return self.status()
        if action == "parse":
            raw = base64.b64decode(body.get("content", ""), validate=True)
            return parse_document(raw, body.get("kind", "text"))
        if action == "read":
            if not self.read_enabled or not self.hosts:
                return {"status": "unavailable", "text": "", "reason": "source_not_authorized"}
            try:
                return self.reader(body.get("url", ""), self.hosts)
            except (ValueError, OSError, http.client.HTTPException):
                return {"status": "unavailable", "text": "", "reason": "source_unavailable_or_not_authorized"}
        if action == "search":
            task, step = body.get("taskId"), body.get("step")
            if not isinstance(task, str) or not re.fullmatch(r"[a-fA-F0-9-]{36}", task) or type(step) is not int or not 0 <= step < 12:
                raise ValueError("invalid_task")
            if not self.status()["search"]:
                return {"enabled": False, "status": "unavailable", "items": [], "message": self.status()["reason"]}
            query = body.get("query")
            if not isinstance(query, str) or not 1 <= len(query.strip()) <= 300:
                raise ValueError("invalid_query")
            fingerprint = hashlib.sha256(query.strip().encode()).hexdigest()
            owner = hashlib.sha256(subject.encode()).hexdigest()
            with self.searcher.lock:
                previous = self.searcher.db.execute("SELECT state,result,day FROM material_search_calls WHERE subject=? AND query_hash=? ORDER BY day DESC,rowid DESC LIMIT 1", (owner, fingerprint)).fetchone()
                if previous and previous[0] != "completed":
                    return {"enabled": False, "status": "unavailable", "items": [], "code": "outcome_unknown", "message": "相同查询结果待核对，未重新购买"}
                if previous and previous[2] == int(time.time() // 86400):
                    result = __import__("json").loads(previous[1])
                    result.update(taskId=task + "_" + str(step), cached=True)
                else:
                    result = self.searcher.search(subject, {"taskId": task + "_" + str(step), "round": 1, "query": query})
            if result.get("message") and not result.get("items"):
                result.update(status="unavailable", enabled=False, code="budget_or_outcome_unavailable")
            # Summary is discovery-only. Only a subsequent original read can be
            # used as evidence or supply a trustworthy date.
            return {**result, "items": [{"url": i["url"], "title": i["title"], "discoveryOnly": True} for i in result["items"]]}
        raise ValueError("unknown_action")

    def close(self):
        self.searcher.db.close()


if __name__ == "__main__" and "--pdf-worker" in sys.argv:
    import json
    if sys.platform != "win32":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    print(json.dumps(parse_document(sys.stdin.buffer.read(MAX_BYTES + 1), "pdf"), ensure_ascii=False))
