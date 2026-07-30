# P1 — D4 Agent 自主性约定文档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Scott 选定的"档 2 PR 模式"写成 `.claude/AUTONOMY.md` 元规则文档，定义 agent 自动允许 / 仍要授权 / 升降档触发条件，并同步更新现有 memory 与 CLAUDE.md 索引。

**Architecture:** 单一新增文档 + 双锚点同步（CLAUDE.md 引用 + memory 标注）。无代码改动，无测试改动。Scott 合并 PR 后规则即生效。

**Tech Stack:** Markdown · Git · CLAUDE.md 协作约定

**前置 Spec:** `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §6

**前置代码引用（必读）:**
- `CLAUDE.md` — 现有项目协作约定（要加 AUTONOMY.md 索引）
- 既有 memory `feedback_deploy_skill_push_authorization.md` — 现行 push/deploy 铁律（要标注 D4 部分放松）
- v3.3 spec/plan 模板 — 文档风格参考

**工程原则（贯穿全 task）:**
1. 反硬编码 — 升降档阈值数字（≥80% / ≤50%）写进 AUTONOMY.md 而非散落各处
2. 根本性修复 — 解决"agent 自主性 vs 安全 gate"的根本冲突，不打补丁式各种 case-by-case 例外
3. PR-as-deliverable — 本 plan 的 PR 本身就是档 2 模式的第一次实践
4. 写后必验 — 文档写完后 grep 自身校验关键约束在 (push 不许 main / merge 要授权 / 等)

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `.claude/AUTONOMY.md` | **创建** (~120 行) | 档 2 PR 模式定义 + 自动允许 / 要授权矩阵 + 自审 checklist + 升降档触发 |
| `CLAUDE.md` | **修改** (+5 行) | "Claude Code 配置说明" 节加 AUTONOMY.md 索引 |
| `~/.claude/projects/.../memory/feedback_deploy_skill_push_authorization.md` | **修改** (+10 行) | 加"被 D4 部分放松 (push 到 feature branch 自动 OK)"声明 |
| `tests/test_autonomy_doc_invariants.py` | **创建** (~40 行) | 文档守护测：grep AUTONOMY.md 关键约束在；CLAUDE.md 真引用了 |

---

## 执行顺序与依赖

```
T1 (写 AUTONOMY.md 全文 + 守护测红)
  ↓
T2 (跑守护测 PASS → commit)
  ↓
T3 (改 CLAUDE.md 加索引 + 守护测扩 → commit)
  ↓
T4 (改 memory 标注被部分放松 → commit, 不进 git, 单独保存)
  ↓
T5 (push feat/p1-autonomy 分支 + 开 PR)
```

---

## Task 1: 写 AUTONOMY.md + 失败的守护测

**Files:**
- Create: `.claude/AUTONOMY.md`
- Create: `tests/test_autonomy_doc_invariants.py`

- [ ] **Step 1: 先写守护测（TDD 先红）**

```python
# tests/test_autonomy_doc_invariants.py
"""文档守护: AUTONOMY.md 关键约束必须存在, 防被未来无意改坏."""
from pathlib import Path
import unittest


AUTONOMY_PATH = Path(__file__).parent.parent / ".claude" / "AUTONOMY.md"


class TestAutonomyDocInvariants(unittest.TestCase):
    """文档级守护."""

    @classmethod
    def setUpClass(cls):
        cls.text = AUTONOMY_PATH.read_text(encoding="utf-8")

    def test_file_exists(self):
        self.assertTrue(AUTONOMY_PATH.exists(), f"{AUTONOMY_PATH} 不存在")

    def test_states_pr_mode(self):
        """声明档 2 PR 模式是当前选定档位."""
        self.assertIn("档 2", self.text)
        self.assertIn("PR 模式", self.text)

    def test_forbids_push_to_main(self):
        """禁止 push 到 main."""
        self.assertRegex(self.text, r"(禁止|不得|never|do not).{0,20}push.{0,20}main", )

    def test_requires_authorization_for_merge(self):
        """merge PR 要授权."""
        self.assertIn("merge PR", self.text)
        self.assertIn("授权", self.text)

    def test_requires_authorization_for_deploy(self):
        """deploy 要授权."""
        self.assertIn("deploy", self.text)

    def test_requires_authorization_for_money(self):
        """花钱要授权."""
        self.assertIn("花钱", self.text)

    def test_lists_self_review_checklist(self):
        """自审 checklist 必须列出 全测 / smoke / PR description."""
        self.assertIn("pytest", self.text)
        self.assertIn("smoke", self.text)
        self.assertIn("PR description", self.text)

    def test_defines_upgrade_downgrade_triggers(self):
        """升降档触发条件必须有数值阈值."""
        # 80%, 50% 等数字至少出现一次, 不许只是模糊 "若干次"
        self.assertRegex(self.text, r"\d+\s*%")
```

- [ ] **Step 2: 跑测验证 FAIL**

```bash
python -m pytest tests/test_autonomy_doc_invariants.py -v 2>&1 | tail -10
```
Expected: FileNotFoundError → 8 fails (因为 AUTONOMY.md 还没写)

- [ ] **Step 3: 写 AUTONOMY.md 全文**

```bash
mkdir -p .claude
```

文件内容（写入 `.claude/AUTONOMY.md`）:

```markdown
# Agent 自主性约定 v1

> 档位选定: **档 2 — PR 模式** (Scott 决策于 2026-05-06)
> 上级文档: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §6
> 升降档历史: 档 0 (~2026-05-06) → 档 2 (2026-05-06)

---

## 档位定义

档 2 = "PR 模式" — agent 自动 push 到 feature branch 并开 PR; Scott merge PR 等于交付被接收.

设计哲学: **PR 是最终交付物的事实标准**. Scott 看 PR description + diff + CI 状态做合并决定, 比 "实时确认每一步" 高效 10 倍.

---

## 自动允许 (无需 Scott 在场)

- 编辑 / 读 / 写本仓库代码 (除以下 deny: `.env` / `instance/` / `crypto_utils.py`)
- 跑 pytest, 跑 `/smoke` skill, 起本机 server
- 调任何 MCP / skill / sub-agent
- `git add` / `git commit`
- `git push` 到 **feature 分支** (`feat/*` / `fix/*` / `docs/*` / `chore/*`)
- `gh pr create` 开 PR (含完整 description)
- 写 memory 文件 (在用户 home 下, 不进项目 git)

## 仍要 Scott 显式授权 (stop and ask)

| 动作 | 为什么 stop | Scott 授权方式 |
|------|-----------|--------------|
| `gh pr merge` 或 GitHub UI 合 PR 到 main | 影响 main 历史, 不可低成本回滚 | 「merge」/「合 PR #N」 |
| `git push --force` (任何分支) | 改写历史, 可能丢工作 | 「force push」 |
| `git push origin main` (直接 push main) | 跳过 PR review | 「push main」(应当极少触发) |
| 部署到腾讯云 / 任何 prod 环境 | 影响线上服务 | 「deploy」/「上线」 |
| 真金真银花钱 (gpt-image-2 真跑 / ai-refine 真跑 / Seedream 等) | 不可逆扣费 | 「真测」/「跑一单」 |
| 改 prod DB 数据 (含密码 / 迁移 / 删除) | 影响真实数据 | 「go prod 改密」/「prod 迁移」 |
| 改 `.env` / fernet key / 任何秘密 | 安全敏感 | 「改 env」 |

---

## PR 自审 checklist (push 前必做)

每次 `gh pr create` 前 agent 必须自跑:

- [ ] `python -m pytest -q` → 0 failed (与基线对比, 不许回归)
- [ ] `/smoke` skill → 全过
- [ ] 改了 `templates/`? 跑 `/regen-thumbs` 验证渲染
- [ ] 改了 AI 生图 / 合成 / 路由? 跑 `tests/e2e_*` 中相关 e2e 测
- [ ] PR description 含 5 节: 背景 / 改动 / 验证 / 风险 / 回滚
- [ ] 跟 spec 关联? Body 引用 `docs/superpowers/specs/<file>.md` 路径

不达 5 项任何一项 → 不许 push, 修复后重跑.

---

## 升降档触发条件

### 升档 3 (高度自主, 自动合 main + 自动 deploy)

触发条件: **连续 10 个 PR 自审通过率 ≥ 80%** 且 **Scott 在 review 时 0 大改 (定义: ≤2 行 diff 修正)**

升档由 Scott 显式说 "升档 3"; agent 不主动建议升档.

### 降档 1 (轻度自主, 不开 PR 仅 push feature 分支)

自动触发: **连续 3 个 PR 含逻辑 bug 或测试遗漏 (Scott 显示打回)** → agent 自动降档, 通知 Scott "已降档 1, 请评估".

可由 Scott 命令 "降档 1" 强制降.

### 降档 0 (现状, 保守)

自动触发: **任意一次违规 push main / 误花钱 / 改 prod 未授权** → 立即降档 0, 等待 Scott 决策.

---

## 跟既有 memory 的关系

本文档**部分放松**以下 memory 铁律:

- `feedback_deploy_skill_push_authorization.md` — push 到 feature 分支不再问 (但 push to main 仍触发铁律)
- `feedback_write_then_verify.md` — 不动, 全档位都守

本文档**强化**以下原则:

- spec §3 #5 写后必验 — 进入自审 checklist 第 1 项 (`pytest` 验证)
- spec §3 #3 PR-as-deliverable — 本文档**就是**这条原则的实现细则

---

**版本**: v1.0
**生效日期**: 2026-05-06
**审核人**: Scott (本仓库 owner)
**起草人**: Claude Opus 4.7 (per spec §6 brainstorm + Q3=2)
```

- [ ] **Step 4: 跑守护测验证 PASS**

```bash
python -m pytest tests/test_autonomy_doc_invariants.py -v 2>&1 | tail -10
```
Expected: 8 passed

- [ ] **Step 5: 跑全测确认无回归**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 252+ passed (P0 base 252 + 8 守护 = 260 多)

- [ ] **Step 6: Commit**

```bash
git add .claude/AUTONOMY.md tests/test_autonomy_doc_invariants.py
git commit -m "docs(autonomy): 加 .claude/AUTONOMY.md 档 2 PR 模式约定 + 8 守护测

per master roadmap §6 (Q3=2). 定义自动允许 / 要授权 / 自审 checklist / 升降档触发.
守护测确保关键约束 (push not to main, merge 要授权, 5 节 PR description, 升降档数值阈值)
不会被未来无意改坏.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: CLAUDE.md 加 AUTONOMY.md 索引

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 扩 守护测覆盖 CLAUDE.md 引用**

在 `tests/test_autonomy_doc_invariants.py` 末尾加:

```python
class TestClaudeMdReferencesAutonomy(unittest.TestCase):
    """CLAUDE.md 必须显式引用 AUTONOMY.md, 否则新 agent 不会发现这文档."""

    def test_claude_md_links_autonomy(self):
        claude_md = Path(__file__).parent.parent / "CLAUDE.md"
        text = claude_md.read_text(encoding="utf-8")
        self.assertIn(".claude/AUTONOMY.md", text,
                      "CLAUDE.md 没引用 AUTONOMY.md, 新 agent 找不到自主性约定")
```

跑 → FAIL.

- [ ] **Step 2: 改 CLAUDE.md**

在 "## Claude Code 配置说明" 节，原来写到「### settings.json 关键约束」之前的位置插入新小节：

```markdown
### Agent 自主性约定（档 2 PR 模式）

详见 `.claude/AUTONOMY.md`（2026-05-06 由 master roadmap §6 定义）。

简版规则：
- **自动 OK**：编辑/测试/commit/push feature 分支/开 PR
- **stop and ask**：merge PR、deploy、花钱、动 prod
- **PR 自审 checklist**：全测、smoke、PR description 5 节齐备
```

- [ ] **Step 3: 跑测 PASS**

```bash
python -m pytest tests/test_autonomy_doc_invariants.py -v 2>&1 | tail -5
```
Expected: 9 passed (8 + 1 新增)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md tests/test_autonomy_doc_invariants.py
git commit -m "docs(autonomy): CLAUDE.md 加 AUTONOMY.md 索引节 + 守护测

让新 agent / 新 session 能从 CLAUDE.md (auto-loaded) 一跳找到自主性约定.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 同步更新 memory feedback_deploy_skill_push_authorization

**Files:**
- Modify: `~/.claude/projects/C--Users-28293-clean-industry-ai-assistant/memory/feedback_deploy_skill_push_authorization.md`

- [ ] **Step 1: 在文档头部加 D4 部分放松声明**

```markdown
> **2026-05-06 D4 部分放松**:
> 本铁律的 "push 类操作" 边界被 master roadmap §6 (`docs/superpowers/specs/2026-05-06-master-roadmap-design.md`) 重新划分:
>
> - **push 到 feature 分支** (`feat/*` / `fix/*` / `docs/*` 等) — 不再问, 自动 OK
> - **push 到 main** / **`--force` 任何分支** — 仍触发本铁律, 必须 Scott 显式授权
> - **`/deploy` skill 调用** — 仍触发本铁律, 必须 Scott 显式说 "deploy"
>
> 详见 `.claude/AUTONOMY.md` 的 "仍要 Scott 显式授权" 表.
```

- [ ] **Step 2: 不进 git** (memory 在 user home, 跨项目共享, 跟项目 git 解耦)

- [ ] **Step 3: 验证**

```bash
grep -c "D4 部分放松" ~/.claude/projects/C--Users-28293-clean-industry-ai-assistant/memory/feedback_deploy_skill_push_authorization.md
```
Expected: ≥1

- [ ] **Step 4: 不需要 commit** (跟项目 git 无关)

---

## Task 4: PR 开 + 等 Scott merge

**Files:** 不改代码

- [ ] **Step 1: push 到 feature 分支**

```bash
git checkout -b feat/p1-autonomy
git push -u origin feat/p1-autonomy
```

- [ ] **Step 2: 开 PR**

```bash
gh pr create --title "P1: Agent 自主性约定 (档 2 PR 模式)" --body "$(cat <<'EOF'
## 背景

per master roadmap (\`docs/superpowers/specs/2026-05-06-master-roadmap-design.md\`) §6, Scott 在 brainstorm Q3 选定档 2 PR 模式. 需要把这一约定从对话沉淀成 \`.claude/AUTONOMY.md\` 元规则文档, 让所有未来 session / 新 agent 都按统一规则跑.

## 改动

1. \`.claude/AUTONOMY.md\` (新, 120 行) — 档位定义 / 自动允许 / 要授权矩阵 / PR 自审 checklist / 升降档触发
2. \`CLAUDE.md\` (+5 行) — 加索引节, 让 auto-loaded 协作约定能跳到 AUTONOMY
3. \`tests/test_autonomy_doc_invariants.py\` (新, 9 测) — 文档守护, 防关键约束被未来无意改坏

memory \`feedback_deploy_skill_push_authorization.md\` 已在用户 home 同步标注 (跨项目共享 memory, 不进本仓库 git).

## 验证

- [x] 全测 \`python -m pytest -q\` → 261 passed (基线 252 + 9 新增)
- [x] 9 守护测覆盖: 档 2 PR 模式 / 禁 push main / merge 要授权 / deploy 要授权 / 花钱要授权 / 自审 checklist / 升降档数值阈值 / CLAUDE.md 索引
- [x] 文件 \`.claude/AUTONOMY.md\` grep 关键短语全部出现

## 风险

零代码改动, 零业务影响. 风险只在文档措辞 — 等本 PR review 时 Scott 校对.

## 回滚

\`\`\`
git revert <merge-commit>
\`\`\`

回滚后回到档 0 (现状), 所有 push/merge/deploy 都需 Scott 显式授权.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: STOP — 等 Scott merge**

merge 后档 2 即生效.

---

## 完成标准

- [ ] T1-T4 全过
- [ ] `.claude/AUTONOMY.md` 存在, ~120 行, 含 8 节 (档位定义/自动允许/要授权/自审/升降档/memory 关系/版本)
- [ ] `CLAUDE.md` grep 到 `.claude/AUTONOMY.md` 链接
- [ ] memory `feedback_deploy_skill_push_authorization.md` 含 "D4 部分放松" 字样
- [ ] 全测 ≥ 261 passed (基线 252 + 9 新守护)
- [ ] PR feat/p1-autonomy 已开, 等 merge
- [ ] PR merge 后档 2 立即生效, 后续所有 plan 实施 (P2/P3/P5.0) 按档 2 跑

## 风险与回滚

| 风险 | 触发概率 | 应对 |
|---|---|---|
| 守护测的 grep 模式过严, 文档稍调措辞就 fail | 30% | 模式用 `assertRegex` 留一点容错; 必要时 task 1 step 1 微调 |
| Scott review 时对升降档阈值有异议 | 40% | 当 plan 中事; review 反馈直接改 AUTONOMY.md push 更新, 守护测也跟着扩 |
| 跟既有 settings.json 的 deny rule 冲突 (如果未来加了 push deny) | 5% | settings.json deny 优先; AUTONOMY.md 是软约定, hook 是硬执行, 冲突时 hook 赢 |

**回滚:** `git revert <PR-merge-commit>`. 影响零业务代码.

---

**Plan 起草日期**: 2026-05-06
**作者**: Claude Opus 4.7
**对应 Spec**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §6
**预计工时**: 30 分钟（不含 Scott review 时间）
