const { app } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { diagnostics } = require("./diagnostics.cjs");

let runtimeDataDir = "";
let runtimeCoordinator = null;
const EXECUTOR_STDIO_DRAIN_MS = 50;

function executorFailure(action, blockedReason, error) {
  return { ok: false, action, blocked_reason: blockedReason, error, logs: [] };
}

function parseExecutorOutput({ action = "status", status = 0, stdout = "", stderr = "", error } = {}) {
  const stderrText = String(stderr || "").trim();
  if (error) return executorFailure(action, "executor_spawn_failed", String(error.message || error));
  const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) {
    const detail = stderrText || (status === 0 ? "微信执行器未返回结果" : `微信执行器异常退出（代码 ${status}）`);
    return executorFailure(action, "executor_no_result", detail);
  }
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    return executorFailure(action, "executor_result_invalid", stderrText || "微信执行器返回了无效结果");
  }
  if (!result || Array.isArray(result) || typeof result !== "object" || typeof result.ok !== "boolean") {
    return executorFailure(action, "executor_result_invalid", stderrText || "微信执行器返回结果缺少状态");
  }
  if (result.ok === false && !result.error && !result.blocked_reason) {
    return executorFailure(action, "executor_result_invalid", stderrText || "微信执行器未说明失败原因");
  }
  if (status !== 0 && result.ok === true) {
    return executorFailure(action, "executor_exit_failed", stderrText || `微信执行器异常退出（代码 ${status}）`);
  }
  return result;
}

function cliPath(development = false, cliName = "") {
  return path.join(app.getAppPath(), "rpa", "active_touch", cliName || (development ? "active_touch_cli.dev.cjs" : "active_touch_cli.cjs"));
}

function executeActiveTouch(args, options = {}) {
  return new Promise((resolve) => {
    const development = options.development === true;
    const timeoutMs = Number(options.timeoutMs) || 0;
    const selectedDataDir = options.dataDir === undefined ? runtimeDataDir : String(options.dataDir || "");
    const childArgs = selectedDataDir ? [...args, "--data-dir", selectedDataDir] : args;
    const executable = cliPath(development, options.cliName);
    const operation = diagnostics().begin("wechat_adapter", "executor", {
      command: args[0] ?? "status",
      argument_count: args.length,
      development,
      timeout_ms: timeoutMs,
      workflow: options.workflow || "",
      phase: options.phase || "",
      coordinator_owner: options.owner || "",
      task_id: options.taskId || "",
      contact_id: options.contactId || "",
      current_index: Number.isFinite(Number(options.currentIndex)) ? Number(options.currentIndex) : undefined
    });
    const child = spawn(process.execPath, [executable, ...childArgs], {
      cwd: path.dirname(executable),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    let exitDrain = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (exitDrain) clearTimeout(exitDrain);
      const resultState = result?.state && typeof result.state === "object" && !Array.isArray(result.state)
        ? result.state
        : {};
      const diagnosticValue = (key) => result
        && Object.prototype.hasOwnProperty.call(result, key)
        ? result[key]
        : resultState[key];
      const blockedReason = result?.blocked_reason || resultState.blocked_reason || "";
      const primaryReason = diagnosticValue("primary_reason") || blockedReason;
      operation.end({
        ok: result?.ok === true,
        action: result?.action || args[0] || "status",
        blocked_reason: blockedReason,
        stage: diagnosticValue("stage"),
        send_clicked_at: diagnosticValue("send_clicked_at"),
        primary_reason: primaryReason,
        cleanup_reason: diagnosticValue("cleanup_reason"),
        verification_mode: diagnosticValue("verification_mode"),
        real_action_attempted: diagnosticValue("real_action_attempted"),
        error: result?.error || "",
        process_pid: child.pid || 0,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        diagnostics: diagnosticValue("diagnostics") ?? null
      }, { ok: result?.ok === true, code: primaryReason });
      resolve(result);
    };
    const settleFromOutput = (status) => {
      settle(parseExecutorOutput({ action: args[0] ?? "status", status, stdout, stderr }));
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      settle(parseExecutorOutput({ action: args[0] ?? "status", error }));
    });

    child.on("exit", (status) => {
      if (settled) return;
      exitDrain = setTimeout(() => settleFromOutput(status), EXECUTOR_STDIO_DRAIN_MS);
    });

    child.on("close", (status) => settleFromOutput(status));

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        settle(executorFailure(args[0] ?? "status", "executor_timeout", "微信执行器运行超时"));
        try {
          child.kill();
        } catch {}
      }, timeoutMs);
    }
  });
}

async function runActiveTouch(args, options = {}) {
  const command = args[0] ?? "status";
  if (command === "status") return executeActiveTouch(args, options);

  if (options.owner) {
    const updated = runtimeCoordinator?.update(options.owner, options.phase || command);
    if (updated && !updated.ok) return { ok: false, action: command, blocked_reason: updated.error, error: "微信操作锁已失效", logs: [] };
    return executeActiveTouch(args, options);
  }

  const lock = runtimeCoordinator?.acquire({ state: "preparing_campaign", taskId: "", account: "unknown", phase: `developer:${command}` });
  if (lock && !lock.ok) return { ok: false, action: command, blocked_reason: lock.error, error: "当前正在进行联系人同步或主动触达，开发命令已禁用", logs: [] };
  try {
    return await executeActiveTouch(args, options);
  } finally {
    if (lock?.lock?.owner) runtimeCoordinator?.release(lock.lock.owner);
  }
}

function runActiveTouchDev(args, options = {}) {
  return runActiveTouch(args, { ...options, development: true });
}

function configureActiveTouchRuntime({ dataDir, coordinator } = {}) {
  runtimeDataDir = String(dataDir || "");
  runtimeCoordinator = coordinator;
}

module.exports = { configureActiveTouchRuntime, parseExecutorOutput, runActiveTouch, runActiveTouchDev };
