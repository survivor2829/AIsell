const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { MAX_MOMENTS_COMMENT_LENGTH } = require("../../rpa/active_touch/moments_dry_run.dev.cjs");

const handlers = new Map();
const runnerCalls = [];
const armCalls = [];
const executeCalls = [];
const coordinatorEvents = [];
const momentsOpenCalls = [];
const momentsContextCalls = [];
const diagnosticEvents = [];
let coordinatorBusy = false;
let coordinatorOwner = 0;
let coordinatorActiveOwner = "";
let runBehavior = async (args, options) => {
  runnerCalls.push({ args, options });
  return { ok: true, action: args[0] };
};
let executeBehavior = async (options) => {
  executeCalls.push(options);
  return { ok: true, action: "send", state: { real_send_status: "sent_verified" } };
};
let momentsOpenBehavior = async (options) => {
  momentsOpenCalls.push(options);
  return {
    ok: true,
    action: "moments-open",
    surfaceMode: "integrated",
    pid: 42,
    hWnd: "84",
    title: "微信",
    className: "mmui::MainWindow",
    x: 0,
    y: 0,
    width: 1064,
    height: 686,
    dpi: 96,
    focused: true,
    normalized: true,
    layoutMode: "stable_target"
  };
};
let momentsContextBehavior = (baseDir, observationId) => {
  momentsContextCalls.push({ baseDir, observationId });
  return {
    ok: true,
    expectedWindow: {
      pid: 42,
      hWnd: "84",
      left: 0,
      top: 0,
      width: 1064,
      height: 686
    }
  };
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "./active-touch-ipc.cjs") return { runActiveTouchDev: (args, options) => runBehavior(args, options) };
  if (request === "../../rpa/active_touch/state_machine.dev.cjs") {
    return {
      executeVerifiedContactSend: (options) => executeBehavior(options),
      setRealSendArm: (dataDir, enabled) => {
        armCalls.push([dataDir, enabled]);
        return { ok: true, action: "set-real-send-arm" };
      }
    };
  }
  if (request === "../../rpa/active_touch/moments_dry_run.dev.cjs") return { MAX_MOMENTS_COMMENT_LENGTH };
  if (request === "../../rpa/active_touch/moments_action.dev.cjs") {
    return { loadMomentsActionContext: (baseDir, observationId) => momentsContextBehavior(baseDir, observationId) };
  }
  if (request === "../../rpa/active_touch/moments_navigation.dev.cjs") {
    return { openWechatMoments: (options) => momentsOpenBehavior(options) };
  }
  if (request === "./diagnostics.cjs") {
    return { diagnostics: () => ({ event: (...args) => diagnosticEvents.push(args) }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "active-touch-dev-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const { registerActiveTouchDevIpc } = require(modulePath);
Module._load = originalLoad;

const webContents = { id: 7 };
let focused = true;
let mainWindowShowCalls = 0;
let mainWindowFocusCalls = 0;
const mainWindow = {
  webContents,
  isDestroyed: () => false,
  isFocused: () => focused,
  show: () => { mainWindowShowCalls += 1; },
  focus: () => { mainWindowFocusCalls += 1; focused = true; }
};
const coordinator = {
  acquire: (details) => {
    coordinatorEvents.push(["acquire", details]);
    if (coordinatorBusy || coordinatorActiveOwner) return { ok: false, error: "wechat_operation_busy" };
    coordinatorActiveOwner = `moments-owner-${++coordinatorOwner}`;
    return { ok: true, lock: { owner: coordinatorActiveOwner } };
  },
  release: (owner) => {
    coordinatorEvents.push(["release", owner]);
    assert.equal(owner, coordinatorActiveOwner, "the runtime coordinator must release its active owner");
    coordinatorActiveOwner = "";
    return { ok: true };
  }
};

registerActiveTouchDevIpc({
  activeTouchDir: "test-data",
  momentsDir: "moments-data",
  coordinator,
  getMainWindow: () => mainWindow
});
const sendSelected = handlers.get("active-touch:send-selected-contact");
const momentsDryRun = handlers.get("active-touch:dev-moments-dry-run");
const momentsInspect = handlers.get("active-touch:dev-moments-inspect-menu");
const momentsLike = handlers.get("active-touch:dev-moments-like");
const momentsComment = handlers.get("active-touch:dev-moments-comment");

(async () => {
  const observationId = "a".repeat(64);

  const oversizedDryRun = await momentsDryRun({}, {
    mode: "targeted",
    commentEnabled: true,
    commentText: "x".repeat(MAX_MOMENTS_COMMENT_LENGTH + 1)
  });
  assert.equal(oversizedDryRun.blocked_reason, "moments_comment_too_long");
  assert.deepEqual(runnerCalls, []);

  let resolveDryRun;
  runBehavior = (args, options) => {
    runnerCalls.push({ args, options });
    return new Promise((resolve) => { resolveDryRun = resolve; });
  };
  const pendingDryRun = momentsDryRun({}, {
    mode: "targeted",
    likeEnabled: true,
    commentEnabled: true,
    commentText: " 您好 "
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mainWindowShowCalls, 0, "preview must not refocus before its worker settles");
  assert.equal(mainWindowFocusCalls, 0, "preview must not refocus before its worker settles");
  resolveDryRun({ ok: true, action: "moments-dry-run" });
  assert.equal((await pendingDryRun).ok, true);
  assert.equal(mainWindowShowCalls, 0, "preview completion must not steal the user's foreground window");
  assert.equal(mainWindowFocusCalls, 0, "preview completion must not steal focus");
  assert.equal(momentsOpenCalls.length, 1);
  assert.deepEqual(momentsOpenCalls[0], { allowIntegrated: true, minIdleMs: 0 });
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(runnerCalls[0].args.slice(0, 7), [
    "moments-dry-run",
    "--mode",
    "targeted",
    "--like",
    "--comment-enabled",
    "--comment-text-base64",
    Buffer.from("您好", "utf8").toString("base64")
  ]);
  assert.equal(runnerCalls[0].args[7], "--expected-window-base64");
  const expectedWindow = JSON.parse(Buffer.from(runnerCalls[0].args[8], "base64").toString("utf8"));
  assert.equal(expectedWindow.surfaceMode, "integrated");
  assert.equal(expectedWindow.pid, 42);
  assert.equal(expectedWindow.hWnd, "84");
  assert.equal(expectedWindow.normalized, true);
  momentsOpenCalls.length = 0;
  assert.deepEqual(runnerCalls[0].options, {
    cliName: "moments_dry_run_cli.dev.cjs",
    dataDir: "moments-data",
    owner: "moments-owner-1",
    phase: "developer:moments-dry-run",
    timeoutMs: 45000
  });
  assert.equal(coordinatorEvents[0][1].phase, "developer:moments-dry-run");
  assert.deepEqual(coordinatorEvents[1], ["release", "moments-owner-1"]);
  runnerCalls.length = 0;
  coordinatorEvents.length = 0;
  coordinatorOwner = 0;
  runBehavior = async (args, options) => {
    runnerCalls.push({ args, options });
    return { ok: true, action: args[0] };
  };

  assert.equal((await momentsInspect({ sender: webContents }, { observationId, clickToken: "" })).blocked_reason, "trusted_user_click_required");
  assert.equal((await momentsInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-like:wrong-intent"
  })).blocked_reason, "trusted_user_click_required");
  assert.equal((await momentsInspect({ sender: { id: 8 } }, {
    observationId,
    clickToken: "moments-inspect:wrong-sender"
  })).blocked_reason, "trusted_user_click_required");
  focused = false;
  assert.equal((await momentsInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-inspect:unfocused"
  })).blocked_reason, "trusted_user_click_required");
  focused = true;
  assert.equal((await momentsInspect({ sender: webContents }, {
    observationId: "",
    clickToken: "moments-inspect:missing-observation"
  })).blocked_reason, "moments_observation_required");
  assert.deepEqual(runnerCalls, []);

  const inspectToken = "moments-inspect:inspect-1";
  assert.equal((await momentsInspect({ sender: webContents }, { observationId, clickToken: inspectToken })).ok, true);
  assert.deepEqual(momentsContextCalls[0], { baseDir: "moments-data", observationId });
  assert.deepEqual(momentsOpenCalls[0], {
    allowIntegrated: true,
    minIdleMs: 0,
    expectedWindow: {
      pid: 42,
      hWnd: "84",
      left: 0,
      top: 0,
      width: 1064,
      height: 686
    }
  });
  assert.deepEqual(runnerCalls, [{
    args: ["moments-inspect-menu", "--observation-id", observationId],
    options: {
      cliName: "moments_action_cli.dev.cjs",
      dataDir: "moments-data",
      owner: "moments-owner-1",
      phase: "developer:moments-inspect-menu",
      timeoutMs: 125000
    }
  }]);
  assert.equal(coordinatorEvents[0][1].phase, "developer:moments-inspect-menu");
  assert.deepEqual(coordinatorEvents[1], ["release", "moments-owner-1"]);
  assert.equal(mainWindowShowCalls, 0, "menu inspection completion must not show the app over the user's work");
  assert.equal(mainWindowFocusCalls, 0, "menu inspection completion must not steal focus");
  assert.equal((await momentsInspect({ sender: webContents }, { observationId, clickToken: inspectToken })).blocked_reason, "trusted_user_click_required");

  coordinatorBusy = true;
  assert.equal((await momentsInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-inspect:busy"
  })).blocked_reason, "wechat_operation_busy");
  coordinatorBusy = false;
  assert.equal(runnerCalls.length, 1);

  assert.equal((await momentsComment({ sender: webContents }, {
    observationId,
    clickToken: "moments-comment:missing",
    commentText: "  "
  })).blocked_reason, "moments_comment_missing");
  assert.equal((await momentsComment({ sender: webContents }, {
    observationId,
    clickToken: "moments-comment:oversized",
    commentText: "x".repeat(MAX_MOMENTS_COMMENT_LENGTH + 1)
  })).blocked_reason, "moments_comment_too_long");

  assert.equal((await momentsComment({ sender: webContents }, {
    observationId,
    clickToken: "moments-comment:comment-1",
    commentText: " 您好 "
  })).ok, true);
  assert.deepEqual(runnerCalls.at(-1), {
    args: [
      "moments-comment",
      "--observation-id",
      observationId,
      "--comment-text-base64",
      Buffer.from("您好", "utf8").toString("base64")
    ],
    options: {
      cliName: "moments_action_cli.dev.cjs",
      dataDir: "moments-data",
      owner: "moments-owner-2",
      phase: "developer:moments-comment"
    }
  });

  let releaseMomentsLike;
  runBehavior = (args, options) => {
    runnerCalls.push({ args, options });
    return new Promise((resolve) => {
      releaseMomentsLike = () => resolve({ ok: true, action: "moments-like" });
    });
  };
  runnerCalls.length = 0;
  const pendingLike = momentsLike({ sender: webContents }, {
    observationId,
    clickToken: "moments-like:like-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(coordinatorActiveOwner, /^moments-owner-/u);
  assert.equal((await momentsInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-inspect:in-flight"
  })).blocked_reason, "moments_action_in_flight");
  assert.deepEqual(runnerCalls[0].args, ["moments-like", "--observation-id", observationId]);
  assert.equal(runnerCalls[0].options.timeoutMs, undefined, "real actions must not be hard-killed during verification");
  releaseMomentsLike();
  await pendingLike;
  assert.equal(coordinatorActiveOwner, "");

  runBehavior = async (args, options) => {
    runnerCalls.push({ args, options });
    throw new Error("worker crashed");
  };
  const crashedComment = await momentsComment({ sender: webContents }, {
    observationId,
    clickToken: "moments-comment:crash",
    commentText: "您好"
  });
  assert.equal(crashedComment.blocked_reason, "moments_action_failed");
  assert.equal(crashedComment.status, "outcome_unknown");
  assert.equal(crashedComment.real_action_attempted, null);
  assert.equal(coordinatorActiveOwner, "");

  runBehavior = async (args, options) => {
    runnerCalls.push({ args, options });
    return { ok: false, action: args[0], blocked_reason: "executor_timeout", error: "worker timeout" };
  };
  const timedOutInspect = await momentsInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-inspect:timeout"
  });
  assert.equal(timedOutInspect.status, "blocked");
  assert.equal(timedOutInspect.real_action_attempted, false);
  assert.equal(mainWindowShowCalls, 0, "inspection timeout must remain passive");
  assert.equal(mainWindowFocusCalls, 0, "inspection timeout must not steal focus");
  const timedOutComment = await momentsComment({ sender: webContents }, {
    observationId,
    clickToken: "moments-comment:timeout",
    commentText: "另一条测试"
  });
  assert.equal(timedOutComment.status, "outcome_unknown");
  assert.equal(timedOutComment.real_action_attempted, null);

  runBehavior = async (args, options) => {
    runnerCalls.push({ args, options });
    return { ok: true, action: args[0] };
  };
  runnerCalls.length = 0;

  assert.equal((await sendSelected({ sender: webContents }, {
    clickToken: "",
    contactId: "c1",
    message: "hello"
  })).blocked_reason, "trusted_user_click_required");
  assert.equal((await sendSelected({ sender: webContents }, {
    clickToken: "send-missing",
    contactId: "",
    message: "hello"
  })).blocked_reason, "contact_or_message_missing");

  assert.equal((await sendSelected({ sender: webContents }, {
    clickToken: "send-1",
    contactId: "c1",
    message: " hello "
  })).ok, true);
  assert.equal(executeCalls[0].contactId, "c1");
  assert.equal(executeCalls[0].message, "hello");
  assert.equal(executeCalls[0].authorized, true);
  await executeCalls[0].runStep("calibrate", []);
  assert.deepEqual(runnerCalls, [{ args: ["calibrate"], options: undefined }]);

  executeBehavior = async () => { throw new Error("send driver crashed"); };
  const crashedSend = await sendSelected({ sender: webContents }, {
    clickToken: "send-2",
    contactId: "c1",
    message: "hello"
  });
  assert.equal(crashedSend.blocked_reason, "real_send_failed");
  assert.equal(crashedSend.send_attempted, null);
  assert.deepEqual(armCalls.at(-1), ["test-data", false]);

  const runnerCallsBeforeNavigationBlock = runnerCalls.length;
  const refocusCallsBeforeNavigationBlock = mainWindowFocusCalls;
  momentsOpenBehavior = async (options) => {
    momentsOpenCalls.push(options);
    return { ok: false, reason: "wechat_user_active" };
  };
  const navigationBlockedDryRun = await momentsDryRun({}, {
    mode: "targeted",
    likeEnabled: true
  });
  assert.equal(navigationBlockedDryRun.blocked_reason, "wechat_user_active");
  assert.equal(navigationBlockedDryRun.real_action_attempted, false);
  assert.equal(runnerCalls.length, runnerCallsBeforeNavigationBlock, "blocked navigation must not start the dry-run worker");
  assert.equal(coordinatorActiveOwner, "", "blocked navigation must release the WeChat runtime lock");
  assert.equal(mainWindowFocusCalls, refocusCallsBeforeNavigationBlock, "blocked navigation must not steal the user's screen");

  diagnosticEvents.length = 0;
  momentsOpenBehavior = async (options) => {
    momentsOpenCalls.push(options);
    return {
      ok: false,
      reason: "moments_discover_entry_not_found",
      diagnostics: {
        discover: {
          dpi: 120,
          scale: 1.25,
          region: { left: 8, top: 80, width: 44, height: 260 },
          activePixelCount: 412,
          candidateCount: 4,
          exactMatchCount: 0,
          selectedMatchCount: 0,
          screenshot_base64: "must-not-survive",
          ocr_text: "must-not-survive",
          candidates: [{
            bounds: { left: 24, top: 310, width: 26, height: 26 },
            centerX: 37,
            centerY: 323,
            activePixelCount: 178,
            fillRatio: 0.424,
            aspectRatio: 1.05,
            cornerRatio: 0.029,
            ringRatio: 0.636,
            diagonalContrast: 0.243,
            greenRatio: 0,
            matched: false,
            selected: false,
            raw_pixels: "must-not-survive",
            contact_name: "must-not-survive"
          }]
        },
        raw_pixels: "must-not-survive"
      }
    };
  };
  const diagnosticBlockedDryRun = await momentsDryRun({}, { mode: "targeted", likeEnabled: true });
  assert.equal(diagnosticBlockedDryRun.blocked_reason, "moments_discover_entry_not_found");
  assert.deepEqual(diagnosticBlockedDryRun.diagnostics, {
    discover: {
      dpi: 120,
      scale: 1.25,
      region: { left: 8, top: 80, width: 44, height: 260 },
      activePixelCount: 412,
      candidateCount: 4,
      exactMatchCount: 0,
      selectedMatchCount: 0,
      candidates: [{
        bounds: { left: 24, top: 310, width: 26, height: 26 },
        centerX: 37,
        centerY: 323,
        activePixelCount: 178,
        fillRatio: 0.424,
        aspectRatio: 1.05,
        cornerRatio: 0.029,
        ringRatio: 0.636,
        diagonalContrast: 0.243,
        greenRatio: 0,
        matched: false,
        selected: false
      }]
    }
  });
  assert.equal(JSON.stringify(diagnosticBlockedDryRun).includes("must-not-survive"), false);
  assert.equal(diagnosticEvents.length, 1);
  assert.equal(diagnosticEvents[0][0], "wechat_adapter");
  assert.equal(diagnosticEvents[0][1], "moments_navigation_blocked");
  assert.deepEqual(diagnosticEvents[0][2].diagnostics, diagnosticBlockedDryRun.diagnostics);
  assert.equal(JSON.stringify(diagnosticEvents[0]).includes("must-not-survive"), false);
  assert.equal(diagnosticEvents[0][3].code, "moments_discover_entry_not_found");
  assert.equal(coordinatorActiveOwner, "", "diagnostic navigation block must release the WeChat runtime lock");

  const callsBeforeMissingCoordinator = runnerCalls.length;
  registerActiveTouchDevIpc({ activeTouchDir: "test-data", momentsDir: "moments-data", getMainWindow: () => mainWindow });
  const missingCoordinatorInspect = handlers.get("active-touch:dev-moments-inspect-menu");
  const missingCoordinator = await missingCoordinatorInspect({ sender: webContents }, {
    observationId,
    clickToken: "moments-inspect:missing-coordinator"
  });
  assert.equal(missingCoordinator.blocked_reason, "runtime_coordinator_unavailable");
  assert.equal(missingCoordinator.real_action_attempted, false);
  assert.equal(runnerCalls.length, callsBeforeMissingCoordinator);

  const ipcSource = fs.readFileSync(modulePath, "utf8");
  assert.equal(ipcSource.includes("refocusMainWindow"), false);
  assert.equal(ipcSource.includes("mainWindow.show()"), false);
  assert.equal(ipcSource.includes("mainWindow.focus()"), false);

  console.log("active-touch-dev-ipc self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
