# T5 实施结果：search-r008 有界恢复

分支：`codex/fix-r008-bounded-recovery`，基于 `codex/fix-apimart-gateway-transport` 的 `dd6a97a`（包含 T4 合并提交 `1eee65e`）。未合并、未推送、未发布。

## 2026-09-24 审查返工

已将本分支变基到最新基线 `82f248d`，并在同一分支追加审查修复。

- 熔断时在任务上留下标记；从暂停恢复时，仅对该熔断清空连续计数，重置当前联系人的身份重试次数和旧证据指纹。第 3 人若仍为 r008，会完整等待 2/8/20 秒后跳过并继续第 4 人，不会再次熔断。
- 仅 `search_result_identity_unverified` 按 `rule_id` 累计连续跳过。r015 等其他跳过既不增加也不清除计数。
- 重新加入的行删除旧证据指纹；重新加入后即使证据相同，首次仍等待 2 秒，任务级连续计数为空。
- r008 的 passport 失败附件仅在最终跳过或熔断时记一次。熔断沿用 `needs_attention` 的一条失败记录，并附带本次诊断；自动重试期间不生成附件。
- 两个新增自检结束后清理临时目录。新增断言先在旧代码上失败：前三次自动重试已产生 3 条失败记录（预期 0 条）。

返工验证：`node src/main/wechat-workflow.self_check.cjs` 通过，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`；新增覆盖文字/图文任务熔断恢复、r015 三人连续跳过、重新加入同一证据、每人一次失败记录。

返工后的第一次 `npm.cmd run check:self` 退出码 1：已通过策略门禁、active-touch、朋友圈与自动回复等检查，但在未改动的 `scripts/component-update-selftest.cjs:117` 停止，第三个用例实际状态 `error`、预期 `ready`。单独执行 `node scripts/component-update-selftest.cjs` 退出码 0，4/4 用例通过；随后复跑整套检查确认门禁（最终结果记录在下方）。

第二次 `npm.cmd run check:self` 退出码 0，末行 `all source self-checks passed`，包含 `WeChat failure policy review passed: every added literal reason is classified` 和本次 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。`git diff --check` 退出码 0（仅有 LF/CRLF 提示）。

审查意见第 5 条所述未加盐文本哈希由 T10b 处理；本次未改变 resolver 的判定与证据设计。`candidate_set_hash` 在本机状态和诊断中保存，比较指纹使用它；按原任务卡要求，最终失败记录仍包含这个哈希。若“仅用于本机比较”意指不得进入本地 passport，便与原卡“failure-evidence / passport 增加候选集合哈希”冲突，需在 T10b 统一调整。

## 二审返工（基线 9d77c2d）

- r008 的 `workflow_contact_send` 诊断改为 warn；真实 diagnostics 订阅 passport 的自检确认 2/8/20 秒重试不截图，最终跳过才截 1 次。
- 熔断写盘前直接清掉当前行的重试次数、旧指纹和任务连续数。测试在熔断后重新加入另一位联系人，回到原熔断联系人时仍先等待 2 秒。
- 重新加入测试在连续数为 2 时执行，确认清零后两位 r008 不会继承旧熔断计数；熔断后首次读取保留相同哈希。熔断码的 `attention(...)` 调用改为同一行，断言策略 `known=true`、`attentionScope=global`。
- 人工核对为“已发送”和会话已核验后的发送前跳过均清空连续身份失败计数。非身份跳过清除旧 `rule_id`，防止 run-bill 误计 r008。
- 图文任务的文字段已发送、图片段 r008 时，保留文字段 `sent_verified`，最终跳过行的原因、响应 `deliveryStatus` 和 run-bill 原因均标为“部分已发送”；后续重试不会重发文字。新完成的消息段会清除旧指纹。

**范围异议与未完成项**：二审第 6 条要求界面列表不显示通用“身份不唯一，已跳过”，但该文案写在 `desktop/src/renderer/WechatWorkflow.tsx`，不在 T5 任务卡的允许文件内。本分支已在 `skip_record.blockedReason` 写明“部分内容已发送”，并在 run-bill 标记，但列表的固定状态标签仍待任务卡扩充文件范围后修改。真实微信发送、异机空跑、发布包均未验证。

二审验证：`node src/main/wechat-workflow.self_check.cjs` 退出码 0，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`；`npm.cmd run check:self` 退出码 0，末行 `all source self-checks passed`，其中策略门禁输出 `WeChat failure policy review passed: every added literal reason is classified`；`git diff --check` 退出码 0（仅 LF/CRLF 提示）。

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
