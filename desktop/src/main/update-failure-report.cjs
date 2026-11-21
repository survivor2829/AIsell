// Update helper failures reach the field reports (user 2026-11-21: 47d2578f stopped at "备份业务数据失败 …
// EPERM … generations\<hash>\resources" and nothing about it was ever uploaded — the helper writes its
// failure to jobs/<id>.status.json after the app has exited, and no one read it back). On the next start
// each unreported helper failure is logged once as an "update" event. Diagnostics only keep identifiers,
// so the path becomes its shape (where under the profile or the install, hashes and names folded away)
// and the stack becomes file:line frames of our own code.
const fs = require("node:fs");
const path = require("node:path");

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const SAFE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu;
const identifier = (value, fallback = "") => {
  const text = String(value ?? "").trim();
  return SAFE.test(text) ? text.toLowerCase() : fallback;
};

// "C:\Users\x\AppData\Roaming\app\data\cloud-maintenance\components\generations\<64 hex>\resources"
//  → "profile.data.cloud-maintenance.components.generations.h.resources"
function locationKind(file, roots = {}) {
  const value = String(file || "");
  if (!value) return "";
  const lower = path.resolve(value).toLowerCase();
  const named = Object.entries(roots).filter(([, root]) => root)
    .map(([name, root]) => [name, path.resolve(String(root)).toLowerCase()])
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, root]) => lower === root || lower.startsWith(root + path.sep));
  const rest = named ? path.relative(named[1], lower) : "";
  const parts = (named ? rest.split(/[\\/]+/u) : [path.basename(lower)]).filter(Boolean).map((part) =>
    /^[0-9a-f]{12,}$/u.test(part) ? "h" : /^[a-z0-9_.-]{1,40}$/u.test(part) ? part : "x");
  const shape = [named ? named[0] : "other", ...parts].join(".");
  return shape.length <= 120 ? shape : shape.slice(0, 120);
}

// Our own frames only ("update-storage.cjs:84"); node internals and customer paths are dropped.
function frames(stack) {
  return String(stack || "").split(/\r?\n/u).slice(1)
    .map((line) => line.match(/([a-z0-9_.-]+\.c?js):(\d+)(?::\d+)?\)?\s*$/iu))
    .filter(Boolean).map((match) => identifier(`${match[1]}:${match[2]}`)).filter(Boolean).slice(0, 8);
}

function failureDetails(status, roots) {
  const failure = status?.failure || {};
  const details = {
    failure_phase: identifier(failure.phase || status?.phase, "unknown"),
    error_code: identifier(failure.code, "update_failed"),
    syscall_kind: identifier(failure.syscall),
    location_kind: identifier(locationKind(failure.path, roots)),
    cleanup_code: identifier(failure.cleanupCode),
    frames_code: frames(failure.stack)
  };
  // Empty values would reach the report as hashes of nothing.
  return Object.fromEntries(Object.entries(details).filter(([, value]) => Array.isArray(value) ? value.length : value));
}

// Each failed job is reported once; the marker sits next to its status file.
function reportHelperFailures({ jobsDir, roots = {}, log, now = Date.now() }) {
  let names;
  try { names = fs.readdirSync(jobsDir); } catch { return 0; }
  let reported = 0;
  for (const name of names) {
    const match = name.match(/^(.+)\.status\.json$/u);
    if (!match) continue;
    const marker = path.join(jobsDir, `${match[1]}.reported.json`);
    if (names.includes(path.basename(marker))) continue;
    let status;
    try { status = JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")); } catch { continue; }
    if (status?.phase !== "error" || now - Date.parse(status.updatedAt || 0) > MAX_AGE_MS) continue;
    try { log(failureDetails(status, roots)); } catch { continue; }
    try { fs.writeFileSync(marker, JSON.stringify({ reportedAt: new Date(now).toISOString() })); } catch {}
    reported += 1;
  }
  return reported;
}

module.exports = { locationKind, frames, failureDetails, reportHelperFailures };
