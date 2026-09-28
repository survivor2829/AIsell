const assert = require("node:assert/strict");
const { parallelCheckGroups, serialChecks, runChecks } = require("./run-self-checks.cjs");

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

const output = [];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, ...args) { output.push(String(chunk)); return true; };
try {
  const child = (status, stdout) => (_node, _args, options) => {
    assert.deepEqual(options.stdio, ["inherit", "pipe", "inherit"]);
    assert.ok(options.maxBuffer >= 1024 * 1024);
    return { status, stdout };
  };
  assert.throws(() => runChecks(["silent.cjs"], child(0, "child original output\n")),
    /self-check exited 0 without a passed line: silent\.cjs/);
  assert.ok(output.join("").includes("child original output"), "child stdout must remain visible");
  runChecks(["ok.cjs"], child(0, "child says passed\n"));
  assert.ok(output.join("").includes("child says passed"));
  assert.throws(() => runChecks(["failed.cjs"], child(2, "child says passed\n")), /self-check failed/);
} finally {
  process.stdout.write = originalWrite;
}

console.log("Self-check runner checks passed: grouping, exit status, passed lines and output forwarding.");
