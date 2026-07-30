"""
数据库模型：用户 + 生成日志
"""
from datetime import datetime
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=True)
    is_admin = db.Column(db.Boolean, default=False)
    is_paid = db.Column(db.Boolean, default=False)
    is_approved = db.Column(db.Boolean, default=False)
    custom_api_key_enc = db.Column(db.Text, nullable=True)
    # PR C (2026-05-07): 二级模式 — 非付费用户自配 DeepSeek + GPT-image-2 key,
    # Fernet 加密. 付费 (is_paid=True) 用户走 platform key, 这两列为空.
    # custom_api_key_enc 老字段保留, alembic migration 复制其内容到 deepseek_key.
    custom_deepseek_key_enc = db.Column(db.Text, nullable=True)
    custom_gpt_image_key_enc = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_active = db.Column(db.DateTime, default=datetime.utcnow)

    logs = db.relationship("GenerationLog", backref="user", lazy="dynamic",
                           cascade="all, delete-orphan", passive_deletes=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def __repr__(self):
        return f"<User {self.username}>"


class GenerationLog(db.Model):
    __tablename__ = "generation_logs"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    product_type = db.Column(db.String(50), nullable=False)
    model_name = db.Column(db.String(100), default="")
    api_key_source = db.Column(db.String(20), default="")  # 'platform' | 'custom' | 'none'
    action = db.Column(db.String(20), default="generate")   # 'generate' | 'export'
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def __repr__(self):
        return f"<Log {self.user_id} {self.product_type} {self.created_at}>"


# ── 批量生成（PRD: PRD_批量生成.md F9/F10）─────────────────────────
class Batch(db.Model):
    """一次批量上传 = 一个 Batch 行；下挂 N 个 BatchItem。"""
    __tablename__ = "batches"

    id = db.Column(db.Integer, primary_key=True)
    batch_id = db.Column(db.String(64), unique=True, nullable=False, index=True)
    name = db.Column(db.String(200), nullable=False)        # 已加 (第N次) 后缀的最终显示名
    raw_name = db.Column(db.String(200), nullable=False, index=True)  # 用户原始输入名
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    status = db.Column(db.String(20), default="uploaded", index=True)
    # uploaded → queued → running → completed / failed / archived
    total_count = db.Column(db.Integer, default=0)
    valid_count = db.Column(db.Integer, default=0)
    skipped_count = db.Column(db.Integer, default=0)
    batch_dir = db.Column(db.String(255), nullable=False)   # 相对项目根
    # 任务9 (PRD F11): 模板策略
    template_strategy = db.Column(db.String(20), default="auto")  # 'auto' | 'fixed'
    fixed_theme_id = db.Column(db.String(40), nullable=True)       # 仅当 strategy='fixed'
    product_category = db.Column(db.String(20), default="设备类")  # 设备类/耗材类/工具类/配件类
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    items = db.relationship("BatchItem", backref="batch", lazy="dynamic",
                            cascade="all, delete-orphan", passive_deletes=True,
                            order_by="BatchItem.id")

    def to_dict(self, with_items: bool = False) -> dict:
        d = {
            "id": self.id,
            "batch_id": self.batch_id,
            "name": self.name,
            "raw_name": self.raw_name,
            "user_id": self.user_id,
            "status": self.status,
            "total_count": self.total_count,
            "valid_count": self.valid_count,
            "skipped_count": self.skipped_count,
            "batch_dir": self.batch_dir,
            "template_strategy": self.template_strategy or "auto",
            "fixed_theme_id": self.fixed_theme_id,
            "product_category": self.product_category or "设备类",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }
        if with_items:
            d["items"] = [it.to_dict() for it in self.items.all()]
        return d

    def __repr__(self):
        return f"<Batch {self.batch_id} {self.name} valid={self.valid_count}>"


class BatchItem(db.Model):
    """批次中的一个产品。命名不规范的也入表（status=skipped + skip_reason）。"""
    __tablename__ = "batch_items"

    id = db.Column(db.Integer, primary_key=True)
    batch_pk = db.Column(db.Integer, db.ForeignKey("batches.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)        # 文件夹名,如 "产品A"
    status = db.Column(db.String(20), default="pending", index=True)
    # pending → processing → done / failed / skipped
    main_image_path = db.Column(db.String(500), default="")
    detail_image_paths = db.Column(db.Text, default="[]")   # JSON list of str
    desc_text = db.Column(db.Text, default="")              # 完整文案（任务4 喂 DeepSeek）
    desc_chars = db.Column(db.Integer, default=0)
    skip_reason = db.Column(db.String(200), nullable=True)
    error = db.Column(db.Text, nullable=True)
    result = db.Column(db.Text, nullable=True)              # JSON
    want_ai_refine = db.Column(db.Boolean, default=False)   # PRD F6 用户勾选
    ai_refine_status = db.Column(db.String(20), default="not_requested")
    # 任务9 (PRD F11): 处理时解析出的主题 (auto 模式下来自 product_type 关键词;fixed 直通)
    resolved_theme_id = db.Column(db.String(40), nullable=True)
    resolved_theme_matched_by = db.Column(db.String(80), nullable=True)  # 调试: 'keyword:AI' / 'fixed:tech-blue'
    # not_requested / pending / processing / done / failed
    # 任务2 (2026-04-22): 实时阶段 pill. parsing/cutting/rendering/capturing, done/failed 时清回 null.
    # WS 断线重连时前端从 /api/batch/<id>/status 读回此值做 catch-up.
    current_stage = db.Column(db.String(20), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    started_at = db.Column(db.DateTime, nullable=True)
    finished_at = db.Column(db.DateTime, nullable=True)

    def to_dict(self) -> dict:
        import json as _json
        try:
            details = _json.loads(self.detail_image_paths or "[]")
        except _json.JSONDecodeError:
            details = []
        try:
            result_obj = _json.loads(self.result) if self.result else None
        except _json.JSONDecodeError:
            result_obj = None
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "main_image_path": self.main_image_path,
            "detail_image_paths": details,
            "desc_text": self.desc_text,
            "desc_chars": self.desc_chars,
            "skip_reason": self.skip_reason,
            "error": self.error,
            "result": result_obj,
            "want_ai_refine": self.want_ai_refine,
            "ai_refine_status": self.ai_refine_status,
            "resolved_theme_id": self.resolved_theme_id,
            "resolved_theme_matched_by": self.resolved_theme_matched_by,
            "current_stage": self.current_stage,  # 任务2: 实时阶段 pill 值 (null/parsing/cutting/rendering/capturing)
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }

    def __repr__(self):
        return f"<BatchItem {self.name} {self.status}>"
