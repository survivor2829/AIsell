"""共用 pytest fixture / helper for ai_refine_v2 tests.

P0 T2: addCleanup 模式的根因清理工具.
"""
from __future__ import annotations

from app import app, db
from models import Batch, User
import pytest
import time


@pytest.fixture(autouse=True)
def offline_supplier_quote(monkeypatch):
    """Existing pipeline tests mock generation; price lookups must be offline too."""
    from ai_refine_v2 import pricing
    from ai_refine_v2.image_profile import normalize_profile
    monkeypatch.setattr(pricing, "read_quote", lambda **kwargs: {
        "version": 1, "checked_at": time.time(), "image_unit_cny": .70,
        **{f"image_{key}": value for key, value in normalize_profile(kwargs.get("image_profile")).items()},
        "planner_per_million_cny": {"input": 2, "cache": .04, "output": 8},
        "sources": ["test-fixture-no-network"],
    })
    monkeypatch.setattr("pricing_config.MAX_REFINE_COST_PER_RUN", 100)


def cleanup_user(username: str) -> None:
    """删除指定用户名的 User row + 其 Batch (FK 级联到 BatchItem).

    设计:
    - Batch.user_id FK 没 ondelete=CASCADE, 必须先删 Batch
    - BatchItem.batch_id FK 有 ondelete=CASCADE, ORM 自动级联
    - 测 fixture 不会创 GenerationLog, 暂不处理 (HIGH issue defer)
    """
    with app.app_context():
        u = User.query.filter_by(username=username).first()
        if u is None:
            return
        for b in Batch.query.filter_by(user_id=u.id).all():
            db.session.delete(b)
        db.session.flush()
        db.session.delete(u)
        db.session.commit()
