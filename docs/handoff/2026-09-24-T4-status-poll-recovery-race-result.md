# T4 实施结果

分支：`codex/fix-touch-status-recovery-race`（基于 `codex/fix-apimart-gateway-transport`）。

## 改动

- 新增只经 `loadTaskState` 的展示读取 `readWorkflowTask`，让跳过记录和结果不明提示的展示不触发崩溃恢复。
- 新任务完成持久化和绑定记录后，将任务 ID 登记到 `recoveredTaskIds`，避免同一实例后续重新加载时误判为中断任务。
- 在 `wechat-workflow.self_check.cjs` 使用真实 workflow 入口、持久化任务和受控的发送器，验证纯文字与文字加图片任务在发送中反复读取后仍保持 `running/sending`，最终均为 `sent_verified`；复制发送中状态到新实例，验证第一次执行仍保守恢复并暂停。

## `loadWorkflowTask` 调用核对

| 位置 | 用途 | 处理 |
|---|---|---|
| `runWorkflowStep`（约 193 行） | 执行并修改任务 | 保留恢复加载 |
| `canRetryWorkflowTask`（约 563 行） | 只读重试资格，但仅在需关注任务上调用 | 保留恢复加载；任务卡已明确该状态路径不轮询运行任务 |
| `describeUnknownWorkflowTask`（原约 569 行） | 只读展示 | 改用 `readWorkflowTask` |
| `resolveUnknownWorkflowTask`（约 593 行） | 写入人工处置 | 保留恢复加载 |
| `acknowledgeUnknownWorkflowResolution`（约 682 行） | 写入处置确认 | 保留恢复加载 |
| `updateWorkflowTask`（约 694 行） | 编辑任务并写入 | 保留恢复加载 |
| `describeSkippedWorkflowTask`（原约 747 行） | 只读展示，每次状态轮询可能调用 | 改用 `readWorkflowTask` |
| `retrySkippedWorkflowTask`（约 759 行） | 重新加入并写入 | 保留恢复加载 |

`hasStartedWorkflowTask` 只检查任务文件是否存在，原来就不调用 `loadWorkflowTask`，无需改动。

## 验证

在 `desktop/` 下执行：

| 命令 | 实际输出 |
|---|---|
| 修改生产代码前 `node src/main/wechat-workflow.self_check.cjs` | 失败：状态轮询后任务实际为 `paused`，预期 `running`。|
| 修改后 `node src/main/wechat-workflow.self_check.cjs` | `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.` |
| `npm.cmd run check:self` | 首次因受限环境中 `spawnSync git EPERM` 中断；在可运行 Git 子进程的环境重跑，通过，末行 `all source self-checks passed`。|
| `git diff --check` | 通过。|

## 未验证

- 未在真实微信和异机安装版本复验；第一位联系人不再停机和诊断包无 `task_context_mismatch`，仍需用户发布后的指定账号、联系人验收。
- 未做安装包构建或发布。

## 对任务卡的异议

- `hasStartedWorkflowTask` 在当前代码中仅检查文件存在，不经过恢复加载；无需改造。
- `canRetryWorkflowTask` 是只读资格判断，不是写入入口；它只用于需关注任务，因此按任务卡的路径分析保留恢复加载。
