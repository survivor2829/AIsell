"""WeChat share-card signature for the official site (https://www.xilianhui.cn/huoke/).

The page asks GET /huoke/api/wx-sign?url=<page address>; this answers {appId, timestamp, nonceStr,
signature} so the page can set its own share title, line and picture (user request 2026-11-18).

- Only addresses of the official site are signed.
- The AppSecret comes from the environment (WX_APPID, WX_SECRET) and never leaves this process.
- access_token and jsapi_ticket are cached until shortly before they expire, so WeChat is asked at
  most a few times a day whatever the traffic.
Standard library only; runs in a python:3.12-alpine container next to the site.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_HOSTS = {"www.xilianhui.cn", "xilianhui.cn"}
ALLOWED_PREFIX = "/huoke/"
ROUTE = "/huoke/api/wx-sign"
WECHAT = "https://api.weixin.qq.com/cgi-bin"


def signature(ticket: str, nonce: str, timestamp: int, url: str) -> str:
    """WeChat JS-SDK signature: sha1 over the four fields in this exact order and form."""
    plain = f"jsapi_ticket={ticket}&noncestr={nonce}&timestamp={timestamp}&url={url}"
    return hashlib.sha1(plain.encode("utf-8")).hexdigest()


def allowed_page(value: str) -> str | None:
    """The page address to sign, without its #fragment; None for anything not on the official site."""
    if not isinstance(value, str) or len(value) > 2000:
        return None
    page = value.split("#", 1)[0]
    parts = urllib.parse.urlsplit(page)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS or parts.port not in (None, 443):
        return None
    if not (parts.path + "/").startswith(ALLOWED_PREFIX) and parts.path != ALLOWED_PREFIX.rstrip("/"):
        return None
    return page


class Tickets:
    """The jsapi ticket, fetched through an access token, both cached until five minutes before expiry."""

    def __init__(self, app_id: str, secret: str, fetch=None, clock=time.time):
        self.app_id, self.secret, self.clock = app_id, secret, clock
        self.fetch = fetch or self._fetch
        self.lock = threading.Lock()
        self.ticket, self.until = "", 0.0

    @staticmethod
    def _fetch(url: str) -> dict:
        with urllib.request.urlopen(url, timeout=10) as response:
            return json.loads(response.read(64 * 1024))

    def current(self) -> str:
        with self.lock:
            if self.ticket and self.clock() < self.until:
                return self.ticket
            token = self.fetch(f"{WECHAT}/token?" + urllib.parse.urlencode(
                {"grant_type": "client_credential", "appid": self.app_id, "secret": self.secret}))
            if not token.get("access_token"):
                raise RuntimeError(f"token_failed:{token.get('errcode', 'unknown')}")
            ticket = self.fetch(f"{WECHAT}/ticket/getticket?" + urllib.parse.urlencode(
                {"access_token": token["access_token"], "type": "jsapi"}))
            if ticket.get("errcode", 0) != 0 or not ticket.get("ticket"):
                raise RuntimeError(f"ticket_failed:{ticket.get('errcode', 'unknown')}")
            self.ticket = ticket["ticket"]
            self.until = self.clock() + max(60, int(ticket.get("expires_in", 7200)) - 300)
            return self.ticket


def make_handler(tickets: Tickets):
    class Handler(BaseHTTPRequestHandler):
        server_version = "wx-share-signer"

        def log_message(self, *_args):  # no page addresses or client details in logs
            return None

        def _reply(self, status: int, body: dict):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parts = urllib.parse.urlsplit(self.path)
            if parts.path != ROUTE:
                return self._reply(404, {"error": "not_found"})
            page = allowed_page((urllib.parse.parse_qs(parts.query).get("url") or [""])[0])
            if not page:
                return self._reply(400, {"error": "url_not_allowed"})
            try:
                ticket = tickets.current()
            except Exception as error:  # WeChat refused or unreachable: the page keeps the default card
                return self._reply(503, {"error": str(error)[:60] or "wechat_unavailable"})
            nonce, timestamp = secrets.token_hex(8), int(time.time())
            return self._reply(200, {"appId": tickets.app_id, "timestamp": timestamp, "nonceStr": nonce,
                                     "signature": signature(ticket, nonce, timestamp, page)})

    return Handler


def main():
    app_id, secret = os.environ.get("WX_APPID", "").strip(), os.environ.get("WX_SECRET", "").strip()
    if not app_id or not secret:
        raise SystemExit("WX_APPID and WX_SECRET are required")
    port = int(os.environ.get("PORT", "8090"))
    ThreadingHTTPServer(("0.0.0.0", port), make_handler(Tickets(app_id, secret))).serve_forever()


if __name__ == "__main__":
    main()
