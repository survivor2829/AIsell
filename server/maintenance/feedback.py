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
    if not isinstance(body, dict) or type(body.get("schema")) is not int or body["schema"] not in (1, 2):
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
    clean = {"schema": body["schema"], "id": body["id"], "text": text, "category": body["category"], "createdAt": body["createdAt"],
             "client": report, "context": {key: safe_token(context.get(key)) for key in ("module", "taskId")}, "diagnostics": diagnostics}
    # Schema 1's canonical object is unchanged: old retries must retain their hash.
    if body["schema"] == 2:
        if body.get("visibility") not in ("public", "private"):
            raise ValueError("feedback_visibility")
        clean["visibility"] = body["visibility"]
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
        columns = {row[1] for row in db.execute("PRAGMA table_info(feedback)")}
        for name, definition in (("visibility", "TEXT NOT NULL DEFAULT 'private'"),
                                 ("hidden", "INTEGER NOT NULL DEFAULT 0"),
                                 ("official_reply", "TEXT NOT NULL DEFAULT ''")):
            if name not in columns:
                db.execute(f"ALTER TABLE feedback ADD COLUMN {name} {definition}")

    @staticmethod
    def feedback_receipt(row):
        return {"id": row["id"], "status": row["status"], "receivedAt": row["received"], "updatedAt": row["updated"],
                "visibility": row["visibility"], "hidden": bool(row["hidden"]), "officialReply": row["official_reply"]}

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
            # body preserves the originally submitted visibility for idempotency;
            # the separate column is mutable and must never be reset by retries.
            db.execute("""INSERT INTO feedback
                (id,received,updated,status,token_hash,payload_hash,body,diagnostics,diagnostics_expires,visibility)
                VALUES (?,?,?,?,?,?,?,?,?,?)""", (
                clean["id"], now, now, "pending", token_hash, payload_hash, json.dumps(body, ensure_ascii=False),
                json.dumps(clean["diagnostics"], ensure_ascii=False) if clean["diagnostics"] else None, now + 30 * 86400,
                clean.get("visibility", "private")))
            return self.feedback_receipt(db.execute("SELECT * FROM feedback WHERE id=?", (clean["id"],)).fetchone())

    def withdraw_feedback(self, body):
        if not isinstance(body, dict) or body.get("visibility", "private") != "private":
            raise ValueError("feedback_visibility")
        if not UUID.fullmatch(str(body.get("id", ""))) or not SECRET.fullmatch(str(body.get("receiptToken", ""))):
            raise FeedbackUnauthorized()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM feedback WHERE id=?", (body["id"],)).fetchone()
            if not row or not hmac.compare_digest(row["token_hash"], hashlib.sha256(body["receiptToken"].encode()).hexdigest()):
                raise FeedbackUnauthorized()
            if row["visibility"] == "public":
                db.execute("UPDATE feedback SET visibility='private',updated=MAX(updated+1,?) WHERE id=?",
                           (int(time.time()), body["id"]))
            return self.feedback_receipt(db.execute("SELECT * FROM feedback WHERE id=?", (body["id"],)).fetchone())

    def public_feedback(self, offset=0, limit=30):
        limit = min(30, max(1, limit))
        with self.connect() as db:
            rows = db.execute("SELECT * FROM feedback WHERE visibility='public' AND hidden=0 ORDER BY received DESC,id DESC LIMIT ? OFFSET ?",
                              (limit, offset)).fetchall()
            total = db.execute("SELECT COUNT(*) FROM feedback WHERE visibility='public' AND hidden=0").fetchone()[0]
        items = []
        for row in rows:
            body = json.loads(row["body"])
            items.append({"id": row["id"], "text": body["text"], "category": body["category"], "createdAt": body["createdAt"],
                          "receivedAt": row["received"], "updatedAt": row["updated"], "status": row["status"], "officialReply": row["official_reply"]})
        return {"items": items, "total": total}

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

    def feedback_overview(self, offset=0, status=""):
        if status and status not in STATES:
            raise ValueError("feedback_status")
        where, parameters = (" WHERE status=?", (status,)) if status else ("", ())
        with self.connect() as db:
            rows = db.execute("SELECT * FROM feedback" + where + " ORDER BY received DESC, id DESC LIMIT 100 OFFSET ?", (*parameters, offset)).fetchall()
            total = db.execute("SELECT COUNT(*) FROM feedback" + where, parameters).fetchone()[0]
        now = int(time.time())
        return {"items": [{**json.loads(row["body"]), **self.feedback_receipt(row),
                           "diagnostics": json.loads(row["diagnostics"]) if row["diagnostics"] and row["diagnostics_expires"] > now else [],
                           "diagnosticsExpired": row["diagnostics_expires"] <= now} for row in rows], "total": total}

    def update_feedback(self, body):
        if not isinstance(body, dict) or not UUID.fullmatch(str(body.get("id", ""))) or body.get("status") not in STATES:
            raise ValueError("feedback_status")
        if "officialReply" in body and (not isinstance(body["officialReply"], str) or len(body["officialReply"]) > 2000):
            raise ValueError("feedback_reply")
        if "hidden" in body and type(body["hidden"]) is not bool:
            raise ValueError("feedback_hidden")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM feedback WHERE id=?", (body["id"],)).fetchone()
            if not row:
                return False
            reply, hidden = body.get("officialReply", row["official_reply"]), body.get("hidden", bool(row["hidden"]))
            if (body["status"], reply, hidden) != (row["status"], row["official_reply"], bool(row["hidden"])):
                db.execute("UPDATE feedback SET updated=MAX(updated+1,?),status=?,official_reply=?,hidden=? WHERE id=?",
                           (int(time.time()), body["status"], reply, hidden, body["id"]))
            return True
