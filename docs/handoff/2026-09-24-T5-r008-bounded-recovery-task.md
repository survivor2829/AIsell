# T5【P0】search-r008：从"第一次就全局停"改回有界恢复，加熔断和证据

分支：`codex/fix-r008-bounded-recovery`，从已合并 T4 的 `codex/fix-apimart-gateway-transport` 拉出（2026-09-24 已合并，合并提交 `1eee65e`）。

## 第 0 步：T4 二审遗留的一行修复（先做）

- **问题**：`touch-workflow.cjs` 最外层 catch 里的 `recoveredTaskIds.delete(id)` 只在内存行处于 `INTERRUPTED_SEND_STATES` 时才执行。但在"发送已 clicked、随后 `attention()` 或成功分支的 `persist()` 抛出 ENOSPC/EPERM"这类场景里，persist 之前内存行已经被改成 `outcome_unknown` 或 `sent_verified`，条件不成立，id 仍留在集合里。结果是：磁盘停在 running+clicked，store 是 needs_attention，本进程内既没有重试按钮也没有人工核对面板，只能重启。
- **修法**：改为无条件执行 `recoveredTaskIds.delete(id)`。这样做是安全的，理由有三：
  - 能走到最外层 catch，说明本次 step 已经结束（execute 已 await 完毕）；
  - `activeStep` 互斥，保证同一时间只有一个 step；
  - `loadWorkflowTask` 只会恢复磁盘上处于 running 且当前行为 INTERRUPTED 状态的任务，这与"崩溃后重启"完全等价。
- **验收**：新增一个故障注入用例。发送结果为 clicked 之后，让 `attention()` 的 persist 第一次抛 ENOSPC。断言：本进程内第一个 needs_attention 快照中 `unknownResolution.required === true`，且发送次数不增加。删掉这行修复后，用例必须失败。

## 背景

- `search-r008` 表示 OCR 读到了搜索区域的文字，但没有确认"网络查找/搜索网络结果"分界，所以**不点击任何联系人**。它属于明确未发送（`send_attempted=false`）。规则目录把它归为 `recoverable`（`desktop/src/shared/wechat-rule-catalog.json` 中 search-r008 条目，条件为 `web_boundary_missing`）。
- `bf985a2` 在 `touch-workflow.cjs:420-429` 为 r008 加了专门分支：第一次出现就 `attention(..., "wechat_search_panel_unavailable")`。这个码在 `wechat-failure-policy.cjs:15` 是 `blocker/global`，所以整个工作流（触达、朋友圈、自动回复）一起停。这个分支还**不增加** `identity_recovery_attempts`，也没有跳过出口，一直失败的联系人会把任务卡死。
- 异机 9-23 数据（1.1.53，尚未包含 bf985a2）：身份失败 602 次，其中 r008 492 次、r014 110 次。r008 往往连续出现，每人最多失败 4 次，最长连续 28 次。按新分支回放，9.65 小时至少全局停 128 次。
- 用户已决定：r008 自动重试后跳过、继续下一个人。

## 要做

1. **删除 `touch-workflow.cjs:420-429` 的 r008 专门分支**，让 r008 走现有的身份有界恢复（:430-445，间隔 2/8/20 秒），次数用完后走跳过（:446-468），也就是写入 `identity_skipped` 和 `recordSkippedResult`，之后可以通过"重新加入"补跑。
2. **证据未变就提前跳过**：每次身份失败时，记录证据指纹，即 `rule_id` 加上候选集合的哈希（由 resolver 输出，见第 4 步）。本次指纹与上一次相同，就直接跳过，不再等 8 或 20 秒。这是更保守的做法，因为跳过意味着不发送。
3. **熔断**：在任务上记录"连续因同一 rule_id 跳过的联系人数"。前 2 位照常跳过；**第 3 位不跳过**，保持为当前联系人（`status="generated"`、`send_attempted=false`、`retry_blocked=false`），然后返回 `attention` 并全局暂停。这样用户恢复后会从这位联系人继续，任务级"重新加入"依然可用。如果第 3 位也被跳过，多段任务的新当前联系人还没有消息段，`canRetryWorkflowTask` 会返回 false，任务就无法恢复（T6a 的起草者发现了这个问题）。暂停提示改成"连续多位联系人的搜索结果无法确认身份，请检查微信搜索窗口"，不再写"面板未出现"。中间任何一人成功，计数清零。熔断的原因码请复用或新增一个已登记的码，并在 `wechat-failure-policy.cjs` 与规则目录中登记，CI 的 `wechat-failure-policy-review` 必须通过。
4. **补充 r008 证据**（用于查 r008 本身的根因），在 `desktop/rpa/active_touch/wechat_search_result_resolver.cjs` 的输出与 failure-evidence / passport 中增加以下字段，都不含可读的联系人文字，只存哈希：
   - 搜索方式：按微信号还是按名字（对应 resolver 的哪个分支）；
   - OCR 文字框数量与坐标；
   - 每个框文本的哈希；
   - 裁剪区域；
   - `webSearchTop` 或分界检测的中间结果；
   - 候选集合哈希（供第 2 步使用）。
5. run-bill 的 `rule_counts` 目前为空，因为读的是 `current.search_evidence?.rule_id`（:152,171），而 r008 没写这个字段。让身份失败把 `rule_id` 写进 `search_evidence`。

## 允许改动

- `desktop/src/main/touch-workflow.cjs`
- `desktop/rpa/active_touch/wechat_search_result_resolver.cjs`（只做证据输出，**不改判定逻辑**）
- `desktop/src/shared/wechat-failure-policy.cjs`、`wechat-rule-catalog.json`（仅登记熔断码）
- 对应的 self_check

## 禁止

- 不放宽身份判定。r008 的判定条件和"身份不明不点击"的边界保持不变。
- 不改 `outcome_unknown` 处理，不自动补发。
- 不改 T4 已修改的加载逻辑。

## 验收（新增断言在当前 HEAD 上必须失败）

1. r008 首次出现时**不**全局停；按 2/8/20 秒重试；第 4 次仍失败则该联系人 `identity_skipped`，任务继续下一位。
2. 连续两次证据指纹相同时，立即跳过，不再等待剩余延迟。
3. 连续第 3 位联系人 r008 失败时触发全局暂停，该联系人仍是当前联系人，没有被跳过。之后点"重新加入"或"启动"，从这位联系人重新开始，并完整重走身份核验。用例要覆盖**纯文字任务**和**多段任务（文字加图片）**。如果中间某一位成功，计数清零。T6a 会复用这个熔断出口。
4. 被跳过的联系人可以通过"重新加入"补跑，补跑时身份核验完整重走。
5. run-bill 的 `rule_counts` 包含 `search-r008`。
6. `npm.cmd run check:self` 通过，其中包括 `wechat-failure-policy-review`。

## 需用户本人验收（发布 1 后）

- 异机跑一批以后，诊断包中 r008 不再触发全局停机；统计每百人全局停机次数、跳过率、跳过后补跑成功率。
- 用新的 r008 证据字段判断 r008 的真实成因（我来分析）。
