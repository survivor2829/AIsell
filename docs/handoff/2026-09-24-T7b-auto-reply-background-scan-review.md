# T7b 审查结论：打回（门禁失败 + 1 处安全相关 + 3 处功能回退，在同一分支追加）

审查对象：`codex/auto-reply-background-scan`（80d173e，基线 7d1daa3）

## 已做对

- 顶部第 1 条（首次接管时暂停被覆盖）修好了：探针 Q7 在基线发 1 次，在本分支保持暂停、发 0 次。退回这处修复，新测试会失败。
- 被动观察不抢焦点、不点击、不发送：观察块在 `Open-AutoReplyVisualConversation` 之前就退出，只用 PrintWindow，空闲时不调用窗口准备。发送路径没有改动。
- T7a 的暂停探针（P1、Q1、Q1b、Q2、Q2b、Q4、Q5、Q6c、Q7）全部符合预期，一审、二审的变异集基本都能抓到。
- 每小时统计只有计数，不含身份信息；N09、N10、N15 都有测试；没有删掉任何保护或测试。
- 注意：`wechat_auto_reply_visual_driver.dev.cjs` 不只是开发用。它在发布清单里，也是默认扫描路径（`activeScanMode="visual"`），所以这次改动会随版本发出去。

## 必须修

1. **【门禁】`check:self` 不通过。** `wechat_auto_reply_driver.cjs:1407` 这一行被改动过，行里原有的 `reason: "current_session_baselined"` 没有登记，失败原因审查门禁报"Unclassified"。请在 `workflowPolicies` 里登记。结果文档里写的"check:self 通过"已经不成立。
2. **【安全相关】接管时暂停提前返回，跳过了接管清理。**
   - 位置：`auto-reply-ipc.cjs:3911`。这时 `workflowMode` 已经是 true，但 `discardTestScopeRuntimeState`、`restoreTurnBoundaries`、`primeRetryNeeded = true`、`restoreWorkflowChatSurface = true` 都没执行。下次进来不会再走接管块，这些清理就永远补不上。
   - 审查探针 H2：接管中暂停，再 `resumeWorkflow`。本分支 workflow prime 0 次，基线 1 次。
   - 后果：恢复后扫描时没有新的起始边界，可能把会话里的旧消息当成新消息去回。这一点是推理得出的，没有端到端复现。
   - 修法：暂停返回前照常做完清理，只是不置 `workflowStartPending`。
   - 用例：接管中暂停 → 恢复，断言会重新 prime，旧消息不回复。
3. **【功能】观察时把任何红色未读角标都当成候选**（`wechat_auto_reply_visual_driver.dev.cjs:1829`）。扫描模式只认名单内的角标。只要有一个没免打扰的群、或名单外的人有未读，每次轮询都会触发一次前台扫描，"空闲不抢前台"的目标就落空了。观察时应当用和扫描一样的名单过滤。
4. **【功能】观察返回 `wechat_window_changed`/`wechat_process_changed` 时什么都没重置**（`wechat_auto_reply_driver.cjs:1366`），下次还是走观察。
   - 卡片要求这种情况下，下一次必须是前台扫描。
   - 审查探针 PA（重启微信）：本分支每次轮询都返回 window_changed，并把工作流暂停成需要处理，直到 60 秒一次的定期检查才恢复；基线只错 1 次就恢复。
5. **【功能】用户一直在用电脑时，观察被整个跳过**（`:1363`，超过 60 秒以后）。
   - 结果是用户活跃期间，由新消息触发的扫描永远不会发生（探针 PB：`wechat_user_active` 5 次，观察 0 次）。基线不用等待就能回复。
   - 另外，printwindow_unusable 计数在空闲时不清零，3 次不连续的失败也会关掉观察（探针 PF）。计数应在成功时清零。

## 必须补的测试（变异存活）

- T05：悬浮窗暂停路径的提示文字。
- T09：返回聊天页后的身份核对。
- T11、T12：有待处理状态时强制前台。
- T25：卡片点名的 `visual_sidebar_match_missing`。
- T29：忙或暂停时保留 afterMoments。
- T35：返回聊天页标志要强制前台。
- 空闲观察后 `reply_guards`、`processed`、`pending_observation` 保持不变。
- 第 3–5 条修复各配一条用例。
- PowerShell 部分（T14、T16）如果没法做夹具，至少把判定逻辑挪到 JS 里测。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t7b\`：
- 探针：`WT=<你的工作区> node probe3.cjs`、`probe4.cjs`（同样用 WT）。H2、PA、PB、PF 必须变成预期结果。
- 变异：`WT=<你的工作区> node mutate3.cjs mutations3.json`。上面列出的存活项都要被抓到。
- T7a 的暂停探针和变异集（`scratch\t7a\`、`t7a-r2\`）照旧全部通过。
- `check:self`、`build:test` 都通过。

## 二审（2a76ed3）：通过，已合并（2026-09-27，合并提交 `728bcc7`）

- 一审 5 条必须修都已修好，代码未发现缺陷。
  - 门禁：直接运行，输出 passed。
  - 接管暂停：照常做清理，只是不置"待启动"；探针 H2 能重新 prime，Q7 发 0 次。恢复后不会回复旧消息。
  - 观察只认名单内的角标。
  - window_changed 之后下一次走前台扫描。
  - 用户活跃时仍会观察；PrintWindow 计数在成功时清零。
- 空闲 150 秒（5 秒轮询一次）只抢 2 次前台，基线是 30 次。
- T7a 的暂停探针和变异集全部通过。一审点名的 7 个存活项全部抓到。
- **只缺测试的地方，由 Claude 在基线补上**：
  - R06（安全）：接管时暂停之后，不恢复、直接再走一步，必须仍是暂停、0 次 prime、0 次发送。原测试一暂停就调用 resume，测不到这种情况。
  - T32：定期复查之后，紧接着的一次空闲轮询必须留在后台（`lastForegroundScanAt` 要刷新）。
  - R19：原来的"空闲观察保留回复记录"测试是在空状态上跑的，等于没测。现在先写入真实形状的 reply_guards 和 processed 再比较。
  - 以上三处都能被对应变异抓到。
- 合并版本 `check:self` 87 项、`build:test`、失败原因门禁都通过。
- **已知缺口（低风险，暂不出卡）**：
  - R20：空闲时单独清掉 `pending_observation`，最坏会漏回一条消息，不会发错。接管时本来就会丢弃这一项，所以在 IPC 层很难造出对应的夹具。
  - R05、R03、R09、R13、R15、R16、R18、T18、T04、T34、T37，详见审查脚本 `scratch\t7b-r2\`。
