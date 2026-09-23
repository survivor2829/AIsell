# T8 多段消息复用已核验会话：文字发出后，图片/网址段不再重新搜索

分支：`codex/touch-multipart-session-reuse`（在 T4、T5 合并后开始。三张卡都改 `touch-workflow.cjs`，T5 的自检多半也落在 `touch-message-sequence.self_check.cjs`。计划中的 T6、T9 以后也改 `touch-workflow.cjs`，区域不重叠，按合并顺序 rebase。建议在发布 1 异机复验后开始，便于前后对比）

## 背景（异机 9-23 诊断包，1.1.53）

- 多段触达（文字 + 图片/网址）每一段都从头走一遍"选人 → 窗口准备 → 搜索点开 → 会话核验"。
  - 图片段平均 10.71 秒，其中重新搜索加核验占 6.66 秒；
  - 590 个图片段合计 65.5 分钟。
- 图片段重新搜索失败 84 次：r014 49 次，r008 35 次。
  - 日志里的失败序列记号 `T4 s`（40 人）和 `T8 8 8 8 (s)`（27 人），意思是"文字已发出，图片段重新搜索时遇到 r014 / r008"。**这两个记号与任务卡 T4、T8 的编号无关。**
  - 诊断窗口结束时，有 16 人停在"文字已发、图片未发"。
- 各步骤 p50：搜索点开 4.33 秒，窗口准备 0.95 秒，会话核验 0.98 秒，选人、校准各约 0.18 秒。
- 异机 UIA 不可用，搜索全部走 OCR，所以会话核验基本都是"按微信号精确搜索"模式加视觉会话头（见现状 4）。

## 现状（代码已复核，HEAD 258e37a，`desktop/` 下无未提交改动）

1. **每一段都是独立事务。**
   - `touch-workflow.cjs:304-358` 的 `executePart` 为每段单独建目录 `message-parts/<recipientKey>/<partIndex>`（:305-306），每段有自己的 `state.json`，然后调用 `options.execute`，也就是 `executeVerifiedContactSend`（`main.cjs:733` → `touch-task-ipc.cjs:1400`）。
   - `touch-message-sequence.cjs:56-91` 按顺序逐段执行，已经 `sent_verified` 的段会跳过（:58）。
2. **每一段都走 `state_machine.dev.cjs` 的完整链路：**
   1. `select-customer` / `calibrate`（:641-656），其中包括冻结身份比对（:649-655）；
   2. `prepare_window`（:658-702）；
   3. `click-search-result-dry-run`（:704-720）；
   4. `verify_session`（:722-725）；
   5. 发图片（:726-734），或发文字/网址（:735-767）。

   `select-customer` 会清空会话字段和窗口句柄（`state_machine.cjs:423-458`），所以上一段核验过的会话，下一段看不到。
3. **段与段之间只可能被外部输入干扰。** 处理一位联系人的整个过程都持有协调锁（`touch-workflow.cjs:277-282` 获取，:551-557 释放），段之间不会插入其他需要拿锁的内部 RPA（自动回复、同步联系人等）。
4. **"会话头哈希"已经有了，就是 `conversation_token`。**
   - 会话观察脚本生成的格式是 `conversation:v2:<pid>:<hWnd>:title|visual:<sha256>`（`wechat_window_driver.dev.cjs:600、628、642`）。`verify_session` 会把它写进状态（`state_machine.dev.cjs:326-342`）。
     - `title` 模式哈希的是**期望的联系人名称**（:598），只能证明"会话头里有这个名字"；
     - `visual` 模式哈希的是会话头截图（:603-626），同名联系人的会话头像素相同。
   - 在"按微信号精确搜索"模式下，现有检查并不比对这个 token：
     - `sessionCheckAsync` 跳过了 token 比对（:96-101、:121）；
     - 图片脚本接受任意会话头（`wechat_image_send.dev.cjs:282-284`）。
   - 驱动注释写明：视觉哈希只能证明会话头像素没变，本身识别不了联系人；联系人身份来自上游那次冻结的微信号搜索（`wechat_window_driver.dev.cjs:159-161`）。
   - 触达任务允许同名联系人进入名单（`touch_task_state.cjs:138`，`requireUniqueName: false`），靠的正是每段重新按微信号搜索。
   - 所以，复用必须证明"从上一次真实搜索到现在，这个会话一直没被动过"，严格比对要由复用闸门自己来做，而且同名联系人不能复用。
   - 调研里提到的 `Get-ConversationHeaderHash`（`wechat_window_driver.cjs:1895`）只在点击搜索结果的脚本里用来证明落点（:1954、:1989），裁剪区域也不一样，本卡不用它。
5. **"期间没有外部输入"目前没有现成证据。**
   - 文字、图片发送驱动结束时，不会回报自己最后一次输入的时刻（图片脚本的输入租约只在脚本内部用，`wechat_image_send.dev.cjs:41、117`）。
   - 可用的是只读探测 `inspectForegroundWechatMainWindow`（`wechat_window_driver.cjs:1391-1398`，走 :939-984 的"仅检查"分支）：
     - 不移动窗口，不抢前台，成功时返回 `inspectionOnly: true`；
     - 传入 `minIdleMs` 时，如果用户空闲时间不够，返回 `wechat_user_active`（:940 → :586-591）；
     - 传入的句柄已失效时返回 `wechat_window_identity_mismatch`（:862-865）。
   - 视觉发送已经在这样用它：`state_machine.dev.cjs:539-547`，配合 `strictPreparedWechatWindow`（:203-214）。那里的默认 runner 是同步的 `runPowerShell`。

## 要做

1. **锚点（只放内存）**
   - 在 `executeVerifiedContactSendCore` 新增选项 `captureSessionAnchor`。
   - 该选项为 true、且本段以 `sent_verified` 结束时，在返回值上附一个 `session_anchor`。触发时机：
     - 图片：`sendWechatImage` 返回成功之后；
     - 文字/网址：`sendReal` 返回成功之后。
   - 锚点内容从本段状态读取：`pid`、`hWnd`、`conversation_token`、`conversation_verification_mode`、`conversation_title_mode`、`search_query`、`search_query_type`、`wechat_account_id`、`contact_identity`（即 `identityKey(selected_customer)`，已是哈希）、`anchored_at`。
   - `anchored_at` 在驱动返回后立即取时间，时钟可注入。
   - 锚点里不放可读的姓名。
   - 不传这个选项的调用方（单人发送、自动回复视觉发送等），返回值保持不变。
2. **`touch-workflow.cjs` 只在多段模式下传递锚点**（`executePart`，:304-358）
   - 锚点放在本次 `runWorkflowStep` 的闭包变量里，初始为空。
   - 仅当 `multipart` 为 true 时，每段传 `captureSessionAnchor: true`；`partIndex > 0` 时再传 `reuseSession: { partIndex, sourcePartIndex, anchor }`（没有锚点时 `anchor` 为 null）。单段纯文字（:365）两者都不传。
   - 一段返回后，同时满足以下三条才更新锚点（并记下来源段号），否则清空：
     - `ok` 为 true；
     - `state.real_send_status === "sent_verified"`；
     - 返回值带有锚点。

     "迟到失败但已持久化 sent_verified"的情况（`touch-message-sequence.cjs:84-85`）返回的 `ok` 为 false，也要清空。
   - 返回给 `executeMessageSequence` 之前，删掉 `session_anchor`。
   - 锚点不写进任务文件、段记录、passport、diagnostics；不跨 `runWorkflowStep`，也不跨联系人。
   - `touch-message-sequence.cjs` 不改。
3. **复用闸门**
   - **位置：** 放在 `select-customer` / `calibrate`（:641-656）之后、`prepare_window`（:658）之前。`select-customer` / `calibrate` 本身不改，每段照样做冻结身份比对。
   - **触发：** 只有收到 `reuseSession` 时才执行。
   - **包装：** 整个闸门用 `observeSendStage(options, "session_reuse", …)` 包起来。
   - **原则：** 闸门只读，任何一步不通过都回退。闸门内的任何异常（`windowInspector`、`sessionDriver` 抛错等）都在闸门内捕获并当作不通过（参照 :541-545 的写法），**不得**冒泡成 `touch_part_exception` / `outcome_unknown`；完整路径原有的异常处理不变。
   - **开始前：** 用 `loadState(baseDir)` 保存一份完整快照，供回退使用。
   - **步骤（按顺序）：**
     1. **本地前置检查：**
        - 锚点存在；
        - `contact_identity` 等于本段 `selected_customer` 的 `identityKey`；
        - 账号一致；
        - `0 ≤ now − anchored_at ≤ 15 秒`（正常情况下两段相隔 1–2 秒；负值也算过期）；
        - 联系人显示名在同步通讯录中唯一：`contactIdentityError(readContacts(options.contactsDir || baseDir), selected_customer, undefined, { requireUniqueName: true })` 返回空（同 :35-42 的读取方式，但强制 `requireUniqueName`）。

        不通过时的结果：`anchor_missing` / `contact_changed` / `anchor_expired` / `name_not_unique`。
     2. **把锚点里的会话写进本段状态：**
        - `conversation_located`、`conversation_verified` 设为 true；
        - `conversation_title` 取本段 `selected_customer.name`；
        - 窗口 pid、句柄、进程名，以及 `conversation_verification_mode`、`conversation_token`、`conversation_title_mode`、`search_query`、`search_query_type`，都取自锚点；
        - `search_input_done`、`search_result_clicked` 设为 false；
        - 发送门禁相关字段按 `clickSearchResultDryRun` 成功时的写法复位（`state_machine.cjs:835-868`）；
        - 另外记录 `session_source: "reused_verified_conversation"` 和来源段号；
        - 其余字段（包括 `task_context`、`real_send_attempts`）保持不变。
     3. **核验会话：** 跑现有的 `verifyRealSendSessionAsync`（:316-324），外面用单独的阶段名 `session_reuse_verify` 包起来，不沿用 `verify_session`，避免闸门内的核验失败在日志里被当成真实的会话失败。不通过记为 `session_verify_failed`。
     4. **严格比对（新增，只在闸门里做）：**
        - 核验后的 pid、句柄与锚点一致，否则记为 `window_changed`；
        - `conversation_token` 非空，且与锚点完全相同，否则记为 `conversation_token_changed`。这一条**不适用**精确搜索模式的豁免；
        - 核验模式没有变化。
     5. **检查外部输入：**
        - 放在会话核验之后，这样检查范围覆盖到核验那一刻。
        - 调用 `options.windowInspector`。闸门自己的默认值是 `(ctx) => inspectForegroundWechatMainWindow(ctx, runPowerShellAsync)`（从 `wechat_window_driver.cjs` 引入 `runPowerShellAsync`），以免阻塞主进程；视觉分支（:539）的默认值不改。
        - 传入 `{ expectedPid, expectedHWnd }`（取自锚点），以及 `minIdleMs = max(1, ceil(now − anchored_at))`。
        - 要求 `inspectionOnly === true`、`strictPreparedWechatWindow` 通过，且 pid、句柄与锚点一致。
        - 结果映射：`wechat_user_active` → `user_input_detected`；`wechat_window_identity_mismatch` 或 pid/句柄不同 → `window_changed`；其他情况（含异常）→ `window_not_ready`。
     6. **全部通过：** 跳过 `prepare_window`、`click-search-result-dry-run` 和 `verify_session`，直接进入现有的图片分支（:726）或文字分支（:735-767）。这两个分支的代码不改。
     7. **回退：**
        - 先用开始前的快照原样 `saveState` 写回（闸门里 `blockSendGate` 等写入的字段一并撤销）；
        - 再从 :658 开始走原来的完整路径，每一步都不改；
        - 闸门的结果**不能**当作本段的 `blocked_reason`，本段成败只由完整路径决定。
   - 各步之间沿用现有的 `executionMayContinue` 检查，一旦暂停就按现有方式取消（`batch_cancelled`，未发送）。
   - **残余风险（写进 result，由用户知悉）：**
     - 空闲探测看不到以下时段内的人工输入：
       1. 上一段驱动最后一次自己的输入 → `anchored_at`（文字段约为发送后确认的 1–2 秒）；
       2. `anchored_at` 之后约 0.5–1 秒：`minIdleMs` 在 Node 侧算好，PowerShell 读空闲时间时已经过了进程启动这段；
       3. 探测之后 → 本段发送驱动启动：与现有路径"核验 → 图片脚本启动"的空档相同。
     - 这几段时间里如果切换了会话，token 比对仍会拦下。漏过的前提是切到"显示名相同"的会话；同名联系人已由第 1 步排除，剩下的只有与联系人同名的群聊、公众号等非通讯录会话，这与现有"按会话标题核验"模式的保证同一级别。
4. **诊断**
   - 闸门返回 `{ ok, action: "session_reuse", reuse_outcome, reused_from_part }`。
   - `reuse_outcome` 的取值：`reused`、`anchor_missing`、`anchor_expired`、`contact_changed`、`name_not_unique`、`session_verify_failed`、`window_changed`、`conversation_token_changed`、`user_input_detected`、`window_not_ready`。
   - 在 `wechat-send-diagnostics.cjs` 的字符串白名单（:65-71）里加 `reuse_outcome`，数字白名单（:96-107）里加 `reused_from_part`。
   - 这些值不是失败码，因此：
     - 字段名不要以 `reason` 结尾；
     - 不新增 `reason:` / `blocked_reason:` 字面量，辅助函数也不要取名 `failure`、`blocked`、`result`、`response`，因为 `scripts/wechat-failure-policy-review.cjs:6-13` 会扫描这些模式；
     - 不登记进规则目录。
5. **图片发送器可注入**
   - 新增 `options.imageSender`，默认仍是 `sendWechatImage`（:728）。
   - 只供自检使用，默认行为不变。
6. **远程关闭开关**（Claude 在审查时追加）
   - 在运行数据目录读取 `active_touch/feature-flags.json` 的 `multipartSessionReuse` 字段。文件不存在或该字段不是 `false` 时视为开启。
   - 为 `false` 时，每一段都走完整搜索（即当前 HEAD 的行为），`reuse_outcome` 记为 `disabled`，并加入第 4 步的取值列表。
   - 每个联系人开始时读取一次，不需要重启。文件损坏按"开启"处理，并写一条 warn 诊断。
   - 用途：异机如果出现复用相关的问题，测试人员放一个文件就能关闭，不用重新发版。

## 允许改动

- `desktop/rpa/active_touch/state_machine.dev.cjs`
- `desktop/src/main/touch-workflow.cjs`：仅限 `executePart` 和多段调用处（:303-365）
- `desktop/src/shared/wechat-send-diagnostics.cjs`：仅在白名单里加 `reuse_outcome`、`reused_from_part`
- `desktop/rpa/active_touch/self_check.cjs`、`desktop/src/main/touch-message-sequence.self_check.cjs`

## 禁止

- 复用路径不在搜索框输入，也不点击任何联系人或搜索结果。闸门只读：不移动窗口，不抢前台。
- 不改 `sessionCheckAsync`、`verifyRealSendSessionAsync` 的现有判定。
- 不改以下 PowerShell 脚本：会话观察、窗口检查、文字发送、图片发送（包括其中的 `exactSearchBinding`）。严格比对只能在闸门里**额外增加**。
- 锚点的限制：
  - 不写盘；
  - 不跨步骤、联系人或进程；
  - 只能来自本次调用中真正核验成功（`sent_verified`）的那一段；
  - 纯文字单段任务和其他调用方不启用。
- 不放宽任何现有检查：冻结身份比对、`setRealSendArm` 的身份检查、`sendReal` 内的会话复查都照常执行。
- 不改 `outcome_unknown` 处理，也不改"不自动补发"。
- 不改 `touch-message-sequence.cjs` 的段状态机。
- 不改 T4 的加载逻辑，也不改 T5 的 r008 / 熔断分支。
- 不做任何真实的微信操作。

## 验收（新增断言在当前 HEAD 上必须失败）

- **开关：** `feature-flags.json` 中 `multipartSessionReuse:false` 时，文字加图片的任务里图片段仍然完整搜索，搜索调用次数与 HEAD 相同，`reuse_outcome` 为 `disabled`；文件损坏时视为开启，并有 warn 诊断。
- **走真实入口：** `createTouchWorkflow` → 真实的 `executeMessageSequence` → 真实的 `executeVerifiedContactSend`。
- **只假 Win32 层：** 通过 `drivers` 和 `execute` 包装注入假的 `windowPreflight`、`windowInspector`、`sessionDriver`、`sendDriver`、`bubbleVerifier`、`imageSender`。
- **CLI：** `select-customer`、`calibrate`、`send --dry-run` 走真实 CLI；`click-search-result-dry-run`、`input-message-dry-run` 等会调用 PowerShell 的命令用假实现，并计数。
- **全程不启动 PowerShell**（例如把 `child_process.spawn` 换成计数桩，断言 0 次）。
- 下文"阶段事件"指 `stage=<名称>`、`phase=finish` 的 `send_stage` 事件。

1. **正常复用。** 精确搜索模式下发送"文字 + 2 张图 + 网址"，闸门全部通过：
   - `click-search-result-dry-run` 和 `windowPreflight` 各调用 1 次（只在第 0 段）；
   - `verify_session` 阶段事件 1 次，`session_reuse_verify` 阶段事件 3 次；
   - `windowInspector` 调用 3 次，每次都带锚点的 pid 和句柄，且 `minIdleMs ≥ 1`；
   - `select-customer` 调用 4 次；
   - 4 段都是 `sent_verified`；
   - `session_reuse` 阶段事件 3 次，`reuse_outcome=reused`，`reused_from_part` 依次为 0、1、2。
2. **两段之间会话被切走。**
   - 精确搜索模式：第 1 段闸门核验时 `sessionDriver` 返回同 pid/句柄、但不同的 token → `conversation_token_changed`；
   - 会话标题模式：同样注入 → `session_verify_failed`；
   - 两种情况下第 1 段都重新走 `windowPreflight` 和搜索，最终仍是 `sent_verified`。
3. **有外部输入、窗口变化或探测异常。** 以下情况都要重新搜索，本段最终 `sent_verified`，全程没有 `outcome_unknown` / `touch_part_exception`：
   - `windowInspector` 返回 `wechat_user_active` → `user_input_detected`；
   - `windowInspector` 返回不同的句柄 → `window_changed`；
   - `windowInspector` 抛异常 → `window_not_ready`。
4. **锚点超时。** 两段之间时钟前进 16 秒 → `anchor_expired`，回退。
5. **同名联系人不复用。** 通讯录中另有一位显示名相同、微信号不同的联系人 → `name_not_unique`，回退；`windowInspector` 调用 0 次。
6. **不跨步骤。** 文字段发出后暂停（沿用现有的 `pauseAfterText` 思路）。下一次 `runWorkflowStep` 中：
   - 第 1 段结果为 `anchor_missing`；
   - 第 1 段重新搜索。
7. **回退后完整路径失败。** 例如第 1 段闸门因 token 变化回退，随后搜索返回 `search_result_identity_unverified`：
   - 该段先有一条 `session_reuse` 阶段事件，`reuse_outcome=conversation_token_changed`；
   - 本段结果是完整路径的原因码，不是闸门结果；
   - 闸门阶段 `sendDriver`、`imageSender` 调用 0 次。

**护栏**（这几条在 HEAD 上已经成立，改动后必须仍然成立）：

8. 以下位置都不出现 `session_anchor`：任务文件、`message_parts`、passport、diagnostics.jsonl、`runWorkflowStep` 的返回值。
9. 现有用例全部通过：
   - 单段纯文字任务、自动回复视觉发送等用例的返回值不含 `session_anchor`；
   - 图片段 `outcome_unknown` 仍然全局暂停，且不补发。
10. `npm.cmd run check:self` 通过，其中包括 `wechat-failure-policy-review`（`touch-message-sequence.self_check.cjs` 由 `wechat-workflow.self_check.cjs:884` 调用）。

## 需用户本人验收/授权

- **内部发布：** `release:internal` / `publish:internal` 需要用户授权。
- **真实微信验证：** 需要用户授权测试账号和联系人，由用户本人执行，Codex 不做。
  1. 发一次"文字 + 3 张图 + 网址"，确认 4 段都发到同一个联系人；
  2. 文字发出后立即手动点开另一个会话，确认程序回退到搜索，没有发错人。
- **异机复验：** 从诊断包统计以下指标，与 9-23 基线（590 段 / 65.5 分钟 / 84 次失败）对比：
  - `reuse_outcome` 的分布，即复用命中率（操作员同时在用电脑时会大量出现 `user_input_detected`，属预期）；
  - 每人耗时 p50 / p90；
  - 图片段的搜索次数；
  - "文字已发、图片段重新搜索失败"的序列数。

  预期每个命中复用的后续段节省约 4–5 秒：保留了会话核验，又新增一次只读探测，所以省不满 6.66 秒。
