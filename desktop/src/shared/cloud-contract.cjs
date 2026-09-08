const crypto = require("node:crypto");

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,119}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function token(value, fallback = "") {
  return typeof value === "string" && TOKEN.test(value) && !/(?:sk-|ak-|ltai)/i.test(value) ? value : fallback;
}
function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) fail("cloud_version_invalid");
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
function verifyManifest(envelope, config) {
  if (typeof envelope?.payload !== "string" || envelope.payload.length > 16384
      || typeof envelope.signature !== "string" || envelope.signature.length > 128) fail("cloud_manifest_invalid");
  if (!crypto.verify(null, Buffer.from(envelope.payload), config.signingPublicKey,
    Buffer.from(envelope.signature, "base64"))) fail("cloud_signature_invalid");
  const m = JSON.parse(envelope.payload);
  if (m.schema !== 1 || m.appId !== config.appId || m.channel !== config.channel
      || m.platform !== "win32" || m.arch !== "x64" || !VERSION.test(m.version)
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size)
      || m.size < 1 || m.size > 8 * 1024 ** 3
      || m.file !== `/artifacts/${m.sha256}.exe`
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1
      || typeof m.notes !== "string" || m.notes.length > 2000) fail("cloud_manifest_invalid");
  if (m.publishedAt !== undefined && (typeof m.publishedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.publishedAt)
      || !Number.isFinite(Date.parse(m.publishedAt)))) fail("cloud_manifest_invalid");
  return m;
}

// Only technical fields cross the network. Never upload free-form messages,
// stack traces, paths, arbitrary nested log details or hashes of customer text.
function reportEntry(entry, context) {
  if (!entry || !["warn", "error", "fatal", "info"].includes(entry.level)) return null;
  const module = token(entry.module), event = token(entry.event);
  if (!module || !event || !UUID.test(entry.run_id || "") || !Number.isSafeInteger(entry.seq)) return null;
  const ts = Date.parse(entry.ts);
  if (!Number.isFinite(ts)) return null;
  const result = {
    id: crypto.createHash("sha256").update(`${context.installId}:${entry.run_id}:${entry.seq}`).digest("hex"),
    ts: new Date(ts).toISOString(), level: entry.level, module, event,
    code: token(entry.code, "unknown_error"), phase: token(entry.phase),
    traceId: UUID.test(entry.trace_id || "") ? entry.trace_id : "",
    durationMs: Number.isFinite(entry.duration_ms) ? Math.min(86400000, Math.max(0, Math.round(entry.duration_ms))) : 0
  };
  // Finite technical counters / enums useful for RPA failure diagnosis.
  result.details = {};
  for (const key of ["receipt_stage", "receipt_code", "receipt_draft_read_stage", "state", "status", "phase", "reason_code", "error_code"]) {
    const value = token(entry.details?.[key]);
    if (value) result.details[key] = value;
  }
  for (const key of ["receipt_conversation_verified", "receipt_draft_read_ok", "receipt_draft_consumed", "receipt_input_lease_valid", "receipt_bubble_verified"]) {
    if (typeof entry.details?.[key] === "boolean") result.details[key] = entry.details[key];
  }
  return result;
}
module.exports = { VERSION, UUID, compareVersions, fail, reportEntry, token, verifyManifest };
