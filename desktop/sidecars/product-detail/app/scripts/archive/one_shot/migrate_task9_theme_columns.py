"""任务9 模板智能匹配 — DB schema 升级。

幂等。可重复跑。

新增列:
  batches.template_strategy   TEXT  DEFAULT 'auto'
  batches.fixed_theme_id      TEXT  NULL
  batches.product_category    TEXT  DEFAULT '设备类'
  batch_items.resolved_theme_id          TEXT  NULL
  batch_items.resolved_theme_matched_by  TEXT  NULL

为什么手写 migration 而不用 flask-migrate?
  → 项目走 db.create_all() 路线 (幂等,只创新表),不维护 Alembic 版本链。
    给已有 DB 加列必须自己写 ALTER TABLE。SQLite ADD COLUMN 是非破坏的,加 default 即可。
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "instance" / "wubaoyun.db"

NEW_COLUMNS: list[tuple[str, str, str]] = [
    # (table, column_name, column_def_sql)
    ("batches",     "template_strategy",          "TEXT DEFAULT 'auto'"),
    ("batches",     "fixed_theme_id",             "TEXT"),
    ("batches",     "product_category",           "TEXT DEFAULT '设备类'"),
    ("batch_items", "resolved_theme_id",          "TEXT"),
    ("batch_items", "resolved_theme_matched_by",  "TEXT"),
]


def _existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r[1] for r in rows}


def main() -> int:
    if not DB_PATH.is_file():
        print(f"[migrate_t9] DB 不存在: {DB_PATH}")
        print(f"[migrate_t9] 跳过 — 下次启动 db.create_all() 会按最新 schema 建表")
        return 0

    print(f"[migrate_t9] DB: {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    try:
        added = 0
        skipped = 0
        for table, col, defn in NEW_COLUMNS:
            existing = _existing_columns(conn, table)
            if col in existing:
                print(f"  [skip] {table}.{col} 已存在")
                skipped += 1
                continue
            sql = f"ALTER TABLE {table} ADD COLUMN {col} {defn}"
            print(f"  [add ] {sql}")
            conn.execute(sql)
            added += 1
        conn.commit()
        print(f"[migrate_t9] 完成: 新增 {added} 列, 跳过 {skipped} 列")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
