"""rewrite batches.batch_dir: uploads/batches/... -> static/uploads/batches/...

Revision ID: b1c0de_static_prefix
Revises: a73747e2b475
Create Date: 2026-04-22

背景 (紧急3 / 2026-04-22):
  Docker named volume `uploads` 挂载到 /app/static/uploads, 但代码 UPLOAD_DIR
  之前指向 /app/uploads -> 写入的 parsed.json / preview.png 实际落在容器临时层,
  重启即蒸发, refine 来找 0.1s FileNotFoundError.

  代码侧已把 UPLOAD_DIR 迁到 BASE_DIR/static/uploads. 但 DB 里已有 batches.batch_dir
  字符串 (相对磁盘路径) 仍是 'uploads/batches/xxx' - 新代码按新路径拼不上。

  本 migration 只改字符串前缀, 不动磁盘文件 (老批次文件早丢了, 用户 UI 手动删即可).
"""
from alembic import op


revision = "b1c0de_static_prefix"
down_revision = "a73747e2b475"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "UPDATE batches "
        "SET batch_dir = 'static/' || batch_dir "
        "WHERE batch_dir LIKE 'uploads/batches/%' "
        "  AND batch_dir NOT LIKE 'static/%'"
    )


def downgrade():
    op.execute(
        "UPDATE batches "
        "SET batch_dir = SUBSTR(batch_dir, 8) "
        "WHERE batch_dir LIKE 'static/uploads/batches/%'"
    )
