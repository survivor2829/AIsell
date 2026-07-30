"""验证 addCleanup 模式真在 test 结束后清理 User row.

不依赖 pytest 测试方法收集顺序 (避免 pytest-randomly / xdist 时变绿).
单测内部驱动 unittest.TestCase 的完整生命周期来证 cleanup 真触发.
"""
from __future__ import annotations

import unittest

from app import app, db
from models import User
from ai_refine_v2.tests.conftest import cleanup_user


class _InnerTest(unittest.TestCase):
    """内嵌一个 fake test 用于让外层测试驱动其 lifecycle."""

    def runTest(self):
        with app.app_context():
            u = User(username="fixture_rollback_inner_user")
            u.set_password("x")
            db.session.add(u)
            db.session.commit()
        # 注册 cleanup; runTest() 完后 unittest 自动调
        self.addCleanup(cleanup_user, "fixture_rollback_inner_user")


class TestAddCleanupActuallyFires(unittest.TestCase):
    """断言 addCleanup 真触发 + 真清掉 row, 不依赖外部测试顺序."""

    def setUp(self):
        app.config["TESTING"] = True
        app.config["WTF_CSRF_ENABLED"] = False

    def test_cleanup_fires_after_test_completes(self):
        # 跑内层 fake test 一次; unittest.TestCase.run() 会自动调所有 addCleanup
        result = unittest.TestResult()
        _InnerTest().run(result)

        # 断言 fake test 自身没崩
        self.assertEqual(len(result.errors), 0,
                         f"内层 test 报错: {result.errors}")
        self.assertEqual(len(result.failures), 0,
                         f"内层 test 失败: {result.failures}")

        # 真正断言: 那个 user 已经被 cleanup 了
        with app.app_context():
            found = User.query.filter_by(
                username="fixture_rollback_inner_user").first()
            self.assertIsNone(found,
                              "addCleanup 没真触发, fixture_rollback_inner_user 还在 DB")

    def test_cleanup_with_no_existing_user_is_noop(self):
        """边界: cleanup_user 调用一个不存在的 username 不应报错."""
        cleanup_user("definitely_does_not_exist_xyz_12345")
        # 不抛异常 = 通过
