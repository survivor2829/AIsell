const { ipcMain } = require("electron");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");
const { executeVerifiedContactSend, setRealSendArm } = require("../../rpa/active_touch/state_machine.dev.cjs");
const { MAX_MOMENTS_COMMENT_LENGTH } = require("../../rpa/active_touch/moments_dry_run.dev.cjs");
const { loadMomentsActionContext } = require("../../rpa/active_touch/moments_action.dev.cjs");
const { openWechatMoments } = require("../../rpa/active_touch/moments_navigation.dev.cjs");
const { diagnostics } = require("./diagnostics.cjs");

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

function finiteNumber(value, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? numeric : undefined;
}

function finiteInteger(value, minimum, maximum) {
  const numeric = finiteNumber(value, minimum, maximum);
  return numeric === undefined ? undefined : Math.round(numeric);
}

function sanitizeMomentsBounds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const left = finiteNumber(value.left, -100_000, 100_000);
  const top = finiteNumber(value.top, -100_000, 100_000);
  const width = finiteNumber(value.width, 0, 100_000);
  const height = finiteNumber(value.height, 0, 100_000);
  if ([left, top, width, height].some((entry) => entry === undefined)) return undefined;
  return { left, top, width, height };
}

function sanitizeMomentsDiscoverCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const bounds = sanitizeMomentsBounds(value.bounds);
  const centerX = finiteNumber(value.centerX, -100_000, 100_000);
  const centerY = finiteNumber(value.centerY, -100_000, 100_000);
  const activePixelCount = finiteInteger(value.activePixelCount, 0, 1_000_000);
  const fillRatio = finiteNumber(value.fillRatio, 0, 1);
  const aspectRatio = finiteNumber(value.aspectRatio, 0, 100);
  const cornerRatio = finiteNumber(value.cornerRatio, 0, 1);
  const ringRatio = finiteNumber(value.ringRatio, 0, 1);
  const diagonalContrast = finiteNumber(value.diagonalContrast, 0, 1);
  const greenRatio = finiteNumber(value.greenRatio, 0, 1);
  if (!bounds || [centerX, centerY, activePixelCount, fillRatio, aspectRatio, cornerRatio, ringRatio,
    diagonalContrast, greenRatio].some((entry) => entry === undefined)) return undefined;
  return {
    bounds,
    centerX,
    centerY,
    activePixelCount,
    fillRatio,
    aspectRatio,
    cornerRatio,
    ringRatio,
    diagonalContrast,
    greenRatio,
    matched: value.matched === true,
    selected: value.selected === true
  };
}

function sanitizeMomentsNavigationDiagnostics(value) {
  const source = value?.discover;
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const region = sanitizeMomentsBounds(source.region);
  const dpi = finiteInteger(source.dpi, 72, 480);
  const scale = finiteNumber(source.scale, 0.75, 5);
  const activePixelCount = finiteInteger(source.activePixelCount, 0, 2_000_000);
  const candidateCount = finiteInteger(source.candidateCount, 0, 100);
  const exactMatchCount = finiteInteger(source.exactMatchCount, 0, 100);
  const selectedMatchCount = finiteInteger(source.selectedMatchCount, 0, 100);
  const candidates = Array.isArray(source.candidates)
    ? source.candidates.slice(0, 8).map(sanitizeMomentsDiscoverCandidate).filter(Boolean)
    : [];
  if (!region || [dpi, scale, activePixelCount, candidateCount, exactMatchCount, selectedMatchCount]
    .some((entry) => entry === undefined)) return undefined;
  return {
    discover: {
      dpi,
      scale,
      region,
      activePixelCount,
      candidateCount,
      exactMatchCount,
      selectedMatchCount,
      candidates
    }
  };
}

function recordMomentsNavigationBlock(action, phase, reason, rawDiagnostics) {
  const safeDiagnostics = sanitizeMomentsNavigationDiagnostics(rawDiagnostics);
  diagnostics().event("wechat_adapter", "moments_navigation_blocked", {
    action,
    reason,
    real_action_attempted: false,
    ...(safeDiagnostics ? { diagnostics: safeDiagnostics } : {})
  }, { level: "warn", code: reason, phase });
  return safeDiagnostics;
}

function blockedMomentsAction(action, blockedReason, error, attempted = false, rawDiagnostics) {
  const safeDiagnostics = sanitizeMomentsNavigationDiagnostics(rawDiagnostics);
  return {
    ok: false,
    action,
    status: attempted === null ? "outcome_unknown" : "blocked",
    blocked_reason: blockedReason,
    error,
    real_action_attempted: attempted,
    ...(safeDiagnostics ? { diagnostics: safeDiagnostics } : {})
  };
}

function blockedMomentsDryRun(blockedReason, error, rawDiagnostics) {
  return {
    ...blockedMomentsAction("moments-dry-run", blockedReason, error, false, rawDiagnostics),
    dry_run: true
  };
}

function momentsNavigationError(reason) {
  const messages = {
    wechat_user_active: "检测到你正在使用鼠标或键盘，本次预演已停止；方便时重新点击即可",
    wechat_window_not_ready: "微信窗口暂时无法固定到左上角，请确认微信已登录且主窗口可见",
    wechat_window_not_foreground: "微信窗口未能取得前台焦点，本次没有继续操作",
    moments_discover_entry_ambiguous: "新版微信中识别到多个“发现”入口，为避免点错已停止",
    moments_discover_entry_not_found: "未能唯一识别新版微信侧栏的“发现”图标，本次没有点击",
    moments_discover_entry_not_owned: "识别到的“发现”图标不属于已绑定微信窗口，本次没有点击",
    moments_discover_open_timeout: "已打开“发现”，但未能在时限内唯一识别“朋友圈”；尚未执行后续动作",
    moments_entry_ambiguous: "新版微信中识别到多个朋友圈入口，为避免点错已停止",
    moments_entry_not_found: "未能唯一识别新版微信的朋友圈入口，本次没有点击"
  };
  return messages[reason] || `朋友圈导航预检未通过：${reason}`;
}

async function runMomentsDryRun(payload = {}) {
  const args = ["moments-dry-run", "--mode", String(payload.mode ?? "")];
  if (payload.likeEnabled === true) args.push("--like");
  if (payload.commentEnabled === true) {
    const commentText = String(payload.commentText ?? "").trim();
    if (commentText.length > MAX_MOMENTS_COMMENT_LENGTH) {
      return blockedMomentsDryRun(
        "moments_comment_too_long",
        `已阻断：评论文案不能超过 ${MAX_MOMENTS_COMMENT_LENGTH} 个字符`
      );
    }
    args.push("--comment-enabled", "--comment-text-base64", Buffer.from(commentText, "utf8").toString("base64"));
  }
  if (momentsActionInFlight) {
    return blockedMomentsDryRun("moments_action_in_flight", "已阻断：另一项朋友圈操作正在执行");
  }
  if (typeof runtimeCoordinator?.acquire !== "function" || typeof runtimeCoordinator?.release !== "function") {
    return blockedMomentsDryRun("runtime_coordinator_unavailable", "已阻断：微信运行锁不可用");
  }
  let lock;
  try {
    lock = runtimeCoordinator.acquire({
      state: "preparing_campaign",
      taskId: "",
      account: "unknown",
      phase: "developer:moments-dry-run"
    });
  } catch {
    return blockedMomentsDryRun("runtime_coordinator_failed", "已阻断：微信运行锁获取失败");
  }
  if (!lock?.ok || !lock.lock?.owner) {
    return blockedMomentsDryRun(
      lock?.error || "wechat_operation_busy",
      "已阻断：当前正在执行联系人同步、主动触达或自动回复"
    );
  }

  momentsActionInFlight = true;
  try {
    const opened = await openWechatMoments({ allowIntegrated: true, minIdleMs: 0 });
    if (!opened?.ok) {
      const reason = String(opened?.reason || opened?.blocked_reason || "moments_window_not_found");
      recordMomentsNavigationBlock("moments-dry-run", "developer:moments-dry-run", reason, opened?.diagnostics);
      return blockedMomentsDryRun(reason, momentsNavigationError(reason), opened?.diagnostics);
    }
    args.push(
      "--expected-window-base64",
      Buffer.from(JSON.stringify(opened), "utf8").toString("base64")
    );
    return await runActiveTouchDev(args, {
      cliName: "moments_dry_run_cli.dev.cjs",
      dataDir: momentsDataDir,
      owner: lock.lock.owner,
      phase: "developer:moments-dry-run",
      timeoutMs: MOMENTS_DRY_RUN_TIMEOUT_MS
    });
  } catch (error) {
    return blockedMomentsDryRun(
      "moments_dry_run_failed",
      error instanceof Error ? error.message : "朋友圈安全预演执行失败"
    );
  } finally {
    momentsActionInFlight = false;
    try {
      runtimeCoordinator.release(lock.lock.owner);
    } catch {
      // Keep the read-only result authoritative; a stale lock fails closed later.
    }
  }
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
    const actionContext = loadMomentsActionContext(momentsDataDir, observationId);
    if (!actionContext?.ok) {
      return blockedMomentsAction(
        definition.action,
        String(actionContext?.reason || "moments_observation_required"),
        "已阻断：朋友圈安全预演已失效，请重新检查并生成预演"
      );
    }
    const handedOff = await openWechatMoments({
      allowIntegrated: true,
      minIdleMs: 0,
      expectedWindow: actionContext.expectedWindow
    });
    if (!handedOff?.ok) {
      const reason = String(handedOff?.reason || handedOff?.blocked_reason || "moments_window_not_found");
      recordMomentsNavigationBlock(definition.action, `developer:${definition.action}`, reason, handedOff?.diagnostics);
      return blockedMomentsAction(definition.action, reason, momentsNavigationError(reason), false, handedOff?.diagnostics);
    }
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
  }
}

function registerActiveTouchDevIpc(options = {}) {
  activeTouchDataDir = String(options.activeTouchDir ?? options.dataDir ?? "");
  momentsDataDir = String(options.momentsDir ?? activeTouchDataDir);
  runtimeCoordinator = options.coordinator ?? null;
  getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
  ipcMain.handle("active-touch:dev-calibrate", () => runActiveTouchDev(["calibrate"]));
  ipcMain.handle("active-touch:dev-moments-dry-run", (_event, payload = {}) => runMomentsDryRun(payload));
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
