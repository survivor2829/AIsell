"""Read-only semantic comparison of two isolated SQLite snapshots. No AI calls."""
from collections import Counter
from contextlib import closing
from pathlib import Path
import json
import sqlite3

# These startup-only fields are the verified changes in the existing services.
# Never ignore all timestamps: paid receipts and task outcomes must remain exact.
VOLATILE = {
    "content-engine.sqlite3": {"voice_personas_v1": {"updated_at"}},
    "wubaoyun.db": {"users": {"last_active"}},
}


def compare(previous, current, database_name):
    def connect(file):
        db = sqlite3.connect(Path(file).resolve().as_uri() + "?mode=ro", uri=True)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            db.close()
            raise ValueError("sqlite_integrity_failed")
        return db

    def quote(name):
        return '"' + name.replace('"', '""') + '"'

    with closing(connect(previous)) as old, closing(connect(current)) as new:
        tables = [row[0] for row in old.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        new_tables = {row[0] for row in new.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in tables:
            if table not in new_tables:
                return {"ok": False, "reason": "database_table_missing", "table": table}
            columns = [row[1] for row in old.execute("PRAGMA table_info(" + quote(table) + ")")]
            current_columns = {row[1] for row in new.execute("PRAGMA table_info(" + quote(table) + ")")}
            if not set(columns) <= current_columns:
                return {"ok": False, "reason": "database_column_missing", "table": table}
            ignored = VOLATILE.get(database_name, {}).get(table, set())
            compared = [column for column in columns if column not in ignored]
            # Compare a multiset, preserving duplicate rows and blob bytes.
            sql = "SELECT " + (",".join(map(quote, compared)) or "1") + " FROM " + quote(table)
            if Counter(old.execute(sql)) - Counter(new.execute(sql)):
                return {"ok": False, "reason": "database_business_rows_changed", "table": table}
    return {"ok": True}


def main(arguments):
    try:
        result = compare(*arguments)
    except Exception:
        result = {"ok": False, "reason": "database_snapshot_unreadable"}
    print(json.dumps(result))
    return 0
