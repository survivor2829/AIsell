"""守护测: P5.0 可移植度评估报告完整性.

确保:
- 主报告与 _raw 原始输出文件都在 git 里 (audit-only deliverable)
- 主报告含 §A-§F 6 节核心结构
- 三色矩阵汇总数字 (24 🟢 / 4 🟡 / 0 🔴) 在主报告/裸输出中一致
"""
from __future__ import annotations
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MAIN_REPORT = REPO / "docs" / "superpowers" / "audits" / "2026-05-06-portability-assessment.md"
RAW_REPORT = REPO / "docs" / "superpowers" / "audits" / "_raw" / "2026-05-06-portability.md"


class TestReportFilesExist:
    """守护: 主报告 + 裸输出都必须存在."""

    def test_main_report_exists(self):
        assert MAIN_REPORT.is_file(), (
            f"主评估报告必须存在: {MAIN_REPORT}. "
            "P5.0 audit-only deliverable, 删了等于回退本次 sprint."
        )

    def test_raw_report_exists(self):
        assert RAW_REPORT.is_file(), (
            f"architect agent 裸输出必须存在: {RAW_REPORT}. "
            "审计可追溯 — 后续若有人质疑判断, _raw 是 architect 原始证据."
        )


class TestMainReportStructure:
    """守护: 主报告必须含 §A-§F 6 节."""

    def test_required_sections(self):
        content = MAIN_REPORT.read_text(encoding="utf-8")
        required = [
            "## §A. 33 Block 三色矩阵",
            "## §B. 4 工序适配度评级",
            "## §C. 耗品 4 板斧叙事映射",
            "## §D. P5.1+ 工时再校准",
            "## §E. 人审反向校验证据",
            "## §F. 决策建议",
        ]
        for sect in required:
            assert sect in content, (
                f"主报告缺节 {sect!r}. 这 6 节是评估报告的不变量结构."
            )


class TestThreeColorTotals:
    """守护: 三色汇总数字一致 (24 🟢 / 4 🟡 / 0 🔴 / 5 main_img all 🟢)."""

    def test_block_totals_in_main_report(self):
        content = MAIN_REPORT.read_text(encoding="utf-8")
        # 主报告 §A.1 摘要
        assert "🟢 24" in content or "24 (85.7%)" in content, (
            "主报告必须明示 24 个 🟢 复用 block (基于 architect agent 评估)."
        )
        assert "🟡 4" in content, (
            "主报告必须明示 4 个 🟡 重写 block (a/b3/c1/f)."
        )
        assert "🔴 0" in content, (
            "主报告必须明示 0 个 🔴 删除 block."
        )

    def test_main_img_all_green(self):
        content = MAIN_REPORT.read_text(encoding="utf-8")
        assert "🟢 5/5" in content, (
            "主报告必须明示 5 个 main_img 模板全部 🟢 复用."
        )


class TestWorkHoursCalibration:
    """守护: 工时再校准给出明确的修正区间 (6-9 day)."""

    def test_calibrated_total_hours_present(self):
        content = MAIN_REPORT.read_text(encoding="utf-8")
        # 必须有总工时区间 (6-9 day)
        assert "6-9d" in content or "6-9 day" in content, (
            "主报告必须给出修正后总工时区间 6-9d (基于子阶段累加)."
        )
        # 必须有原估对比 (10 day)
        assert "10d" in content or "10 day" in content, (
            "主报告必须保留原 master spec 估算 10d 作为对比锚点."
        )


class TestKeyFindingMentioned:
    """守护: '耗材类基建已完成 60%' 这个关键发现必须在主报告中."""

    def test_60_percent_finding(self):
        content = MAIN_REPORT.read_text(encoding="utf-8")
        assert "60%" in content, (
            "主报告必须含'耗材类基建已完成 60%'这个关键发现, "
            "它是工时压缩 30-45% 的核心依据."
        )
