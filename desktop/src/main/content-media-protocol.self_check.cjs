const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseMediaRange,
  parseContentMediaUrl,
  registerContentMediaProtocol,
  registerContentMediaScheme
} = require("./content-media-protocol.cjs");

assert.deepEqual(parseMediaRange("bytes=0-99", 1000), { start: 0, end: 99 });
assert.deepEqual(parseMediaRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.deepEqual(parseMediaRange("bytes=900-", 1000), { start: 900, end: 999 });
assert.equal(parseMediaRange("bytes=0-99,200-299", 1000), null);

const candidateId = `generated_video_${"a".repeat(32)}`;
const supplementalId = `guided_auto_mix_supplemental_image_${"b".repeat(32)}`;
assert.deepEqual(
  parseContentMediaUrl(`xiaoxi-content://generated/${candidateId}/video`),
  { candidateId, variant: "video" }
);
assert.deepEqual(
  parseContentMediaUrl(`xiaoxi-content://generated/${candidateId}/thumbnail`),
  { candidateId, variant: "thumbnail" }
);
assert.deepEqual(
  parseContentMediaUrl(`xiaoxi-content://supplemental/${supplementalId}/image`),
  { operationId: supplementalId, variant: "image" }
);
for (const value of [
  "file:///C:/secret.mp4",
  "xiaoxi-content://generated/not-an-id/video",
  "xiaoxi-content://supplemental/not-an-id/image",
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

const mediaRegistrations = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-media-protocol-"));
const mediaPath = path.join(tempDir, "video.mp4");
fs.writeFileSync(mediaPath, Buffer.from("0123456789", "utf8"));
registerContentMediaProtocol({
  protocol: { handle: (scheme, handler) => mediaRegistrations.push({ scheme, handler }) },
  net: { fetch: async () => new Response("unused") },
  controller: {
    resolveGeneratedVideoPath: async (id, variant) => ({
      generated_video_id: id,
      variant,
      absolute_path: mediaPath
    }),
    resolveGuidedAutoMixSupplementalImagePath: async (id) => ({
      operation_id: id,
      variant: "image",
      absolute_path: mediaPath,
      mime_type: "image/png"
    })
  }
});
assert.equal(mediaRegistrations[0].scheme, "xiaoxi-content");

(async () => {
  const handler = mediaRegistrations[0].handler;
  const rangeResponse = await handler({
    url: `xiaoxi-content://generated/${candidateId}/video`,
    method: "GET",
    headers: new Headers({ range: "bytes=2-5" })
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("accept-ranges"), "bytes");
  assert.equal(rangeResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(rangeResponse.headers.get("content-length"), "4");
  assert.equal(Buffer.from(await rangeResponse.arrayBuffer()).toString(), "2345");

  const invalidResponse = await handler({
    url: `xiaoxi-content://generated/${candidateId}/video`,
    method: "GET",
    headers: new Headers({ range: "bytes=100-200" })
  });
  assert.equal(invalidResponse.status, 416);
  assert.equal(invalidResponse.headers.get("content-range"), "bytes */10");

  const headResponse = await handler({
    url: `xiaoxi-content://generated/${candidateId}/video`,
    method: "HEAD",
    headers: new Headers()
  });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("content-length"), "10");
  assert.equal(await headResponse.text(), "");

  const supplementalResponse = await handler({
    url: `xiaoxi-content://supplemental/${supplementalId}/image`,
    method: "GET",
    headers: new Headers()
  });
  assert.equal(supplementalResponse.status, 200);
  assert.equal(supplementalResponse.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await supplementalResponse.arrayBuffer()).toString(), "0123456789");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("content media protocol self-check passed");
})().catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
