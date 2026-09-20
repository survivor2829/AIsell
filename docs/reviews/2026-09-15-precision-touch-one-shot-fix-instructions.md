# 给 Codex 的复核与修复指令：精准触达链路一次性修到位

> 日期：2026-09-15 ｜ 配套审查报告：[2026-09-15-precision-touch-pipeline-root-cause.md](./2026-09-15-precision-touch-pipeline-root-cause.md)
> 目标（用户原话口径）：**只要精准触达一条链路打通，能跑上百人/千人。**
> 工作方式：先只读复核本指令的每一条（确认/证伪/证据不足三态，允许反驳），再动手。每条修复独立提交、独立验证（一改一验），全部完成后**不直接合入，把 diff 交回复核**。

---

## 第〇步：复核（只读，先于一切改动）

对下面每条主张给出三态判定（确认 / 证伪 / 证据不足）+ 文件行号证据。允许反驳，但反驳必须带代码证据，不接受"我觉得"。

1. `LOCAL_TASK_ATTENTION_REASONS`（wechat-workflow.cjs:8-16）只有 6 个业务前置码，所有运行期故障码（input_draft_read_failed / wechat_target_changed / input_draft_target_not_owned / clipboard_* / powershell_timeout 等）都会走 `applyTaskAttention` → `enabled=false` 全局停。
2. touch-workflow.cjs:358-423 中，send_attempted=false 且非 identity 码的失败 → :418 attention；touch-task-ipc.cjs:697-749 存在同构缺口（→ :748 pauseTask）。
3. `Read-InputDraft`（wechat_window_driver.dev.cjs:910-1019）在发送前无条件走"坐标点击 + 剪贴板 sentinel + ^A^C"链，无 UIA ValuePattern 优先路径；输入框坐标是估算值（:949-950）。
4. after 阶段 `draft_consumed` 兜底依赖 before 的 `draftExact===true`（:1146）。
5. resolver 的 `unique_local_visual`（:242-244）与 `unique_local_surface_visual`（:278-283）放行不核验身份值；兜底会话核验为 `title.includes(customerName)`（state_machine.cjs:473）；全仓无 `identity_relaxed` 标记。
6. `integrity_error` 无重置出路（touch-workflow.cjs:176、:473）。
7. 当前工作树有 19 文件未提交改动 + 8 个未跟踪新文件（failure-evidence WIP），此状态下不得出包。

---

## A｜停机范围收窄（P0，编排层）

### A1. 反转默认方向

`applyTaskAttention`（wechat-workflow.cjs:375-388）改为：

- 新建显式 `GLOBAL_ATTENTION_REASONS` 白名单，**只含**：`outcome_unknown` 及"结果不明"族（发送结果无法确认类）、账号/授权失真（account_mismatch、授权无效类）、窗口/会话身份丢失（wechat_window_identity_mismatch 族）、`integrity_error`、`application_disposing`。
- 白名单内 → `enabled=false` 全局停（保持现状）。
- 白名单外（含一切未知码）→ **只停当前任务**（task.status=needs_attention，enabled 不动，timer 不动）。
- 保留 `requiresGlobalAttention===true` 强制通道，语义不变。
- runCycle 的 catch（:509-515）同步改：异常默认只停任务；仅当异常可归类为上述"结果不明/身份丢失"类才全局停。无法归类时**停任务并保留原始错误文本**（diagnosticReason），不全局停。

判据一句话（写进代码注释）：**这个错误值得让朋友圈和自动回复一起等吗？**

### A2. 发送前失败分类补缺（两条路径同步）

touch-workflow.cjs:358-423 与 touch-task-ipc.cjs:697-749，在 identity 分支之后、attention 之前，**新增一层"可恢复发送前失败"分类**：

- 条件：`send_attempted === false` 且 `!retry_blocked` 且当前 status 不在 ["prepared","clicked","outcome_unknown"]；
- 新增可恢复码集合（初版）：`input_draft_read_failed`、`wechat_target_changed`、`input_draft_target_not_owned`、`wechat_window_not_foreground`、`clipboard_*`（clipboard_read_failed / clipboard_sentinel_write / wechat_clipboard_restore_unsupported）、`powershell_timeout`；
- 行为：有界重试本联系人 2 次（退避 5s/15s），仍失败 → 标记 `pre_send_failed`（新状态，语义=明确未发送、可安全重试），**跳过并继续下一位**；记入 skipped 结果（与 identity_skipped 分列，UI 可见）；
- 重试前必须重新走窗口/会话核验（现有"重新验证微信窗口和当前会话"路径），不许直接续跑；
- 明确排除：任何 `outcome_unknown`、`send_attempted!==false`、retry_blocked 的情况——这些仍走原路径（fail-closed 生命线，一个字都不许动）。

### A3. integrity_error 出路

给含 `integrity_error` 的任务加"重置此任务（丢进度、保留已确认发送的账本）"入口；重置后任务从首个未完成联系人重新可启动。已 sent_verified / outcome_unknown 的记录**不得**被重置清除。

### A4. 断言预告

- 现有"未知码 → 全局停"的自检断言改为"未知码 → 仅停任务"；新增反例组："outcome_unknown / account_mismatch / integrity_error → 仍全局停"（断言不得删只许改，改动逐条列出）。
- 新增断言必须非空洞：在旧实现上跑必须红（用新旧对照探针，两边夹具同源）。

**反方复核要求**：改完后自查三点——①结果不明类是否仍 100% 全局停（用"outcome_unknown + reason 恰好等于某白名单码"探针）；②朋友圈/自动回复的既有全局停语义是否被误伤；③暂停→恢复路径是否仍通（不能出现"队列无 pending 就拒绝重启"）。

---

## B｜发送前核验分级降级（P0，发送层）

### B1. UIA 优先直读草稿

`Read-InputDraft` 改为两级：

1. **UIA 路径（首选）**：在预期 PID/HWND 会话内，用 UIA 查输入框元素（Edit/Document 控件，会话底部区域），命中且 ValuePattern 可读 → 直接读文本返回，**全程不碰剪贴板、不移动光标、不点击**。读取结果与剪贴板路径同构（text/isEmpty）。
2. **剪贴板路径（降级）**：UIA 定位不到或读不出时，走现有 sentinel 链；`Set-XiaoxiClipboardTextWithRetry` 重试预算 ≥3 次、指数退避（现状是多少次请先复核报告）。
- 输入框**坐标估算降为最后兜底**：优先 UIA BoundingRectangle 的中心点。

### B2. 验收断言（非空洞）

- UIA 正常的夹具：断言剪贴板 API 调用次数 = 0、光标未移动；
- UIA 空 + sentinel 写失败 N 次：断言走 A2 的有界重试 → 跳过，**不全局停**；
- UIA 读出的文本与剪贴板读出的文本在同一夹具上逐字一致（两路径等价性）。

### B3. 禁止事项（硬约束）

- 禁止跳过发送前核验、禁止"粘贴完直接点发送"；
- 禁止降低 after 阶段（message_bubble / draft_consumed）的任一判定标准；
- 禁止把 `draftExact` 失败静默当作"空草稿"放过（现状 isEmpty 语义保持：sentinel 未变 = 空；读失败 = 失败，不是空）。

**反方复核要求**：B1 上线后，若客户机 UIA 恒空，剪贴板路径仍会高频执行——复核"重试预算 × A2 跳过"组合下的最坏耗时（单联系人上限应 < 2 分钟），超过则调预算而不是删护栏。

---

## C｜relaxed 放行配套（P0，识别层安全债，放量前必须还）

1. resolver 以 `unique_local_visual` / `unique_local_surface_visual` 放行时，返回结构带 `identity_relaxed: true` + 分支 ID；
2. 该标记逐层透传到任务行（results[i]）与诊断事件；
3. **带 identity_relaxed 的会话核验升级为强比对**：标题完全等于 expectedName（trim 后全等），或核验会话资料区微信号与目标一致；includes 兜底**仅允许用于非 relaxed 路径**；
4. expectedName 为空或长度 <2 时，relaxed 放行直接禁用（回退 unverified）；
5. 放行审计事件：分支 ID + 候选数量 + 几何结构指纹（纯数字，无文字）。

**反方复核要求**：强比对可能让部分原本能过的 relaxed 放行被拒——这是预期行为（宁可跳过不可错发），但要断言"拒绝后走 identity_skipped 而非全局停"，否则 C 和 A 会互相打架。

---

## D｜今晚 WIP 的处置（P1，诊断层）

1. failure-evidence / rule-catalog / 诊断包脚本作为**独立提交**先行验证、先行合入（与 A/B/C 分开，一笔一验）；
2. 提交前自检：rule catalog 编号与 `Write-XiaoxiFailure` 调用点的一致性（新增/删除调用点必须同步编号表，编号不复用）；
3. **resolver→日志透传**回归：确认 state_machine block() 现在真的把 `inputResult.diagnostics`（含 rule_id、candidate_count、ocr_ok）透传到 diagnostics 事件（1.1.30 时代这里是断的）；
4. 截图取证维持保守遮罩不动（安全取舍正确），但要在文档里明示"截图不能用于识别层归因"——归因靠 rule_id + 结构指纹。

---

## E｜验收协议（对用户承诺"一次改到位"）

### E1. 出包前（本机）

- `npm.cmd run check:self` + `build:test` 全绿；
- A/B/C 各自的新旧对照探针：新断言在旧实现上必须红、在新实现上必须绿；
- 一次 headless 千人模拟：注入 5% 联系人失败率（混合 identity / clipboard / target_changed），断言：任务不全局停、失败联系人全部进入可重试终态、无 outcome_unknown 误产生、总时长可接受。

### E2. 出包后（客户机，按序）

1. **先装当前已构建的 1.1.33 复验**（这一步不改代码）：跑 20-50 人，看 `input_draft_read_failed` 是否复现。**不复现** ⇒ 剪贴板修复已生效，B 是加固；**复现** ⇒ B1 是主修，且 rule_id 会给出具体阶段。
2. 装 A+B+C+D 版本，跑 100 人批次过夜：验收标准（用户口径）——
   - 任务不中断（或中断原因明确为"结果不明"类且可人工决议）；
   - 结束时 UI 分列：成功 / 跳过（可重试）/ 待人工；
   - 任何一次失败，**只凭日志（rule_id + 结构指纹）就能说出"哪条规则、因为什么结构、拒绝了什么"**，不需要问用户"你当时看到啥"。
3. 100 人连续两批稳定后，才放量到千级。

### E3. 报告口径

按 AGENTS.md：交付说明改了什么、验证结果、未验证项；"机制生效"（不再全局停）与"根因消失"（该跳的还跳不跳）分开陈述，不许混写。

---

## F｜需要用户拍板的问题（不阻塞主链路，集中一次问）

1. 客户机 3583 人里 `wechat_id_missing`（无公开微信号）的占比未知——建议在客户端加一个"本次触达可跑人数 vs 排除人数及原因"的赛前统计提示。**用户的"上千人"可能实际只有几百人可跑。**
2. 千人任务预计 17-25 小时（客户机），跨夜运行时用户不能碰机器（wechat_user_active 保护）。是否接受？是否要加"夜间自动暂停/白天续跑"？
3. 若 A+B 修完后客户机（UIA 恒空）仍高频走剪贴板降级路径：是否为这类机器提供半自动模式（人工点搜索结果，机器管话术/节奏/账本）？

---

## 硬约束（全文有效，违反任何一条即打回）

- 🚫 禁止为走通链路软化任何 fail-closed 判定：`outcome_unknown` 不自动补发、`send_attempted` 门禁、已发送分段不重发、`retry_blocked` 不置假；
- 🚫 禁止在实测出结论前改异常处理与对账逻辑（先复核第〇步再动手）；
- 🚫 禁止批量重命名/顺手重构/一次提交混多类改动（一改一验，提交按 A/B/C/D 拆分）；
- 🚫 禁止从 dirty worktree 出包；WIP 与行为修复分开提交；
- 🚫 禁止把"跳过人数"混入"已发送"计数（分列是 1.1.26 之后的既有规矩）；
- ✅ 每条修复附反方复核（会不会引入新问题），修复完成后把 diff 交回复核，不直接合入。

## 附：证据快照（审查报告全文见同目录）

- 本机今日时间线：diagnostics.jsonl.1（05:50-06:34 UTC 三轮失败→06:44 重启→06:46-07:07 三轮全绿）
- 客户机卡点：PROJECT_STATUS 1.1.32/1.1.33 条目（反馈 ad145325、52cb71f2）
- 停机链代码：wechat-workflow.cjs:8-16、:375-388、:509-515；touch-workflow.cjs:358-423；touch-task-ipc.cjs:697-749
- 发送核验代码：wechat_window_driver.dev.cjs:910-1019（Read-InputDraft）、:1083-1153（before/after）
- relaxed 放行：wechat_search_result_resolver.cjs:242-244、:278-283；state_machine.cjs:473
