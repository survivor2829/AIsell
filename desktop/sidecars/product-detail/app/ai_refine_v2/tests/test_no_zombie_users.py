"""CI 守护: 任何测跑完后, DB 不许残留 zombie-prefix 用户.

T2 加的 addCleanup 是"防再造"; 本测是"事后核查", 双保险.
"""
import re
import unittest

from app import app
from models import User


ZOMBIE_RE = re.compile(
    r"^(alice|bob_other|lock_user|bi_user|done_user|ok_user|viewer)_[a-f0-9]{6,}$"
)


class TestNoZombieUsers(unittest.TestCase):
    def test_zero_zombie_users_in_db(self):
        """跑完所有测后 (本测在 alphabetical 末尾附近), DB 应当 0 zombie."""
        with app.app_context():
            zombies = [
                u for u in User.query.all() if ZOMBIE_RE.match(u.username)
            ]
            sample = [u.username for u in zombies[:5]]
            self.assertEqual(
                len(zombies), 0,
                f"DB 残留 {len(zombies)} 条僵尸用户; 前 5: {sample}; "
                f"修法: 1) 检查新增测试是否漏了 addCleanup; "
                f"2) 删 scripts/_tmp_purge_test_users.py 重写 + 跑一次"
            )
