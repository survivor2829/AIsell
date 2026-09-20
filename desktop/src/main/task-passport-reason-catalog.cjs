const wechatRules = require("../shared/wechat-rule-catalog.json");
const { ACTION_REASON_CODES } = require("./auto-reply-decision.cjs");

function ruleStage(rule) {
  if (rule.id.startsWith("search-")) return "contact_search";
  if (rule.id.startsWith("image") || rule.id.startsWith("draft-")) return "message_send";
  if (rule.id.startsWith("wx1-") || rule.id.startsWith("wx2-")) return "wechat_window";
  if (rule.id.startsWith("wx3-")) return "moments_navigation";
  if (rule.id.startsWith("wx4-")) return "moments_publish";
  if (rule.id.startsWith("wx5-")) return "moments_interaction";
  return "runtime";
}

function entry(code, meaning, stage) {
  return Object.freeze({ code, meaning, stage });
}

const rpaEntries = wechatRules.map((rule) => entry(rule.id, rule.reason, ruleStage(rule)));
const activeTouch = rpaEntries.filter((item) => !item.code.startsWith("wx3-") && !item.code.startsWith("wx4-") && !item.code.startsWith("wx5-"));
const moments = rpaEntries.filter((item) => item.code.startsWith("wx3-") || item.code.startsWith("wx4-") || item.code.startsWith("wx5-"));

for (const item of [
  entry("task_failure_reason_missing", "失败分支没有上报受控原因码", "task_transition"),
  entry("touch_workflow_failure_reason_missing", "统一触达工作流没有上报受控原因码", "workflow_step"),
  entry("outcome_unknown", "发送动作可能已发生但结果无法确认", "send_verification")
]) activeTouch.push(item);

for (const item of [
  entry("moments_action_missing", "朋友圈任务没有可执行动作", "workflow_prepare"),
  entry("moments_comment_ai_unavailable", "评论生成能力不可用", "workflow_prepare"),
  entry("moments_campaign_state_persist_failed", "朋友圈任务状态无法持久化", "workflow_prepare"),
  entry("moments_workflow_config_invalid", "朋友圈任务配置无效", "workflow_prepare"),
  entry("workflow_occurrence_date_invalid", "计划执行日期无效", "workflow_prepare"),
  entry("moments_interaction_outcome_unknown", "朋友圈动作结果无法确认", "interaction_verify"),
  entry("moments_interaction_incomplete", "朋友圈任务未完成", "workflow_finish"),
  entry("moments_workflow_failed", "朋友圈统一工作流失败", "workflow_finish"),
  entry("moments_failure_reason_missing", "朋友圈失败分支没有上报受控原因码", "runtime")
]) moments.push(item);

const autoReply = [];
for (const [action, codes] of Object.entries(ACTION_REASON_CODES)) {
  for (const code of codes) autoReply.push(entry(code, `自动回复决策：${action}`, "reply_decision"));
}
for (const item of [
  entry("conversation_not_eligible", "当前会话不在允许回复范围", "candidate_filter"),
  entry("wechat_operation_busy", "微信操作协调器正被其他业务占用", "coordination"),
  entry("send_not_attempted", "发送动作尚未发生", "send"),
  entry("sent_verified", "发送完成且新消息已核验", "send_verification"),
  entry("outcome_unknown", "发送动作可能已发生但结果无法确认", "send_verification"),
  entry("send_outcome_unknown", "自动回复发送结果无法确认", "send_verification"),
  entry("auto_reply_failure_reason_missing", "自动回复失败分支没有上报受控原因码", "runtime")
]) autoReply.push(item);

const TASK_PASSPORT_REASON_CATALOGS = Object.freeze({
  active_touch: Object.freeze(activeTouch),
  moments: Object.freeze(moments),
  auto_reply: Object.freeze(autoReply)
});

module.exports = { TASK_PASSPORT_REASON_CATALOGS };
