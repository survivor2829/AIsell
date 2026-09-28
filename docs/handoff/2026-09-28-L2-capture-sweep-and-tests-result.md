# L2 结果：搜索截图清扫节流与测试补强

分支：`codex/capture-sweep-hardening`；起点：`2415f4d`。未合并、未发布。

## 改动

- `touch-workflow.cjs` 以进程级时间戳限制过期截图清扫：首个有效步骤清扫一次，此后至少间隔 60 分钟；使用工作流已有的 `now` 时钟，便于注入验证。清扫函数和规则未改。
- 截图链路自检改用独立沙箱 TEMP，断言每个场景无残留；不再比较或清理真实 TEMP 中其他进程的截图。增加精确文件名、年龄、顶层目录、符号链接，以及微信号回退到姓名后 `block()` 写日志异常的用例。
- 观察自检补 `Abc`/`abc` 的生产 PowerShell 标题比较回放；检查 chain 子进程的完成行。两层异步自检都在进程退出前检查完成标记，避免悬空 Promise 以 0 退出。
- 新增进程内清扫节流自检；`run-self-checks.cjs` 仅在 checks 清单新增一行。

## 验证命令与实际输出

源码自检及构建均在 `%TEMP%` 外的 `.worktrees/a-line/desktop` 执行。审查脚本位于 `C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\`，执行时设置 `RV_TREE=..\..\..\..\Desktop\xiaoxi-active-touch\.worktrees\a-line` 或 `WT=C:\Users\Scott\Desktop\xiaoxi-active-touch\.worktrees\a-line`。

| 命令 | 实际输出摘要 |
| --- | --- |
| `node src/main/touch-capture-sweep.self_check.cjs` | `touch capture sweep interval passed: first step, within-hour reuse, after-hour sweep` |
| `node rpa/active_touch/wechat_search_observation.self_check.cjs` | `search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)`；`search title send gate passed: longer title sends=0, exact title sends=1`；`search capture chain passed: CLI flag, passport bytes, pause, fallback/save/log exceptions and sandboxed stale cleanup` |
| `node scratch/t10b-r3/sweep_probe.cjs` | `sweepThrew:null`、`missingDirThrew:null`、`fileSymlink:"created"`、`hardlinkTargetIntact:true`、`failures:0` |
| `node scratch/t10b-r3/orphan_paths_r3.cjs` | `psLaunches:0`；全部 16 个场景 `orphans:0`，包括回退后写日志异常、存状态异常和暂停 |
| `node scratch/final-integ2/run2/t10a-safety/attacks.cjs` | 20 个 G1–G7 攻击场景均输出 `no click` |
| `node scratch/final-integ2/run2/t10a-r3-safety/fuzz_diff.cjs` | 四组各 `total:60000`、`tOnlySel:0`、`diffPoint:0` |
| 变异脚本 `mutate.cjs` | `X06 KILLED`、`X07 KILLED`、`X08 KILLED`、`X09 KILLED`、`X10 KILLED`、`X12 KILLED`、`X22 KILLED`、`X23 KILLED`、`R16 KILLED`；脚本均报告还原后的工作树状态 |
| `npm.cmd run build:test` | `✓ 1643 modules transformed.`、`✓ built in 1.39s`、`test renderer build completed`；退出码 0 |

`npm.cmd run check:self` 实际输出中的本次相关行及最终结果（退出码 0）：

```text
> rpa/active_touch/wechat_search_observation.self_check.cjs
search observation PowerShell replay passed (spaced OCR; noisy sections ignored; no real input)
search title send gate passed: longer title sends=0, exact title sends=1
search capture chain passed: CLI flag, passport bytes, pause, fallback/save/log exceptions and sandboxed stale cleanup
> rpa/active_touch/self_check.cjs
active-touch self-check passed
> src/main/touch-capture-sweep.self_check.cjs
touch capture sweep interval passed: first step, within-hour reuse, after-hour sweep
touch-task-ipc self-check passed
Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.
all source self-checks passed
```

## 未验证与任务卡差异

- 未运行真实微信、安装包或异版本兼容验收；以上是离线/源码检查与 renderer 测试构建。
- 卡片写“满 24 小时删除”，现有函数条件为 `now - mtimeMs > 24h`，恰好等于 24 小时会保留。本卡同时禁止改清扫规则，因此自检使用 24 小时加 60 秒验证删除、23 小时 59 分验证保留，未改动这个边界。
