"""add User.custom_deepseek_key_enc + custom_gpt_image_key_enc (dual key mode)

Revision ID: e4f1a2_dual_key
Revises: d3e0f1_rename_peihao
Create Date: 2026-05-07

背景 (PR C 2026-05-07 商业化):
P3 砍刀流让所有用户共用 platform key. 商业化模式调整: 付费用户走 platform key,
非付费用户自配 DeepSeek + GPT-image-2 key. User 表加 2 列存 Fernet 加密 key.

老字段 custom_api_key_enc 保留并把现有数据复制到 custom_deepseek_key_enc
(向后兼容历史用户曾配过的 DeepSeek key).

回滚保障:
  downgrade 完整 drop 2 个新列, 用 batch_alter_table 兼容 SQLite (原生不支持
  DROP COLUMN, batch_alter 自动 recreate 表).
"""
from alembic import op
import sqlalchemy as sa


revision = "e4f1a2_dual_key"
down_revision = "d3e0f1_rename_peihao"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as batch_op:
        batch_op.add_column(
            sa.Column("custom_deepseek_key_enc", sa.Text(), nullable=True)
        )
        batch_op.add_column(
            sa.Column("custom_gpt_image_key_enc", sa.Text(), nullable=True)
        )

    # 历史数据复制: custom_api_key_enc 有值的, 当作 DeepSeek key 拷过去
    # (P3 砍刀前 custom_api_key_enc 一直是 DeepSeek key 的存放位置)
    op.execute(
        "UPDATE users SET custom_deepseek_key_enc = custom_api_key_enc "
        "WHERE custom_api_key_enc IS NOT NULL AND custom_api_key_enc != ''"
    )


def downgrade():
    with op.batch_alter_table("users") as batch_op:
        batch_op.drop_column("custom_gpt_image_key_enc")
        batch_op.drop_column("custom_deepseek_key_enc")
