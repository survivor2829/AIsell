---
title: G2 设计提案：wechatId 优先搜索与授权证据观测
date: 2026-09-17
status: 待评审
version_target: 1.1.48
scope: G2
excluded: G3 拦截单独归类
---

# G2 设计提案：wechatId 优先搜索与授权证据观测

## 目标与边界

G2 的目标是降低按名字搜索造成的身份证据不足跳过率，并补齐成功/失败两侧的 resolver 观测，使后续判断有可复核证据。G2 只涉及搜索词选择、现有解析器的证据记录、快照兼容和定向验证；不改变 G3 的网络查找拦截、规则归类或其独立版本。

## ① 搜索词优先级与降级链路

### 选择顺序

1. `contact.wechatId` 非空时，首选原始 `wechatId` 作为 `search_query`。
2. `wechatId` 为空、格式不可信或该词搜索明确无结果时，降级为现有名字搜索词（`remark || nickname || name`），并记录降级原因。
3. 名字搜索仍沿用现有候选解析和 fail-closed 授权门禁；无法形成硬证据时不点击、不发送。

“格式不可信”只指已知非法空白/占位值等确定情形，不通过猜测把一个看似合法的微信号改写成别的值。搜索失败的判定必须来自搜索阶段的明确无结果状态；超时、窗口丢失、网络查找误点等不自动等同于“搜不到”，应保留原失败语义并停止在当前门禁。

### 与 `exact_wechat_id_visual` 的衔接

- 首选 `wechatId` 搜索后，优先复用现有 `exact_wechat_id_visual`（以及其已有的本地 UIA 等等价精确证据）授权路径。
- 该路径必须同时满足：候选视觉区域唯一、OCR/文本中的微信号与目标值精确匹配、候选未落入网络查找行；任一条件缺失即 fail-closed。
- `wechatId` 搜索得到多个候选时，不以位置、头像或模糊名称自行择一；只有现有精确授权规则能唯一证明目标时才允许进入后续点击分支。
- 降级到名字搜索后，不得把名字匹配提升为 `exact_wechat_id_visual`；仍按现有名字候选的本地证据等级执行。

### `snapshot_hash` 与续跑兼容

`search_query` 从名字变为优先 `wechatId` 会改变搜索输入快照，因此同一联系人在新版本中可能产生不同 `snapshot_hash`。设计上：

- 快照内容继续包含规范化后的 `search_query`、查询类型、候选摘要和授权结果；哈希算法与字段顺序保持不变。
- 续跑不能把旧版本“按名字搜索”的成功快照当作新版本 `wechatId` 搜索已验证结果。查询词、查询类型或解析版本任一变化即视为快照不兼容，重新执行搜索和授权。
- 对仍在运行的旧任务，保留旧账本记录和已确认发送状态；升级后从未完成联系人重新搜索，不回退或覆盖历史 `sent_verified`。
- 新任务/续跑日志记录 `search_query_type`（`wechat_id`/`name_fallback`）、`fallback_reason` 和 `resolver_version`，便于区分“输入变化”与“授权失败”。

## ② 成功/失败两侧的 resolver 观测

### 统一记录字段

在搜索解析完成、任何授权点击之前，写入一条脱敏证据摘要；成功与失败都必须写入：

- `resolver_mode`：实际采用的授权分支，例如 `exact_wechat_id_visual`、`unique_local_uia`、`unique_local_visual`、`unique_local_surface_visual`、`identity_unverified`。
- `search_query_type`：`wechat_id` 或 `name_fallback`。
- `fallback_reason`：未降级时为空；降级仅使用受控枚举（`wechat_id_empty`、`wechat_id_no_result`、`wechat_id_invalid_placeholder`）。
- `candidate_count`、`visual_candidate_count`、`ocr_ok`、`network_lookup_isolated`。
- `authorization_decision`：`authorized` / `denied`。
- `rule_id`、`resolver_version`。
- `evidence_summary`：仅保存脱敏后的字段存在性、长度、哈希前缀、匹配布尔值和候选区域摘要，不保存微信号原文、完整 OCR 文本或截图内容。

成功记录还要关联后续 `sent_verified` 的 `trace_id`；失败记录要保留 `send_attempted=false`、`send_clicked=false` 和最终 `reason_code`。这样可以验证“哪条 resolver 通过”与“哪条门禁拒绝”，而不扩大敏感数据落盘范围。

### 可审计性要求

- 摘要必须在点击前落盘，避免点击失败后丢失授权判断。
- 成功与失败使用同一字段集合，禁止只记录成功路径。
- `resolver_mode` 是受控枚举；新增分支必须同时更新枚举、脱敏摘要和分类表，否则评审不通过。
- G3 的 `wechat_search_network_lookup_misclick` 仍保持独立 reason/rule，不在 G2 合并。

## ③ 验证计划

### 本机 harness

增加针对搜索词选择与观测字段的合成用例：

1. 有效 `wechatId`：断言 `search_query_type=wechat_id`，命中 `exact_wechat_id_visual` 时授权，且成功日志含 resolver 摘要。
2. `wechatId` 为空：断言降级为名字，记录 `wechatId_empty`，名字证据不足时 fail-closed。
3. `wechatId` 明确无结果：断言只在“无结果”状态降级；超时/网络查找不误判为无结果。
4. 多候选或网络查找行混入：断言无唯一硬证据时不发生点击，失败日志含 `authorization_decision=denied`。
5. 续跑快照：旧名字快照与新 wechatId 查询类型不兼容并重新解析；历史 `sent_verified` 不重复发送。

### 客户机小批量对比

在客户机先选 30–50 名联系人，保留同一任务的旧基线字段，再运行 1.1.48 候选：

- 分层包含：有效 wechatId、wechatId 为空/异常、历史成功、历史 R014 失败；不主动扩大联系人或发送内容范围。
- 对比指标：总人数、`search_query_type` 分布、`resolver_mode` 分布、`search_result_identity_unverified` 跳过率、网络查找误点数、`sent_verified` 成功率、未知/缺失观测字段数。
- 主要验收门槛：R014 跳过率相对基线下降；所有允许发送的联系人仍有成功 resolver 摘要；正常联系人全流程不受影响；网络查找拦截仍单独计数。
- 若成功率或跳过率变化无法由 resolver 观测解释，暂停扩大范围，不进入 G3 或其他档位。

## 版本与实施边界

- 通过评审后，以 1.1.48 独立版本、独立提交实施。
- 仅修改搜索解析、证据摘要/诊断落盘、快照兼容处理及定向回归；不修改 G3 拦截归类。
- 本提案阶段不改代码、不运行验收、不生成安装包。

