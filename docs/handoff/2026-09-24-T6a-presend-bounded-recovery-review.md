# T6a 审查结论：打回（1 处未修完 + 2 处小缺陷 + 测试缺口，在同一分支追加）

审查对象：`codex/touch-presend-bounded-recovery`（bf12c55，基线 c8adade）

## 已做对

- 发送安全的核心没问题。24 个故障注入场景全部通过，其中 15 个在 c8adade 上会失败。
  - 有界重试恰好 3 次，然后跳过。
  - 结果未知时一律不重试：`send_attempted` 为 null、true、字符串 "false"，或只有 `not_attempted`，都按 `outcome_unknown` 处理，新开实例后重发 0 次。
  - 点击后再返回 false，按结果未知处理；多段消息的文字、图片都不会重发。
  - 熔断在第 3 位联系人触发，这位联系人不被跳过，可以继续；X/Y/X、中间成功、身份跳过、快照变化、结果未知，都会让连续计数清零。
- T5 的隐私和 r008 测试仍然通过。
- 0b 的纯读取函数到位，展示路径都改用它。
- 新原因码已登记，`touch_pre_send_failure_streak` 和界面文案都已加上。
- 变异 36 个，作者的测试抓到 27 个。
- 与 7d1daa3 合并后，`check:self` 87 项和 `build:test` 都通过。

## 必须修

1. **【0a 没修完】多段消息（文字+图片）在写入 sending 之前抛异常，重启后仍然没有重试按钮。**
   - 恢复逻辑（:106）会把任务正确地暂停成"上次任务未完成"。但 `canRetryWorkflowTask`（`touch-workflow.cjs:660-663`）只用 `canContinueTouchResult(row, true)` 判断，这个函数要求行上有 `message_parts`，于是 `canRetry=false`，和 c8adade 一样。
   - 续跑路径（:251 `resumableFreshEdit`）已经允许这种"全新、未发送"的行继续，两处条件对不上。
   - 修法：让 `canRetryWorkflowTask` 接受和 `resumableFreshEdit` 同样的条件，最好把条件抽成一个函数，两处共用。
   - 用例：图片任务在 `writeJsonAtomic(contacts.json)` 抛异常，重启后 `canRetry=true`，重试后文字和图片各发 1 次，不重复。
2. **日志级别判断和实际分支不一致**（`:448-455`）。
   - 判断时没看行状态（prepared、clicked、结果未知）、误点提醒路径和 `!enabled()`。结果是单段消息 `prepared → send_attempted:false`（实际走结果未知）也记成 warn，误点提醒也记成 warn。
   - 修法：先确定走哪个分支，再按这个分支决定日志级别。
   - 用例：这两种情况都记 error。
3. **passport 失败记录多了。**
   - 图片点击前超时的跳过，现在写 2 条：error 级日志 1 条，:368 显式 `recordFailure` 1 条；以前只有 1 条。
   - 环境类用尽后的跳过也多出 1 条。
   - 要求：每次最终跳过或熔断，只写 1 条（卡片第 1 条）。用真实接线测试断言条数。

## 必须补的测试（变异存活，代码行为是对的）

- M18：熔断出口的"部分已发送"计算。
- M24：熔断的界面文案。
- M27：已停用时 `workflow_paused` 的处理。
- M33：身份类与发送前类两种连续计数互相清零。
- 另外 M08（快照变化清零）、M09（人工处理清零）、M28（`!enabled()` 暂停）、M32 只有审查探针覆盖到，请写进自检。
- 熔断路径的真实 passport 接线；卡片 7b 在新开实例上重跑。

## 顺带发现（不属于本卡）

- `failure-evidence.self_check` 在 c8adade 上就失败（"missing source image-r015"）。它不在 `check:self` 里，属于 B 线"接入 12 个未登记自检"要处理的范围。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t6a\`：探针 `DESK=<你的工作区>/desktop node probe.cjs` 和 `probe-restart.cjs`（同样用 DESK）；变异 `WT=<你的工作区> node mutate.cjs mutations*.json`。上面列出的存活项都必须被抓到，`check:self`、`build:test` 都要通过。

## 二审（ceaa740）：通过，已合并（2026-09-27，合并提交 `9ab1864`）

- 一审 3 条必须修都做到了：
  - 恢复入口和 `canRetryWorkflowTask` 共用同一个 `resumableFreshEdit`。多段任务在发送前出现异常，重启后可以重试，文字和图片各发 1 次。
  - 日志级别按实际走的分支来定。
  - 每次最终跳过或熔断只写 1 条 passport 失败记录（用真实 store 测过）。
- 一审存活的 8 个变异全部被抓到。24 个安全场景和 18 个"可能已发出"的负例场景都通过，都没有重发。
- **只缺测试的地方，由 Claude 在基线补上**：删掉 `resumableFreshEdit` 的任一守卫（send_attempted、retry_blocked、message_parts、行状态，即 N02–N05），原来的自检发现不了。其中 N02、N05 会真的重发文字和图片。已在 `touch-message-sequence.self_check.cjs` 补上 4 个"可能已发出"的多段负例，要求 canRetry=false 且发送 0 次；补完后 N02–N05 都会被抓到。
- 合并版本 `check:self` 87 项、`build:test` 都通过。
- 遗留（不影响发送安全，T6b 顺手处理）：日志级别的几个边角情况没测到（N09、N10、N12、N18，只影响 passport 条数）；M15（发送前跳过的记录里带上旧的搜索规则号）。
