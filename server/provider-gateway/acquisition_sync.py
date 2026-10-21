"""Private acquisition records, scoped only by the verified gateway session."""
import hashlib
import json
import re
import sqlite3
import threading

COLLECTIONS = {"profile", "enterprise", "card", "source", "followup", "copyEvent"}
EVENTS = {"followup", "copyEvent"}
IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,160}\Z")
FORBIDDEN = {"cookie", "cookies", "authorization", "password", "token", "apikey", "credentials", "checkpoint", "checkpoints", "localpath", "filepath", "partition", "session", "sessions"}
MAX_BODY = 2 * 1024 * 1024


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def validate_data(value, depth=0):
    if depth > 16:
        raise ValueError("sync_data_depth")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or re.sub(r"[^a-z]", "", key.lower()) in FORBIDDEN:
                raise ValueError("sync_private_runtime_field")
            validate_data(item, depth + 1)
    elif isinstance(value, list):
        if len(value) > 10000:
            raise ValueError("sync_list_size")
        for item in value:
            validate_data(item, depth + 1)
    elif not (value is None or isinstance(value, (str, int, float, bool))):
        raise ValueError("sync_data_type")


class AcquisitionSync:
    def __init__(self, path=":memory:"):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records (
                tenant TEXT, collection TEXT, id TEXT, version INTEGER,
                data TEXT NOT NULL, sequence INTEGER,
                PRIMARY KEY(tenant, collection, id));
            CREATE TABLE IF NOT EXISTS changes (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL,
                collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
                data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS changes_tenant ON changes(tenant, sequence);
            CREATE TABLE IF NOT EXISTS operations (
                tenant TEXT, id TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
                PRIMARY KEY(tenant,id));
        """)

    def close(self):
        with self.lock:
            self.db.close()

    @staticmethod
    def identity(subject):
        if not subject:
            raise ValueError("session_required")
        namespace = hashlib.sha256(("xiaoxi-acquisition-v1:" + subject).encode()).hexdigest()
        return {"schema": 1, "namespace": namespace, "displayId": "渠道商 " + namespace[:8]}

    @staticmethod
    def record(row):
        return {"collection": row[0], "id": row[1], "version": row[2], "data": json.loads(row[3]), "sequence": row[4]}

    def push(self, tenant, body):
        ops = body.get("operations")
        if set(body) != {"operations"} or not isinstance(ops, list) or not 1 <= len(ops) <= 100 or len(packed(body).encode()) > MAX_BODY:
            raise ValueError("sync_batch_invalid")
        for op in ops:
            if (not isinstance(op, dict) or set(op) != {"opId", "collection", "id", "baseVersion", "data"}
                    or op["collection"] not in COLLECTIONS
                    or not all(isinstance(op[k], str) and IDENTIFIER.fullmatch(op[k]) for k in ("opId", "id"))
                    or type(op["baseVersion"]) is not int or not 0 <= op["baseVersion"] < 2**53
                    or not isinstance(op["data"], dict)):
                raise ValueError("sync_operation_invalid")
            validate_data(op["data"])
            if len(packed(op["data"]).encode()) > 512 * 1024:
                raise ValueError("sync_record_size")
        results = []
        with self.lock, self.db:
            for op in ops:
                fingerprint = hashlib.sha256(packed(op).encode()).hexdigest()
                receipt = self.db.execute("SELECT fingerprint,result FROM operations WHERE tenant=? AND id=?", (tenant, op["opId"])).fetchone()
                if receipt:
                    if receipt[0] != fingerprint:
                        raise ValueError("sync_operation_reused")
                    results.append(json.loads(receipt[1]))
                    continue
                row = self.db.execute("SELECT collection,id,version,data,sequence FROM records WHERE tenant=? AND collection=? AND id=?", (tenant, op["collection"], op["id"])).fetchone()
                if (row and (op["collection"] in EVENTS or row[2] != op["baseVersion"])) or (not row and op["baseVersion"] != 0):
                    result = {"opId": op["opId"], "status": "conflict", "record": self.record(row) if row else None}
                else:
                    version = (row[2] if row else 0) + 1
                    data = packed(op["data"])
                    sequence = self.db.execute("INSERT INTO changes(tenant,collection,id,version,data) VALUES(?,?,?,?,?)", (tenant, op["collection"], op["id"], version, data)).lastrowid
                    self.db.execute("INSERT OR REPLACE INTO records VALUES(?,?,?,?,?,?)", (tenant, op["collection"], op["id"], version, data, sequence))
                    result = {"opId": op["opId"], "status": "applied", "record": self.record((op["collection"], op["id"], version, data, sequence))}
                self.db.execute("INSERT INTO operations VALUES(?,?,?,?)", (tenant, op["opId"], fingerprint, packed(result)))
                results.append(result)
        return {"results": results}

    def pull(self, tenant, body):
        cursor, limit = body.get("cursor", 0), body.get("limit", 100)
        if set(body) - {"cursor", "limit"} or type(cursor) is not int or not 0 <= cursor < 2**53 or type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("sync_cursor_invalid")
        with self.lock:
            rows = self.db.execute("SELECT collection,id,version,data,sequence FROM changes WHERE tenant=? AND sequence>? ORDER BY sequence LIMIT ?", (tenant, cursor, limit + 1)).fetchall()
        # Bound responses too: a source may contain a full original document.
        records, size = [], 0
        for row in rows[:limit]:
            record = self.record(row)
            count = len(packed(record).encode())
            if records and size + count > MAX_BODY:
                break
            records.append(record)
            size += count
        return {"records": records, "cursor": records[-1]["sequence"] if records else cursor, "hasMore": len(rows) > len(records)}

    def handle(self, action, subject, body):
        identity = self.identity(subject)
        if action == "identity" and not body:
            return identity
        if body.get("expectedNamespace") != identity["namespace"]:
            raise ValueError("sync_account_changed")
        body = {key: value for key, value in body.items() if key != "expectedNamespace"}
        if action == "push":
            return self.push(identity["namespace"], body)
        if action == "pull":
            return self.pull(identity["namespace"], body)
        raise ValueError("sync_action_invalid")
