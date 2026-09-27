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
