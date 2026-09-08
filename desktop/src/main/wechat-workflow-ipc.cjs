const path = require("node:path");
const { createWechatWorkflowController } = require("./wechat-workflow.cjs");
const { FLOATING_PROGRESS_WINDOW, floatingProgressPosition } = require("./floating-progress-window.cjs");

function registerWechatWorkflowIpc(options) {
  const { ipcMain, BrowserWindow, screen } = options.electron || require("electron");
  const consumedClicks = new Set();
  let floatingWindow = null;
  let floatingLoad = null;
  let progressTimer = null;
  let contactSync = null;
  let readContactProgress = null;
  let disposed = false;
  const main = () => options.getMainWindow?.();
  function viewState(state = controller.status()) {
    const current = state.tasks.find((task) => task.id === (state.currentTaskId || state.lastTaskId));
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
      momentsProgress: moments || null
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
    if (!active()) floatingWindow?.hide();
    return { ok: true, state: viewState() };
  }

  async function showFloating() {
    if (disposed) throw new Error("程序正在退出。");
    if (!floatingWindow || floatingWindow.isDestroyed()) {
      const position = floatingProgressPosition(screen.getPrimaryDisplay().workArea);
      const target = new BrowserWindow({
        width: FLOATING_PROGRESS_WINDOW.width, height: FLOATING_PROGRESS_WINDOW.height, ...position,
        title: "微信拓客进度", alwaysOnTop: true, resizable: false, show: false,
        frame: false, autoHideMenuBar: true, skipTaskbar: true, backgroundColor: "#ffffff",
        webPreferences: { preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false }
      });
      floatingWindow = target;
      target.setMenu(null);
      target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      target.webContents.on("will-navigate", (event) => event.preventDefault());
      target.on("close", (event) => {
        if (!disposed && !options.isQuitting?.()) { event.preventDefault(); showMain(); }
      });
      target.on("closed", () => {
        if (floatingWindow === target) { floatingWindow = null; floatingLoad = null; }
        clearInterval(progressTimer); progressTimer = null;
      });
      floatingLoad = (async () => {
        // did-finish-load only confirms HTML loading, not React/module startup.
        // Keep the main page available until the progress controls really exist.
        const waitForControls = () => target.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const ready = () => Boolean(document.querySelector(".workflow-floating-shell .floating-actions") && window.xiaoxiWorkflow);
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
    main()?.hide();
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
    await showFloating();
    return controller.start();
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
      try {
        if (!validSender(event)) throw new Error("请从微信拓客页面操作。");
        if (click) assertClick(event, payload?.clickToken);
        const result = await action(payload);
        return result?.state ? { ...result, state: viewState(result.state) } : result;
      } catch (failure) {
        return { ok: false, error: failure.message || "操作未完成，请重试。", state: viewState() };
      }
    });
  }

  handle("status", () => controller.refresh());
  handle("start", start, true);
  handle("pause", () => controller.pause());
  handle("add-task", (payload) => controller.addTask(payload), true);
  handle("update-task", (payload) => controller.updateTask(payload), true);
  handle("get-task", (payload) => controller.getTask(String(payload?.id || "")));
  handle("cancel-task", (payload) => controller.cancelTask(String(payload?.id || "")));
  handle("retry-task", (payload) => controller.retryTask(String(payload?.id || "")), true);
  handle("remove-recipient", (payload) => controller.removeRecipient(String(payload?.id || "")));
  handle("add-recipients", (payload) => controller.addRecipients(payload?.contactIds), true);
  handle("set-reply-enabled", (payload) => controller.setReplyEnabled(payload?.enabled));
  handle("show-main", showMain);
  handle("show-floating", showFloating);
  return {
    ...controller,
    start, showFloating, runContactSync,
    dispose: async () => {
      disposed = true;
      clearInterval(progressTimer); progressTimer = null;
      await controller.dispose(); floatingWindow?.destroy(); floatingWindow = null;
    }
  };
}

module.exports = { registerWechatWorkflowIpc };
