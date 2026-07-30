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
| `git push origin main` (直接 push main) | 跳过 PR review, **禁止** push 到 main 除非 Scott 显式同意 | 「push main」(应当极少触发) |
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
- [ ] **有 user-facing 改动 (新功能 / UI 变化 / 行为变化)?** 必须更新 `static/changelog.json`:
      新建 entry 在 `entries[0]` + `latest_version` 升到对应版本号 (如 `2026.05.11.2`)。
      **判定标准**: 用户登录后能感知到的差异都算 (新按钮 / 隐藏功能 / 改默认行为 /
      错误信息变化等)。纯重构 / 性能优化 / 内部 dead code 清理不必更新。
      **反例**: 加了"导出 JPG"按钮但漏写公告 → 用户不知道新功能存在 (2026-05-11 教训)。
- [ ] PR description 含 5 节: 背景 / 改动 / 验证 / 风险 / 回滚
- [ ] 跟 spec 关联? Body 引用 `docs/superpowers/specs/<file>.md` 路径

不达任何一项 → 不许 push, 修复后重跑.

---

## 升降档触发条件

### 升档 3 (高度自主, 自动合 main + 自动 deploy)

触发条件: **连续 10 个 PR 自审通过率 ≥ 80%** 且 **Scott 在 review 时 0 大改 (定义: ≤ 2 行 diff 修正)**

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

**版本**: v1.1
**生效日期**: 2026-05-06 (v1.0); 2026-05-11 (v1.1: 加 changelog 自审项)
**审核人**: Scott (本仓库 owner)
**起草人**: Claude Opus 4.7 (per spec §6 brainstorm + Q3=2)

## 修订记录

### v1.1 (2026-05-11)
- 加 PR 自审 checklist 第 5 项: user-facing 改动必须同步更新 `static/changelog.json`
- 触发: 2026-05-11 PR #35 (导出 JPG) 漏写公告, 用户提醒后才补
- 判定: 用户登录后能感知到的差异都算; 纯内部清理 / 重构不算
