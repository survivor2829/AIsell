const assert = require("node:assert/strict");
const { unclassifiedAddedReasons } = require("./wechat-failure-policy-review.cjs");
const { classifyWechatFailureReason } = require("../src/shared/wechat-failure-policy.cjs");

assert.deepEqual(unclassifiedAddedReasons('+ return { blocked_reason: "outcome_unknown" };'), []);
assert.deepEqual(unclassifiedAddedReasons('+ return { reasonCode: "brand_new_unclassified_reason" };'), ["brand_new_unclassified_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ Write-XiaoxiFailure "rule-r001" "another_new_reason"'), ["another_new_reason"]);

for (const [reason, classification, attentionScope] of [
  ["retry_skipped_selection_invalid", "recoverable", "task"],
  ["retry_skipped_task_mismatch", "recoverable", "task"],
  ["retry_skipped_sent_verified_forbidden", "blocker", "task"],
  ["workflow_paused", "environment", "task"],
  ["contact_snapshot_changed", "blocker", "task"],
  ["touch_sequence_changed", "blocker", "task"],
  ["touch_image_unavailable", "recoverable", "task"],
  ["task_passport_screenshot_failed", "recoverable", "task"],
  ["touch_part_exception", "blocker", "global"],
  ["touch_part_outcome_unknown", "blocker", "global"],
  ["moments_workflow_failed", "blocker", "global"]
]) {
  assert.deepEqual(classifyWechatFailureReason(reason), { reasonCode: reason, classification, attentionScope, known: true });
}
console.log("WeChat failure policy review gate self-check passed");
