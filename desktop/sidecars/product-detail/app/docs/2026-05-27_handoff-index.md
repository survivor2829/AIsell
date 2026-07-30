# 2026-05-27 项目交接索引

> 用途：下一轮规划或执行前，先从这里进入，避免在多份文档里找入口。

## 先看哪份

| 你要做什么 | 先看 | 作用 |
|---|---|---|
| 快速拍板下一步 | `docs/2026-05-27_decision-brief.md` | 1 页短简报，列出推荐路线和未闭环风险 |
| 查看待办执行看板 | `docs/2026-05-27_next-action-tracker.md` | 下一步行动、授权要求和完成证据 |
| 复核完整现状 | `docs/2026-05-27_next-planning-baseline.md` | 完整项目基线、证据、工作区变更、验证状态 |
| 准备提交当前工作区 | `docs/2026-05-27_commit-manifest.md` | 推荐提交方式、文件清单、提交前验证和选 1 命令草案 |
| 执行上传 UX 手测 | `docs/2026-05-27_upload-ux-browser-validation-runbook.md` | `/batch/upload` 浏览器验收步骤和通过标准 |
| 记录上传 UX 手测结果 | `docs/2026-05-27_upload-ux-browser-validation-report.md` | 浏览器验收结果和失败记录 |
| 恢复 Python/Flask 环境 | `docs/2026-05-27_python-flask-env-recovery-options.md` | 本地环境恢复路线、授权边界和命令草案 |
| Review 上传 UX 改动 | `docs/2026-05-27_upload-ux-quick-win-plan.md` | 改动目标、范围、风险、回滚和验证记录 |
| 做 P5.6 耗材真测 | `docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md` | 真测验收报告模板 |
| 判断阶段七能不能开 | `docs/2026-05-27_phase7-readiness-checklist.md` | 升配、PG、Redis、自愈的触发条件和授权边界 |

## 当前推荐路线

优先闭环 **B. 上传 UX 快赢真实浏览器验证**；在三项拍板里，它对应 **2. 先恢复 Python/Flask 环境**。

Agent team 只读审查已复核三项拍板入口、选 2 环境恢复路径、登录边界和 commit manifest；结论是材料足够支持用户拍板。当前最稳路线是先选 1 固化当前工作区，再选 2 闭环上传 UX；如果更急于验证上传体验，也可以直接选 2。

原因：

- 不花 API 钱。
- 不碰生产。
- 已有代码实现和轻量验证。
- 只差本地 Flask/浏览器手测，是当前最短闭环；手测前需用本地测试账号登录，不使用生产账号或生产密码。

如果现在只拍一个板：

| 选择 | 立即动作 |
|---|---|
| 1. 先提交当前工作区 | 按 `docs/2026-05-27_commit-manifest.md` staging，提交前复跑一键交接检查；命令草案在提交清单中，只有用户明确选择 1 后执行 |
| 2. 先恢复 Python/Flask 环境 | 先看 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”，再提供 Python 路径，或授权 `scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall` |
| 3. 暂不动代码，只继续规划 | 继续细化 P5.6 / 阶段七 / P6，不提交、不安装、不联网、不触发 API |

## 当前关键验证命令

一键交接检查：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1
```

当前一键交接检查已覆盖：

- `bootstrap local dev env plan-only OK`：确认 bootstrap 默认不创建 `.venv`、不安装依赖、不联网。
- `sensitive content scan OK: current status files`：确认当前待提交文件未命中私钥/长 token/key/password 形状。
- `2026-05-27 planning path checks passed (25 paths)`：确认规划引用路径存在。
- `commit manifest covers git status (23 paths); command draft matches manifest (23 paths)`：确认提交清单覆盖当前 git status，且选 1 的 `git add -- ...` 命令草案与提交清单一致。
- `worktree summary: 1 modified, 22 untracked, 23 total`：确认一键检查尾部直接给出当前待提交数量摘要。
- `recommended route:`：一键检查通过后直接打印 `1 first: commit current worktree to freeze handoff and validation assets` / `2 next: restore Python/Flask environment and browser-test /batch/upload`。
- `next decision options:`：一键检查通过后直接打印 `1. commit current worktree` / `2. restore Python/Flask environment` / `3. planning only; no code/install/network/API`。
- `entry docs:`：一键检查通过后直接打印 `commit: docs/2026-05-27_commit-manifest.md` / `environment: docs/2026-05-27_python-flask-env-recovery-options.md` / `actions: docs/2026-05-27_next-action-tracker.md`。

无项目依赖的验证：

```bash
node scripts/verify_batch_upload_ux_all.js
node scripts/verify_2026_05_27_planning_paths.js
node scripts/verify_2026_05_27_commit_manifest.js
```

生成上传 UX 本地手测素材：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make_upload_ux_sample.ps1
```

只读检查本机开发环境：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1
```

需要单独跑上传 UX 静态检查时：

```bash
python scripts/verify_batch_upload_ux_static.py
```

在 Codex Desktop 当前环境里，`node scripts/verify_batch_upload_ux_all.js` 会自动回退到捆绑 Python 执行这一步。

恢复完整 Python/Flask 环境后：

```bash
python -m pytest tests/test_batch_upload_ux.py tests/test_batch_progress_ui.py -q
python -m pytest tests/test_batch_pipeline_smoke.py -q
```

授权创建本仓库 `.venv` 时可用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall
```

## 当前工作区状态

- 修改：`templates/batch/upload.html`
- 新增：22 个交接/验证/测试文件
- 未提交：是
- 本地手测素材：`test_batch_input/upload_ux_sample` 已生成，内容为 2 个产品目录、6 个产品文件；每个产品目录包含 `main.png`、`detail-1.png`、`info.txt`，`info.txt` 标记为 synthetic sample / no real customer data，且 `test_batch_input/` 被 git 忽略
- 未执行：真实浏览器 `/batch/upload` 手测、P5.6 真测、阶段七生产动作

## 当前卡点

- 项目 Python/Flask 环境未恢复：PATH 无 `python` / `py` / `pip`，仓库无 `.venv/venv`，常见本机 Python 安装目录也未发现可直接复用的 `python.exe`。
- Docker 路线当前不能直接执行：本机未检测到 `docker` / `docker-compose`；即使后续授权容器路线，构建也会涉及 apt/pip/Playwright/rembg 下载。
- Codex bundled Python 可用于标准库静态检查，但不能替代项目 Flask/pytest 环境。
- 下一步需要用户拍板：先提交当前工作区，或提供/授权恢复项目 Python 环境后，用本地测试账号登录并做真实浏览器 `/batch/upload` 手测。

## 授权边界

需要先问用户：

- 真实 AI/API 调用或费用支出。
- prod、deploy、SSH、DB、升配。
- P5.6 真实耗材端到端真测。
- 阶段七 PG/Redis/自愈执行落地。

可以继续本地推进：

- 文档整理。
- 无依赖脚本验证。
- 不触发真实 API 的本地 smoke。
- 恢复本地开发环境前的只读盘点。
