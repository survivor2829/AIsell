# 图片发送卡点定性（2026-09-16 上午客户机 1.1.43 实测）

> 审查方：WorkBuddy · 只读分析
> 证据：诊断包 `AI获客 V1.0版本-诊断日志-2026-09-16T02-53-23-019Z(1).zip` + 客户截图
> 客户版本：**1.1.43**（buildId 20260916T0216Z，commit 1d4e475，sourceDirty=false）

## 1. 顺带确认：hotfix 生效

本次会话中搜索链路各阶段（click-search-result-dry-run / verify_session）全部干净通过，**没有发生"网络查找微信号"误点**。1.1.43 的搜索修复在客户机真实环境下工作正常（huatengcangku 专项测试仍建议补一次，但本包已是有效的正面证据）。

## 2. 图片卡点——这次定位到了（置信度：高）

时间线（第二位联系人）：

```
02:52:30.053  image_send 阶段启动
02:53:00.159  powershell_timeout（耗时恰好 30.1 秒）
              clipOp = draft_sentinel_write   ← 死在第一步剪贴板操作
02:53:00.168  workflow_contact_send.failed (powershell_timeout)
02:53:00.177  task.global_stop (outcome_unknown)  ← 按设计暂停等人工确认
```

三个定性结论：

1. **死因是图片脚本的单次 30 秒硬超时**，且死在 **draft_sentinel_write（写剪贴板哨兵文本）——发图片流程的第一个剪贴板动作，发生在加载/粘贴图片、点击发送之前**。
2. 30 秒内没完成第一步，说明脚本头部开销（PowerShell 启动 + Add-Type 编译 + 可能的图片位图加载）或剪贴板 COM 争用重试在客户机上已经吃满预算——**这不是"发送结果不明"，而是"还没走到发送"**。
3. 任务随后按 outcome_unknown 全局暂停——**安全上没错**（结果确实不明），但**保守过头了**：脚本记录的最后操作是哨兵写入（点击发送之前），足以判定"明确未发送"，本应有界重试/跳过而不是停下等人工。

## 3. 修复指令（给 Codex，即第二档图片项，按此实施）

### I1：图片脚本分阶段预算 + 进度标记（根修）

- 把 `wechat_image_send` 脚本拆为独立阶段：`sentinel_write → image_load → clipboard_bitmap → paste → read_back → click_send → post_confirm`，每阶段独立超时预算（建议：sentinel_write 15s、image_load 60s、clipboard_bitmap 45s、paste 30s、read_back 20s、click_send 30s、post_confirm 30s），总预算上限 180s。
- **每完成一个阶段立即向 stdout/进度文件落一个标记**（阶段名 + 时间戳 + 剪贴板序列号）。超时发生时，编排层按"最后完成的标记"归因。

### I2：超时按"最后标记"定性（止血）

- 超时时最后标记 ≤ `paste` 之前（含 draft_sentinel_write）→ 判定 `send_attempted=false` → 走"明确未发送"路径：有界重试 1–2 次 → 跳过进未触达名单。**不再 outcome_unknown、不再全局暂停。**
- 最后标记 ≥ `click_send` 或无任何标记 → 保持 outcome_unknown（fail-closed 不变）。
- 此规则写进 wechat-failure-policy 分级表并同步归类，过自检门禁。

### I3：查一下哨兵写入为何吃满 30 秒

- 在 I1 的分阶段计时基础上，确认 30 秒到底花在哪：若 image_load/bitmap 在 sentinel_write 之前执行且耗时过长，调整执行顺序（先哨兵后加载）；
- 核对剪贴板 COM 忙碌重试（0x800401D0 重试 5 次）的总耗时是否计入该阶段预算，重试期间应留有日志轨迹。

### 约束

- 独立提交、独立版本（建议 1.1.44）、独立公告；不夹带认人强比对或其他第二档项。
- 完成后自检需含合成用例：模拟"sentinel_write 后超时"断言走重试/跳过路径；模拟"click_send 后超时"断言保持 outcome_unknown。
- 客户机验收：重跑本次失败场景（同一联系人、同一图片），确认要么成功、要么自动跳过继续下一位，全程无人工干预、无全局暂停。

## 4. 给用户的一句话

这次不是"又一个新 bug"，是早已在账本上的"30 秒硬超时"问题被 1.1.43 的精细日志抓了现行——修法明确（拆阶段 + 按标记定性），一轮可完成。
