# L1 自检卫生结果

- 分支：`codex/selfcheck-hygiene`；基线：`2415f4d`。
- `runChecks` 同时检查退出码与本检查 stdout 的 `passed` 行；保留完整子进程 stdout，stderr 继续直出。退出 0 但无 `passed` 会报 `self-check exited 0 without a passed line: <check>`，并行分组使用同一个 `runChecks`。
- 运行器自检覆盖退出 0 无 `passed`、退出 0 有 `passed`、非零退出、子进程原文可见。95 项逐项核对后，为成功时无该行的运行器自检、渲染表面自检、组件更新自检、更新助手端到端夹具补了输出；没有改这些检查的断言。
- `wechat-workflow.self_check.cjs` 的所有 44 个 `mkdtempSync` 创建点统一登记，结束时在 `finally` 核对路径属于当前临时目录并递归清理。G14 用户在重试窗口 `start()` 不得重复恢复接待、G17 恢复后状态订阅收到 `listening` 更新，均补了断言。

## 验证

- 在主工作区（不在 `%TEMP%`）运行 `npm.cmd run check:self`，退出码 **0**。清单 95 项，日志中 95 个脚本入口均执行。第一次运行抓到 `update-helper.e2e.cjs` 退出 0 但未打印 `passed`，补行后完整重跑通过。实际输出末尾：

  ```text
  > src/main/wechat-workflow.self_check.cjs
  workflow scope stress: aliases_json=66671, scope_ms=22, contacts_reads=5
  auto-reply v4 self-check passed
  T8 multipart session reuse checks passed; PowerShell launches: 0
  Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.

  all source self-checks passed
  ```

- 同一工作区运行 `npm.cmd run build:test`，退出码 **0**。实际输出末尾：

  ```text
  ✓ 1643 modules transformed.
  ✓ built in 1.62s
  test renderer build completed
  ```

- 对 G14、G17 分别在进程内注入已知变异，工作流自检都以非零退出：G14 报 `failed retry must not resume an already started workflow again`（`3 !== 2`）；G17 报状态断言（`'paused'` 与 `'listening'` 不同）。变异钩子已删除，生产文件未改。
- 专用临时目录下单独跑工作流自检，成功退出后输出 `temp-proof order=0 retry=0 all=0 exit=0`。这次仅跳过嵌套的 `touch-message-sequence` 检查，因为它在专用 `%TEMP%` 下有独立夹具假设；完整 `check:self` 已在正常环境运行并覆盖该嵌套检查。系统 `%TEMP%` 的历史目录未清理，且并行的其他运行仍在增加总数，故用专用目录核对本次创建物。
- `git diff --check` 通过。未改 A 线 L2 文件，也未操作真实微信。
