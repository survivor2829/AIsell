"""rename batches.product_category 配耗类 → 配件类

Revision ID: d3e0f1_rename_peihao
Revises: c2f9a1_current_stage
Create Date: 2026-05-07

背景 (用户 2026-05-07 改名):
  4 大产品类原是 [设备类, 耗材类, 配耗类, 工具类]. 用户反馈 "配耗" 不直观,
  改成 "配件类" 更符合用户认知 (机器人配件 + 耗材组合 → 实际就是配件).

  本 migration 把 DB 已有数据的 "配耗类" 全部改成 "配件类". 防御性 migration:
  prod 当前 12 batch 全是 "设备类", 0 个 "配耗类", 但仍写 UPDATE 防御未来开发
  环境 / 测试 DB 已经创建了的 "配耗类" 数据.

回滚保障:
  downgrade 反向 UPDATE, "配件类" → "配耗类".
"""
from alembic import op


revision = "d3e0f1_rename_peihao"
down_revision = "c2f9a1_current_stage"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "UPDATE batches SET product_category = '配件类' "
        "WHERE product_category = '配耗类'"
    )


def downgrade():
    op.execute(
        "UPDATE batches SET product_category = '配耗类' "
        "WHERE product_category = '配件类'"
    )
