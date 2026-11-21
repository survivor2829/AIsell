const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { locationKind, frames, failureDetails, reportHelperFailures } = require("./update-failure-report.cjs");
const { sanitizeValue } = (() => { try { return require("./diagnostics.cjs"); } catch { return {}; } })();

// 2026-11-21 47d2578f: "备份业务数据失败 … EPERM … generations\<hash>\resources", never uploaded.
const profile = "C:\\Users\\56871\\AppData\\Roaming\\xiaoxi-active-touch-test";
const roots = { profile, install: "C:\\Users\\56871\\AppData\\Local\\Programs\\AI获客-测试版" };
const where = `${profile}\\data\\cloud-maintenance\\components\\generations\\630a725d8d1906da54654341e1546e884af9b242b06cc1f2c87830c7840987b2\\resources`;
assert.equal(locationKind(where, roots), "profile.data.cloud-maintenance.components.generations.h.resources");
assert.equal(locationKind(`${roots.install}\\resources\\app.asar`, roots), "install.resources.app.asar");
assert.equal(locationKind("D:\\客户资料\\视频.mp4", roots), "other.x", "a path outside the known roots keeps no name");
assert.doesNotMatch(locationKind(where, roots), /56871/u, "never the Windows user name");

const stack = `Error: EPERM: operation not permitted, symlink '${where}' -> 'C:\\x'\n    at async Object.symlink (node:internal/fs/promises:1000:10)\n    at async copySnapshot (C:\\Users\\56871\\AppData\\Local\\Temp\\h\\resources\\app\\src\\main\\update-storage.cjs:84:7)\n    at async captureData (C:\\Users\\56871\\x\\update-backups.cjs:71:22)`;
assert.deepEqual(frames(stack), ["update-storage.cjs:84", "update-backups.cjs:71"]);

const details = failureDetails({ phase: "error", failure: { phase: "backup", code: "EPERM", syscall: "symlink", path: where, stack } }, roots);
assert.deepEqual(details, { failure_phase: "backup", error_code: "eperm", syscall_kind: "symlink",
  location_kind: "profile.data.cloud-maintenance.components.generations.h.resources", frames_code: ["update-storage.cjs:84", "update-backups.cjs:71"] });
// Every value survives the diagnostics filter as it is (identifiers under *_phase/_code/_kind keys).
if (sanitizeValue) assert.deepEqual(sanitizeValue(details), details);

// Each failed job is logged once; finished jobs and old failures are not.
const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "update-report-"));
try {
  const now = Date.parse("2026-11-21T12:00:00Z");
  fs.writeFileSync(path.join(jobs, "a.status.json"), JSON.stringify({ phase: "error", updatedAt: "2026-11-21T10:00:00Z", failure: { phase: "backup", code: "EPERM", path: where } }));
  fs.writeFileSync(path.join(jobs, "b.status.json"), JSON.stringify({ phase: "complete", updatedAt: "2026-11-21T10:00:00Z" }));
  fs.writeFileSync(path.join(jobs, "c.status.json"), JSON.stringify({ phase: "error", updatedAt: "2026-09-01T10:00:00Z", failure: { code: "EPERM" } }));
  const logged = [];
  assert.equal(reportHelperFailures({ jobsDir: jobs, roots, log: (row) => logged.push(row), now }), 1);
  assert.equal(logged[0].location_kind, "profile.data.cloud-maintenance.components.generations.h.resources");
  assert.equal(reportHelperFailures({ jobsDir: jobs, roots, log: (row) => logged.push(row), now }), 0, "reported once");
  assert.equal(reportHelperFailures({ jobsDir: path.join(jobs, "missing"), roots, log: () => {}, now }), 0);
} finally { fs.rmSync(jobs, { recursive: true, force: true }); }

console.log("update failure report self-check passed: path shapes without names, own frames only, once per failed job");
