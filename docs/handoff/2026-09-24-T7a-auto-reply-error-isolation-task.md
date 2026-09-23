# T7a【P1】自动回复：一次出错不再整轮停用，接待名单逐人隔离

分支：`codex/auto-reply-workflow-resilience`

顺序与依赖：
- 在发布 1（T1/T4/T5）之后开始，与 T4/T5 不改同一段代码。
- T5 也会在 `wechat-failure-policy.cjs` 和规则目录里登记新码，两边都是追加，合并时注意冲突。
- T6b 也改 `wechat-workflow.cjs`，但改的是不同代码块（:717-748、:777-786 和新方法）。T6b 的"重新加入并启动"会走本卡改过的 `start()`，行为兼容。T9a 只加脚本，不重叠；T9b 尚未出卡，出卡时再核对。
- T6a、T6b 也改 `WechatWorkflow.tsx`：T6a 改 :203-212，T6b 改 :91-92、:393-442、:459-465。本卡不碰这些行。
- 顺序按 T6b 卡的建议：T6a → T6b → T7a。可以并行开发，但要逐个合并，后合并的先 rebase。
- T7b 必须等本卡合并后再开始。

> 行号均指 HEAD `258e37a`。前面的卡合并后行号会偏移，届时以函数和分支的语义为准。

## 现象

来自异机 9-23 诊断包，版本 1.1.53，同一进程（run `2ec782b8`）从 9-20 一直跑到 9-22。

- 9-21 15:25:07–15:25:31，用户 24 秒内点了 4 次"启动程序"，每次都只进入 `listening`。15:25:08 记录了一次 `reply.result`，原因是 `reply_needs_attention`，错误原文被哈希，看不到。
- 9-22 开启了接待，`reply_eligible=true` 出现 276 次，但没有任何 `reply.result`。
- `auto-reply-diagnostics.jsonl` 只有 `paused` 事件，没有 `start_requested`，`scan_health` 一直是 unknown。

也就是说，自动回复一次都没有扫描过。

## 现状（已对照 HEAD 258e37a 的代码复核）

1. **一次出错，本次运行就不再回复。**
   - `wechat-workflow.cjs:474` 把 `reply.error` 写入 `replyError`；
   - 之后每一轮，:460 的 `!replyError` 条件都会跳过自动回复；
   - 没有有限任务时，:383-389 直接 `enabled=false`，进入 `needs_attention`；
   - 只有 `start()`（:863-864）会清空 `replyError`。
2. **再点"启动程序"也恢复不了。**
   - 自动回复内部一旦暂停（`state.status="paused"`），工作流模式下只有 `workflowStartPending=true` 时才会重新走启动检查（`auto-reply-ipc.cjs:3809-3823`）。
     - 暂停来源：AI 错误 `pauseForSystemError`（:2578-2606，在 :3207 调用）、窗口变化（:2856-2861）、发送结果未知（:3477、:3677）、返回聊天失败（:3829-3831）。
   - 这个标志初值为 true（:1485）；之后在工作流路径上只在三处置位：首次接管（:3788）、`pauseWorkflow`（:3760）、上次事件是返回聊天失败时（:3804-3808）。:2381 属于独立模式的 `start()`，与工作流无关。
   - `wechat-workflow.start()` 不通知自动回复。于是下一次 `runWorkflowStep` 在 :3824-3826 立即返回 `needs_attention`，大约 1 秒后整条流程又停下。
   - :3804-3808 只在用户再点"启动程序"（`start()` 清空 `replyError`）之后才会执行，本轮内不会自动执行。它是 HEAD 上唯一一种再点启动就能恢复的内部暂停。
3. **AI 的瞬时错误也直接暂停。**
   - 生成失败时，只有 `CONTACT_GENERATION_FAILURES`（:62-68）会跳过当条、继续处理别的；其余错误一律走 `pauseForSystemError`（:3206-3210）。
   - 此时该条消息的 fingerprint 停在 `generating`，属于非终态（:1334-1336），但**没有重新入队**。视觉驱动在返回候选时已经推进了基线（`wechat_auto_reply_visual_driver.dev.cjs:3256-3257`），工作流的重新启动检查（:3809-3823）也不会重放它。所以恢复运行后，这条消息很可能再也不会被识别出来。
   - 已有的同进程重试手段是 `requeueCandidate`（:2647-2653，在 :3080 使用）。
   - 错误类别由 `systemErrorCategory`（:398-407）决定：
     - `AI_NETWORK_ERROR` → network
     - `AI_REQUEST_TIMEOUT` → timeout
     - `AI_RATE_LIMITED` → rate_limit
   - DeepSeek 的 HTTP 5xx 被映射成 `AI_REQUEST_FAILED`（`deepseek-api.cjs:394`），和未知错误是同一个码，本卡不纳入退避。
4. **接待名单里一人有问题，整张名单失效。**
   - `resolveWorkflowContactScope`（:1362-1406）逐人检查。只要有一人 id 不唯一、找不到、已停用、资料变了（:1373-1377），或者会话名与别人重复（:1378-1379），就整体返回失败。
   - 这个检查在 `runWorkflowStep` 的 :3797-3798，早于写入 `start_requested` 的 :3820。这和 9-22 日志里完全没有扫描记录一致。
   - 同一个函数还在 `runOnce` 开头（:2762）和每次 `isCurrentRun()`（:2773-2783）里重新执行：一步之内合格者集合（`scopeBinding`）变了，就 `pauseWithError` 中止。这是防止名单在一步中途变化的护栏。
   - 每次执行都要重读通讯录，并做"名单人数 × 全部别名"的循环（`uniqueAliasesForTestContact`，:1185-1190）。一次空闲轮询至少执行 3–4 次。现在名单一出问题就整体失败，所以大名单几乎走不到这条路；本卡改成逐人隔离之后，它就成了常态。
5. **触达联系人自动加入接待名单时，不检查重名。**
   - `enroll`（`wechat-workflow.cjs:264-273`）把任务里的所有联系人直接写入名单，调用点有两处：`saveTask`（:695）和每轮 `runCycle`（:441-448）。
   - 触达按微信号找人，允许重名；自动回复按会话名认人，要求唯一。09-17 的名单里有 11 人同名。
   - 手动加入走 `prepareWorkflowRecipients`（:3852-3861），那条路径是有检查的。
6. **诊断看不出原因。**
   - `runWorkflowStep` 返回的错误只有中文文案，经 `workflowFailureReason` 处理后大多落成 `reply_needs_attention`（`wechat-workflow.cjs:475`）。
   - `lastReplyDiagnostic`（:83）跨运行不清零，:477 会把相同原因去重。所以 9-22 的失败很可能被当成与 9-21 相同而没有记下来。

**推断，尚未证实**：9-21/9-22 的失败发生在 :3820 之前。理由是：运行中的内部暂停都会先写自己的诊断事件（AI 错误写 `system_error`，:2596；窗口变化写 `workflow_window_changed`，:2859；结果未知在 :3477 前写发送诊断），而据 wechat-logs 报告，auto_reply 日志从本次进程启动（9-20 12:35）起只有 `paused`，`scan_health` 一直是 unknown。所以"更早一次内部暂停后没有重新启用"（第 2 点）可能性较低。剩下两类：
- 名单检查失败（第 4 点：资料变化或重名）。重名文案用的是"重复"，匹配不上 `workflowFailureReason` 的 `/唯一|重名/`（`wechat-workflow.cjs:28`），所以落成 `reply_needs_attention`。
- 启动检查抛错（:3810-3812）。1.1.53 是 development 版，走托管网关（`main.cjs:404-409`）。网关未就绪时，`assertAvailable`（`deepseek-api.cjs:647-653`）抛 `PROVIDER_GATEWAY_UNAVAILABLE`，被 :3844-3845 捕获后同样落成 `reply_needs_attention`。

本卡修第 4 点，并补上原因码。如果实际是网关或密钥不可用，本卡**不会**让回复恢复（配置类仍然暂停），但发布后的日志会给出原因码。

## 要做

1. **返回结构化结果。** `runWorkflowStep` 的所有非成功返回都带机器可读的 `reasonCode`，例如 `workflow_recipient_ambiguous`、`workflow_recipients_none_eligible`、`AI_NETWORK_ERROR`、`send_outcome_unknown_paused`。
   - 包括 :3844-3845 的 catch：启动检查（:3810-3812）抛出的错误，取其 `code`（例如 `PROVIDER_GATEWAY_UNAVAILABLE`、`API_KEY_MISSING`）；没有 code 的，用一个固定兜底码。
   - 给用户看的 `error` 文案保持不变。
2. **错误分级**（判定放在 auto-reply-ipc 内）。
   - **退避后自动重试**，适用于两类情况：
     - `system_error.category` 是 network、timeout 或 rate_limit；
     - `workflow_chat_navigation_failed`（既没有读到消息，也没有发送）。
   - 退避的具体做法：
     - 返回 `{ status: "backoff", reasonCode, retryAfterMs, progressText }`，不带 `error`。
     - 间隔依次为 30 s、2 min、5 min，之后一直保持 5 min。
     - 退避期间被调用时，在解析名单（:3797）之前就返回剩余时间，不扫描。
     - 到时间后重新走启动检查（与 :3809-3823 相同）。
     - AI 类错误不再调用 `pauseForSystemError`，而是在进入退避前把候选消息重新入队（复用 `requeueCandidate`），确保退避结束后处理的是同一条消息。重放的候选照常走 verify、`reply_guards` 和发送前检查。入队失败就按现有 :3117-3121 的方式暂停。
     - AI 类退避不重新 prime、不重置基线。返回聊天失败这一类沿用 :3804-3808 的现有处理（会重新 prime）。
     - 出现一次完整成功的扫描，或一次 AI 决策成功，就把退避计数清零。
   - **以下情况仍然暂停**，行为不变，只补 `reasonCode`：
     - 配置类：`API_KEY_*`、`SECURE_STORAGE_UNAVAILABLE`、`AI_EXPERT_NOT_READY`、`PROVIDER_GATEWAY_UNAVAILABLE`；
     - AI 返回类：余额不足、内容被拦截、响应无效、`AI_REQUEST_FAILED`；
     - 结果未知：`send_outcome_unknown_paused`、`stale_run_send_paused`；
     - 运行类：`send_retry_queue_paused`、`workflow_window_changed`、`auto_reply_error_paused`、`runtime_lock_release_failed_paused`；
     - 账号不一致；
     - 名单中一个可接待的人都没有；
     - 运行中名单变化（`isCurrentRun` 触发的中止，见第 5 步）；
     - **以上没有列出的码，一律暂停。** 退避只能是白名单。
3. **调度器处理退避**（`wechat-workflow.cjs:456-487`、:383-389）。
   - 收到 `status: "backoff"` 时不写 `replyError`，把 `progressText` 写入 `replyStatus`，例如"云端智能暂时不可用，约 30 秒后自动重试"。
   - 没有有限任务时，phase 保持 `listening`。
   - 每次进入退避记一条 `reply.backoff`，字段为 reasonCode、attempt、retry_after_ms。同一次退避期间的重复返回不再记。
   - `reply.result` 的 `reason` 改用返回的 `reasonCode`。
4. **点击启动即重新启用自动回复。**
   - `start()` 通知自动回复，让下一次 `runWorkflowStep` 重新走启动检查，效果等同于"先暂停、再启动"。
   - 同时清零退避计数和 `lastReplyDiagnostic`。
   - 不清除 `processed`、`reply_guards` 和结果未知的记录。同一条消息如果结果未知，仍由 :3027-3051 拦截，不会补发。
5. **接待名单逐人隔离。** `resolveWorkflowContactScope` 对不合格的人逐个剔除，返回合格者 `contacts` 和被剔除者 `excluded`。`excluded` 每项只含 `{ id, code }`，code 为 `workflow_recipient_changed` 或 `workflow_recipient_ambiguous`。具体要求：
   - 重名判断仍基于完整通讯录（`testContactUniverse` 包含已停用的联系人，:1168-1174）。剔除一个人，不能让另一个人因此"变成唯一"。
   - 被剔除者的别名不进入 `aliases`，`resolveContact` 对他们返回 null。
   - `scopeBinding` 只按合格者计算。
   - 合格者为 0 时返回失败，原因为 `workflow_recipients_none_eligible`，按配置类处理（暂停）。
   - 账号一致性检查（:1387-1388、:3800）只看合格者。
   - `runWorkflowStep` 在返回里带上 `excludedCount` 和按 code 分类的人数，由调度器放进 `status()`。
   - 运行中护栏（`isCurrentRun`，:2773-2783）保持不变：一步之内合格者集合变了，照旧中止并暂停，只补 `reasonCode`。
6. **自动加入名单时检查重名。**
   - auto-reply 提供一个不抛错的筛选函数，例如 `screenWorkflowRecipients(contacts) → { accepted, excluded }`。它**必须与第 5 步共用同一份逐人判定**，不另写规则。
   - `enroll` 只写入 `accepted`，把排除人数记在任务上（例如 `task.replyEnrollExcluded`），并记一条只含计数的日志。
   - 拿不到筛选函数时，保持现有行为。
   - 手动加入（`prepareWorkflowRecipients`）行为不变：所选的人里只要有一个不合格，就整体拒绝，并提示具体是哪一位。
7. **界面**（`WechatWorkflow.tsx`，只改展示文字和类型）：
   - 退避期间显示 `replyStatus`，不显示"自动回复需处理"（涉及 :191-193、:349、:471）；
   - 在"接待范围"（:706-716）显示两类人数：
     - "N 位因重名或资料变化暂不自动回复"；
     - 最近一次从触达自动加入时，有几位因重名未加入。
   - 不改任务行，任务行在 T6b 的改动范围内。
8. **诊断**：在 `reply.result` 或 `reply.backoff` 里记录合格人数、别名个数、`JSON.stringify(aliases).length`（只记长度，不记内容），以及本步名单解析的耗时 `scope_ms`。
   - 这串别名会作为环境变量 `XIAOXI_ALLOWED_NAMES` 传给 PowerShell（`wechat_auto_reply_driver.cjs:1300`、:1378；视觉驱动 :3028）。Windows 单个环境变量的上限是 32,767 字符。
   - 请在 result 中报告：3000 人通讯录、2000 人接待名单的合成数据下，别名串长度，单次 `resolveWorkflowContactScope` 耗时，以及一次空闲轮询里它被调用几次。
   - **本卡不修改传参方式，也不做缓存。** 超限或耗时过大时，在 result 里写明，另出卡处理。

新增的 `reason:` / `reasonCode:` 字面量，必须在 `workflowPolicies` 或规则目录中登记，否则 `check:self` 里的 `scripts/wechat-failure-policy-review.cjs` 会失败。

## 允许改动

- `desktop/src/main/auto-reply-ipc.cjs`
- `desktop/src/main/wechat-workflow.cjs`，限以下位置：reply step（:456-487）、`settleQueue`（:383-389）、`enroll`（:264-273）、`start`（:855-873）、:74-90 的状态变量声明，以及 `status()`（:245-262）的新增字段
- `desktop/src/renderer/WechatWorkflow.tsx`：只改 :66-69（类型）、:191-193、:349、:471、:706-716，不动按钮逻辑
- `desktop/src/shared/wechat-failure-policy.cjs`、`desktop/src/shared/wechat-rule-catalog.json`：只用于登记新增的字面量
- `desktop/src/main/auto-reply-ipc.self_check.cjs`、`desktop/src/main/wechat-workflow.self_check.cjs`

## 禁止

- 不放宽任何身份判定：
  - 会话名必须在完整通讯录中唯一；
  - 匿名红点（`messageDriven`）仍不能授权回复（:1398）；
  - 视觉结果的 `conversationEvidence` 校验（:1401-1402）不变；
  - 运行中护栏 `isCurrentRun`（:2773-2783）不变。
- 不改结果未知的处理：不补发，不清 `reply_guards` 和 `processed`，`send_outcome_unknown_paused` 仍然暂停。
- 退避后重放的候选不得跳过 verify（:3272）、`reply_guards`（:3025-3063）和发送前检查。
- 不改 `rpa/active_touch/*` 的扫描和发送驱动，不改 `deepseek-api.cjs`，不改测试版的单联系人模式。
- API Key 和错误原文不进日志。日志只记原因码和计数，不记联系人名、联系人 ID 或消息内容。
- 不做抢前台和返回聊天页相关的改动（属于 T7b）。

## 验收（新增断言在当前 HEAD 上必须失败）

以下 1–6 写在 `auto-reply-ipc.self_check` 中：使用真实的 `createAutoReplyController`，开启工作流模式，扫描、发送、AI 和时钟用 fake，通过 `runWorkflowStep` 调用。

1. 第一次生成时抛出 `AI_NETWORK_ERROR`：
   - 返回 `status:"backoff"`、`retryAfterMs:30000`，不带 `error`；
   - 30 s 内再次调用不扫描；
   - 时钟推进 30 s 后，同一条消息被回复，`send` 恰好调用 1 次。

   HEAD 上返回的是 needs_attention。
   - 回归保护（HEAD 上也通过）：退避期间 fake verify 报告这条消息已不是最新来信（`incoming_message_changed`），则重放后 `send` 调用 0 次。
2. 连续失败时，间隔依次为 30000 → 120000 → 300000 → 300000；成功一次后回到 30000。`AI_REQUEST_FAILED` 和未登记的码不进入退避。
3. `API_KEY_INVALID` 和 `AI_EXPERT_NOT_READY` 仍返回 `needs_attention`，并带对应的 `reasonCode`；启动检查里 `assertAvailable` 抛 `PROVIDER_GATEWAY_UNAVAILABLE` 时，返回的 `reasonCode` 就是这个码。HEAD 上没有 reasonCode。
4. 发送结果未知：
   - 返回 `needs_attention`，`reasonCode` 为 `send_outcome_unknown_paused`；
   - 之后重新启用，同一条消息再次出现时，`send` 的调用次数不增加。
5. 名单为：A 正常；B 与名单外的 C 同名，且 C 已停用；D 资料已变化。
   - 扫描只收到 A 的别名，A 的消息被回复；
   - B 会话里的消息不回复；
   - 返回 `excludedCount:2`。

   HEAD 上整张名单返回 needs_attention。另测：
   - 全部不合格时，返回 `workflow_recipients_none_eligible`；
   - 一步之内把 A 的资料改掉（`isCurrentRun` 复核时合格者集合变化），这一步中止、`send` 调用 0 次，并返回 `needs_attention` 和对应的 `reasonCode`。
6. 自动回复先因 `workflow_window_changed` 暂停，然后调用第 4 步新增的重新启用入口（也就是工作流 `start()` 会调用的那个函数）：下一步会重新走启动检查，并能正常扫描。HEAD 上没有这个入口，只能立即返回 needs_attention。第 8 条会通过真实的 `start()` 再覆盖一次。

以下 7–9 写在 `wechat-workflow.self_check` 中：

7. 触达任务的联系人里有重名者：`addTask` 之后，接待名单里没有这个人，任务上记录的排除人数为 1。
   - 筛选要用真实 auto-reply 的筛选函数，配临时的 contacts 固件。
   - HEAD 上这个人会被加入名单。
8. 至少一条用例把真实的 auto-reply 控制器接入 `createWechatWorkflowController`：
   - 注入 AI 网络错误后，连续 `tick` 期间 `replyError` 始终为空，phase 为 `listening`；
   - 时钟推进后，自动回复恢复；
   - 自动回复因 `workflow_window_changed` 暂停、工作流进入 `needs_attention` 后，调用工作流的 `start()`，下一次 `tick` 能重新走启动检查并扫描。HEAD 上会立即再次 `needs_attention`。
9. 日志与原因码：
   - 同一原因的回复失败，在 `pause` 再 `start` 之后的新一轮里会再记一次日志。HEAD 上会被去重。
   - `reply.result` 的 `reason` 等于返回的 `reasonCode`。

通用要求：

10. 诊断事件中不含联系人名、联系人 ID 或消息内容，沿用现有 `/private-.../` 的断言写法。
11. `npm.cmd run check:self` 通过，其中包括 `wechat-failure-policy-review`。

## 需用户本人验收或授权

- **真实微信**（需用户指定测试账号和联系人）：
  - 在接待名单里放一个重名联系人和一个正常联系人；
  - 让正常联系人发消息，确认能收到回复；
  - 断网约 1 分钟再恢复，不点任何按钮，自动回复能继续回复。
- 如果第 8 步报告的别名串长度超过 32,767，或名单解析耗时明显拖慢主进程，是先出后续卡再发布，还是先发布，由用户决定。
- **发布**需用户授权。发布后在异机复验：
  - `reply.result` 和 `reply.backoff` 里有具体的原因码，并据此确认 9-21/9-22 的失败是名单问题还是网关/密钥问题；
  - 统计被排除的人数和别名总长度；
  - 跑触达的同时，有自动回复的记录。
