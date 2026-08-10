const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "MomentsPublishPanel.tsx"), "utf8");

assert.match(source, /data-xiaoxi-moments-publish-choose/u);
assert.match(source, /data-xiaoxi-moments-publish-prepare/u);
assert.match(source, /data-xiaoxi-moments-publish-confirm/u);
assert.match(source, /第一步：生成发布确认/u);
assert.match(source, /第二步：最终发布确认/u);
assert.match(source, /只有点击“确认发表”才会操作微信/u);
assert.match(source, /公开发布到朋友圈/u);
assert.match(source, /state\.fingerprint\.slice\(0, 12\)/u);
assert.match(source, /file\.name/u);
assert.match(source, /formatBytes\(file\.size\)/u);
assert.match(source, /moments_publish_file_name_field_missing/u);
assert.match(source, /moments_publish_file_name_readback_mismatch/u);
assert.match(source, /moments_publish_file_name_focus_failed/u);
assert.match(source, /moments_publish_file_dialog_did_not_close/u);

assert.match(source, /const unsubscribe = api\.onUpdate/u);
assert.match(source, /liveStateSeen = true/u);
assert.match(source, /if \(disposed \|\| liveStateSeen \|\| !result\?\.state\) return/u);
assert.ok(
  source.indexOf("const unsubscribe = api.onUpdate") < source.indexOf("void api.status()"),
  "the live subscription must be installed before requesting the initial snapshot"
);

assert.match(source, /api\.prepare\(\{ content: normalizedContent, selectionId: selection\.selection_id \}\)/u);
assert.match(source, /const \[localConfirmationId, setLocalConfirmationId\] = useState\(""\)/u);
assert.match(
  source,
  /const prepared = Boolean\(localConfirmationId\)[\s\S]*state\.draft_id === localConfirmationId/u,
  "only a confirmation created by the current panel mount may become publishable"
);
assert.match(
  source,
  /if \(isPreparedState\(result\.state\)\)[\s\S]*api\.reset\(\)/u,
  "a prepared draft discovered during initial hydration must be reset instead of re-enabled"
);
assert.match(source, /api\.confirm\(\{ draftId: localConfirmationId \}\)/u);
assert.doesNotMatch(source, /api\.confirm\(\{ draftId: state\.draft_id \}\)/u);
assert.equal((source.match(/api\.confirm\(/gu) || []).length, 1, "confirm must only run from the explicit final action");

assert.match(source, /data-xiaoxi-moments-publish-resolve-published/u);
assert.match(source, /data-xiaoxi-moments-publish-resolve-not-published/u);
assert.match(source, /resolveUnknown\("published"\)/u);
assert.match(source, /resolveUnknown\("not_published"\)/u);
assert.match(source, /系统已锁定这次尝试，不会自动补发，也不提供直接重发/u);
assert.match(source, /系统不会直接补发；如需发布，请重新创建/u);
assert.doesNotMatch(source, /setTimeout/u);

assert.doesNotMatch(source, /\bpaths?\b/iu);
assert.doesNotMatch(source, /absolute/iu);

console.log("Moments publish panel self-check passed");
