const { app, BrowserWindow, dialog, safeStorage, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { configureActiveTouchRuntime, runActiveTouch } = require("./active-touch-ipc.cjs");
const { registerAutoReplyIpc } = require("./auto-reply-ipc.cjs");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { registerAiExpertIpc } = require("./ai-expert-ipc.cjs");
const { registerContactSyncIpc } = require("./contact-sync-ipc.cjs");
const { migrateLegacyRuntimeData } = require("./runtime-data.cjs");
const { registerTouchTaskIpc } = require("./touch-task-ipc.cjs");
const { createRuntimeCoordinator } = require("./runtime-coordinator.cjs");
const { createDeepSeekClient, createDeepSeekKeyStore } = require("./deepseek-api.cjs");
const { registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");
const { configureDiagnostics, diagnostics } = require("./diagnostics.cjs");
const { registerDiagnosticsIpc } = require("./diagnostics-ipc.cjs");
const { developmentEdition, pilotEdition, editionLabel, preloadFile, rendererDir } = require("./edition.cjs");

let mainWindow = null;
let disarmRealSend = null;
let touchTaskController = null;
let autoReplyController = null;
let momentsCampaignController = null;

function rendererBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, `../../${rendererDir}/build-edition.json`), "utf8"));
  } catch {
    return {};
  }
}

// ponytail: keep test data separate from the delivery profile.
if (developmentEdition) app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-test"));
if (pilotEdition) app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-delivery"));

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function createWindow() {
  mainWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: "#f8d9df",
    title: ["AI获客", editionLabel].filter(Boolean).join(" "),
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    diagnostics().event("renderer", "load_failed", { error_code: errorCode, error: errorDescription, url: validatedUrl }, { level: "error", code: `load_${errorCode}` });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    diagnostics().event("renderer", "process_gone", details, { level: "fatal", code: details.reason || "renderer_gone" });
  });
  mainWindow.on("unresponsive", () => diagnostics().event("renderer", "unresponsive", {}, { level: "error", code: "renderer_unresponsive" }));
  mainWindow.on("responsive", () => diagnostics().event("renderer", "responsive"));
  mainWindow.on("close", () => {
    diagnostics().event("app", "window_closing");
    autoReplyController?.pause("app_closed");
    touchTaskController?.pause("应用窗口已关闭，任务已暂停");
    momentsCampaignController?.pauseForAppClose();
    disarmRealSend?.();
  });
  mainWindow.on("blur", () => {
    if (developmentEdition) disarmRealSend?.();
  });
  mainWindow.on("minimize", () => {
    if (developmentEdition) disarmRealSend?.();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../../${rendererDir}/index.html`));
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    diagnostics().event("app", "second_instance_requested");
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    let runtime;
    try {
      runtime = migrateLegacyRuntimeData({ appPath: app.getAppPath(), userDataDir: app.getPath("userData") });
    } catch {
      dialog.showErrorBox("数据迁移失败", "旧版本联系人或任务未能安全迁移，程序已停止启动；原数据不会被删除。");
      app.quit();
      return;
    }
    const build = rendererBuildInfo();
    const logger = configureDiagnostics({
      rootDir: runtime.rootDir,
      appInfo: {
        name: app.getName(),
        version: app.getVersion(),
        edition: developmentEdition ? "development" : pilotEdition ? "pilot" : "unknown",
        build_id: build.buildId || process.env.XIAOXI_BUILD_ID || "",
        packaged: app.isPackaged
      }
    });
    process.on("uncaughtException", (error) => logger.event("app", "uncaught_exception", { error }, { level: "fatal", code: error?.code || "uncaught_exception" }));
    process.on("unhandledRejection", (error) => logger.event("app", "unhandled_rejection", { error }, { level: "error", code: error?.code || "unhandled_rejection" }));
    logger.environment({
      displays: screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: display.bounds,
        work_area: display.workArea,
        scale_factor: display.scaleFactor,
        rotation: display.rotation,
        internal: display.internal
      }))
    });
    logger.event("runtime", "migration_finished", {
      migrated_count: runtime.migrated.length,
      kept_existing_count: runtime.keptExisting.length,
      archived_count: runtime.archived.length,
      split_state_count: runtime.splitState.length,
      skipped_foreign_install: runtime.skippedForeignInstall
    });
    const coordinator = createRuntimeCoordinator(runtime.rootDir);
    const deepSeekKeyStore = createDeepSeekKeyStore({ rootDir: runtime.rootDir, safeStorage });
    const deepSeekClient = createDeepSeekClient({ keyStore: deepSeekKeyStore });
    const aiExpertStore = createAiExpertStore({ rootDir: runtime.rootDir });
    coordinator.initialize();
    configureActiveTouchRuntime({ dataDir: runtime.activeTouchDir, coordinator });
    const internalRealSend = developmentEdition || pilotEdition ? require("../../rpa/active_touch/state_machine.dev.cjs") : null;
    const developmentRealSend = developmentEdition ? require("./active-touch-dev-ipc.cjs") : null;
    const momentsCampaign = developmentEdition || pilotEdition
      ? require("./moments-campaign-ipc.cjs")
      : null;
    if (developmentRealSend) developmentRealSend.registerActiveTouchDevIpc({
      activeTouchDir: runtime.activeTouchDir,
      momentsDir: runtime.momentsDir,
      coordinator,
      getMainWindow: () => mainWindow
    });
    if (momentsCampaign) {
      momentsCampaignController = momentsCampaign.registerMomentsCampaignIpc({
        baseDir: runtime.momentsDir,
        coordinator,
        deepSeekClient,
        getMainWindow: () => mainWindow
      });
    }
    if (internalRealSend) disarmRealSend = () => internalRealSend.setRealSendArm(runtime.activeTouchDir, false);
    registerContactSyncIpc({ dataDir: runtime.contactSyncDir, activeTouchDir: runtime.activeTouchDir, coordinator });
    registerDeepSeekApiIpc({ keyStore: deepSeekKeyStore, client: deepSeekClient });
    registerDiagnosticsIpc();
    registerAiExpertIpc({ store: aiExpertStore, isAutoReplyRunning: () => ["starting", "running"].includes(autoReplyController?.status().status) });
    if (internalRealSend) {
      autoReplyController = registerAutoReplyIpc({
        getMainWindow: () => mainWindow,
        dataDir: runtime.autoReplyDir,
        activeTouchDir: runtime.activeTouchDir,
        coordinator,
        deepSeekClient,
        expertStore: aiExpertStore,
        send: internalRealSend.executeVerifiedContactSend,
        sendHandoff: internalRealSend.executeVerifiedFileHelperSend,
        runStep: (command, args, owner) => runActiveTouch([command, ...args], {
          development: true,
          owner,
          phase: `auto-reply:${command}`,
          dataDir: runtime.autoReplyDir
        })
      });
    }
    touchTaskController = registerTouchTaskIpc({
      getMainWindow: () => mainWindow,
      dataDir: runtime.activeTouchDir,
      coordinator,
      deepSeekClient,
      buildId: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      executionMode: "real_send",
      realSendExecutor: internalRealSend.executeVerifiedContactSend,
      verifyRealSendSession: internalRealSend.refreshRealSendSession,
      verifyMessageBubble: internalRealSend.verifyMessageBubble,
      onPause: disarmRealSend || undefined
    });
    createWindow();
    momentsCampaignController?.initialize();
    logger.event("app", "ready", { window_created: true });

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      if (mainWindow) mainWindow.show();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => momentsCampaignController?.dispose());
}
