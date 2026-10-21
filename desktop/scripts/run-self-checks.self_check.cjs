const assert = require("node:assert/strict");
const { checks, concurrencyFor, isExclusive, runPool, runScheduled, checkResult, checkEnvironment, groups, checksForGroup } = require("./run-self-checks.cjs");

async function main() {
  assert.deepEqual(Object.keys(groups), ["core", "moments-visual", "reply-visual", "rpa", "runtime"]);
  const assigned = Object.keys(groups).flatMap(checksForGroup);
  assert.deepEqual([...assigned].sort(), [...checks].sort(), "every active check executes exactly once across CI groups");
  assert.equal(new Set(assigned).size, checks.length);
  assert.deepEqual(checksForGroup(), checks, "the local entrypoint keeps complete coverage");
  assert.throws(() => checksForGroup("unknown"), /Unknown self-check group/);
  assert.ok(groups["moments-visual"].includes("rpa/active_touch/moments_visual.self_check.cjs"));
  assert.equal(groups["reply-visual"].length, 2);
  const workflow = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../.github/workflows/ci.yml"), "utf8");
  const matrix = workflow.match(/group: \[([^\]]+)\]/u)?.[1].split(",").map(name => name.trim());
  assert.deepEqual(matrix, Object.keys(groups), "the workflow must execute the canonical complete partition");
  assert.equal(concurrencyFor({}, 20), 6);
  const local = { TZ: "America/New_York" };
  assert.equal(checkEnvironment("rpa/active_touch/wechat_auto_reply_driver.self_check.cjs", local), local,
    "Node and the PowerShell OS clock must keep their existing agreement");
  assert.equal(checkEnvironment("src/main/moments-draft.self_check.cjs", local).TZ, "Asia/Shanghai");
  assert.equal(checkEnvironment("src/main/acquisition-sync.self_check.cjs", { PRECISE_TEST_PYTHON: "explicit-python" }).PRECISE_TEST_PYTHON,
    "explicit-python", "An explicit sync fixture interpreter must remain authoritative");
  assert.equal(concurrencyFor({}, 1), 1);
  assert.equal(concurrencyFor({ XIAOXI_SELF_CHECK_CONCURRENCY: "2" }, 20), 2);
  assert.throws(() => concurrencyFor({ XIAOXI_SELF_CHECK_CONCURRENCY: "0" }, 20), /concurrency/);
  assert.equal(new Set(checks).size, checks.length);
  for (const check of ["scripts/update-helper.e2e.cjs", "scripts/component-update-selftest.cjs",
    "scripts/product-detail-download.electron.self_check.cjs", "rpa/active_touch/moments_navigation.self_check.cjs"]) {
    assert.equal(isExclusive(check), true, check + " must run alone");
  }
  assert.equal(isExclusive("src/main/acquisition-account.self_check.cjs"), false);
  const output = [], errors = [];
  const originalWrite = process.stdout.write, originalErrorWrite = process.stderr.write;
  process.stdout.write = chunk => { output.push(String(chunk)); return true; };
  process.stderr.write = chunk => { errors.push(String(chunk)); return true; };
  try {
    assert.throws(() => checkResult("silent.cjs", { status: 0, stdout: "child original output\n" }), /without a passed line/);
    checkResult("ok.cjs", { status: 0, stdout: "child says passed\n", stderr: "child stderr\n" });
    assert.throws(() => checkResult("failed.cjs", { status: 2, stdout: "passed\n" }), /self-check failed/);
    assert.ok(output.join("").includes("child original output"));
    assert.ok(errors.join("").includes("child stderr"));
  } finally { process.stdout.write = originalWrite; process.stderr.write = originalErrorWrite; }

  let alive = 0, maximum = 0;
  const order = [];
  const execute = async check => {
    if (isExclusive(check)) assert.equal(alive, 0, "exclusive check overlaps another child");
    alive++; maximum = Math.max(maximum, alive); order.push("start:" + check);
    await new Promise(resolve => setTimeout(resolve, 5));
    alive--; order.push("end:" + check);
    return { status: 0, stdout: "passed" };
  };
  const exclusive = "scripts/update-helper.e2e.cjs";
  await runScheduled(["first", "second", "third", exclusive, "last"], { concurrency: 2, execute, report() {} });
  assert.equal(maximum, 2, "pool must use and bound concurrency");
  assert.ok(order.indexOf("start:" + exclusive) > order.indexOf("end:third"));
  assert.ok(order.indexOf("start:last") > order.indexOf("end:" + exclusive));
  let drained = false, started = 0;
  await assert.rejects(runPool(["fail", "inflight", "never"], { concurrency: 2,
    execute: async check => {
      started++;
      if (check === "fail") throw Error("fixture failure");
      await new Promise(resolve => setTimeout(resolve, 5)); drained = true;
      return { status: 0, stdout: "passed" };
    }, report() {} }), /fixture failure/);
  assert.equal(started, 2, "failure stops new children");
  assert.equal(drained, true, "failure must wait for in-flight children");
  console.log("Self-check runner checks passed: bounded pool, exclusive barriers, output and failure drain.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
