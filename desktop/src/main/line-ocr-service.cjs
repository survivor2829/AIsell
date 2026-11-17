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

function createLineOcrService({ resolveLaunch, spawnProcess = spawn, now = () => Date.now(), env = process.env, onEvent = () => {} } = {}) {
  let child = null;
  let starting = null;
  let failedAt = 0;

  function clear() {
    delete env[ENV_URL];
    delete env[ENV_TOKEN];
  }

  function stop() {
    const running = child;
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
      onEvent("unavailable", { cause: "runtime_missing" });
      return Promise.resolve(false);
    }
    const token = crypto.randomBytes(24).toString("hex");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          failedAt = now();
          stop();
          onEvent("unavailable", { cause: reason });
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
      const timer = setTimeout(() => finish(false, "start_timeout"), START_TIMEOUT_MS);
      let buffered = "";
      process_.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        const line = buffered.split(/\r?\n/u)[0];
        if (!buffered.includes("\n")) return;
        try {
          const port = Number(JSON.parse(line).port);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("port");
          env[ENV_URL] = `http://127.0.0.1:${port}/read`;
          env[ENV_TOKEN] = token;
          onEvent("ready", { port });
          finish(true);
        } catch {
          finish(false, "protocol_invalid");
        }
      });
      process_.stderr.on("data", () => { /* never logged: screen text */ });
      process_.on("error", () => finish(false, "spawn_error"));
      process_.on("exit", (code) => {
        if (child === process_) {
          child = null;
          clear();
        }
        if (!settled) finish(false, `exited_${code}`);
        else onEvent("exited", { code });
      });
    });
  }

  // Resolves true when the reader is up; false (never throws) when it cannot be used now.
  function ensure() {
    if (child && child.exitCode === null && env[ENV_URL]) return Promise.resolve(true);
    if (starting) return starting;
    if (failedAt && now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(false);
    starting = start().finally(() => { starting = null; });
    return starting;
  }

  return { ensure, stop, running: () => Boolean(child && child.exitCode === null && env[ENV_URL]) };
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

module.exports = { createLineOcrService, configureLineOcrService, lineOcrService, ENV_URL, ENV_TOKEN };
