"use strict";
// Every feature that settles work as failed must also report it, or failures on customer computers stay
// invisible (user 2026-11-25: 清理无效好友 failed silently; 精准获客 and 手机批量 had no report either).
// A failure capsule is made from an error-level diagnostic event, so each runner below takes a failure callback
// and its registration hands it the logger. A new runner that records "failed" belongs in this list.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const RUNNERS = [
  // [runner, where it is registered, what the registration must pass]
  ["social-publisher.cjs", "social-publish-ipc.cjs", /onFailure:\s*\(failure\)\s*=>[^\n]*report(Publish|Social)Failure\(\{ logger/],
  ["social-acquisition.cjs", "social-acquisition-ipc.cjs", /onFailure:\s*\(failure\)\s*=>\s*reportSocialFailure\(\{ logger/],
  ["geo-workbench.cjs", "geo-workbench-ipc.cjs", /onFailure:\s*\(failure\)\s*=>\s*reportSocialFailure\(\{ logger/],
  ["phone-batch.cjs", "phone-matrix-ipc.cjs", /onFailure:[^\n]*logger\?\.event\?\.\([^\n]*level: "error"/],
  ["touch-cleanup.cjs", "wechat-workflow-ipc.cjs", /onFailure:[^\n]*logger\?\.event\?\.\(/]
];

for (const [runner, registration, wiring] of RUNNERS) {
  const source = read(runner);
  assert.match(source, /onFailure/, `${runner} records failures but takes no failure callback`);
  assert.match(read(registration), wiring, `${registration} does not send ${runner} failures to the diagnostic log`);
}
// The registrations that need a logger get one from main.
const main = read("main.cjs");
for (const [register, marker] of [["registerSocialAcquisitionIpc", "social_acquisition"], ["registerPhoneMatrixIpc", "手机矩阵截图"]]) {
  const call = main.slice(main.indexOf(`${register}({`), main.indexOf(`${register}({`) + 600);
  assert.ok(call.includes(marker) && /\blogger\b/.test(call), `main.cjs registers ${register} without the logger`);
}
// Runners not listed above must not quietly start settling work as failed.
const listed = new Set(RUNNERS.map(([runner]) => runner));
const KNOWN_REPORTED_ELSEWHERE = new Set([
  "moments-publish-ipc.cjs", "moments-campaign-ipc.cjs", // log every outcome themselves (logger.event with level)
  "content-engine-sidecar.cjs", "product-detail-sidecar.cjs", // engine journals feed the capsules
  "touch-unreachable.cjs", "task-passport.cjs", "feedback-controller.cjs", "component-paths.cjs", "diagnostics-ipc.cjs",
  "provider-gateway-client.cjs", "space-pause-hotkey.cjs", "sprite-activity.cjs", "product-detail-ipc.cjs" // states named, not runs settled
]);
for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".cjs") && !name.includes("self_check"))) {
  if (listed.has(file) || KNOWN_REPORTED_ELSEWHERE.has(file)) continue;
  const source = read(file);
  if (/status(:| =) "failed"/.test(source) && !/level: "error"|onFailure/.test(source)) {
    assert.fail(`${file} settles work as failed without reporting it; add a failure callback and list it here`);
  }
}
console.log("failure reporting self-check passed: every runner that settles work as failed reports it to the failure log");
