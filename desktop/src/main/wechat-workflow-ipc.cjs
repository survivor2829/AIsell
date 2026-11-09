const fs = require("node:fs");
const path = require("node:path");
const { createWechatWorkflowController, workflowFailureReason } = require("./wechat-workflow.cjs");
const { SPRITE_WINDOW, spriteGround, spritePosition, spriteWalkRange } = require("./floating-progress-window.cjs");

function registerWechatWorkflowIpc(options) {
  const { ipcMain, BrowserWindow, screen } = options.electron || require("electron");
  const consumedClicks = new Set();
  let floatingWindow = null;
  let floatingLoad = null;
  let progressTimer = null;
  let contactSync = null;
  let readContactProgress = null;
  let disposed = false;
  // 小玺 also shows the automation that runs outside this app: 养号 and 一键分发 in Chrome
  // (user decision 2026-10-30). kind -> { title, detail, done, total }.
  const external = new Map();
  const main = () => options.getMainWindow?.();
  function viewState(state = controller.status()) {
    const current = state.tasks.find((task) => task.id === (state.currentTaskId || state.waitingTaskId || state.lastTaskId));
    const moments = current?.type === "interact" ? options.getMomentsProgress?.(current) : null;
    const syncing = readContactProgress?.();
    return {
      ...state,
      contactSync: contactSync && {
        ...contactSync,
        ...(contactSync.running && ["capturing", "syncing"].includes(syncing?.status)
          ? { stage: syncing.last_stage || "syncing" } : {})
      },
      tasks: state.tasks.map((task) => task.id === current?.id && moments ? { ...task, progress: moments } : task),
      momentsProgress: moments || null,
      // A moments job the workflow is running already shows as the workflow's own task.
      external: [...external.values()].filter((item) => !(state.currentTaskId && item.kind === { publish: "moments-publish", interact: "moments-campaign" }[current?.type]))
    };
  }
  const broadcast = (state) => {
    const progress = viewState(state);
    for (const window of [main(), floatingWindow]) {
      if (window && !window.isDestroyed()) window.webContents.send("wechat-workflow:update", { ok: true, state: progress });
    }
  };
  const controller = createWechatWorkflowController({ ...options, onUpdate: broadcast });

  const active = () => controller.status().enabled || controller.status().phase === "pausing" || contactSync?.running;
  function showMain(intent) {
    if (["start", "history", "tasks"].includes(intent?.view)) main()?.webContents.send("wechat-workflow:navigate", { view: intent.view });
    main()?.show(); main()?.focus();
    return { ok: true, state: viewState() };
  }

  async function showFloating(request = {}) {
    if (disposed) throw new Error("程序正在退出。");
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      const position = spritePosition(screen.getPrimaryDisplay().workArea, readSpritePlace());
      const target = new BrowserWindow({
        width: SPRITE_WINDOW.width, height: SPRITE_WINDOW.height, ...position,
        title: "小玺", alwaysOnTop: true, resizable: false, show: false, transparent: true, hasShadow: false,
        // A maximized 小玺 sticks at the top-left corner, cannot be dragged and loses its transparency
        // (a white block; user report 2026-11-02). It is never meant to be maximized or full screen.
        maximizable: false, minimizable: false, fullscreenable: false,
        frame: false, autoHideMenuBar: true, skipTaskbar: true, backgroundColor: "#00000000",
        webPreferences: { preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false }
      });
      floatingWindow = target;
      // The transparent parts let clicks through; 小玺 and its bubble take them while the pointer is on them.
      target.setIgnoreMouseEvents?.(true, { forward: true });
      target.on("maximize", () => target.unmaximize());
      target.on("enter-full-screen", () => target.setFullScreen(false));
      target.setMenu(null);
      target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      target.webContents.on("will-navigate", (event) => event.preventDefault());
      target.on("close", (event) => {
        if (!disposed && !options.isQuitting?.()) {
          event.preventDefault();
          try {
            options.logger?.event?.("wechat_workflow", "floating.close_redirected",
              { workflow_phase: controller.controlSnapshot().phase }, { trace: true });
          } catch { /* A diagnostic failure must not prevent returning to the main window. */ }
          showMain();
        }
      });
      target.on("closed", () => {
        if (floatingWindow === target) { floatingWindow = null; floatingLoad = null; }
        clearInterval(progressTimer); progressTimer = null;
        clearInterval(spriteCursorTimer); spriteCursorTimer = null;
        stopSpriteWalk();
      });
      startSpriteCursor();
      floatingLoad = (async () => {
        // did-finish-load only confirms HTML loading, not React/module startup.
        // Keep the main page available until the progress controls really exist.
        const waitForControls = () => target.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const ready = () => Boolean(document.querySelector(".workflow-floating-shell") && window.xiaoxiWorkflow);
          if (ready()) { resolve(true); return; }
          const observer = new MutationObserver(() => { if (ready()) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error("progress_renderer_not_ready")); }, 5000);
          observer.observe(document.documentElement, { childList: true, subtree: true });
        })`);
        const loadLocal = async () => {
          await target.loadFile(path.resolve(options.rendererPath), { query: { floating: "workflow" } });
          await waitForControls();
        };
        try {
          if (process.env.VITE_DEV_SERVER_URL) {
            try {
              const url = new URL(process.env.VITE_DEV_SERVER_URL); url.searchParams.set("floating", "workflow");
              await target.loadURL(url.toString());
              await waitForControls();
            } catch (failure) {
              options.logger?.event("wechat_workflow", "floating.development_load_failed", { error: failure.message }, { level: "warn", code: "progress_renderer_not_ready" });
              await loadLocal();
            }
          } else await loadLocal();
        } catch (failure) {
          target.destroy();
          options.logger?.event("wechat_workflow", "floating.load_failed", { error: failure.message }, { level: "error", code: "progress_window_load_failed" });
          main()?.show();
          throw new Error("进度悬浮窗未能打开，请重新启动应用后再试。");
        }
      })();
    }
    await floatingLoad;
    if (disposed || !floatingWindow || floatingWindow.isDestroyed()) throw new Error("进度悬浮窗已关闭，请重新启动应用。");
    if (typeof floatingWindow.showInactive === "function") floatingWindow.showInactive();
    else floatingWindow.show();
    // A WeChat run hides the main window so it does not cover WeChat; Chrome runs keep it.
    if (request?.keepMain !== true) main()?.hide();
    broadcast(controller.status());
    if (!progressTimer) {
      progressTimer = setInterval(() => {
        if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) broadcast(controller.status());
      }, 750);
      progressTimer.unref?.();
    }
    return { ok: true, state: viewState() };
  }

  async function start() {
    if (contactSync?.running) throw new Error("联系人正在同步，完成后即可启动程序。");
    contactSync = null;
    // Do not hide the only place that can display a start-preflight error.
    // The floating window is still visible before any WeChat action begins.
    const preflight = controller.preflightStart();
    try {
      await showFloating();
      return await controller.start();
    } catch (failure) {
      if (!preflight.alreadyActive) showMain({ view: "tasks" });
      throw failure;
    }
  }

  async function runContactSync(operation, readProgress) {
    if (contactSync?.running) throw new Error("联系人正在同步，请等待本次完成。");
    contactSync = { running: true, stage: "syncing", contactCount: 0, error: "" };
    readContactProgress = readProgress;
    try {
      await showFloating();
      const result = await operation();
      contactSync = {
        running: false, stage: result.ok ? "synced" : "failed",
        contactCount: Number(result.state?.contact_count) || 0,
        error: result.ok ? "" : (result.error || result.state?.last_error || "同步未完成，请返回主页面查看原因。")
      };
      return result;
    } catch (failure) {
      contactSync = { ...contactSync, running: false, stage: "failed", error: failure.message };
      throw failure;
    } finally {
      readContactProgress = null;
      broadcast(controller.status());
    }
  }

  function validSender(event) {
    return [main(), floatingWindow].some((window) => window && !window.isDestroyed()
      && window.webContents === event.sender && (!event.senderFrame || event.senderFrame === event.sender.mainFrame));
  }
  function assertClick(event, token) {
    if (!validSender(event) || !/^[a-f0-9-]{36}$/.test(String(token || "")) || consumedClicks.has(token)) {
      throw new Error("请在程序中点击对应按钮操作。");
    }
    consumedClicks.add(token);
    if (consumedClicks.size > 2000) consumedClicks.delete(consumedClicks.values().next().value);
  }
  function handle(name, action, click = false) {
    ipcMain.handle(`wechat-workflow:${name}`, async (event, payload) => {
      let stage = "sender_validation";
      try {
        if (!validSender(event)) throw new Error("请从微信拓客页面操作。");
        stage = "click_validation";
        if (click) assertClick(event, payload?.clickToken);
        stage = "action_execute";
        const result = await action(payload);
        return result?.state ? { ...result, state: viewState(result.state) } : result;
      } catch (failure) {
        const reason = stage === "sender_validation" ? "invalid_sender" : stage === "click_validation" ? "invalid_click" : workflowFailureReason(failure, "workflow_action_failed");
        options.logger?.event?.("wechat_workflow", "action.failed", { action: name, stage, reason, error: failure }, { level: "warn", code: reason, trace: true });
        return { ok: false, error: failure.message || "操作未完成，请重试。", state: viewState() };
      }
    });
  }

  handle("status", () => controller.refresh());
  handle("start", start, true);
  handle("pause", () => controller.pause());
  handle("choose-touch-images", async () => {
    if (active()) throw new Error("请先暂停微信拓客，再添加图片。");
    const { dialog } = options.electron || require("electron");
    const selection = await dialog.showOpenDialog(main(), {
      title: "选择要在话术后发送的图片", properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }]
    });
    if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true };
    if (active()) throw new Error("微信任务已启动，请先暂停后再添加图片。");
    try { return { ok: true, images: options.executors.touch.importImages(selection.filePaths) }; }
    catch (error) { throw new Error(/^(请|每次|单张|图片|已保存)/.test(error.message) ? error.message : "图片无法读取，请检查文件后重新添加。"); }
  }, true);
  handle("add-task", (payload) => controller.addTask(payload), true);
  handle("update-task", (payload) => controller.updateTask(payload), true);
  handle("get-task", (payload) => controller.getTask(String(payload?.id || "")));
  handle("cancel-task", (payload) => controller.cancelTask(String(payload?.id || "")));
  handle("delete-tasks", (payload) => controller.deleteTasks(payload?.ids, payload?.unsuccessfulOnly === true), true);
  handle("retry-task", async (payload) => {
    const result = await controller.retryTask(String(payload?.id || ""), payload?.andStart === true);
    return payload?.andStart === true ? { ...result, ...(await start()) } : result;
  }, true);
  handle("retry-skipped", async (payload) => {
    const result = await controller.retrySkipped(String(payload?.id || ""), payload?.contactIds);
    return payload?.andStart === true ? { ...result, ...(await start()) } : result;
  }, true);
  handle("retry-all-and-start", async () => {
    const result = await controller.retryAll(true);
    return { ...result, ...(await start()) };
  }, true);
  handle("resolve-touch-unknown", (payload) => {
    const id = String(payload?.id || "");
    const resolution = String(payload?.resolution || "");
    if (String(payload?.clickedTaskId || "") !== id || String(payload?.clickedResolution || "") !== resolution) {
      throw new Error("点击的处理结果与提交内容不一致，请重新点击对应按钮。");
    }
    return controller.resolveTouchUnknown(id, resolution);
  }, true);
  handle("remove-recipient", (payload) => controller.removeRecipient(String(payload?.id || "")));
  handle("add-recipients", (payload) => controller.addRecipients(payload?.contactIds), true);
  handle("set-reply-enabled", (payload) => controller.setReplyEnabled(payload?.enabled));
  handle("show-main", showMain);
  handle("show-floating", () => showFloating());

  // Every feature reports what it is doing here, so 小玺 shows it (user decision 2026-10-30).
  function setExternalActivity(kind, activity) {
    if (disposed) return;
    const before = JSON.stringify(external.get(kind) ?? null), next = activity ? { kind, ...activity } : null;
    if (before === JSON.stringify(next)) return; // Polled every few seconds; only real changes reach the windows.
    if (next) external.set(kind, next); else external.delete(kind);
    broadcast(controller.status());
  }
  // One thing 小玺 says once: a finished video, a failed job.
  function say(line) {
    if (disposed || !floatingWindow || floatingWindow.isDestroyed()) return;
    floatingWindow.webContents.send("wechat-workflow:sprite-say", { text: String(line?.text || "").slice(0, 60), sub: String(line?.sub || "").slice(0, 80), mood: ["done", "error"].includes(line?.mood) ? line.mood : "" });
  }
  const showSprite = () => showFloating({ keepMain: true }).catch(() => { /* The app works without 小玺. */ });

  // 小玺's own window: the bubble and 小玺 take clicks; dragging moves the window and the place is kept.
  const fromSprite = (event) => floatingWindow && !floatingWindow.isDestroyed() && event.sender === floatingWindow.webContents;
  function readSpritePlace() {
    try { return options.spritePlaceFile ? JSON.parse(fs.readFileSync(options.spritePlaceFile, "utf8")) : null; } catch { return null; }
  }
  const spriteDisplay = (x, y) => screen.getDisplayNearestPoint?.({ x: Math.round(x + SPRITE_WINDOW.width / 2), y: Math.round(y) }) || screen.getPrimaryDisplay();
  const saveSpritePlace = (x) => {
    if (!options.spritePlaceFile) return;
    try { fs.writeFileSync(options.spritePlaceFile, JSON.stringify({ x: Math.round(x) })); } catch { /* The place is a convenience. */ }
  };
  // The pet watches the pointer anywhere on screen; only changes are sent, ten times a second at most.
  let spriteCursorTimer = null, spriteCursorLast = "";
  function startSpriteCursor() {
    clearInterval(spriteCursorTimer);
    spriteCursorTimer = setInterval(() => {
      if (!floatingWindow || floatingWindow.isDestroyed() || !floatingWindow.isVisible?.() || !screen.getCursorScreenPoint) return;
      const point = screen.getCursorScreenPoint(), key = `${point.x},${point.y}`;
      if (key === spriteCursorLast) return;
      spriteCursorLast = key;
      const [x, y] = floatingWindow.getPosition();
      floatingWindow.webContents.send("wechat-workflow:sprite-cursor", { x: point.x - x, y: point.y - y });
    }, 100);
    spriteCursorTimer.unref?.();
  }
  // Walking moves the window a little at a time. It never walks during a WeChat task or a contact sync.
  let spriteWalk = null;
  function stopSpriteWalk() {
    if (!spriteWalk) return;
    const walk = spriteWalk; spriteWalk = null;
    clearInterval(walk.timer);
    if (walk.moved && floatingWindow && !floatingWindow.isDestroyed()) saveSpritePlace(floatingWindow.getPosition()[0]);
    walk.resolve({ moved: Math.round(walk.moved) });
  }
  ipcMain.handle?.("wechat-workflow:sprite-walk", (event, dx) => {
    if (!fromSprite(event) || spriteDrag || active() || !Number.isFinite(dx)) return { moved: 0 };
    stopSpriteWalk();
    const [startX, y] = floatingWindow.getPosition();
    const range = spriteWalkRange(spriteDisplay(startX, y).workArea, startX), goal = Math.min(range.max, Math.max(range.min, startX + Math.max(-300, Math.min(300, dx))));
    if (Math.abs(goal - startX) < 4) return { moved: 0 };
    return new Promise((resolve) => {
      const direction = Math.sign(goal - startX), started = Date.now(), walk = { moved: 0, resolve, timer: null };
      spriteWalk = walk;
      walk.timer = setInterval(() => {
        if (!floatingWindow || floatingWindow.isDestroyed() || active()) { stopSpriteWalk(); return; }
        const x = startX + direction * Math.min(Math.abs(goal - startX), (Date.now() - started) * .06);
        floatingWindow.setPosition(Math.round(x), y);
        walk.moved = Math.abs(x - startX);
        if (walk.moved >= Math.abs(goal - startX)) stopSpriteWalk();
      }, 33);
    });
  });
  ipcMain.on?.("wechat-workflow:sprite-walk-stop", (event) => { if (fromSprite(event)) stopSpriteWalk(); });
  ipcMain.on?.("wechat-workflow:sprite-interactive", (event, interactive) => {
    if (fromSprite(event)) floatingWindow.setIgnoreMouseEvents?.(interactive !== true, { forward: true });
  });
  // While 小玺 is held, the window follows the pointer from here (a relayed move fell behind a quick
  // drag and lost it, 2026-10-30). Letting go without moving is a click.
  let spriteDrag = null, spriteFall = null;
  ipcMain.on?.("wechat-workflow:sprite-drag-start", (event) => {
    if (!fromSprite(event)) return;
    clearInterval(spriteDrag?.timer);
    stopSpriteWalk();
    // Caught in mid-air: the fall ends here, and letting go again must drop it from where it is held.
    const caught = Boolean(spriteFall);
    if (spriteFall) { const fall = spriteFall; spriteFall = null; clearInterval(fall.timer); fall.resolve({ moved: true, impact: 0, caught: true }); }
    if (floatingWindow.isMaximized?.()) floatingWindow.unmaximize();
    const cursor = screen.getCursorScreenPoint(), [x, y] = floatingWindow.getPosition();
    const drag = { dx: cursor.x - x, dy: cursor.y - y, from: cursor, moved: caught, started: Date.now(), last: cursor, lastAt: Date.now(), lastSent: 0, vx: 0, vy: 0 };
    drag.timer = setInterval(() => {
      if (!floatingWindow || floatingWindow.isDestroyed() || Date.now() - drag.started > 60000) { clearInterval(drag.timer); return; }
      const point = screen.getCursorScreenPoint();
      if (!drag.moved && Math.hypot(point.x - drag.from.x, point.y - drag.from.y) < 4) return;
      drag.moved = true;
      floatingWindow.setPosition(Math.round(point.x - drag.dx), Math.round(point.y - drag.dy));
      const now = Date.now(), elapsed = Math.max(1, now - drag.lastAt);
      drag.vx = drag.vx * .6 + (point.x - drag.last.x) / elapsed * 400; drag.vy = drag.vy * .6 + (point.y - drag.last.y) / elapsed * 400;
      drag.last = point; drag.lastAt = now;
      if (now - drag.lastSent >= 33) { drag.lastSent = now; floatingWindow.webContents.send("wechat-workflow:sprite-drag", { vx: Math.round(drag.vx), vy: Math.round(drag.vy) }); }
    }, 16);
    drag.timer.unref?.();
    spriteDrag = drag;
  });
  ipcMain.handle?.("wechat-workflow:sprite-drag-end", (event) => {
    if (!fromSprite(event) || !spriteDrag) return { moved: false };
    const drag = spriteDrag; spriteDrag = null;
    clearInterval(drag.timer);
    if (!drag.moved || floatingWindow.isMaximized?.()) return { moved: false };
    // Let go anywhere and it falls to the bottom of that screen, carried along by how it was thrown.
    return new Promise((resolve) => {
      const [startX, startY] = floatingWindow.getPosition(), area = spriteDisplay(startX, startY).workArea, ground = spriteGround(area);
      const left = area.x, right = area.x + area.width - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap;
      let x = Math.min(right, Math.max(left, startX)), y = startY, vx = Math.max(-900, Math.min(900, Date.now() - drag.lastAt < 120 ? drag.vx : 0)), vy = Math.max(-700, Math.min(1200, Date.now() - drag.lastAt < 120 ? drag.vy : 0)), last = Date.now();
      const started = last;
      const finish = (impact) => {
        clearInterval(timer); spriteFall = null;
        if (floatingWindow && !floatingWindow.isDestroyed()) { floatingWindow.setPosition(Math.round(x), ground); saveSpritePlace(x); }
        resolve({ moved: true, impact: Math.round(Math.max(0, impact)) });
      };
      const timer = setInterval(() => {
        if (!floatingWindow || floatingWindow.isDestroyed()) { clearInterval(timer); spriteFall = null; resolve({ moved: true, impact: 0 }); return; }
        const now = Date.now(), dt = Math.min(.04, (now - last) / 1000); last = now;
        vy += 2400 * dt; y += vy * dt; x += vx * dt;
        if (x < left || x > right) { x = Math.min(right, Math.max(left, x)); vx = -vx * .55; }
        if (y >= ground || now - started > 3000) { finish(vy); return; }
        floatingWindow.setPosition(Math.round(x), Math.round(Math.max(area.y - 40, y)));
      }, 16);
      spriteFall = { timer, resolve };
    });
  });
  return {
    ...controller,
    start, showFloating, runContactSync, setExternalActivity, say, showSprite,
    dispose: async () => {
      disposed = true;
      clearInterval(progressTimer); progressTimer = null;
      await controller.dispose(); floatingWindow?.destroy(); floatingWindow = null;
    }
  };
}

module.exports = { registerWechatWorkflowIpc };
