const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const driverPath = path.join(__dirname, "moments_action_driver.dev.cjs");
const calls = [];
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./wechat_window_driver.cjs" && path.resolve(parent?.filename || "") === path.resolve(driverPath)) {
    return {
      runPowerShell: (_script, env, options) => {
        calls.push({ env, options });
        return {
          ok: true,
          status: "comment_draft_verified",
          actionAttempted: false,
          commentStatus: "draft_verified",
          verificationMode: "targeted_uia_value_roundtrip_and_unique_enabled_button_transition"
        };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[require.resolve(driverPath)];
let driver;
try {
  driver = require(driverPath);
} finally {
  Module._load = originalLoad;
}

const observationId = "a".repeat(64);
const commentText = "只读草稿往返检查0717";
const result = driver.inspectCommentDraft({
  observationId,
  commentText,
  expectedWindow: {},
  postSnapshot: {}
});

assert.equal(result.ok, true);
assert.equal(result.observationId, observationId);
assert.equal(result.commentText, commentText);
assert.equal(calls.length, 1);
assert.equal(calls[0].env.XIAOXI_MOMENTS_ACTION, "comment_check");
assert.equal(Buffer.from(calls[0].env.XIAOXI_MOMENTS_COMMENT_BASE64, "base64").toString("utf8"), commentText);
assert.deepEqual(calls[0].options, { ensure: false, sta: true });

assert.equal(driver.inspectCommentDraft({ observationId, commentText: "" }).reason, "moments_comment_missing");
assert.equal(driver.inspectCommentDraft({ observationId, commentText: "x".repeat(501) }).reason, "moments_comment_missing");
assert.equal(calls.length, 1, "invalid comment text must not start PowerShell");

delete require.cache[require.resolve(driverPath)];
console.log("moments UIA action driver self-check passed");
