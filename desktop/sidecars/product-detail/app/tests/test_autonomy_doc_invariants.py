"""文档守护: AUTONOMY.md + CLAUDE.md 关键约束必须存在.

P1 T1+T2 落地. 跑这些测确保未来无意改动不会破坏档 2 PR 模式合约.
"""
from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).parent.parent
AUTONOMY = PROJECT_ROOT / ".claude" / "AUTONOMY.md"
CLAUDE_MD = PROJECT_ROOT / "CLAUDE.md"


class TestAutonomyDocInvariants(unittest.TestCase):
    """AUTONOMY.md 守护 (8 测)."""

    @classmethod
    def setUpClass(cls):
        if not AUTONOMY.exists():
            cls.text = ""
        else:
            cls.text = AUTONOMY.read_text(encoding="utf-8")

    def test_file_exists(self):
        self.assertTrue(AUTONOMY.exists(), f"{AUTONOMY} 不存在")

    def test_states_pr_mode(self):
        self.assertIn("档 2", self.text)
        self.assertIn("PR 模式", self.text)

    def test_forbids_push_to_main(self):
        self.assertRegex(
            self.text,
            r"(禁止|不得|never|do not).{0,20}push.{0,20}main",
        )

    def test_requires_authorization_for_merge(self):
        self.assertIn("merge PR", self.text)
        self.assertIn("授权", self.text)

    def test_requires_authorization_for_deploy(self):
        self.assertIn("deploy", self.text)

    def test_requires_authorization_for_money(self):
        self.assertIn("花钱", self.text)

    def test_lists_self_review_checklist(self):
        self.assertIn("pytest", self.text)
        self.assertIn("smoke", self.text)
        self.assertIn("PR description", self.text)

    def test_defines_upgrade_downgrade_triggers(self):
        # 至少有数值阈值, 防"若干次"模糊化
        self.assertRegex(self.text, r"\d+\s*%")


class TestClaudeMdReferencesAutonomy(unittest.TestCase):
    """CLAUDE.md 必须引用 AUTONOMY.md (1 测, 由 T2 解锁)."""

    def test_claude_md_links_autonomy(self):
        text = CLAUDE_MD.read_text(encoding="utf-8")
        self.assertIn(
            ".claude/AUTONOMY.md", text,
            "CLAUDE.md 没引用 AUTONOMY.md, 新 agent / 新 session 找不到自主性约定"
        )
