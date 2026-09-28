# T4【P0】状态轮询误触发"崩溃恢复"的竞态

分支：`codex/fix-touch-status-recovery-race`（与 T1 文件不重叠，可并行）

## 现象（异机 9-23 诊断包，1.1.53）

每个新建的精准触达任务，第一位联系人一开始就全局停机（3/3）：`select-customer`、`calibrate` 通过，接着 `click-search-result-dry-run` 报 `task_context_mismatch`，随后 `classification.unknown_reason_paused`。用户点"继续"和"启动"后，同一联系人成功。

## 根因（代码路径已复核）

1. `touch-workflow.cjs:197` 新建任务走 `createTask` 分支，**不经过** `loadWorkflowTask`，所以 id 没有进入 `recoveredTaskIds`（:63-75）。
2. `touch-workflow.cjs:293-295` 把当前联系人写成 `sending` 并持久化，然后启动 RPA 子进程。
3. 进度悬浮窗每 750ms 调用 `controller.status()`（`wechat-workflow-ipc.cjs:107-109`）。
4. `status()`（`wechat-workflow.cjs:246-262`）对**每个**任务调用 `skippedTouchState`（:149-153），没有状态门槛，接着进入 `describeSkippedWorkflowTask`（`touch-workflow.cjs:742-749`），再进入 `loadWorkflowTask`。
5. `loadWorkflowTask` 发现这个 id 不在集合里，且任务状态是 `running` 加 `sending`，于是调用 `recoverInterruptedTask`（`touch_task_state.cjs:611-680`），把一个正在执行的任务当成崩溃现场处理：
   - 多段消息（文字加图片）：`interruptedParts.length !== 1`，任务落到末尾被改成 `status="paused"`，当前联系人改回 `generated`。子进程的下一条命令在 `validateTaskContext`（`active_touch_cli.cjs:76-86`）校验到任务不是 `running`，报 `task_context_mismatch`。这就是日志里的现象。
   - **纯文字消息：`interruptedParts === null`，当前联系人会被标成 `outcome_unknown`，同时写入 `retry_blocked`、`awaiting_resolution`，而真实发送可能仍在进行。这是安全缺陷**：界面会要求人工核对一条其实正常的发送，并且永久阻断自动重试。

`status()` 里另外两条会进入 `loadWorkflowTask` 的路径（`canRetry` 的 :133-139、`unknownResolution` 的 :141-148、`reconcileUnknownResolutions` 的 :187-200）都只处理 `needs_attention` 的任务，不会碰运行中的任务。

## 要做

1. **状态读取与恢复分离**：新增只读加载函数（例如 `readWorkflowTask(id)`），只调用 `loadTaskState`，从不调用 `recoverInterruptedTask`，也不修改 `recoveredTaskIds`。`describeSkippedWorkflowTask`、`hasStartedWorkflowTask` 这类只为展示服务的函数改用它。
2. **新建任务登记为已恢复**：`touch-workflow.cjs:197` 分支创建并持久化任务后，把 id 加入 `recoveredTaskIds`。
3. 其余会修改任务的入口（执行一步、处置结果不明、重试跳过、编辑任务）保持用 `loadWorkflowTask`。崩溃恢复仍在应用启动后第一次真正执行或处置该任务时发生。
4. 在 result 中列出 `touch-workflow.cjs` 里每一处 `loadWorkflowTask` 调用，逐一说明它是"只读展示"还是"会修改任务"，以及改用了哪个函数。

## 允许改动

- `desktop/src/main/touch-workflow.cjs`
- 对应的 self_check（`touch-task-ipc.self_check.cjs` 或 `wechat-workflow.self_check.cjs`，以现有用例所在文件为准）

## 禁止

- 不改 `recoverInterruptedTask` 的恢复语义，因为真正崩溃时必须保守。
- 不改 `validateTaskContext` 的校验，也不把 `task_context_mismatch` 降级或移出全局阻断。
- 不动 T5 的 r008 分支（:420-429）。

## 验收（新增断言在当前 HEAD 上必须失败）

1. **纯文字任务**：执行器持有 `sending` 状态期间（用 fake driver 阻塞），反复调用 `describeSkippedWorkflowTask` 或 `controller.status()`，之后当前联系人**不是** `outcome_unknown`，任务仍是 `running`，执行结束后状态为 `sent_verified`。
2. **多段任务**：同样的注入，任务不会变成 `paused`，不产生 `task_context_mismatch`。
3. **真实崩溃仍能恢复**：模拟重启（新建 workflow 实例）后，任务状态为 `running` 加 `sending` 时，第一次执行这一步会按原逻辑恢复（纯文字标为结果不明，多段暂停）。
4. `npm.cmd run check:self` 通过。

## 需用户本人验收

- 发布后在异机新建一个精准触达任务，第一位联系人不再停机，诊断中不再出现 `task_context_mismatch`。
