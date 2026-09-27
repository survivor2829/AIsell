# T6a 发送前有界恢复实施结果

分支：`codex/touch-presend-bounded-recovery`，从收尾基线 `c8adade` 新建；未合并、未推送、未发布。

## 改动

- 按卡片顶部补充先修重启卡住：运行中、当前行尚未到 `sending` 的任务，重启后恢复为可继续的暂停状态并写明“上次任务未完成”；已有完成回执和 `outcome_unknown` 仍走原入口。展示路径使用纯读取 `readTaskState`，主文件读失败返回 `null`，不从备份恢复写盘。
- 明确 `send_attempted === false` 且不在排除名单的发送前失败，沿用 5 秒、15 秒恢复和第 3 次跳过。`message_input_failed` 变体及五个裸码加入策略；失前台变体仍走环境等待。暂停原因在环境计时前返回 pending，结果未知仍全局暂停且不自动重试。
- 图片点击前超时、环境等待耗尽和普通发送前跳过共用同因熔断出口。前两位跳过；第 3 位暂停并保留在当前行，重试次数与连续计数当场清零，保留已核验的消息段。成功发送、快照变化、人工处置与重新加入会清计数。新码 `touch_pre_send_failure_streak` 登记为全局阻断，并补界面文案。
- 有界恢复的诊断记为 warn；真实诊断订阅和 passport 接线验证：恢复期间 0 份失败附件，最终跳过 1 份。run-bill 的发送前跳过不写搜索规则号。

## 验证命令与实际输出

- 故障注入先在旧实现上运行 `node src/main/touch-message-sequence.self_check.cjs`：重启前尚未写 `sending` 的任务在 `canRetryWorkflowTask` 处得到 `false`，预期 `true`；补上发送前恢复用例后，旧分流首次返回 `needs_attention`，预期 `pending`。两处均在改实现前复现。
- 改后同命令退出码 0，输出 `Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.`。覆盖逐码 12 个恢复原因、27 个排除原因、单段和文字加图片熔断、X/Y/X 与成功后计数重置、重新加入、环境超时、图片点击前超时、暂停和结果未知；第三位已发文字继续时不重发。
- `node rpa/active_touch/self_check.cjs` 退出码 0，末行 `active-touch self-check passed`。`node src/main/wechat-workflow.self_check.cjs` 退出码 0，输出 `Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.`。`node scripts/wechat-failure-policy-review.self_check.cjs` 退出码 0，输出 `WeChat failure policy review gate self-check passed`。
- `npm.cmd run check:self` 最终退出码 0，末行 `all source self-checks passed`；策略门禁输出 `WeChat failure policy review passed: every added literal reason is classified`。首次全量运行曾因恢复条件误包含已有 `outcome_unknown` 而失败，收窄后定向及最终全量均通过。
- `npm.cmd run build:test` 退出码 0，末行 `test renderer build completed`。`git diff --check` 退出码 0。
- 卡片另要求的 `node src/main/failure-evidence.self_check.cjs` 退出码 1：`AssertionError: missing source image-r015`。基线 `c8adade` 的规则目录已有 `image-r015` 指向 `touch-workflow.cjs`，该源码在基线只有 `image_send_pre_click_timeout` 字面量，没有 `"image-r015"` 字面量；本次未修改目录，也未为通过检查增加无用途字面量。

## 未验证与异议

- 未操作真实微信、测试联系人、安装包或异机；真实故障注入、发布与业务指标需用户授权后验收。
- 第 5 步新增的共享策略，也会影响独立触达页的分类及有界恢复／环境等待；本轮只按任务卡修改工作流，不改该页 IPC。
- 顶部补充允许修改 `touch_task_state.cjs`，正文“禁止”仍写不得改；按顶部优先级实施。正文要求复用 T5 连续计数，但 T5 既有断言要求非身份跳过后 `identity_skip_streak` 为空；因此保留身份计数字段，用同样的熔断出口和带 `pre_send:` 前缀的 `pre_send_skip_streak` 记录发送前同因计数，避免改动卡片未允许的 T5 自检文件。
- `failure-evidence.self_check.cjs` 的 `image-r015` 源码字面量缺口在基线已存在，且规则目录不在本卡允许改动范围；请由审查方决定是否另卡处理。

## 一审返工（同一分支追加，未变基）

- 将“全新、未发送且尚无 `message_parts` 的多段行可继续”抽为 `resumableFreshEdit`，恢复入口与 `canRetryWorkflowTask` 共用。用 `contacts.json` 写入故障注入复现：旧实现重启后 `canRetry=false`；修后为 `true`，继续后文字、图片各执行 1 次。
- 发送诊断以持久化后的当前行状态和实际失败分流决定级别。单段 `prepared → send_attempted:false` 与网络误点提醒记 error；确认未发送的有界恢复、图片点击前超时和环境等待／耗尽记 warn，避免诊断订阅与显式 `recordFailure` 为最终跳过重复生成 passport 失败记录。
- 自检增加多段 0a、日志级别、真实 passport 接线、部分已发熔断、文案、暂停、身份与发送前计数互清、快照变化、人工处理及新实例上的 7b 回归。真实接线的图片点击前超时和环境耗尽各 1 份失败附件；连续三人同因失败共 3 份（前两人各一次最终跳过，第三人一次熔断）。

验证命令与实际输出：

- `DESK=<本分支>/desktop node probe.cjs`：退出码 0，末行 `done failed=0`；其中 `interruptedMultipart` 为 `canRetry=true`、后续 `calls=2`，`warnLevelScope` 中 prepared 与误点提醒为 `failed:error`，`passportRealWiring` 中图片点击前超时 `shots=1`、环境耗尽 `shots=1`、三人熔断 `shots=3`。
- `DESK=<本分支>/desktop node probe-restart.cjs`：退出码 0；普通重启后单段调用 `c0:txt,c1:txt`，多段调用 `c0:txt,c0:img,c1:txt,c1:img`，无重复。
- `WT=<本分支> node mutate.cjs mutations.json M08 M09 M18 M24 M27 M28 M32 M33`：退出码 0，八项均 `KILLED`，且每项都由项目的 `touch-message-sequence.self_check.cjs` 断言失败；脚本末尾 Git 状态只有本轮两个改动文件。第一次在受限环境运行时子进程 `spawnSync` 返回 EPERM、退出码 1，没有形成有效变异结论；随后在获准的进程环境重跑得到上述结果。
- 同目录 `mutations-probe.json` 的七项探针变异中，M08、M09、M28、M32 为 `KILLED`；M18、M27、M33 在只执行审查 `probe.cjs` 的组合中仍为 `SURVIVED`。这三项已由上面的项目自检组合抓到；没有修改审查探针来制造通过结果。
- `node src/main/touch-message-sequence.self_check.cjs`：退出码 0，输出 `Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.`。`npm.cmd run check:self`：退出码 0，末行 `all source self-checks passed`。`npm.cmd run build:test`：退出码 0，末行 `test renderer build completed`。

未验证：仍未操作真实微信、真实联系人或安装包；没有合并、推送或发布。对任务卡新增异议：无；`mutations-probe.json` 的三项存活仅反映该探针未覆盖相应断言，项目自检已经覆盖。
