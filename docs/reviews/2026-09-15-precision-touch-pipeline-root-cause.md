# 精准触达链路打通专项审查：为什么"跑上百成千个联系人"至今跑不通

> 审查日期：2026-09-15（晚） ｜ 视角：交叉审查（只读，未改任何代码，未运行测试）
> 目标口径：用户要求已降级为"只要精准触达一条链路打通，能跑百人/千人规模"
> 数据来源：本机运行数据（xiaoxi-active-touch-test）、diagnostics.jsonl(.1)、wechat_workflow/state.json、PROJECT_STATUS 1.1.20–1.1.33 条目、今晚未提交 WIP（19 文件 +765/-408）

---

## 一、总判断

**链路跑不通不是一个 bug，而是一条"故障放大链"。每一层单独看都有理由，组合起来的效果是：任何一个小故障都会把千人大任务杀死。**

当前各层的真实状态（按证据）：

| 层 | 状态 | 证据 |
|---|---|---|
| 识别层（搜索认人） | **本机已通、客户机已通到"打开会话"** | 1.1.31 放宽后本机三轮 4/4 全绿；客户机 1.1.32/33 反馈确认"联系人打开、会话核验、文案输入均成功" |
| 发送层（发送前草稿核验） | **客户机当前卡点** | 1.1.32 反馈 `input_draft_read_failed`（clipboard_sentinel_write），1.1.33 换 PowerShell 接口后**未验证** |
| 编排层（失败处理） | **结构性根因，未修** | 发送前失败的 reasonCode 不在 6 码白名单 → `enabled=false` 全局停机 |
| 诊断层 | **今晚 WIP 修到一半**（rule_id + 证据采集，未提交） | docs/failure-evidence.md、wechat-rule-catalog.json |

一句话：**Codex 一直在修"识别"和"剪贴板"，但真正让千百人任务死掉的是编排层把"一个联系人的可恢复失败"放大成"全部业务停摆"。这个不修，识别率和剪贴板修到 99% 也没用——1000 人任务平均会遇到几十次失败，每次都全局停，任务必死。**

数学论证（为什么编排层优先于一切）：设单联系人一次通过率 95%，1000 人任务中预期失败次数 ≈ 50。当前实现下每次失败 → `enabled=false` → 用户必须人工重新启动。**"跑千百人"的第一必要条件不是识别率 100%，而是"单点失败不停全局"。**

---

## 二、完整故障放大链（带代码证据）

以客户机 1.1.32 反馈的实际失败为例，一次 `input_draft_read_failed` 的完整传导：

```text
Read-InputDraft 剪贴板 sentinel 写失败（Win10 故障机）
  ↓ wechat_window_driver.dev.cjs:983-988（clipboard_sentinel_write 阶段）
  ↓ send_attempted=false（明确未发送，安全）
touch-workflow.cjs:358  notAttempted=true
  ↓ :361 isRecoverablePreSendInputBlock？ → 只认 wechat_external_input_detected
  │   和 message_input_failed_wechat_user_active 两类 → 否
  ↓ :375 identitySkipReason？ → input_draft_read_failed 不在 5 码跳过名单 → 否
  ↓ :418 attention("触达未执行...")  → 任务 needs_attention
wechat-workflow.cjs:489-490  applyTaskAttention(task, "input_draft_read_failed", ...)
  ↓ :380 LOCAL_TASK_ATTENTION_REASONS.has("input_draft_read_failed")？ → 否（白名单只有 6 个业务前置码）
  ↓ :384  enabled = false  ←←← 全局停机：朋友圈、自动回复全部陪葬
```

**三个环节单独看都"有自己的道理"，组合起来就是：一次剪贴板抖动 = 整个软件罢工。**

### 各环节证据

**环节 1｜白名单内容（wechat-workflow.cjs:8-16）**：`LOCAL_TASK_ATTENTION_REASONS` = {touch_task_payload_incomplete, moments_no_new_posts, moments_workflow_config_invalid, workflow_occurrence_date_invalid, workflow_executor_unavailable, touch_draft_generation_failed}——全是"业务前置"码，**没有一个运行期故障码**。运行期失败码（input_draft_read_failed、wechat_target_changed、input_draft_target_not_owned、clipboard_*、powershell_timeout…）全部落入"未知码→全局停"。

**环节 2｜发送前失败分类缺口（touch-workflow.cjs:358-423）**：发送前失败（send_attempted=false）只有三条出路：①外部输入/用户活跃→15s 有界恢复（✅已做）；②5 个 identity 码→跳过（✅已做）；③**其余一切→attention→全局停**（❌缺口）。同构缺口也存在于 legacy 路径 touch-task-ipc.cjs:697-749（identity 跳过✅、pre-draft 恢复✅、其余→pauseTask→needs_attention❌）。**两条路径必须同步修，只修一条不改症状。**

**环节 3｜catch-all 兜底（wechat-workflow.cjs:509-515）**：任务执行抛任何异常 → 直接 `enabled=false`，无差别全局停。

### 今日实测数据印证（本机，xiaoxi-active-touch-test）

从 diagnostics.jsonl.1 提取的 09-15 完整时间线（UTC，+8=本地）：

- **13:50–14:34（旧版 1.1.30 上）**：三轮任务共 20 次失败 = 16× `search_result_identity_unverified` + 3× `wechat_external_input_detected` + 1× `wechat_target_changed`。其中 **wechat_target_changed 那一次触发全局停**，任务中断 29 分钟（05:51→06:20 需人工重启）——这是"单点失败停全局"的现场实证。identity 失败没有停任务（1.1.24 修复生效✅），但在联系人上重试 2-3 次后跳过。
- **14:44**：contact_sync 重启微信 + 更新到位。
- **14:46–15:07（1.1.31+ 严格路径）**：三轮 4/4、4/4、1/1 全部成功，单联系人耗时约 21s + 安全间隔约 11s ≈ **32s/人**。
- **吞吐换算**：本机 32s/人 → 1000 人 ≈ 8.9 小时。客户机 PowerShell 慢（朋友圈模块实测 10s 级卡顿），预计 60-90s/人 → 1000 人 = 17-25 小时，**必须跨夜无人值守** → 编排层停机问题更加致命。
- 运行期间 `wechat_user_active` 保护意味着**用户全程不能碰机器**——这是正确设计，但要在产品预期上说清楚。

---

## 三、各层具体发现

### 发送层（客户机卡点的机制分析）

`Read-InputDraft`（wechat_window_driver.dev.cjs:910-1019）每次发送前**无条件**执行：
1. 光标移到输入框**估算坐标**（默认 bottom-105 / x=0.65 比率，:949-950）；
2. 鼠标点击输入框；
3. 剪贴板写 sentinel（:983-985）；
4. SendKeys ^A ^C（:991-997）；
5. 读剪贴板比对（:1003-1004）；
6. finally 恢复剪贴板+光标（:1012-1017）。

结构性问题：

- **E5｜剪贴板是全局竞争资源**：每个联系人 before 阶段 ≥2 次写 + 1 次复制 + 恢复；after 阶段在气泡核验失败时再来一轮（:1143-1146）。千人 = 数千次全局资源操作，被剪贴板管理器/输入法云同步/微信自身任意一次抢占即失败。1.1.32 客户机 `clipboard_sentinel_write` 失败、1.1.33 换 PowerShell 接口（方向正确）都发生在这一环。
- **E6｜无 UIA 优先路径**：即使在 UIA 正常的机器上，代码也走剪贴板。UIA 的 ValuePattern 可以直接读输入框文本（零剪贴板依赖、零坐标依赖），但当前实现完全没有用。
- **E7｜after 阶段的双路径耦合**：`draft_consumed` 兜底要求 before 的 `draftExact===true`（:1146）；before 失败 → after 两条核验路径同时失效 → 一旦已点发送即 outcome_unknown。before 的可靠性直接决定 after 的可用性。
- **反方复核（不许做的）**：不能建议"跳过发送前核验/粘贴完直接点发送"——那是把 fail-closed 改成 fail-open。正确方向是**换证据来源**（UIA 直读）而不是**取消证据**。

### 识别层（已大幅缓解，但有安全债）

- **E8｜relaxed 放行没有配套强核验**（上次审查 Blocker 1，至今未实现——全仓 grep `identity_relaxed` 0 命中）：
  - `unique_local_visual`：本地唯一带标签候选就点，**不核验读出的微信号是否等于目标**（resolver :242-244）；
  - `unique_local_surface_visual`：完全读不出身份文字、只有一行表面文字也点（resolver :278-283）；
  - 兜底会话核验仅 `title.includes(customerName)`（state_machine.cjs:473）——同名、短名（"王"）、expectedName 为空时形同虚设。
  - 千人规模下 1% 放行错误 = 10 个发错人且日志显示"成功"。**这条债在放量跑之前必须还**，否则跑得越快错得越多。
- **E9｜今早 16 次 identity_unverified 无法定性**：失败发生在 13:50-14:34（更新下载 13:48 失败 ⇒ 还在旧版 1.1.30 上），14:44 重启微信+新版后消失。**既不能证明 1.1.31+ 已修复（没复现过故障形态），也不能定罪当前版本（旧版行为）**——这正是今晚 rule_id WIP 要解决的"无分支 ID 日志"问题。结论：留待带 rule_id 的版本在故障形态复现时归因。
- **E10｜`wechat_target_changed` 不在任何跳过/恢复名单** → attention → 全局停（今晨现场实证）。它多数时候是"用户碰了微信/窗口切换"类可恢复扰动。

### 编排层（除停机外）

- **E4｜`integrity_error` 永久死锁**（touch-workflow.cjs:176、:473）：`canRetry` 恒 false，无"重置此任务"入口。上次审查已提，仍未修。千人任务跑几十小时，一次状态写坏 = 整任务报废。
- **E11｜批量续跑与授权**：1.1.24 已改"跨批次自动准备下一批并保持运行"✅；授权绑定整份冻结清单✅。这两个不再挡路。

### 诊断层（今晚 WIP 评估）

- **E12｜方向正确，完成度一半**：
  - rule_id 编号表（349 个拒绝位置）+ 本地 JSON/PNG 取证 + 诊断包导出 = 上次建议的 L1+L4，✅；
  - 但截图是 `full_content` 保守遮罩（遮住整个内容区，docs/failure-evidence.md 自述"不能用它检查聊天文字、OCR 识别结果或联系人身份"）→ 对"识别层到底看见了什么"的取证价值≈0，只能证明"失败发生过"。识别层归因仍主要靠 rule_id + 结构指纹；
  - WIP 未提交（19 文件改动+8 新文件）。按 AGENTS.md 规则，**不能从这个 dirty worktree 出包**。
- **E13｜数据链断点（上次审查已定性的 O-6 类问题）**：resolver 早已产出 rule_id/candidate_count/ocr_ok，但 1.1.30 时代的 state_machine block() 丢弃 inputResult.diagnostics → 日志 diagnostics:null。今晚 WIP 是否已修透传需在提交后回归确认（本次未逐行核对 765 行 diff 的透传完整性）。

### 环境层（产品决断仍悬置）

- 客户机 Win10 19042/19045：UIA 空控件树 + OCR 拆词 + PowerShell 慢，这是**物理事实**，不会因版本迭代消失。上次报告 P2-8 的决断（半自动模式 / 列为不支持环境）用户尚未拍板。
- 用户当前目标（"要求不高，跑通就行"）下，**不必先做这个决断**——1.1.31 放宽后识别层已能在这类机器上打开会话（客户机反馈证实）。但若 P0 修复后客户机仍卡在草稿核验（UIA 空 ⇒ UIA 优先路径也用不上），则半自动决断会重新变成必答题。

---

## 四、已验证没问题、不要动的清单（在原清单上追加今日验证）

| 项 | 今日验证证据 |
|---|---|
| identity 失败跳过 + 2 次自动恢复 | 本机三轮实测：identity 失败重试 2-3 次后跳过，任务未停（diagnostics.jsonl.1 05:50-06:34） |
| 外部输入有界恢复（3 次 × 15s） | touch-task-ipc.cjs:46-47 常量 + :713 重试上限存在 |
| 批量跨批自动续跑 | 1.1.24 修复，wechhat_workflow 状态记录未见 50 人边界停 |
| `outcome_unknown` 不自动补发 / `send_attempted` 门禁 | touch-workflow.cjs:26-27、:317、:424-427（本次抽查未发现软化） |
| 本机（Win11）全链路 | 14:46-15:07 三轮全绿，32s/人 |
| 1.1.31 放宽在本机有效 | 同上（严格路径 exact_wechat_id_search 放行） |

---

## 五、自我证伪清单

1. ~~"今早 16 次 identity_unverified 证明当前版本仍会失败"~~ → **否**。失败发生在 13:50-14:34，13:48 更新下载失败说明还在 1.1.30；14:44 重启+新版后三轮全绿。当前版本对该形态的表现**未知**，不是"仍失败"。
2. ~~"1.1.33 的剪贴板修复没解决问题"~~ → **证据不足**。客户机至今未在 1.1.33 上复验（PROJECT_STATUS 1.1.33 自述"异机实际发送仍须安装本版后复验"）。不能把"未验证"写成"无效"。
3. ~~"识别层仍是主要瓶颈"~~ → **过时**。客户机 1.1.32/33 反馈明确显示已推进到发送前核验阶段；识别层瓶颈已让位于编排层停机与发送层剪贴板依赖。
4. ~~"全局停是设计错误"~~ → **要分层**。对"结果不明"全局停是生命线（不动）；错的是把"明确未发送"类失败也全局停。
5. ~~"state_machine 有逻辑 bug 导致误停"~~ → 否（沿用上次审查结论，本次抽查未推翻）。

## 六、未覆盖声明

- `wechat_window_driver.cjs`（142KB）与 `wechat_window_driver.dev.cjs` 未逐行通读，只精读了搜索解析、草稿读取、发送核验、会话核验关键段；moments/auto_reply 模块不在本次范围。
- 今晚 WIP 的 765 行 diff 未逐行核对（只核对了 failure-evidence 的设计文档与 rule catalog 的存在性）。
- 未运行任何测试、未在真实微信上复现、未连接客户机。
- 客户机 3583 人中 `wechat_id_missing` 的排除比例未知（触达资格硬性要求公开微信号，touch_task_state.cjs:112）——**实际可跑人数可能远小于 3583，需要客户机跑一次分类统计**。
- 客户机 1.1.33 表现无数据（最后反馈停在 1.1.32）。

## 七、修复优先级总表

| # | 项 | 层 | 必要性（对"跑千百人"） | 详见 |
|---|---|---|---|---|
| P0-A | 停机范围收窄：未知码默认只停任务 + 发送前失败分类补缺 + integrity_error 出路 | 编排 | **第一必要条件**（数学论证见上） | 修复指令 A |
| P0-B | 发送前核验分级：UIA 优先直读 + 剪贴板降级 + 坐标→UIA 定位 | 发送 | 客户机当前卡点；无论 1.1.33 是否生效都需要 | 修复指令 B |
| P0-C | relaxed 放行配套：identity_relaxed 标记 + 强比对 + 放行审计 | 识别安全债 | 放量前的安全前提（否则跑得越多错得越多） | 修复指令 C |
| P1-D | 今晚 WIP（rule_id/取证）独立提交验证 | 诊断 | 让下次异机反馈可归因 | 修复指令 D |
| P1-E | 客户机先复验 1.1.33（不改代码） | 验收 | 确定 P0-B 是"主修"还是"加固" | 修复指令 E |
| P2 | wechat_id_missing 比例统计 UI 提示；无 UIA 机器半自动决断 | 产品 | 不阻塞主链路 | 修复指令 F（问题清单） |
