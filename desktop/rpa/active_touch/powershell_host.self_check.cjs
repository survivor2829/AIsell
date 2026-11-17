"use strict";
// The long-lived PowerShell for read-only observations (powershell_host.cjs).
const assert = require("node:assert/strict");
const { createPowerShellHost } = require("./powershell_host.cjs");

async function main() {
  if (process.platform !== "win32") { console.log("powershell host self-check skipped (not Windows)"); return; }
  const host = createPowerShellHost();
  try {
    let answer = await host.run('@{ ok = $true; name = "向锦涛" } | ConvertTo-Json -Compress', {}, 30_000);
    assert.deepEqual(JSON.parse(answer.stdout), { ok: true, name: "向锦涛" }, "Chinese output survives");

    answer = await host.run('$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @{ ok = $false; reason = "早退" } | ConvertTo-Json -Compress; exit; "after"', {}, 10_000);
    assert.deepEqual(JSON.parse(answer.stdout), { ok: false, reason: "早退" }, "exit ends the script, not the host, even after a script changes the console encoding");
    assert.equal(host.running, true);

    answer = await host.run('[Environment]::GetEnvironmentVariable("XIAOXI_TITLE_NEAR_NAMES")', { XIAOXI_TITLE_NEAR_NAMES: "[\"甲\"]" }, 10_000);
    assert.equal(answer.stdout, "[\"甲\"]");
    answer = await host.run('"[" + [Environment]::GetEnvironmentVariable("XIAOXI_TITLE_NEAR_NAMES") + "]"', {}, 10_000);
    assert.equal(answer.stdout, "[]", "a value the previous request set never reaches the next one");

    await host.run('$leftover = 7; "set"', {}, 10_000);
    answer = await host.run('"[" + $leftover + "]"', {}, 10_000);
    assert.equal(answer.stdout, "[]", "each request runs in its own runspace");

    answer = await host.run('[System.Threading.Thread]::CurrentThread.ApartmentState.ToString()', {}, 10_000);
    assert.equal(answer.stdout, "STA", "clipboard reads need STA");

    const started = Date.now();
    answer = await host.run("Start-Sleep -Seconds 30", {}, 1500);
    assert.equal(answer.timedOut, true, "a request that does not answer in time times out");
    assert.ok(Date.now() - started < 10_000);
    assert.equal(host.running, false, "and the host is stopped");
    answer = await host.run('"fresh"', {}, 30_000);
    assert.equal(answer.stdout, "fresh", "the next request starts a new host");

    // Real scripts open with the DPI context and the parent guard. The guard starts once per
    // process; a later script in the same host must not exit (2026-11-17 real run: every
    // hosted conversation check after the first came back empty and the contact was skipped).
    const driverSource = require("node:fs").readFileSync(require.resolve("./wechat_window_driver.cjs"), "utf8");
    const prefix = driverSource.split("const DPI_AWARE_POWERSHELL = `")[1].split("\n`;")[0];
    for (let index = 0; index < 3; index += 1) {
      answer = await host.run(`${prefix}\n@{ ok = $true; run = ${index} } | ConvertTo-Json -Compress`, { XIAOXI_PARENT_PID: String(process.pid) }, 30_000);
      assert.deepEqual(JSON.parse(answer.stdout.trim()), { ok: true, run: index }, `script ${index + 1} with the real prefix answers`);
    }
    answer = await host.run(`${prefix}\n"should not run"`, { XIAOXI_PARENT_PID: "1" }, 30_000);
    assert.equal(answer.stdout.trim(), "", "a script for another parent still exits");

    const calls = [];
    for (let index = 0; index < 5; index += 1) calls.push(host.run(`"${index}"`, {}, 10_000));
    assert.deepEqual((await Promise.all(calls)).map((item) => item.stdout), ["0", "1", "2", "3", "4"], "requests run one at a time in order");

    const timed = Date.now();
    for (let index = 0; index < 5; index += 1) await host.run('"x"', {}, 10_000);
    const perCall = (Date.now() - timed) / 5;
    assert.ok(perCall < 600, `a warm call is far below a new process (${perCall} ms)`);
  } finally {
    host.stop();
  }
  const broken = createPowerShellHost({ spawnProcess: () => { throw new Error("blocked"); } });
  assert.equal((await broken.run('"x"')).hostUnavailable, true, "a host that cannot start lets the caller fall back");
  console.log("powershell host self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
