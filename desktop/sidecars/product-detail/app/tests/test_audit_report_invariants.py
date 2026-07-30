"""守护: 审计报告必须含关键节. 防被未来无意改坏.

per `docs/superpowers/plans/2026-05-06-P2-tech-debt-audit-implementation.md` T3 step 5.
"""
from pathlib import Path
import unittest

REPORT = Path(__file__).parent.parent / "docs/superpowers/audits/2026-05-06-tech-debt-audit.md"
STUBS_DIR = Path(__file__).parent.parent / "docs/superpowers/specs/_stubs"


class TestAuditReport(unittest.TestCase):
    """文档守护测 — 报告关键结构不许被后续 PR 无意改坏."""

    @classmethod
    def setUpClass(cls):
        cls.text = REPORT.read_text(encoding="utf-8")

    def test_report_exists(self):
        self.assertTrue(REPORT.exists(), f"报告文件不存在: {REPORT}")

    def test_has_top10_section(self):
        self.assertIn("Top 10 严重度排名", self.text)

    def test_has_4_categories(self):
        self.assertIn("§A. 安全债", self.text)
        self.assertIn("§B. 架构债", self.text)
        self.assertIn("§C. 代码风味债", self.text)
        self.assertIn("§D. Dead code", self.text)

    def test_has_severity_definitions(self):
        self.assertIn("严重", self.text)
        self.assertIn("中", self.text)
        self.assertIn("低", self.text)

    def test_has_scott_decision_section(self):
        self.assertIn("Scott 决策栏", self.text)

    def test_has_root_cause_analysis(self):
        """跨类根因分析必须存在 — N→K 压缩是 audit 最高价值产出."""
        self.assertIn("根因模式分析", self.text)

    def test_no_TBD_in_top10_rows(self):
        """Top 10 表 #1-#10 行不能含 TBD 占位符."""
        top10_section = self.text.split("Top 10 严重度排名")[1].split("分类细节")[0]
        for n in range(1, 11):
            row_marker = f"| {n} |"
            self.assertIn(row_marker, top10_section, f"Top 10 缺第 {n} 行")
            row = next((line for line in top10_section.split("\n") if line.startswith(row_marker)), "")
            self.assertNotIn("TBD", row, f"Top 10 第 {n} 行仍是 TBD 占位: {row}")

    def test_severity_total_table_filled(self):
        """总览表的合计行必须是数字, 不能是 TBD."""
        overview_section = self.text.split("总览")[1].split("Top 10")[0]
        # 含 "合计" 那行
        合计_lines = [line for line in overview_section.split("\n") if "**合计**" in line]
        self.assertTrue(合计_lines, "总览表缺合计行")
        for line in 合计_lines:
            self.assertNotIn("TBD", line, f"合计行仍含 TBD: {line}")

    def test_raw_archives_exist(self):
        """4 份 sub-agent 原始片段必须存档."""
        raw_dir = REPORT.parent / "_raw"
        for name in ["security", "architect", "code-review", "explore"]:
            f = raw_dir / f"2026-05-06-{name}.md"
            self.assertTrue(f.exists(), f"缺原始片段: {f}")
            self.assertGreater(f.stat().st_size, 500, f"片段太短可能空: {f}")

    def test_root_cause_lists_5_categories(self):
        """根因模式必须 ≥ 4 个根因 (设计目标是 N→K 大幅压缩)."""
        rc_section = self.text.split("根因模式分析")[1].split("Scott 决策栏")[0]
        # 根因 1, 根因 2, 根因 3, 根因 4 至少
        for n in range(1, 5):
            self.assertIn(f"根因 {n}", rc_section, f"根因模式缺第 {n} 项")

    def test_top10_stubs_exist(self):
        """Top 10 每条都必须有对应 _stubs/ 文件 (Scott review 时点链接可看到详细方案)."""
        expected_stubs = [
            "C5-except-pass-decrypt-stub.md",
            "A1-secret-key-fallback-stub.md",
            "B4-windows-font-path-stub.md",
            "C10-clear-proxy-race-stub.md",
            "A6-task-id-idor-stub.md",
            "A4-login-no-ratelimit-stub.md",
            "C1-no-logging-stub.md",
            "B1-app-py-god-module-stub.md",
            "B7-map-parsed-spaghetti-stub.md",
            "B5-prompt-template-monolith-stub.md",
        ]
        missing = [s for s in expected_stubs if not (STUBS_DIR / s).exists()]
        self.assertFalse(missing, f"缺 stub: {missing}")

    def test_each_stub_has_required_sections(self):
        """每个 stub 必须含: 问题简述 / 修复方案 / checklist."""
        required = ["问题简述", "修复方案", "checklist"]
        for stub in STUBS_DIR.glob("*-stub.md"):
            text = stub.read_text(encoding="utf-8")
            for section in required:
                self.assertIn(section, text, f"{stub.name} 缺节: {section}")


if __name__ == "__main__":
    unittest.main()
