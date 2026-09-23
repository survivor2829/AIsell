# T7b【P2】自动回复：空闲时不抢微信前台，只在需要时返回聊天页

分支：`codex/auto-reply-background-scan`

依赖：T7a 合并后再开始。两张卡都改 `auto-reply-ipc.cjs` 的 `resolveWorkflowContactScope` 和 `runWorkflowStep`，也都改 `wechat-workflow.cjs` 的 reply step。

> 行号均指 HEAD `258e37a`。T7a 合并后 `auto-reply-ipc.cjs` 的行号会偏移，届时以函数语义为准。

## 背景

- 工作流模式下，自动回复每轮轮询都依次做三件事：摆放微信窗口并抢到前台 → 返回聊天页 → 视觉扫描。本机实测一次扫描 p50 13.1 s、p90 15.2 s（wechat-code 报告 A4；数据来自本机 09-15～09-22，对应哪个构建不确定）。
- 触达两个联系人之间有 8–15 s 的安全间隔，这段时间没有到期任务，也会轮询（`wechat-workflow.cjs:456-460`）。如果用户正在用电脑，前台会被抢走；触达那边还会因为"检测到外部输入"而等待。
- 9-23 异机包里没有自动回复的扫描数据（原因见 T7a），所以本卡的收益只能靠本卡新增的统计来量化。

## 现状（已复核）

1. **每次扫描都抢前台，用户在打字也照抢。**
   - `wechat_auto_reply_driver.cjs:1334`：每次 `scanWechatIncoming` 都先调用 `normalizeWindowForExecution`。
   - :1213-1220 以 `requireFocused:true, minIdleMs:0` 准备窗口，对应 `wechat_window_driver.cjs:1043` 的 SetWindowPos 和 :1045-1050 的抢前台。
   - `minIdleMs:0` 意味着即使用户正在打字，也照样抢前台。
2. **每轮都返回一次聊天页。**
   - :1231-1242：只要 `restoreChatSurface` 为 true，每轮都执行一次 `returnWechatFromMomentsToChat`（`moments_navigation.dev.cjs:1301-1311`，要起一次 PowerShell）。
   - 工作流模式下它恒为 true（`auto-reply-ipc.cjs:1395`）。
3. **计划里"用 inspect-only 扫描"这条路走不通。**
   - `XIAOXI_WECHAT_INSPECT_ONLY` 模式（`wechat_window_driver.cjs:939-984`）在微信不在前台时，直接返回 `wechat_window_not_foreground`（:951-953）。
   - 发送前检查依赖的正是这个语义（`state_machine.dev.cjs:539-561`，经 `inspectForegroundWechatMainWindow`，`wechat_window_driver.cjs:1391-1398`），不能改。
4. **视觉驱动本身已优先用 PrintWindow，但有四处仍要求前台。**
   - 已具备的部分：
     - 默认用 PrintWindow 截图（`wechat_auto_reply_visual_driver.dev.cjs:908-922`、:855-882），只有退回屏幕截图时才要求前台（:884-887）；
     - 自己按 PID/HWND 定位窗口（:1709-1735）。
   - 要求前台的四处：
     - **点开未读会话**：扫描脚本在同一次调用里直接点开（:2090 调用 `Open-AutoReplyVisualConversation`，该函数在 :939-942 要求前台）。
     - **PrintWindow 结果不可用**：结构缺失或识别失败时，会强制改用屏幕截图（JS :3158-3164，判定函数 `shouldForceScreenCapture` 在 :2421-2433）。
     - **已绑定会话的复核**：当前已绑定的会话在 PrintWindow 下显示"无新消息"时，必须用前台屏幕帧再核一次（:3165-3190，判定函数 `isBoundPrintWindowNoMessage` 在 :2467-2482），因为 PrintWindow 可能落后一帧。触达联系人会被自动加入接待名单，触达之后微信里打开的正是名单中的会话，所以这是最常见的情况。
     - **窗口最小化**：PrintWindow 路径会返回 `wechat_window_missing`（:909-911）。这个原因在 `STRICT_SCOPE_WINDOW_RESET_REASONS` 中（`auto-reply-ipc.cjs:139-144`），会让工作流暂停（:2856-2861）。现在之所以没出问题，是因为每轮扫描前都会先把窗口还原。
5. **发送本身不抢前台。**
   - 发送前检查要求窗口已在前台，并且处于标准布局（`state_machine.dev.cjs:546`，`strictPreparedWechatWindow` 在 :203-214）。视觉发送同样要求（`wechat_auto_reply_visual_send.dev.cjs:204-206`）。
   - 发送之所以能成功，是因为同一轮扫描已经把窗口准备好了。
6. **两处现有行为会让 observe 误停或失效。**
   - **窗口挪动**：同一 PID/HWND 的位置或大小明显变化时，`rejectChangedWindow`（`wechat_auto_reply_driver.cjs:1247-1255`）返回 `wechat_window_changed`，同样会让工作流暂停。现在是先摆放窗口再扫描，所以碰不到这种情况。
   - **"偏好屏幕截图"一旦设上就一直有效**：
     - 任何一次强制屏幕截图的调用返回 `ok:true`，就会设置 `preferredScreenWindow`（视觉驱动 :3040-3041），包括第 4 点里已绑定会话的复核在屏幕帧里找到消息（:3172）。
     - 之后同一窗口的每次调用都强制屏幕截图（:3025、:3037）。只有窗口变了（:3024）或 `resetBaselines`（:3401）才会清掉。
     - 所以如果把它当作"直接走前台"的条件，第一次靠复核回复了当前会话之后，observe 在这个窗口上就再也不会用上。

## 要做

1. **视觉驱动新增只读的 observe 模式**，包括 `XIAOXI_AUTO_REPLY_MODE=observe` 和 JS 函数 `observeWechatIncoming`。
   - 只用 PrintWindow：不退回屏幕截图，不做焦点回退，不点击，不滚动，在 :2090 点开会话之前退出。
   - 用现有基线做比较，但**不修改**任何状态，包括 preview/message 基线、occurrence、`stableActiveSession`、retry、pending。
   - 结果只有两种：
     - `idle`：仅当扫描逻辑的结论是 `no_unread_message`；
     - `foreground_required`：附带 trigger，取值如 unread_candidate、printwindow_unusable、structure_missing、window_minimized、geometry_changed、other。
   - 结果里不带会话名、消息内容和签名，避免被 auto-reply 当成观察记录处理（`auto-reply-ipc.cjs:2938`，`recordOutgoingObservation`）。
   - 结果恒为 `ok:false`。observe 不读也不写 `preferredScreenWindow`，也不经过 `invoke` 里 :3040-3041 的设置逻辑。
   - PID 或 HWND 变化时，仍返回原来的 `wechat_process_changed` / `wechat_window_changed`。observe 自己不清基线，下一次前台扫描按现有 :3191-3214 处理。
2. **扫描入口先判断走哪条路**（`wechat_auto_reply_driver.cjs:1331-1369`）。只有 `matchOptions.passiveScan===true`、且处于视觉模式（`activeScanMode==="visual"`）时才先走 observe。UIA 模式不变。
   - 以下任一情况，直接走现有的前台路径（先抢前台，再按原逻辑扫描，扫描逻辑一字不改）：
     - 还没完成 prime，或需要重新 prime；
     - 存在待恢复的观察、已点开的未读、重试候选或启动边界；
     - observe 返回 `foreground_required`；
     - 距上次前台完整扫描已满 60 s。这是周期复核，用来兜住 PrintWindow 落后的情况；
     - 同一 PID/HWND 上 observe 连续 3 次报 `printwindow_unusable`，说明这台机器 PrintWindow 不可用；此后到下一次 prime 之前不再 observe，计入 `passive_unusable`。
   - `preferredScreenWindow` **不作为**直接走前台的条件（原因见现状 6）。它只继续影响前台扫描本身怎么截图，这部分不改。
   - 两种前台扫描的空闲要求不同：
     - 周期复核用 `minIdleMs: 5000`。用户正在操作时返回 `wechat_user_active`，下一轮再试。
     - 由消息触发的前台扫描仍用 `minIdleMs: 0`。
   - observe 结果为 idle 时，返回 `{ ok:false, reason:"no_unread_message", passive:true }`，不调用窗口准备。
   - 同一 PID/HWND 只是窗口位置或大小变了：observe 报 `geometry_changed`，走前台路径重新摆放，不报 `wechat_window_changed`。observe 结果不经过 `rejectChangedWindow`；前台扫描之后的 `rejectChangedWindow` 保持不变。
   - 60 s、5000 ms 两个参数写成常量；另设一个总开关常量，方便回退。
3. **只在需要时返回聊天页。** `restoreChatSurface` 不再恒为 true。
   - 标志由 auto-reply 控制器持有，在 `resolveContactScope`（`auto-reply-ipc.cjs:2012-2016`，工作流分支合成 `driverOptions` 的地方）注入；`resolveWorkflowContactScope` 本身是无状态的顶层函数，不放在那里。
   - 导航成功后清除，包括 prime 时的导航（prime 同样走 `normalizeWindowForExecution`，`wechat_auto_reply_driver.cjs:1285-1292`）。
   - 只在以下三种情况置位：
     - 工作流启动或接管后的第一次扫描（或 prime）；
     - 上一个有限任务是朋友圈（publish 或 interact）。由 wechat-workflow 在该任务这一步结束后，给下一次 `runWorkflowStep` 传 `afterMoments:true`；
     - 上一次扫描或 observe 的结果显示不在聊天页。这组原因请从代码中核实后在 result 里列出，至少包括 `visual_ocr_structure_missing`、`visual_sidebar_match_missing` 和 `wechat_chat_*`。

   置位时必须走前台路径。连续失败 3 次的处理沿用 T7a。
4. **统计抢前台次数。**
   - 驱动在结果里标明本次是否抢了前台，以及原因（prime、unread_candidate、periodic_recheck、pending_state、chat_surface_restore、passive_unusable 等）。
   - auto-reply 按小时汇总，每小时写一行诊断，内容包括：
     - 前台次数，按原因分列；
     - observe 判定为 idle 的次数；
     - 导航次数；
     - `passive_miss`：周期复核发现了候选消息，而在它之前的 observe 都报了 idle。
   - 不要每次写一行。`DIAGNOSTIC_LOG_MAX_LINES=500`（`auto-reply-ipc.cjs:23`），逐次记录会很快把有用的行挤出去。
5. **只在工作流模式启用**：由 `resolveWorkflowContactScope`（:1395）在 `driverOptions` 里传 `passiveScan:true`。测试版单联系人模式和旧的独立轮询保持不变。

新增的 `reason:` / `reasonCode:` 字面量需要在 `workflowPolicies` 或规则目录中登记，否则 `check:self` 会失败。

## 允许改动

- `desktop/rpa/active_touch/wechat_auto_reply_visual_driver.dev.cjs`：只新增 observe 模式；prime、scan、prime_confirm、recover、verify 的现有判定和 `preferredScreenWindow` 逻辑不动
- `desktop/rpa/active_touch/wechat_auto_reply_driver.cjs`
- `desktop/src/main/auto-reply-ipc.cjs`：只涉及 `driverOptions`（:1395、:2012-2016）、返回聊天页的标志和小时统计
- `desktop/src/main/wechat-workflow.cjs`：只增加 `afterMoments` 的传递
- 对应的 self_check：`desktop/rpa/active_touch/wechat_auto_reply_visual_driver.self_check.cjs`、`wechat_auto_reply_driver.self_check.cjs`，`desktop/src/main/auto-reply-ipc.self_check.cjs`、`wechat-workflow.self_check.cjs`
- `desktop/src/shared/wechat-failure-policy.cjs` 和 `wechat-rule-catalog.json`：只用于登记新增的字面量

## 禁止

- 不改以下既有逻辑：`wechat_window_driver.cjs` 的 INSPECT_ONLY 语义、`state_machine.dev.cjs` 的发送前检查、视觉发送、`moments_navigation.dev.cjs`。
- 不在发送路径上新增抢前台。发送仍依赖同一轮前台扫描准备好的窗口；前台条件不满足时，按现有逻辑安全取消并重试。
- observe 的结果不能触发 AI 生成或发送，也不能推进任何基线。凡是可能导致回复的候选，都必须走完现有的前台扫描、verify 和发送前检查。
- 不改点开会话前的身份核验，包括白名单完全匹配、`conversationEvidence` 和 `conversation_click_not_owned`。不改结果未知的处理。
- 不改 prime 的抢前台行为，它每次启动只做一次。

## 验收（新增断言在当前 HEAD 上必须失败）

`wechat_auto_reply_driver.self_check`（windowNormalizer、runner 和时钟用 fake）：

1. 视觉模式，`passiveScan:true`、`restoreChatSurface` 未置位。prime 之后，时钟推进不到 60 s，连续 10 次扫描都由 observe 判定为 idle：windowNormalizer 调用 0 次。HEAD 上 10 次。
2. observe 报告 unread_candidate 时，恰好做 1 次前台准备，随后以 `scan` 模式执行原扫描。
3. 当前会话已绑定，observe 一直为 idle：
   - 60 s 内不抢前台；
   - 满 60 s 时做 1 次周期复核，且 `minIdleMs` ≥ 5000；
   - 用户处于活跃状态时返回 `wechat_user_active`，不抢前台。
4. observe 报告窗口最小化或位置、大小变化时，走前台路径，不返回 `wechat_window_missing` 或 `wechat_window_changed`；PID 变化时仍返回 `wechat_process_changed`。
5. 一次前台扫描以 `foreground_screen` 返回候选（`preferredScreenWindow` 因此被设置）之后，后续 60 s 内的空闲轮次仍走 observe，windowNormalizer 调用 0 次。
6. observe 在同一 PID/HWND 上连续 3 次报 `printwindow_unusable` 后，下一轮直接走前台，且不再调用 observe，直到重新 prime。
7. 非工作流模式（测试版）每次扫描仍准备窗口。这条是回归保护，在 HEAD 上也会通过。

`wechat_auto_reply_visual_driver.self_check`：

8. 源码断言：observe 分支在 `Open-AutoReplyVisualConversation` 之前退出，且不调用 `New-AutoReplyVisualScreenFrame`、`SetCursorPos`、`mouse_event`。
   - 调用 observe 前后，JS 中各基线 Map、`stableActiveSession`、`preferredScreenWindow` 完全相同；
   - observe 的返回恒为 `ok:false`。

`auto-reply-ipc.self_check`（真实控制器，工作流模式，经 `runWorkflowStep` 调用，`scanIncoming` 用 fake 并记录收到的 `driverOptions`）：

9. 返回聊天页的标志：
   - 第一次调用时 `restoreChatSurface:true`；这次成功后，之后的空闲调用里不再为 true。HEAD 上恒为 true。
   - 传入 `afterMoments:true` 后，下一次为 true，成功后清除；
   - 扫描返回 `visual_sidebar_match_missing` 后，下一次为 true。
10. observe 判定为 idle 的结果，不改变 `reply_guards`、`processed`、`pending_observation`。小时统计行包含上述各项计数，不含联系人信息。

`wechat-workflow.self_check`：

11. 执行完一步 publish 或 interact 任务后，下一次 `runWorkflowStep` 收到 `afterMoments:true`；执行完一步 touch 任务后不带。HEAD 上不带。

最后：

12. `npm.cmd run check:self` 通过。

## 需用户本人验收或授权

- **真实微信**（需用户指定测试账号和联系人）：
  - 在其他程序里连续打字 30 分钟，统计每小时抢前台的次数，并与 HEAD 对比；
  - 分别给"不是当前打开的会话"和"当前已打开的会话"发消息，记录回复延迟的 p50/p90；后一种预期不超过约 75 s；
  - 朋友圈任务结束后，自动回复能回到聊天页；
  - 微信最小化后能恢复；
  - 触达和自动回复同时运行时，"检测到外部输入"的等待次数下降。
- 如果 `passive_miss` 偏高或延迟不可接受，由用户决定缩短周期还是关闭总开关。
- 在 PrintWindow 画面会落后的机器上，observe 可能把当前会话的新消息判成 idle，要等 60 s 周期复核才发现。是否接受这个延迟，由用户在真实验收后决定。
- **发布**需用户授权。
