const catalog = require("./wechat-rule-catalog.json");

const FAILURE_CLASSIFICATIONS = Object.freeze(["environment", "recoverable", "blocker"]);

const workflowPolicies = Object.freeze({
  touch_task_payload_incomplete: { classification: "blocker", attentionScope: "task" },
  moments_no_new_posts: { classification: "recoverable", attentionScope: "task" },
  moments_interaction_incomplete: { classification: "recoverable", attentionScope: "task" },
  moments_publish_pre_action_failed: { classification: "recoverable", attentionScope: "task" },
  moments_publish_outcome_unknown_requires_resolution: { classification: "blocker", attentionScope: "global" },
  moments_workflow_config_invalid: { classification: "blocker", attentionScope: "task" },
  workflow_occurrence_date_invalid: { classification: "blocker", attentionScope: "task" },
  workflow_executor_unavailable: { classification: "blocker", attentionScope: "task" },
  touch_draft_generation_failed: { classification: "recoverable", attentionScope: "task" },
  moments_interaction_outcome_unknown: { classification: "blocker", attentionScope: "global" },
  outcome_unknown: { classification: "blocker", attentionScope: "global" },
  contact_identity_ambiguous: { classification: "blocker", attentionScope: "global" },
  ai_expert_not_ready: { classification: "blocker", attentionScope: "global" },
  account_mismatch: { classification: "environment", attentionScope: "global" },
  contact_sync_running: { classification: "environment", attentionScope: "global" },
  no_pending_work: { classification: "recoverable", attentionScope: "global" },
  executor_unavailable: { classification: "blocker", attentionScope: "global" },
  task_payload_missing: { classification: "blocker", attentionScope: "global" },
  invalid_task_result: { classification: "blocker", attentionScope: "global" },
  workflow_data_invalid: { classification: "blocker", attentionScope: "global" },
  application_disposing: { classification: "environment", attentionScope: "global" },
  wechat_operation_busy: { classification: "environment", attentionScope: "global" },
  touch_safety_interval: { classification: "environment", attentionScope: "global" },
  retry_skipped_task_running: { classification: "environment", attentionScope: "task" },
  retry_skipped_already_pending: { classification: "environment", attentionScope: "task" },
  retry_skipped_pause_timeout: { classification: "environment", attentionScope: "task" },
  retry_skipped_empty: { classification: "recoverable", attentionScope: "task" },
  retry_skipped_outcome_unknown_forbidden: { classification: "blocker", attentionScope: "task" },
  retry_skipped_status_forbidden: { classification: "blocker", attentionScope: "global" },
  retry_skipped_poisoned_forbidden: { classification: "blocker", attentionScope: "task" },
  image_send_pre_click_timeout: { classification: "recoverable", attentionScope: "task" },
  wechat_id_name_conflict: { classification: "blocker", attentionScope: "task" },
  wechat_id_no_result: { classification: "recoverable", attentionScope: "task" },
  wechat_id_invalid_placeholder: { classification: "recoverable", attentionScope: "task" }
});

const reasonPolicies = new Map(Object.entries(workflowPolicies));
const rulePolicies = new Map();
for (const row of catalog) {
  if (!FAILURE_CLASSIFICATIONS.includes(row.classification)) {
    throw new Error(`Unclassified WeChat rule: ${row.id}`);
  }
  const existing = reasonPolicies.get(row.reason);
  if (existing && existing.classification !== row.classification) {
    throw new Error(`Conflicting WeChat failure classification: ${row.reason}`);
  }
  if (!existing) reasonPolicies.set(row.reason, { classification: row.classification, attentionScope: "global" });
  rulePolicies.set(row.id, { reason: row.reason, classification: row.classification });
}

function normalizeFailureReasonCode(value) {
  const reason = String(value || "");
  return /^[a-z][a-z0-9_]{1,79}$/u.test(reason) ? reason : "invalid_unclassified_reason";
}

function classifyWechatFailureReason(reasonCode) {
  const reason = normalizeFailureReasonCode(reasonCode || "task_attention_reason_missing");
  if (/^message_input_failed_wechat_user_active(?:_attempts_[1-9]\d*)?$/u.test(reason)) {
    return { reasonCode: reason, classification: "environment", attentionScope: "global", known: true };
  }
  const policy = reasonPolicies.get(reason);
  return policy
    ? { reasonCode: reason, ...policy, known: true }
    : { reasonCode: reason, classification: "blocker", attentionScope: "global", known: false };
}

function classifyWechatFailure(result) {
  if (typeof result === "string") return classifyWechatFailureReason(result);
  const reasonCode = String(result?.blocked_reason || result?.reason || result?.state?.blocked_reason || "task_attention_reason_missing");
  const ruleId = String(result?.rule_id || result?.ruleId || result?.state?.rule_id || "");
  const policy = classifyWechatFailureReason(reasonCode);
  const rule = rulePolicies.get(ruleId);
  return { ...policy, ruleId, ruleMatchesReason: Boolean(rule && rule.reason === policy.reasonCode) };
}

module.exports = { FAILURE_CLASSIFICATIONS, workflowPolicies, classifyWechatFailure, classifyWechatFailureReason, normalizeFailureReasonCode };
