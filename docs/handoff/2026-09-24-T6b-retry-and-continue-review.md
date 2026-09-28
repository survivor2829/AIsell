# T6b 审查结论：通过，已合并（2026-09-27，合并提交 `cc05e75`）；1 处小缺陷和测试缺口转入 T9b 变基

审查对象：`codex/workflow-retry-and-continue`（086afea，基线 5f2b93f）

## 已做对

- `andStart`、`retryAll`、`retry-all-and-start` 的控制器、IPC、preload 都已接好。一键启动走的是 `start()` 的 IPC，同步检查、悬浮窗、隐藏主窗口都照旧生效。启动失败时，保留已重新加入的任务。
- 安全探针 15/15 通过（真实 touch-workflow、真实控制器、真实 IPC）：
  - 混合任务 retryAll：只发了"部分已发送"那一行里没发的图片，以及身份跳过的那个联系人。被标记异常、结果未知、已发送、有已点击段的行，一条都没发。
  - 连点两次、并发调用：只有一次成功，每人只发一次；重放的或缺失的令牌会被拒绝。
  - 有限任务正在发送时、用户点暂停之后：一键操作都会被拒绝。`andStart:"true"`（字符串）不会启动。其他账号的任务、已取消的任务都会被忽略。
- T6a 的 `resumableFreshEdit` 没有被放宽（N02–N05 都被抓到）。T6a 遗留的 N09、N10、N12、N18、M15 都补了测试。
- 变异 27 个，自检抓到 23 个。与 f78a8b0 合并后 `check:self`、`build:test` 都通过。

## 遗留（转入 T9b 变基，见其卡顶部）

1. **【代码，小】`pauseForRetry` 在资格检查之前执行**（`wechat-workflow.cjs` 约 :757，被 `retryTask` 约 :805、`retryAll` 约 :815 调用）。
   - 情形：处于接待中时，用户点"重新加入并继续"，但此时 `canRetry` 已经变成 false。调用返回失败，自动回复却一直停着没恢复。
   - 基线的行为是直接拒绝，不产生副作用。
   - 修法：先做资格检查再暂停；或者失败时恢复接待。
2. **测试缺口**：
   - `retry-all-and-start` 的令牌被重放或无效（T08）；
   - 其他账号已完成、但还有跳过行的任务（T02）；
   - `andStart` 不是严格的 `true`（T07）；
   - 暂停过程中重试（T13）；
   - `assertPlanEditable`（T16）；
   - `retryAll` 的串行化、持久化和重启（T14、T17）。
   - 审查脚本：`C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t6b\`（`probe.cjs`、`mutate3.cjs` + `mutations.json`）。
