# 任务护照原因码登记

本登记只描述取证字段，不改变任何匹配、跳过、重试、发送或调度判定。

权威机器可读枚举为 `desktop/src/main/task-passport-reason-catalog.cjs`，分为 `active_touch`、`moments`、`auto_reply` 三张表，每项固定包含：

- `code`：写入护照 `result_code` 的具体代码；存在底层规则号时优先使用 `rule_id`（例如 `search-r014`）。
- `meaning`：代码含义。
- `stage`：发生阶段。

主动触达和朋友圈底层规则由现有 `wechat-rule-catalog.json` 全量派生，因此新增 `search-r00N`、`image-r00N`、`wx1-r00N` 至 `wx5-r00N` 时不会再维护第二份易漂移的抄本。自动回复决策码由 `auto-reply-decision.cjs` 的 `ACTION_REASON_CODES` 派生；发送与协调失败另登记受控运行码。

护照同时保存三个字段：

- `reason_code`：业务语义原因，如 `search_result_identity_unverified`。
- `rule_id`：命中判定规则，如 `search-r014`。
- `result_code`：账单归类键；有 `rule_id` 时取规则号，否则取业务原因码。

任何失败分支没有上报原因时，不写 `unknown`，而写对应模块的显式缺失码：`task_failure_reason_missing`、`touch_workflow_failure_reason_missing`、`moments_failure_reason_missing` 或 `auto_reply_failure_reason_missing`。这些码的出现本身就是可检索的观测缺口，不能被当作业务分类或自动重试许可。
