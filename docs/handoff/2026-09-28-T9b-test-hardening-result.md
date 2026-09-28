# T9b 后续测试补强结果

- 分支：`codex/t9b-test-hardening`，基线：`17f802a`。仅改 `desktop/src/main/wechat-workflow.self_check.cjs` 和本结果文档；生产代码未改。
- 增加离线工作流夹具，覆盖四审文档“后续测试补强”的五项：恢复接待后继续定时轮询；重试暂停期间确认未知结果为已发送、取消或删除任务；删除所有接待联系人或回复步骤报错；退出期间重试失败；切换到有 pending 任务的账号，以及只有其他账号有 pending 任务时仍恢复接待。失败后保持暂停的场景均断言未调用 `reply.resumeWorkflow`，账号切换后断言有限触达发送 0 次。等待门闩在 `finally` 中释放。

## 审查脚本

`scratch/t9b-r4/r4-probe.cjs <工作区>` 运行通过：Q4、Q7、Q8、Q10、Q17 均保持 `false/paused`、`resumeCalls+0`、`touchSends=0`；Q3 只有其他账号有 pending 任务时恢复到 `true/listening`、发送 0 次；Q19 恢复后的 `replyStepsAfterFailure>0=true`、发送 0 次。完整 Q1–Q19 均无 `PROBE-ERROR`。

用 `scratch/t9b-r4/mutate-r4.cjs` 和 `r4-guard.json` 逐项变异当前工作区，以下 10 项全部被仓库自检抓到（均输出 `KILLED`，每项 `survived 0`）：

| 要求 | 被抓到的变异 |
| --- | --- |
| 自动轮询 | G18 |
| 计划修订代次 | G1、G8、G10 |
| 仅恢复真实接待 | G5、G6、G12 |
| 退出边界 | G13 |
| 账号切换与其他账号任务 | G0d、G16 |

审查脚本的硬编码旧工作区路径和精确标签筛选只在系统临时目录副本中适配；每项变异运行后均恢复源码，适配文件未提交。

## 完整自检实际输出

在 `desktop/` 运行 `npm.cmd run check:self`，退出码 **0**，末尾实际输出：

```text
> src/main/wechat-workflow.self_check.cjs
workflow scope stress: aliases_json=66671, scope_ms=23, contacts_reads=5
auto-reply v4 self-check passed
T8 multipart session reuse checks passed; PowerShell launches: 0
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

all source self-checks passed
```

这次只补离线测试，未运行真实微信或安装包验收。
