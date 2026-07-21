const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "MomentsDryRunPanel.tsx"), "utf8");

assert.match(source, /const MOMENTS_DRY_RUN_UI_TIMEOUT_MS = 50_000;/u);
assert.match(source, /const MOMENTS_INSPECT_UI_TIMEOUT_MS = 110_000;/u);
assert.match(source, /moments_external_input_detected: "检测到其他鼠标或键盘输入，已停止且未发送；请暂时不要操作后重试。"/u);
assert.match(source, /let timedOut = false;[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*timedOut = true;/u);
assert.match(source, /setObservationId\(""\);[\s\S]*setMenuVerified\(false\);[\s\S]*setRequiresRestart\(true\);[\s\S]*setBusy\(false\);/u);
assert.ok((source.match(/if \(timedOut\) return;/gu) || []).length >= 2, "late dry-run resolve and reject paths must both be ignored");
assert.match(source, /window\.clearTimeout\(watchdog\);[\s\S]*if \(!timedOut\) setBusy\(false\);/u);
assert.match(source, /disabled=\{busy \|\| requiresRestart \|\|/u);
assert.match(source, /const inspectWatchdog = action === "inspect" \? window\.setTimeout/u);
assert.match(source, /inspectTimedOut = true;[\s\S]*setObservationId\(""\);[\s\S]*setMenuVerified\(false\);[\s\S]*setRequiresRestart\(true\);[\s\S]*setBusy\(false\);/u);
assert.ok((source.match(/if \(inspectTimedOut\) return;/gu) || []).length >= 2, "late inspect resolve and reject paths must both be ignored");
assert.match(source, /if \(inspectWatchdog !== null\) window\.clearTimeout\(inspectWatchdog\);[\s\S]*if \(!inspectTimedOut\) setBusy\(false\);/u);
assert.match(source, /const \[commentSendSupported, setCommentSendSupported\] = useState\(false\);/u);
assert.match(source, /setCommentSendSupported\(result\.comment_send_supported === true\);/u);
assert.match(source, /disabled=\{busy \|\| !observationId \|\| !menuVerified \|\| !commentSendSupported/u);
assert.match(source, /已锁定目标内容/u);
assert.doesNotMatch(source, /已锁定唯一内容/u);
assert.match(source, /verification_level === "clipboard_exact"/u);
assert.match(source, /verification_level === "visible_exact"/u);
assert.match(source, /已在原帖唯一识别到相同评论，并复核帖子锚点与评论候选稳定/u);
assert.match(source, /系统从当前可见内容中选一条并在操作前回锁；相同动作不重复，结果不明不自动补发/u);

console.log("Moments dry-run panel self-check passed");
