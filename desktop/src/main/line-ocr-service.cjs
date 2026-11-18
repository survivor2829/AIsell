// The touch chat-title reader (PP-OCRv4 recognition, sidecars/product-detail/app/line_ocr.py).
// Windows' own OCR read 26 of 64 field chat titles exactly, this model 58 (2026-11-17), and
// most skipped contacts had the right chat open but an unreadable title. The reader runs in the
// product-detail runtime on loopback with a per-run token; the WeChat scripts find it through
// XIAOXI_LINE_OCR_URL / XIAOXI_LINE_OCR_TOKEN (inherited by every child process and PowerShell
// script). Started on the first touch step, never required: without it the scripts keep the
// Windows reading, so a missing or broken reader can only cost accuracy, never a send.
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const START_TIMEOUT_MS = 20_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const ENV_URL = "XIAOXI_LINE_OCR_URL";
const ENV_TOKEN = "XIAOXI_LINE_OCR_TOKEN";
const STDERR_TAIL_BYTES = 8 * 1024;

// Why a reader that never came up stopped, without any screen text: the Python exception class,
// a Windows error number and whether the frozen launcher itself failed. Six customer computers
// reported only a hashed "exited_N" for 1.3.30–1.3.35 while the same component starts on the
// development machine (2026-11-18), so the reason has to come back from the field.
function exitEvidence(stderr) {
  const text = String(stderr || "");
  const evidence = {};
  const types = [...text.matchAll(/^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*(?:Error|Exception|Fail|Exit|Interrupt))(?::|\s*$)/gmu)];
  const last = types.length ? types[types.length - 1][1] : "";
  if (/^[A-Za-z_]\w{0,59}$/u.test(last)) evidence.error_type = last;
  const winError = text.match(/\[WinError (-?\d{1,10})\]/u);
  if (winError) evidence.win_error = Number(winError[1]);
  if (/Failed to (?:load Python DLL|execute script|extract|start embedded python)|LoadLibrary|\[PYI-\d+/u.test(text)) evidence.launcher_failed = true;
  if (evidence.error_type && /onnxruntime/u.test(text)) evidence.onnxruntime = true;
  return evidence;
}

function createLineOcrService({ resolveLaunch, spawnProcess = spawn, now = () => Date.now(), env = process.env, onEvent = () => {} } = {}) {
  let child = null;
  let starting = null;
  let failedAt = 0;
  let stopping = false;
  // probe(): a reader started only to check it works is stopped again unless a touch step asked
  // for it meanwhile.
  let claimed = false;

  function clear() {
    delete env[ENV_URL];
    delete env[ENV_TOKEN];
  }

  function stop() {
    const running = child;
    stopping = true;
    child = null;
    clear();
    if (running && running.exitCode === null) {
      try { running.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => { if (running.exitCode === null) running.kill(); }, 3000).unref?.();
    }
  }

  function start() {
    let launch;
    try {
      launch = resolveLaunch?.();
    } catch {
      launch = null;
    }
    if (!launch?.runtimePath || !fs.existsSync(launch.runtimePath)) {
      failedAt = now();
      onEvent("unavailable", { kind: "runtime_missing" }, { launch, stderr: "" });
      return Promise.resolve(false);
    }
    // An older or partly updated product-detail component has the runtime but not the model.
    if ((launch.requiredFiles || []).some((file) => !fs.existsSync(file))) {
      failedAt = now();
      onEvent("unavailable", { kind: "model_missing" }, { launch, stderr: "" });
      return Promise.resolve(false);
    }
    const token = crypto.randomBytes(24).toString("hex");
    stopping = false;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let ready = false;
      let stderr = "";
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          failedAt = now();
          stop();
          // "kind" and "error_type" are plain codes the diagnostics log keeps readable (not WeChat
          // failure reasons: the run never depends on this reader).
          // The third argument is never logged: the app keeps it for its one startup report (at
          // that point the reader has read nothing, so its output holds no screen text).
          onEvent("unavailable", { kind: reason, ...exitEvidence(stderr) }, { launch, stderr });
        }
        resolve(ok);
      };
      let process_;
      try {
        process_ = spawnProcess(launch.runtimePath, [...(launch.runtimeArgs || []), "--line-ocr-serve"], {
          cwd: path.dirname(launch.runtimePath),
          env: { ...env, ...(launch.environment || {}), [ENV_TOKEN]: token, PYTHONUTF8: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch {
        finish(false, "spawn_failed");
        return;
      }
      child = process_;
      timer = setTimeout(() => finish(false, "start_timeout"), START_TIMEOUT_MS);
      let buffered = "";
      process_.stdout.on("data", (chunk) => {
        // Only the first line of the current reader counts: nothing after start, nothing from a
        // reader already being stopped.
        if (settled || child !== process_) return;
        buffered += String(chunk);
        const line = buffered.split(/\r?\n/u)[0];
        if (!buffered.includes("\n")) return;
        try {
          const port = Number(JSON.parse(line).port);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("port");
          env[ENV_URL] = `http://127.0.0.1:${port}/read`;
          env[ENV_TOKEN] = token;
          ready = true;
          onEvent("ready", { port });
          finish(true);
        } catch {
          finish(false, "protocol_invalid");
        }
      });
      // Kept in memory only for exitEvidence(); never logged as text (it may hold screen text).
      process_.stderr.on("data", (chunk) => {
        if (!settled) stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_BYTES);
      });
      process_.on("error", () => finish(false, "spawn_error"));
      process_.on("exit", (code) => {
        if (child === process_) {
          child = null;
          clear();
        }
        if (!settled) {
          // The exit can arrive before the last stderr lines are read: wait briefly for them.
          const fail = () => finish(false, `exited_${code}`);
          if (process_.stderr.readableEnded === false) {
            process_.stderr.once("end", fail);
            setTimeout(fail, 500).unref?.();
          } else fail();
        } else {
          // A reader that stops on its own after starting is not restarted for every contact.
          if (ready && child === null && !stopping) failedAt = now();
          onEvent("exited", { code });
        }
      });
    });
  }

  // Resolves true when the reader is up; false (never throws) when it cannot be used now.
  function ensure() {
    claimed = true;
    return acquire();
  }
  function acquire() {
    if (child && child.exitCode === null && env[ENV_URL]) return Promise.resolve(true);
    if (starting) return starting;
    if (failedAt && now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(false);
    starting = start().finally(() => { starting = null; });
    return starting;
  }

  // Checked once after launch, before anyone touches a customer: a reader that cannot start is
  // reported at once instead of only when a touch run needs it (2026-11-18: the reason never
  // reached the field reports because it happened outside the minute of history a capsule keeps).
  async function probe() {
    if (child || starting) return ensure();
    claimed = false;
    const ok = await acquire();
    if (ok && !claimed) stop();
    // A check made while the computer is still busy starting up must not hold back the first
    // touch step for five minutes: it tries again itself.
    if (!ok && !claimed) failedAt = 0;
    return ok;
  }

  return { ensure, probe, stop, running: () => Boolean(child && child.exitCode === null && env[ENV_URL]) };
}

let shared = null;
function configureLineOcrService(options) {
  shared?.stop();
  shared = createLineOcrService(options);
  return shared;
}
function lineOcrService() {
  return shared;
}

module.exports = { createLineOcrService, configureLineOcrService, lineOcrService, exitEvidence, ENV_URL, ENV_TOKEN };
