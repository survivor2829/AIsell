# T6a【P1】"明确未发送"的失败：有界重试后跳过，连续同因才熔断

分支：`codex/touch-presend-bounded-recovery`（在 T5 合并后开始。T4、T5、本卡都改 `touch-workflow.cjs`；与 T5 同改 `wechat-failure-policy.cjs` 和 `touch-message-sequence.self_check.cjs`。T8 也改 `touch-workflow.cjs`（:303-365，与本卡的 :393-548 不重叠）和 `touch-message-sequence.self_check.cjs`，谁后合并谁 rebase。T6b 是一键"重新加入并继续"，单独出卡，与本卡同批发布）

> 行号均指 HEAD `258e37a`。T4、T5 合并后会偏移，以函数和分支语义为准。

## 现状

- `touch-workflow.cjs:393-544` 是 `send_attempted=false` 的分流。任务内能恢复的只有四类：
  - 图片点击前超时，直接跳过（:398-409）；
  - 身份类（:410-468，T5 负责）；
  - environment 类，每 30 秒重试、最长 10 分钟后跳过（:469-500）；
  - 已登记的 recoverable 类，等 5/15 秒重试，之后跳过（:501-533）。
- 其余失败都落到 :534-543 的 `attention(...)`。未登记码按 `wechat-failure-policy.cjs:97-100` 判为 `blocker/global`（`known:false`），已登记的 blocker 码多数也是 global，结果是整个工作流停机。
- 09-15 晚客户机共 16 次全局停（`docs/reviews/2026-09-16-customer-evening-incident-and-fixes.md:11-19`）。按 HEAD 的分类重算，下面 8 次今天仍会全局停：
  - `message_snapshot_unavailable` 5 次；
  - `image_driver_failed` 2 次；
  - `atomic_send_not_verified` 1 次。
- 历史包里另有 `atomic_draft_changed` 2 次、`wechat_send_point_obscured` 2 次（9-23 调研报告）。
- 下面这些码在 `send_attempted=false` 时都产生于点击发送**之前**（已逐条核对）：

  | 原因码 | 位置 | HEAD 分类 |
  |---|---|---|
  | `message_snapshot_unavailable` | `rpa/active_touch/state_machine.dev.cjs:434`（写入 prepared 之前） | 未登记 → global |
  | `atomic_send_not_verified` | `state_machine.dev.cjs:470`，仅当发送驱动返回 `sendAttempted===false`。此时 prepared 已写入并回调（:455-457），`persistNotAttempted` 再回调 `"sending"`（:276），所以 :394 能进入未发送分支 | 未登记 → global |
  | `atomic_draft_changed` | 发送脚本 `wechat_window_driver.dev.cjs:385`（未点击，`sendAttempted=$false`），同样经 `state_machine.dev.cjs:468-470` 进入 `persistNotAttempted` | 未登记 → global |
  | `message_input_failed[_<诊断>][_attempts_N]` | `state_machine.cjs:903-913`，显式 `send_attempted:false`；诊断取 `draftCheck` 或驱动 reason | 除 `_wechat_user_active` 外都未登记 → global |
  | `wechat_focus_failed` | `wechat_window_driver.cjs:344`（`SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT`）。每个 PowerShell 步骤前都会先跑这段（:364、:2028），步骤脚本没有有效输出时才拿它当原因（:404-409、:2174-2186）。发送点击步骤如果这样失败，结果里没有 `sendAttempted`，`state_machine.dev.cjs:468-472` 会记为结果未知 | 未登记 → global |
  | `wechat_clipboard_read_failed` | 生产路径只在输入脚本 `wechat_window_driver.cjs:2594-2596` 产生，经 `state_machine.cjs:903-908` 包装成 `message_input_failed_wechat_clipboard_read_failed`；裸码只经 `wechatWindowReason`（`state_machine.cjs:316`）透传 | 未登记 → global |
  | `image_driver_failed` | `wechat_image_send.dev.cjs:386`（异常消息不合规时的兜底）；只有点击前失败时 `sendAttempted=$false` | 已登记 blocker/global（policy:51） |

- **重试是安全的**：`executeVerifiedContactSendCore`（`state_machine.dev.cjs:514-768`）每次都从选人重新走一遍：`select-customer`（:642）、冻结快照比对（:651）、`prepare_window`、`click-search-result-dry-run`（resolver 身份判定）、`verify_session`、输入、send 预检、`sendReal` 会话复核和发送前快照。身份核验一步不少。现有自检也把"点击前草稿变化可以安全重试"当作约束（`rpa/active_touch/file_helper_send.self_check.cjs:112`）。
- **跳过也是安全的**：跳过就是不发送。`pre_send_skipped` 在可重试集合里（`touch_task_state.cjs:14`），之后可以"重新加入"补跑。

## 与计划和调研不符之处（已核实）

1. **`image_existing_draft` 在当前源码里不存在。** 这个名字来自 09-16 报告；现在的码是 `image_existing_draft_clear_failed`（`wechat_image_send.dev.cjs:311`），已登记为 recoverable（`wechat-rule-catalog.json:2842`），HEAD 已经走有界恢复。本卡只给它加回归断言。
2. **`image_driver_failed` 已登记为 blocker/global**，`scripts/wechat-failure-policy-review.self_check.cjs:35` 固定了这个分类，而且同一个码在点击后也会出现。**不改它的分类**。新路径按 `send_attempted === false` 判断，不看分类。
3. **catalog 里已是 blocker 的码不改分类**，例如 `wechat_window_identity_mismatch`、`atomic_conversation_changed`、`wechat_send_point_obscured`。原因：同一个 reason 在 `workflowPolicies` 和 catalog 里分类不一致时，策略文件加载就会抛错（`wechat-failure-policy.cjs:79-82`）。
4. **"账号/登录类必须停"要拆开看**：
   - `wechat_login_required` 目前是 environment（catalog wx1-r001），走 :469-500 的等待；现有用例 `touch-message-sequence.self_check.cjs:234-272` 固定了这个行为。本卡不改它。
   - `wechat_account_*` 属 blocker，列入下面的排除名单。
5. **调研漏了一个必须排除的码：`wechat_search_result_landing_unverified`。**
   - 位置：`wechat_window_driver.cjs:1955`（点击前采集会话头失败）、`:1967-1970` 和 `:1990`（点击后）。点击后的两处已经点了搜索结果，却无法核验落到了哪里（`actionAttempted=$true`），提示文案写的是"不会自动重试"（`state_machine.cjs:348`）。
   - 它的 `send_attempted` 虽然是 false，但可能已经发生过点击，不能进入自动重试。
6. **同名码也用于"结果未知"。** `message_snapshot_unavailable`（`state_machine.dev.cjs:900`，`sendAttempted=true`）和 `atomic_send_not_verified`（:472，true 或 null）都会在点击后出现。把它们登记为 recoverable 不影响结果未知的处理，原因如下：
   - `touch-workflow.cjs:393-394` 和 `touch-task-ipc.cjs:781-783` 都先看 `send_attempted`；
   - `wechat-workflow.cjs` 只用分类里的 `attentionScope`，而结果未知时 touch-workflow 报的码是 `outcome_unknown`（global）。

   所以下面的"禁止"里要求：任何地方都不能只凭分类决定重试。

## 要做

1. **排除名单**：在 `touch-workflow.cjs` 的 `IDENTITY_SKIP_REASONS`（:42-49）旁新增 `TOUCH_PRE_SEND_STOP_REASONS`，按 `failurePolicy.reasonCode` 匹配（这个值已经规范化过：非法码记为 `invalid_unclassified_reason`，缺码记为 `task_attention_reason_missing`）。名单内的码保持现有处理，即 :534-543 的 attention，停机范围按策略。
   - 授权与任务上下文：`batch_authorization_missing`、`task_context_missing`、`task_context_mismatch`、`executor_contact_mismatch`（`active_touch_cli.cjs:68,85,168`）、`contact_snapshot_changed`、`touch_sequence_changed`、`contact_or_message_missing`
   - 账号：`wechat_account_identity_missing`、`wechat_account_not_verified`、`wechat_account_changed`、`wechat_account_directory_missing`、`wechat_account_ambiguous`
   - 发送门禁与防重：`real_send_already_attempted`、`real_send_not_armed`、`real_send_explicit_allow_missing`、`real_send_final_confirmation_missing`、`real_send_gate_failed`、`real_send_session_not_verified`、`send_gate_not_passed`、`prepared_task_persist_failed`（`state_machine.dev.cjs:459`）
   - 可能已点击、落点未核验：`wechat_search_result_landing_unverified`
   - 身份冲突：`wechat_id_name_conflict`、`contact_identity_ambiguous`
   - 内容完整性：`touch_image_changed`、`image_attempt_context_missing`
   - 没有可用原因码：`task_attention_reason_missing`、`invalid_unclassified_reason`
2. **暂停判定提前。** 放在身份分支（:410-468）之后、environment 分支（:469）之前。命中下列任一条件时，按 :534-538 的写法返回 pending：
   - 条件：`!enabled()`；或原因是 `batch_cancelled`（`state_machine.dev.cjs:179-187`）；或原因是 `workflow_paused`（`touch-workflow.cjs:331-333`、`touch-message-sequence.cjs:63`）。
   - 返回时：不改 `pre_send_recovery_attempts`，不写也不删 `environment_recovery_started_at`，不计入熔断。
   - 为什么要放在 environment 前面：`workflow_paused` 在 policy:41 属于 environment，HEAD 上会走 :469 开始 10 分钟计时。恢复运行时如果已经超过 10 分钟，下一次环境失败会立刻跳过；本卡又把这个跳过接进熔断，暂停就会被算成失败。
3. **把 :501 的条件泛化。** 现在是 `recoverable && known`，改为同时满足：
   - 已在 :393-394 的 `notAttempted` 分支内，**并且** `result.send_attempted === false`（严格相等。只有 `send_result` 为 not_attempted 还不够）；
   - 原因码不在排除名单；
   - 分类不是 environment（environment 仍走 :469-500）。

   重试节奏、次数和跳过写法完全沿用 :501-533：等 5 秒和 15 秒各重试一次，第 3 次失败记为 `pre_send_skipped`，并调用 `recordSkippedResult`。

   - `send_attempted` 为 null 或 true 的结果一律不进新路径，包括 `atomic_send_not_verified` 在 `state_machine.dev.cjs:472` 的情况。它们仍走 :545-548 的 `outcome_unknown`。
4. **熔断：复用 T5 的"连续跳过计数 + 暂停出口"，不另写一套。**
   - 计数键：身份跳过沿用 T5 的 `rule_id`；本卡的发送前跳过用 `reasonCode`。两类键加前缀区分。
   - 接入所有 `pre_send_skipped` 出口：
     - :398-409，图片点击前超时；
     - :476-487，环境等待满 10 分钟；
     - 第 3 步泛化后的出口。
   - 规则：
     - 同一个键连续到第 3 位联系人、且这一位的恢复次数已用完时，触发熔断；
     - 键不同就从 1 重新计；
     - 以下情况计数清零：任一联系人 `sent_verified`；联系人以其他方式离开当前位置（:246-258 的快照变化跳过、人工处置）；`retrySkippedWorkflowTask`（:751-767）重新加入跳过的联系人。清零放在 `touch-workflow.cjs` 里做，不改 `touch_task_state.cjs`。
   - 触发后的处理：
     - **第 3 位不跳过**，仍作为当前联系人：`generated`，`retry_blocked=false`，`send_attempted=false`，`pre_send_recovery_attempts` 归零，删除 `environment_recovery_started_at`。多段消息保留已发的段和 `not_attempted` 的段。
     - 计数清零。
     - 返回 attention。原因码：T5 的熔断码如果不带搜索/r008 语义就直接复用；否则新增 `touch_pre_send_failure_streak`，在 `workflowPolicies` 登记为 `blocker/global`。
     - 提示文案："连续 3 位联系人因同一原因在发送前失败，失败的内容都没有发出，已暂停；已发出的内容不会重发。请检查微信后重新加入继续。"（多段任务里前两位的文字可能已经发出，不能写成"消息均未发出"。）
   - **为什么不能"第 3 位跳过后再停"**：跳过后，当前联系人变成下一位的新行，没有 `message_parts`。
     - 多段任务里，`canContinueTouchResult(row, true)` 会返回 false（`touch-message-sequence.cjs:14-20`），于是 `canRetryWorkflowTask`（`touch-workflow.cjs:560-564`）为 false。
     - 结果：任务上没有"重新加入"按钮，页面提示"不能直接重试，请先核对微信中的实际结果"（`WechatWorkflow.tsx:422`），这与实际情况不符。用户只能绕道跳过名单里的"全部重试"。
     - 如果第 3 位恰好是最后一位，按 :527-528 的写法任务会先被标成 completed，再被 `attention()`（:177-182）改成 paused，状态自相矛盾。
   - 如果 T5 合并后的 r008 熔断正是"跳过后再停"：先用多段任务写用例复现上面的问题，再在共用出口里一起改，并同步修改 T5 的断言（在 result 中说明）。
5. **登记**（`wechat-failure-policy.cjs`）：
   - `workflowPolicies` 新增，分类都是 `recoverable`、范围都是 `task`：`message_snapshot_unavailable`、`atomic_send_not_verified`、`atomic_draft_changed`、`wechat_focus_failed`、`wechat_clipboard_read_failed`。
   - 在 `classifyWechatFailureReason` 中紧接 :94 的 user_active 正则之后，按顺序加两条：
     1. `^message_input_failed_wechat_window_not_foreground(?:_attempts_[1-9]\d*)?$` → `environment/global`。它与 `wechat_window_not_foreground` 同类（输入脚本 `wechat_window_driver.cjs:2585` 就直接用这个 reason），应该等待，而不是 5 秒后又去抢前台。
     2. 其余 `^message_input_failed(?:_[a-z0-9_]+)?$` → `recoverable/task`。
   - 不新增 catalog 行：catalog 行要求源码里有对应的 rule id 字面量（`src/main/failure-evidence.self_check.cjs:19-23`）。
6. **界面文案**：在 `WechatWorkflow.tsx:203-212` 的 `TASK_ERROR_LABELS` 中加熔断码的文案；T5 的熔断码如果还没有文案，也一并加上。否则页面会按分类显示 :216 的"本次结果不能安全确认……请先核对微信中的实际结果"，与"失败的内容都没有发出"矛盾。
7. **现有断言按新语义改写**（语义变了，不是放宽），并在 result 中逐条列出：
   - `touch-message-sequence.self_check.cjs:106-110`：未登记码 `simulated_image_failure`，`send_attempted=false`，原来期望 `needs_attention`。改为：
     - 首次返回 pending，`waitingReason` 为 `wechat_pre_send_recovery`；
     - :109 的 `canRetryWorkflowTask` 改为期望 false。任务仍在运行，已排定自动重试，不需要人工重新加入，与 :245 的语义一致；
     - 保留"文字不重发"（:115）和"同一 part 事务"（:116-117）两条断言。
   - `:414-421`：`atomic_conversation_changed`。改为首次返回 pending，并断言它不是 `identity_skipped`。原断言的本意是"不能误判为联系人不存在"，这一点保留。

## 允许改动

- `desktop/src/main/touch-workflow.cjs`
- `desktop/src/shared/wechat-failure-policy.cjs`：只做第 5 步的登记，以及熔断码
- `desktop/src/renderer/WechatWorkflow.tsx`：只改 :203-212 的 `TASK_ERROR_LABELS`
- `desktop/src/main/touch-message-sequence.self_check.cjs`、`desktop/scripts/wechat-failure-policy-review.self_check.cjs`

## 禁止

- 不改 environment 分支的等待参数，不改 `wechat_login_required` 等 environment 码在运行中的处理。例外只有两处：第 2 步把暂停判定放到它前面；它的跳过出口接入熔断。
- **任何地方都不能只凭分类为 recoverable 就重试**：新路径和已有路径都必须同时满足 `send_attempted === false`。
- 不改 `outcome_unknown` 路径（:368-374、:545-548），不改 `UNCERTAIN_SEND_STATES`，不自动补发。
- 不改 `rpa/` 下的驱动、状态机、resolver 和身份判定；不改 `touch_task_state.cjs`；不改 `touch-task-ipc.cjs`。
- 不改已有 catalog 行和已登记码的分类，`image_driver_failed` 仍是 `blocker/global`。
- 不动 T5 的 r008 与身份恢复逻辑。唯一例外是第 4 步的共用熔断出口。
- 不改 `canContinueTouchResult`、`retrySkippedResults` 的判定。

## 验收

第 1–4、8 条，以及第 6 条中关于 `workflow_paused` 的断言，在当前 HEAD 上必须失败；其余是回归护栏。

测试走 `createTouchWorkflow(config).runWorkflowStep`，写在 `touch-message-sequence.self_check.cjs` 现有夹具中（:46-101）。

1. **逐码注入**，每个码都带 `send_attempted:false`：
   - 覆盖的码：
     - 文字段：`message_snapshot_unavailable`、`atomic_send_not_verified`、`atomic_draft_changed`、`message_input_failed`、`message_input_failed_clipboard_write_or_paste_failed_attempts_2`、`message_input_failed_wechat_clipboard_read_failed`、`wechat_focus_failed`、`wechat_clipboard_read_failed`、`wechat_window_identity_mismatch`、一个新造的合法未登记码；
     - 图片段：`image_driver_failed`，以及作回归的 `image_existing_draft_clear_failed`。
   - `atomic_send_not_verified`、`atomic_draft_changed` 的桩要按真实顺序回调：先 `onTransition("prepared")`，再 `onTransition("sending")`（对应 `state_machine.dev.cjs:457`、`:276`），然后返回。
   - 期望：
     - 第 1 次返回 pending，`retryAfterMs=5000`，`waitingReason` 为 `wechat_pre_send_recovery`；
     - 第 2 次 `retryAfterMs=15000`；
     - 第 3 次记为 `pre_send_skipped`，`progress.done` 加 1；
     - 全程不出现 `needs_attention`。
2. `message_input_failed_wechat_window_not_foreground_attempts_3` 返回 `wechat_environment_recovery`，`retryAfterMs=30000`。
3. **熔断**：单段任务和多段任务（文字加图片，图片段失败）各测一次。夹具现在只有 2 位联系人（:46-47、:53），需要加第 3 位。
   - 前 2 位记为 `pre_send_skipped`；第 3 位返回 `needs_attention`，其原因码按 `classifyWechatFailureReason` 得到的 `attentionScope` 为 global。
   - 第 3 位不被跳过，`canRetryWorkflowTask` 为 true。
   - 继续执行后，第 3 位重走整条链路；多段任务不重发已发出的文字（看执行器调用序列）。
4. **计数清零与累计**：
   - 序列"X 跳过、成功、X 跳过、X 跳过"不熔断；
   - 序列"X、Y、X"不熔断；
   - 2 位联系人的任务，两位都因 X 跳过、任务完成；调用 `retrySkippedWorkflowTask` 重新加入两位，再都因 X 失败：两位都记为 `pre_send_skipped`，不熔断（计数已清零）；
   - 连续 3 次环境等待满 10 分钟后的跳过会熔断；
   - 连续 3 次图片点击前超时的跳过也会熔断。
5. **排除名单逐码**：返回 `needs_attention`，不计重试次数，不跳过。其中必须包含 `wechat_search_result_landing_unverified`、`task_context_mismatch`、`wechat_account_changed`、`real_send_already_attempted`。
6. **暂停**：
   - `enabled` 为 false 时执行器返回 `batch_cancelled`：结果为 pending，`pre_send_recovery_attempts` 不变，不计入熔断；
   - 文字发出后暂停，序列返回 `workflow_paused`：结果为 pending，行上**没有**写入 `environment_recovery_started_at`（HEAD 上会写入）。
7. **结果未知**：
   - 场景 a：`send_attempted:null`，原因为 `atomic_send_not_verified`；
   - 场景 b：`onTransition("prepared")` 之后不回调 `"sending"`，直接返回 `send_attempted:false`。
   - 两种都期望：`outcome_unknown` 并全局停；重建 workflow 实例后，执行器调用次数不增加。
8. **策略**：第 5 步新登记的码 `known:true`，分类与第 5 步一致；`image_driver_failed` 仍是 `blocker/global`；`message_input_failed_wechat_user_active` 仍是 `environment/global`。
9. `npm.cmd run check:self` 通过。它包含 `wechat-failure-policy-review`，并通过 `wechat-workflow.self_check.cjs:884` 运行本卡的 touch-message-sequence 自检。
   - `failure-evidence.self_check.cjs` 不在 check:self 名单里，要另跑 `node src/main/failure-evidence.self_check.cjs`。
   - 注意：策略是共享的，新登记的码也会让独立触达页走有界恢复或环境等待（`touch-task-ipc.cjs:790`、`:831`）。在 result 中说明这一点。

## 需用户本人验收/授权（Codex 不做）

- 与 T6b 同批走 `release:internal` / `publish:internal`，需用户授权。发布后异机复验以下指标：
  - 每百人全局停机次数（按 reason 统计）；
  - `pre_send_skipped` 占比；
  - 熔断触发次数和原因；
  - 跳过后补跑的成功率；
  - 确认没有任何 `outcome_unknown` 被自动补发。
- 测试号真机故障注入：测试账号和联系人范围需用户授权。
  - 运行中占用剪贴板、把微信切到后台，观察三步：有界重试 → 跳过 → "重新加入"补跑成功；
  - 连续 3 人同因失败时暂停，且第 3 人没有被跳过。
