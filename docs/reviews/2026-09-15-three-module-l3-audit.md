# 微信拓客三模块 L3 盲区与组合链路审查

> 日期：2026-09-15 ｜ 范围：自动回复 / 精准触达 / 朋友圈运营，单独运行 + 统一调度组合运行
> 性质：只读审查，未改代码、未跑测试
> 判据：每条"成功/放行"路径三问——①有没有记录？②能否区分"完全确认"与"降低标准"？③错了能否事后查账？

---

## 一、总判断

1. **L3 类盲区（错误地成功、无声无息）三个模块都有，程度不同**：自动回复最严重（生产模式默认走模糊匹配且不留精度记录）；朋友圈中等（头像哈希不拦截 + 身份复核函数是死代码）；精准触达已在上一轮确认。
2. **组合链路能跑通**：文件锁 + 调度串行 + 自重入防护三重互斥完整，无"回复切走触达会话"的窗口，剪贴板无争用——这部分架构是扎实的。
3. **真正的组合级风险是停机范围**（与首轮审查根因 4 一致）：身份/会话类错误码不在任务级白名单，任何一个冒泡，三个功能同时停。

---

## 二、自动回复（最严重 🔴）

### 🔴 1. 生产模式默认"模糊匹配也放行"，且成功记录不分精度

- 生产"全部已同步联系人"模式 `strict:false`（auto-reply-ipc.cjs:1977-1985），仅测试/工作流模式 `strict:true`（:1390、:1998）。
- 非 strict 时发送端模糊匹配：标题编辑距离 ≤34% 长度、首字符+末 2 字符相同即放行（wechat_auto_reply_visual_send.dev.cjs:139-154，侧栏 :346-357，扫描端 wechat_auto_reply_visual_driver.dev.cjs:200-240）。
- `exact=$false` 只用于行内决策（visual_driver:721），**从不写入发送结果**：`$finalResult`（send:1420-1426）只有 conversationVerified 布尔值；`reply_send_finished`（auto-reply-ipc.cjs:3354-3387）无 exact/fuzzy 字段。
- **与触达 unique_local_visual 完全同构**：发错人的成功与正常成功在账面完全一致。

### 🔴 2. 发错人无法还原识别证据

`recordReplyGuard`（auto-reply-ipc.cjs:2176-2190）与发送完成日志只落**解析后的白名单名**，不落 OCR 原始标题和编辑距离。模糊匹配把 A 客户误配到 B 客户时，日志显示的是合法联系人名，原始证据为零。

### 🟡 3. 诊断日志滚动上限

`auto-reply-diagnostics.jsonl` 上限 500 行/512KB（:22-23），高流量下"错误地成功"的记录会被滚动冲掉。

### ✅ 已有防护（资产，勿动）

- AI 失败不发明文兜底：记 `reply_generation_skipped` 后跳过（:3133-3164）；回复过安全检查，涉验证码/密码/支付直接拒绝（:388、:492-496）。
- 发送后核验强：草稿回读逐字相等（send:1250）；点击前重验会话绑定（:1354-1404）；点击后要求 draft_consumed 或 bubble_verified（:1127-1195），否则 outcome_unknown 暂停（auto-reply-ipc.cjs:3614-3633）。
- exactly-once 完整：fingerprint 去重（:1269-1281）、unknown 禁止补发（:2985-3011）、turn-boundary 防跨轮重复（:1314-1319）。
- 跳过留痕：各 skip 均有 reason 白名单（:145-228、:2963-2981）。

---

## 三、朋友圈运营（中等 🔴）

### 🔴 1. 头像哈希不匹配不拦截 + 身份复核死代码

- `Resolve-MomentsInteractionAnchor` 计算头像像素哈希后，`avatarHashMatched` 只写 diagnostics（moments_visual_probe.dev.cjs:642），**不参与放行判定**（:644-646 只看菜单候选数）——"看着不对也继续"。
- 点赞/评论重锁定的唯一硬约束是 menu_hash 精确匹配（moments_visual_action_driver.dev.cjs:1101-1104）；头像层靠像素启发式 `Find-MomentsAvatarForMenu`（probe:658-692）配对，A 帖身份可能配到 B 帖菜单，无文本级复核。
- `Test-MomentsStablePostIdentity`（driver:1072-1074）**定义了但从未调用**——写好的防线没接上。

### 🟡 2. 账本有 verificationMode 无置信度

attempt 账本（moments_action.dev.cjs:1296-1340）持久化 status/verification_mode/post_fingerprint 等，能区分"怎么验证的"，但识别得分（avatar score、OCR 计数）只在 diagnostics 部分落盘——无法知道"识别时有多确定"。

### 🟡 3. 去重模糊匹配的漏处理查账困难

`contained_visual_text` / `stable_visual_identity` 用包含比较与编辑距离 ≤4%/7% 判同帖（moments-campaign-ipc.cjs:240-251、probe:340-360）。误判 → 该帖永远跳过，skip 只计数+last_reason，无 fingerprint 明细。

### ✅ 已有防护（资产，勿动）

- 点赞：菜单哈希精确比对 + 菜单态必须精确为"赞"（:5247-5249）+ 二次重读校验 bounds（:5251-5262）+ 点击后验证"取消赞"，否则 outcome_unknown（:5279-5288）。
- 评论：发送前 UIA 精确回读编辑器（:5533-5541）；发送后 13 项回读证明链（moments_comment_readback_proof.dev.cjs:1-18）；去重检查不可用时拒绝猜测（:5200-5203）。
- 发布：outcome_unknown 强制阻塞后续发布（moments-publish-ipc.cjs:544、589-590）。
- 不确定即停：campaign 收 outcome_unknown 立即 pause（moments-campaign-ipc.cjs:762-770）。

---

## 四、三链路组合运行（能跑通 ✅，一个缺口 🔴）

### ✅ 互斥完整，无交叉打断

- 进程级文件锁单持有者（runtime-coordinator.cjs:63-88，busy 返回 wechat_operation_busy），三个执行器各自 acquire（touch-workflow.cjs:247 / auto-reply-ipc.cjs:2748 / moments-campaign-ipc.cjs:1010）。
- 调度层串行：inFlight 防重入（wechat-workflow.cjs:524-526）；回复观察完成后才取任务（:424-443）。
- 触达每步自核验会话（touch-workflow.cjs:295），回复切换只发生在触达步之间。
- 剪贴板/输入全部持锁操作，busy 方按类型退避（触达 pending+retryAfterMs=1000，touch-workflow.cjs:248-251）。**不存在"触达粘贴中回复开工"的窗口。**

### 🟡 吞吐损耗（有意设计，可接受）

触达每发 1 人进入 8~15 秒安全间隔（touch_task_state.cjs:626-628），间隔内朋友圈被调度（不饿死但被延迟）；持续消息流下 3583 人批量会被自动回复反复插队，批量耗时不可控。不死锁、不中断，仅变慢。

### 🔴 停机白名单缺口（组合级最大风险）

`LOCAL_TASK_ATTENTION_REASONS`（wechat-workflow.cjs:8-16）仅 6 码：touch_task_payload_incomplete / moments_no_new_posts / moments_workflow_config_invalid / workflow_occurrence_date_invalid / workflow_executor_unavailable / touch_draft_generation_failed。

**不在名单、冒泡即三功能齐停的**：`contact_identity_ambiguous`（:27）、`account_mismatch`（:29）、`contact_sync_running`（:30）、`atomic_conversation_changed`，以及 runCycle catch 无 reasonCode 的任何异常（:509-514 直接 enabled=false）。

缓解现状：多数 identity 失败已在 touch-workflow 内部消化为 identity_skipped 不冒泡（:216-227、:391-411）；真正会冒泡的是 `atomic_conversation_changed`、`batch_authorization_missing` 和无码 outcome_unknown。**`atomic_conversation_changed`（会话被切走）本质是可恢复的瞬时状态，全局停属于停机范围过粗——正是首轮审查指出的"拉全厂电闸"。**

---

## 五、修复优先级总表

| # | 优先级 | 事项 | 模块 | 位置 |
|---|---|---|---|---|
| 1 | 🔴 | 发送结果与 reply_guard 增加 `conversation_match=exact\|fuzzy` + OCR 原始标题落盘 | 自动回复 | auto-reply-ipc.cjs:2176/3354, send:1420 |
| 2 | 🔴 | Resolve 放行前强制 `avatarHashMatched`；恢复调用 `Test-MomentsStablePostIdentity` | 朋友圈 | probe:644, driver:1072 |
| 3 | 🔴 | `atomic_conversation_changed` 降为任务级处理（重试恢复，不全局停）——产品确认后实施 | 组合调度 | wechat-workflow.cjs:8-16 |
| 4 | 🟡 | relaxed/fuzzy 成功的审计记录豁免日志滚动上限 | 自动回复 | auto-reply-ipc.cjs:22 |
| 5 | 🟡 | attempt 账本统一补数值置信度字段（L2 结构指纹方案天然覆盖） | 朋友圈 | moments_action.dev.cjs:1296 |
| 6 | 🟡 | 去重误判的 skip 记 fingerprint 明细 | 朋友圈 | moments-campaign-ipc.cjs:240 |
| 7 | 💭 | L1 分支 ID 编号推广到三模块（一次做完，与触达共用标准） | 全部 | — |

**统一标准（一句话）**：三个模块同一套账——成功必须带"精确/模糊"标记与识别证据；凡降低标准放行必留痕；失败与不明一律不静默。这与触达侧 identity_relaxed 方案是同一个工程，建议一次设计、三处落地。

## 六、未覆盖声明

- 自动回复视觉驱动 174KB 与朋友圈驱动 265KB 未逐行通读，基于关键函数定位+代理梳理；未运行任何测试；未在真实微信验证修复方案（尤其 #2 强制 avatar 哈希可能提高拦截率，需实测权衡拦截率与通过率）。
