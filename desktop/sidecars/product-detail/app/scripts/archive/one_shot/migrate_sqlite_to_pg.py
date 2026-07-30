"""SQLite → Postgres 数据迁移脚本 (幂等 / 可重跑).

用法:
    # 1. dry-run: 只打迁移报告 (不改任何数据)
    python scripts/migrate_sqlite_to_pg.py \\
        --sqlite instance/wubaoyun.db \\
        --pg "postgresql+psycopg2://xiaoxi:xxx@localhost:5433/xiaoxi"

    # 2. 确认 OK 后加 --commit 真迁
    python scripts/migrate_sqlite_to_pg.py \\
        --sqlite instance/wubaoyun.db \\
        --pg "postgresql+psycopg2://xiaoxi:xxx@localhost:5433/xiaoxi" \\
        --commit

前置条件:
  1. 目标 PG 必须已跑过 `flask db upgrade` (alembic_version 表存在且为 head)
     本脚本会校验, 不满足立即退出 — 避免往空 DB 里塞脏数据.
  2. SQLite 源库路径存在且可读.

行为:
  - 每张表按 PK 去重: INSERT ... ON CONFLICT (id) DO NOTHING
    → 已迁过的行不覆盖, 可反复重跑 (幂等)
  - 迁移顺序遵循 FK: users → batches → batch_items, users → generation_logs
  - 每张表搬完后 setval 重置 PG 的 SERIAL 序列 (避免后续新增行 PK 冲突)
  - DateTime / Boolean / Text 类型 psycopg2 自动处理, 不需要手工转

不迁的东西:
  - alembic_version (由 flask db upgrade 维护)
  - 文件系统产物 (static/uploads, static/outputs) — 走 docker volume 另外搬

扩展性备注:
  - 新增 model → 在 TABLES 配置里加一行 (列名 + FK 依赖) 即可
  - 要改为"一次性清空目标再导入" → 加 --truncate 开关 (现在故意没加, 太危险)
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from typing import Any

# 迁移顺序 (FK 依赖: 被引用方先迁)
# 每个条目: (sqlite 表名, pg 表名, 列清单, 主键列)
# 列顺序要和 INSERT 里一致
TABLES: list[tuple[str, str, list[str], str]] = [
    (
        "users", "users",
        ["id", "username", "password_hash", "email",
         "is_admin", "is_paid", "is_approved",
         "custom_api_key_enc", "created_at", "last_active"],
        "id",
    ),
    (
        "batches", "batches",
        ["id", "batch_id", "name", "raw_name", "user_id", "status",
         "total_count", "valid_count", "skipped_count", "batch_dir",
         "template_strategy", "fixed_theme_id", "product_category",
         "created_at", "updated_at"],
        "id",
    ),
    (
        "batch_items", "batch_items",
        ["id", "batch_pk", "name", "status",
         "main_image_path", "detail_image_paths", "desc_text", "desc_chars",
         "skip_reason", "error", "result",
         "want_ai_refine", "ai_refine_status",
         "resolved_theme_id", "resolved_theme_matched_by",
         "created_at", "updated_at", "started_at", "finished_at"],
        "id",
    ),
    (
        "generation_logs", "generation_logs",
        ["id", "user_id", "product_type", "model_name",
         "api_key_source", "action", "created_at"],
        "id",
    ),
]

BASELINE_REV = "a73747e2b475"  # 必须和 migrations/versions/*baseline*.py 里的 revision 对齐


def verify_pg_ready(pg_url: str) -> None:
    """确保 PG 已经跑过 baseline migration. 否则脚本不能跑."""
    try:
        import psycopg2
    except ImportError:
        sys.exit("✗ 缺 psycopg2-binary, pip install psycopg2-binary 后重跑")

    # 从 SQLAlchemy URL 里抽出 psycopg2 connect string
    # postgresql+psycopg2://user:pwd@host:port/db → postgresql://user:pwd@host:port/db
    conn_url = pg_url.replace("postgresql+psycopg2://", "postgresql://")

    try:
        conn = psycopg2.connect(conn_url)
    except Exception as e:
        sys.exit(f"✗ 连 PG 失败: {e}\n  → 检查 REDIS_URL / 容器是否起来, "
                 f"端口/密码是否对")

    try:
        cur = conn.cursor()
        cur.execute("SELECT version_num FROM alembic_version LIMIT 1")
        row = cur.fetchone()
        if not row:
            sys.exit("✗ PG 里 alembic_version 表是空的 — "
                     "先 cd 到项目根跑 `flask db upgrade` 把结构建好")
        if row[0] != BASELINE_REV:
            sys.exit(
                f"✗ PG 的 alembic_version={row[0]!r}, 和本脚本期望的 "
                f"baseline={BASELINE_REV!r} 不一致 — "
                f"代码和 DB 不同步, 请先同步后再跑迁移"
            )
        print(f"✓ PG 已 ready, alembic_version={row[0]}")
    finally:
        conn.close()


def read_sqlite_rows(sqlite_path: Path, table: str,
                     cols: list[str]) -> list[tuple[Any, ...]]:
    if not sqlite_path.is_file():
        sys.exit(f"✗ SQLite 源库不存在: {sqlite_path}")
    conn = sqlite3.connect(str(sqlite_path))
    try:
        col_list = ", ".join(cols)
        rows = conn.execute(
            f"SELECT {col_list} FROM {table} ORDER BY id"
        ).fetchall()
        return rows
    finally:
        conn.close()


def count_pg_rows(pg_url: str, table: str) -> int:
    import psycopg2
    conn = psycopg2.connect(pg_url.replace("postgresql+psycopg2://",
                                            "postgresql://"))
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        return cur.fetchone()[0]
    finally:
        conn.close()


def insert_rows(pg_url: str, table: str, cols: list[str],
                rows: list[tuple], pk: str) -> tuple[int, int]:
    """把 rows 批量插进 PG, ON CONFLICT (pk) DO NOTHING.

    返回 (inserted, skipped).
    """
    import psycopg2
    from psycopg2.extras import execute_values
    if not rows:
        return (0, 0)

    col_list = ", ".join(cols)
    placeholders = f"({', '.join(['%s'] * len(cols))})"
    sql = (
        f"INSERT INTO {table} ({col_list}) VALUES %s "
        f"ON CONFLICT ({pk}) DO NOTHING RETURNING {pk}"
    )

    conn = psycopg2.connect(pg_url.replace("postgresql+psycopg2://",
                                            "postgresql://"))
    try:
        cur = conn.cursor()
        # execute_values 会把 placeholders 自动展开
        template = placeholders
        inserted_pks = execute_values(
            cur, sql, rows, template=template, fetch=True
        )
        conn.commit()
        inserted = len(inserted_pks) if inserted_pks else 0
        skipped = len(rows) - inserted
        return (inserted, skipped)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def reset_pg_sequence(pg_url: str, table: str, pk: str) -> int:
    """把 PG 的 SERIAL 序列重置到当前 MAX(pk)+1.

    避免: 迁完数据后, 用户通过 UI 新增一条, PG 发出的下一个 id 从 1 开始,
          跟已迁入的行 PK 直接冲突.
    返回新的 nextval.
    """
    import psycopg2
    conn = psycopg2.connect(pg_url.replace("postgresql+psycopg2://",
                                            "postgresql://"))
    try:
        cur = conn.cursor()
        # Postgres 的 SERIAL 列默认序列名是 <table>_<pk>_seq
        seq = f"{table}_{pk}_seq"
        cur.execute(
            f"SELECT setval('{seq}', "
            f"       COALESCE((SELECT MAX({pk}) FROM {table}), 0) + 1, "
            f"       false)"
        )
        new_val = cur.fetchone()[0]
        conn.commit()
        return new_val
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="SQLite → Postgres 数据迁移")
    parser.add_argument("--sqlite", required=True,
                        help="源 SQLite 库路径 (例: instance/wubaoyun.db)")
    parser.add_argument("--pg", required=True,
                        help="目标 PG URL (SQLAlchemy 格式: "
                             "postgresql+psycopg2://u:p@h:p/db)")
    parser.add_argument("--commit", action="store_true",
                        help="实际执行 INSERT. 不给就是 dry-run, 只报告")
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite).resolve()
    if not sqlite_path.is_file():
        sys.exit(f"✗ SQLite 源库不存在: {sqlite_path}")

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print("=" * 60)
    print(f"  SQLite → Postgres 数据迁移  [{mode}]")
    print("=" * 60)
    print(f"源: {sqlite_path}")
    print(f"目标: {args.pg}")
    print()

    verify_pg_ready(args.pg)
    print()

    total_inserted = 0
    total_skipped = 0
    report = []

    for sqlite_t, pg_t, cols, pk in TABLES:
        rows = read_sqlite_rows(sqlite_path, sqlite_t, cols)
        pg_count = count_pg_rows(args.pg, pg_t)
        print(f"[{sqlite_t}] 源 {len(rows)} 行, PG 现有 {pg_count} 行")

        if not args.commit:
            # dry-run: 只统计
            report.append((sqlite_t, len(rows), pg_count, 0, 0))
            continue

        # commit: 实际插
        inserted, skipped = insert_rows(args.pg, pg_t, cols, rows, pk)
        new_seq = reset_pg_sequence(args.pg, pg_t, pk)
        print(f"    → 插入 {inserted}, 跳过(已存在) {skipped}, "
              f"seq 重置到 {new_seq}")
        total_inserted += inserted
        total_skipped += skipped
        report.append((sqlite_t, len(rows), pg_count, inserted, skipped))

    print()
    print("=" * 60)
    print("迁移报告:")
    print(f"  {'表名':<20} {'源':>6} {'PG 原':>6} {'插入':>6} {'跳过':>6}")
    for t, n_src, n_pg, n_ins, n_skip in report:
        print(f"  {t:<20} {n_src:>6} {n_pg:>6} {n_ins:>6} {n_skip:>6}")
    if args.commit:
        print(f"\n总计插入 {total_inserted} 行, 跳过 {total_skipped} 行 "
              f"(已存在)")
    else:
        print("\n[DRY-RUN] 不改任何数据. 确认 OK 后加 --commit 实际迁移.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
