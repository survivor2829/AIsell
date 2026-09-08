"""Small test maintenance service. Public HTTPS, administrator UI via SSH tunnel only."""
import argparse
import collections
from contextlib import contextmanager
import hashlib
import json
import os
import re
import sqlite3
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from feedback import FeedbackStoreMixin, FeedbackConflict, FeedbackUnauthorized, validate_feedback, STATES

TOKEN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
VERSION = re.compile(r"(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){2}\Z")
APP_IDS = {"test": "com.aihuoke.desktop.test", "delivery": "com.aihuoke.desktop", "smoke": "com.aihuoke.maintenance.smoke"}

def safe_token(value):
    return value if isinstance(value, str) and TOKEN.fullmatch(value) and not re.search(r"sk-|ak-|ltai", value, re.I) else ""

def validate_report(body):
    if not isinstance(body, dict) or body.get("schema") != 1:
        raise ValueError("schema")
    channel = body.get("channel")
    if channel not in APP_IDS or body.get("appId") != APP_IDS[channel]:
        raise ValueError("app")
    if not UUID.fullmatch(str(body.get("installId", ""))) or not VERSION.fullmatch(str(body.get("version", ""))):
        raise ValueError("identity")
    if body.get("platform") != "win32" or body.get("arch") != "x64":
        raise ValueError("platform")
    entries = body.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= 20:
        raise ValueError("entries")
    clean = {key: body[key] for key in ("schema", "appId", "channel", "installId", "version", "platform", "arch")}
    clean.update(buildId=safe_token(body.get("buildId")), osRelease=safe_token(body.get("osRelease")))
    clean["entries"] = []
    for entry in entries:
        if not isinstance(entry, dict) or not HEX.fullmatch(str(entry.get("id", ""))):
            raise ValueError("entry")
        if entry.get("level") not in ("info", "warn", "error", "fatal"):
            raise ValueError("level")
        if not safe_token(entry.get("module")) or not safe_token(entry.get("event")):
            raise ValueError("event")
        ts = entry.get("ts", "")
        if not isinstance(ts, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", ts):
            raise ValueError("time")
        row = {"id": entry["id"], "ts": ts, "level": entry["level"]}
        row.update({key: safe_token(entry.get(key)) for key in ("module", "event", "code", "phase")})
        row["traceId"] = entry.get("traceId") if UUID.fullmatch(str(entry.get("traceId", ""))) else ""
        duration = entry.get("durationMs", 0)
        row["durationMs"] = duration if type(duration) is int and 0 <= duration <= 86400000 else 0
        row["details"] = {}
        details = entry.get("details", {})
        if isinstance(details, dict):
            for key in ("receipt_stage", "receipt_code", "receipt_draft_read_stage", "state", "status", "phase", "reason_code", "error_code"):
                if safe_token(details.get(key)):
                    row["details"][key] = details[key]
            for key in ("receipt_conversation_verified", "receipt_draft_read_ok", "receipt_draft_consumed", "receipt_input_lease_valid", "receipt_bubble_verified"):
                if type(details.get(key)) is bool:
                    row["details"][key] = details[key]
        clean["entries"].append(row)
    return clean

class Store(FeedbackStoreMixin):
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "reports.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY, received INTEGER, install_id TEXT, version TEXT,
                    channel TEXT, module TEXT, code TEXT, level TEXT, issue TEXT, body TEXT);
                CREATE INDEX IF NOT EXISTS reports_received ON reports(received);
                CREATE INDEX IF NOT EXISTS reports_issue ON reports(issue);
                CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, status TEXT, fixed_version TEXT);
            """)
            self.initialize_feedback(db)
    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()
    def insert(self, report):
        accepted = []
        with self.connect() as db:
            for row in report["entries"]:
                issue = hashlib.sha256(f'{report["channel"]}:{row["module"]}:{row["event"]}:{row["code"]}'.encode()).hexdigest()
                full = {**report, "entries": [row]}
                inserted = db.execute("INSERT OR IGNORE INTO reports VALUES (?,?,?,?,?,?,?,?,?,?)", (
                    row["id"], int(time.time()), report["installId"], report["version"], report["channel"],
                    row["module"], row["code"], row["level"], issue, json.dumps(full, ensure_ascii=False)))
                # A report from the declared fixed version (or newer) reopens the issue.
                if inserted.rowcount:
                    prior = db.execute("SELECT * FROM issues WHERE id=?", (issue,)).fetchone()
                    if prior and prior["fixed_version"] and tuple(map(int, report["version"].split("."))) >= tuple(map(int, prior["fixed_version"].split("."))):
                        db.execute("UPDATE issues SET status='reopened' WHERE id=?", (issue,))
                accepted.append(row["id"])
        return accepted
    def prune(self):
        with self.connect() as db:
            db.execute("UPDATE feedback SET diagnostics=NULL WHERE diagnostics_expires <= ?", (int(time.time()),))
            db.execute("DELETE FROM reports WHERE received < ?", (int(time.time()) - 30 * 86400,))
            db.execute("DELETE FROM reports WHERE id IN (SELECT id FROM reports ORDER BY received DESC LIMIT -1 OFFSET 50000)")
            db.execute("DELETE FROM issues WHERE id NOT IN (SELECT DISTINCT issue FROM reports)")
    def overview(self):
        with self.connect() as db:
            issues = [dict(row) for row in db.execute("""
                SELECT r.issue AS id, r.channel, r.module, r.code, COUNT(*) AS occurrences,
                  GROUP_CONCAT(DISTINCT r.version) AS versions,
                  COUNT(DISTINCT r.install_id) AS installations, MAX(r.received) AS last_seen,
                  COALESCE(i.status,'open') AS status, COALESCE(i.fixed_version,'') AS fixed_version
                FROM reports r LEFT JOIN issues i ON r.issue=i.id WHERE r.level != 'info'
                GROUP BY r.issue ORDER BY last_seen DESC LIMIT 200
            """)]
            reports = [json.loads(row["body"]) for row in db.execute("SELECT body FROM reports ORDER BY received DESC LIMIT 200")]
            versions = [dict(row) for row in db.execute("SELECT channel,version,COUNT(DISTINCT install_id) AS installations,MAX(received) AS last_seen FROM reports GROUP BY channel,version ORDER BY last_seen DESC")]
        return {"issues": issues, "reports": reports, "versions": versions}

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, handler, store, admin=False):
        super().__init__(address, handler)
        self.store, self.admin = store, admin
        self.slots = threading.BoundedSemaphore(24)
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
    server_version = "Maintenance/1"
    def setup(self):
        super().setup()
        self.connection.settimeout(20)
    def log_message(self, *_args):
        pass  # Do not persist client IP, raw URLs, request bodies or credentials.
    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)
    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536 or self.headers.get("Content-Type") != "application/json":
            raise ValueError("body")
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("incomplete")
        return json.loads(data)
    def do_POST(self):
        try:
            if not self.server.allowed(self.client_address[0]):
                return self.reply(429, {"error": "rate_limit"})
            if self.server.admin:
                if not re.fullmatch(r"(?:127\.0\.0\.1|localhost):\d{1,5}", self.headers.get("Host", "")) or self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
                    return self.reply(403, {"error": "origin"})
                if self.path == "/api/feedback/status":
                    updated = self.server.store.update_feedback(self.body())
                    return self.reply(200 if updated else 404, {"ok": updated})
            if self.server.admin and self.path == "/api/issues":
                # Only same-origin JSON from the loopback admin UI is accepted.
                if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
                    return self.reply(403, {"error": "origin"})
                body = self.body()
                if not HEX.fullmatch(str(body.get("id", ""))) or body.get("status") not in ("open", "investigating", "fixed"):
                    raise ValueError("issue")
                fixed = body.get("fixedVersion", "")
                if fixed and not VERSION.fullmatch(fixed) or body["status"] == "fixed" and not fixed:
                    raise ValueError("version")
                with self.server.store.connect() as db:
                    db.execute("INSERT OR REPLACE INTO issues VALUES (?,?,?)", (body["id"], body["status"], fixed))
                return self.reply(200, {"ok": True})
            if not self.server.admin and self.path == "/v1/feedback":
                clean, secret = validate_feedback(self.body(), validate_report, safe_token)
                return self.reply(200, self.server.store.insert_feedback(clean, secret))
            if not self.server.admin and self.path == "/v1/feedback/status":
                return self.reply(200, self.server.store.feedback_statuses(self.body()))
            if not self.server.admin and self.path == "/v1/feedback/visibility":
                return self.reply(200, self.server.store.withdraw_feedback(self.body()))
            if self.server.admin or self.path != "/v1/reports":
                return self.reply(404, {"error": "not_found"})
            report = validate_report(self.body())
            return self.reply(200, {"accepted": self.server.store.insert(report)})
        except FeedbackConflict:
            self.reply(409, {"error": "feedback_conflict"})
        except FeedbackUnauthorized:
            self.reply(403, {"error": "feedback_access_denied"})
        except (ValueError, TypeError, KeyError):
            self.reply(400, {"error": "invalid_report"})
        except Exception:
            self.reply(503, {"error": "unavailable"})
    def do_GET(self):
        route = urlsplit(self.path).path
        if self.server.admin:
            if not re.fullmatch(r"(?:127\.0\.0\.1|localhost):\d{1,5}", self.headers.get("Host", "")):
                return self.reply(403, {"error": "host"})
            if route == "/api/overview":
                return self.reply(200, self.server.store.overview())
            if route == "/api/feedback":
                query = parse_qs(urlsplit(self.path).query)
                raw_offset = query.get("offset", ["0"])[0]
                status = query.get("status", [""])[0]
                if not re.fullmatch(r"\d{1,9}", raw_offset):
                    return self.reply(400, {"error": "invalid_offset"})
                if status and status not in STATES:
                    return self.reply(400, {"error": "invalid_status"})
                return self.reply(200, self.server.store.feedback_overview(int(raw_offset), status))
            if route == "/":
                data = Path(__file__).with_name("admin.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Frame-Options", "DENY")
                self.end_headers()
                return self.wfile.write(data)
            return self.reply(404, {"error": "not_found"})
        if route == "/health":
            return self.reply(200, {"ok": True, "service": "maintenance", "schema": 1})
        if route == "/v1/feedback/public":
            if not self.server.allowed(self.client_address[0]):
                return self.reply(429, {"error": "rate_limit"})
            query = parse_qs(urlsplit(self.path).query)
            offset, limit = query.get("offset", ["0"])[0], query.get("limit", ["30"])[0]
            if not re.fullmatch(r"\d{1,9}", offset) or not re.fullmatch(r"[1-9]\d{0,8}", limit):
                return self.reply(400, {"error": "invalid_pagination"})
            try:
                return self.reply(200, self.server.store.public_feedback(int(offset), int(limit)))
            except Exception:
                return self.reply(503, {"error": "unavailable"})
        match = re.fullmatch(r"/v1/releases/(test|delivery|smoke)/latest", route)
        if match:
            file = self.server.store.root / "releases" / match[1] / "latest.json"
            if not file.exists():
                return self.reply(200, {"empty": True})
            return self.reply(200, json.loads(file.read_text()))
        match = re.fullmatch(r"/artifacts/([a-f0-9]{64})\.exe", route)
        if match:
            file = self.server.store.root / "artifacts" / (match[1] + ".exe")
            if file.is_file():
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(file.stat().st_size))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                try:
                    with file.open("rb") as stream:
                        while chunk := stream.read(256 * 1024):
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass
                return
        self.reply(404, {"error": "not_found"})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/var/lib/ai-maintenance")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    args = parser.parse_args()
    store = Store(args.root)
    admin = Server(("127.0.0.1", 8081), Handler, store, admin=True)
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    public = Server(("0.0.0.0", args.port), Handler, store)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    public.socket = context.wrap_socket(public.socket, server_side=True, do_handshake_on_connect=False)
    def prune():
        while True:
            store.prune()
            time.sleep(60)
    threading.Thread(target=prune, daemon=True).start()
    public.serve_forever()

if __name__ == "__main__":
    main()
