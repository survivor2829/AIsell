# 2026-05-27 提交清单

> 用途：如果后续要提交当前工作区变更，用这份清单决定 staging 范围。  
> 状态：仅建议，不代表已经执行 `git add` / `git commit`。

## 当前工作区

- 修改：`templates/batch/upload.html`
- 新增：22 个文件
- 当前未提交：是

数字口径：

- `commit manifest covers git status (23 paths); command draft matches manifest (23 paths)`：只统计当前 `git status --short --untracked-files=all` 中需要提交的 1 个修改路径 + 22 个新增路径，并确认 `git add -- ...` 命令草案与“建议包含”路径完全一致。
- `2026-05-27 planning path checks passed (25 paths)`：额外校验文档引用到的既有测试文件 `tests/test_batch_progress_ui.py` 和 `tests/test_batch_pipeline_smoke.py`，所以比提交清单多 2 个路径。

## 推荐方式

建议优先做 **一个提交**。

原因：

- 交接索引、路径检查、一键检查、上传 UX runbook 互相引用。
- 强拆成多个 commit 时，中间 commit 容易出现“文档引用的脚本还不存在”或“路径检查脚本缺文件”的状态。
- 当前改动都围绕同一个目标：对齐项目进度，并把上传 UX 快赢推进到可验证状态。

建议提交信息：

```text
chore: add upload ux handoff and validation baseline
```

## 选 1 时的最小执行顺序

1. 先运行 `powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1`。
2. 只 stage 本清单“建议包含”里的 23 个路径；不要 stage `test_batch_input/`。
3. 提交信息使用 `chore: add upload ux handoff and validation baseline`。

提交后下一步建议接 `2. restore Python/Flask environment`：按 `docs/2026-05-27_python-flask-env-recovery-options.md` 的“选 2 时的最小执行顺序”恢复环境，再用本地测试账号闭环 `/batch/upload` 浏览器手测。

建议包含：

```text
templates/batch/upload.html
tests/test_batch_upload_ux.py
scripts/check_local_dev_env.ps1
scripts/bootstrap_local_dev_env.ps1
scripts/make_upload_ux_sample.ps1
scripts/verify_2026_05_27_commit_manifest.js
scripts/verify_2026_05_27_handoff_all.ps1
scripts/verify_2026_05_27_planning_paths.js
scripts/verify_batch_upload_inline_js_syntax.js
scripts/verify_batch_upload_runtime_smoke.js
scripts/verify_batch_upload_ux_all.js
scripts/verify_batch_upload_ux_static.py
docs/2026-05-27_commit-manifest.md
docs/2026-05-27_decision-brief.md
docs/2026-05-27_handoff-index.md
docs/2026-05-27_next-action-tracker.md
docs/2026-05-27_next-planning-baseline.md
docs/2026-05-27_phase7-readiness-checklist.md
docs/2026-05-27_python-flask-env-recovery-options.md
docs/2026-05-27_upload-ux-browser-validation-report.md
docs/2026-05-27_upload-ux-browser-validation-runbook.md
docs/2026-05-27_upload-ux-quick-win-plan.md
docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md
```

命令草案（仅在用户明确选择 1 后执行）：

```powershell
git add -- templates/batch/upload.html tests/test_batch_upload_ux.py scripts/check_local_dev_env.ps1 scripts/bootstrap_local_dev_env.ps1 scripts/make_upload_ux_sample.ps1 scripts/verify_2026_05_27_commit_manifest.js scripts/verify_2026_05_27_handoff_all.ps1 scripts/verify_2026_05_27_planning_paths.js scripts/verify_batch_upload_inline_js_syntax.js scripts/verify_batch_upload_runtime_smoke.js scripts/verify_batch_upload_ux_all.js scripts/verify_batch_upload_ux_static.py docs/2026-05-27_commit-manifest.md docs/2026-05-27_decision-brief.md docs/2026-05-27_handoff-index.md docs/2026-05-27_next-action-tracker.md docs/2026-05-27_next-planning-baseline.md docs/2026-05-27_phase7-readiness-checklist.md docs/2026-05-27_python-flask-env-recovery-options.md docs/2026-05-27_upload-ux-browser-validation-report.md docs/2026-05-27_upload-ux-browser-validation-runbook.md docs/2026-05-27_upload-ux-quick-win-plan.md docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md
git commit -m "chore: add upload ux handoff and validation baseline"
```

执行命令草案前仍需先跑一键交接检查；命令草案不得包含 `test_batch_input/`。`scripts/verify_2026_05_27_commit_manifest.js` 会解析 `git add -- ...` 草案，并确认它与“建议包含”的 23 个路径完全一致。

## 可选拆分

如果必须拆分，建议拆成两个 commit，但只要求最终合并后跑通过一键检查。

### Commit 1：规划和交接材料

```text
docs: add 2026-05-27 planning handoff
```

包含：

```text
docs/2026-05-27_commit-manifest.md
docs/2026-05-27_decision-brief.md
docs/2026-05-27_handoff-index.md
docs/2026-05-27_next-action-tracker.md
docs/2026-05-27_next-planning-baseline.md
docs/2026-05-27_phase7-readiness-checklist.md
docs/2026-05-27_python-flask-env-recovery-options.md
docs/2026-05-27_upload-ux-browser-validation-report.md
docs/2026-05-27_upload-ux-browser-validation-runbook.md
docs/2026-05-27_upload-ux-quick-win-plan.md
docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md
```

### Commit 2：上传 UX 和验证入口

```text
fix(batch): show upload progress and stabilize folder picker
```

包含：

```text
templates/batch/upload.html
tests/test_batch_upload_ux.py
scripts/check_local_dev_env.ps1
scripts/bootstrap_local_dev_env.ps1
scripts/make_upload_ux_sample.ps1
scripts/verify_2026_05_27_commit_manifest.js
scripts/verify_2026_05_27_handoff_all.ps1
scripts/verify_2026_05_27_planning_paths.js
scripts/verify_batch_upload_inline_js_syntax.js
scripts/verify_batch_upload_runtime_smoke.js
scripts/verify_batch_upload_ux_all.js
scripts/verify_batch_upload_ux_static.py
```

## 提交前验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1
```

`verify_2026_05_27_handoff_all.ps1` 已包含 PowerShell 语法检查、bootstrap plan-only 安全检查、上传 UX 轻量检查、可选 Python 静态检查、`git diff --check`、敏感/本地素材路径护栏、当前 status 文件敏感内容扫描、commit manifest 覆盖检查和 `git status --short` 输出。

关键通过证据应包含 `Codex bundled Python: OK`、`common Python candidates: MISSING`、`docker: MISSING`、`bootstrap local dev env plan-only OK`、`sensitive content scan OK: current status files`、`Codex bundled Python dependency probe`、`flask: MISSING`、`pytest: MISSING`、`playwright: MISSING`、`tests/test_batch_progress_ui.py: OK`、`tests/test_batch_pipeline_smoke.py: OK`、`using Python static verifier`、`stdlib source guard tests passed`、`batch upload UX static checks passed`、`test_batch_input is ignored by git`、`upload UX sample path exists: test_batch_input\upload_ux_sample`、`upload UX sample content OK: 2 product dirs, 6 product files`、`upload UX sample product dirs OK: sample-product-a, sample-product-b`、`upload UX sample product files OK: main.png, detail-1.png, info.txt`、`upload UX sample product files are non-empty`、`upload UX sample PNG headers OK: main.png, detail-1.png`、`upload UX sample info markers OK: synthetic sample, no real customer data`、`commit manifest covers git status (23 paths); command draft matches manifest (23 paths)`、`worktree summary: 1 modified, 22 untracked, 23 total`、`handoff verification passed`、`recommended route:`、`1 first: commit current worktree to freeze handoff and validation assets`、`2 next: restore Python/Flask environment and browser-test /batch/upload`、`next decision options:`、`1. commit current worktree`、`2. restore Python/Flask environment`、`3. planning only; no code/install/network/API`、`entry docs:`、`commit: docs/2026-05-27_commit-manifest.md`、`environment: docs/2026-05-27_python-flask-env-recovery-options.md` 和 `actions: docs/2026-05-27_next-action-tracker.md`。

当前限制：

- 完整 pytest 未跑，因为本机无 PATH Python/py/pip 且仓库无 `.venv/venv`。
- Flask 浏览器手测未跑，需先恢复 Python/Flask 环境，并使用本地测试账号登录后打开 `/batch/upload`；不使用生产账号或生产密码。
