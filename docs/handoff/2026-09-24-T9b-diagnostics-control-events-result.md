# T9b 结果：控制事件与诊断补强

- 分支：`codex/diagnostics-control-events`；已变基到收尾基线 `b6755a9`（包含 T6b `cc05e75`）。仅解决 `wechat-workflow.cjs` 的重试函数冲突，保留 T6b 的控制行为与 T9b 的暂停日志。
- 工作流暂停、启动、任务重试、批量重试和退出写 trace；主窗关闭、退出请求、悬浮窗关闭也有 trace。`retryTask` 记录实际 `andStart === true`，`retryAll` 成功后仅记录任务数、联系人数、排除数和 `and_start_requested`，分类放在 `code`。日志失败不会改变控制操作结果。
- 修复接待中无资格重试却先暂停的问题：`retryTask` 与 `retryAll` 先做资格检查，通过后才暂停。T6b 的账号、未知发送结果、布尔启动、点击凭证、跳过联系人选择、串行化、暂停中编辑、持久化等测试缺口已补。
- `needs_attention` 后启动和退出前阶段均有断言。`main.cjs` 的静态检查覆盖 `status?.()`，退出重入保护在日志前。诊断摘要无效字段、轮转边界及默认 19 个归档均有断言。
- 微信版本由已选中的微信进程文件提供，经共享白名单进入发送诊断。诊断包摘要增加 `app`、`wechat`、`display`、`feedback_latest`、`log_coverage`；分析器增加版本变化、人工操作和暂停到恢复统计。采集器共享读取日志，错误清理残缺 ZIP 且不输出绝对路径。
- `tools/AI-Customer-Diagnostics-Tool.zip` 已重打，内含的 CMD、PS1 与 `tools/remote-diagnostics/` 源文件逐字节一致。ZIP SHA-256：`c729f4b64f38e0f6ed7c00a0aff46f45ef2590976ec4f736d54cee17724b67ec`。

## 审查脚本实测

- T6b `probe.cjs`：P01–P15 全部 `PASS`，`done failed=0`。T6b `mutate3.cjs mutations.json T02 T07 T08 T13 T14 T16 T17`：T07、T13、T16、T17 原脚本判为 `KILLED`；T02、T08、T14 的旧匹配文本已不在变基后的函数中，按当前代码形态临时适配同一变异后，三项均为 `KILLED`。T16 由 T6b 探针捕获。
- T9b `failopen.cjs`：`none`、`allThrow`、`opThrow`、`realWriterThrows` 四种 logger 下，启动、重试、暂停、退出结果一致。
- T9b `privacy.cjs`：`leaks in new events: 0 []`；`private in new summary fields: false`；`private anywhere in summary.json: none`。
- T9b `retention.cjs`：`outside intact: true`，`non-owned files kept: true`，`default MAX_ARCHIVES: 19`。
- T9b `ps-cases.cjs`：并发追加、共享持有日志采集 `exit=0`；原日志或轮转日志被独占锁定时 `exit=1`、`entries=[]`、`absPathInOutput=false`。
- T9b `t1probe.cjs`：原版 `{"search-r008":{"max":2,"bins":[1,1,0,0]}}`，去掉成功断串的变异版为 `{"search-r008":{"max":3,"bins":[0,1,0,0]}}`。
- T9b `mutate.cjs` 对当前工作区运行：34 项 `KILLED`，2 项 `SURVIVED`，8 项 `PATTERN NOT FOUND`。本轮要求的 T1、P4、P6、P10、P11、P12、R1、W5 均被捕获。存活的 D3 删除文件存在性检查后仍被 `GetVersionInfo` 异常处理返回空串；W8 将日志的先存 `previousReason` 改为 `task.reasonCode`，由于 `requeueTask` 保留 `reasonCode`，两者当前等价。未匹配项包括部分暂停、退出与主窗日志片段，原因是本轮增加了 fail-open 包装或 T6b 改了调用参数；对应行为已由定向自检、源码断言及探针覆盖。

审查脚本中硬编码的旧临时工作区路径仅在临时副本中改为本分支路径；PowerShell 采集探针仍在审查脚本自己的 `scratch/t9b/ps-中文 目录` 中运行。临时适配未进入提交。

## 完整检查实际输出

`desktop/` 下运行 `npm.cmd run check:self`，退出码 0，末尾输出：

```text
> scripts/analyze-diagnostics.self_check.cjs
diagnostics analyzer self-check passed

Running isolated active-touch, moments and auto-reply self-check groups in parallel.

> src/main/wechat-workflow.self_check.cjs
workflow scope stress: aliases_json=66671, scope_ms=24, contacts_reads=5
auto-reply v4 self-check passed
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

all source self-checks passed
```

`desktop/` 下运行 `npm.cmd run build:test`，退出码 0，末尾输出：

```text
✓ 1643 modules transformed.
✓ built in 1.69s
test renderer build completed
```

`git diff --check` 对本卡文本源码逐项检查通过。构建有 Vite CJS API 弃用和大于 500 kB 的 chunk 提示。未做真实微信、异机安装包或正式发布验收。

## 2026-09-27 二审修订

- `wechat-workflow.self_check.cjs` 在开头设置 `process.exitCode = 1`，只有输出最终通过消息才清零。T16 的 `releaseReply` 和串行化用例的 `releaseRecipients` 均在 `finally` 兜底释放，失败时不会因悬空 Promise 假装通过。
- 仓库自检新增抛错 logger 的控制结果对照：`event`/`begin` 都抛、操作句柄 `end`/`fail` 抛、读取属性就抛，覆盖 `retryTask`、`retryAll`、暂停成功和失败、`dispose` 后 `enabled=false`，以及悬浮窗关闭后回到主窗。`diagnostics.self_check.cjs` 还执行主窗关闭和退出处理函数，验证诊断抛错不跳过后续清理。
- `retryAll` 的候选执行器全失败，以及 `retrySkipped` 重试失败时，若此前正在接待且期间没有新的用户暂停，则恢复接待；用户主动暂停不会被恢复动作覆盖。失败的批量重试不记录成功事件。`retryTask` 成功后的落盘也有断言。

### 二审审查脚本实际结果

| 脚本 | 实际结果 |
| --- | --- |
| `scratch/t9b-r2/failopen2.cjs <工作区>` | `none`、`allThrow`、`opThrow`、`getterThrow`、`realWriterThrows` 均为 `SAME-AS-NONE`；悬浮窗 `closeShowMain` 均为 `true/1` |
| `scratch/t9b-r2/resid.cjs <工作区>` | R1 批量重试失败后 `true/listening`；R2 跳过联系人重试失败后 `true/listening`；R3 无效任务 ID 后 `true/listening` |
| `scratch/t9b-r2/t16run.cjs` | 按当前 `retryAll` 包装写法适配临时变异：内部自检 `exit 1 signal null`，报 `Missing expected rejection`；脚本本身退出 0，表示测试缺口已抓到 |
| `scratch/t9b-r2/mutate-r2.cjs N` | N1–N7、N17、N20 均 `KILLED`；首轮 20 项 `KILLED`、N19 `SURVIVED`。补充 `retryTask` 落盘断言后单独重测 N19 为 `KILLED` |
| `scratch/t6b/probe.cjs` | P01–P15 全部 `PASS`，末行 `done failed=0` |

审查变异脚本中写死的旧工作区路径，以及 T16 的旧 `return serialize` 匹配文本，只在系统临时目录的脚本副本中适配；仓库源码在每项变异后恢复。未在真实微信上运行。

### 二审完整检查实际输出

`desktop/` 下 `npm.cmd run check:self`：退出码 0，末尾输出：

```text
> src/main/wechat-workflow.self_check.cjs
workflow scope stress: aliases_json=66671, scope_ms=23, contacts_reads=5
auto-reply v4 self-check passed
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

all source self-checks passed
```

`desktop/` 下 `npm.cmd run build:test`：退出码 0，末尾输出：

```text
✓ 1643 modules transformed.
✓ built in 1.47s
test renderer build completed
```

构建仍提示 Vite CJS API 弃用及一个 chunk 大于 500 kB；本轮未改发布包，也未进行真实微信或异机验收。

## 2026-09-27 三审安全修订

- 失败恢复接待只在原本由这次重试暂停、计划未变、当前账号没有待执行有限任务时尝试；重新计算阶段后，只有 `listening` 才调用 `reply.resumeWorkflow()` 并继续调度。`persist()` 在写盘前递增计划修订代次，因此 ENOSPC 前已经发生的内存任务变更也会阻止自动恢复。
- 仓库自检补 P7–P9：批量重试和跳过联系人重试在入队后落盘失败、重试等待期间手动确认未知结果；三种情况都断言调用失败、保持暂停、有限触达发送 0 次。另补用户在重试前已暂停和重试期间点击暂停的用例，确保失败恢复不覆盖用户操作。

### 三审审查脚本实际结果

- `scratch/t9b-r3/resume-probe.cjs <工作区>`：P1 失败后仅恢复接待、发送 0 次；P2–P3 用户预先暂停后仍 `false/paused`；P4 用户中途暂停后仍 `false/paused`；P5 退出中仍暂停；P6 接待被关闭后仍 `false/paused`，`resumeCalls+0`。P7 `retryAll(false)` 落盘 ENOSPC 后 `false/paused`、`touchSends after tick=0`；P8 `retrySkipped` 落盘 ENOSPC 后 `false/paused`、`touchSends after tick=0`；P9 确认未知结果后 `false/paused`、`touchSends after tick=0`。
- `scratch/t9b-r3/mutate-r3.cjs`：RS3（忽略暂停代次）`KILLED`，报 `a later user pause must take priority over retry recovery`；RS4（预先暂停仍给恢复凭据）`KILLED`，报 `a retry started after user pause must stay paused`。`mutprobe.cjs` 的对应变异分别复现 P4 错误恢复为 `true/listening resumeCalls+1`、P2/P3 错误恢复为 `true/listening resumeCalls+1`。原脚本的旧工作区路径及 RS3/RS4 旧函数签名只在系统临时目录的脚本副本中适配；R5/R6 旧文本在当前代码中未匹配，非本轮指定变异。
- `scratch/t6b/probe.cjs`：P01–P15 全部 `PASS`，末行 `done failed=0`。

`desktop/` 下 `npm.cmd run check:self`：退出码 0，末尾实际输出：

```text
> src/main/wechat-workflow.self_check.cjs
workflow scope stress: aliases_json=66671, scope_ms=23, contacts_reads=5
auto-reply v4 self-check passed
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

all source self-checks passed
```

`desktop/` 下 `npm.cmd run build:test`：退出码 0，末尾实际输出：

```text
✓ 1643 modules transformed.
✓ built in 1.49s
test renderer build completed
```

构建仍有 Vite CJS API 弃用和超过 500 kB 的 chunk 提示；未做真实微信发送或异机安装包验收。
