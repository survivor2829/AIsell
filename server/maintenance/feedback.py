"""User feedback is independent from automatic, consent-based diagnostics."""
import hashlib
import hmac
import json
import re
import time

UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
SECRET = re.compile(r"[a-f0-9]{64}\Z")
TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\Z")
STATES = ("pending", "in_progress", "resolved")


class FeedbackConflict(Exception):
    pass


class FeedbackUnauthorized(Exception):
    pass


def validate_feedback(body, validate_report, safe_token):
    if not isinstance(body, dict) or body.get("schema") != 1:
        raise ValueError("feedback_schema")
    if not UUID.fullmatch(str(body.get("id", ""))) or not SECRET.fullmatch(str(body.get("receiptToken", ""))):
        raise ValueError("feedback_identity")
    text = body.get("text")
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000 or text != text.strip():
        raise ValueError("feedback_text")
    if body.get("category") not in ("problem", "suggestion", "experience") or not TIME.fullmatch(str(body.get("createdAt", ""))):
        raise ValueError("feedback_category")
    client = body.get("client")
    if not isinstance(client, dict):
        raise ValueError("feedback_client")
    # Reuse the same identity and diagnostic allowlist as automatic reports.
    entries = body.get("diagnostics", [])
    if not isinstance(entries, list) or len(entries) > 20:
        raise ValueError("feedback_diagnostics")
    probe = entries or [{"id": "0" * 64, "ts": body["createdAt"], "level": "info", "module": "feedback", "event": "submitted"}]
    report = validate_report({**client, "entries": probe})
    diagnostics = report.pop("entries") if entries else []
    report.pop("entries", None)
    context = body.get("context") or {}
    if not isinstance(context, dict):
        raise ValueError("feedback_context")
    clean = {"schema": 1, "id": body["id"], "text": text, "category": body["category"], "createdAt": body["createdAt"],
             "client": report, "context": {key: safe_token(context.get(key)) for key in ("module", "taskId")}, "diagnostics": diagnostics}
    return clean, body["receiptToken"]


class FeedbackStoreMixin:
    def initialize_feedback(self, db):
        db.executescript("""
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY, received INTEGER NOT NULL, updated INTEGER NOT NULL,
                status TEXT NOT NULL, token_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
                body TEXT NOT NULL, diagnostics TEXT, diagnostics_expires INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS feedback_received ON feedback(received);
        """)

    @staticmethod
    def feedback_receipt(row):
        return {"id": row["id"], "status": row["status"], "receivedAt": row["received"], "updatedAt": row["updated"]}

    def insert_feedback(self, clean, secret):
        payload_hash = hashlib.sha256(json.dumps(clean, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        token_hash = hashlib.sha256(secret.encode()).hexdigest()
        now = int(time.time())
        body = {key: value for key, value in clean.items() if key != "diagnostics"}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM feedback WHERE id=?", (clean["id"],)).fetchone()
            if existing:
                if not hmac.compare_digest(existing["payload_hash"], payload_hash) or not hmac.compare_digest(existing["token_hash"], token_hash):
                    raise FeedbackConflict()
                return self.feedback_receipt(existing)
            db.execute("INSERT INTO feedback VALUES (?,?,?,?,?,?,?,?,?)", (
                clean["id"], now, now, "pending", token_hash, payload_hash, json.dumps(body, ensure_ascii=False),
                json.dumps(clean["diagnostics"], ensure_ascii=False) if clean["diagnostics"] else None, now + 30 * 86400))
            return {"id": clean["id"], "status": "pending", "receivedAt": now, "updatedAt": now}

    def feedback_statuses(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("items"), list) or not 1 <= len(body["items"]) <= 100:
            raise ValueError("feedback_query")
        results = []
        with self.connect() as db:
            for item in body["items"]:
                if not isinstance(item, dict) or not UUID.fullmatch(str(item.get("id", ""))) or not SECRET.fullmatch(str(item.get("receiptToken", ""))):
                    raise FeedbackUnauthorized()
                row = db.execute("SELECT * FROM feedback WHERE id=?", (item["id"],)).fetchone()
                if not row or not hmac.compare_digest(row["token_hash"], hashlib.sha256(item["receiptToken"].encode()).hexdigest()):
                    raise FeedbackUnauthorized()
                results.append(self.feedback_receipt(row))
        return {"items": results}

    def feedback_overview(self, offset=0):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM feedback ORDER BY received DESC, id DESC LIMIT 100 OFFSET ?", (offset,)).fetchall()
            total = db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        now = int(time.time())
        return {"items": [{**json.loads(row["body"]), **self.feedback_receipt(row),
                           "diagnostics": json.loads(row["diagnostics"]) if row["diagnostics"] and row["diagnostics_expires"] > now else [],
                           "diagnosticsExpired": row["diagnostics_expires"] <= now} for row in rows], "total": total}

    def update_feedback(self, body):
        if not isinstance(body, dict) or not UUID.fullmatch(str(body.get("id", ""))) or body.get("status") not in STATES:
            raise ValueError("feedback_status")
        with self.connect() as db:
            # Successive changes in the same second must still order unambiguously.
            result = db.execute("UPDATE feedback SET updated=CASE WHEN status=? THEN updated ELSE MAX(updated+1, ?) END, status=? WHERE id=?",
                                (body["status"], int(time.time()), body["status"], body["id"]))
            return result.rowcount == 1
