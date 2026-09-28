const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const driverPath = require.resolve("../../rpa/active_touch/wechat_window_driver.cjs");
const driver = require(driverPath);
const sweeps = [];
require.cache[driverPath].exports = {
  ...driver,
  cleanupStaleSearchCaptures: (at) => sweeps.push(at)
};
const { createTouchWorkflow } = require("./touch-workflow.cjs");

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-sweep-interval-"));
  const id = "sweep-fixture";
  const taskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(id).digest("hex"));
  const contact = { id: "target", name: "甲乙", allowed: true };
  const record = { id, payload: { contacts: [contact], script: "您好" } };
  let timestamp = Date.parse("2026-09-28T00:00:00.000Z");
  const workflow = () => createTouchWorkflow({ dataDir: root, now: () => new Date(timestamp) });
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "workflow-binding.json"), JSON.stringify({ taskId: "other-task" }));
    const first = workflow();
    const step = (instance) => instance.runWorkflowStep(record, { isEnabled: () => true });
    assert.equal((await step(first)).status, "needs_attention");
    assert.deepEqual(sweeps, [timestamp], "the first valid step must sweep");
    timestamp += 30 * 60 * 1000;
    await step(first);
    await step(workflow());
    assert.equal(sweeps.length, 1, "multiple steps and workflow instances share one process interval");
    timestamp += 31 * 60 * 1000;
    await step(first);
    assert.deepEqual(sweeps, [Date.parse("2026-09-28T00:00:00.000Z"), timestamp], "a step after 60 minutes must sweep again");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("touch capture sweep interval passed: first step, within-hour reuse, after-hour sweep");
}

if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
