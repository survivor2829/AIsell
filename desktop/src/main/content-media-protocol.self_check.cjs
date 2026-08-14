const assert = require("node:assert/strict");
const {
  parseContentMediaUrl,
  registerContentMediaScheme
} = require("./content-media-protocol.cjs");

const candidateId = `generated_video_${"a".repeat(32)}`;
assert.deepEqual(
  parseContentMediaUrl(`xiaoxi-content://generated/${candidateId}/video`),
  { candidateId, variant: "video" }
);
assert.deepEqual(
  parseContentMediaUrl(`xiaoxi-content://generated/${candidateId}/thumbnail`),
  { candidateId, variant: "thumbnail" }
);
for (const value of [
  "file:///C:/secret.mp4",
  "xiaoxi-content://generated/not-an-id/video",
  `xiaoxi-content://other/${candidateId}/video`,
  `xiaoxi-content://generated/${candidateId}/../../secret`
]) {
  assert.equal(parseContentMediaUrl(value), null);
}

const registrations = [];
registerContentMediaScheme({
  registerSchemesAsPrivileged: (value) => registrations.push(value)
});
assert.equal(registrations[0][0].scheme, "xiaoxi-content");
assert.equal(registrations[0][0].privileges.secure, true);

console.log("content media protocol self-check passed");
