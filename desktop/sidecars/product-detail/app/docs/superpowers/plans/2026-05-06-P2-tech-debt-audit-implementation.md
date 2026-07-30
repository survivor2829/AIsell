# P2 — D2 技术债中度审计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 4 个 sub-agent 并行扫描整套代码库，产出 `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` 主报告 + 每条高/中严重度债 1 份 spec stub，**全程 audit-only 不动代码**。

**Architecture:** 单条 message 4 tool call 真并行（dead code / 代码风味 / 架构 / 安全），各 agent 输出 markdown 片段；agent 完工后由本 plan 主线 aggregate 成统一报告 + 自动派发 stub 到 `_stubs/` 目录。Scott review 报告决定哪些 stub 转正式 spec 进入 P4。

**Tech Stack:** Sub-agents (`oh-my-claudecode:explore` / `code-reviewer` / `architect` / `security-reviewer`) · Markdown · 文件系统

**前置 Spec:** `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §7

**前置文档引用（必读）:**
- spec §7.1 4 sub-agent 矩阵
- spec §7.3 报告模板结构
- v3.3 spec / plan 等已有 docs 风格作为 stub 参考
- memory `user_cleanup_taste.md` — Scott 偏好 archive > delete
- memory `feedback_no_hardcoded_data.md` — 不硬编码原则（审计准则之一）

**工程原则（贯穿全 task）:**
1. 反硬编码 — 审计本身的扫描范围 / 严重度阈值 / 文件白名单都写进 prompt 配置, 不写死
2. 根本性修复 — 报告里每条债必须列 "根因诊断" 一节, 不只列 "症状"
3. PR-as-deliverable — 1 个 PR 包含完整报告 + stubs, Scott 一次性 review
4. 写后必验 — 报告写完 grep 自校验 (Top 10 排名存在 / 4 类齐备 / 每条债有严重度评级)

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `docs/superpowers/audits/` | **创建目录** | 审计报告专用 (跟 specs/plans 分开, 不要混) |
| `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` | **创建** (~500-800 行) | 主报告: Top 10 / 分类细节 / 4 类 sub-agent 输出 / Scott 决策栏 |
| `docs/superpowers/specs/_stubs/` | **创建目录** | 高/中严重度债的 spec 草稿 |
| `docs/superpowers/specs/_stubs/<topic>-stub.md` | **创建** (n 份, ~30-50 行/份) | 每条值得做的债 1 份 stub |
| `docs/superpowers/audits/_raw/` | **创建** | sub-agent 原始输出存档 (debug 用) |

**零代码改动** — 这是 audit-only 阶段。

---

## 执行顺序与依赖

```
T1 (准备目录 + 报告骨架文件)
  ↓
T2 (单条 message 4 tool call 真并行: 4 sub-agent 扫描)
  ↓
T3 (聚合 4 份输出, 写入报告 § Top 10 + 分类细节)
  ↓
T4 (按报告结果生成 spec stubs)
  ↓
T5 (报告自审 + 守护测)
  ↓
T6 (PR feat/p2-tech-audit + Scott review)
```

T2 是单步骤但**最重要**——必须真并行 (单条 message 4 tool call), 不能串行 (会浪费 4 倍时间).

---

## Task 1: 准备目录 + 写报告骨架

**Files:**
- Create: `docs/superpowers/audits/2026-05-06-tech-debt-audit.md`
- Create: `docs/superpowers/audits/_raw/.gitkeep`
- Create: `docs/superpowers/specs/_stubs/.gitkeep`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p docs/superpowers/audits/_raw
mkdir -p docs/superpowers/specs/_stubs
touch docs/superpowers/audits/_raw/.gitkeep
touch docs/superpowers/specs/_stubs/.gitkeep
```

- [ ] **Step 2: 写报告骨架（占位待 T3 填）**

写入 `docs/superpowers/audits/2026-05-06-tech-debt-audit.md`:

```markdown
# 技术债中度审计报告 v1

> **日期**: 2026-05-06
> **触发**: master roadmap §7 (Q5=B 中度审计 audit-only)
> **范围**: 全仓库 .py / templates/ / static/ / scripts/ / migrations/ / docs/
> **输出方法**: 4 sub-agent 真并行扫描
> **承诺**: audit-only, 本报告产生 0 行业务代码改动

---

## 总览

| 维度 | 严重度高 | 严重度中 | 严重度低 |
|---|---|---|---|
| 安全债 (security-reviewer) | TBD | TBD | TBD |
| 架构债 (architect) | TBD | TBD | TBD |
| 风味债 (code-reviewer) | TBD | TBD | TBD |
| Dead code (explore) | TBD | TBD | TBD |
| **合计** | TBD | TBD | TBD |

---

## Top 10 严重度排名

| # | 债 | 类型 | 严重度 | 修复估时 | spec stub | Scott 决策 |
|---|---|---|---|---|---|---|
| 1 | TBD | TBD | 严重 | TBD | _stubs/TBD-stub.md | [ ] 修 [ ] 不修 [ ] 延后 |

---

## 分类细节

### §A. 安全债 (n 项)

(由 security-reviewer agent 输出, T3 填入)

### §B. 架构债 (n 项)

(由 architect agent 输出, T3 填入)

### §C. 代码风味债 (n 项)

(由 code-reviewer agent 输出, T3 填入)

### §D. Dead code 债 (n 项)

(由 explore agent 输出, T3 填入)

---

## 根因模式分析

(T3 跨 4 类输出后的 meta 分析: 是否多个债共享同一根因? 例: 5 处硬编码源于 config 缺失 → 真根因是没有 config 体系)

---

## Scott 决策栏

每条 Top 10 旁勾选, 30 秒一条 = 5 分钟决策.

转化:
- ✅ 修 → 该 stub 转正式 spec, 进入 P4 队列
- ❌ 不修 → stub 标 deferred, 备注理由
- ⏰ 延后 → stub 标 backlog, 季度复盘

---

**起草人**: Claude Opus 4.7
**对应 Plan**: docs/superpowers/plans/2026-05-06-P2-tech-debt-audit-implementation.md
```

- [ ] **Step 3: 不 commit, 进 T2**

---

## Task 2: 4 sub-agent 真并行扫描

**Files:** 只产出, 不 modify

**关键执行模式**: 必须**单条 message 4 tool call**. 串行跑会浪费 4 倍时间, 也违反 Scott 在 spec 里强调的"真并行".

- [ ] **Step 1: 准备 4 份 prompt (每个 agent 一份)**

每份 prompt 必须包含:
- 扫描范围 (路径白名单 + 排除项)
- 严重度评级标准 (高/中/低 各自定义)
- 输出格式 (markdown 片段, 带"根因诊断 + 修复建议 + 估时" 三段)
- 严禁动手修, 仅扫描

模板 (security-reviewer 例):

```
你是本仓库的资深安全审计师. 扫描以下范围, 输出 markdown 片段.

## 扫描范围
- `app.py` (5500+ 行 Flask 主路由)
- `auth.py` / `admin.py` (认证 + 后台)
- `crypto_utils.py` (fernet key 管理)
- `models.py` (User / Batch / GenerationLog 等)
- `migrations/versions/*.py`
- 排除: `tests/` / `ai_refine_v2/tests/` / `scripts/archive/`

## 关注点 (按 OWASP Top 10 + 本项目历史问题)
1. 秘密泄露 (是否有 hardcoded API key / fernet key / DB password?)
2. CSRF 边界 (Flask-WTF 是否所有 POST 都覆盖?)
3. SQL 注入 (是否有 raw SQL? f-string 拼 SQL?)
4. 鉴权漏洞 (路由有 @login_required 吗? 越权访问其他用户 batch?)
5. 密码 / token 存储 (用 werkzeug hash 还是裸存?)
6. .env 文件管理 (gitignore? 文档是否暴露?)
7. fernet key 轮换机制 (有吗?)
8. log 中是否泄露 PII / API key?
9. session / cookie 配置 (HttpOnly / Secure / SameSite?)
10. 已知历史问题: docs/2026-04-21_踩坑复盘 §坑5 密码假成功 (是否所有 set_password 都有验证?)

## 严重度评级
- 严重 (高): 直接可被攻击者利用 / 可导致数据泄露
- 中: 需特定条件触发, 但攻击成本低
- 低: 防御纵深建议, 不修也能跑

## 输出格式 (markdown 片段, 直接拼到 audit 报告 §A)

### §A.1 [简短问题描述]
- **位置**: `<file>:<line>` (具体到行)
- **严重度**: 严重 / 中 / 低
- **根因诊断**: (为什么会出现这个问题, 不要只说"问题是 X")
- **修复建议**: (具体到行级 diff 思路)
- **估时**: 0.5h / 2h / 1d 等
- **依赖**: (修这个会牵动哪些 caller / migration)

(每条独立小节, 用 ### §A.N 序号)

## 限制
- ❌ 严禁修改任何代码
- ❌ 严禁创建除报告外的文件
- ❌ 严禁运行 git 命令
- ✅ 仅 Read / Grep / Glob 扫描
- ✅ 输出 markdown 字符串作为 agent return value

## 输出长度
500-1500 字, 列 5-15 项.
```

(其他 3 个 agent 类似 prompt, 各自关注点不同 — 见 spec §7.1)

- [ ] **Step 2: 真并行调用 4 sub-agent**

```
单条 message 含 4 个 Agent tool call:

1. Agent(subagent_type="oh-my-claudecode:security-reviewer", prompt=<security prompt>)
2. Agent(subagent_type="oh-my-claudecode:architect", prompt=<architect prompt>)
3. Agent(subagent_type="oh-my-claudecode:code-reviewer", prompt=<code-reviewer prompt>)
4. Agent(subagent_type="oh-my-claudecode:explore", prompt=<dead-code prompt>)
```

⚠️ 这是单条 message 4 tool call, **必须并行**. 串行的话工时 ×4.

每个 agent 估算耗时 5-10 分钟, 并行的话总等待 ~10 分钟.

- [ ] **Step 3: 4 份返回值原始存档**

不直接拼, 先各自存到 `docs/superpowers/audits/_raw/`:
- `_raw/2026-05-06-security.md`
- `_raw/2026-05-06-architect.md`
- `_raw/2026-05-06-code-review.md`
- `_raw/2026-05-06-explore.md`

```bash
# 4 个 agent return 后, 用 Write 工具各写一份
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-tech-debt-audit.md \
        docs/superpowers/audits/_raw/ \
        docs/superpowers/specs/_stubs/.gitkeep
git commit -m "audit(p2): 4 sub-agent 真并行扫描完成, 原始输出存档

并行 4 路: security-reviewer / architect / code-reviewer / explore.
原始片段存 audits/_raw/, 待 T3 聚合到主报告.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 聚合到主报告 + 跨类根因分析

**Files:**
- Modify: `docs/superpowers/audits/2026-05-06-tech-debt-audit.md`

- [ ] **Step 1: 读 4 份原始片段, 填入主报告 §A-§D**

```bash
# 读取每份, 把 markdown 片段拼入主报告对应分类节
```

- [ ] **Step 2: 计算总览表数字 (§ 总览)**

数每类的高/中/低 项数, 填入总览表.

- [ ] **Step 3: 排 Top 10**

从 4 类中按严重度+修复 ROI 综合排. 排序逻辑:

1. 严重高 优先 (无视类型)
2. 同严重度内, 修复估时短的优先 (低成本高收益)
3. 安全高 > 架构高 > 风味高 > dead high (类型优先级)

填入 § Top 10 表.

- [ ] **Step 4: 写跨类根因分析 (§ 根因模式分析)**

例:

> 4 类扫描中发现 5 处硬编码 (api_endpoint × 2 / threshold × 2 / file_path × 1).
> **根因不是"程序员忘了"**, 而是项目缺统一 config 体系: 没有 settings.py 或 config.yaml 集中管理.
> 真根因 spec: `_stubs/config-system-stub.md` (修这一处可消解 5 个表象).

这一节是 audit 报告最高价值产出 — 把 N 个表象映射到 K 个根因 (K << N).

- [ ] **Step 5: 跑文档守护测**

写一个简单的报告守护测 `tests/test_audit_report_invariants.py`:

```python
"""守护: 审计报告必须含关键节. 防被未来无意改坏."""
from pathlib import Path
import unittest

REPORT = Path(__file__).parent.parent / "docs/superpowers/audits/2026-05-06-tech-debt-audit.md"


class TestAuditReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = REPORT.read_text(encoding="utf-8")

    def test_report_exists(self):
        self.assertTrue(REPORT.exists())

    def test_has_top10(self):
        self.assertIn("Top 10", self.text)

    def test_has_4_categories(self):
        self.assertIn("§A", self.text)
        self.assertIn("§B", self.text)
        self.assertIn("§C", self.text)
        self.assertIn("§D", self.text)

    def test_has_severity_definitions(self):
        self.assertIn("严重", self.text)
        self.assertIn("中", self.text)

    def test_has_scott_decision_section(self):
        self.assertIn("Scott 决策", self.text)

    def test_has_root_cause_analysis(self):
        """跨类根因分析必须存在."""
        self.assertIn("根因模式分析", self.text)

    def test_no_TBD_in_critical_sections(self):
        """Top 10 表里不能有 TBD."""
        top10_section = self.text.split("Top 10")[1].split("分类细节")[0]
        # 表头有"TBD" 是模板占位; 但 # 1, # 2 等行不许有
        for line in top10_section.split("\n"):
            if line.startswith("| 1 |") or line.startswith("| 2 |"):
                self.assertNotIn("TBD", line, f"Top 10 表行 {line} 仍是占位")
```

跑 → 应当 PASS (T3 已填完)

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-tech-debt-audit.md \
        tests/test_audit_report_invariants.py
git commit -m "audit(p2): 聚合 4 路原始输出 + Top 10 排名 + 跨类根因分析 + 7 守护测

跨类根因映射 N 个表象 → K 根因 是本 audit 最高价值产出.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 生成 spec stubs（每条高/中严重度债 1 份）

**Files:**
- Create: `docs/superpowers/specs/_stubs/<topic>-stub.md` × n 份

- [ ] **Step 1: 数高/中严重度总数**

读报告 § 总览, 算 高+中 = n.

- [ ] **Step 2: 每条生成 stub**

stub 模板:

```markdown
# [STUB] <债名>

> ⚠️ 草稿状态: 由 P2 audit 自动生成, 待 Scott review 决定是否转正式 spec.
> 来源: `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` § <分类>.<编号>
> 严重度: <高/中>
> 估时: <h>

## 问题简述

(从 audit 报告抄过来)

## 根因诊断

(从 audit 报告抄过来)

## 修复方案 (Drafts)

### 方案 A — <名字>
(描述)
- 优势:
- 劣势:
- 估时:

### 方案 B — <名字>
(描述)

(2 方案以上, 留 Scott 选)

## 兜底/回滚

(如何 revert; 影响哪些 caller)

## 转正式 spec checklist

- [ ] Scott 决策"修"
- [ ] 选定方案 (A 或 B)
- [ ] 改 spec 文件名 = `2026-XX-XX-<topic>-design.md`
- [ ] 移到 specs/ 根目录
- [ ] 进入 P4 实施

---

**生成日期**: 2026-05-06
**生成方式**: P2 audit 自动派发
```

- [ ] **Step 3: 文件名规则**

每个 stub 命名: `<short-topic>-stub.md`, 例:
- `csrf-coverage-gap-stub.md`
- `app-py-1500-line-monolith-stub.md`
- `dead-rembg-helper-stub.md`
- `fernet-key-no-rotation-stub.md`

- [ ] **Step 4: 跑守护测扩**

加一条:

```python
def test_stubs_match_high_medium_count(self):
    """高+中 严重度数 == _stubs/ 文件数."""
    text = REPORT.read_text(encoding="utf-8")
    # 简化: 数 "严重: 严重" 和 "严重: 中" 出现次数
    high = text.count("严重度**: 严重")
    medium = text.count("严重度**: 中")
    expected = high + medium

    stubs_dir = Path(__file__).parent.parent / "docs/superpowers/specs/_stubs"
    actual = len(list(stubs_dir.glob("*-stub.md")))

    self.assertEqual(expected, actual,
                     f"报告里 高+中 共 {expected}, 但 _stubs/ 里只有 {actual} 份")
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/_stubs/ tests/test_audit_report_invariants.py
git commit -m "audit(p2): 高/中严重度自动生成 spec stub n 份, 守护测扩 (8 守护)

每 stub 含问题简述 / 根因 / 2 方案 / 兜底, 30 行模板.
Scott review 决定哪些 stub 转正式 spec 进 P4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PR + Scott review

**Files:** 不改代码

- [ ] **Step 1: push feature 分支**

```bash
git checkout -b feat/p2-tech-audit
git push -u origin feat/p2-tech-audit
```

- [ ] **Step 2: 开 PR (5 节 description)**

```bash
gh pr create --title "P2: 技术债中度审计 (audit-only) — Top N 严重度 + n 份 stub" --body "$(cat <<'EOF'
## 背景

per master roadmap (\`docs/superpowers/specs/2026-05-06-master-roadmap-design.md\`) §7. Scott 选定 Q5=B (中度审计 audit-only). 4 sub-agent 真并行扫描全仓库.

## 改动

**0 行业务代码 diff**. 仅产出文档:

1. \`docs/superpowers/audits/2026-05-06-tech-debt-audit.md\` (主报告, ~600 行)
2. \`docs/superpowers/audits/_raw/*.md\` (4 份 sub-agent 原始片段, debug 用)
3. \`docs/superpowers/specs/_stubs/*-stub.md\` (n 份 spec 草稿, 高+中 严重度各一)
4. \`tests/test_audit_report_invariants.py\` (8 守护测)

## 验证

- [x] 全测 \`python -m pytest -q\` → 包括 8 新守护测
- [x] 报告 §A-§D 4 类齐备
- [x] Top 10 表里 0 个 TBD
- [x] _stubs/ 文件数 == 报告高+中 严重度数
- [x] 跨类根因分析存在

## 风险

零业务影响 (audit-only). 风险只在报告本身的判断准确度 - Scott review 时关注 Top 10 的严重度评级是否合理.

## 决策入口

每条 Top 10 旁勾选 ✅ 修 / ❌ 不修 / ⏰ 延后, 进入下一阶段 P4 实施队列.

## 回滚

\`\`\`
git revert <merge-commit>
\`\`\`

(实际不太需要回滚 - 只是文档)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: STOP — 等 Scott review**

Scott 在 PR description 决策栏勾选每条 Top 10 → 进入 P4 队列.

---

## 完成标准

- [ ] T1-T5 全过
- [ ] `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` 存在, 含 Top 10 / §A-§D / 跨类根因 / 决策栏
- [ ] `_raw/*.md` 4 份原始片段存档
- [ ] `_stubs/*-stub.md` ≥ 高+中严重度数
- [ ] 8 守护测全过
- [ ] PR 已开, Scott review 决策栏勾选完毕
- [ ] 0 行业务代码改动 (audit-only 承诺)

## 风险与回滚

| 风险 | 触发概率 | 应对 |
|---|---|---|
| 4 sub-agent 中某个失败 / 超时 | 25% | 在 T2 step 4 检测; 失败的单独重跑 (不重跑成功的); 实在不行降级该类为 "本次未审计" 留 follow-up |
| sub-agent 输出质量参差 (有的非常详细, 有的敷衍) | 50% | T3 聚合时人审一遍; 敷衍的写 prompt 重跑 |
| 报告爆出 >20 项严重度 ≥ 高 | 30% | spec §13 已说明: Scott 决定升级到 Q2 档 C, 或者跳 P4 直奔 P5 |
| Scott review 决策栏勾选困难 (太多项不知道选哪) | 40% | 报告里多写"修复 ROI" 一列帮决策; 实在选不动就只挑前 5 修 |
| 守护测的 grep 模式跟报告实际格式对不上 | 20% | T3 step 5 / T4 step 4 现场调整 (不是真 bug, 是模板与实例不一致) |

**回滚:** `git revert <PR-merge-commit>`. 0 业务影响. 报告作废, 想再做就再开一份 P2 v2.

---

**Plan 起草日期**: 2026-05-06
**作者**: Claude Opus 4.7
**对应 Spec**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §7
**预计工时**: 1-2 day (T2 真并行 ~10 min + T3-T4 聚合 ~3-4h + Scott review 时间)
