const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const file = path.join(desktopDir, "release-capabilities.json");
const matrix = JSON.parse(fs.readFileSync(file, "utf8"));
const expectedCapabilities = ["activeTouch", "autoReply", "contactSync", "moments"];
const validImplementation = new Set(["implemented"]);
const validAggregateVerification = new Set(["pending", "verified", "partial"]);
const validWorkflowVerification = new Set(["pending", "verified", "partial"]);

function deriveAggregate(values) {
  return values.every((value) => value === values[0]) ? values[0] : "partial";
}

assert.equal(matrix.schemaVersion, 2);
assert.deepEqual(matrix.targetWeixin, ["4.1.11.55"]);
assert.deepEqual(Object.keys(matrix.capabilities || {}).sort(), expectedCapabilities);
for (const [name, capability] of Object.entries(matrix.capabilities)) {
  assert.equal(validImplementation.has(capability.implementation), true, `${name} implementation status is invalid`);
  assert.equal(validAggregateVerification.has(capability.localLiveVerification), true, `${name} local verification status is invalid`);
  assert.equal(validAggregateVerification.has(capability.portableVerification), true, `${name} portable verification status is invalid`);
}

const moments = matrix.capabilities.moments;
assert.equal(moments.implementation, "implemented");
assert.deepEqual(moments.packagedEditions, ["test", "delivery"]);
assert.deepEqual(Object.keys(moments.workflows || {}).sort(), ["dailyAutomation", "perPostInteraction", "publishing"]);
for (const [name, workflow] of Object.entries(moments.workflows)) {
  assert.equal(validImplementation.has(workflow.implementation), true, `${name} implementation status is invalid`);
  assert.equal(validWorkflowVerification.has(workflow.localLiveVerification), true, `${name} local verification status is invalid`);
  assert.equal(validWorkflowVerification.has(workflow.portableVerification), true, `${name} portable verification status is invalid`);
}
assert.equal(moments.workflows.perPostInteraction.localLiveVerification, "partial");
assert.equal(moments.workflows.dailyAutomation.localLiveVerification, "pending");
assert.equal(moments.workflows.publishing.localLiveVerification, "pending");
assert.equal(
  moments.localLiveVerification,
  deriveAggregate(Object.values(moments.workflows).map((workflow) => workflow.localLiveVerification))
);
assert.equal(
  moments.portableVerification,
  deriveAggregate(Object.values(moments.workflows).map((workflow) => workflow.portableVerification))
);
assert.equal(matrix.capabilities.autoReply.localLiveVerification, "verified");
assert.equal(matrix.capabilities.activeTouch.localLiveVerification, "verified");

console.log("release capability matrix self-check passed");
