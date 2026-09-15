const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { normalizeFailureReasonCode } = require("../shared/wechat-failure-policy.cjs");

const THRESHOLD = 3;
const MAX_BUILDS = 32;

function createClassificationQualityLedger({ rootDir, buildVersion = "unknown", buildId = "unknown", buildCommit = "unknown", now = () => new Date() }) {
  const identity = { buildVersion: String(buildVersion || "unknown"), buildId: String(buildId || "unknown"), buildCommit: String(buildCommit || "unknown") };
  const buildKey = [identity.buildVersion, identity.buildId, identity.buildCommit].join("|");
  const file = path.join(rootDir, "wechat_failure_classification_quality.json");
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.version !== 1 || !value.builds || typeof value.builds !== "object") throw new Error("classification_quality_ledger_invalid");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, builds: {} };
      return { version: 1, builds: {}, readError: "classification_quality_ledger_unreadable" };
    }
  };
  const recordFor = (store) => store.builds[buildKey] || { ...identity, unknownPauseCount: 0, unknownReasonCodes: [], affectedTaskCount: 0, affectedTaskFingerprints: [], status: "ok" };
  function summary() {
    const store = read();
    if (store.readError) return { ...identity, threshold: THRESHOLD, unknownPauseCount: 0,
      unknownReasonCodes: [store.readError], affectedTaskCount: 0, status: "needs_review" };
    const record = recordFor(store);
    return { ...identity, threshold: THRESHOLD, unknownPauseCount: record.unknownPauseCount,
      unknownReasonCodes: [...record.unknownReasonCodes].sort(), affectedTaskCount: record.affectedTaskCount, status: record.status };
  }
  function record(task, reasonCode) {
    const store = read();
    if (store.readError) throw new Error(store.readError);
    const item = recordFor(store);
    const reason = normalizeFailureReasonCode(reasonCode || "task_attention_reason_missing");
    const fingerprint = createHash("sha256").update(String(task?.id || "workflow")).digest("hex").slice(0, 16);
    item.unknownPauseCount += 1;
    if (!item.unknownReasonCodes.includes(reason)) item.unknownReasonCodes.push(reason);
    if (!item.affectedTaskFingerprints.includes(fingerprint)) {
      item.affectedTaskCount += 1;
      item.affectedTaskFingerprints = [...item.affectedTaskFingerprints, fingerprint].slice(-512);
    }
    item.status = item.unknownPauseCount >= THRESHOLD ? "needs_review" : "ok";
    item.updatedAt = new Date(now()).toISOString();
    store.builds[buildKey] = item;
    const ordered = Object.entries(store.builds).sort(([, left], [, right]) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
    store.builds = Object.fromEntries(ordered.slice(0, MAX_BUILDS));
    writeJsonAtomic(file, store);
    return { reason, summary: summary() };
  }
  return { record, summary, buildKey };
}

module.exports = { createClassificationQualityLedger, THRESHOLD };
