# T7b 结果：自动回复后台观察与按需返回聊天页

- 分支：`codex/auto-reply-background-scan`；基线：`7d1daa3`。
- 工作流模式新增只读 `observe`：只用 PrintWindow 读取允许名单的未读提示与当前会话消息签名，结果仅为 `ok:false` 的空闲或需前台复核，不返回联系人、消息、签名，不修改视觉基线、待处理队列或屏幕截图偏好。候选仍进入原前台扫描、验证和发送前检查。独立测试模式不启用。
- 前台扫描按未读候选、待处理状态、窗口变化、首次 prime 或每 60 秒复核触发；周期复核要求用户空闲 5 秒。连续 3 次同窗口 PrintWindow 捕获失败后暂停观察，直到下次 prime。窗口位置变化走重新摆放，PID/HWND 变化仍走原有安全处理。
- 返回聊天页由控制器按需置位：首次接管、朋友圈 publish/interact 步骤结束、以及上次扫描出现 `visual_ocr_structure_missing`、`visual_sidebar_match_missing` 或 `wechat_chat_*`。代码里的聊天页原因包括 `wechat_chat_entry_ambiguous`、`wechat_chat_entry_not_found`、`wechat_chat_entry_not_owned`、`wechat_chat_surface_unverified`。导航成功后清标志，prime 导航同样适用。每小时汇总前台原因、观察空闲、导航、被动漏检，不逐次写诊断。
- T7a 二审遗留：首次接管等待旧扫描时的用户暂停优先于待启动；悬浮窗暂停后的回复步骤返回明确的“已暂停”提示。补了第二次退避窗口、人数变化、两种加入名单原因、退避中暂停与明确重启的断言。

## 验证

- `check:self`：完整通过，包含视觉驱动、扫描驱动、自动回复控制器、工作流与原因码规则检查。之后补充了定向断言、缺失视觉驱动的安全回退及前台原因标记；受影响的定向自检均再次通过。
- `build:test`：通过；Vite 提示现有的大于 500 kB chunk。
- T7a 审查 `probe.cjs`：P1 退避中暂停后发送 0 次；其余 P2–P5 符合预期。二审 `probe2.cjs`：Q7 接管等待中暂停，最终暂停、发送 0 次；Q1/Q2 退避暂停后发送 0 次，Q1b/Q2b 明确重启后各发送 1 次；D1 两个退避窗口各记一条，D2 排除人数 1→2 各记一条。
- 原审查 `mutate.cjs mutations.json`：M01–M31 全部被自检检出。二审 `mutations2.json`：可套用的 N05–N16 均被检出，新增断言明确检出 N06、N09、N10、N15；N01–N04 的旧替换片段因新增暂停代数和提示文本而无法匹配，脚本报 `SETUP-ERROR`，并非变异存活。变异脚本结束后源码恢复。
- 单独移除首次接管的暂停代数判断（Q7_REVERT）：新增自检从“paused”变成“running”并失败；脚本已恢复源码。
- `git diff --check` 与视觉 PowerShell 脚本解析：通过。

未操作真实微信、未发送真实消息、未发布。真实账号下的 30 分钟前台次数、已打开及未打开会话的回复延迟、最小化恢复和朋友圈返回聊天页，留待用户指定测试账号及联系人后验收。PrintWindow 落后一帧时当前会话可能等待最多约 60 秒周期复核；是否调整周期由真实验收决定。

## 一审返修（同分支追加，未变基）

- 在 `workflowPolicies` 登记 `current_session_baselined`。首次接管等待期间即使用户暂停，仍完成旧测试态清理、发送边界恢复、重新 prime 标记和聊天页恢复标记；暂停优先，恢复前不置待启动。自检验证暂停后旧消息不发送，显式恢复会重新 prime。
- 观察仅用允许名单的侧栏未读行判断候选；名单外角标不触发前台。观察发现 PID/HWND 改变时清除旧窗口身份并要求下次前台重新建基线。周期复核前仍执行观察，观察到未读时用 `minIdleMs=0` 前台扫描；成功的空闲观察清除 PrintWindow 失败次数。
- 增补审查点名的 T05、T09、T11、T12、T25、T29、T35 断言；T14、T16 用实际 PowerShell 分支夹具检验，同时覆盖名单内外角标、活跃用户未读、交替捕获失败与空闲，以及空闲观察不改 `reply_guards`、`processed`、`pending_observation`。

### 审查脚本实际输出

`probe3.cjs`：

```text
H2 takeover paused then resume: step=paused text=yes again=paused/text resumed=running primes_after_takeover=1 restoreTurnBoundaries=2 resets=2 scans=1 sends=0
H3 popup pause after running: step=paused progressText=自动回复已暂停，请检查后重新启动
```

`probe4.cjs`：

```text
PA WeChat restart, repeated user restarts: wechat_window_changed,current_session_baselined,no_unread_message,no_unread_message,no_unread_message,no_unread_message,no_unread_message,no_unread_message,no_unread_message
PB user active >60s, message waiting: results=no_unread_message,no_unread_message,no_unread_message,no_unread_message,no_unread_message observe_calls=5 minIdle=0
PB2 user active <60s, message waiting: result=no_unread_message fg=unread_candidate minIdle=0
PE requeued retry candidate: requeued=true result_ok=true fg=pending_state prepared=1
PF unusable/idle alternating: printwindow_unusable,idle,printwindow_unusable,idle,printwindow_unusable,idle,printwindow_unusable,idle
```

T7a `probe.cjs`：`P1 ... after_expiry step=paused auto_reply_status=paused sends=0`。`probe2.cjs`：`Q7 user pause during takeover wait: step=paused status=paused sends=0`；Q1/Q2 暂停发送 0 次，Q1b/Q2b 明确恢复各发送 1 次。

`mutate3.cjs mutations3.json`：审查点名的 T05、T09、T11、T12、T14、T16、T25、T29、T35 均输出 `KILLED`；额外补的 T15 也输出 `KILLED`。完整集的其他存活项为 T04、T18、T32、T34、T37；T01、T02、T06、T10、T20、T33、T41 因旧替换片段与返修代码不匹配输出 `SETUP-ERROR`，不能算检出。变异脚本结束后已恢复源码。T7a `mutate.cjs mutations.json` 的 M01–M31 全部 `KILLED`；二审 `mutations2.json` 的 N05–N16 全部 `KILLED`，N01–N04 为旧片段 `SETUP-ERROR`。

### 项目门禁实际输出

`npm.cmd run check:self`，退出码 0，末尾输出：

```text
> src/main/wechat-workflow.self_check.cjs
workflow scope stress: aliases_json=66671, scope_ms=22, contacts_reads=5
auto-reply v4 self-check passed
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.
all source self-checks passed
```

`npm.cmd run build:test`，退出码 0，末尾输出：

```text
✓ 1643 modules transformed.
dist-development/assets/index-LjKoAXww.js                      547.61 kB │ gzip: 180.47 kB
(!) Some chunks are larger than 500 kB after minification.
✓ built in 1.54s
test renderer build completed
```

`git diff --check` 通过。未做真实微信验收、安装包验证或发布。
