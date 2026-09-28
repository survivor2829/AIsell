# T4 审查结论：通过，合并前补 3 处小修

审查对象：`codex/fix-touch-status-recovery-race`（bbf43e4）

## 二审（d7cb510）：通过，已合并（2026-09-24，合并提交 `1eee65e`）

- 三处小修都已落实，并用变异测试逐一确认有效：删掉 `recoveredTaskIds.add(id)`、删掉 catch 中的 `delete(id)`、把计算顺序调回旧顺序，这三种改法都会让 `wechat-workflow` 自检失败。
- 对抗审查确认：最外层 catch 只会在 execute 结束之后执行，加上 `activeStep` 互斥和 needs_attention 门槛，恢复不会和正在进行的发送重叠；单段消息的恢复结果只会是 `outcome_unknown`，不会误判为"未发送"，也不会自动补发。
- 合并后的版本 `check:self` 84 项全部通过，`build:test` 也通过。
- **遗留一处（不涉及安全）**：catch 的条件判断读的是内存行状态。如果是 persist 本身抛出 ENOSPC，内存行已经先被改写，判断不成立，任务在本进程内会卡住，重启后可恢复。修法是改为无条件 `delete(id)`，已写进 T5 卡的第 0 步。
- **另记两项（以后单独出卡）**：
  - 任务已经持久化为 running、但还没写入 sending 时抛异常，重启后也会卡住（旧问题）；
  - `auto-reply-ipc.self_check.cjs:1960,1986` 用 `/ffff/`、`/bbbb|cccc|dddd/` 去匹配含随机 hex 的日志，大约每 500 次会误报一次失败。

## 结论

**核心修复正确，可以合并。** 合并前请在同一分支追加下面 3 处小修。T5 要等 T4 合并后再开始。

## 验证结果

- 把 `touch-workflow.cjs` 换回 3918341 后，新用例失败（实际是 `paused`，预期是 `running`）。换回新代码后通过。
- 对抗审查写了完整链路探针：IPC start、真实的 750ms 广播、`wechat-workflow:status` 和 `status()`。在基线上能复现竞态，在 T4 上不再复现。纯文字任务和多段任务都测了。
- `describeUnknownWorkflowTask` 和 `canRetryWorkflowTask` 在发送中轮询，任务都保持 `running/sending`。
- 在四张卡合并后的版本上，`check:self` 全部 84 项通过。

## 合并前小修

1. **测试能抓到回退**：变异测试表明，删掉 `recoveredTaskIds.add(id)` 后自检仍然全绿。请在用例的轮询里加上 `controller.status()`（走完整的 `status()` 链路），或者加上 `canRetryWorkflowTask(taskRecord, payload)`。要求：删掉 `add(id)` 后测试必须失败。
2. **同一进程内卡死**：新任务已经持久化了 `sending/prepared/clicked`，随后 `runWorkflowStep` 从最外层 catch 退出（例如 persist 抛出 ENOSPC 或 EPERM）。这时 store 是 `needs_attention`，磁盘上是 `running+sending`。因为 id 已在 `recoveredTaskIds` 里，本进程内既没有重试按钮，也没有人工核对面板，只能重启。
   - 修法：在最外层 catch 中，如果当前行处于 `INTERRUPTED_SEND_STATES`，执行 `recoveredTaskIds.delete(id)`，让已有 `needs_attention` 门槛的 `canRetry` 路径去做恢复。
   - 加一个故障注入用例覆盖。不会自动重发。
3. **`status()` 计算顺序**（`wechat-workflow.cjs:254-256`）：先计算 `canRetry`（会恢复），再计算 `unknownResolution`。这样重启后出现上述边缘状态时，第一次状态快照就能显示人工核对面板。

## 记录，暂不处理（以后单独出卡）

- `readWorkflowTask` 用的是 `loadTaskState`。它读文件失败时会从备份恢复，并把状态写成 `paused`（`touch_task_state.cjs:581-598`），所以不是严格只读。概率很低，而且要改 T4 允许范围之外的文件。以后给展示路径单独做一个"读失败就返回 null"的纯读取函数。
