const assert = require("node:assert/strict");
const { parallelCheckGroups, serialChecks } = require("./run-self-checks.cjs");

assert.deepEqual(parallelCheckGroups.map(group => group.name), ["active-touch", "moments", "auto-reply"]);
assert.ok(parallelCheckGroups.every(group => group.checks.length > 0));
const grouped = parallelCheckGroups.flatMap(group => group.checks);
assert.equal(new Set(grouped).size, grouped.length, "Parallel self-check groups must not overlap");
assert.equal(grouped.some(check => check.includes("moments")), true);
assert.equal(grouped.some(check => check.includes("auto-reply")), true);
assert.equal(grouped.some(check => check.includes("active-touch-ipc") || check.endsWith("active_touch/self_check.cjs")), true);
assert.equal(grouped.some(check => check.startsWith("rpa/")), false,
  "PowerShell and system-clock RPA harnesses remain serial to avoid local resource contention");
assert.equal(serialChecks.some(check => grouped.includes(check)), false, "Serial and parallel checks must be disjoint");

console.log("Independent active-touch, moments and auto-reply checks are configured as parallel groups.");
