# T6b【P1】"重新加入并继续"改为一键

分支：`codex/workflow-retry-and-continue`

- **依赖**：代码上不依赖 T4、T5、T6a。
- **文件重叠**：
  - 与 T6a 都改 `WechatWorkflow.tsx`，但代码块不同（T6a 只改 :203-212）；
  - 与 T7a、T9 都改 `wechat-workflow.cjs`（T7a 改 reply step、`settleQueue`、`enroll`、`start`，不碰本卡的 retry 函数）。
- **建议顺序**：T6a → T6b → T7a，与 T6a 同批发布。

> 行号均指 HEAD `258e37a`。

## 现象（9-23 诊断包）

- 任务结束后，要等人工在跳过名单里点"重新加入"。
  - 3 次等待分别是 2.6 分钟、8.9 分钟、12.2 小时（最长一次 9-20 22:49 → 9-21 10:58）。
  - 3 次共重新加入 101 人（26、9、66），另有 26 人因误点标记被排除。
- 另有 5 次 `retry_skipped_task_running`：程序运行中点了"重新加入"，被拒绝。
- 每次恢复都要点两下：先"重新加入"，再"启动程序"。

## 现状（已核对）

- **任务级"重新加入"**：按钮在 `WechatWorkflow.tsx:442`，禁用条件是 `planLocked`（:338）。点击后：
  - 走 IPC `retry-task`（`wechat-workflow-ipc.cjs:201`），进入 `retryTask`（`wechat-workflow.cjs:777-786`）；
  - 结果只是把任务改回 pending、`phase="paused"`，还得再点一次"启动程序"。
- **跳过名单"全部重试"**：按钮在 `WechatWorkflow.tsx:433`，经 IPC `retry-skipped`（:202）进入 `retrySkipped`（`wechat-workflow.cjs:717-748`）：
  - 如果正在监听自动回复，并且没有当前或下一项有限任务，会先 `pauseWorkflow()`（:718-721）；
  - 重新加入后停在 paused，提示"点击启动程序后一次补跑"（`WechatWorkflow.tsx:398`）。
- **启动**必须走 IPC 层的 `start()`（`wechat-workflow-ipc.cjs:115-128`），它负责三件事：同步中拦截、打开浮窗并隐藏主窗口、预检失败时留在主页面。直接调用 `controller.start()` 不会打开浮窗。
- **点击校验**：
  - preload 有两道可信点击门（`preload-api.cjs:942-943`）：
    - `consumeWorkflowStart` 只认 `[data-xiaoxi-workflow-start]` 元素上的真实点击，现在只有启动按钮带这个属性（`WechatWorkflow.tsx:283,296,478`）；
    - `consumeWorkflowSave` 认 `[data-xiaoxi-workflow-save]`，重新加入、删除、添加任务等按钮都带这个属性。
  - retry 在 preload 的 :965-966；IPC 侧用 `validSender` 和 `assertClick`（`wechat-workflow-ipc.cjs:152-162`）校验一次性令牌。
- **可重试的判定**：
  - `canRetry`（`wechat-workflow.cjs:133-140`）调用 `canRetryWorkflowTask`（`touch-workflow.cjs:560-564`），只有确认未发送的任务才为 true；
  - 跳过联系人由 `retrySkippedResults`（`touch_task_state.cjs:240-313`）判断，排除结果未知的联系人和误点网络查找被隔离（投毒）的联系人。
  - 本卡不改这些判定。

## 要做

1. **`retryTask` 和 `retrySkipped` 支持 `andStart`。**
   - controller（`wechat-workflow.cjs`）：`retryTask(id, { andStart })` 在程序运行中时，沿用 `retrySkipped` :718-721 的规则：
     - 只有当前没有 `currentTaskId`、`nextTask()` 也为空（也就是只在监听或回复）时，才先 `pauseWorkflow()`；
     - 否则报原来的错误。
   - IPC（`wechat-workflow-ipc.cjs:201-202`）：`payload.andStart === true` 时，controller 操作成功后调用本文件的 `start()`。
     - 启动失败（例如联系人同步中）时，返回 `ok:false` 和错误信息；已重新加入的状态保留，不回滚。
   - preload（:965-966）：增加可选的 `andStart` 参数。
     - `andStart` 为真时改用 `consumeWorkflowStart()` 取令牌，保证"开始真实发送"仍然只能由启动类按钮的真实点击触发；
     - 不带 `andStart` 时仍用 `consumeWorkflowSave()`；
     - 一次点击只消费一次令牌。
2. **新增"全部重新加入并继续"。**
   - controller 新增一个方法（例如 `retryAll()`），"运行中"的规则同第 1 步（先暂停，再进 `serialize`），在同一个 `serialize` 内完成：
     - 当前账号下所有 `canRetry` 为 true 的任务，按 `retryTask` 处理；
     - 所有状态为 completed 或 needs_attention、且有可重试跳过联系人的触达任务，按 `retrySkipped` 处理（不带 `contactIds`）；
     - 同一任务两项都满足时，只走一次 `retrySkipped` 路径，计为 1 项。它会把当前位置移到最早的跳过联系人，之后照常走到原来暂停的那一位。不要接着再调 `retryTask`：任务此时已是 pending，`canRetry` 会报错；
     - 单项失败（例如 `retry_skipped_empty`）计入 `excludedCount`，不中断其余项。
   - 以下任务**整项不动**：
     - 有 `unknownResolution` 的任务（:141-148）；
     - `accountMismatch` 的任务；
     - 已 cancelled 的任务。
   - 返回 `{ taskCount, contactCount, excludedCount }`。没有可处理的项时报错，并且不启动。
   - IPC 新增通道 `wechat-workflow:retry-all-and-start`（`click=true`），成功后调用 `start()`；preload 用 `consumeWorkflowStart()`。
   - 日志沿用已有的 `touch.skipped_requeued`（:738-742）；"继续/重新加入"的完整日志留给 T9。
3. **界面（`WechatWorkflow.tsx`）。**
   - :442 按钮改为"重新加入并继续"（`andStart`）。
     - 禁用条件从 `planLocked` 改为与 :408-409 的 `canRetryWhileListening` / `retryLocked` 一致；
     - 按钮属性改为 `data-xiaoxi-workflow-start`。
   - :433 改为"全部重试并继续"（`andStart`，同样改为 `data-xiaoxi-workflow-start`）；监听中的文案改为"暂停自动回复，全部重试并继续"。
   - 单条"重试"（:436）保持只重新加入、不启动，仍用 `data-xiaoxi-workflow-save`，方便用户挑几位后再统一启动。
   - :393-400 的提示按 `andStart` 区分：
     - 一键路径改为"已重新加入 N 位并继续"；
     - 单条"重试"保留"点击启动程序后一次补跑"。
   - :422 中"再点击启动"的说法改为与新按钮一致。
   - 启动失败时显示返回的错误。
   - 状态行（:459-465）增加"全部重新加入并继续（N 项 / M 人）"：
     - 在程序未运行且可处理数大于 0 时显示，带 `data-xiaoxi-workflow-start`；
     - 计数直接取已有的 `canRetry` 和 `skipped_records[].retryable`，不需要新字段。
   - 同步更新 :91-92 的类型声明。
4. 结果未知的三个处置按钮（:423-430）处置后**仍不自动启动**。`TOUCH_RESOLUTION_NOTICES`（:109-113）不改。

## 允许改动

- `desktop/src/main/wechat-workflow.cjs`：只改 retry 相关函数（:717-748、:777-786）和新方法
- `desktop/src/main/wechat-workflow-ipc.cjs`
- `desktop/src/main/preload-api.cjs`：只改 workflow 段（:955-989）
- `desktop/src/renderer/WechatWorkflow.tsx`：可改 :91-92、:393-442、:459-465，不动 :203-212；如需样式可改 `WechatWorkflow.css`
- `desktop/src/main/wechat-workflow.self_check.cjs`

## 禁止

- 不改 `canRetry`、`canRetryWorkflowTask`、`retrySkippedResults`、`skippedRetryBlockedReason` 的判定。一键只是把两次点击合成一次，不扩大可重试范围。
- 结果未知的任务、被投毒的联系人不进入任何一键路径。
- 新通道必须经过 `validSender` 和一次性点击令牌校验。会启动程序的按钮只能用启动类点击门（`data-xiaoxi-workflow-start` / `consumeWorkflowStart`），不能借用保存类点击门。
- 不改 `touch-workflow.cjs`、策略文件和 RPA。

## 验收（新增断言在当前 HEAD 上必须失败）

测试使用 `wechat-workflow.self_check.cjs` 已有的 IPC 夹具（:10-66，`registerWechatWorkflowIpc` 加假窗口），全部经 `handlers.get("wechat-workflow:...")` 调用。夹具现在只有 `interact` 执行器（:40），需要加一个带 `canRetryWorkflowTask`、`describeSkippedWorkflowTask`、`retrySkippedWorkflowTask`、`describeUnknownWorkflowTask` 的触达执行器桩。

1. 对 `canRetry` 为 true 的任务调用 `retry-task` 并带 `andStart`：
   - 任务变为 pending；
   - `status().enabled === true`；
   - 浮窗 `showInactive` 被调用（`windows[0].visible === true`），主窗口被隐藏（`mainHideCount` 增加）。
2. 运行中的两种情况：
   - 只在监听（enabled，且没有当前和下一项有限任务）：先暂停再启动，最终 `enabled === true`；
   - 有有限任务在执行：报错，任务状态不变，不启动。
3. `retry-skipped` 带 `andStart`：跳过的联系人重新加入，并且 `enabled === true`。
4. `retry-all-and-start`，准备 4 项任务：2 项可重试、1 项有跳过联系人的已完成任务、1 项带 `unknownResolution` 的任务。
   - 前 3 项被处理；
   - 第 4 项仍是 needs_attention，`unknownResolution` 仍在；
   - 最终 `enabled === true`。
   - 另测没有可处理项的情况：返回 `ok:false`，`enabled === false`。
5. 以下情况既不重新加入，也不启动：
   - `canRetry` 为 false；
   - 点击令牌无效。
6. 启动失败（联系人同步中）：返回 `ok:false`，任务保持 pending，`enabled === false`。
7. `npm.cmd run check:self` 和 `npm.cmd run build:test` 通过。
8. 点击门在 node 自检里无法区分（没有 window），由 Claude 审查时核对：
   - 带 `andStart` 的调用和 `retryAllAndStart` 用 `consumeWorkflowStart`；
   - 对应按钮带 `data-xiaoxi-workflow-start`。

## 需用户本人验收/授权（Codex 不做）

- 与 T6a 同批发布，需用户授权。
- 发布后在异机上检查：
  - 点一次"重新加入并继续"或"全部重试并继续"，浮窗出现，任务从正确的联系人继续，已发出的内容不重发；
  - 诊断中"任务结束到重新加入"的等待时长。
