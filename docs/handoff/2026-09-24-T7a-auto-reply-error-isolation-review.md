# T7a 审查结论：打回（2 处代码缺陷 + 结果数据更正，在同一分支追加）

审查对象：`codex/auto-reply-workflow-resilience`（581272a，基线 08be3af）

## 已做对

- 逐人隔离、退避、点"启动"恢复、原因码、自动加入时排除重名，都有测试，新测试在 08be3af 上会失败。
- 变异 31 个，抓到 23 个；漏掉的 8 个都是测试缺口，见"必须补的测试"。
- 没发现发错人、重复发送、回复名单外的人：被剔除者的别名不进扫描；结果未知仍暂停、不补发（恢复时清空回复护栏的变异 M20 被测试发现）。
- 新诊断里没有联系人名、ID 或消息文字；新原因码已登记；`check:self`、`build:test` 都通过。

## 必须修

1. **【安全】退避期间用户点"暂停"，到期后会自动恢复并真的发出回复。**
   - 原因：`enterWorkflowBackoff`（`auto-reply-ipc.cjs:1513`）置了 `workflowStartPending = true`；悬浮窗的暂停走 `pause()`（:2230），只把状态改成 paused，没清这个标记；下一步 `:3888` 看到标记，就把状态强制改回 `running`。
   - 复现（审查探针 P1）：AI 断网 → 进入退避 → 调用 `pause()` → 30 秒后下一步返回 `running`，发送 1 次。不在退避时暂停，则一直保持暂停、发送 0 次。
   - 修法：用户暂停必须优先于退避。`pause()` 清掉退避和 `workflowStartPending`（`pauseWorkflow` 在调 `pause()` 之后再置回 true）；或者给退避单独设"到期重查"标志，只在状态仍是 `running` 时才生效。
   - 用例：退避中暂停 → 过了退避时间再走一步 → 断言仍是暂停、发送 0 次。去掉修复后必须失败。
2. **诊断刷屏，会挤掉有用的诊断。**
   - `:3874` 只要名单里有被排除的人，每一步（约 2.5 秒）都写一条 `workflow_scope_excluded`；`:3835` 退避期间每一步都写一条 `workflow_step_return`；`wechat-workflow.cjs:517` 的 `reply.step_skipped` 同理。
   - 诊断文件超过 512KB 会只留最后 500 行（`:22-23`、`:704`），空闲 200 步就写了 200 行、70KB，大约 1 小时后扫描、发送、`system_error` 等记录全被挤掉。而名单里有重名正是这位客户的常态。
   - 修法：同一次运行内，同一条诊断只在内容（原因码、计数）变化时写一次；换了运行照常再写（满足卡片"跨运行不去重"）。
   - 用例：空闲走 200 步，同一原因码只写 1 条；重新启动后再写 1 条。
3. **结果文档的别名串长度要更正。** 每人按 3 个别名（备注、昵称、名字）重测：2000 人时别名串 66,671 字符，超过 Windows 命令行 32,767 的上限。请在 result 写明超限和实测数字，是否另出卡由用户决定，本卡不改。

## 必须补的测试（变异存活）

- M07 跨运行不去重：现有用例两次失败之间夹了一步 `reply_idle`，没真正测到。
- M16 扫描无新消息时清零退避。
- M23/24/25/28 顶部要求的 `workflow_step_return`、`start_pending_missing`、`scope_invalid:<码>`、`reply_error_sticky` 诊断码（可和第 2 条的用例合并）。
- M27 手动选中重名者时整体拒绝。
- M30/M31 退避后重走启动检查；返回聊天失败后重新 prime。
- 验收 5"B 的会话消息不回复"：让假扫描返回 B 的会话，断言发送 0 次（现在的用例只断言了别名）。

## 顺手（小）

- `screenWorkflowRecipients`（:3957）在账号不一致时静默接受 0 人，应写明原因码。
- 加入名单的日志 code 固定写成 `workflow_recipient_ambiguous`，应按实际原因写。

## 合并提示

基线已到 `cdb01ed`（T5 已合并）。请先变基再提交：冲突只在 `wechat-workflow.self_check.cjs` 开头的 require 块，取两边并集（保留基线的 4 行，加上 `createAutoReplyController`，去掉单独的 `{ loadTaskState }`）。

**自测**：`C:\Users\Scott\AppData\Local\Temp\xiaoxi-rv5\scratch\t7a\`：探针 `WT=<你的工作区> node probe.cjs`（P1 必须变成发送 0 次），变异 `WT=<你的工作区> node mutate.cjs mutations.json`（上面列出的存活项都要被发现），以及 `check:self`、`build:test`。
