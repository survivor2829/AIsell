"""regenerate-screen 端点 单测 (v3.3 task5/6).

mock 掉 ai_refine_v2.regen_single.regenerate_screen, 只测 endpoint 自己的
权限/边界/锁/WS publish 行为. 真实重生成走 ai_refine_v2/tests/test_regen_single.py.
"""
from __future__ import annotations

import json
import unittest
import uuid
from unittest import mock

from app import app, db
from models import User, Batch, BatchItem
from ai_refine_v2.tests.conftest import cleanup_user as _cleanup_user


def _uid(prefix: str) -> str:
    """返回跨 session 唯一的字符串 ID，避免与其他测试文件的 batch_id / username 冲突."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _make_authed_client(test_instance: unittest.TestCase, username="testuser"):
    """创建已登录的测试客户端，并注册 addCleanup 以防止僵尸用户残留。

    Args:
        test_instance: 调用方的 TestCase 实例（self），用于注册 addCleanup。
        username: 要创建或复用的用户名；调用方应传 _uid(...) 生成的唯一名。
    """
    client = app.test_client()
    with app.app_context():
        u = User.query.filter_by(username=username).first()
        if u is None:
            u = User(username=username, is_approved=True, is_paid=True)
            u.set_password("x")
            db.session.add(u)
            db.session.commit()
            # 仅对新创建的行注册清理，避免误删预存测试用户
            test_instance.addCleanup(_cleanup_user, username)
        uid = u.id
    with client.session_transaction() as sess:
        sess["_user_id"] = str(uid)
    return client, uid


class TestRegenEndpoint4xx(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_unauthed_redirects_login(self):
        client = app.test_client()
        r = client.post("/api/batch/x/items/1/regenerate-screen", json={})
        self.assertIn(r.status_code, (302, 401))

    def test_batch_not_exist_404(self):
        client, _ = _make_authed_client(self)
        r = client.post(
            "/api/batch/NOTEXIST/items/1/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 404)

    def test_batch_other_owner_403(self):
        alice_name = _uid("alice")
        bob_name = _uid("bob_other")
        batch_id = _uid("bob_batch")
        client, my_uid = _make_authed_client(self, alice_name)
        with app.app_context():
            other = User(username=bob_name, is_approved=True)
            other.set_password("x")
            db.session.add(other)
            db.session.commit()
            self.addCleanup(_cleanup_user, bob_name)
            b = Batch(batch_id=batch_id, name="b", raw_name="b",
                      user_id=other.id, batch_dir="x")
            db.session.add(b)
            db.session.commit()
        r = client.post(
            f"/api/batch/{batch_id}/items/1/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 403)

    def test_item_not_done_409(self):
        username = _uid("done_user")
        batch_id = _uid("d_b")
        client, uid = _make_authed_client(self, username)
        with app.app_context():
            b = Batch(batch_id=batch_id, name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="processing",  # 不是 done
                           result=json.dumps({"task_id": "v2_test"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id
        r = client.post(
            f"/api/batch/{batch_id}/items/{it_pk}/regenerate-screen",
            json={"block_index": 0},
        )
        self.assertEqual(r.status_code, 409)

    def test_block_index_missing_400(self):
        username = _uid("bi_user")
        batch_id = _uid("bi_b")
        client, uid = _make_authed_client(self, username)
        with app.app_context():
            b = Batch(batch_id=batch_id, name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({"task_id": "v2_test"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id
        r = client.post(
            f"/api/batch/{batch_id}/items/{it_pk}/regenerate-screen",
            json={},
        )
        self.assertEqual(r.status_code, 400)


class TestRegenEndpoint200(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_success_calls_regenerate_screen_and_publishes_ws(self):
        from pathlib import Path
        username = _uid("ok_user")
        batch_id = _uid("ok_b")
        client, uid = _make_authed_client(self, username)
        with app.app_context():
            b = Batch(batch_id=batch_id, name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({
                               "task_id": "v2_test_xyz",
                               "ai_refined_path": "/uploads/x/p/ai_refined.jpg",
                           }))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id

        from ai_refine_v2.regen_single import RegenResult
        fake_result = RegenResult(
            new_block_path=Path("/tmp/block_4.jpg"),
            new_assembled_path=Path("/tmp/assembled.png"),
            cost_rmb=0.7,
        )
        with mock.patch(
            "ai_refine_v2.regen_single.regenerate_screen",
            return_value=fake_result,
        ) as mocked, mock.patch(
            "batch_pubsub.publish",
            return_value=1,
        ) as ws_pub, mock.patch.dict(
            "os.environ",
            {"DEEPSEEK_API_KEY": "fake_ds_key", "GPT_IMAGE_API_KEY": "fake_gpt_key"},
        ):
            # also mock task_dir.is_dir() so 410 is bypassed
            with mock.patch(
                "pathlib.Path.is_dir",
                return_value=True,
            ):
                r = client.post(
                    f"/api/batch/{batch_id}/items/{it_pk}/regenerate-screen",
                    json={"block_index": 4},
                )
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertEqual(body["block_index"], 4)
        self.assertEqual(body["cost_rmb"], 0.7)
        self.assertIn("new_assembled_url", body)
        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(ws_pub.call_count, 1)
        ev = ws_pub.call_args.args[1]
        self.assertEqual(ev["type"], "screen_regenerated")
        self.assertEqual(ev["block_index"], 4)


class TestRegenEndpointLock(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_locked_returns_423(self):
        from app import _get_regen_lock
        username = _uid("lock_user")
        batch_id = _uid("l_b")
        client, uid = _make_authed_client(self, username)
        with app.app_context():
            b = Batch(batch_id=batch_id, name="b", raw_name="b", user_id=uid,
                      batch_dir="x")
            db.session.add(b)
            db.session.commit()
            it = BatchItem(batch_pk=b.id, name="p", status="done",
                           ai_refine_status="done",
                           result=json.dumps({"task_id": "v2_t"}))
            db.session.add(it)
            db.session.commit()
            it_pk = it.id

        lk = _get_regen_lock(it_pk, 4)
        self.assertTrue(lk.acquire(blocking=False))
        try:
            r = client.post(
                f"/api/batch/{batch_id}/items/{it_pk}/regenerate-screen",
                json={"block_index": 4},
            )
            self.assertEqual(r.status_code, 423)
        finally:
            lk.release()
