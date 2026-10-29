const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { reportPublishFailure } = require("./social-publish-ipc.cjs");
const { createDiagnosticLogger } = require("./diagnostics.cjs");
const { createFailureCapsules } = require("./failure-capsule.cjs");

// A publish failure becomes a failure capsule with the page screenshot, so a
// 视频号 problem on a customer computer arrives without anyone exporting logs.
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-publish-ipc-"));
  const logger = createDiagnosticLogger({ rootDir: root });
  const capsules = createFailureCapsules({ rootDir: root, logger, settleMs: 5, home: root, captureScreen: async () => {} });
  capsules.start();
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("page")]);
  reportPublishFailure({ logger, evidenceDir: path.join(root, "failure-evidence") },
    { platform: "channels", code: "SOCIAL_PAGE_NOT_LOADED", step: "上传视频", clicked: false, pageUrl: "https://channels.weixin.qq.com/platform/post/create", screenshot: png.toString("base64"),
      network: { failed: ["res.wx.qq.com:Script:ERR_ABORTED:x2"], slow: ["res.wx.qq.com:Stylesheet:slow"] } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const [capsule] = fs.readdirSync(capsules.directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => JSON.parse(fs.readFileSync(path.join(capsules.directory, name), "utf8")));
  assert.equal(capsule?.module, "social_publish");
  assert.equal(capsule.code, "social_page_not_loaded");
  // Which resources failed tells a network or proxy problem from a changed page, without a second look at the customer computer.
  assert.deepEqual(capsule.details.failed_request_kind, ["res.wx.qq.com:Script:ERR_ABORTED:x2"]);
  assert.deepEqual(capsule.details.slow_request_kind, ["res.wx.qq.com:Stylesheet:slow"]);
  assert.equal(capsule.details.platform_kind, "channels");
  assert.equal(capsule.details.step_code, "upload");
  assert.equal(capsule.details.page_kind, "platform.post.create");
  assert.equal(capsule.evidence.length, 1, "the page screenshot travels with the failure");
  assert.equal(capsule.evidence[0].hasImage, true);
  // Being asked to log in again is the platform's normal answer: counted, not filed.
  reportPublishFailure({ logger, evidenceDir: "" }, { platform: "channels", code: "SOCIAL_LOGIN_REQUIRED", step: "打开平台", clicked: false, pageUrl: "", screenshot: "" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fs.readdirSync(capsules.directory).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).length, 1);
  assert.ok(logger.readRecent(20).some((entry) => entry.event === "job_failed" && entry.code === "social_login_required" && entry.level === "warn"));
  capsules.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("social publish IPC self-check passed: failures reach capsules with the page screenshot; login walls are counted");
})().catch((error) => { console.error(error); process.exit(1); });
