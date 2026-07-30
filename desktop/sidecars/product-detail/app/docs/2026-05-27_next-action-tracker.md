# 2026-05-27 下一步行动追踪

> 用途：把当前未闭环事项变成可选择、可验证的执行项。  
> 状态：活文档；执行前仍以当前工作区和用户授权为准。

## 当前优先级

| 优先级 | 行动 | 状态 | 需要授权 | 完成证据 |
|---|---|---|---|---|
| P0 | 决定是否提交当前工作区 | 待用户拍板；一键交接已含当前 status 文件敏感内容扫描和命令草案比对 | 需要 | 按 `docs/2026-05-27_commit-manifest.md` staging/commit，或明确暂不提交；提交前确认 `sensitive content scan OK: current status files` 和 `commit manifest covers git status (23 paths); command draft matches manifest (23 paths)` |
| P0 | 恢复 Python/Flask 本地环境 | 待用户选择路线；Codex 捆绑 Python 仅够静态检查；常见本机 Python 安装目录未发现可直接复用环境；Docker/Compose 当前未检测到 | 安装依赖/联网需要 | `scripts/check_local_dev_env.ps1` 显示项目 Python + Flask/pytest 可用 |
| P0 | 生成上传 UX 本地手测素材 | 已生成 | 不需要 | `test_batch_input/upload_ux_sample` 已生成；2 个产品目录、6 个产品文件；`main.png` / `detail-1.png` PNG 头有效；`info.txt` 标记 synthetic sample / no real customer data；`test_batch_input/` 仍被 git 忽略 |
| P0 | 闭环上传 UX 真实浏览器验证 | 待环境恢复；需本地测试账号可登录且 `is_approved=True` | 不花 API；启动本地服务即可；不使用生产账号或生产密码 | `docs/2026-05-27_upload-ux-browser-validation-report.md` 填完并通过 |
| P1 | P5.6 耗材类真实端到端验收 | 待样本和费用授权 | 真实 API 费用需要 | `docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md` 填完结果 |
| P2 | 阶段七预备是否启动 | 待性能/并发触发 | 升配/prod/DB 需要 | `docs/2026-05-27_phase7-readiness-checklist.md` 完成只读盘点 |
| P2 | P6 配件类/工具类扩展规划 | 待 P5.6 结论 | 真测需要 | 重新 audit 当前代码后产出 P6 plan |

## 推荐下一步

先选 **提交当前工作区** 或 **恢复 Python/Flask 环境**。

Agent team 最新只读审查结论：三项拍板入口、选 2 环境恢复路径、登录边界和 commit manifest 都足够支持用户拍板。当前最稳路线是先选 1 固化当前工作区，再选 2 闭环上传 UX；如果更急于验证上传体验，也可以直接选 2。

两者的区别：

- 如果先提交：保住当前交接和上传 UX 快赢成果，后续再开环境恢复分支。
- 如果先恢复环境：可以更快做 `/batch/upload` 浏览器手测；但需先用本地测试账号登录，当前 Codex 捆绑 Python 不能替代项目 Flask/pytest 环境，仍需要处理项目 Python/依赖问题。

## 拍板问题

下一轮只需要先回答一个问题：**当前先走哪条线？**

| 选择 | 含义 | 立即动作 |
|---|---|---|
| 1. 先提交当前工作区 | 先固化上传 UX 快赢、交接文档、验证脚本和手测 runbook | 按 `docs/2026-05-27_commit-manifest.md` staging；提交前复跑一键交接检查；提交后自然接选 2 |
| 2. 先恢复 Python/Flask 环境 | 先把 `/batch/upload` 真实浏览器手测闭环 | 按 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”执行；用户提供 Python 路径，或明确授权执行 `scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall` |
| 3. 暂不动代码，只继续规划 | 继续细化 P5.6 / 阶段七 / P6 的条件和验收口径 | 不提交、不安装、不联网、不触发 API |

## 执行入口

交接自检：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1
```

当前一键交接尾部应输出：

```text
worktree summary: 1 modified, 22 untracked, 23 total
handoff verification passed
recommended route:
1 first: commit current worktree to freeze handoff and validation assets
2 next: restore Python/Flask environment and browser-test /batch/upload
next decision options:
1. commit current worktree
2. restore Python/Flask environment
3. planning only; no code/install/network/API
entry docs:
commit: docs/2026-05-27_commit-manifest.md
environment: docs/2026-05-27_python-flask-env-recovery-options.md
actions: docs/2026-05-27_next-action-tracker.md
```

提交范围：

```text
docs/2026-05-27_commit-manifest.md
```

环境恢复：

```text
docs/2026-05-27_python-flask-env-recovery-options.md
scripts/bootstrap_local_dev_env.ps1
```

选 2 的执行顺序以 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”为准：先确认 Python 路径或授权，再跑只读探针 / `.venv` bootstrap / pytest / 本地 Flask / 浏览器手测。

上传 UX 浏览器验收：

```text
docs/2026-05-27_upload-ux-browser-validation-runbook.md
docs/2026-05-27_upload-ux-browser-validation-report.md
```

上传 UX 本地样本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make_upload_ux_sample.ps1
```

## 不应直接执行

- 不直接跑真实 AI/API。
- 不直接创建 `.venv` 或安装依赖，除非用户明确授权。
- 不连接生产 DB。
- 不 deploy、不 SSH、不升配。
- 不把 P6 扩品类排到 P5.6 真测之前。
