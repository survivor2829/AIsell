"use strict";
// One long-lived PowerShell for read-only WeChat observations (2026-11-17 speed-up).
//
// Starting powershell.exe took about 0.9 s on the development machine, and a touch contact
// started it six times. Observation scripts (conversation check, bubble snapshots) run here
// instead, each in its own runspace, so their variables never meet; the process stays.
//
// - Read-only callers only: nothing that clicks, types or sends uses the host.
// - Each request carries the full environment it needs; keys the previous request set and
//   this one does not are cleared, so no value leaks from one call into the next.
// - A request that does not answer in time kills the host; the next call starts a fresh one.
// - Any host failure before the script ran answers { hostUnavailable: true } and the caller
//   falls back to its own powershell.exe, so the host can never make a step fail.
// - XIAOXI_POWERSHELL_HOST=0 turns it off.
const { spawn } = require("node:child_process");

const HOST_LOOP = String.raw`
$ProgressPreference = "SilentlyContinue"
# Scripts set the console encoding to UTF-8 themselves, which replaces Console.Out: fix it
# here once and take the current writer for every answer.
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$reader = [Console]::In
$previousKeys = @()
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $response = $null; $ps = $null; $rs = $null
  try {
    # Requests and answers travel as base64 of UTF-8 JSON: plain ASCII, so neither the console
    # code page (GBK on a Chinese Windows, 437 on CI) nor a script changing it can garble a
    # customer's name (CI 2026-11-17: 甲 arrived as τö▓).
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim())) | ConvertFrom-Json
    foreach ($key in $previousKeys) { [Environment]::SetEnvironmentVariable($key, $null) }
    $previousKeys = @()
    foreach ($property in $request.env.PSObject.Properties) {
      [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value)
      $previousKeys += $property.Name
    }
    $text = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$request.script))
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = "STA"
    $rs.ThreadOptions = "ReuseThread"
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript('$ProgressPreference = "SilentlyContinue"; ' + $text)
    $output = $ps.Invoke()
    $stdout = ($output | ForEach-Object { [string]$_ }) -join [string][char]10
    $stderr = ($ps.Streams.Error | Select-Object -First 5 | ForEach-Object { $_.ToString() }) -join [string][char]10
    $response = @{ id = [string]$request.id; stdout = $stdout; stderr = $stderr } | ConvertTo-Json -Compress -Depth 3
  } catch {
    $response = @{ id = [string]$request.id; host_error = $_.Exception.GetType().Name } | ConvertTo-Json -Compress
  } finally {
    if ($null -ne $ps) { $ps.Dispose() }
    if ($null -ne $rs) { $rs.Dispose() }
  }
  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$response)))
  [Console]::Out.Flush()
}
`;

function createPowerShellHost(options = {}) {
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  let child = null;
  let buffer = "";
  let pending = null;
  let queue = Promise.resolve();
  let sequence = 0;

  const stop = () => {
    const current = child;
    child = null;
    buffer = "";
    if (current) {
      try { current.stdin.end(); } catch {}
      try { current.kill(); } catch {}
    }
    if (pending) {
      const settle = pending.settle;
      pending = null;
      settle({ hostUnavailable: true, cause: "powershell_host_stopped" });
    }
  };

  const start = () => {
    if (child) return child;
    const encoded = Buffer.from(HOST_LOOP, "utf16le").toString("base64");
    const created = spawnProcess("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      env: { ...process.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    created.stdout.setEncoding("utf8");
    created.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line || !pending) continue;
        let message;
        try { message = JSON.parse(Buffer.from(line, "base64").toString("utf8")); } catch { continue; }
        if (String(message.id) !== pending.id) continue;
        const settle = pending.settle;
        pending = null;
        settle(message.host_error ? { hostUnavailable: true, cause: "powershell_host_error" } : { stdout: String(message.stdout || ""), stderr: String(message.stderr || "") });
      }
    });
    created.stderr.on("data", () => {});
    created.stdin.on("error", () => {});
    const lost = () => { if (child === created) stop(); };
    created.on("error", lost);
    created.on("close", lost);
    child = created;
    return created;
  };

  // Runs one script; answers { stdout, stderr }, { timedOut: true } or { hostUnavailable: true }.
  const run = (script, env = {}, timeoutMs = 15000) => {
    const job = queue.then(() => new Promise((resolve) => {
      let process_;
      try { process_ = start(); } catch { resolve({ hostUnavailable: true, cause: "powershell_host_spawn_failed" }); return; }
      const id = `${Date.now()}-${++sequence}`;
      const timer = setTimeout(() => {
        if (!pending || pending.id !== id) return;
        pending = null;
        stop();
        resolve({ timedOut: true });
      }, Math.max(1000, Number(timeoutMs) || 15000));
      pending = { id, settle: (value) => { clearTimeout(timer); resolve(value); } };
      const request = Buffer.from(JSON.stringify({ id, env, script: Buffer.from(String(script), "utf16le").toString("base64") }), "utf8").toString("base64");
      try { process_.stdin.write(`${request}\n`); } catch {
        clearTimeout(timer);
        pending = null;
        stop();
        resolve({ hostUnavailable: true, cause: "powershell_host_write_failed" });
      }
    }));
    queue = job.catch(() => undefined);
    return job;
  };

  return { run, stop, get running() { return Boolean(child); } };
}

let sharedHost = null;
function powerShellHost() {
  if (process.env.XIAOXI_POWERSHELL_HOST === "0" || process.platform !== "win32") return null;
  if (!sharedHost) {
    sharedHost = createPowerShellHost();
    process.once("exit", () => sharedHost?.stop());
  }
  return sharedHost;
}

module.exports = { createPowerShellHost, powerShellHost, HOST_LOOP };
