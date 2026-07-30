"""守护测: 批量生成管线核心路径 (upload + state machine + schema drift).

背景 (2026-05-08):
批量管线最近一次成功跑是 4/30, 之后 6 个 PR (P5.0 / P5.1 / 配件类重命名 /
dual key / lifestyle reorder / material_origin / CSRF 24h) 都没碰过批量代码,
但有 schema migration 改动. 用户接下来要重度用批量功能,需要"用的时候直接
跑通"的硬保障 — 这 3 条守护测把"代码层 work"固化进 CI.

防的回归:
1. TestBatchUploadSmoke
   - 路由签名变 / zip 解压挂 / scan_batch 改坏 / DB 持久化失败
   - POST /api/batch/upload 一个最小 zip → 200 + DB row 写入

2. TestBatchStateMachine
   - _batch_db_sync_callback 状态机被改坏 (worker 状态 → DB 同步逻辑)
   - 验证 Batch.status: uploaded → running → completed 流转
   - 验证 BatchItem.status: pending → processing → done + started_at/finished_at

3. TestSchemaDriftGuard
   - 防 alembic migration 漏 / 字段拼错 / models.py 跟 DB 真实 schema 偏离
   - 本次 session 实测: 我把 success_count 当 batches 列查 → 没有, 实际是
     valid_count + skipped_count. 这种"列名以为存在但其实没有"的乌龙必须红测.
"""
from __future__ import annotations

import io
import json
import shutil
import unittest
import uuid
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from unittest import mock

from PIL import Image

from app import (
    app, db,
    UPLOAD_DIR,
    _batch_db_sync_callback,
)
from models import User, Batch, BatchItem
from ai_refine_v2.tests.conftest import cleanup_user as _cleanup_user


# ── helpers (沿用 ai_refine_v2/tests/test_regen_endpoint.py 模式) ──

def _uid(prefix: str) -> str:
    """跨 session 唯一字符串 ID, 防 batch_id / username 撞车."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _make_authed_client(test_instance: unittest.TestCase, username: str | None = None):
    """登录测试 client. test_instance 用于 addCleanup 注册."""
    username = username or _uid("batchuser")
    client = app.test_client()
    with app.app_context():
        u = User.query.filter_by(username=username).first()
        if u is None:
            u = User(username=username, is_approved=True, is_paid=True)
            u.set_password("x")
            db.session.add(u)
            db.session.commit()
            test_instance.addCleanup(_cleanup_user, username)
        uid = u.id
    with client.session_transaction() as sess:
        sess["_user_id"] = str(uid)
    return client, uid


def _png_bytes() -> bytes:
    """1x1 RGB PNG 占位, 不依赖外部素材."""
    buf = BytesIO()
    Image.new("RGB", (1, 1), color="white").save(buf, "PNG")
    return buf.getvalue()


def _make_minimal_zip(product_name: str = "测试产品A") -> bytes:
    """造一个 zip 含 1 个合规产品文件夹: <product_name>/main.jpg + desc.txt."""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{product_name}/main.jpg", _png_bytes())
        zf.writestr(f"{product_name}/desc.txt",
                    "测试用文案: 商用清洁机器人, 适用于商场/写字楼/车间.")
    return buf.getvalue()


def _cleanup_batch_dir(batch_id: str) -> None:
    """删除 uploads/batches/<batch_id>/ 目录, 防测试污染."""
    target = UPLOAD_DIR / "batches" / batch_id
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)


# ── 守护测 1: upload smoke ─────────────────────────────────────────

class TestBatchUploadSmoke(unittest.TestCase):
    """端到端冒烟: POST /api/batch/upload → 200 + DB 写入."""

    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_upload_minimal_zip_returns_200_and_persists_db(self):
        client, uid = _make_authed_client(self)
        zip_bytes = _make_minimal_zip("产品A")

        r = client.post(
            "/api/batch/upload",
            data={
                "file": (BytesIO(zip_bytes), "test_batch.zip"),
                "batch_name": _uid("smoke"),
                "product_category": "设备类",
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(r.status_code, 200, f"upload 失败: {r.get_data(as_text=True)}")
        body = r.get_json()
        self.assertIn("batch_id", body)
        self.assertEqual(body["valid_count"], 1, "1 个合规产品应该被识别为 valid")
        self.assertEqual(body["skipped_count"], 0)
        self.assertEqual(body["total_folders"], 1)
        self.assertEqual(body["product_category"], "设备类")
        self.assertEqual(body["template_strategy"], "auto")

        batch_id = body["batch_id"]
        self.addCleanup(_cleanup_batch_dir, batch_id)

        with app.app_context():
            b = Batch.query.filter_by(batch_id=batch_id).first()
            self.assertIsNotNone(b, f"batch 没入 DB: {batch_id}")
            self.assertEqual(b.user_id, uid)
            self.assertEqual(b.status, "uploaded")
            self.assertEqual(b.valid_count, 1)
            items = b.items.all()
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0].name, "产品A")
            self.assertEqual(items[0].status, "pending")
            self.assertGreater(items[0].desc_chars, 0, "desc_text 应被解析入库")

    def test_upload_no_file_returns_400(self):
        """守护: 路由保留 file 字段必填校验, 防被改坏成 500."""
        client, _ = _make_authed_client(self)
        r = client.post("/api/batch/upload", data={}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        self.assertIn("file", r.get_json().get("error", ""))

    def test_upload_non_zip_returns_400(self):
        """守护: 非 zip 文件被拒, 防 zip slip 防御层被绕过."""
        client, _ = _make_authed_client(self)
        r = client.post(
            "/api/batch/upload",
            data={"file": (BytesIO(b"not a zip"), "fake.txt")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn(".zip", r.get_json().get("error", ""))


# ── 守护测 2: state machine ────────────────────────────────────────

class TestBatchStateMachine(unittest.TestCase):
    """_batch_db_sync_callback: worker 状态 → DB 同步逻辑."""

    def setUp(self):
        app.config["TESTING"] = True

    def _seed_batch_with_one_pending_item(self, username: str, item_name: str = "P"):
        """造一个有 1 个 pending item 的 batch, 返回 (batch_id, item_pk)."""
        batch_id = _uid("sm")
        with app.app_context():
            u = User.query.filter_by(username=username).first()
            if u is None:
                u = User(username=username, is_approved=True, is_paid=True)
                u.set_password("x")
                db.session.add(u)
                db.session.commit()
                self.addCleanup(_cleanup_user, username)
            b = Batch(
                batch_id=batch_id, name=batch_id, raw_name=batch_id,
                user_id=u.id, status="uploaded",
                total_count=1, valid_count=1, skipped_count=0,
                batch_dir=f"static/uploads/batches/{batch_id}",
            )
            db.session.add(b)
            db.session.flush()
            it = BatchItem(batch_pk=b.id, name=item_name, status="pending")
            db.session.add(it)
            db.session.commit()
            return batch_id, it.id

    def test_processing_then_done_flow(self):
        """worker 报 processing → done: Batch uploaded → running → completed."""
        username = _uid("sm_user")
        batch_id, item_pk = self._seed_batch_with_one_pending_item(username, "产品A")

        # 1) processing
        _batch_db_sync_callback(batch_id, "产品A", "processing", None, None)
        with app.app_context():
            b = Batch.query.filter_by(batch_id=batch_id).first()
            it = BatchItem.query.get(item_pk)
            self.assertEqual(b.status, "running",
                             "首个 item 进 processing → batch.status=running")
            self.assertEqual(it.status, "processing")
            self.assertIsNotNone(it.started_at, "started_at 必须在 processing 时打点")

        # 2) done (单 item batch, 应该立刻 completed)
        result = {"task_id": "v2_test", "ok": True}
        _batch_db_sync_callback(batch_id, "产品A", "done", result, None)
        with app.app_context():
            b = Batch.query.filter_by(batch_id=batch_id).first()
            it = BatchItem.query.get(item_pk)
            self.assertEqual(b.status, "completed",
                             "全部 item 终态后 batch.status=completed")
            self.assertEqual(it.status, "done")
            self.assertIsNotNone(it.finished_at, "finished_at 必须在终态时打点")
            self.assertIsNone(it.current_stage, "终态时 current_stage 必须清 null")
            self.assertEqual(json.loads(it.result), result)

    def test_failed_item_does_not_break_batch_completion(self):
        """worker 报 failed: item.status=failed + error, batch 仍能进 completed."""
        username = _uid("sm_fail")
        batch_id, item_pk = self._seed_batch_with_one_pending_item(username, "产品B")

        _batch_db_sync_callback(batch_id, "产品B", "failed", None, "DeepSeek 限流")
        with app.app_context():
            b = Batch.query.filter_by(batch_id=batch_id).first()
            it = BatchItem.query.get(item_pk)
            self.assertEqual(it.status, "failed")
            self.assertEqual(it.error, "DeepSeek 限流")
            self.assertEqual(b.status, "completed",
                             "全部 item 终态(含 failed) → batch.status=completed")

    def test_unknown_batch_silent_skip(self):
        """worker 回调不存在的 batch_id: 不抛异常, 安全跳过 (worker 不能死循环)."""
        # 不应该 raise
        _batch_db_sync_callback("BATCH_DOES_NOT_EXIST", "x", "done", None, None)


# ── 守护测 3: schema drift guard ───────────────────────────────────

class TestSchemaDriftGuard(unittest.TestCase):
    """防 alembic migration 跟 models.py 漂移导致 prod 查询炸."""

    EXPECTED_BATCHES_COLUMNS = {
        # 列名 → 不可漂移. 加列 OK (向前兼容), 改/删名字立刻红测.
        "id", "batch_id", "name", "raw_name", "user_id", "status",
        "total_count", "valid_count", "skipped_count", "batch_dir",
        "template_strategy", "fixed_theme_id", "product_category",
        "created_at", "updated_at",
    }

    EXPECTED_BATCH_ITEMS_COLUMNS = {
        "id", "batch_pk", "name", "status",
        "main_image_path", "detail_image_paths", "desc_text", "desc_chars",
        "skip_reason", "error", "result",
        "want_ai_refine", "ai_refine_status",
        "resolved_theme_id", "resolved_theme_matched_by",
        "current_stage",
        "created_at", "updated_at", "started_at", "finished_at",
    }

    def test_batches_table_has_expected_columns(self):
        """守护: batches 表实际列必须包含 EXPECTED_BATCHES_COLUMNS 全集."""
        from sqlalchemy import inspect as _inspect
        with app.app_context():
            insp = _inspect(db.engine)
            actual = {c["name"] for c in insp.get_columns("batches")}
            missing = self.EXPECTED_BATCHES_COLUMNS - actual
            self.assertFalse(
                missing,
                f"batches 表缺列 {missing}. 可能 alembic migration 没跑全或被 revert. "
                f"实际列: {sorted(actual)}",
            )

    def test_batch_items_table_has_expected_columns(self):
        """守护: batch_items 表实际列必须包含 EXPECTED_BATCH_ITEMS_COLUMNS 全集."""
        from sqlalchemy import inspect as _inspect
        with app.app_context():
            insp = _inspect(db.engine)
            actual = {c["name"] for c in insp.get_columns("batch_items")}
            missing = self.EXPECTED_BATCH_ITEMS_COLUMNS - actual
            self.assertFalse(
                missing,
                f"batch_items 表缺列 {missing}. 可能 c2f9a1 (current_stage) 或后续 "
                f"migration 没跑全. 实际列: {sorted(actual)}",
            )

    def test_models_match_db_inspector(self):
        """守护: models.Batch / BatchItem 的 ORM 列声明跟 DB 实际 schema 一致.

        防 'models.py 加了字段但忘记写 alembic migration' 的常见错.
        """
        from sqlalchemy import inspect as _inspect
        with app.app_context():
            insp = _inspect(db.engine)
            for model_cls, table_name in [(Batch, "batches"), (BatchItem, "batch_items")]:
                model_cols = {c.name for c in model_cls.__table__.columns}
                db_cols = {c["name"] for c in insp.get_columns(table_name)}
                only_in_model = model_cols - db_cols
                self.assertFalse(
                    only_in_model,
                    f"{model_cls.__name__}.__table__ 有列 {only_in_model} 但 DB "
                    f"{table_name} 表没有 — 缺 alembic migration!",
                )


if __name__ == "__main__":
    unittest.main()
