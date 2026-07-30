# 商用化路线图 v1 — Master Roadmap

> **文档位置**: `docs/superpowers/specs/2026-05-06-master-roadmap-design.md`
> **Brainstorm session**: 2026-05-06
> **会话**: ws-push-image-refresh-test
> **设计依据**: 6 轮 Q&A 决策（见 §11）
> **适用项目**: 清洁机器人 AI 详情图生成器（设备类已上线于腾讯云生产；本路线图扩展耗品 / 配耗工具类，并补足商用化基础工作）
> **作者**: Claude Opus 4.7（Q&A 由 Scott 决策）

---

## §1. 背景与触发

设备类（清洁机器人）AI 详情图生成器在 2026-04-21 完成生产首发上线（`project_stage6_prod_live.md`），随后 v3.2.2 颜色保真双图锚定（4-29）和 v3.3 单屏 reroll 逃逸阀（5-06，待 push）两条特性把单品类的产品质量推到 ~85-90% 跨屏一致率。

当前阻碍商用化的 5 个并存问题：

1. **API key 仍由用户配置** — `templates/auth/settings.html` 至今让用户填 DeepSeek / 图像生成 key，且接口写死为豆包形态，无 `base_url`，无法切换第三方供应商
2. **技术债无系统化盘点** — 4-21 上线后只攒了"阶段七 wishlist"，5+ 个 demo 客户同时使用前需要确认无严重问题
3. **agent 协作流程不一致** — 现有 memory 铁律（push / deploy / 花钱必授权）与"我只验最终交付"诉求冲突
4. **品类单一** — 仅设备类管线跑通；清洁行业销售真实结构是 设备 + 耗品 + 配耗工具 三足
5. **遗留小事项** — v3.3 task 10 卡在 push/deploy / 60+ pytest 僵尸用户 / 腾讯云 prod admin 密码丢失

本路线图把上述 5 件事拆成 4 份独立 spec + 1 份元规则 + 当前一份总路线图（D5）。

---

## §2. 设计决策（6 轮 Q&A 锚点）

| Q | 问题 | 决定 | 关键推论 |
|---|---|---|---|
| Q1 | 是否有商业截止日期？ | **C** — 无截止，自我驱动地基化 | 不赶 demo，不为 deadline 牺牲质量；可以选纯报告型阶段 |
| Q2 | "地基化"档位？ | **D** — 轻量（自己 + 5 个潜在客户体验级） | 不上 PG / Redis；2C2G SQLite 不动；阶段七 wishlist 大部分延后 |
| Q3 | Agent 自主性档位？ | **2** — PR 模式 | 自动 push feature branch + 自动开 PR；merge / deploy / 花钱仍要授权 |
| Q4 | 耗品 vs 配耗工具，先做谁？ | **A** — 先耗品，跑通后做配耗 | 耗品销售叙事最标准化；视觉素材简单（不需场景图库） |
| Q5 | 技术债审计深度？ | **B** — 中度审计 + 纯报告 | 1-2 天，4 sub-agent 并行扫，不动手修；产 spec stubs |
| Q6 | API key 砍刀流深度？ | **A** — 砍刀流（最小 MVP） | 删 custom UI；platform key 走 env；base_url 也走 env；不做 admin 后台 |

---

## §3. 工程原则（贯穿所有阶段，违反等于不交付）

1. **避免硬编码** — 任何可变值（API key / 域名 / 阈值 / 路径 / 价格 / 文案）必须走 `os.environ` 或 DB 或 config 文件；代码里不许出现 magic literal。原则触发场景示例：
   - 价格不写死在代码 → 走 `pricing_config.py`
   - API endpoint 不写死 → 走 `XXX_BASE_URL` 环境变量
   - 文案/参数不写死 → 走 AI 解析 / 配置文件（参考 `feedback_no_hardcoded_data.md`）

2. **根本性修复** — 修 bug 时先问"**why is this issue able to occur in the first place**"。修表象（"这次的颜色不对，把那一行改下"）跟修根因（"色彩稳定性整套缺锚定，加 ColorAnchor"）是 2 个量级的工作。本路线图所有修复**默认走根因路线**；选择只修表象时必须在 PR description 里明示理由（如：根因要重写整模块，本 PR 仅热修+开 follow-up issue）。

3. **PR-as-deliverable** — 每阶段 1+ 个 PR；PR description 必须含：背景 / 改动 / 验证（测数 / smoke 结果） / 风险 / 回滚方案。Scott merge PR 等于交付被接收。

4. **Audit-only 优先** — 不知道修还是不修，先 audit；侦察 ≠ 战斗（参考 `user_cleanup_taste.md` 的 "先跑 dep-graph 再聊删除"）。

5. **写后必验** — 任何写操作（DB 写 / 文件改 / 配置改 / 部署）后，立即构造最小"读或用"动作证明功能维度真生效（参考 `feedback_write_then_verify.md`）。

6. **fixture 必清理** — 测试代码用过的 DB 行必须在 fixture teardown rollback / delete；不留脏数据。本路线图 P0 包含一次性清理 + fixture 加固。

---

## §4. 阶段总览（图 + 表）

```
P0 → P1 → P2 → P3 → P4 → P5 → P6
(收尾) (元规则) (审计) (砍刀) (修债) (耗品) (配耗)
```

| 阶段 | 内容 | 工时估算 | PR 数 | 阻断条件 |
|---|---|---|---|---|
| **P0** | v3.3 收尾 + 僵尸用户清理 + prod 密码同步 | 1-2 h | 2 | Scott 授权 push/deploy |
| **P1** | D4 — 协作约定文档 | 30 min | 1 | — |
| **P2** | D2 — 技术债审计（4 sub-agent 并行） | 1-2 day | 1 | — |
| **P3** | D1 — key 托管砍刀流 | 0.5-1 day | 1 | — |
| **P4** | D2 选中高/中严重度债修复 | 不固定 | n | Scott 挑选 |
| **P5** | D3a — 耗品类管线（5 子阶段） | 2 周 | 5+ | P3 完成 |
| **P6** | D3b — 配耗工具类管线（复用 P5） | 1 周 | 3+ | P5 完成 |

**总周期估算**：3-4 周（看 P4 挑几个修）

---

## §5. P0 详情：v3.3 收尾 + 遗留小事项

### 5.1 子任务表

| 事 | 做法 | 授权状态 |
|---|---|---|
| v3.3 task 10 push | `git push origin feat/regen-single-screen-v33` | 等 Scott 说 "push" |
| v3.3 prod 真测 1 单 | 在 `http://124.221.23.173:5000/` 跑 reroll，烧 ¥0.7 | 等 Scott 说 "真测" |
| v3.3 prod deploy | `ssh tencent-prod` + `git pull` + `docker compose restart` | 等 Scott 说 "deploy" |
| **僵尸用户清理（根因+清理）** | 见 §5.2 | 自动可做（本机） |
| 腾讯云 prod admin 密码 → `2829347524an` | ssh tencent-prod + `docker compose exec web python <reset_script>` + write+verify 闭环 | 等 Scott 说 "go prod 密码" |

### 5.2 僵尸用户清理 — 根因 + 一次性清理 + 防再造

**根因**：`ai_refine_v2/tests/test_regen_endpoint.py`（及任何创建 `User` row 的测试）在 setUp 创建用户但 tearDown 不 rollback / delete。每跑一次 pytest，DB 留 60+ 条 `alice_xxx` / `bob_other_xxx` / `lock_user_xxx` 等脏数据，254 测每次都加几十条。

**修法**（按 §3 原则 #2 根本性修复）：
1. 改测试 base class 用 `db.session.begin()` + 每测 rollback；或者引入 `pytest-flask-sqlalchemy` 的 `db_session` fixture（自动 savepoint+rollback）
2. 改完后再写一次性脚本 `_tmp_purge_test_users.py` 删既有 60+ 条脏数据
3. **绝不**用"每次跑完手动 truncate"这种表象修复

PR description 必须列：
- 根因诊断（为什么会有僵尸）
- 修法选型（rollback fixture vs savepoint vs autouse 清理）
- 防回归策略（CI 跑完后断言无 zombie 前缀）

---

## §6. P1 — D4 协作约定文档

### 6.1 输出物

新文件：`.claude/AUTONOMY.md`

内容（草稿）：

```markdown
# Agent 自主性约定 v1

## 档位
档 2 — PR 模式（Scott 选定 2026-05-06）

## 自动允许（无需打扰 Scott）
- 编辑/读/写本仓库代码（除 .env / instance/ / crypto_utils.py 仍 deny）
- 跑测试 / 启本机 server / 运行 sub-agent
- git commit
- git push 到 feature branch（**禁止 push main**）
- 创建 PR (gh pr create) 并写完整 description
- 调任何 MCP / skill / sub-agent

## 仍要 Scott 授权
- merge PR 到 main
- git push --force（任何分支）
- deploy 腾讯云 / 任何 prod 改动
- 真金真银花钱（gpt-image-2 真测、ai-refine 真跑）
- 改 prod DB 数据（含密码、迁移）
- 改 .env / fernet key

## PR 自审 checklist（push 前必做）
- [ ] `python -m pytest -q` 0 fail
- [ ] /smoke skill 跑过
- [ ] 改了模板？跑 /regen-thumbs
- [ ] PR description 含：背景 / 改动 / 验证 / 风险 / 回滚

## 升降档触发条件
- 升档 3：连续 10 个 PR 自审通过率 ≥80% 且 Scott 0 大改 → Scott 决定
- 降档 1：连续 3 个 PR 含逻辑 bug 或测试遗漏 → 自动降档
```

### 6.2 同步更新

- `feedback_deploy_skill_push_authorization.md` — 标注被 D4 部分放松（push 到 feature branch 不再问）
- `CLAUDE.md` — 加一行指向 `.claude/AUTONOMY.md`

---

## §7. P2 — D2 技术债审计

### 7.1 4 sub-agent 并行扫描矩阵

| Agent | 范围 | 关键产出 |
|---|---|---|
| `oh-my-claudecode:explore` | dead code / unused imports / 不再被引用的 helper | 删除候选清单 |
| `oh-my-claudecode:code-reviewer` | 代码风味、SOLID 违反、重复代码 | 重构候选清单 + 严重度评级 |
| `oh-my-claudecode:architect` | 文件过大、责任不清、循环依赖 | 拆分/合并候选 |
| `oh-my-claudecode:security-reviewer` | fernet key 管理、SQL 注入风险、秘密泄露、CSRF 边界 | 安全债清单（最高优先） |

### 7.2 输出文件

- `docs/superpowers/audits/2026-05-06-tech-debt-audit.md` — 主报告
- `docs/superpowers/specs/_stubs/<topic>-stub.md` — 每条高/中严重度债 1 份草稿

### 7.3 报告结构（模板）

```markdown
# 技术债审计报告 v1

## Top 10 严重度排名
| # | 债 | 类型 | 严重度 | 修复估时 | spec stub |
|---|---|---|---|---|---|
| 1 | xxx | security | 严重 | 2h | _stubs/xxx-stub.md |

## 分类细节
### 安全债 (n 项)
...
### 架构债 (n 项)
...
### Dead code (n 项)
...
### 风味债 (n 项)
...

## Scott 决策栏 (留空)
- [ ] Top 1: 修 / 不修 / 延后 → 备注 ___
- [ ] Top 2: ...
```

---

## §8. P3 — D1 key 托管砍刀流

### 8.1 改动范围

| 文件 | 行为 | 内容 |
|---|---|---|
| `templates/auth/settings.html` | 删除 | 整块「API Key 配置卡」 |
| `app.py:1066-1100` | 删除 | custom key 写入逻辑 |
| `app.py:1944-1950` | 改写 | 从 `decrypt_api_key(owner.custom_api_key_enc)` 改为 `os.environ['DEEPSEEK_API_KEY']`（缺则报错） |
| `app.py:2955` | 改写 | `key_source` 字段统一记 `'platform'` |
| `ai_refine_v2/refine_generator.py` | 加参 | `base_url=os.getenv("REFINE_API_BASE_URL", default)` |
| `app.py` 启动钩子 | 新增 | 启动时校验 platform key 完整，缺则报错 + 友好提示 |
| `models.py` | **不动** | `custom_api_key_enc` / `api_key_source` 字段保留（YAGNI 但留扩展点） |

### 8.2 测试影响

`tests/test_*` 中所有 fixture 创建 User 时设 `custom_api_key_enc=encrypt_api_key(...)` 的逻辑要改：
- 选项 A — fixture 改为 monkeypatch `os.environ['DEEPSEEK_API_KEY']='sk-fake'`
- 选项 B — 抽出 `make_test_user()` helper，集中维护

P3 完成时 251 测必须保持全绿。

### 8.3 关于 base_url（per Scott Q6 + §3.1 反硬编码）

```python
# ai_refine_v2/refine_generator.py
# DEFAULT_REFINE_BASE_URL 的具体值在 P3 实施时通过 grep 现有 OpenAI client 调用点确认,
# 同步写入 .env.example 作为参考默认; 永远不在代码里硬编码生产值.
DEFAULT_REFINE_BASE_URL = os.environ["REFINE_API_BASE_URL"]  # 启动校验阶段验非空

client = OpenAI(api_key=key, base_url=DEFAULT_REFINE_BASE_URL)
```

未来切第三方只改 `.env` 一行，不动代码。**P3 实施时同步更新 `.env.example`** 让新人 onboard 时能一眼看到要配什么。

---

## §9. P4 — D2 选中高/中严重度债修复

不预先估时；按 P2 报告 Scott 标记的 "修" 项目逐个生成 spec → plan → PR。每个债 1 个独立 PR。

P4 是开放阶段，可中断、可挑、可放弃。

---

## §10. P5 — D3a 耗品类管线（5 子阶段）

### 10.1 子阶段表

| 子阶段 | 内容 | 工时 |
|---|---|---|
| **P5.0** | 「导演思维」可移植度评估报告 | 0.5 day |
| **P5.1** | 数据 schema 适配（品类 enum / `consumable` 加入） | 1 day |
| **P5.2** | block 模板设计（新写 / 复用 / 删的清单） | 3 day |
| **P5.3** | 解析 prompt 适配（耗品 4 板斧：用量/性价比/兼容/寿命） | 2 day |
| **P5.4** | 拼接管线适配（屏数可能不是 12） | 1 day |
| **P5.5** | e2e 测 + 真测 1 单 | 2 day |
| **P5.6** | admin/UI 入口（新品类选项） | 1 day |

### 10.2 P5.0 评估报告产出（决定 P5.1+ 范围）

报告内容：
- 设备类 12 个 block 哪几个**直接复用**（如 hero / 参数表 / 1 台顶 8 人）
- 哪几个**需要重写**（如清洁故事屏、磨砂玻璃维度卡）
- 哪几个**应该删**（耗品没有，比如机器人续航 KPI）
- 设备类导演脚本 4 工序的可移植度评估（解析 / 模板匹配 / 渲染 / 精修）

### 10.3 防硬编码原则在 P5 的具象

- 品类不能写死，加 `ProductCategory` enum 或 config 表
- 耗品的 4 板斧文案 prompt 不能写死，走 prompt 配置文件
- 耗品的视觉风格不能继承设备类（清洁机器人是科技蓝；耗品可能是清新绿/暖橘），用 `theme_id` 系统挂新主题

---

## §11. P6 — D3b 配耗工具类管线

复用 P5 经验，工时压缩到 1 周。设计点：
- 配耗工具的销售叙事更杂（场景 + 兼容 + 便利）
- 视觉可能需要场景图（人在洗手间用拖把）→ 重新设计 `scene_bank/`
- P6.0 评估报告再做一次（工具类是否能复用耗品架构）

---

## §12. Done Criteria（D5 整体完工标准）

- [ ] P0-P6 每阶段都有合并到 main 的 PR
- [ ] 每个 PR 跑过全测（≥251 测绿）+ `/smoke` skill
- [ ] P0 三件事全闭环（含 prod 真测）
- [ ] D2 报告中 ≥80% 高严重度债已修或明确决定不修（带 PR description 备注）
- [ ] D3a 耗品类至少 1 单真测出货（prod 上）
- [ ] D3b 配耗工具类至少 1 单真测出货
- [ ] memory 留 4+ 条新记录（v3.3 完成 / D2 审计 / D1 上线 / D3 双品类上线）
- [ ] 此 D5 spec 文件**最终修订版**（含每阶段实际工时 / 偏差 / 教训）

---

## §13. Risks & Rollback

| 风险 | 触发概率 | 应对 |
|---|---|---|
| P2 审计爆出 >20 项严重度 ≥ 高 | 30% | Scott 决定升级到 Q2 档 C 或者跳 P4 直奔 P5 |
| P5.0 评估发现"导演思维不可移植" | 40% | 重新设计耗品类独立管线（可能 6/8 屏 / 单图详情） |
| 档 2 自主性 PR 累积过多 Scott review 不过来 | 25% | 累计 ≤3 个 PR 才推下一个，超出排队 |
| Scott 中途插入新需求 | 60% | 路线图允许中途插入；插入时此 spec 加版本号（v1.1 / v1.2 ...）重排 |
| P3 砍刀流破坏现有 prod 用户的 custom key 工作流 | 5% | prod admin 是唯一活用户（其他都是测试 fixture），影响面 0；保守起见 prod 部署时 prod 上的 admin custom_api_key_enc 不删 |

**回滚策略**：每阶段 1 个 PR，`git revert <PR-merge-commit>` 即可回滚单个阶段。P5+ 涉及新品类，回滚不影响设备类（独立管线）。

---

## §14. References

### 内部 specs / plans
- `docs/superpowers/specs/2026-04-30-regenerate-screen-design.md` — v3.3 设计
- `docs/superpowers/plans/2026-04-30-regenerate-screen-implementation.md` — v3.3 实施
- `docs/superpowers/specs/2026-04-23-project-cleanup-design.md` — 4-23 项目清理

### 内部 docs
- `docs/2026-04-21_踩坑复盘_生产上线.md` — 生产上线踩坑（密码假成功 / 模板 build vs restart）
- `CLAUDE.md` — 项目协作约定

### Memory
- `feedback_no_hardcoded_data.md` — 不硬编码原则（§3 原则 #1 之源）
- `feedback_write_then_verify.md` — 写后必验（§3 原则 #5 之源）
- `feedback_deploy_skill_push_authorization.md` — push/deploy 授权（P0 + D4 改写之）
- `feedback_silent_fallback.md` — API 降级必须打日志
- `user_cleanup_taste.md` — Scott 偏好 archive > delete（§3 原则 #4 之源）
- `project_stage6_prod_live.md` — 阶段七 wishlist（D5 范围 anchor）
- `project_v322_color_anchor_complete.md` — v3.2.2 色彩锚定背景
- `project_v33_regen_single_complete.md` — v3.3 进度（P0 anchor）

---

**版本**: v1.0
**起草日期**: 2026-05-06
**Scott 决策时间**: 2026-05-06（Q1-Q6 + 整体 §2-§5 GATE 全 ✅）
**下一步**: writing-plans skill → 生成 P0-P6 各自的实施计划（plans/）
