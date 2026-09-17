# 精准触达放宽改动审查 + 异机日志精准定位方案

> 日期：2026-09-15 ｜ 对象：提交 `553475a`（open unique contacts and resume safely）、`4c35ab7`（personalize outreach from embedded aliases）
> 性质：只读审查，未改代码、未跑测试

---

## 一、这轮改了什么（事实层）

**553475a 核心动作 = 放宽"认人"标准，让链路不再轻易停下：**

1. OCR 截图 2 倍放大再识别（`wechat_window_driver.cjs` `$ocrScale=2`），坐标映射回原屏幕，有测试（`clickedX===182`）。✅ 纯工程改进，无安全争议。
2. resolver 新增/提前两条放行路径（`wechat_search_result_resolver.cjs:347-355`）：
   - `exact_wechat_id_visual`：带"微信号："标签且值匹配 → 点（原有，提前）；
   - `unique_local_visual`：**本地只剩 1 个带标签候选就点，不检查读出的微信号是否匹配目标**；
   - `unique_local_surface_visual`：**完全读不出身份文字、只有一行名字也点**。
3. `wechat_target_changed` 从"点击位置根窗口==预期窗口"放宽为"点击位置属于微信进程即可"（`Test-SearchResultClickTarget`，测试明确 `sameProcessPopup=true` 放行）。
4. `isRecoverablePreDraftInputBlock` 删除 `safety.phase==="pre_input"` 限制：`copy_probe` 阶段检测到外部输入也自动恢复重试；文案从"草稿未写入"修正为"消息尚未发送"。
5. 诊断增强：点击被拒时输出 `safety_diagnostics`（phase/expected_hWnd/hit_hWnd/pid）。✅ 正是"日志精准定位"的方向。

**4c35ab7 = AI 称呼提取升级**：从"品牌客户经理炎燃19946167505"这类"备注+手机号"长字段提取人名；正反例测试齐全（"上海星辰科技1380013800"→generic）。✅ 真实业务痛点，改动干净。

## 二、总体判断

**"链路修通了"和"精准触达没问题了"是两件事。**

- 本机修通的本质：认人标准从"宁可错杀（停下问人）"向"错放（点了再说）"挪了一大步。挪这一步可以是对的（等于把赌注押在"点进去之后的会话核验"上），**但现在的会话核验强度还撑不起这个赌注**。
- 本机通过 ≠ 故障机通过：故障机（Win10 19042/19045 + UIA 空 + 慢）形态仍未真机验证，这条规矩不变。

## 三、审查发现

### 🔴 Blocker 1：`unique_local_visual` 放行不核验身份值，兜底核验强度不足

- 证据：resolver 新逻辑"本地唯一带标签候选即放行"（commit diff :350-355）；自检用例明确演示：目标 `cb1668`、OCR 读出"微信号：CB1669" → 期望 `selected`（"one local result stays clickable when OCR misreads its WeChat ID"）。
- 兜底：`state_machine.cjs:473` 会话核验 = `conversationTitle.includes(customerName)`。
- 漏洞组合：①点错的人恰好同名 → includes 通过 → **发错人**；②customerName 短（"王"）、为空、或列表里重名 → includes 弱匹配 → **发错人**；③3583 人规模下，1% 的放行错误 = 35 个发错人。
- 修复方向（不推翻放宽，加配套）：
  1. 凡 relaxed 模式放行（`unique_local_visual` / `unique_local_surface_visual`），在任务状态写 `identity_relaxed=true` + 分支 ID；
  2. 带 `identity_relaxed` 的会话核验升级为**强比对**（标题完全等于 expectedName，或比对会话资料区微信号，而不是 includes）；
  3. expectedName 为空/长度<2 时，relaxed 放行直接禁用（回退 unverified）。

### 🔴 Blocker 2：`copy_probe` 阶段外部输入改为自动恢复，需确认上限与落点

- 证据：commit diff `touch-task-ipc.cjs:154-159` 删除 `phase==="pre_input"` 限制；自检演示第一次 `copy_probe` 失败后第二次直接 `sent_verified`。
- 原设计是"草稿被碰过 → fail-closed"，现在等于"用户在用电脑也等一会再抢"。
- 必须确认（diff 中看不到，在 `waitForPreDraftInputRecovery`）：①重试次数硬上限存在；②上限用尽后落点仍是 needs_attention / outcome_unknown，不会无限等；③恢复重试前重新核对窗口身份与输入时钟（防等待期间会话被用户切换）。三项缺一即为真 Blocker。

### 🟡 1：`wechat_target_changed` 同进程弹窗放行

- 微信同进程弹窗（确认框/小程序/网页）盖住搜索结果时点击会落在弹窗上；后续虽有会话核验，但可能先触发弹窗上的意外动作。建议放行后加一道"落点是会话页而非弹窗页"的校验。

### 🟡 2：放宽后必须补"放行审计"，否则日志体系出现新盲区

- 失败少了 → 日志少了 → 一旦放行是错的（发错人），日志里**什么都没有**，任务显示成功。relaxed 放行必须记账（分支 ID+候选结构统计，不含文字），这与下方日志方案是同一个工程。

### 💭 1：`4c35ab7` 的 `source.includes(candidate)`（ai-draft.cjs:51）比原来的分词包含宽松，称呼来源已被 `["remark","nickname","name"]` 限定，风险低；留意"张伟"匹配到"张伟明"类前缀误用，建议加边界（前后非汉字）。

## 四、异机日志精准定位方案（对用户诉求的回答）

**你的方案方向完全正确，这正是打破"猜想→验证→返工"循环的唯一出路。** 落地设计（五层，前四层不含隐私、可进现有白名单）：

| 层 | 内容 | 解决什么 |
|---|---|---|
| L1 分支 ID | resolver 15 条 return、state_machine 各 block 点全部编唯一 ID（R07/S12…），失败码变成 `identity_unverified@R07` | 现在 15 条拒绝路径共用 1 个错误码——"模糊"的根源 |
| L2 决策结构指纹 | 失败时带：候选数量、几何分布（几行几列）、OCR 行数与文本长度、webSearchTop 位置——全是数字，无文字 | 开发方不看现场也知道"当时屏幕上是什么结构" |
| L3 放行审计 | relaxed 放行强制记录分支 ID+结构指纹+`identity_relaxed` | 防"发错人无声无息"（本轮改动逼出来的新需求） |
| L4 用户授权快照 | 失败瞬间本地保存打码截图+OCR 原文+几何 JSON，用户一键导出（授权模型与吐槽中心一致：用户显式动作） | 需要真实现场时，用户主动递给你，不碰白名单 |
| L5 症状对账表 | 每版本结构化记录"修了哪个分支 ID"；反馈带版本+分支 ID 自动判断"旧分支没修好 vs 新形态" | 终结"异机验证又冒新 bug、分不清新旧" |

- 工作量：L1+L2 约 1-2 天（机械改动），L3 与 Blocker 1 修复同批做，L4 半天（复用截图管线），L5 是流程纪律零代码。
- 与现有吐槽中心的关系：L1-L3 走现有白名单自动上报；L4 是用户显式导出，不与白名单冲突。
- 验收标准（一句话）：**异机任何一次失败，开发方只凭日志就能说出"哪条规则、因为屏幕上什么结构、拒绝了什么"，不需要再问用户"你当时看到啥"。**

## 五、下一步建议（排序）

1. Blocker 2 的三项确认（半小时，读 `waitForPreDraftInputRecovery`）——不过先不改代码；
2. Blocker 1 的 `identity_relaxed` 强比对 + L3 放行审计（同一批改）；
3. L1 分支 ID + L2 结构指纹（独立小步，先落地最快见效）；
4. 故障机验收 1.1.30 时，用 L1/L2 的日志验证一次"只凭日志定位"是否成立。
