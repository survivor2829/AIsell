const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");

const desktopDir = path.resolve(__dirname, "..");
const { checks, groups, checksForGroup, isExclusive } = require("./self-check-groups.cjs");
function checkEnvironment(check, environment = process.env) {
  // Preserve the original three business fixture groups' calendar. Windows
  // PowerShell replays use the OS clock; changing only Node's TZ breaks them.
  const chinaCalendar = /src\/main\/(?:active-touch(?:-dev)?-ipc|touch-task-ipc|wechat-workflow|moments-[^/]+|auto-reply-ipc)\.self_check\.cjs$/.test(check)
    || /^src\/renderer\/moments-[^/]+\.self_check\.cjs$/.test(check);
  let result = chinaCalendar ? { ...environment, TZ: "Asia/Shanghai" } : environment;
  if (check === "src/main/acquisition-sync.self_check.cjs" && !environment.PRECISE_TEST_PYTHON) {
    const python = environment.XIAOXI_BUILD_PYTHON || path.join(desktopDir, ".build/product-detail-venv/Scripts/python.exe");
    if (fs.existsSync(python)) result = { ...result, PRECISE_TEST_PYTHON: python };
  }
  return result;
}
function concurrencyFor(environment = process.env, cpus = os.availableParallelism()) {
  const value = environment.XIAOXI_SELF_CHECK_CONCURRENCY;
  if (value === undefined || value === "") return Math.max(1, Math.min(cpus, 6));
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 64) throw Error("Self-check concurrency must be an integer from 1 to 64");
  return Number(value);
}

function checkResult(check, result) {
  console.log(`\n> ${check}${Number.isFinite(result.durationMs) ? ` (${result.durationMs} ms)` : ""}`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw result.error || new Error(`self-check failed: ${check} (status ${result.status})`);
  if (!result.stdout?.split(/\r?\n/u).some(line => /\bpassed\b/iu.test(line))) {
    throw new Error(`self-check exited 0 without a passed line: ${check}`);
  }
}

function executeCheck(check) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(desktopDir, check)], {
      cwd: desktopDir, env: checkEnvironment(check),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0, overflow;
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        overflow ||= Error(`Self-check output exceeded 64 MiB: ${check}`);
        child.kill();
      } else output[name].push(chunk);
    });
    child.once("error", reject);
    child.once("close", status => overflow ? reject(overflow) : resolve({ status,
      durationMs: Math.round(performance.now() - started),
      stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() }));
  });
}

async function runPool(list, { concurrency = concurrencyFor(), execute = executeCheck, report = checkResult } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw Error("Invalid self-check concurrency");
  let cursor = 0, failure;
  async function worker() {
    while (!failure && cursor < list.length) {
      const check = list[cursor++];
      try { report(check, await execute(check)); }
      catch (error) { failure ||= error; }
    }
  }
  // Drain every child before rejecting; never leave test processes behind when
  // a sibling fails or start an exclusive check while a child is still alive.
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  if (failure) throw failure;
}

async function runScheduled(list, options = {}) {
  let pending = [];
  for (const check of list) {
    if (!isExclusive(check)) { pending.push(check); continue; }
    await runPool(pending, options); pending = [];
    await runPool([check], { ...options, concurrency: 1 });
  }
  await runPool(pending, options);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--group")) throw Error("Usage: run-self-checks.cjs [--group name]");
  const selected = checksForGroup(args[1]);
  console.log(`\nRunning source checks with up to ${concurrencyFor()} children; exclusive resource checks run alone.`);
  await runScheduled(selected);
  console.log("\nall source self-checks passed");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checks, concurrencyFor, isExclusive, runPool, runScheduled, checkResult, checkEnvironment, groups, checksForGroup };
