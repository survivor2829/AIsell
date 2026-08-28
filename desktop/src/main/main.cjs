const { app, BrowserWindow, dialog, net, protocol, safeStorage, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const productBrand = require("../../product-brand.json");
const { configureActiveTouchRuntime, runActiveTouch } = require("./active-touch-ipc.cjs");
const { registerAutoReplyIpc } = require("./auto-reply-ipc.cjs");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { registerAiExpertIpc } = require("./ai-expert-ipc.cjs");
const { registerContactSyncIpc } = require("./contact-sync-ipc.cjs");
const { migrateLegacyRuntimeData } = require("./runtime-data.cjs");
const { registerTouchTaskIpc } = require("./touch-task-ipc.cjs");
const { createRuntimeCoordinator } = require("./runtime-coordinator.cjs");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore } = require("./deepseek-api.cjs");
const { registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");
const { configureDiagnostics, diagnostics } = require("./diagnostics.cjs");
const { registerDiagnosticsIpc } = require("./diagnostics-ipc.cjs");
const { developmentEdition, pilotEdition, editionLabel, preloadFile, rendererDir } = require("./edition.cjs");
const {
  createProductDetailAiSettingsStore
} = require("./product-detail-ai-settings.cjs");
const {
  registerProductDetailAiSettingsIpc
} = require("./product-detail-ai-settings-ipc.cjs");
const { createProductDetailSidecar } = require("./product-detail-sidecar.cjs");
const {
  isAllowedProductDetailUrl,
  registerProductDetailDownloads
} = require("./product-detail-download.cjs");
const { registerProductDetailIpc } = require("./product-detail-ipc.cjs");
const { createContentEngineSidecar } = require("./content-engine-sidecar.cjs");
const { registerContentEngineIpc } = require("./content-engine-ipc.cjs");
const { createBailianApiKeyStore } = require("./bailian-api-key.cjs");
const {
  registerContentMediaProtocol,
  registerContentMediaScheme
} = require("./content-media-protocol.cjs");
const {
  resolveDefaultDevelopmentSidecarRuntime
} = require("./development-sidecar-runtime.cjs");
const {
  resolveRemotionRuntimeEnvironment
} = require("./remotion-runtime-environment.cjs");
const {
  resolveContentEngineMediaToolsEnvironment
} = require("./content-engine-media-tools.cjs");

let mainWindow = null;
let disarmRealSend = null;
let touchTaskController = null;
let autoReplyController = null;
let momentsCampaignController = null;
let momentsPublishController = null;
let productDetailController = null;
let productDetailIpcRegistration = null;
let productDetailDownloadRegistration = null;
let contentEngineController = null;
let contentEngineIpcRegistration = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;

const PROVIDER_CONSUMER_RESTART_STATES = new Set(["ready", "starting", "failed"]);

registerContentMediaScheme(protocol);

function restartProductDetailForProviderChange() {
  const state = productDetailController?.status().state;
  if (!PROVIDER_CONSUMER_RESTART_STATES.has(state)) return undefined;
  return productDetailController.restart();
}

function productDetailRuntimePath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "product-detail",
      "product-detail-server.exe"
    );
  }
  const configuredPath = String(process.env.XIAOXI_PRODUCT_DETAIL_SIDECAR || "").trim();
  if (configuredPath) return configuredPath;
  return resolveDefaultDevelopmentSidecarRuntime("product-detail");
}

function contentEngineRuntimePath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "content-engine",
      "content-engine-worker.exe"
    );
  }
  const configuredPath = String(process.env.XIAOXI_CONTENT_ENGINE_SIDECAR || "").trim();
  if (configuredPath) return configuredPath;
  return resolveDefaultDevelopmentSidecarRuntime("content-engine");
}

function productDetailRuntimeEnvironment() {
  if (app.isPackaged) {
    return {
      XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: path.join(
        process.resourcesPath,
        "content-engine",
        "browser",
        "chrome.exe"
      )
    };
  }
  const configured = String(process.env.XIAOXI_PRODUCT_DETAIL_BROWSER_PATH || "").trim();
  if (configured) return { XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: configured };
  return {};
}

function restartImageProviderConsumers() {
  const restarts = [restartProductDetailForProviderChange()];
  const contentState = contentEngineController?.status().state;
  if (PROVIDER_CONSUMER_RESTART_STATES.has(contentState)) {
    restarts.push(contentEngineController.restart());
  }
  return Promise.all(restarts.filter(Boolean));
}

function contentEngineRuntimeArgs() {
  if (app.isPackaged) return [];
  const entryPath = String(process.env.XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY || "").trim();
  return entryPath ? [entryPath] : [];
}

function remotionRuntimeEnvironment() {
  return resolveRemotionRuntimeEnvironment({
    environment: process.env,
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    moduleDir: __dirname,
    resourcesPath: process.resourcesPath
  });
}

function contentEngineRuntimeEnvironment(runtimePath, dataDir) {
  return {
    ...remotionRuntimeEnvironment(),
    ...resolveContentEngineMediaToolsEnvironment({
      runtimePath,
      isPackaged: app.isPackaged,
      dataDir
    })
  };
}

function isAllowedProductDetailFrameNavigation(targetUrl) {
  const sidecarOrigin = productDetailController?.status().origin;
  return isAllowedProductDetailUrl(targetUrl, sidecarOrigin);
}

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
    title: [productBrand.displayName, editionLabel].filter(Boolean).join(" "),
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || !isAllowedProductDetailFrameNavigation(event.url)) {
      event.preventDefault();
    }
  });
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
    const bailianKeyStore = createBailianApiKeyStore({
      rootDir: path.join(app.getPath("userData"), "content-engine"),
      safeStorage
    });
    const deepSeekClient = createDeepSeekClient({ keyStore: deepSeekKeyStore });
    const aiExpertStore = createAiExpertStore({ rootDir: runtime.rootDir });
    const productDetailDataDir = path.join(app.getPath("userData"), "product-detail");
    const productDetailAiSettingsStore = createProductDetailAiSettingsStore({
      rootDir: productDetailDataDir,
      safeStorage
    });
    const getProductDetailProviderEnvironment = () => {
      const providerEnvironment = { DEEPSEEK_MODEL };
      if (deepSeekKeyStore.status().configured) {
        providerEnvironment.DEEPSEEK_API_KEY = deepSeekKeyStore.read();
      }
      const refineStatus = productDetailAiSettingsStore.status();
      if (refineStatus.ready) {
        const refine = productDetailAiSettingsStore.runtimeConfig();
        providerEnvironment.REFINE_API_KEY = refine.apiKey;
        providerEnvironment.REFINE_API_BASE_URL = refine.baseUrl;
      }
      return providerEnvironment;
    };
    coordinator.initialize();
    configureActiveTouchRuntime({ dataDir: runtime.activeTouchDir, coordinator });
    const internalRealSend = developmentEdition || pilotEdition ? require("../../rpa/active_touch/state_machine.dev.cjs") : null;
    const developmentRealSend = developmentEdition ? require("./active-touch-dev-ipc.cjs") : null;
    const momentsCampaign = developmentEdition || pilotEdition
      ? require("./moments-campaign-ipc.cjs")
      : null;
    const momentsPublish = developmentEdition || pilotEdition
      ? require("./moments-publish-ipc.cjs")
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
    if (momentsPublish) {
      momentsPublishController = momentsPublish.registerMomentsPublishIpc({
        baseDir: runtime.momentsDir,
        coordinator,
        dialog,
        logger,
        getMainWindow: () => mainWindow
      });
      momentsPublishController.initialize();
    }
    if (internalRealSend) disarmRealSend = () => internalRealSend.setRealSendArm(runtime.activeTouchDir, false);
    registerContactSyncIpc({ dataDir: runtime.contactSyncDir, activeTouchDir: runtime.activeTouchDir, coordinator });
    registerDiagnosticsIpc();
    productDetailController = createProductDetailSidecar({
      runtimePath: productDetailRuntimePath(),
      dataDir: productDetailDataDir,
      getTrustedRuntimeEnvironment: productDetailRuntimeEnvironment,
      getProviderEnvironment: getProductDetailProviderEnvironment
    });
    productDetailIpcRegistration = registerProductDetailIpc({
      controller: productDetailController,
      getMainWindow: () => mainWindow
    });
    registerDeepSeekApiIpc({
      keyStore: deepSeekKeyStore,
      client: deepSeekClient,
      onChanged: restartProductDetailForProviderChange
    });
    registerProductDetailAiSettingsIpc({
      store: productDetailAiSettingsStore,
      onChanged: restartImageProviderConsumers
    });
    const contentEnginePath = contentEngineRuntimePath();
    const contentEngineDataDir = path.join(app.getPath("userData"), "content-engine");
    contentEngineController = createContentEngineSidecar({
      runtimePath: contentEnginePath,
      runtimeArgs: contentEngineRuntimeArgs(),
      dataDir: contentEngineDataDir,
      getTrustedRuntimeEnvironment: () => contentEngineRuntimeEnvironment(
        contentEnginePath,
        contentEngineDataDir
      ),
      getProviderEnvironment: () => {
        const providerEnvironment = {};
        if (bailianKeyStore.status().configured) {
          providerEnvironment.DASHSCOPE_API_KEY = bailianKeyStore.read();
          const apiHost = bailianKeyStore.status().apiHost;
          if (apiHost) providerEnvironment.XIAOXI_BAILIAN_API_HOST = apiHost;
        }
        if (productDetailAiSettingsStore.status().ready) {
          const imageProvider = productDetailAiSettingsStore.runtimeConfig();
          providerEnvironment.APIMART_API_KEY = imageProvider.apiKey;
          providerEnvironment.APIMART_API_BASE_URL = imageProvider.baseUrl;
          providerEnvironment.APIMART_IMAGE_MODEL = imageProvider.model;
        }
        return providerEnvironment;
      }
    });
    registerContentMediaProtocol({
      protocol,
      net,
      controller: contentEngineController
    });
    contentEngineIpcRegistration = registerContentEngineIpc({
      controller: contentEngineController,
      bailianKeyStore,
      dialog,
      shell,
      getMainWindow: () => mainWindow
    });
    contentEngineController.start().catch(() => undefined);
    registerAiExpertIpc({ store: aiExpertStore, isAutoReplyRunning: () => ["starting", "running"].includes(autoReplyController?.status().status) });
    if (internalRealSend) {
      autoReplyController = registerAutoReplyIpc({
        getMainWindow: () => mainWindow,
        dataDir: runtime.autoReplyDir,
        activeTouchDir: runtime.activeTouchDir,
        coordinator,
        deepSeekClient,
        expertStore: aiExpertStore,
        singleContactScopeRequired: developmentEdition,
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
    productDetailDownloadRegistration = registerProductDetailDownloads({
      session: mainWindow.webContents.session,
      getMainWindow: () => mainWindow,
      getProductDetailOrigin: () => productDetailController?.status().origin || "",
      getDesktopPath: () => app.getPath("desktop"),
      diagnostics: logger
    });
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
  app.on("before-quit", (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    const cleanupTimeout = new Promise((resolve) => {
      setTimeout(resolve, 8_000);
    });
    Promise.race([
      Promise.allSettled([
        Promise.resolve(productDetailController?.dispose()),
        Promise.resolve(contentEngineController?.dispose()),
        Promise.resolve(momentsPublishController?.dispose())
      ]),
      cleanupTimeout
    ]).catch(() => undefined).finally(() => {
      productDetailIpcRegistration?.dispose();
      productDetailDownloadRegistration?.dispose();
      contentEngineIpcRegistration?.dispose();
      momentsCampaignController?.dispose();
      quitCleanupComplete = true;
      app.quit();
    });
  });
}
