const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const file = path.join(desktopDir, "release-capabilities.json");
const matrix = JSON.parse(fs.readFileSync(file, "utf8"));
const expectedCapabilities = ["activeTouch", "autoReply", "contactSync", "moments"];
const validImplementation = new Set(["implemented", "single-post-preview"]);
const validVerification = new Set(["pending", "verified"]);

assert.equal(matrix.schemaVersion, 1);
assert.deepEqual(matrix.targetWeixin, ["4.1.11.54"]);
assert.deepEqual(Object.keys(matrix.capabilities || {}).sort(), expectedCapabilities);
for (const [name, capability] of Object.entries(matrix.capabilities)) {
  assert.equal(validImplementation.has(capability.implementation), true, `${name} implementation status is invalid`);
  assert.equal(validVerification.has(capability.localLiveVerification), true, `${name} local verification status is invalid`);
  assert.equal(validVerification.has(capability.portableVerification), true, `${name} portable verification status is invalid`);
}
assert.equal(matrix.capabilities.moments.implementation, "single-post-preview");

console.log("release capability matrix self-check passed");
