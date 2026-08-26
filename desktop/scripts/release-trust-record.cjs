const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), "utf8"));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function independentFile(file, releaseDir, label) {
  const normalized = String(file || "").trim();
  if (!path.isAbsolute(normalized)) throw new Error(`${label} path must be absolute`);
  const state = fs.lstatSync(normalized, { throwIfNoEntry: false });
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
  const realFile = fs.realpathSync(normalized);
  const realRelease = fs.realpathSync(releaseDir);
  const relative = path.relative(realRelease, realFile);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${label} must be supplied independently from the release tree`);
  }
  return realFile;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function verifyReleaseTrustRecord({
  environment = process.env,
  portableManifest,
  portableManifestSha256,
  portableTreeSha256,
  product,
  releaseDir
}) {
  const recordFile = independentFile(
    environment.XIAOXI_RELEASE_TRUST_RECORD,
    releaseDir,
    "Release trust record"
  );
  const publicKeyFile = independentFile(
    environment.XIAOXI_RELEASE_TRUST_PUBLIC_KEY,
    releaseDir,
    "Release trust public key"
  );
  const expectedPublicKeySha256 = String(environment.XIAOXI_RELEASE_TRUST_PUBLIC_KEY_SHA256 || "").trim().toLowerCase();
  if (!HASH_PATTERN.test(expectedPublicKeySha256)) {
    throw new Error("Trusted release public-key SHA-256 is required");
  }

  const publicKey = fs.readFileSync(publicKeyFile);
  const publicKeySha256 = sha256Buffer(publicKey);
  if (publicKeySha256 !== expectedPublicKeySha256) throw new Error("Release trust public-key hash mismatch");

  const record = readJson(recordFile, "Release trust record");
  assertExactKeys(record, ["payload", "signature"], "Release trust record");
  assertExactKeys(record.payload, [
    "artifactType",
    "portableManifestSha256",
    "portableTreeSha256",
    "product",
    "remotionRuntimeDescriptorSha256",
    "remotionRuntimeManifestSha256",
    "schemaVersion"
  ], "Release trust payload");
  assertExactKeys(record.signature, ["algorithm", "valueBase64"], "Release trust signature");
  if (
    record.payload.schemaVersion !== 1
    || record.payload.artifactType !== "delivery"
    || record.payload.product !== product
    || record.signature.algorithm !== "RSA-SHA256"
  ) {
    throw new Error("Release trust record is incompatible");
  }
  for (const field of [
    "portableManifestSha256",
    "portableTreeSha256",
    "remotionRuntimeDescriptorSha256",
    "remotionRuntimeManifestSha256"
  ]) {
    if (!HASH_PATTERN.test(String(record.payload[field] || ""))) throw new Error(`Release trust ${field} is invalid`);
  }

  let signature;
  try {
    signature = Buffer.from(String(record.signature.valueBase64 || ""), "base64");
  } catch {
    throw new Error("Release trust signature is invalid");
  }
  if (!signature.length || !crypto.verify("RSA-SHA256", Buffer.from(canonicalJson(record.payload)), publicKey, signature)) {
    throw new Error("Release trust signature verification failed");
  }

  const runtimeDescriptorSha256 = sha256Text(canonicalJson(portableManifest.remotionRuntime));
  if (
    record.payload.portableManifestSha256 !== portableManifestSha256
    || record.payload.portableTreeSha256 !== portableTreeSha256
    || record.payload.remotionRuntimeDescriptorSha256 !== runtimeDescriptorSha256
    || record.payload.remotionRuntimeManifestSha256 !== portableManifest.remotionRuntime?.manifestSha256
  ) {
    throw new Error("Release trust record does not bind the packaged Remotion runtime");
  }
  return {
    algorithm: record.signature.algorithm,
    portableManifestSha256,
    portableTreeSha256,
    publicKeySha256,
    recordSha256: sha256Buffer(fs.readFileSync(recordFile)),
    runtimeDescriptorSha256,
    verified: true
  };
}

module.exports = {
  canonicalJson,
  sha256Text,
  verifyReleaseTrustRecord
};
