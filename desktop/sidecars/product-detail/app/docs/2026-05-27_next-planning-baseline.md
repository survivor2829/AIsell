# 2026-05-27 项目下一步规划基线

> 目的：把当前项目进度、证据来源和下一步选择收敛成一页可执行基线，避免继续规划时依赖聊天记忆。
> 范围：只对齐现状与规划，不代表已授权真测、部署、花钱或生产变更。

## 当前判断

`product-detail` 已从单品详情图工具演进为多品类 AI 详情长图系统：

- Flask/Jinja 后端与模板系统仍是主体。
- 批量生成、AI 精修、单屏 reroll、JPG 导出、公告系统、多品类主题识别、AI 生图引擎统一已经进入主线。
- 当前工作区分支为 `main...origin/main`。
- 本机 `git` 可用；`python` / `py` 当前不可用，暂不能在这台 PowerShell 里直接跑 pytest。

## 权威证据

| 事项 | 证据 |
|---|---|
| 批量生成功能已生产上线 | `PROJECT_STATUS_批量生成.md`：阶段六生产上线完成，阶段七待启动 |
| 5 月产品变更最新到 2026-05-14 | `static/changelog.json`：`latest_version=2026.05.14` |
| 耗材类 P5 已到最后验收段 | `docs/superpowers/audits/2026-05-13-portability-assessment-v2.md`：P5.1/P5.2/P5.3/P5.5 DONE，P5.6 待启动 |
| AI 生图引擎已统一 | `static/changelog.json` 2026.05.13.3；`ai_image_router.py` 中 `DEFAULT_IMAGE_ENGINE` |
| 平台 Key 砍刀流已落地 | `AGENTS.md` P3 说明；`tests/test_p3_invariants.py` 守护测；`app.py` 读取平台 env |
| 批量阶段进度已实现 | `batch_processor.py` `_publish_stage()` + `BatchItem.current_stage` |

## Agent Team 独立审查

2026-05-27 已调用独立 agent 做只读项目进度审查。结论与当前基线一致：

- 项目主体是 Flask/Jinja/Playwright/AI 批量详情图系统，当前小机部署形态仍以 SQLite + memory pubsub 为主；`docker-compose.yml` 中 PG/Redis full profile 属于阶段七预备，不代表已切换生产链路。
- agent 审查时工作区未提交变更为 1 个修改文件 + 9 个新增文件；其中上传 UX 快赢已实现，P5.6 验收模板和阶段七清单属于规划/验收资产。
- 当前在此基础上新增了 `docs/2026-05-27_commit-manifest.md`、`docs/2026-05-27_handoff-index.md`、`docs/2026-05-27_next-action-tracker.md`、`docs/2026-05-27_decision-brief.md`、`docs/2026-05-27_python-flask-env-recovery-options.md`、`docs/2026-05-27_upload-ux-browser-validation-report.md`、`docs/2026-05-27_upload-ux-browser-validation-runbook.md`、`scripts/check_local_dev_env.ps1`、`scripts/bootstrap_local_dev_env.ps1`、`scripts/make_upload_ux_sample.ps1`、`scripts/verify_2026_05_27_commit_manifest.js`、`scripts/verify_2026_05_27_handoff_all.ps1` 和 `scripts/verify_2026_05_27_planning_paths.js`，因此最新工作区状态为 1 个修改文件 + 22 个新增文件。
- 上传 UX 仍缺真实浏览器 `/batch/upload` 手测闭环；P5.6 仍缺真实样本、费用授权与端到端结果；阶段七仍不应在未命中性能/并发触发条件时贸然执行。
- agent 审查曾提示 `scripts/verify_batch_upload_ux_all.js` 需同步进规划文档；本基线已补齐文件清单、提交拆分与验证记录。
- 最新 agent team 只读审查已复核三项拍板入口、选 2 环境恢复路径、登录边界和 commit manifest；结论是材料足够支持用户拍板。审查后已补清“B 上传 UX 快赢验证”对应三项拍板里的“2. 先恢复 Python/Flask 环境”，并在 `docs/2026-05-27_handoff-index.md` 与 `docs/2026-05-27_decision-brief.md` 标明：当前最稳路线是先选 1 固化当前工作区，再选 2 闭环上传 UX；如果更急于验证上传体验，也可以直接选 2。

## 当前剩余主线

### A. P5.6 耗材类端到端验收

状态：待启动。

目标：
- 跑通 1 个真实耗材类 demo 端到端链路。
- 记录成本、耗时、输出图质量、失败点和是否可作为客户 demo。
- 验证 5 月 13-14 的耗材类调性改动确实带来品类辨识度。

前置：
- 需要真实耗材产品资料与图片。
- 需要用户明确授权真测费用，历史估计为约 ¥5-10。
- 本机需要可运行 Python/pytest，或改用已有服务器/可运行环境。

建议输出：
- `docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md`
- 内容包括样本、命令/入口、结果截图路径、成本、问题、结论。
- 当前已创建验收报告模板：`docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md`

### B. 批量上传 UX 快赢

状态：已实施，无依赖静态/语法/运行时 smoke 均通过，待真实浏览器手动验证。

已完成迹象：
- 每产品阶段进度事件已在 `batch_processor.py` 发布。
- 进度 UI 接管有 `tests/test_batch_progress_ui.py` 守护。

已实施：
- 文件夹 picker 点击穿透：给 `.picker .icon/.hint/.sub` 加 `pointer-events: none`，并加 click 兜底。
- 上传进度条 + ETA：将 `/api/batch/upload` 上传从 `fetch` 切到 `XMLHttpRequest`，使用 `xhr.upload.onprogress`。
- 新增 `tests/test_batch_upload_ux.py` 源码守护测。

价值：
- 不花 API 钱。
- 用户感知强，尤其 80MB+ 批次上传时能减少“卡死”错觉。
- 可以在 P5.6 前或后独立做。

风险：
- 需要前端手动验证文件夹选择弹窗和上传流程。
- 当前本机 Python 不可用，守护测需要先恢复运行环境。

当前已创建并执行实施计划：`docs/2026-05-27_upload-ux-quick-win-plan.md`

真实浏览器验收步骤已拆成 runbook：`docs/2026-05-27_upload-ux-browser-validation-runbook.md`

### C. 阶段七硬件/PG/Redis/自愈

状态：待启动，且受实际并发/性能触发。

触发条件来自 `PROJECT_STATUS_批量生成.md`：
- 2C2G 下单批 >= 5 产品且 > 10 分钟。
- swap > 500MB 持续 5 分钟。
- 用户主观反馈“卡”达到多次。

优先子项：
- 升 4C8G 前备份。
- 升配后同步 `docker-compose.yml` 内存/并发池。
- 僵尸批次自愈：`reset-stuck-items` 端点 + UI 按钮 + processing 超时重置。
- PG/Redis 接入只在多 worker/多用户需要上来后推进。

当前已创建预备清单：`docs/2026-05-27_phase7-readiness-checklist.md`

### D. P6 配件类/工具类扩展

状态：可规划，但建议不要抢在 P5.6 验收前正式开干。

原因：
- P5 耗材类最后缺的是“真实出货验证”，如果没过，P6 会继承未知问题。
- 5 月审计明确提醒：audit 建议可能过期，实施前必须重新 grep 当前代码。

## 推荐决策顺序

1. 先选是否收口 P5.6。
   - 如果有真实耗材样本和真测授权，就做 P5.6。
   - 如果没有样本或暂不想花钱，就先把 B 的浏览器手动验证收掉。

2. P5.6 通过后，再定 P6 或阶段七。
   - 客户 demo 优先：开 P6。
   - 性能/稳定优先：开阶段七自愈与部署地基。

3. 所有涉及花钱、prod、deploy、DB、真实 API 大额调用的动作继续 stop-and-ask。

## 当前决策面板

| 选择 | 适用条件 | 下一动作 | 是否需要授权 |
|---|---|---|---|
| A. 收口 P5.6 耗材类真测 | 已有真实耗材样本，愿意烧 ¥5-10 | 填 `2026-05-27-p5-6-consumable-e2e.md`，先 dry-run，再等授权真测 | 真测需要 |
| B. 闭环 UX 快赢验证 | 暂无样本或暂不花钱 | 恢复 Python/Flask 环境，用本地测试账号登录后打开 `/batch/upload` 手测 picker + 上传进度 | 不需要花钱；启动本机服务不需要 prod 授权；不使用生产账号或生产密码 |
| C. 继续做 UX 第二刀 | 上传体验仍是近期痛点 | 做客户端图片压缩 opt-in 或打包进度细化 | 不需要花钱 |
| D. 阶段七预备 | 已命中性能/并发触发条件 | 按 `2026-05-27_phase7-readiness-checklist.md` 从只读盘点开始 | 升配/生产操作需要 |
| E. P6 扩品类 | P5.6 通过且客户 demo 要扩类目 | 重新 audit 当前配件/工具代码，再写 P6 plan | 代码规划不需要；真测需要 |

推荐下一步：**B. 闭环 UX 快赢验证**。原因是代码已实现且已有无依赖静态/语法/运行时 smoke 验证，只差真实浏览器手测；它不花钱，也不碰生产，是当前最短闭环。

## 本轮交接摘要

本轮已经完成“状态对齐 + 下一步规划 + 一项低风险体验改进”的组合推进：

1. 现状对齐：
   - P5 耗材类剩余主线是 P5.6 端到端真测。
   - 阶段七仍待触发，不应在没有性能/并发压力时贸然上 PG/Redis。
   - 本机完整 pytest / Flask 启动受 Python 环境缺失影响。

2. 已落地规划材料：
   - 项目交接索引。
   - 下一步行动追踪表。
   - 提交清单。
   - Python/Flask 环境恢复选项说明。
   - P5.6 耗材类端到端验收模板。
   - 批量上传 UX 快赢实施计划。
   - 阶段七硬件 / PG / Redis / 自愈预备清单。
   - 当前决策面板。

3. 已实现代码改动：
   - 批量上传 picker 点击稳定化。
   - 批量上传改用 XHR，新增上传百分比、速度和 ETA。
   - 保留后端错误文案，便于定位失败。

4. 已落地验证入口：
   - pytest 源码守护测：`tests/test_batch_upload_ux.py`。
   - 无 pytest 静态验证：`scripts/verify_batch_upload_ux_static.py`。
   - 无 Flask JS 语法验证：`scripts/verify_batch_upload_inline_js_syntax.js`。
   - 无 Flask 运行时 smoke：`scripts/verify_batch_upload_runtime_smoke.js`。
   - 无依赖一键验证入口：`scripts/verify_batch_upload_ux_all.js`。
   - 本地开发环境只读探针：`scripts/check_local_dev_env.ps1`。
   - 授权后本地 `.venv` bootstrap 草案：`scripts/bootstrap_local_dev_env.ps1`。
   - 上传 UX 本地手测素材生成：`scripts/make_upload_ux_sample.ps1`；当前 `test_batch_input/upload_ux_sample` 已生成，且 `test_batch_input/` 仍被 git 忽略。
   - commit manifest 覆盖检查：`scripts/verify_2026_05_27_commit_manifest.js`。
   - 本轮交接一键检查：`scripts/verify_2026_05_27_handoff_all.ps1`。
   - 规划路径一致性检查：`scripts/verify_2026_05_27_planning_paths.js`。

5. 已通过验证：
   - 上传 UX 静态验证通过。
   - 上传页内联 JS 语法编译通过。
   - 上传页运行时 smoke 通过，覆盖 picker、进度文案、成功路径、后端错误路径。
   - 相邻批量进度 UI 源码守护断言通过。

6. 未闭环事项：
   - 恢复 Python/Flask 环境。
   - 启动本地 app，用本地测试账号登录，并做 `/batch/upload` 真实浏览器手测。
   - 如需提交/PR，先决定是否把本轮文档和 UX 快赢作为一个提交。

## 下一步可执行包

### 包 1：P5.6 验收包

- 准备 1 个耗材类样本。
- 写验收报告模板。
- 跑 mock/dry-run 验证入口。
- 用户授权后跑真实 API。
- 记录结论：通过 / 需修 prompt / 需修模板 / 需修流程。

### 包 2：UX 快赢包

- 修 picker 点击穿透。
- 加上传进度条、速度和 ETA。
- 加守护测扫描关键实现。
- 本地浏览器手测上传 UI。

### 包 3：阶段七预备包

- 写升级前检查清单。
- 设计僵尸批次自愈端点和 UI。
- 明确哪些操作必须 prod 授权。

## 当前阻塞/注意

- 本机没有可用 `python` / `py` / `pip` 命令，仓库内也没有 `.venv` / `venv` / `python.exe` / `pytest.exe`。要运行完整 pytest 或启动 Flask，需要先恢复 Python 入口、创建虚拟环境，或切到已有可运行环境。
- Codex 捆绑 Python 可执行，但缺少项目依赖和 pytest；它只能用于标准库级脚本/源码守护断言，不能直接启动 Flask。
- 真实耗材类端到端验收会烧 API 费用，必须等用户授权。
- 当前规划文档不代表自动执行 deploy、prod DB 修改或花钱真测。

## 当前工作区变更

截至 2026-05-27，本轮 goal 已产生以下未提交变更：

| 文件 | 状态 | 用途 |
|---|---|---|
| `templates/batch/upload.html` | 修改 | 批量上传 UX 快赢：picker 稳定点击 + XHR 上传进度 |
| `tests/test_batch_upload_ux.py` | 新增 | 上传 UX 源码守护测 |
| `scripts/verify_batch_upload_ux_static.py` | 新增 | 无 pytest 依赖的上传 UX 静态验证 |
| `scripts/verify_batch_upload_inline_js_syntax.js` | 新增 | 无 Flask 依赖的上传页内联 JS 语法检查 |
| `scripts/verify_batch_upload_runtime_smoke.js` | 新增 | 无 Flask 依赖的上传页运行时 smoke，覆盖进度/成功/后端错误/按钮恢复 |
| `scripts/verify_batch_upload_ux_all.js` | 新增 | 一键运行当前可用的无依赖上传 UX 验证 |
| `scripts/check_local_dev_env.ps1` | 新增 | 只读检查本机 Python/Node/venv/Flask/pytest/Playwright 状态，并单独报告 Codex 捆绑 Python |
| `scripts/bootstrap_local_dev_env.ps1` | 新增 | 授权后创建/更新本仓库 `.venv` 并安装本地 Flask 验证依赖 |
| `scripts/make_upload_ux_sample.ps1` | 新增 | 生成不含真实客户数据的上传 UX 本地手测素材 |
| `scripts/verify_2026_05_27_commit_manifest.js` | 新增 | 确认当前 `git status` 文件均被提交清单覆盖 |
| `scripts/verify_2026_05_27_handoff_all.ps1` | 新增 | 一键运行本轮交接检查 |
| `scripts/verify_2026_05_27_planning_paths.js` | 新增 | 检查 2026-05-27 规划交接材料引用的关键路径存在 |
| `docs/2026-05-27_commit-manifest.md` | 新增 | 当前工作区建议提交清单，含选 1 命令草案 |
| `docs/2026-05-27_handoff-index.md` | 新增 | 本轮交接材料入口索引 |
| `docs/2026-05-27_next-action-tracker.md` | 新增 | 下一步行动、授权要求和完成证据追踪 |
| `docs/2026-05-27_next-planning-baseline.md` | 新增 | 项目当前规划基线与决策面板 |
| `docs/2026-05-27_decision-brief.md` | 新增 | 下一轮规划拍板用短简报 |
| `docs/2026-05-27_python-flask-env-recovery-options.md` | 新增 | Python/Flask 本地环境恢复选项与授权边界 |
| `docs/2026-05-27_upload-ux-browser-validation-report.md` | 新增 | 上传 UX 浏览器验收结果模板 |
| `docs/2026-05-27_upload-ux-quick-win-plan.md` | 新增 | 批量上传 UX 快赢实施计划与记录 |
| `docs/2026-05-27_upload-ux-browser-validation-runbook.md` | 新增 | 上传 UX 真实浏览器验收步骤 |
| `docs/2026-05-27_phase7-readiness-checklist.md` | 新增 | 阶段七预备清单 |
| `docs/superpowers/audits/2026-05-27-p5-6-consumable-e2e.md` | 新增 | P5.6 耗材类端到端验收模板 |

## 建议提交拆分

详见 `docs/2026-05-27_commit-manifest.md`。

当前更推荐 **一个提交**，因为交接索引、路径检查、一键检查、上传 UX runbook 互相引用；强拆多个 commit 时，中间 commit 容易出现“文档引用的脚本还不存在”或“路径检查脚本缺文件”的状态。

提交清单已包含选 1 命令草案；仅在用户明确选择 1 后执行，执行前仍需先跑一键交接检查，且不得包含 `test_batch_input/`。

建议提交信息：

```text
chore: add upload ux handoff and validation baseline
```

已完成验证：

- `scripts/verify_batch_upload_ux_static.py`：通过，输出 `batch upload UX static checks passed`。
- `scripts/verify_batch_upload_inline_js_syntax.js`：通过，输出 `compiled inline scripts: 1`。
- `scripts/verify_batch_upload_runtime_smoke.js`：通过，输出 `batch upload runtime smoke passed`。
- `scripts/verify_batch_upload_ux_all.js`：通过，输出 `compiled inline scripts: 1`、`batch upload runtime smoke passed`、`using Python static verifier: C:\Users\Scott\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`、`batch upload UX static checks passed`、`stdlib source guard tests passed: 10 tests across 2 files`、`all batch upload UX checks passed`；当前环境未找到 PATH Python 时，会回退到 Codex 捆绑 Python 跑标准库静态检查和源码守护测；一旦找到 Python，这些 Python 检查失败会让 wrapper 失败退出。
- `scripts/check_local_dev_env.ps1`：通过执行，只读确认当前 PATH 下 `git` 与 `node` 可用、`python/py/pip` 不可用，仓库内无 `.venv/venv` Python；同时输出 `common Python candidates: MISSING`，确认常见本机 Python 安装目录没有可直接复用的 `python.exe`；输出 `docker: MISSING` / `docker-compose: MISSING`，确认当前 Docker/Compose 路线不能直接执行；同时输出 `Codex bundled Python: OK`，报告 Codex 捆绑 Python 可用于标准库静态检查但不是项目 Flask 环境；用该 Python 跑 import 探针时 `flask` / `pytest` / `playwright` 均为 MISSING，可作为恢复本地环境前的基线。
- `scripts/verify_2026_05_27_handoff_all.ps1`：通过，串联本地环境探针、Codex 捆绑 Python 依赖边界探针、PowerShell 语法检查、bootstrap plan-only 安全检查、规划路径检查、commit manifest 覆盖检查、上传 UX 轻量检查、`git diff --check`、敏感/本地素材路径护栏、当前 status 文件敏感内容扫描和 `git status --short`；bootstrap 安全检查输出 `bootstrap local dev env plan-only OK`，确认默认模式不创建 `.venv`、不安装依赖、不联网；敏感内容扫描输出 `sensitive content scan OK: current status files`；当前无 PATH Python 时，脚本仍使用 Codex 捆绑 Python 完成可选静态检查，并打印所用 Python 路径；依赖边界探针输出 `Codex bundled Python dependency probe`、`flask: MISSING`、`pytest: MISSING`、`playwright: MISSING`；提交清单覆盖检查输出 `commit manifest covers git status (23 paths); command draft matches manifest (23 paths)`；本地手测素材护栏输出 `test_batch_input is ignored by git`、`upload UX sample path exists: test_batch_input\upload_ux_sample`、`upload UX sample content OK: 2 product dirs, 6 product files`、`upload UX sample product dirs OK: sample-product-a, sample-product-b`、`upload UX sample product files OK: main.png, detail-1.png, info.txt`、`upload UX sample product files are non-empty`、`upload UX sample PNG headers OK: main.png, detail-1.png` 和 `upload UX sample info markers OK: synthetic sample, no real customer data`；脚本尾部输出 `worktree summary: 1 modified, 22 untracked, 23 total`、`handoff verification passed`、`recommended route:`、`1 first: commit current worktree to freeze handoff and validation assets`、`2 next: restore Python/Flask environment and browser-test /batch/upload`、`next decision options:`、`1. commit current worktree`、`2. restore Python/Flask environment`、`3. planning only; no code/install/network/API`、`entry docs:`、`commit: docs/2026-05-27_commit-manifest.md`、`environment: docs/2026-05-27_python-flask-env-recovery-options.md`、`actions: docs/2026-05-27_next-action-tracker.md`，用于直接进入下一步拍板。
- `scripts/verify_2026_05_27_planning_paths.js`：通过，确认 25 个规划交接关键路径存在，且核心文档包含必要锚点；当前也守护 agent team 最新审查结论、“B 对应选 2”口径、最稳路线说明和选 2 最小执行顺序入口。
- `tests/test_batch_upload_ux.py`：用 Codex 捆绑 Python 标准库 runner 直接执行 6 个 `test_` 方法，通过。
- `tests/test_batch_progress_ui.py`：用 Codex 捆绑 Python 标准库 runner 直接执行 4 个 `test_` 方法，通过。
- `git diff --check`：通过，仅有 Windows 换行提示。
- 提交前敏感路径/密钥词扫描：未发现本轮新增 `.env` / `instance/` 实文件或真实密钥；命中项仅为文档中的授权边界说明、验收清单占位 env 名，以及 `templates/batch/upload.html` 既有 `ark_api_key` localStorage 逻辑。
- 新增/引用路径存在性检查：本轮列出的 25 个关键文件均 `OK`。

未完成验证：

- 完整 `pytest`：本机无可用 pytest。
- Flask 本地启动：当前 Python 环境缺 Flask 依赖。
- 浏览器手动验证：需恢复可运行环境后，用本地测试账号登录并打开 `/batch/upload`。本轮曾尝试连接 Codex in-app browser，但当前浏览器 runtime 未能启动；这不是页面代码报错，仍以后续真实浏览器手测为准。

## 验证环境恢复建议

任选其一：

详见 `docs/2026-05-27_python-flask-env-recovery-options.md`。任选其一：

1. 修复系统 PATH，让 `python` / `pip` 指向项目使用的 Python 3 环境。
2. 在仓库内创建 `.venv`，安装 `requirements.txt` 和 pytest。
   - 授权后可执行 `powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall`。
3. 切到已经部署好依赖的服务器/开发机运行验证。

恢复后优先运行：

```bash
python -m pytest tests/test_batch_upload_ux.py tests/test_batch_progress_ui.py -q
python -m pytest tests/test_batch_pipeline_smoke.py -q
```

在 pytest 不可用但有 Python 的环境中，可先运行无依赖静态验证：

```bash
python scripts/verify_batch_upload_ux_static.py
node scripts/verify_batch_upload_inline_js_syntax.js
node scripts/verify_batch_upload_runtime_smoke.js
node scripts/verify_batch_upload_ux_all.js
node scripts/verify_2026_05_27_planning_paths.js
powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1
powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1
```
