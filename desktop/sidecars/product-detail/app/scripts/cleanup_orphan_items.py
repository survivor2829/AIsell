"""清理 batch_items 表里的孤儿 / 测试污染行。

两类目标:
  1. 真孤儿: batch_pk 指向不存在的 batches.id (外键悬空)
     → 通常来自:上游 batch 被 delete 但 items 没 cascade (FK=OFF 场景)
     → 完全无用, 永远可以删
  2. 测试污染: name='测试产品A' 且 status 在 {'pending','failed','skipped'}
     → E2E 测试写进去但没跑完的脏数据
     → status='done' 的绝不动(那可能是真人起的测试)

用法:
    python scripts/cleanup_orphan_items.py
        → 默认 dry-run, 只打印会被删的行, 不改 DB

    python scripts/cleanup_orphan_items.py --confirm
        → 真删 "真孤儿" (batch_pk 不存在)

    python scripts/cleanup_orphan_items.py --confirm --include-test-pollution
        → 也删 name='测试产品A' 且 status in (pending/failed/skipped) 的

为什么不用 Flask-SQLAlchemy?
  → 脚本要在 app.py 不 run 的情况下也能跑,
    直接 sqlite3 更轻,还能显式 PRAGMA foreign_keys=ON 确认级联行为。
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "instance" / "wubaoyun.db"

TEST_POLLUTION_NAME = "测试产品A"
TEST_POLLUTION_SAFE_STATUSES = ("pending", "failed", "skipped")


def _find_orphans(conn: sqlite3.Connection) -> list[tuple]:
    """batch_pk 在 batches.id 里找不到的行 — 真孤儿。"""
    return conn.execute(
        """
        SELECT bi.id, bi.name, bi.status, bi.batch_pk, bi.want_ai_refine,
               bi.main_image_path
          FROM batch_items bi
     LEFT JOIN batches b ON b.id = bi.batch_pk
         WHERE b.id IS NULL
         ORDER BY bi.id
        """
    ).fetchall()


def _find_test_pollution(conn: sqlite3.Connection) -> list[tuple]:
    """name='测试产品A' 且 status 非 done 的行 — 测试跑一半残留。"""
    placeholders = ",".join("?" * len(TEST_POLLUTION_SAFE_STATUSES))
    sql = f"""
        SELECT bi.id, bi.name, bi.status, bi.batch_pk, b.batch_id AS bid,
               bi.main_image_path
          FROM batch_items bi
     LEFT JOIN batches b ON b.id = bi.batch_pk
         WHERE bi.name = ?
           AND bi.status IN ({placeholders})
         ORDER BY bi.id
    """
    return conn.execute(sql, (TEST_POLLUTION_NAME, *TEST_POLLUTION_SAFE_STATUSES)).fetchall()


def _print_rows(title: str, rows: list[tuple], cols: list[str]) -> None:
    print(f"\n── {title} ({len(rows)} 条) ────────────────────────")
    if not rows:
        print("  (无)")
        return
    widths = [max(len(c), max((len(str(r[i])) for r in rows), default=0)) for i, c in enumerate(cols)]
    header = "  " + "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    print(header)
    print("  " + "  ".join("-" * w for w in widths))
    for r in rows:
        print("  " + "  ".join(str(r[i]).ljust(widths[i]) for i in range(len(cols))))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--confirm", action="store_true",
                    help="真删 (不带此参数默认 dry-run)")
    ap.add_argument("--include-test-pollution", action="store_true",
                    help="同时删 name='测试产品A' status in (pending/failed/skipped) 的行")
    args = ap.parse_args()

    if not DB_PATH.is_file():
        print(f"[cleanup] DB 不存在: {DB_PATH}")
        return 1

    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        orphans = _find_orphans(conn)
        _print_rows(
            "真孤儿 (batch_pk 指向不存在的 batch)",
            orphans,
            ["id", "name", "status", "batch_pk", "want_ai_refine", "main_image_path"],
        )

        if args.include_test_pollution:
            pollution = _find_test_pollution(conn)
            _print_rows(
                f"测试污染 (name='{TEST_POLLUTION_NAME}' 且 status in {TEST_POLLUTION_SAFE_STATUSES})",
                pollution,
                ["id", "name", "status", "batch_pk", "batch_id", "main_image_path"],
            )
        else:
            pollution = []
            print("\n(未启用 --include-test-pollution, 跳过"
                  f" name='{TEST_POLLUTION_NAME}' 残留扫描)")

        total = len(orphans) + len(pollution)
        if total == 0:
            print("\n✓ 数据库很干净, 无需清理")
            return 0

        if not args.confirm:
            print("\n" + "═" * 50)
            print(f"DRY-RUN: 将删除 {total} 条 ({len(orphans)} 孤儿"
                  f" + {len(pollution)} 测试污染)")
            print("加 --confirm 真删。")
            print("═" * 50)
            return 0

        # 真删
        to_delete = [r[0] for r in orphans] + [r[0] for r in pollution]
        placeholders = ",".join("?" * len(to_delete))
        cur = conn.execute(
            f"DELETE FROM batch_items WHERE id IN ({placeholders})", to_delete,
        )
        conn.commit()
        print(f"\n✓ 已删除 {cur.rowcount} 条 batch_items 行")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
