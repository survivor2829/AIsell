const { ipcMain } = require("electron");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");
const { executeVerifiedContactSend, setRealSendArm } = require("../../rpa/active_touch/state_machine.dev.cjs");
const { MAX_MOMENTS_COMMENT_LENGTH } = require("../../rpa/active_touch/moments_dry_run.dev.cjs");

const MOMENTS_DRY_RUN_TIMEOUT_MS = 45_000;
const MOMENTS_INSPECT_TIMEOUT_MS = 125_000;

let realSendInFlight = false;
let momentsActionInFlight = false;
let activeTouchDataDir = "";
let momentsDataDir = "";
let runtimeCoordinator = null;
let getMainWindow = () => null;
const consumedClickTokens = new Set();

const MOMENTS_ACTIONS = {
  inspect: {
    channel: "active-touch:dev-moments-inspect-menu",
    action: "moments-inspect-menu",
    clickIntent: "moments-inspect",
    timeoutMs: MOMENTS_INSPECT_TIMEOUT_MS
  },
  like: {
    channel: "active-touch:dev-moments-like",
    action: "moments-like",
    clickIntent: "moments-like"
  },
  comment: {
    channel: "active-touch:dev-moments-comment",
    action: "moments-comment",
    clickIntent: "moments-comment"
  }
};

function rememberClickToken(clickToken) {
  consumedClickTokens.add(clickToken);
  if (consumedClickTokens.size > 100) consumedClickTokens.delete(consumedClickTokens.values().next().value);
}

function trustedFocusedClick(event, payload, clickIntent) {
  const mainWindow = getMainWindow();
  const clickToken = String(payload.clickToken ?? "");
  const prefix = `${clickIntent}:`;
  if (
    !clickToken.startsWith(prefix)
    || clickToken.length === prefix.length
    || consumedClickTokens.has(clickToken)
    || !mainWindow
    || mainWindow.isDestroyed()
    || event?.sender !== mainWindow.webContents
    || !mainWindow.isFocused()
  ) return "";
  rememberClickToken(clickToken);
  return clickToken;
}

function blockedMomentsAction(action, blockedReason, error, attempted = false) {
  return {
    ok: false,
    action,
    status: attempted === null ? "outcome_unknown" : "blocked",
    blocked_reason: blockedReason,
    error,
    real_action_attempted: attempted
  };
}

function refocusMainWindow() {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (typeof mainWindow.show === "function") mainWindow.show();
    if (typeof mainWindow.focus === "function") mainWindow.focus();
  } catch {
    // The read-only result remains authoritative if the window closes during cleanup.
  }
}

function refocusMainWindowAfterInspect(definition) {
  if (definition === MOMENTS_ACTIONS.inspect) refocusMainWindow();
}

async function runMomentsAction(event, payload, definition) {
  if (!trustedFocusedClick(event, payload, definition.clickIntent)) {
    return blockedMomentsAction(definition.action, "trusted_user_click_required", "已阻断：请在测试版主窗口本人点击对应的朋友圈按钮");
  }
  if (momentsActionInFlight) {
    return blockedMomentsAction(definition.action, "moments_action_in_flight", "已阻断：另一项朋友圈操作正在执行");
  }
  const observationId = String(payload.observationId ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(observationId)) {
    return blockedMomentsAction(definition.action, "moments_observation_required", "已阻断：请先重新完成朋友圈安全预演");
  }
  const options = { baseDir: momentsDataDir, observationId };
  if (definition === MOMENTS_ACTIONS.comment) {
    const commentText = String(payload.commentText ?? "").trim();
    if (!commentText) {
      return blockedMomentsAction(definition.action, "moments_comment_missing", "已阻断：评论文案不能为空");
    }
    if (commentText.length > MAX_MOMENTS_COMMENT_LENGTH) {
      return blockedMomentsAction(definition.action, "moments_comment_too_long", `已阻断：评论文案不能超过 ${MAX_MOMENTS_COMMENT_LENGTH} 个字符`);
    }
    options.commentText = commentText;
  }
  if (typeof runtimeCoordinator?.acquire !== "function" || typeof runtimeCoordinator?.release !== "function") {
    return blockedMomentsAction(definition.action, "runtime_coordinator_unavailable", "已阻断：微信运行锁不可用");
  }
  let lock;
  try {
    lock = runtimeCoordinator.acquire({
      state: "preparing_campaign",
      taskId: "",
      account: "unknown",
      phase: `developer:${definition.action}`
    });
  } catch {
    return blockedMomentsAction(definition.action, "runtime_coordinator_failed", "已阻断：微信运行锁获取失败");
  }
  if (!lock?.ok || !lock.lock?.owner) {
    return blockedMomentsAction(
      definition.action,
      lock?.error || "wechat_operation_busy",
      "已阻断：当前正在执行联系人同步、主动触达或自动回复"
    );
  }
  momentsActionInFlight = true;
  try {
    const args = [definition.action, "--observation-id", observationId];
    if (definition === MOMENTS_ACTIONS.comment) {
      args.push("--comment-text-base64", Buffer.from(options.commentText, "utf8").toString("base64"));
    }
    const result = await runActiveTouchDev(args, {
      cliName: "moments_action_cli.dev.cjs",
      dataDir: momentsDataDir,
      owner: lock.lock.owner,
      phase: `developer:${definition.action}`,
      ...(definition.timeoutMs ? { timeoutMs: definition.timeoutMs } : {})
    });
    if (result?.ok === false && String(result.blocked_reason || "").startsWith("executor_")) {
      const definitelyNotAttempted = definition === MOMENTS_ACTIONS.inspect || result.blocked_reason === "executor_spawn_failed";
      return blockedMomentsAction(
        definition.action,
        result.blocked_reason,
        result.error || "朋友圈隔离执行器未返回可验证结果",
        definitelyNotAttempted ? false : null
      );
    }
    return result;
  } catch (error) {
    return blockedMomentsAction(
      definition.action,
      "moments_action_failed",
      error instanceof Error ? error.message : "朋友圈操作执行失败",
      null
    );
  } finally {
    momentsActionInFlight = false;
    try {
      runtimeCoordinator.release(lock.lock.owner);
    } catch {
      // Keep the action result authoritative; a stale lock fails closed for later work.
    }
    refocusMainWindowAfterInspect(definition);
  }
}

function registerActiveTouchDevIpc(options = {}) {
  activeTouchDataDir = String(options.activeTouchDir ?? options.dataDir ?? "");
  momentsDataDir = String(options.momentsDir ?? activeTouchDataDir);
  runtimeCoordinator = options.coordinator ?? null;
  getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
  ipcMain.handle("active-touch:dev-calibrate", () => runActiveTouchDev(["calibrate"]));
  ipcMain.handle("active-touch:dev-moments-dry-run", (_event, payload = {}) => {
    const args = ["moments-dry-run", "--mode", String(payload.mode ?? "")];
    if (payload.likeEnabled === true) args.push("--like");
    if (payload.commentEnabled === true) {
      const commentText = String(payload.commentText ?? "").trim();
      if (commentText.length > MAX_MOMENTS_COMMENT_LENGTH) {
        return {
          ok: false,
          action: "moments-dry-run",
          blocked_reason: "moments_comment_too_long",
          dry_run: true,
          error: `已阻断：评论文案不能超过 ${MAX_MOMENTS_COMMENT_LENGTH} 个字符`,
          real_action_attempted: false
        };
      }
      args.push("--comment-enabled", "--comment-text-base64", Buffer.from(commentText, "utf8").toString("base64"));
    }
    return runActiveTouchDev(args, { cliName: "moments_dry_run_cli.dev.cjs", dataDir: momentsDataDir, timeoutMs: MOMENTS_DRY_RUN_TIMEOUT_MS })
      .finally(refocusMainWindow);
  });
  Object.values(MOMENTS_ACTIONS).forEach((definition) => {
    ipcMain.handle(definition.channel, (event, payload = {}) => runMomentsAction(event, payload, definition));
  });
  ipcMain.handle("active-touch:dev-select-customer", (_event, payload = {}) =>
    runActiveTouchDev(["select-customer", "--id", String(payload.id ?? "")])
  );
  ipcMain.handle("active-touch:dev-click-search-result", () => runActiveTouchDev(["click-search-result-dry-run"]));
  ipcMain.handle("active-touch:dev-input-message", (_event, payload = {}) =>
    runActiveTouchDev(["input-message-dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:dev-send-dry-run", (_event, payload = {}) =>
    runActiveTouchDev(["send", "--dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:send-selected-contact", async (event, payload = {}) => {
    const mainWindow = getMainWindow();
    const clickToken = String(payload.clickToken ?? "");
    if (!clickToken || consumedClickTokens.has(clickToken) || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) {
      return { ok: false, action: "send", blocked_reason: "trusted_user_click_required", error: "已阻断：请在测试版窗口本人点击发送", send_attempted: false };
    }
    rememberClickToken(clickToken);
    if (realSendInFlight) return { ok: false, action: "send", blocked_reason: "real_send_in_flight", error: "已阻断：真实发送正在确认中", send_attempted: false };
    const contactId = String(payload.contactId ?? "").trim();
    const message = String(payload.message ?? "").trim();
    if (!contactId || !message) return { ok: false, action: "send", blocked_reason: "contact_or_message_missing", error: "已阻断：请选择联系人并填写发送文案", send_attempted: false };
    realSendInFlight = true;
    try {
      return await executeVerifiedContactSend({
        baseDir: activeTouchDataDir,
        contactId,
        message,
        authorized: true,
        runStep: (command, args = []) => runActiveTouchDev([command, ...args])
      });
    } catch (error) {
      setRealSendArm(activeTouchDataDir, false);
      return { ok: false, action: "send", blocked_reason: "real_send_failed", error: error instanceof Error ? error.message : "真实发送执行失败", send_attempted: null };
    } finally {
      realSendInFlight = false;
    }
  });
  ipcMain.handle("active-touch:set-real-send-arm", (_event, payload = {}) =>
    runActiveTouchDev(["set-real-send-arm", payload.enabled ? "--on" : "--off"])
  );
  ipcMain.handle("active-touch:fail-conversation", () => runActiveTouchDev(["fail-conversation"]));
  ipcMain.handle("active-touch:verify-real-send-session", () => runActiveTouchDev(["verify-real-send-session"]));
}

function disarmRealSend(dataDir) {
  return setRealSendArm(dataDir, false);
}

module.exports = { disarmRealSend, registerActiveTouchDevIpc };
