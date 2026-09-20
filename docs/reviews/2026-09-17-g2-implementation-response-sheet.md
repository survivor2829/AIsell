# G2 实施回应单（1.1.48 前）

状态：待实施确认。本文只回答评审补充问题，不包含代码变更。

## ① 错号风险与 wechatId 权威性

当前 `wechatId` 的直接来源是 `wechat-silent-sync` 从当前登录微信账号的本地通讯录数据库读取并规范化的 `alias/wechat_id/wechatId` 字段。它是“该账号本地同步快照”的权威来源，但不是独立的外部真值：数据库可能过期、字段错配或被人工/历史数据污染。因此不能仅凭“有一个有效 wechatId”放行发送。

G2 增加辅助校验：

- `wechatId` 搜索命中后，候选展示名/昵称/备注若可读，必须与联系人名满足“非矛盾”校验；明确指向另一真人、明显冲突或出现多个同等候选时，拒绝授权并 fail-closed。
- 展示名缺失时，不用模糊相似度补证；除非已有现成的精确本地证据同时证明 ID 唯一且候选未落入网络查找行，否则拒绝授权。
- 一旦有效 `wechatId` 命中但辅助校验冲突，不降级为名字搜索自动发送；记录 `wechat_id_name_conflict`，交由人工处理，避免把潜在错号转换成另一种误发路径。
- 通过同步快照中的唯一性、账号归属和候选展示名非矛盾校验后，才进入 `exact_wechat_id_visual` 或等价精确授权分支。

## ② `wxid_` 内部 ID

`wxid_` 开头值视为微信内部 opaque ID，不假设微信搜索框一定支持按此值检索。行为规定如下：

- 先尝试 `wechatId` 搜索；若搜索明确返回“无结果”，才降级到名字搜索，并记录 `wechat_id_no_result`。
- 若只是超时、窗口异常、网络查找行出现或结果状态不确定，不得把它当作无结果，不触发降级，继续沿原 fail-closed 语义暂停。
- 名字降级后仍必须通过现有本地候选授权门禁；不能因为 `wxid_` 看起来像内部 ID 就放宽名字匹配。

## ③ 客户机小批量验收数字

从历史 R014 失败联系人中分层抽取 30–50 人，另保留同批历史成功/正常联系人作为对照。1.1.48 验收门槛：

1. 历史 R014 分层的 `search_result_identity_unverified` 跳过率 **≤ 20%**（基线 100%，即 127/127）。
2. 该分层 `sent_verified` **≥ 70%**；任何未达到者不得扩大批量。
3. 对照联系人 `sent_verified` 数量不得低于同一批次的历史结果，且不得出现新增误点网络查找行。
4. 所有成功与失败记录均必须有 `resolver_mode`、`search_query_type` 和脱敏证据摘要；字段缺失率为 0。

若样本实际可发送量因账号状态或客户侧限制少于 30 人，则按实际可执行人数记录原因，不用降门槛冒充通过；需补足样本后再判定。

## 实施边界

## 失败分级表登记证据

本次新增的三个 reason 已同步登记，避免再次出现 1.1.46 `image-r010` 漏登记导致全局停机：

| reason | rule_id | 分级 | 登记位置 |
|---|---|---|---|
| `wechat_id_name_conflict` | `search-r016` | blocker | `desktop/src/shared/wechat-rule-catalog.json`、`desktop/src/shared/wechat-failure-policy.cjs` |
| `wechat_id_no_result` | `search-r017` | recoverable | `desktop/src/shared/wechat-rule-catalog.json`、`desktop/src/shared/wechat-failure-policy.cjs` |
| `wechat_id_invalid_placeholder` | `search-r018` | recoverable | `desktop/src/shared/wechat-rule-catalog.json`、`desktop/src/shared/wechat-failure-policy.cjs` |

分级表加载时会校验每条 catalog 记录的 classification；`wechat-failure-policy.cjs` 同时把三个 reason 纳入受控策略，未登记或冲突会在启动自检阶段失败。

- 三条结论确认后，才实施 1.1.48，独立提交、独立版本公告。
- 本次不实现 G3 的网络查找拦截归类，不修改其 rule/reason 语义。
- 通过本机 harness 与客户机小批量门槛后，才进入后续发布验收。
