# T9b 审查结论

审查对象：`codex/diagnostics-control-events`。一审（5c98df7）的结论已写进卡片顶部的第 5–9 条。

## 二审（cf7a0b2）：再修一轮（同一分支追加）

**已做对**：
- 变基无冲突。retryAll 和 andStart 的日志只带计数，用的是 `code:` 字段。
- pauseForRetry 改成先检查资格：T6b 探针 P09、P10 在接待中重试失败后，接待仍在继续；P01–P15 共 15/15 通过。
- T1 测试、zip 重打（与源文件逐字节一致，使用共享读）、一审存活的变异，都已处理好。
- 注入各种会抛异常的 logger 时，代码行为和不注入时完全一样（审查脚本 failopen2.cjs 实测）。
- 发送链路没有行为变化。合并版本 `check:self` 97 项、`build:test` 都通过。

**必须修**
1. **【测试会假通过】** `wechat-workflow.self_check.cjs:1050-1068`（T16 用例）里，`releaseReply()` 没放在 finally 里。一旦 :1064 的断言失败，`test.close()` → `dispose()` 就会一直等 `inFlight`；事件循环排空后，进程以 0 退出，也不打印 passed，而 `run-self-checks.cjs` 只看退出码，于是显示通过。
   - 实测：去掉 retryAll 的 `assertPlanEditable`，自检退出码 0，stdout 为空。`:1022-1038` 的 `releaseRecipients` 也是同样的写法。
   - 修法：release 一律放进 finally。另外，这个自检开头先设 `process.exitCode = 1`，最后一行打印 passed 时再设为 0。
   - 验证：用审查脚本 `t16run.cjs` 去掉 `assertPlanEditable`，自检必须以非 0 退出。
2. **【测试缺失】卡片第 7 条要求的"注入会抛异常的 logger"用例没有提交到仓库**，结果文档里引用的是审查用的临时脚本。请把 `scratch\t9b-r2\failopen2.cjs` 的核心场景写进自检：
   - logger 分为全部抛出、操作句柄抛出、读属性就抛出三种；
   - 覆盖 pause、retryTask、retryAll、dispose（之后 enabled 必须是 false），以及 IPC 关窗后回到主窗。
   - 要求：去掉 `wechat-workflow.cjs:97-109`、`wechat-workflow-ipc.cjs:63-66`、`main.cjs:271`/`:853` 的 try，或者把 dispose 改回"先记日志、后改 enabled"（审查变异 N1–N7、N20），测试都要失败。
3. **【代码，小】重试失败后接待仍然停住的剩余路径**：
   - (a) `retryAll`（:858）的前置检查通过了，但执行器的 `retrySkippedWorkflowTask` 返回 `ok:false`，最后 `taskCount=0` 在 :879 报错；
   - (b) `retrySkipped`（:816）仍然先暂停、后检查资格。这个问题基线上就有。
   - 修法：采用卡片给的另一种做法，"失败时恢复接待"，统一处理这两处，并各补一个用例。两种情况都只是停住，不会重发。
4. 小：N17（retryAll 在"空结果"报错前就记日志）补一条断言。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t9b-r2\`（`failopen2.cjs`、`t16run.cjs`、`resid.cjs`、`mutate-r2.cjs`）和 `scratch\t6b\probe.cjs`。
- N1–N7、N20、T16、N17 都必须被自检抓到；
- T6b 探针保持 15/15；
- `check:self`、`build:test` 都通过。

## 三审（a6d8df7）：打回 1 处安全回归（同一分支追加）

**已做对**：二审 4 条都完成了。
- T16 不再假通过：去掉 `assertPlanEditable` 后，自检以 1 退出。
- 抛异常的 logger 测试已写进自检：N1–N7、N20 都会被抓到；main.cjs 的处理函数在 vm 里真实跑过。
- 两条"失败后恢复接待"的路径都有测试。
- N17 已补断言。
- T6b 探针 15/15；与 a6f5caa 合并后 `check:self` 97 项、`build:test` 都通过。

**必须修**
1. **【安全回归】重试失败后恢复接待时，会把用户没启动的有限触达任务发出去。**
   - 位置：`wechat-workflow.cjs:793-798` 的 `resumeAfterFailedRetry`，在 :840 和 :898 的 catch 里调用。
   - 问题：任何失败都会恢复，包括任务已经在内存里重新入队之后才发生的失败。恢复后 `settleQueue()` 切到 working，`schedule(0)` 就开始发送。cf7a0b2 在同样的场景下发送 0 次。
   - 审查探针 `resume-probe.cjs` 复现了三种情况：
     - P7：接待中执行 `retryAll(false)`，`requeueTask` 之后 `persist()` 抛出 ENOSPC。调用返回失败，但状态变成 true/working，下一次 tick 发出 1 条触达。
     - P8：同样的情况经由 `retrySkipped` 触发，发出 1 条。
     - P9：重试暂停期间，`resolveTouchUnknown(not_sent)` 落地（它会有意把 enabled 设为 false）；随后重试失败并恢复，这个已处理的任务被发出，用户并没有点开始。
   - 修法：只允许恢复到"接待中"。如果当前账号有待执行的任务（`nextTask()`），或者重试期间队列变过，就不恢复，保持暂停。恢复前先确认 phase 仍是 listening。`reply.resumeWorkflow` 也只在真正恢复接待时才调用；目前 P6 里接待已经关掉了，却仍然记了一条 `workflow_resume_requested`。
   - 用例：把 P7、P8、P9 写进自检，断言返回失败、保持暂停、发送 0 次。
2. **测试缺口**：RS3（忽略 generation 检查）、RS4（已暂停时 `pauseForRetry` 仍返回 generation）目前只有探针能抓到，请写进自检，覆盖"重试前用户已暂停，失败后不恢复"。

**自测**：审查脚本在 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t9b-r3\`（`resume-probe.cjs`、`mutprobe.cjs`、`mutate-r3.cjs` + `extra.json`）。
- P1–P9 都要符合预期，P7–P9 发送 0 次；
- RS3、RS4 必须被自检抓到；
- T6b 探针保持 15/15；
- `check:self`、`build:test` 都通过。
