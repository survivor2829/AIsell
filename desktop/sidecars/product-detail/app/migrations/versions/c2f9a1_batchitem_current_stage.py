"""add batch_items.current_stage for realtime stage-pill

Revision ID: c2f9a1_current_stage
Revises: b1c0de_static_prefix
Create Date: 2026-04-22

背景 (任务2 状态实时更新):
  前端需要实时 pill 展示当前阶段 (parsing/cutting/rendering/capturing),
  WS 断线重连时要从 DB 读回每个 item 的 current_stage 做 catch-up
  (避免重放事件队列, memory backend 不存历史).

  新增一列 current_stage VARCHAR(20) NULL. 允许空 (对旧 item 和
  pending/done/failed 状态的 item 都是 NULL).

回滚保障 (按用户硬性要求 1):
  downgrade 完整, 用 op.batch_alter_table 兼容 SQLite (原生不支持 DROP COLUMN,
  batch_alter 自动 recreate 表).
"""
from alembic import op
import sqlalchemy as sa


revision = "c2f9a1_current_stage"
down_revision = "b1c0de_static_prefix"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("batch_items") as batch_op:
        batch_op.add_column(
            sa.Column("current_stage", sa.String(length=20), nullable=True)
        )


def downgrade():
    with op.batch_alter_table("batch_items") as batch_op:
        batch_op.drop_column("current_stage")
