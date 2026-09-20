const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitDiff, unclassifiedAddedReasons } = require("./wechat-failure-policy-review.cjs");
const { classifyWechatFailureReason } = require("../src/shared/wechat-failure-policy.cjs");

assert.deepEqual(unclassifiedAddedReasons('+ return { blocked_reason: "outcome_unknown" };'), []);
assert.deepEqual(unclassifiedAddedReasons('+ return { reasonCode: "brand_new_unclassified_reason" };'), ["brand_new_unclassified_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ return { reason: "brand_new_reason_field" };'), ["brand_new_reason_field"]);
assert.deepEqual(unclassifiedAddedReasons('+ return failure("brand_new_failure_helper");'), ["brand_new_failure_helper"]);
assert.deepEqual(unclassifiedAddedReasons('+ return response("needs_attention", "brand_new_response_helper");'), ["brand_new_response_helper"]);
assert.deepEqual(unclassifiedAddedReasons('+ return result("blocked", "brand_new_result_helper");'), ["brand_new_result_helper"]);
assert.deepEqual(unclassifiedAddedReasons('+ return result("needs_attention", safeReason(error?.code, "brand_new_safe_reason"));'), ["brand_new_safe_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ return attention("blocked", null, "brand_new_attention_reason");'), ["brand_new_attention_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ Write-XiaoxiFailure "rule-r001" "another_new_reason"'), ["another_new_reason"]);
assert.deepEqual(unclassifiedAddedReasons('+ log("reply.activated", { reason: "finite_tasks_drained" });'), []);
assert.deepEqual(unclassifiedAddedReasons('+ return { reason: "invalid_unclassified_reason" };'), []);

for (const [reason, classification, attentionScope] of [
  ["retry_skipped_selection_invalid", "recoverable", "task"],
  ["retry_skipped_task_mismatch", "recoverable", "task"],
  ["retry_skipped_sent_verified_forbidden", "blocker", "task"],
  ["workflow_paused", "environment", "task"],
  ["contact_snapshot_changed", "blocker", "task"],
  ["batch_authorization_missing", "blocker", "task"],
  ["touch_sequence_changed", "blocker", "task"],
  ["touch_image_unavailable", "recoverable", "task"],
  ["task_passport_screenshot_failed", "recoverable", "task"],
  ["touch_part_exception", "blocker", "global"],
  ["touch_part_outcome_unknown", "blocker", "global"],
  ["moments_workflow_failed", "blocker", "global"],
  ["image_driver_exception", "blocker", "global"],
  ["image_driver_failed", "blocker", "global"],
  ["image_attempt_context_missing", "blocker", "task"],
  ["image_attempt_changed", "blocker", "global"],
  ["image_previous_outcome_unknown", "blocker", "global"],
  ["image_receipt_unavailable", "blocker", "global"],
  ["message_bubble_stale", "blocker", "global"],
  ["touch_image_changed", "blocker", "task"],
  ["moments_publish_snapshot_changed", "blocker", "task"],
  ["moments_comment_duplicate_visual_state_unknown", "blocker", "task"],
  ["moments_render_pane_ambiguous", "environment", "task"],
  ["moments_render_pane_not_found", "environment", "task"],
  ["moments_surface_read_failed", "environment", "task"],
  ["powershell_failed", "environment", "global"],
  ["powershell_output_invalid", "blocker", "global"],
  ["powershell_timeout", "environment", "global"],
  ["wechat_operation_failed", "blocker", "global"]
]) {
  assert.deepEqual(classifyWechatFailureReason(reason), { reasonCode: reason, classification, attentionScope, known: true });
}

const largeDiffRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-policy-large-diff-"));
try {
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: largeDiffRoot, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  };
  runGit(["init", "--quiet"]);
  const sourceDir = path.join(largeDiffRoot, "desktop", "src", "main");
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourceFile = path.join(sourceDir, "large-policy-fixture.cjs");
  fs.writeFileSync(sourceFile, "module.exports = {};\n", "utf8");
  runGit(["add", "."]);
  runGit(["-c", "user.name=Xiaoxi Self Check", "-c", "user.email=self-check@example.invalid", "commit", "--quiet", "-m", "base"]);
  fs.writeFileSync(sourceFile, `const payload = "${"x".repeat(1_100_000)}";\nreturn { reason: "large_diff_trailing_unclassified_reason" };\n`, "utf8");
  const largeDiff = gitDiff("HEAD", { cwd: largeDiffRoot });
  assert(largeDiff.length > 1024 * 1024, "fixture must exceed Node's default spawnSync buffer");
  assert.deepEqual(unclassifiedAddedReasons(largeDiff), ["large_diff_trailing_unclassified_reason"]);
  runGit(["add", "."]);
  runGit(["-c", "user.name=Xiaoxi Self Check", "-c", "user.email=self-check@example.invalid", "commit", "--quiet", "-m", "reason"]);
  fs.writeFileSync(path.join(largeDiffRoot, "README.md"), "unrelated final commit\n", "utf8");
  runGit(["add", "."]);
  runGit(["-c", "user.name=Xiaoxi Self Check", "-c", "user.email=self-check@example.invalid", "commit", "--quiet", "-m", "unrelated"]);
  const newBranchDiff = gitDiff("4b825dc642cb6eb9a060e54bf8d69288fbee4904", { cwd: largeDiffRoot });
  assert.deepEqual(unclassifiedAddedReasons(newBranchDiff), ["large_diff_trailing_unclassified_reason"],
    "a new branch push must inspect reasons from every commit, not only HEAD^");
} finally {
  fs.rmSync(largeDiffRoot, { recursive: true, force: true });
}
console.log("WeChat failure policy review gate self-check passed");
