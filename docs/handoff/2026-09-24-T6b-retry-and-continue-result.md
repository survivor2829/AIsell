# T6b 结果：重新加入并继续

分支：`codex/workflow-retry-and-continue`，从基线 `5f2b93f` 新建；未合并、推送或发布。

## 改动

- 控制器保留原 `canRetry` 和触达执行器的重试判定；程序运行时，只有没有当前或下一项可执行有限任务才先暂停并重新加入。批量操作在同一次序列化中处理当前账号下可重试任务与跳过联系人；同一项优先走跳过联系人路径，结果未知、异账号和已取消任务不动。返回任务、联系人和排除计数。
- IPC 的 `retry-task`、`retry-skipped` 支持 `andStart`，新增 `retry-all-and-start`。重新加入成功后统一调用现有 `start()`，保留同步预检、浮窗和主窗口行为；启动失败时保留已重新加入状态。preload 的一键路径只使用启动点击门，单条重试仍使用保存点击门。
- 任务行和状态行增加一键操作与计数；跳过名单的单条“重试”仍只重新加入。结果未知的三个处置按钮未改。
- 自检补了 IPC 真入口的监听、有限任务阻拦、批量安全筛选、令牌拒绝、同步时启动失败，以及 T6a 二审遗留的 N09/N10/N12/N18 日志级别和 M15 旧搜索规则号断言。

## 验证

- `node src/main/wechat-workflow.self_check.cjs`：退出码 0，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。
- `npm.cmd run build:test`：退出码 0，末行 `test renderer build completed`。
- `npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`。首次在受限进程中运行时，策略自检的 `spawnSync git` 被拒绝（EPERM）；获准重跑后通过。

## 未验证与卡片异议

- 未操作真实微信、联系人或安装包；实际点击门和浮窗仅通过源码核对与 IPC 假窗口验证，仍需按卡片在异机复验。未在旧基线运行新增断言，旧版失败性留待独立审查核对。
- `WechatWorkflow.tsx` 的返回值类型定义位于旧行号约 79，卡片只列了 91–92 的 API 类型。为让新批量计数在类型检查中可用，额外补了同文件的 `WorkflowResult` 字段；未改动其他业务块。
