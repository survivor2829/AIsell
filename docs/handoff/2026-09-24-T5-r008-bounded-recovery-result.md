# T5 实施结果：search-r008 有界恢复

分支：`codex/fix-r008-bounded-recovery`，基于 `codex/fix-apimart-gateway-transport` 的 `dd6a97a`（包含 T4 合并提交 `1eee65e`）。未合并、未推送、未发布。

## 改动

- 第 0 步：最外层异常捕获无条件清理 `recoveredTaskIds`。新增 clicked 后 `attention()` 写盘首次抛 ENOSPC 的故障注入回归。旧代码下首次 `needs_attention` 快照的 `unknownResolution.required` 为 `undefined`；修复后为 `true`，发送次数仍为 1。
- 删除 r008 首次出现即全局停机的专门分支。身份失败沿现有 2/8/20 秒有界恢复，次数用尽后跳过；相同 `rule_id` 与候选集合哈希连续出现时提前跳过。身份不明仍不点击、不发送。
- 在任务状态中记录连续按同一规则跳过的联系人。第 3 位保持当前联系人、`generated`、`send_attempted=false`、`retry_blocked=false`，以 `wechat_search_identity_circuit_open` 全局暂停；发送核验成功或重新加入跳过联系人时清零。已在失败策略与规则目录登记。
- resolver 仅对 r008 拒绝结果补充按微信号或名字搜索、OCR 框数量与坐标、每框文字 SHA-256、裁剪框、网络搜索分界位置和候选集合 SHA-256。触达流程把这些诊断写入 `search_evidence`，并交给 passport 失败记录；run-bill 读取失败行的 `rule_id`。新增测试确认诊断不含可读联系人文字。

## 验证

- `node src/main/wechat-workflow.self_check.cjs`：通过，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。覆盖第 0 步、文字与图文任务的三次延迟重试、相同证据提前跳过、第三人熔断与恢复、成功清零、重新加入、run-bill `rule_counts`。
- `node rpa/active_touch/self_check.cjs`：通过，输出 `active-touch self-check passed`；r008 仍是 `unverified`，证据字段与隐私断言通过。
- `git diff --check`：通过（仅有 Git 的 LF/CRLF 提示）。
- `npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`，其中 `WeChat failure policy review passed: every added literal reason is classified`。普通沙箱内直接运行策略门禁曾因 `spawnSync git EPERM` 失败；在获准执行环境中完整通过。

## 未验证

- 未连接真实微信或异机运行；百人全局停机次数、跳过率、补跑成功率和 r008 实际成因待用户发布后验收。
- 未做发布包、安装包或真实发送验收。

## 对任务卡的异议

- 无范围冲突。卡片要求的 r008 失败证据可通过 resolver 输出中的 `diagnostics` 到 `state_machine` 结果，再由本卡允许修改的触达流程写入 passport；无需扩改 `wechat_window_driver.cjs` 或 `state_machine.cjs`。
