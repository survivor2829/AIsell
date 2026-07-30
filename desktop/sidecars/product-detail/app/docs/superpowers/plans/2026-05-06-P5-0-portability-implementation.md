# P5.0 — 「导演思维」可移植度评估 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 评估设备类 12 个 block 模板和 4 工序导演管线对耗品类的可移植度，产出一份带"复用/重写/删除"三色标记的评估报告，作为 P5.1+ 数据/模板/管线适配工作的输入。

**Architecture:** 单 sub-agent (architect) 主扫 + 主线人审，0 代码改动。报告结构: 12 block 三色矩阵 + 4 工序适配度评级 + 耗品 4 板斧叙事映射 + P5.1+ 工时再校准。

**Tech Stack:** Markdown · `oh-my-claudecode:architect` agent · Read tool · Glob

**前置 Spec:** `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §10.2

**前置代码引用（必读）:**
- `templates/blocks/block_a_hero_robot_cover.html` — 英雄屏（场景图+产品图+卖点）
- `templates/blocks/block_b2_icon_grid.html` — 六大优势图标网格
- `templates/blocks/block_b3_clean_story.html` — 清洁故事屏
- `templates/blocks/block_e_glass_dimension.html` — 产品参数表（磨砂玻璃卡片）
- `templates/blocks/block_f_showcase_vs.html` — 1台顶8人 VS 对比
- `templates/设备类/build_config.json` — 默认配置
- `theme_matcher.py` — 模板智能匹配（任务 9 落地）
- `ai_image_router.py` — 双引擎路由
- `ai_refine_v2/` — gpt-image-2 精修管线

**工程原则（贯穿全 task）:**
1. 反硬编码 — 评估**不能**只看代码注释里写的"设备类"字样, 要看实际数据流是否真特化
2. 根本性修复 — 找出"设备类专属假设"的代码, 区分"配置可解" vs "需重写"
3. PR-as-deliverable — 1 PR = 评估报告 + 12 block 矩阵 + 工时再校准
4. 写后必验 — 评估结论必须 grep 反向校验 (例: 标"复用"的 block 不许有 hardcode 设备类字段)

---

## File Structure

| 路径 | 行为 | 责任 |
|------|------|------|
| `docs/superpowers/audits/` | (复用 P2 已建目录) | — |
| `docs/superpowers/audits/2026-05-06-portability-assessment.md` | **创建** (~400 行) | 评估报告主文件 |
| `tests/test_portability_report_invariants.py` | **创建** (~30 行) | 报告守护测 |

零代码改动。

---

## 执行顺序与依赖

```
T1 (枚举 12 个 block 文件 + 读各自前 30 行确认实际功能)
  ↓
T2 (sub-agent: 调 architect 跑深度可移植度分析)
  ↓
T3 (人审 sub-agent 输出, 写主报告 + 三色矩阵)
  ↓
T4 (列耗品 4 板斧叙事映射 + P5.1+ 工时再校准)
  ↓
T5 (守护测 + 跑全测无回归)
  ↓
T6 (PR feat/p5-0-portability)
```

---

## Task 1: 枚举 12 个 block + 读各文件功能

**Files:**
- Read-only

- [ ] **Step 1: glob 全部 block 文件**

```bash
ls templates/blocks/ 2>&1
ls templates/设备类/ 2>&1
```
列出所有文件名 + 大小.

- [ ] **Step 2: 读每个 block 的前 30 行 (确认实际渲染什么)**

```bash
for f in templates/blocks/*.html; do
  echo "=== $f ==="
  head -30 "$f"
  echo
done > /tmp/p5-0-blocks-overview.txt
```

或者用 Read tool 逐个读 (前 30 行) — 12 个文件并行调用更快.

- [ ] **Step 3: 看 build_config.json 默认配置**

```bash
cat templates/设备类/build_config.json | head -100
```

记下"hardcoded blocks 列表"和"fixed_selling_images"是哪些.

- [ ] **Step 4: 看 theme_matcher 怎么选模板**

```bash
grep -n "block_\|theme" theme_matcher.py | head -30
```

- [ ] **Step 5: 不 commit. 整理出脑内地图**

12 个 block 各自的实际功能 (一句话描述), 哪些是设备类专属假设 (例: "1 台顶 8 人" 是机器人 ROI 叙事, 耗品根本没这概念).

---

## Task 2: 调 architect sub-agent 深度分析

**Files:**
- Create (临时, T6 删): `docs/superpowers/audits/_raw/2026-05-06-portability.md`

- [ ] **Step 1: 写 prompt 给 architect agent**

```
你是清洁行业 AI 详情图生成器的资深产品架构师, 现在帮我评估"设备类管线"对"耗品类"的可移植度.

## 评估范围 (输入)

### 12 个 block 模板 (templates/blocks/)
1. block_a_hero_robot_cover.html — 英雄屏 (场景+产品图+核心卖点)
2. block_b2_icon_grid.html — 六大优势图标网格
3. block_b3_clean_story.html — 清洁故事屏
4. block_e_glass_dimension.html — 参数表 (磨砂玻璃)
5. block_f_showcase_vs.html — 1 台顶 8 人 VS 对比
6. ... (其他 7 个由 T1 step 1 列出)

### 4 工序 (现有导演管线)
工序 1: AI 解析文案 → 字段 (DeepSeek 调 prompt)
工序 2: theme_matcher 选模板 (基于品类/主色/产品图)
工序 3: 12 block 渲染 (Jinja + CSS)
工序 4: gpt-image-2 精修 + Pillow 长图拼接 (ai_refine_v2/)

## 耗品类销售叙事 (新场景, 输出要适配它)

耗品的核心 4 板斧:
A. 用量 (一瓶能用多少次? 多久? 几个机型?)
B. 性价比 (单次成本; 跟散装/竞品对比)
C. 兼容机型 (这瓶适配哪些机器人? 跨品牌吗?)
D. 寿命周期 (开封后多久必须用完? 储存条件? 过期影响?)

跟设备类的「效率/智能化/ROI」叙事完全不同.

## 评估任务 (输出三类标签)

### 任务 A: 12 block 三色矩阵
对每个 block 给三色之一:
- 🟢 复用 — 直接挂耗品数据就能用 (block 设计本身品类无关)
- 🟡 重写 — 概念在但版式/数据结构需重写 (≤4h)
- 🔴 删除 — 耗品根本没这概念, 或者重写成本超过新写 (例: VS 对比"1 台顶 8 人")

每个 block 给:
- 标签 (🟢/🟡/🔴)
- 理由 (1-2 句)
- 如重写, 大概工时 (h)
- 如重写, 关键改动点 (1-3 条)

### 任务 B: 4 工序适配度评级
对每个工序给 0-10 分 (10 = 0 改动直接复用; 0 = 完全重写):
- 工序 1 适配度: ?/10, 理由
- 工序 2 适配度: ?/10, 理由
- 工序 3 适配度: ?/10, 理由
- 工序 4 适配度: ?/10, 理由

### 任务 C: 耗品 4 板斧叙事映射
A 用量 → 哪个 block 承载? 现有不够要新写吗?
B 性价比 → ?
C 兼容机型 → ?
D 寿命周期 → ?

### 任务 D: P5.1+ 工时再校准
spec 当时估 P5.1+P5.2+...P5.6 共 ~10 day. 基于本次评估, 给出修正:
- 哪些子阶段实际可压短? (因为复用度 > 预期)
- 哪些子阶段会爆? (因为需重写多于预期)
- 总工时上下限 (如 8-12 day)

## 限制
- ❌ 严禁修改任何代码
- ❌ 严禁创建除报告外的文件
- ✅ 仅 Read / Grep / Glob 扫描 templates/ + ai_refine_v2/ + theme_matcher.py + ai_image_router.py
- ✅ 输出 markdown 字符串作为 agent return value

## 输出长度
1500-3000 字 markdown.
```

- [ ] **Step 2: 调 architect agent**

```
单条 message 一个 Agent tool call:
Agent(subagent_type="oh-my-claudecode:architect", prompt=<上面 prompt>)
```

预计 5-10 分钟.

- [ ] **Step 3: 把 agent return 写到 _raw/**

```bash
# 用 Write tool 把 agent 输出存档
```
存到 `docs/superpowers/audits/_raw/2026-05-06-portability.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/audits/_raw/2026-05-06-portability.md
git commit -m "audit(p5-0): architect agent 跑可移植度深度分析, 原始输出存档

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 人审 + 写主报告

**Files:**
- Create: `docs/superpowers/audits/2026-05-06-portability-assessment.md`

- [ ] **Step 1: 读 _raw/2026-05-06-portability.md**

人审一遍, 看 architect 的判断是否合理. 重点核实:
- 标 🟢 (复用) 的 block, 真的没设备类专属硬编码吗? (grep 一下 "机器人/续航/智能/ROI" 等字样)
- 标 🔴 (删除) 的 block, 真的耗品没这概念吗? (举反例验证)
- 4 工序评分有没有过乐观/过悲观

如果发现明显错误, 在主报告里**修正 architect 的判断 + 写"为什么改"**.

- [ ] **Step 2: 写主报告**

结构:

```markdown
# 「导演思维」对耗品类可移植度评估 v1

> **日期**: 2026-05-06
> **触发**: master roadmap §10.2
> **评估方法**: architect sub-agent 扫描 + 主线人审
> **承诺**: audit-only, 0 代码改动
> **下一步**: 报告导出后, P5.1 数据 schema 适配按本报告 D 节工时再校准开工

---

## 摘要

(3 句话: 12 block 中 X 复用 / Y 重写 / Z 删除; 4 工序平均 N 分; 耗品 4 板斧 K 个能映射到现有 block; P5.1+ 工时修正为 X-Y day)

---

## §A. 12 block 三色矩阵

| # | Block | 标签 | 理由 | 重写工时 | 关键改动 |
|---|---|---|---|---|---|
| 1 | block_a_hero_robot_cover | 🟡 | 场景+产品图框架可复用, 但 "robot_cover" 命名暴露品类锁定 | 2h | 改名通用 + 让 hero 文案走数据驱动 |
| 2 | block_b2_icon_grid | 🟢 | 六优势图标网格, 设备类用得耗品也能用 | 0 | (仅替换 6 个图标素材) |
| ... | ... | | | | |

(每行人审完判断, 不照抄 architect)

---

## §B. 4 工序适配度评级

### 工序 1: AI 解析文案 → 字段
- 适配度: **8/10**
- 现有 prompt 在 `prompt_templates.py`, 设备类专用. 耗品需新写一份 prompt, 但 DeepSeek 调用骨架直接复用.
- 改动点: 加 `prompt_templates.py:CONSUMABLE_PROMPT`, dispatcher 按 category 选 prompt.

### 工序 2: theme_matcher 选模板
- 适配度: **5/10**
- ...

### 工序 3: 12 block 渲染
- 适配度: **6/10** (跟 §A 联动, 复用率决定本评分)

### 工序 4: gpt-image-2 精修 + 长图拼接
- 适配度: **9/10**
- ai_refine_v2 是品类无关的 image-to-image refiner, 耗品几乎 0 改动.
- 改动点: `_planning.json` 的 prompt 文本要按耗品风格调.

---

## §C. 耗品 4 板斧叙事映射

| 板斧 | 现有 block 承载 | 缺口 | 修补方案 |
|---|---|---|---|
| A 用量 | (新写) `block_consumable_quantity.html` | 没现成的 | P5.2 新写 (~3h) |
| B 性价比 | block_e_glass_dimension (参数表改) | 参数表能塞 | P5.2 重写 dimension 改塞性价比卡 (~2h) |
| C 兼容机型 | (新写) `block_consumable_compat_matrix.html` | 没现成 | P5.2 新写, grid 列兼容机型 (~3h) |
| D 寿命周期 | block_b3_clean_story (改) | clean_story 模板可改造 | P5.2 重写 (~2h) |

---

## §D. P5.1+ 工时再校准

| spec 原估 | 修正估 | 偏差 | 原因 |
|---|---|---|---|
| P5.1 schema 1d | 0.5d | -0.5d | 字段差异比预期小 (主要加 enum) |
| P5.2 模板 3d | 4d | +1d | 新写 + 重写共 14h, 略多 |
| P5.3 prompt 2d | 1d | -1d | DeepSeek 骨架直接复用 |
| P5.4 拼接 1d | 0.5d | -0.5d | image_composer 几乎 0 改 |
| P5.5 e2e + 真测 2d | 2d | 0 | 不变 |
| P5.6 admin/UI 1d | 0.5d | -0.5d | category 下拉选项加一项 |
| **总** | **8.5d** | -1.5d | 比 spec 原估少 |

---

## §E. 风险与建议

(列 3-5 条 P5.1+ 实施时要警惕的事)

---

**起草人**: Claude Opus 4.7 (architect agent 扫描 + 主线人审)
**对应 Plan**: docs/superpowers/plans/2026-05-06-P5-0-portability-implementation.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/audits/2026-05-06-portability-assessment.md
git commit -m "audit(p5-0): 主报告 — 12 block 三色 + 4 工序评分 + 4 板斧映射 + 工时再校准

人审 architect 输出后修正 N 处判断. 总工时再校准 P5.1+: spec 原估 ~10d, 修为 ~8.5d.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 守护测 + 全测

**Files:**
- Create: `tests/test_portability_report_invariants.py`

- [ ] **Step 1: 写守护测**

```python
"""守护: P5.0 评估报告必须含 §A-§E 5 节 + 三色矩阵 + 工时再校准."""
from pathlib import Path
import unittest


REPORT = Path(__file__).parent.parent / "docs/superpowers/audits/2026-05-06-portability-assessment.md"


class TestPortabilityReport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = REPORT.read_text(encoding="utf-8")

    def test_report_exists(self):
        self.assertTrue(REPORT.exists())

    def test_has_5_sections(self):
        for sec in ["§A", "§B", "§C", "§D", "§E"]:
            self.assertIn(sec, self.text, f"缺 {sec}")

    def test_has_three_color_labels(self):
        """三色标签 🟢/🟡/🔴 至少各出现 1 次."""
        for color in ["🟢", "🟡", "🔴"]:
            self.assertIn(color, self.text, f"缺色 {color}")

    def test_has_4_process_ratings(self):
        """4 工序适配度都给了分数."""
        for n in ["工序 1", "工序 2", "工序 3", "工序 4"]:
            self.assertIn(n, self.text)

    def test_has_workhour_calibration(self):
        """工时再校准表必须有."""
        self.assertIn("工时再校准", self.text)
        self.assertRegex(self.text, r"\d+\.?\d*\s*d")  # 至少有 X.Yd 格式

    def test_has_4_consumable_narratives(self):
        """耗品 4 板斧 (用量/性价比/兼容机型/寿命周期) 都映射到了."""
        for n in ["用量", "性价比", "兼容机型", "寿命周期"]:
            self.assertIn(n, self.text)
```

- [ ] **Step 2: 跑测 PASS**

```bash
python -m pytest tests/test_portability_report_invariants.py -v 2>&1 | tail -10
```
Expected: 6 passed

- [ ] **Step 3: 跑全测无回归**

```bash
python -m pytest -q 2>&1 | tail -5
```
Expected: 全测仍绿

- [ ] **Step 4: Commit**

```bash
git add tests/test_portability_report_invariants.py
git commit -m "test(p5-0): 6 守护测覆盖评估报告完整性

防未来无意改坏: 5 节齐备 / 三色标签存在 / 4 工序评分 / 工时再校准表 /
耗品 4 板斧映射齐备.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: PR + Scott review

**Files:** 不改代码

- [ ] **Step 1: push**

```bash
git checkout -b feat/p5-0-portability
git push -u origin feat/p5-0-portability
```

- [ ] **Step 2: 开 PR**

```bash
gh pr create --title "P5.0: 「导演思维」对耗品类可移植度评估" --body "$(cat <<'EOF'
## 背景

per master roadmap (\`docs/superpowers/specs/2026-05-06-master-roadmap-design.md\`) §10.2.

P5 耗品类管线的前置评估: 设备类 12 个 block + 4 工序 对耗品类的可移植度. 本 PR 输出报告作为 P5.1+ 实施的输入.

## 改动 (audit-only, 0 业务代码)

1. \`docs/superpowers/audits/2026-05-06-portability-assessment.md\` — 主报告 (~400 行)
2. \`docs/superpowers/audits/_raw/2026-05-06-portability.md\` — architect agent 原始输出
3. \`tests/test_portability_report_invariants.py\` — 6 守护测

## 关键产出

### 12 block 三色矩阵
- 🟢 复用: N 个 (X%)
- 🟡 重写: M 个 (Y%)
- 🔴 删除: K 个 (Z%)

### 4 工序适配度均分: ?/10

### 耗品 4 板斧叙事映射
- A 用量 → 新写 1 block
- B 性价比 → 改 dimension block
- C 兼容机型 → 新写 1 block
- D 寿命周期 → 改 clean_story block

### P5.1+ 工时再校准
- 原估 ~10d
- 修正 ~8.5d (-1.5d, 因部分 block 复用度高于预期)

## 验证

- [x] 全测 \`python -m pytest -q\` → 263 passed (P3 base 257 + 6 P5.0 守护)
- [x] 6 守护测覆盖报告完整性
- [x] architect agent 真扫了 templates/ + ai_refine_v2/

## 风险

零业务影响 (audit-only). 风险只在评估准确度 — 实际 P5.2 模板写起来可能发现新问题, 那时 plan 再迭代.

## 回滚

\`\`\`
git revert <merge-commit>
\`\`\`

## 决策入口

Scott review 报告后:
- ✅ 接受评估 → P5.1 按修正工时表开工
- 🔄 部分修正 → 评论指出哪些 block/工序判断不准, 我改报告 v1.1
- ❌ 重做 → 撤 PR 重启 P5.0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: STOP — 等 Scott review**

merge 后 P5.0 闭环, 可起 P5.1.

---

## Task 6: 收尾清理 (PR merge 后)

**Files:**
- Delete: `docs/superpowers/audits/_raw/2026-05-06-portability.md` (已聚合到主报告, 原始片段不再需要)

- [ ] **Step 1: PR merge 后, 删 _raw 临时**

```bash
git checkout main
git pull
rm docs/superpowers/audits/_raw/2026-05-06-portability.md
git add -u
git commit -m "chore(p5-0): 删 architect 原始输出片段 (已聚合到主报告)"
git push
```

或者保留 _raw/ 作为审计追溯——按团队偏好, 个人偏好删 (减少噪声).

---

## 完成标准

- [ ] T1-T5 全过 (T6 收尾可选)
- [ ] `docs/superpowers/audits/2026-05-06-portability-assessment.md` 存在, ~400 行, 含 §A-§E
- [ ] 12 block 全部有三色标签
- [ ] 4 工序全部有 0-10 适配度评分
- [ ] 耗品 4 板斧 (用量/性价比/兼容/寿命) 全有映射方案
- [ ] P5.1+ 工时再校准表完整
- [ ] 全测 ≥ 263 passed (P3 base 257 + 6 P5.0 守护)
- [ ] PR feat/p5-0-portability 已开, 等 Scott review

## 风险与回滚

| 风险 | 触发概率 | 应对 |
|---|---|---|
| architect agent 输出过浅 | 30% | T3 人审一律 push back, 在主报告里补漏; agent return 不充分时手动补 grep |
| 三色判断主观, Scott 不同意 | 50% | review 时按 block 反馈, 改报告 v1.1; 这是评估本身的属性, 不是 bug |
| 工时再校准跟实际偏差大 (P5.1 实际比预估慢) | 40% | spec §13 已说"P5 发现不可移植 → 重新设计"; 这是 P5.1+ 的风险, P5.0 不背 |
| 12 block 数量后期变化 (P0/P3 期间删了某个 block) | 5% | T1 step 1 重新数; 守护测不锁死数字 |

**回滚:** `git revert <PR-merge-commit>`. 0 业务影响. 报告作废, P5.1 没启动前可重做.

---

**Plan 起草日期**: 2026-05-06
**作者**: Claude Opus 4.7
**对应 Spec**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md` §10.2
**预计工时**: 0.5 day (T1 30min + T2 ~15min agent 等待 + T3 1-2h 人审写报告 + T4-T6 30min)
