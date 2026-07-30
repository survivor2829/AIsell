# 2026-05-27 决策简报

> 用途：给下一轮规划快速拍板。完整证据见 `docs/2026-05-27_next-planning-baseline.md`。

## 当前一句话状态

`product-detail` 当前是可用主线 + 明确待收口项：批量生成已上线，上传 UX 快赢已实现并通过轻量验证；P5.6 耗材类真测、真实浏览器上传手测、阶段七性能地基仍未闭环。

## 已完成到哪里

- 批量上传 UX：已把 picker 点击稳定化，并将上传改为 XHR 进度反馈，能显示百分比、速度、剩余时间。
- 验证入口：已新增 pytest 风格守护测、无 pytest 静态验证、无 Flask JS 语法检查、无 Flask 运行时 smoke、一键验证脚本。
- 规划资产：已新增交接索引 `docs/2026-05-27_handoff-index.md`、Python/Flask 环境恢复选项 `docs/2026-05-27_python-flask-env-recovery-options.md`、P5.6 耗材类验收模板、阶段七预备清单、完整规划基线、上传 UX 浏览器验证 runbook `docs/2026-05-27_upload-ux-browser-validation-runbook.md`。
- 独立审查：agent team 只读审查已复核三项拍板入口、选 2 环境恢复路径、登录边界和 commit manifest；结论是材料足够支持用户拍板，仅建议补清“B 对应选 2”的口径。

## 当前不要误判的事

- 上传 UX 不是完全闭环：还缺真实 Flask/浏览器 `/batch/upload` 手测。
- P5.6 不是完成：模板已建，但没有真实样本、费用授权和端到端结果。
- 阶段七不是启动：PG/Redis/升配/自愈都只是预备，生产动作仍需另行授权。
- P6 不是优先：建议等 P5.6 通过后再扩品类，避免复制未验证问题。

## 推荐下一步

优先选 **B. 闭环上传 UX 快赢验证**；在下面三项拍板里，它对应 **2. 先恢复 Python/Flask 环境**。如果想先固化当前工作区，再先选 1，之后再选 2。

理由：
- 不花 API 钱。
- 不碰生产。
- 代码已完成，轻量验证已通过。
- 只差恢复可运行环境后做真实浏览器手测，是当前最短闭环；手测只用本地测试账号，不使用生产账号或生产密码。

如果现在只拍一个板，建议从下面三项里选：

| 选择 | 适合情况 | 下一动作 |
|---|---|---|
| 1. 先提交当前工作区 | 想先固化当前交接、上传 UX 快赢和验证脚本 | 按 `docs/2026-05-27_commit-manifest.md` 提交前复跑一键交接检查 |
| 2. 先恢复 Python/Flask 环境 | 想马上闭环 `/batch/upload` 浏览器手测 | 按 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”执行；提供 Python 路径，或授权 `scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall` |
| 3. 暂不动代码，只继续规划 | 还要继续讨论 P5.6 / 阶段七 / P6 | 不提交、不安装、不联网、不触发 API |

## 可选路线

| 选项 | 适合什么时候做 | 需要什么 |
|---|---|---|
| B. 闭环上传 UX 快赢验证 | 暂无耗材样本，或暂不想花钱 | 恢复 Python/Flask 环境，用本地测试账号登录后打开 `/batch/upload` 手测；不使用生产账号或生产密码 |
| A. P5.6 耗材类真测 | 已有真实耗材样本，愿意花约 ¥5-10 真测 | 填验收模板，先 dry-run，再授权真实 API |
| C. 上传 UX 第二刀 | 上传仍是近期核心痛点 | 继续做客户端压缩 opt-in 或打包进度细化 |
| D. 阶段七预备执行 | 已命中性能/并发触发条件 | 从只读盘点开始；升配/prod/DB 需授权 |
| E. P6 扩品类 | P5.6 已通过，客户 demo 需要扩类目 | 重新 audit 当前代码，再写 P6 plan |

## 当前验证结果

- `scripts/verify_batch_upload_ux_all.js`：通过，已覆盖内联 JS 语法、运行时 smoke、标准库静态检查，以及 10 个源码守护测（`tests/test_batch_upload_ux.py` + `tests/test_batch_progress_ui.py`）。
- `scripts/check_local_dev_env.ps1`：通过执行，确认当前本机 PATH 有 Node，仍缺 Python/py/pip，仓库内无 `.venv/venv`，常见本机 Python 安装目录也无可直接复用的 `python.exe`；同时未检测到 `docker` / `docker-compose`，Docker 路线当前不能直接执行；Codex 捆绑 Python 可用于标准库静态检查，但不是项目 Flask 环境；用该 Python 跑 import 探针时 `flask` / `pytest` / `playwright` 均为 MISSING。
- `scripts/verify_2026_05_27_handoff_all.ps1`：通过，已串联交接检查、PowerShell 语法检查、bootstrap plan-only 安全检查、commit manifest 覆盖检查、上传 UX 轻量检查、可选 Python 静态检查、`git diff --check`、敏感/本地素材路径护栏、当前 status 文件敏感内容扫描、上传 UX 样本存在性检查和 `git status --short`；输出 `sensitive content scan OK: current status files`、`worktree summary: 1 modified, 22 untracked, 23 total`、`handoff verification passed`、`recommended route:`、`1 first: commit current worktree to freeze handoff and validation assets`、`2 next: restore Python/Flask environment and browser-test /batch/upload`、`next decision options:`、`1. commit current worktree`、`2. restore Python/Flask environment`、`3. planning only; no code/install/network/API`、`entry docs:`、`commit: docs/2026-05-27_commit-manifest.md`、`environment: docs/2026-05-27_python-flask-env-recovery-options.md`、`actions: docs/2026-05-27_next-action-tracker.md`。
- 本地手测素材：`test_batch_input/upload_ux_sample` 已生成，且一键交接检查确认 `test_batch_input is ignored by git` / `upload UX sample path exists: test_batch_input\upload_ux_sample` / `upload UX sample content OK: 2 product dirs, 6 product files` / `upload UX sample product dirs OK: sample-product-a, sample-product-b` / `upload UX sample product files OK: main.png, detail-1.png, info.txt` / `upload UX sample product files are non-empty` / `upload UX sample PNG headers OK: main.png, detail-1.png` / `upload UX sample info markers OK: synthetic sample, no real customer data`。
- `scripts/verify_2026_05_27_planning_paths.js`：通过。
- `scripts/verify_batch_upload_ux_static.py`：通过。
- `git diff --check`：通过，仅有 Windows 换行提示。

## 当前未提交变更

- 1 个修改文件：`templates/batch/upload.html`
- 22 个新增文件：规划文档、验收模板、验证脚本、上传 UX 守护测、当前决策简报、交接索引、下一步行动追踪、提交清单、Python/Flask 环境恢复选项、授权后 `.venv` bootstrap 草案、上传 UX 浏览器验证 runbook 和结果模板 `docs/2026-05-27_upload-ux-browser-validation-report.md`、本地环境探针、本地手测素材生成、commit manifest 覆盖检查、一键交接检查

建议提交拆分：
- 默认建议一个提交：`chore: add upload ux handoff and validation baseline`
- 具体 staging 范围见 `docs/2026-05-27_commit-manifest.md`
