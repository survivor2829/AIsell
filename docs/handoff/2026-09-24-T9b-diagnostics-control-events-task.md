# T9b 诊断补强：暂停/继续/关窗日志、微信版本、summary.json、保留期

分支：`codex/diagnostics-control-events`

**开始时机**：T9a、T6b、T7a 都合并后再开始。
- 本卡会扩展 T9a 的分析脚本。
- T6b 改 `retryTask` / `retrySkipped`（`wechat-workflow.cjs:717-748`、`:777-786`），新增 `andStart` 和 `retryAll()`，并在卡里写明"继续/重新加入的完整日志留给 T9"。
- T7a 改 `start`（:855-873）。

**与其他卡的文件重叠**（都是不同代码块，按合并顺序 rebase）：
- `wechat-workflow.cjs`：T6b（retry 相关函数和新增 `retryAll`）、T7a（:264-273、:383-389、:456-487、:855-873）、T7b（`afterMoments` 透传）。
- `wechat-workflow.self_check.cjs`：T4（可能）、T6b、T7a、T7b。
- `wechat-workflow-ipc.cjs`：T6b。
- `main.cjs`：C1 改 :641-645；B1b、B1c、B3a、B3b、B4b、B4c 改视频注册块（:647-698）。本卡只改 :269-276、:363-375、:537、:845-849。
- 窗口驱动的自检写在 `wechat_window_layout.self_check.cjs`，不写 `rpa/active_touch/self_check.cjs`，那个文件 T8 在改。
- 不改 `touch-workflow.cjs`，与 T4、T5、T6a、T8 无重叠。

行号均指 HEAD `258e37a`。T6b、T7a 合并后会偏移，以函数语义为准。

## 背景

9-23 包暴露的诊断缺口见 wechat-logs 报告第 6 节，已逐条复核：
- **暂停、继续（`retryTask`）、关窗不进日志。** 暂停时间只能从自动回复日志间接推出；"继续"只能从"启动时 pending=1"反推。
- **`summary.json` 看不出微信版本。** 9-22 16:46 微信从 4.1.13.65 升到 4.1.15.13，只是被联系人同步事件偶然记录下来。
- **导出文件名不带版本。** 多个包混在微信文件夹里分不清。
- **30 MB 轮转只保留约 2.2 天。** 9-23 包实测：首行 9-20 15:01，末行 9-22 20:20，本 run 前 15316 行已被覆盖；其中 58.2% 的行是 `send_stage`（96% 为 info 级）。
  - 日志压缩比约 18:1：6 个文件共 28.7 MB，在 zip 里只占 1.6 MB。包的主要体积是 33.3 MB 的 PNG。

本卡不做的两项：
- "重新加入"已有日志（`touch.skipped_requeued`，`wechat-workflow.cjs:738`），不用补。
- run-bill 的规则号属于 T5 第 5 项。

## 现状（HEAD 258e37a，已核对）

### 1. 工作流控制（`desktop/src/main/wechat-workflow.cjs`）

- `:707-715` 的 `pauseWorkflow` 不写日志。`:720` 的 `retrySkipped` 内部也会调用它。
- `:777-786` 的 `retryTask` 不写日志。
- `:875-879` 的 `dispose` 不写日志。
- `:856` 的 `start` 在 begin 时只带 `stage`、`pending_count`、`reply_enabled`，没有记录启动前的 phase。
- `status()`（:245-262）不是只读的，有两个副作用：
  - 先跑 `reconcileUnknownResolutions`（:190-204），可能把 `enabled` 改成 false、`phase` 改成 paused 并写盘；
  - 再经 `skippedTouchState`（:149-153）走到 T4 描述的恢复竞态。
- `pauseWorkflow` 自己也会调用 `status()`：:710、:713 的 `emit()`（:91），以及 :714 的返回值。本卡不改这一点。

### 2. 关窗与退出

- `main.cjs:270` 关主窗时调用 `diagnostics().event("app", "window_closing")`。这条是 info 级且没有 trace，会被 `diagnostics.cjs:278` 直接丢掉：代码写了，但从来没有落盘。
- `main.cjs:845` 的 before-quit 没有日志。它会触发两次，第二次由 :846 的 `quitCleanupComplete` 直接返回。
- 悬浮窗关闭会被改成回到主窗（`wechat-workflow-ipc.cjs:60-62`），也没有日志。
- 关主窗时 `auto_reply` 日志会记 `paused|app_closed`（`main.cjs:272`），9-23 包有 4 条。这是目前唯一的间接证据。

### 3. 微信版本

- 目前只有联系人同步会写 `wechat_version`（`contact-sync-ipc.cjs:155` 的 `capture_progress`，`:176` 的 `executor.*`）。
  - 9-23 包 75 行带这个字段，其中 16 行是空值，被脱敏成 `{present:false,…}` 对象，不是字符串。
- 精准触达每一步都会跑窗口驱动：
  - 驱动已经拿到窗口进程的 `processPath`（`desktop/rpa/active_touch/wechat_window_driver.cjs:765-777`）；
  - 在 `:934-935` 选定窗口后会写 `window_class_code`，但没有取版本；
  - `:937` 的 `Set-WechatWindowStage`（定义在 :470-478）把整个 `$windowDiagnostic` 写到 stderr，所以在 :935 之后赋值就会被带出。
- 窗口诊断字段经 `desktop/src/shared/wechat-window-diagnostics.cjs:9-44` 的白名单，再经 `wechat-send-diagnostics.cjs:59,122`，进入 `prepare_window` 那条 `send_stage` 的详情。9-23 包中这条详情里有 `window_class_code: "Qt51514QWindowIcon"`。
- 同一个白名单也被 `src/shared/cloud-report.cjs:24` 用来生成云端报告。
- 不能在导出时起 PowerShell 取版本：`diagnostics-ipc.self_check.cjs:251` 断言导出过程 `spawnCalls === 0`。

### 4. `summary.json`（`diagnostics-ipc.cjs:309-315`）

已有：
- `build`，来自 `build-edition.json`，其中含 `edition`；
- `diagnostics.environment.displays`，是启动时的快照，含 `scale_factor`（`main.cjs:384-393`）。

缺的：
- 业务版本、底座版本、组件代次在顶层看不到。
- 通用脱敏把一些键摘要成了 `{present,length,sha256_16}`：
  - `environment.app` 里的 `name`、`edition`、`build_id`、`build_commit`；
  - `environment` 顶层的 `electron`、`chrome`、`node`、`os_version`、`locale`、`timezone`。

  原因在 `diagnostics.cjs:25,103-109`：只有键名以白名单后缀结尾、值又是简单标识符的字符串才原样保留（`os_version` 是值里有空格）。`environment()` 的构造在 `:425-443`。9-23 包就是这样。
- 没有导出时刻的显示器快照。
- 没有最新反馈 ID。
- 没有日志覆盖范围。

另有一个问题：`buildInfo`（`diagnostics-ipc.cjs:44-57`）按 `dist → dist-pilot → dist-development` 的顺序读标记，源码运行时可能读错版本类型。版本类型应以 `edition.cjs` 的运行时判断为准。

### 5. 文件名

`diagnostics-ipc.cjs:291` 生成 `${displayName}-诊断日志-${ISO}.zip`，没有版本。

### 6. 保留

- `diagnostics.cjs:9-10`：`MAX_BYTES = 5 MB`，`MAX_ARCHIVES = 5`。
- 这两个是常量，不能注入，自检覆盖不到轮转数量。

## 要做

### 1. 控制事件（`wechat-workflow.cjs`）

都用现有的 `log(...)` 或 `options.logger.begin`，并带 `trace: true`。

- **暂停**：`pauseWorkflow(trigger = "user")`
  - 开始时调用 `begin("wechat_workflow", "pause", { stage: "control", trigger_code, previous_phase, in_flight }, { trace: true })`；
  - 等在途步骤结束后调用 `end({ stage: "paused" }, { ok: true })`，耗时就是等待在途步骤的时长；
  - `await inFlight` 或 `reply.pauseWorkflow` 抛错时调用 `fail(error)`，再原样抛出，不改原有的控制流；
  - `retrySkipped` 内部的暂停（HEAD :720）传 `retry_skipped`；T6b 新增的 `retryTask`、`retryAll()` 内部暂停分别传 `retry_task`、`retry_all`；
  - IPC 的 `pause` 保持无参，即 `user`。
- **继续**：`retryTask` 成功把任务改回 pending 后，记 `task.retry_requested`，code 为 `retry_task_requested`。字段：
  - `stage: "control"`、`task_kind`、`task_id`
  - `previous_status`
  - `reason`：原 `reasonCode`
  - `and_start_requested`：布尔值，对应 T6b 的 `andStart`

  T6b 的 `retryAll()` 成功后记一条 `task.retry_all_requested`，只含计数：`task_count`、`contact_count`、`excluded_count`、`and_start_requested`。

  被拒绝时已有 `action.failed`（`wechat-workflow-ipc.cjs:175`），不重复记。
- **启动**：`start` 的 begin 详情加 `previous_phase`。
- **退出**：`dispose` 记 `control.disposed`，字段为 `trigger_code: "app_quit"`、`previous_phase`、`in_flight`。
- **状态快照**：新增无副作用的 `controlSnapshot()`，只读闭包变量，返回 `{ enabled, phase, in_flight }`，给关窗和退出日志用。
  - IPC 层（`wechat-workflow-ipc.cjs:216-224`）用 `...controller` 展开，`main.cjs` 可以直接调用 `workflowController?.controlSnapshot?.()`。
  - **不得在关窗/退出日志里调用 `status()`**，原因见现状第 1 条：可能改状态、写盘，还会经 `skippedTouchState → describeSkippedWorkflowTask → loadWorkflowTask` 触发 T4 的恢复竞态。

### 2. 关窗与退出

- `main.cjs:270`：加上 `{ trace: true }`，详情加 `workflow_phase`、`workflow_enabled`，值取自 `controlSnapshot()`。
- `main.cjs:845-849`：在 `quitCleanupStarted = true` 之后记 `app/quit_requested`，字段同上。
- `wechat-workflow-ipc.cjs:60-62`：悬浮窗关闭被改为回主窗时，记 `floating.close_redirected`，带 `workflow_phase`。

### 3. 微信版本

- 在 `NORMALIZE_WECHAT_WINDOW_SCRIPT` 里新增独立函数 `Get-WechatFileVersion([string]$path)`：
  - 用 `[Diagnostics.FileVersionInfo]::GetVersionInfo($path)`，拼 `FileMajorPart.FileMinorPart.FileBuildPart.FilePrivatePart`。不直接用 `FileVersion` 字符串，系统文件的这个字符串常带 ` (WinBuild…)` 后缀；
  - 整段包在 try/catch 里（脚本是 `$ErrorActionPreference = "Stop"`）；路径为空、文件不存在或结果不匹配 `^\d+(\.\d+){1,3}$` 时返回空串。
- `wechat_window_driver.cjs:934-935`：选定窗口后调用 `Get-WechatFileVersion $matched.processPath`。
  - 结果非空才写入 `$windowDiagnostic.window_wechat_version`；
  - 取不到时不写这个字段，也不影响选窗结果；
  - 不把路径写进任何字段。
- `wechat-window-diagnostics.cjs` 的白名单加 `window_wechat_version`，校验用同一个正则。
- 云端不用部署：
  - 客户端 `cloud-report.cjs:24` 复用这个白名单，所以云端报告里也会带上版本号；
  - 维护服务按白名单取字段，未知字段直接丢弃（`server/maintenance/service.py:98,130`）。本卡不改服务端。

### 4. `summary.json`（`diagnostics-ipc.cjs`）

新字段直接按显式白名单构造，**不经过 `sanitizeValue`**，否则 `edition` 这类键又会被摘要化。
- 不走脱敏，就要逐字段校验，不合格的写 `null`：
  - 版本：`^\d+\.\d+\.\d+$`；
  - `build_id`：`^[0-9A-Za-z._-]{1,64}$`；
  - `build_commit`：`^[0-9a-f]{7,40}$`；
  - 枚举值只收列出的取值；
  - UUID、64 位十六进制按各自格式。
- 原有的 `build`、`diagnostics` 两块保持不变，兼容 T9a 的脚本和旧的阅读习惯。新 `app.edition` 以运行时判断为准。

- **`app`**
  - 字段：
    - `version`：业务版本；
    - `base_version`：`app.getVersion()`；
    - `edition`：development | pilot | unknown；
    - `data_profile`：test | delivery | unknown，与 `main.cjs:211-214` 一致；
    - `build_id`、`build_commit`、`source_dirty`、`packaged`；
    - `component`：取 `global.__xiaoxiComponents` 的 `version`、`id`（64 位十六进制或 null）、`healthy`，不含路径。
  - 来源：把 `main.cjs:366-374` 已有的 appInfo 对象提成常量，同时传给 `configureDiagnostics`，以及 `main.cjs:537` 的 `registerDiagnosticsIpc` 新参数 `appInfo`。再由 :338 透传给 `exportBundle`。
- **`wechat`**
  - 扫描本次打包的 `diagnostics.jsonl*`，取 `window_wechat_version` 和 `wechat_version` 的最近一个值、对应时间和来源（`window_driver` 或 `contact_sync`）；
  - 只收匹配版本正则的字符串，跳过被脱敏成对象的空值；
  - 出现过的版本列表：`[{version, first_ts, last_ts, count}]`；
  - 先用字符串预筛（行里含 `wechat_version`）再 `JSON.parse`，不要逐行全量解析 100 MB；
  - 导出时不起任何进程；日志里没有版本时为 `null`。
- **`display`**
  - 导出时刻 `screen.getAllDisplays()` 的快照：显示器数量、主屏，以及每块屏的 `bounds`、`work_area`、`scale_factor`、`rotation`、`internal`；
  - 不带 `label`，它可能是显示器型号；
  - `screen` 由参数注入，默认取 electron。
- **`feedback_latest`**
  - 最新一条反馈的 `id`（UUID）、`created_at`、`delivery`、`status`；没有反馈时为 `null`；
  - 由 `main.cjs` 传入惰性 getter：`feedbackController`（:84 声明）在 `:777` 才创建，晚于 `:537`，发布冒烟模式下始终为 null；
  - getter 取 `feedbackController.status().items[0]`（`feedback-controller.cjs:80-89`，已按新到旧排列），只挑上面四个字段。`delivery` 只收 queued/sending/sent/failed，`status` 按标识符正则校验；
  - **不含反馈正文、分类、上下文和官方回复**。
- **`log_coverage`**
  - 日志文件数、总字节数；
  - 每个 run 的首末 seq 和首末时间；
  - 首 seq 是否 > 1，即是否已被轮转覆盖。

### 5. 文件名

- 格式：`${displayName}-${version}-${data_profile}-诊断日志-${ISO}.zip`。
- version 不匹配 `^\d+\.\d+\.\d+$` 时写 `unknown`。
- 例：`AI获客 V1.0版本-1.1.53-test-诊断日志-2026-09-23T01-46-50-544Z.zip`。

### 6. 保留期

- `MAX_ARCHIVES` 从 5 改为 19，即 20 × 5 MB = 100 MB。按 9-23 的写入速率（约 12.9 MB/天），可以保留约 7 天。
- `createDiagnosticLogger` 支持注入 `maxBytes`、`maxArchives`，默认值就是上面两个常量，供自检使用。
- **不删减 `send_stage`**：日志里判断"步骤开始后进程中断"，直接证据就是成对的 start/finish，这关系到 `outcome_unknown` 的取证。
- 导出包增量不大：按 18:1 的压缩比，日志约增加 4 MB。
- 用 20 × 5 MB 的合成日志跑一次导出，把耗时、`process.memoryUsage().rss` 峰值和 zip 体积写进 result。
  - 耗时超过 20 s，或 RSS 峰值比导出前高出 500 MB 以上，就只报告数据，不自行改导出方式（例如改成流式）。

### 7. 扩展分析脚本（T9a 的 `analyze-diagnostics.cjs`）

- **"人工操作"章节**加入：
  - `pause.*`（按 `trigger_code` 分列）
  - `task.retry_requested`、`task.retry_all_requested`（分别统计 `and_start_requested` 为真的次数）
  - `app/window_closing`、`app/quit_requested`
  - `floating.close_redirected`
  - `control.disposed`
- **"全局暂停与恢复"章节**：
  - 加入手动暂停到下一次 `start.started` 的时长；
  - 使用 `start.started` 的 `previous_phase`。
- **"包概况"章节**：
  - 输出 summary 中新增的 `app`、`wechat`、`display`、`feedback_latest`、`log_coverage`；
  - 按时间列出 `window_wechat_version` 的变化点。
- **旧包**：没有这些事件或字段的旧包照常输出，缺失处注明"该构建未记录"。

## 字段命名注意

`diagnostics.cjs` 的通用脱敏规则：
- 字符串值要原样保留，键名必须以 `action|code|kind|mode|outcome|phase|reason|stage|state|status|type|version…` 结尾（`:25`），值还得是简单标识符（`:108`）；
- 键名含 `path|dir|file|cwd|executable` 的一律摘要化（`:27`）。

所以新字段要用 `trigger_code`、`previous_phase`、`workflow_phase`、`window_wechat_version` 这类名字。不要用 `source`、`edition`、`wechat_file_version`、`data_profile`，这些会被哈希。`profile` 里含 `file`，会命中 `:27`。

另外，`scripts/wechat-failure-policy-review.cjs:7` 会扫描新增行里的 `reason: "<字面量>"`，把它当成未登记的失败原因，CI 会失败。新事件的触发来源一律用 `trigger_code`，不要写 `reason: "app_quit"` 这类字面量。

## 允许改动

- `desktop/src/main/wechat-workflow.cjs`：只加日志和 `controlSnapshot`，不改调度和状态语义
- `desktop/src/main/wechat-workflow-ipc.cjs`：只加 :60-62 一处日志
- `desktop/src/main/main.cjs`：:269-276、:363-375（只把 appInfo 提成常量）、:537、:845-849
- `desktop/src/main/diagnostics.cjs`：轮转常量和注入参数
- `desktop/src/main/diagnostics-ipc.cjs`
- `desktop/rpa/active_touch/wechat_window_driver.cjs`：:934-935 附近取版本
- `desktop/src/shared/wechat-window-diagnostics.cjs`
- `desktop/scripts/analyze-diagnostics.cjs` 及其自检
- 对应的 self_check：
  - `wechat-workflow.self_check.cjs`
  - `diagnostics.self_check.cjs`
  - `diagnostics-ipc.self_check.cjs`
  - 窗口驱动用例：`rpa/active_touch/wechat_window_layout.self_check.cjs`（:47-54 已有切片执行脚本片段的写法）

## 禁止

- 不改暂停、继续、重试、退出本身的行为，只加日志。
- 不改 `outcome_unknown` 的处理、身份核验、`recoverInterruptedTask`、失败分级和规则目录。
- 导出过程不起子进程，保持 `spawnCalls === 0`。
- 截图脱敏、护照策略、云诊断开关都不在本卡范围。
- 新字段不得包含：联系人名、昵称、备注、微信号、聊天或反馈正文、窗口标题、绝对路径、用户名、机器名。
- 自动回复的扫描计数（`reply_idle` 等）不在本卡，归 T7a/T7b。

## 验收（新增断言在当前 HEAD 上必须失败）

### 1. `wechat-workflow.self_check`

- 空闲时调用 `pause()`：出现 `pause.started`（带 `trigger_code: "user"` 和 `previous_phase`）和 `pause.finished`。
- 在途步骤阻塞时暂停：`pause.finished` 要等步骤结束后才出现。
- 由 `retrySkipped` 触发的暂停，`trigger_code` 为 `retry_skipped`；由 `retryTask`、`retryAll()` 触发的分别为 `retry_task`、`retry_all`。
- 对 `needs_attention` 任务执行 `retryTask` 后，出现 `task.retry_requested`，含 `previous_status: "needs_attention"`、原 reason 和 `and_start_requested`。
- `retryAll()` 成功后出现 `task.retry_all_requested`，计数与返回值一致，事件里只有计数和布尔值。
- 全局停机后再 `start()`，`start.started` 的 `previous_phase` 为 `needs_attention`。
- `dispose()` 记 `control.disposed`。
- 调用 `controlSnapshot()` 的前后对比：
  - 执行器桩的 `describeSkippedWorkflowTask`、`describeUnknownWorkflowTask`、`canRetryWorkflowTask` 调用次数都不变；
  - 状态文件内容不变，`onUpdate` 没有被调用。
- 已有的隐私正则（`wechat-workflow.self_check.cjs:135`，`private-customer|private-name|private-script|private-account`）覆盖新事件。
- 暂停过程中 `reply.pauseWorkflow` 抛错：出现 `pause.exception`，错误照样抛给调用方。

### 2. `diagnostics.self_check`

- 注入一个很小的 `maxBytes`，写入足以轮转 25 次的数据后，保留 `diagnostics.jsonl` 和 `.1`–`.19` 共 20 个文件，最旧的被丢弃。
- 沿用 `diagnostics.self_check.cjs:278-287` 的写法：把 `{ window_wechat_version: "4.1.15.13" }` 经 `summarizeSendResult`（与真实 `send_stage` 同一路径）写入日志后，能原样读回。
- 把 `"C:\\Weixin\\Weixin.exe"`、`"Weixin 4.1"` 两个值走同一路径：日志里没有这个字段，而不是被摘要成对象。
- 同一输入经 `cloud-report.cjs` 的 `reportEntry` 后带出版本号，两个非法值不带出。
- 对 `main.cjs` 做源码断言：`window_closing` 和 `quit_requested` 事件都带 `trace: true`，并且附近没有 `status()` 调用。

### 3. 窗口驱动（`wechat_window_layout.self_check.cjs`）

- 按 :47-54 的写法，从 `NORMALIZE_WECHAT_WINDOW_SCRIPT` 切出 `Get-WechatFileVersion` 在 PowerShell 里执行：
  - 对 `$PSHOME\powershell.exe` 返回匹配 `^\d+(\.\d+){1,3}$` 的串；
  - 对不存在的路径和空串返回空串，不抛错。
- 源码断言：:934 之后对 `$matched.processPath` 调用这个函数，结果写入 `window_wechat_version`，而且没有把路径写进 `$windowDiagnostic`。

### 4. `diagnostics-ipc.self_check`

- `showSaveDialog` 收到的 `defaultPath` 文件名包含版本号和 `test`。
- `summary.json` 包含：
  - `app.version`、`app.edition`（明文 `development`，不是摘要对象）、`app.data_profile`、`app.component`；
  - `wechat.version`（来自夹具日志行）和 `versions_seen`；夹具里放一条被摘要成对象的空 `wechat_version`，它不进入列表；
  - `display`（来自注入的 screen），注入的 `label: "private-monitor-label"` 不出现；
  - `feedback_latest`，且夹具反馈正文 `private-feedback-text` 不出现；
  - `log_coverage`。
- 注入不合格的 appInfo（例如 `build_commit: "C:\\Users\\x"`）时，该字段为 `null`。
- 原有断言保持不变：不含绝对路径，`spawnCalls === 0`。

### 5. 分析脚本自检

- 合成数据加入新事件后，"人工操作"和"全局暂停与恢复"两章的输出正确。
- 旧格式数据的输出不变。

### 6. 全量自检

`npm.cmd run check:self` 通过，包括 `wechat-failure-policy-review`。

## 需用户本人验收/授权

- **发布**：随 T6–T9 这一批内部发布，需要用户授权。
- **发布后在异机上检查**：
  - 导出一次诊断包，文件名带版本；
  - `summary.json` 能看到微信版本、DPI、版本类型、最新反馈 ID；
  - 在异机上手动暂停、继续、关窗各一次，脚本输出里能看到对应的事件和时间。
