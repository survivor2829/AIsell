"""Failure capsules: one self-contained record per customer failure.

Unlike /v1/reports, a capsule carries the engine's measurements, traceback and
the steps that led to the failure, plus original failure screenshots. They are
visible only through the loopback administrator API and expire after 30 days.
"""
import base64
import json
import re
import shutil
import time

UUID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
EVIDENCE_ID = re.compile(r"[a-f0-9]{32}\Z")
TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\Z")
MAX_CAPSULE_BYTES = 300 * 1024
MAX_EVIDENCE_BYTES = 5 * 1024 * 1024
MAX_EVIDENCE_PER_CAPSULE = 6
MAX_CAPSULES = 20000
MAX_EVIDENCE_TOTAL = 2 * 1024 ** 3
RETENTION_SECONDS = 30 * 86400
PNG = b"\x89PNG\r\n\x1a\n"
SUMMARY = ("id", "createdAt", "lastSeenAt", "occurrences", "source", "module", "event", "code", "level", "phase", "taskId", "where", "message")


def _client(body, validate_report):
    client = body.get("client") if isinstance(body, dict) else None
    if not isinstance(client, dict):
        raise ValueError("capsule_client")
    probe = {"id": "0" * 64, "ts": "2026-01-01T00:00:00.000Z", "level": "info", "module": "capsule", "event": "received"}
    report = validate_report({**client, "entries": [probe]})
    report.pop("entries")
    return report


def validate_capsule(body, validate_report, safe_token):
    client = _client(body, validate_report)
    capsule = body.get("capsule")
    if not isinstance(capsule, dict) or capsule.get("schema") != 1 or not UUID.fullmatch(str(capsule.get("id", ""))):
        raise ValueError("capsule_identity")
    if not TIME.fullmatch(str(capsule.get("createdAt", ""))) or not safe_token(capsule.get("module")) or not safe_token(capsule.get("code")):
        raise ValueError("capsule_fields")
    occurrences = capsule.get("occurrences", 1)
    if type(occurrences) is not int or not 1 <= occurrences <= 1000000:
        raise ValueError("capsule_occurrences")
    task_id = capsule.get("taskId", "")
    if not isinstance(task_id, str) or len(task_id) > 120:
        raise ValueError("capsule_task")
    serialized = json.dumps(capsule, ensure_ascii=False)
    if len(serialized.encode()) > MAX_CAPSULE_BYTES:
        raise ValueError("capsule_size")
    return client, capsule, serialized


class CapsuleStoreMixin:
    def initialize_capsules(self, db):
        db.executescript("""
            CREATE TABLE IF NOT EXISTS capsules (
                id TEXT PRIMARY KEY, received INTEGER NOT NULL, updated INTEGER NOT NULL,
                install_id TEXT NOT NULL, version TEXT NOT NULL, channel TEXT NOT NULL,
                module TEXT NOT NULL, code TEXT NOT NULL, task_id TEXT NOT NULL,
                occurrences INTEGER NOT NULL, client TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS capsules_received ON capsules(received);
            CREATE INDEX IF NOT EXISTS capsules_install ON capsules(install_id);
        """)

    @property
    def evidence_root(self):
        return self.root / "capsule-evidence"

    def evidence_ids(self, capsule_id):
        folder = self.evidence_root / capsule_id
        return sorted(item.stem for item in folder.glob("*.png")) if folder.is_dir() else []

    def insert_capsule(self, client, capsule, serialized):
        now = int(time.time())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute("SELECT install_id FROM capsules WHERE id=?", (capsule["id"],)).fetchone()
            if prior and prior["install_id"] != client["installId"]:
                raise ValueError("capsule_owner")
            if prior:
                # A capsule is re-sent when the same failure repeats: keep the newest body.
                db.execute("UPDATE capsules SET updated=?,occurrences=?,body=? WHERE id=?",
                           (now, capsule.get("occurrences", 1), serialized, capsule["id"]))
            else:
                db.execute("INSERT INTO capsules VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                    capsule["id"], now, now, client["installId"], client["version"], client["channel"],
                    capsule["module"], capsule["code"], capsule.get("taskId", ""), capsule.get("occurrences", 1),
                    json.dumps(client, ensure_ascii=False), serialized))
        return {"id": capsule["id"], "evidence": self.evidence_ids(capsule["id"])}

    def insert_evidence(self, body, validate_report):
        client = _client(body, validate_report)
        capsule_id, evidence_id, encoded = body.get("capsuleId"), body.get("evidenceId"), body.get("png")
        if not UUID.fullmatch(str(capsule_id or "")) or not EVIDENCE_ID.fullmatch(str(evidence_id or "")) or not isinstance(encoded, str):
            raise ValueError("evidence_identity")
        image = base64.b64decode(encoded, validate=True)
        if not image.startswith(PNG) or len(image) > MAX_EVIDENCE_BYTES:
            raise ValueError("evidence_image")
        with self.connect() as db:
            row = db.execute("SELECT install_id FROM capsules WHERE id=?", (capsule_id,)).fetchone()
        # Only the computer that sent the capsule may attach screenshots to it.
        if not row or row["install_id"] != client["installId"]:
            raise ValueError("evidence_capsule")
        folder = self.evidence_root / capsule_id
        target = folder / f"{evidence_id}.png"
        if not target.exists() and len(self.evidence_ids(capsule_id)) >= MAX_EVIDENCE_PER_CAPSULE:
            raise ValueError("evidence_limit")
        folder.mkdir(parents=True, exist_ok=True)
        partial = folder / f".{evidence_id}.part"
        partial.write_bytes(image)
        partial.replace(target)
        return {"ok": True}

    def prune_capsules(self):
        cutoff = int(time.time()) - RETENTION_SECONDS
        with self.connect() as db:
            db.execute("DELETE FROM capsules WHERE received < ?", (cutoff,))
            db.execute("DELETE FROM capsules WHERE id IN (SELECT id FROM capsules ORDER BY received DESC LIMIT -1 OFFSET ?)", (MAX_CAPSULES,))
            kept = {row["id"] for row in db.execute("SELECT id FROM capsules")}
            ages = {row["id"]: row["received"] for row in db.execute("SELECT id, received FROM capsules")}
        if not self.evidence_root.is_dir():
            return
        folders = []
        for folder in self.evidence_root.iterdir():
            if folder.is_symlink() or not folder.is_dir():
                folder.unlink(missing_ok=True)
                continue
            if folder.name not in kept:
                shutil.rmtree(folder, ignore_errors=True)
                continue
            folders.append((ages.get(folder.name, 0), folder, sum(item.stat().st_size for item in folder.glob("*.png"))))
        total = sum(size for _, _, size in folders)
        # Screenshots are the bulk of the space: drop the oldest first past the cap.
        for _, folder, size in sorted(folders, key=lambda item: item[0]):
            if total <= MAX_EVIDENCE_TOTAL:
                break
            shutil.rmtree(folder, ignore_errors=True)
            total -= size

    def capsule_overview(self, offset=0, module="", code="", install_id=""):
        where, parameters = [], []
        for column, value in (("module", module), ("code", code), ("install_id", install_id)):
            if value:
                where.append(f"{column}=?")
                parameters.append(value)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self.connect() as db:
            rows = db.execute("SELECT * FROM capsules" + clause + " ORDER BY updated DESC, id DESC LIMIT 100 OFFSET ?",
                              (*parameters, offset)).fetchall()
            total = db.execute("SELECT COUNT(*) FROM capsules" + clause, parameters).fetchone()[0]
            groups = [dict(row) for row in db.execute("""
                SELECT module, code, COUNT(*) AS capsules, SUM(occurrences) AS occurrences,
                  COUNT(DISTINCT install_id) AS installations, GROUP_CONCAT(DISTINCT version) AS versions, MAX(updated) AS last_seen
                FROM capsules GROUP BY module, code ORDER BY last_seen DESC LIMIT 200""")]
        items = []
        for row in rows:
            body = json.loads(row["body"])
            items.append({**{key: body.get(key) for key in SUMMARY}, "installId": row["install_id"], "version": row["version"],
                          "channel": row["channel"], "receivedAt": row["received"], "updatedAt": row["updated"],
                          "evidence": self.evidence_ids(row["id"])})
        return {"items": items, "total": total, "groups": groups}

    def capsule_detail(self, capsule_id):
        if not UUID.fullmatch(str(capsule_id or "")):
            return None
        with self.connect() as db:
            row = db.execute("SELECT * FROM capsules WHERE id=?", (capsule_id,)).fetchone()
        if not row:
            return None
        return {"capsule": json.loads(row["body"]), "client": json.loads(row["client"]), "receivedAt": row["received"],
                "updatedAt": row["updated"], "evidence": self.evidence_ids(capsule_id)}

    def evidence_file(self, capsule_id, evidence_id):
        if not UUID.fullmatch(str(capsule_id or "")) or not EVIDENCE_ID.fullmatch(str(evidence_id or "")):
            return None
        target = self.evidence_root / capsule_id / f"{evidence_id}.png"
        return target if target.is_file() and not target.is_symlink() else None
