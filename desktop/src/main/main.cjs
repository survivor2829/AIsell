const { app, BrowserWindow, dialog, ipcMain, nativeImage, net, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, clipboard } = require("electron");
if (!app.isPackaged) require("./development-dependencies.cjs").configureDevelopmentDependencies();
const fs = require("node:fs");
const startupTiming = global.__xiaoxiStartupTiming ||= require('./startup-timing.cjs').createStartupTiming();
startupTiming.mark('main_loaded');
const path = require("node:path");
const components = require("./component-paths.cjs");
const productBrand = require("../../product-brand.json");
const installerTargets = require("../../installer-targets.json");
const { windowLayout, keepWindowInWorkArea } = require("./window-layout.cjs");
const { configureActiveTouchRuntime, runActiveTouch } = require("./active-touch-ipc.cjs");
const { registerAutoReplyIpc } = require("./auto-reply-ipc.cjs");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { registerAiExpertIpc } = require("./ai-expert-ipc.cjs");
const { registerContactSyncIpc } = require("./contact-sync-ipc.cjs");
const { migrateLegacyRuntimeData, resolveRuntimePaths } = require("./runtime-data.cjs");
const { registerTouchTaskIpc } = require("./touch-task-ipc.cjs");
const { registerWechatWorkflowIpc } = require("./wechat-workflow-ipc.cjs");
const { createRuntimeCoordinator } = require("./runtime-coordinator.cjs");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore } = require("./deepseek-api.cjs");
const { registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");
const { configureDiagnostics, diagnostics } = require("./diagnostics.cjs");
const { registerDiagnosticsIpc } = require("./diagnostics-ipc.cjs");
const { createTaskPassportStore } = require("./task-passport.cjs");
const { cloudConfig } = require("./cloud-config.cjs");
const { createCloudMaintenance } = require("./cloud-maintenance.cjs");
const { registerCloudMaintenanceIpc } = require("./cloud-maintenance-ipc.cjs");
const { createRolePreferences, registerRolePreferencesIpc } = require("./role-preferences.cjs");
const { createFeedbackController } = require("./feedback-controller.cjs");
const { createFailureCapsules } = require("./failure-capsule.cjs");
const { createFeedbackAdmin } = require("./feedback-admin.cjs");
const { registerFeedbackIpc } = require("./feedback-ipc.cjs");
const { createLicenseStore, registerLicenseAuthIpc } = require("./license-auth-ipc.cjs");
const { createAccountStore } = require("./account-store.cjs");
const { registerAccountAuthIpc } = require("./account-auth-ipc.cjs");
// Customers run WeChat tasks unattended. The WeChat drivers (PowerShell children inherit this)
// then stop treating any mouse or keyboard activity on the computer as a reason to abort a step;
// the foreground window and click target are still checked before every action.
if (!process.env.XIAOXI_UNATTENDED_INPUT) process.env.XIAOXI_UNATTENDED_INPUT = "1";
const { createProviderGatewayClient } = require("./provider-gateway-client.cjs");
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
const { runProductDetailReleaseSmoke } = require("./product-detail-release-smoke.cjs");
const { createContentEngineSidecar } = require("./content-engine-sidecar.cjs");
const { registerContentEngineIpc } = require("./content-engine-ipc.cjs");
const { registerBusinessWorkbenchIpc } = require('./business-workbench-ipc.cjs');
const { registerKeywordAcquisitionIpc } = require("./keyword-acquisition-ipc.cjs");
const { registerSocialAccountsIpc } = require("./social-accounts-ipc.cjs");
const { registerSocialPublishIpc } = require("./social-publish-ipc.cjs");
const { registerSocialAcquisitionIpc } = require("./social-acquisition-ipc.cjs");
const { registerSocialNurtureIpc } = require("./social-nurture-ipc.cjs");
const { registerDigitalHumanIpc } = require("./digital-human-ipc.cjs");
const { createVoiceCloneClient } = require("./voice-clone-client.cjs");
const { registerProductVideoIpc } = require("./product-video-ipc.cjs");
const { createCoverPriceReader, createPriceReader, createReferencePriceReader } = require("./product-video-pricing.cjs");
const { createProductAudioPreparer } = require("./product-video-audio.cjs");
const { createBailianApiKeyStore } = require("./bailian-api-key.cjs");
const { createVolcengineTtsKeyStore, createVolcengineAsrStore } = require("./volcengine-tts-settings.cjs");
const {
  registerContentMediaProtocol,
  registerContentMediaScheme
} = require("./content-media-protocol.cjs");
const {
  resolveDevelopmentProductDetailLaunch,
  resolveDevelopmentContentEngineLaunch
} = require("./development-sidecar-runtime.cjs");
const {
  resolveRemotionRuntimeEnvironment,
  verifyPackagedRuntimeInBackground
} = require("./remotion-runtime-environment.cjs");
const {
  resolveContentEngineBundledFont,
  resolveContentEngineMediaToolsEnvironment
} = require("./content-engine-media-tools.cjs");

let mainWindow = null;
let disarmRealSend = null;
let touchTaskController = null;
let autoReplyController = null;
let workflowController = null;
let momentsCampaignController = null;
let momentsPublishController = null;
let productDetailController = null;
let productDetailIpcRegistration = null;
let productDetailDownloadRegistration = null;
let contentEngineController = null;
let contentEngineIpcRegistration = null;
let keywordAcquisitionRegistration = null;
let socialAccountsRegistration = null;
let socialPublishRegistration = null;
let socialAcquisitionRegistration = null;
let socialNurtureRegistration = null;
let businessWorkbenchRegistration = null;
let digitalHumanRegistration = null;
let productVideoRegistration = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let cloudMaintenance = null;
let feedbackController = null;
let failureCapsules = null;
let feedbackAdmin = null;
let providerGatewayClient = null;
let taskPassportStore = null;
let developmentContentEngineLaunch = null;
let developmentProductDetailLaunch = null;

const PROVIDER_CONSUMER_RESTART_STATES = new Set(["ready", "starting", "failed"]);
const productDetailReleaseSmokeMode = app.isPackaged
  && process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE === "1";
const productDetailReleaseSmokeDataDirRaw = String(
  process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE_DATA_DIR || ""
).trim();
const productDetailReleaseSmokeDataDir = productDetailReleaseSmokeDataDirRaw
  ? path.resolve(productDetailReleaseSmokeDataDirRaw)
  : "";
const productDetailReleaseSmokeDataDirIsValid = !productDetailReleaseSmokeMode
  || (
    path.isAbsolute(productDetailReleaseSmokeDataDirRaw)
    && productDetailReleaseSmokeDataDir !== path.parse(productDetailReleaseSmokeDataDir).root
  );

registerContentMediaScheme(protocol);

function restartProductDetailForProviderChange() {
  const state = productDetailController?.status().state;
  if (!PROVIDER_CONSUMER_RESTART_STATES.has(state)) return undefined;
  return productDetailController.restart();
}

function productDetailRuntimePath() {
  if (app.isPackaged) {
    return path.join(
      components.resourcesPath(),
      "product-detail",
      "product-detail-server.exe"
    );
  }
  developmentProductDetailLaunch ||= resolveDevelopmentProductDetailLaunch();
  return developmentProductDetailLaunch.runtimePath;
}

function contentEngineRuntimePath() {
  if (app.isPackaged) {
    return path.join(
      components.resourcesPath(),
      "content-engine",
      "content-engine-worker.exe"
    );
  }
  developmentContentEngineLaunch ||= resolveDevelopmentContentEngineLaunch();
  return developmentContentEngineLaunch.runtimePath;
}

function productDetailRuntimeEnvironment() {
  if (app.isPackaged) {
    return {
      XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: path.join(
        components.resourcesPath(),
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

function providerGatewaySupports(provider) {
  const status = providerGatewayClient?.status();
  return Boolean(status?.ready && status.capabilities?.[provider] === true);
}

function contentEngineRuntimeArgs() {
  if (app.isPackaged) return [];
  developmentContentEngineLaunch ||= resolveDevelopmentContentEngineLaunch();
  return developmentContentEngineLaunch.runtimeArgs;
}

let verifiedRemotionRuntime = null;
async function verifyRemotionRuntime() {
  if (!app.isPackaged) return;
  const resourcesPath = components.resourcesPath();
  try {
    const runtime = await verifyPackagedRuntimeInBackground(resourcesPath, {
      cacheFile: path.join(app.getPath("userData"), "content-engine", "remotion-runtime-verification.json")
    });
    verifiedRemotionRuntime = { resourcesPath, runtime };
  } catch (error) {
    console.warn(`Remotion runtime verification failed: ${error.message}`);
    // Never fall back to the synchronous hash in beginStart; report the runtime as unavailable instead.
    throw Object.assign(new Error(error.message), { code: "component_runtime_verification_failed" });
  }
}

function remotionRuntimeEnvironment() {
  const resourcesPath = components.resourcesPath();
  return resolveRemotionRuntimeEnvironment({
    environment: process.env,
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    moduleDir: __dirname,
    resourcesPath,
    verifiedRuntime: verifiedRemotionRuntime?.resourcesPath === resourcesPath ? verifiedRemotionRuntime.runtime : null
  });
}

function contentEngineRuntimeEnvironment(runtimePath, dataDir) {
  return {
    XIAOXI_DISABLE_PAID_CALLS: developmentEdition && process.env.XIAOXI_DISABLE_PAID_CALLS === '1' ? '1' : '0',
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
if (productDetailReleaseSmokeMode && productDetailReleaseSmokeDataDirIsValid) {
  app.setPath("userData", productDetailReleaseSmokeDataDir);
} else if (developmentEdition) {
  const developmentProfile = String(process.env.XIAOXI_DEV_PROFILE_DIR || '').trim();
  if (developmentProfile && (!path.isAbsolute(developmentProfile) || path.resolve(developmentProfile) === path.parse(developmentProfile).root)) throw new Error('开发隔离资料目录必须是非磁盘根目录的绝对路径。');
  app.setPath("userData", developmentProfile || path.join(app.getPath("appData"), "xiaoxi-active-touch-test"));
} else if (pilotEdition) {
  app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-delivery"));
}

const gotSingleInstanceLock = productDetailReleaseSmokeMode || global.__xiaoxiStableLock || app.requestSingleInstanceLock();

function productDetailWebPreferences() {
  return {
    preload: path.join(__dirname, preloadFile),
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false
  };
}

ipcMain.on("window-chrome:set-mode", (event, mode) => {
  if (event.sender !== mainWindow?.webContents || !["login", "workspace"].includes(mode)) return;
  mainWindow.setTitleBarOverlay({ color: mode === "login" ? "#f8f4f0" : "#c91739", symbolColor: mode === "login" ? "#302a2b" : "#ffffff", height: 36 });
});
ipcMain.on('startup:mark', (event, stage) => {
  if (event.sender === mainWindow?.webContents && ['renderer_loaded', 'login_visible', 'login_interactive'].includes(stage)) startupTiming.mark(stage);
});

function createWindow() {
  startupTiming.mark('window_creating');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  mainWindow = new BrowserWindow({
    ...windowLayout(display.workArea),
    autoHideMenuBar: true,
    backgroundColor: "#f8f4f0",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f8f4f0", symbolColor: "#302a2b", height: 36 },
    icon: path.join(__dirname, `../../${rendererDir}/app-icon.ico`),
    title: [productBrand.displayName.replace(/版本$/u, ""), editionLabel].filter(Boolean).join(" "),
    webPreferences: productDetailWebPreferences()
  });
  keepWindowInWorkArea(mainWindow, screen);

  mainWindow.setMenu(null);
  mainWindow.webContents.once('did-finish-load', () => startupTiming.mark('window_loaded'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || !isAllowedProductDetailFrameNavigation(event.url)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) components.invalidateVerification();
    diagnostics().event("renderer", "load_failed", { error_code: errorCode, error: errorDescription, url: validatedUrl }, { level: "error", code: `load_${errorCode}` });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") components.invalidateVerification();
    diagnostics().event("renderer", "process_gone", details, { level: "fatal", code: details.reason || "renderer_gone" });
  });
  mainWindow.on("unresponsive", () => diagnostics().event("renderer", "unresponsive", {}, { level: "error", code: "renderer_unresponsive" }));
  mainWindow.on("responsive", () => diagnostics().event("renderer", "responsive"));
  mainWindow.on("close", () => {
    const workflow = workflowController?.controlSnapshot?.();
    try { diagnostics().event("app", "window_closing", { workflow_phase: workflow?.phase,
      workflow_enabled: workflow?.enabled }, { trace: true }); } catch {}
    void keywordAcquisitionRegistration?.dispose().catch(() => undefined);
    void socialAcquisitionRegistration?.dispose().catch(() => undefined);
    void socialNurtureRegistration?.dispose().catch(() => undefined);
    void socialPublishRegistration?.dispose().catch(() => undefined);
    void socialAccountsRegistration?.dispose().catch(() => undefined);
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
    // The hidden workflow window must not keep Windows running after exit.
    if (process.platform !== "darwin") app.quit();
  });

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.__xiaoxiLoaded = mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.__xiaoxiLoaded = mainWindow.loadFile(path.join(__dirname, `../../${rendererDir}/index.html`));
  }
}

function completeProductDetailReleaseSmoke() {
  void runProductDetailReleaseSmoke({
    BrowserWindow,
    controller: productDetailController,
    dataDir: productDetailReleaseSmokeDataDir,
    preloadPath: path.join(__dirname, preloadFile),
    webPreferences: productDetailWebPreferences()
  }).then(
    () => {
      console.log("product-detail packaged main-process smoke passed");
      process.exitCode = 0;
      app.quit();
    },
    (error) => {
      console.error(`product-detail packaged main-process smoke failed: ${error instanceof Error ? error.message : "unknown failure"}`);
      process.exitCode = 1;
      app.quit();
    }
  );
}

if (!productDetailReleaseSmokeDataDirIsValid) {
  console.error("product-detail packaged main-process smoke requires an absolute fresh data directory");
  process.exitCode = 1;
  app.exit(1);
} else if (!gotSingleInstanceLock) {
  if (!app.isPackaged && developmentEdition) {
    dialog.showErrorBox("内部开发版未启动", "测试版程序仍在运行，占用了同一份测试数据。请先暂停任务并完全退出旧测试版，再重新运行“启动内部开发版.cmd”。刚才显示的旧窗口没有加载本次源码修复。");
    app.exit(1);
  } else {
    if (productDetailReleaseSmokeMode) process.exitCode = 1;
    app.quit();
  }
} else {
  app.on("second-instance", () => {
    diagnostics().event("app", "second_instance_requested");
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    let runtime;
    try {
      if (productDetailReleaseSmokeMode || developmentEdition && process.env.XIAOXI_DEV_PROFILE_DIR) {
        runtime = {
          ...resolveRuntimePaths(app.getPath("userData")),
          migrated: [],
          keptExisting: [],
          archived: [],
          splitState: [],
          skippedForeignInstall: true
        };
        fs.mkdirSync(runtime.rootDir, { recursive: true });
      } else {
        runtime = migrateLegacyRuntimeData({ appPath: app.getAppPath(), userDataDir: app.getPath("userData") });
      }
    } catch {
      if (productDetailReleaseSmokeMode) {
        console.error("product-detail packaged main-process smoke failed: isolated runtime setup failed");
        process.exitCode = 1;
        app.exit(1);
      } else {
        dialog.showErrorBox("数据迁移失败", "旧版本联系人或任务未能安全迁移，程序已停止启动；原数据不会被删除。");
        app.quit();
      }
      return;
    }
    const build = rendererBuildInfo();
    const appInfo = {
      name: app.getName(),
      version: components.businessVersion(app),
      edition: developmentEdition ? "development" : pilotEdition ? "pilot" : "unknown",
      data_profile: developmentEdition ? "test" : pilotEdition ? "delivery" : "unknown",
      build_id: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      build_commit: build.buildCommit || process.env.XIAOXI_BUILD_COMMIT || "",
      source_dirty: build.sourceDirty === true,
      packaged: app.isPackaged
    };
    const logger = configureDiagnostics({ rootDir: runtime.rootDir, appInfo });
    process.env.XIAOXI_INTERNAL_DIAGNOSTICS = logger.internalEnabled ? "1" : "0";
    // In-process RPA has no CLI --data-dir; share the same evidence directory.
    process.env.XIAOXI_FAILURE_DIR = path.join(runtime.rootDir, "failure-evidence");
    // The per-step flight recorder keeps real screen content, so it follows the
    // same internal profile that keeps unmasked failure screenshots.
    if (logger.internalEnabled) process.env.XIAOXI_FLIGHT_DIR = require("./flight-recorder.cjs").flightDirectory(runtime.rootDir);
    startupTiming.attach(logger);
    startupTiming.mark('local_runtime_ready');
    taskPassportStore = createTaskPassportStore({
      rootDir: runtime.rootDir,
      onWriteFailure: (detail) => logger.event("task_passport", "write_failed", detail, { level: "warn", code: "task_passport_write_failed" })
    });
    // A journal can cross its 30-day expiry during installation. Preserve the
    // snapshot's files for the helper's post-startup data confirmation; the next
    // normal launch resumes ordinary retention.
    taskPassportStore.cleanup({ defer: process.argv.includes("--xiaoxi-updated-launch") });
    logger.subscribe((entry) => taskPassportStore.observeDiagnostic(entry));
    // The log keeps only a safe summary; the capsule keeps the stack that locates the bug.
    const crashCapsule = (event, error) => failureCapsules?.record({ source: "crash", module: "app", event,
      code: typeof error?.code === "string" ? error.code : event, level: "fatal", message: String(error?.message || error || ""), traceback: String(error?.stack || "") });
    process.on("uncaughtException", (error) => { logger.event("app", "uncaught_exception", { error }, { level: "fatal", code: error?.code || "uncaught_exception" }); crashCapsule("uncaught_exception", error); });
    process.on("unhandledRejection", (error) => { logger.event("app", "unhandled_rejection", { error }, { level: "error", code: error?.code || "unhandled_rejection" }); crashCapsule("unhandled_rejection", error); });
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
    const maintenanceConfig = cloudConfig({ developmentEdition });
    // 打开即更新：检查完更新之前不启动任何业务任务（update-launch-gate.cjs）。
    // The hold is set before any service is created so none of them resumes work early. The relaunch
    // right after an update skips the gate: the helper is waiting for this version to report healthy.
    const updateHolds = { install: false, launch: !productDetailReleaseSmokeMode && app.isPackaged && maintenanceConfig.enabled === true
      && !process.argv.includes("--xiaoxi-updated-launch") };
    const applyUpdateHold = () => { global.__xiaoxiUpdateHold = updateHolds.launch || updateHolds.install; };
    applyUpdateHold();
    let openLaunchGate;
    const launchGateOpened = new Promise(resolve => { openLaunchGate = resolve; });
    if (!updateHolds.launch) openLaunchGate();
    const licenseStore = createLicenseStore({ rootDir: runtime.rootDir, safeStorage });
    // Phone + password accounts (device token on this computer); the license stays for the transition.
    const accountStore = createAccountStore({ rootDir: runtime.rootDir, safeStorage,
      onChange: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("account:changed"); } });
    providerGatewayClient = createProviderGatewayClient({
      config: {
        blockPaidCalls: developmentEdition && process.env.XIAOXI_DISABLE_PAID_CALLS === '1',
        enabled: !productDetailReleaseSmokeMode && developmentEdition && maintenanceConfig.enabled === true,
        origin: maintenanceConfig.origin,
        caPem: maintenanceConfig.caPem
      },
      licenseStore,
      accountStore,
      appId: maintenanceConfig.appId,
      channel: maintenanceConfig.channel,
      version: components.businessVersion(app),
      buildId: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      installId: (() => {
        try { return fs.readFileSync(path.join(logger.logsDir, "install-id"), "utf8").trim(); }
        catch { return ""; }
      })()
    });
    // Provider readiness gates sidecar spawning, never the local login window.
    let providerSession = providerGatewayClient.initialize().then(gatewayStatus => {
      startupTiming.mark('gateway_session_finished');
      logger.event('provider_gateway', 'session_initialized', {
        state: gatewayStatus.ready ? 'ready' : 'unavailable', code: gatewayStatus.code || ''
      });
      return gatewayStatus;
    });
    const waitForProviderSession = async () => {
      let pending;
      do { pending = providerSession; await pending; } while (pending !== providerSession);
    };
    // Who is signed in: the account when the gateway is on, otherwise the offline license.
    const identityStatus = () => providerGatewayClient.isEnabled() ? accountStore.status() : licenseStore.status();
    const onIdentityChanged = async ({ action }) => {
        contentEngineController?.invalidateCatalogs?.();
        // A login change during startup must not reuse the former identity's session.
        // A password login already opened its session; logins by license or device renew it.
        providerSession = providerSession.then(() => action === 'logged_out'
          ? providerGatewayClient.invalidate() : action === 'logged_in' ? providerGatewayClient.status() : providerGatewayClient.initialize({ force: true }));
        try { await businessWorkbenchRegistration?.refreshAccount?.(); }
        catch { logger.event('map_acquisition', 'account_refresh_failed', { code: 'LOCAL_ACCOUNT_UNAVAILABLE' }); }
        await waitForProviderSession();
        logger.event("provider_gateway", action === "logged_out" ? "session_invalidated" : "session_refreshed", {
          state: providerGatewayClient?.status().ready ? "ready" : "unavailable",
          code: providerGatewayClient?.status().code || ""
        });
        await restartImageProviderConsumers();
      };
    registerLicenseAuthIpc({ ipcMain, store: licenseStore, onChanged: onIdentityChanged });
    registerAccountAuthIpc({ ipcMain, accountStore, licenseStore, gatewayClient: providerGatewayClient, onChanged: onIdentityChanged });
    const deepSeekKeyStore = createDeepSeekKeyStore({ rootDir: runtime.rootDir, safeStorage });
    const bailianKeyStore = createBailianApiKeyStore({
      rootDir: path.join(app.getPath("userData"), "content-engine"),
      safeStorage
    });
    const deepSeekClient = createDeepSeekClient({ keyStore: deepSeekKeyStore, gatewayClient: providerGatewayClient });
    const volcengineTtsKeyStore = createVolcengineTtsKeyStore({ rootDir: path.join(app.getPath("userData"), "content-engine"), safeStorage });
    const volcengineArkKeyStore = createVolcengineTtsKeyStore({ rootDir: path.join(app.getPath("userData"), "content-engine"), safeStorage, filename: "volcengine-ark-api-key.bin" });
    const volcengineAsrStore = createVolcengineAsrStore({ rootDir: path.join(app.getPath("userData"), "content-engine"), safeStorage });
    const aiExpertStore = createAiExpertStore({ rootDir: runtime.rootDir });
    const productDetailDataDir = path.join(app.getPath("userData"), "product-detail");
    const productDetailAiSettingsStore = createProductDetailAiSettingsStore({
      rootDir: productDetailDataDir,
      safeStorage
    });
    const getProductDetailProviderEnvironment = () => {
      const providerEnvironment = { DEEPSEEK_MODEL };
      if (providerGatewayClient?.status().ready && maintenanceConfig.caPem) {
        providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
        providerEnvironment.XIAOXI_PROVIDER_GATEWAY_CA_PEM = maintenanceConfig.caPem;
      }
      if (providerGatewaySupports("deepseek")) {
        providerEnvironment.DEEPSEEK_API_KEY = providerGatewayClient.token();
        providerEnvironment.DEEPSEEK_API_URL = providerGatewayClient.url("/deepseek/v1/chat/completions");
      }
      if (providerGatewaySupports("apimart")) {
        providerEnvironment.REFINE_API_KEY = providerGatewayClient.token();
        providerEnvironment.REFINE_API_BASE_URL = providerGatewayClient.url("/apimart");
      }
      return providerEnvironment;
    };
    coordinator.initialize();
    productDetailController = createProductDetailSidecar({
      beforeStart: async () => {
        // Detail rendering also uses the content engine's bundled browser.
        await Promise.all([components.ensureRuntimeGroup("detail"), components.ensureRuntimeGroup("content")]);
        await waitForProviderSession();
      },
      runtimePath: productDetailRuntimePath(),
      runtimeArgs: app.isPackaged ? [] : developmentProductDetailLaunch.runtimeArgs,
      dataDir: productDetailDataDir,
      getTrustedRuntimeEnvironment: productDetailRuntimeEnvironment,
      getProviderEnvironment: productDetailReleaseSmokeMode || developmentEdition && process.env.XIAOXI_DISABLE_PAID_CALLS === '1'
        ? () => ({})
        : getProductDetailProviderEnvironment
    });
    productDetailIpcRegistration = registerProductDetailIpc({
      controller: productDetailController,
      getMainWindow: () => mainWindow
    });
    if (productDetailReleaseSmokeMode) {
      completeProductDetailReleaseSmoke();
      return;
    }
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
        workflowManaged: true,
        baseDir: runtime.momentsDir,
        coordinator,
        deepSeekClient,
        getMainWindow: () => mainWindow,
        BrowserWindow,
        screen,
        preloadPath: path.join(__dirname, preloadFile),
        rendererPath: path.join(__dirname, `../../${rendererDir}/index.html`),
        passport: taskPassportStore
      });
    }
    if (momentsPublish) {
      momentsPublishController = momentsPublish.registerMomentsPublishIpc({
        baseDir: runtime.momentsDir,
        coordinator,
        dialog,
        logger,
        passport: taskPassportStore,
        getMainWindow: () => mainWindow
      });
      momentsPublishController.initialize();
    }
    if (internalRealSend) disarmRealSend = () => internalRealSend.setRealSendArm(runtime.activeTouchDir, false);
    registerContactSyncIpc({
      dataDir: runtime.contactSyncDir, activeTouchDir: runtime.activeTouchDir, coordinator,
      withProgress: (operation, readProgress) => workflowController.runContactSync(operation, readProgress)
    });
    registerDiagnosticsIpc({ autoReplyDir: runtime.autoReplyDir, appInfo, screen,
      passport: taskPassportStore,
      getWechatState: () => {
        const snapshot = (read) => {
          try { return read() ?? { available: false }; }
          catch (error) { return { available: false, error }; }
        };
        const workflow = snapshot(() => workflowController?.status({ reconcile: false }));
        return {
          coordinator: snapshot(() => coordinator.status()),
          workflow,
          touch: snapshot(() => touchTaskController?.diagnosticSnapshot(workflow.currentTaskId || workflow.waitingTaskId || workflow.lastTaskId)),
          auto_reply: snapshot(() => autoReplyController?.status()),
          moments_publish: snapshot(() => momentsPublishController?.status()),
          moments_interact: snapshot(() => momentsCampaignController?.status())
        };
      },
      getFeedbackLatest: () => feedbackController?.status()?.items?.[0] || null });
    registerDeepSeekApiIpc({
      keyStore: deepSeekKeyStore,
      client: deepSeekClient,
      onChanged: restartProductDetailForProviderChange
    });
    registerProductDetailAiSettingsIpc({
      store: productDetailAiSettingsStore,
      managed: true,
      onChanged: restartImageProviderConsumers
    });
    const contentEnginePath = contentEngineRuntimePath();
    const contentEngineDataDir = path.join(app.getPath("userData"), "content-engine");
    let contentProviderConfiguration = "";
    const providerConfiguration = () => JSON.stringify([providerGatewayClient?.token() || '', providerGatewayClient?.status().capabilities || {}]);
    contentEngineController = createContentEngineSidecar({
      getCatalogScope: providerConfiguration,
      beforeStart: async () => {
        await components.ensureRuntimeGroup("content");
        await verifyRemotionRuntime();
        await waitForProviderSession();
      },
      runtimePath: contentEnginePath,
      runtimeArgs: contentEngineRuntimeArgs(),
      dataDir: contentEngineDataDir,
      getTrustedRuntimeEnvironment: () => contentEngineRuntimeEnvironment(
        contentEnginePath,
        contentEngineDataDir
      ),
      getProviderEnvironment: () => {
        const providerEnvironment = { DEEPSEEK_MODEL };
        const gatewayToken = providerGatewayClient?.token() || "";
        contentProviderConfiguration = providerConfiguration();
        const gatewayStatus = providerGatewayClient?.status();
        if (gatewayStatus?.ready && maintenanceConfig.caPem) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_CA_PEM = maintenanceConfig.caPem;
        }
        if (providerGatewaySupports("deepseek")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.DEEPSEEK_API_KEY = gatewayToken;
          providerEnvironment.DEEPSEEK_API_URL = providerGatewayClient.url("/deepseek/chat/completions");
        }
        if (providerGatewaySupports("bailian")) {
          providerEnvironment.DASHSCOPE_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_BAILIAN_API_HOST = providerGatewayClient.url("/bailian");
        }
        if (providerGatewaySupports("volcengine_tts")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_GATEWAY_ENABLED = "1";
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_API_URL = providerGatewayClient.url("/volcengine/tts/sse");
        }
        if (providerGatewaySupports("volcengine_asr")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_GATEWAY_ENABLED = "1";
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_ENDPOINT = providerGatewayClient.url("/volcengine/asr/recognize/flash");
        }
        providerEnvironment.XIAOXI_CONTENT_PROVIDER = "volcengine";
        if (providerGatewaySupports("volcengine_ark")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_URL = providerGatewayClient.url("/volcengine/ark/chat/completions");
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_HOST = providerGatewayClient.url("/volcengine/ark");
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_COMPATIBLE_ORIGIN = providerGatewayClient.url("/volcengine/ark");
        }
        if (providerGatewaySupports("apimart")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.APIMART_API_KEY = gatewayToken;
          providerEnvironment.APIMART_API_BASE_URL = providerGatewayClient.url("/apimart");
          providerEnvironment.APIMART_IMAGE_MODEL = "gpt-image-2";
          // Covers draw their own Chinese headline; must match createCoverPriceReader.
          providerEnvironment.APIMART_COVER_MODEL = "gpt-image-2.5-ext";
        }
        return providerEnvironment;
      }
    });
    for (const [controller, prefix] of [[productDetailController, "resources/product-detail/"], [contentEngineController, "resources/content-engine/"]]) {
      controller.onUpdate(state => {
        if (!["failed", "unavailable"].includes(state.state)) return;
        const decision = components.serviceRollbackDecision(state.code, prefix);
        if (decision.basis === "not_a_start_failure") return;
        logger.event("app", "service_failure_version_decision", { service_kind: prefix.split("/")[1], rollback_code: decision.basis, rollback: decision.rollback },
          { level: "warn", code: decision.rollback ? "version_rollback_requested" : "version_kept" });
        if (decision.rollback) components.invalidateVerification();
      });
    }
    const officialMaterials = require('./official-materials-ipc.cjs').registerOfficialMaterials({
      ipcMain, getMainWindow: () => mainWindow, rootDir: runtime.rootDir,
      appDir: path.resolve(__dirname, '../..'), config: maintenanceConfig,
      gatewayClient: providerGatewayClient, contentEngine: contentEngineController, shell
    });
    const tutorials = require('./tutorials-ipc.cjs').registerTutorials({
      ipcMain, getMainWindow: () => mainWindow, rootDir: runtime.rootDir, config: maintenanceConfig
    });
    registerContentMediaProtocol({
      protocol,
      net,
      resolveOfficialMedia: id => officialMaterials.resolveMedia(id) || tutorials.resolveMedia(id),
      controller: contentEngineController
    });
    const beforeContentProviderWork = async (capabilities = ["volcengine_ark", "volcengine_asr", "volcengine_tts"]) => {
        await providerGatewayClient?.initialize({ verify: true });
        const requiredCapabilities = [...new Set(capabilities)];
        const missingCapabilities = requiredCapabilities.filter((capability) => !providerGatewaySupports(capability));
        if (missingCapabilities.length) {
          throw Object.assign(new Error(`云端智能服务暂不可用（缺少：${missingCapabilities.join("、")}），当前任务未提交。`), {
            code: "PROVIDER_GATEWAY_UNAVAILABLE",
            requiredCapabilities: missingCapabilities
          });
        }
        if (contentProviderConfiguration === providerConfiguration()) return;
        if (contentEngineController.status().state === 'ready') {
          const result = await contentEngineController.listTasks({ limit: 500 });
          const active = new Set(['queued', 'analyzing', 'rendering']);
          if ((result.items || []).some((task) => active.has(task.status))) {
            throw Object.assign(new Error('AI 授权已更新，请等待当前制作完成或取消后继续，已有结果会保留。'),
                                { code: 'CONTENT_ENGINE_PROVIDER_REFRESH_BUSY' });
          }
        }
        const restarted = await contentEngineController.restart();
        if (restarted.state !== 'ready') throw Object.assign(new Error('授权已更新，内容引擎尚未就绪。'),
                                                           { code: 'CONTENT_ENGINE_PROVIDER_REFRESH_FAILED' });
      };
    const readCoverPrices = createCoverPriceReader({ fetch: net.fetch.bind(net), gatewayClient: providerGatewayClient });
    contentEngineIpcRegistration = registerContentEngineIpc({
      controller: contentEngineController,
      providerCapabilityStatus: providerGatewaySupports,
      beforeProviderWork: beforeContentProviderWork,
      dialog,
      shell,
      getMainWindow: () => mainWindow
    });
    // Requests call ensureReady themselves. Opening the login page must not
    // start or verify the browser/media runtime before a feature needs it.
    keywordAcquisitionRegistration = registerKeywordAcquisitionIpc({
      ipcMain, BrowserWindow, session, getMainWindow: () => mainWindow,
      dataDir: path.join(runtime.rootDir, "keyword_acquisition"),
      expertStore: aiExpertStore, deepSeekClient
    });
    socialAccountsRegistration = registerSocialAccountsIpc({ ipcMain, getMainWindow: () => mainWindow,
      dataDir: path.join(runtime.rootDir, "social_accounts") });
    socialAcquisitionRegistration = registerSocialAcquisitionIpc({ ipcMain, dialog, shell, getMainWindow: () => mainWindow,
      dataDir: path.join(runtime.rootDir, "social_acquisition"), accounts: socialAccountsRegistration.accounts });
    socialPublishRegistration = registerSocialPublishIpc({ ipcMain, getMainWindow: () => mainWindow, copyClient: deepSeekClient,
      ffmpegPath: app.isPackaged ? path.join(path.dirname(contentEngineRuntimePath()), "media-tools", "ffmpeg.exe") : process.env.XIAOXI_FFMPEG_PATH || "ffmpeg",
      dataDir: path.join(runtime.rootDir, "social_publish"), accounts: socialAccountsRegistration.accounts,
      logger, evidenceDir: path.join(runtime.rootDir, "failure-evidence"),
      resolveFinishedVideo: async (finishedVideoId) => {
        const result = await contentEngineController.resolveFinishedPath(finishedVideoId);
        if (result?.finished_video_id !== finishedVideoId) throw new Error("finished video mismatch");
        return require("./content-engine-ipc.cjs").resolvedAbsolutePath(result);
      },
      // The finished video's own cover, published with it; an engine without cover paths gives none.
      resolveFinishedCover: async (finishedVideoId) => {
        const result = await contentEngineController.resolveFinishedPath(finishedVideoId);
        if (result?.finished_video_id !== finishedVideoId) throw new Error("finished video mismatch");
        const cover = String(result.cover_path || "");
        return cover && path.isAbsolute(cover) ? require("./content-engine-ipc.cjs").resolvedAbsolutePath({ absolute_path: cover }) : "";
      } });
    // 养号 shares the accounts and hands its day-8 test video to 一键分发.
    socialNurtureRegistration = registerSocialNurtureIpc({ ipcMain, getMainWindow: () => mainWindow, accounts: socialAccountsRegistration.accounts,
      dataDir: path.join(runtime.rootDir, "social_nurture"), logger, evidenceDir: path.join(runtime.rootDir, "failure-evidence"),
      publish: (payload) => socialPublishRegistration.submitFinished(payload) });
    businessWorkbenchRegistration = registerBusinessWorkbenchIpc({ ipcMain, BrowserWindow, session, dialog, shell,
      dataDir: runtime.rootDir, getMainWindow: () => mainWindow, deepSeekClient, gatewayClient: providerGatewayClient, clipboard, getLicenseStatus: identityStatus });
    const usedDigitalHumanClicks = new Set();
    const readVideoPrices = createPriceReader({ fetch: net.fetch.bind(net), gatewayClient: providerGatewayClient });
    const prepareWorkbenchNarration = async (payload) => {
      await beforeContentProviderWork([]);
      try { return await contentEngineController.prepareVideoNarration(payload); }
      catch (error) {
        if (/CONTENT_ENGINE_.*(?:TIMEOUT|EXIT|STOP|WRITE)/u.test(error.code || '')) error.outcomeUnknown = true;
        throw error;
      }
    };
    const packageWorkbenchVideo = async (payload) => {
      if (!payload.prepared_transcript) await beforeContentProviderWork(["volcengine_asr"]);
      else await contentEngineController.start();
      return contentEngineController.importBaseVideo(payload);
    };
    const selectWorkbenchMusic = async ({ durationSeconds }) => {
      try {
        await contentEngineController.start();
        return await contentEngineController.selectVideoMusic(durationSeconds);
      } catch { return { status: 'unavailable', message: '音乐库暂不可用，本片保留讲解。' }; }
    };
    digitalHumanRegistration = registerDigitalHumanIpc({
      ipcMain, dialog, getMainWindow: () => mainWindow,
      rootDir: path.join(runtime.rootDir, "digital_human"),
      gatewayClient: providerGatewayClient,
      readReferencePrices: createReferencePriceReader({ fetch: net.fetch.bind(net) }),
      readCoverPrices,
      getGeneratedVideo: (id) => contentEngineController.getGeneratedVideo(id),
      // 爆款一键成片：成片文件路径、本地大字封面字体（缺字体时只影响封面）、完成提醒
      resolveGeneratedVideoPath: (id) => contentEngineController.resolveGeneratedVideoPath(id, "video"),
      developmentEdition,
      coverFontFile: (() => { try { return app.isPackaged ? resolveContentEngineBundledFont(contentEngineRuntimePath()) : path.join(__dirname, "..", "..", "sidecars", "content-engine", "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf"); } catch { return undefined; } })(),
      notify: (title, body) => { try { if (Notification.isSupported()) new Notification({ title, body: String(body || "").slice(0, 120) }).show(); } catch { /* 提醒失败不影响任务 */ } },
      generateCover: async (id, design, control) => { await beforeContentProviderWork(['apimart']); return contentEngineController.regenerateCover(id, design, control); },
      voiceCloneClient: createVoiceCloneClient({ gatewayClient: providerGatewayClient, rootDir: path.join(runtime.rootDir, "digital_human", "voice-clones"),
        ffmpegPath: app.isPackaged ? path.join(path.dirname(contentEngineRuntimePath()), "media-tools", "ffmpeg.exe") : process.env.XIAOXI_FFMPEG_PATH || "ffmpeg" }),
      selectMusic: selectWorkbenchMusic,
      ffmpegPath: app.isPackaged
        ? path.join(path.dirname(contentEngineRuntimePath()), "media-tools", "ffmpeg.exe")
        : process.env.XIAOXI_FFMPEG_PATH || "ffmpeg",
      requireTrustedClick: (event, payload, action) => {
        const token = String(payload?.clickToken || "");
        const prefix = `digital-human:${action}:`;
        const uuid = token.startsWith(prefix) ? token.slice(prefix.length) : "";
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(uuid)
            || usedDigitalHumanClicks.has(token) || !mainWindow || mainWindow.isDestroyed()
            || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) {
          throw Object.assign(new Error("请点击页面按钮开始制作。"), { code: "trusted_user_click_required" });
        }
        usedDigitalHumanClicks.add(token);
        if (usedDigitalHumanClicks.size > 200) usedDigitalHumanClicks.delete(usedDigitalHumanClicks.values().next().value);
      },
      packageVideo: packageWorkbenchVideo,
      queryPackaging: (id) => contentEngineController.getTask(id)
    });
    const usedProductVideoClicks = new Set();
    productVideoRegistration = registerProductVideoIpc({
      ipcMain, dialog, getMainWindow: () => mainWindow,
      rootDir: path.join(runtime.rootDir, "product_video"),
      listVoices: async () => { await contentEngineController.start(); return contentEngineController.listAutoMixVoicePersonas(); },
      defaultExportDir: app.getPath("downloads"),
      gatewayClient: providerGatewayClient,
      readPrices: readVideoPrices,
      packageVideo: packageWorkbenchVideo,
      queryPackaging: (id) => contentEngineController.getTask(id),
      resolvePackagingVideo: (id) => contentEngineController.resolveGeneratedVideoPath(id),
      prepareAudio: createProductAudioPreparer({ gatewayClient: providerGatewayClient,
        prepareNarration: prepareWorkbenchNarration,
        selectMusic: selectWorkbenchMusic }),
      ffmpegPath: app.isPackaged
        ? path.join(path.dirname(contentEngineRuntimePath()), "media-tools", "ffmpeg.exe")
        : process.env.XIAOXI_FFMPEG_PATH || "ffmpeg",
      imageThumbnail: (bytes) => nativeImage.createFromBuffer(bytes).resize({ width: 320 }).toDataURL(),
      requireTrustedClick: (event, payload, action) => {
        const token = String(payload?.clickToken || "");
        const prefix = `product-video:${action}:`;
        const uuid = token.startsWith(prefix) ? token.slice(prefix.length) : "";
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(uuid)
            || usedProductVideoClicks.has(token) || !mainWindow || mainWindow.isDestroyed()
            || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) {
          throw Object.assign(new Error("请点击页面按钮开始制作。"), { code: "trusted_user_click_required" });
        }
        usedProductVideoClicks.add(token);
        if (usedProductVideoClicks.size > 200) usedProductVideoClicks.delete(usedProductVideoClicks.values().next().value);
      }
    });
    registerAiExpertIpc({ store: aiExpertStore, deepSeekClient, isAutoReplyRunning: () => ["starting", "running"].includes(autoReplyController?.status().status) });
    if (internalRealSend) {
      autoReplyController = registerAutoReplyIpc({
        getMainWindow: () => mainWindow,
        BrowserWindow,
        screen,
        preloadPath: path.join(__dirname, preloadFile),
        rendererPath: path.join(__dirname, `../../${rendererDir}/index.html`),
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
        }),
        passport: taskPassportStore
      });
    }
    touchTaskController = registerTouchTaskIpc({
      getMainWindow: () => mainWindow,
      dataDir: runtime.activeTouchDir,
      coordinator,
      deepSeekClient,
      appVersion: components.businessVersion(app),
      buildId: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      buildCommit: build.buildCommit || process.env.XIAOXI_BUILD_COMMIT || "",
      executionMode: "real_send",
      realSendExecutor: internalRealSend.executeVerifiedContactSend,
      verifyRealSendSession: internalRealSend.refreshRealSendSession,
      verifyMessageBubble: internalRealSend.verifyMessageBubble,
      detectDeliveryNotice: internalRealSend ? require("../../rpa/active_touch/wechat_delivery_notice.cjs").detectWechatDeliveryNoticeAsync : undefined,
      onPause: disarmRealSend || undefined,
      passport: taskPassportStore
    });
    workflowController = registerWechatWorkflowIpc({
      ...runtime,
      logger,
      appVersion: components.businessVersion(app),
      buildId: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      buildCommit: build.buildCommit || process.env.XIAOXI_BUILD_COMMIT || "",
      getMomentsProgress: (task) => momentsCampaignController?.workflowProgress(task),
      getMainWindow: () => mainWindow,
      isQuitting: () => quitCleanupStarted,
      preloadPath: path.join(__dirname, preloadFile),
      rendererPath: path.join(__dirname, `../../${rendererDir}/index.html`),
      getAccount: () => {
        try { return String(JSON.parse(fs.readFileSync(path.join(runtime.contactSyncDir, "state.json"), "utf8")).account_name || ""); }
        catch { return ""; }
      },
      verifyLiveAccount: internalRealSend ? (accountId) => {
        let wechatRoot = "";
        try { wechatRoot = String(JSON.parse(fs.readFileSync(path.join(runtime.contactSyncDir, "state.json"), "utf8")).wechat_root || ""); } catch {}
        return require("../../rpa/active_touch/wechat_window_driver.dev.cjs").verifyLoggedInWechatAccountAsync(accountId, wechatRoot);
      } : undefined,
      executors: {
        touch: {
          prepareWorkflowTask: (_id, payload) => touchTaskController.prepareWorkflowTask(payload),
          updateWorkflowTask: touchTaskController.updateWorkflowTask,
          hasStartedWorkflowTask: touchTaskController.hasStartedWorkflowTask,
          runWorkflowStep: touchTaskController.runWorkflowStep,
          canRetryWorkflowTask: touchTaskController.canRetryWorkflowTask,
          describeUnknownWorkflowTask: touchTaskController.describeUnknownWorkflowTask,
          resolveUnknownWorkflowTask: touchTaskController.resolveUnknownWorkflowTask,
          acknowledgeUnknownWorkflowResolution: touchTaskController.acknowledgeUnknownWorkflowResolution,
          describeSkippedWorkflowTask: touchTaskController.describeSkippedWorkflowTask,
          retrySkippedWorkflowTask: touchTaskController.retrySkippedWorkflowTask,
          describeImages: touchTaskController.describeImages,
          importImages: touchTaskController.importImages
        },
        publish: momentsPublishController,
        interact: momentsCampaignController
      },
      reply: autoReplyController
    });
    createWindow();
    registerRolePreferencesIpc({ ipcMain, controller: createRolePreferences({ rootDir: runtime.rootDir }), getMainWindow: () => mainWindow });
    if (!productDetailReleaseSmokeMode) {
      feedbackController = createFeedbackController({ rootDir: runtime.rootDir, config: maintenanceConfig,
        version: components.businessVersion(app), buildId: build.buildId, logger, safeStorage,
        identity: () => cloudMaintenance?.identity(), relatedCapsules: query => failureCapsules?.related(query) || [] });
      feedbackAdmin = createFeedbackAdmin({ config: maintenanceConfig });
      registerFeedbackIpc({ ipcMain, admin: feedbackAdmin, controller: feedbackController, getMainWindow: () => mainWindow });
      feedbackController.start();
      cloudMaintenance = createCloudMaintenance({
        rootDir: runtime.rootDir, config: maintenanceConfig,
        version: components.businessVersion(app), buildId: build.buildId, logger,
        componentBaseRoot: app.isPackaged ? components.currentRoot() : null, userData: app.getPath("userData"),
        getLicenseStatus: identityStatus,
        canInstall: () => app.isPackaged && process.platform === "win32" && maintenanceConfig.enabled === true
          && Boolean(installerTargets[maintenanceConfig.channel])
          && path.dirname(process.execPath).toLowerCase() === path.join(process.env.LOCALAPPDATA || "", "Programs", installerTargets[maintenanceConfig.channel].installDirectoryName).toLowerCase()
      });
      let maintenanceStage;
      cloudMaintenance.onUpdate(state => {
        if (state.stage === maintenanceStage) return;
        maintenanceStage = state.stage;
        if (app.isPackaged && !quitCleanupStarted && !state.updateRequested && ["ready", "current", "error"].includes(state.stage)) {
          void require("./update-exit-maintenance.cjs").prepareExitMaintenance({ profile: app.getPath("userData"), runtimeRoot: components.currentRoot() })
            .catch(error => logger.event("app", "exit_helper_prepare_deferred", { code: error.code || error.message }));
        }
      });
      let workflowPause = null;
      const updater = require("./update-coordinator.cjs").createUpdateCoordinator({
        controller: cloudMaintenance, setHold: value => { updateHolds.install = value; applyUpdateHold(); },
        prepare: async () => {
          const workflow = workflowController?.status();
          if (workflow?.enabled && !workflowPause) {
            workflowPause = workflowController.pause("update");
            workflowPause.catch(() => {});
          }
          if (workflow?.enabled || workflow?.phase === "pausing" || workflow?.contactSync?.running || coordinator.status().lock) return "正在等待微信操作完成并保存结果。";
          if (workflowPause) await workflowPause;
          const states = await Promise.all([productVideoRegistration?.service?.prepareForUpdate(), digitalHumanRegistration?.service?.prepareForUpdate()]);
          if (states.some(state => state?.busy)) return "正在等待视频任务保存。";
          const content = contentEngineController?.updateStatus();
          if (content?.pending || (content?.alive && content.state !== "ready")) return "正在等待当前内容任务完成。";
          const summary = content?.state === "ready" ? await contentEngineController.productionSummary() : { active: 0 };
          const product = await productDetailController?.prepareUpdate(true);
          return summary.active > 0 || product?.busy ? "正在等待图片和视频制作完成。" : "";
        },
        release: async () => {
          workflowPause = null;
          productVideoRegistration?.service?.resumeAfterUpdate();
          digitalHumanRegistration?.service?.resumeAfterUpdate();
          await productDetailController?.prepareUpdate(false).catch(() => {});
        }, quit: () => app.quit()
      });
      // 打开即更新：新版下载校验好后，在不打断任何任务、用户没在操作时自动安装重启。
      const autoUpdate = require("./update-auto.cjs").createAutoUpdate({
        controller: cloudMaintenance, request: updater.request, cancel: updater.cancel,
        idleSeconds: () => powerMonitor.getSystemIdleTime(),
        busy: async () => {
          const workflow = workflowController?.status();
          if (workflow?.enabled || workflow?.phase === "pausing" || workflow?.contactSync?.running || coordinator.status().lock) return true;
          if (productVideoRegistration?.service?.isBusy?.() || digitalHumanRegistration?.service?.isBusy?.()) return true;
          // 地图、关键词等浏览器任务在跑，或者有登录/悬浮窗口正显示着，都算在用。
          if (businessWorkbenchRegistration?.controllers?.get("map-acquisition")?.snapshot().busy) return true;
          if (keywordAcquisitionRegistration?.snapshot?.().runs?.some(run => run.status === "running")) return true;
          if (socialPublishRegistration?.isBusy() || socialAcquisitionRegistration?.isBusy() || socialNurtureRegistration?.isBusy()) return true;
          if (BrowserWindow.getAllWindows().some(window => window !== mainWindow && !window.isDestroyed() && window.isVisible())) return true;
          const content = contentEngineController?.updateStatus();
          if (content?.pending || (content?.alive && content.state !== "ready")) return true;
          return content?.state === "ready" && (await contentEngineController.productionSummary()).active > 0;
        }
      });
      registerCloudMaintenanceIpc({ ipcMain, controller: cloudMaintenance, getMainWindow: () => mainWindow,
        restart: () => { autoUpdate.userRequested(); return updater.request(); }, cancelUpdate: updater.cancel });
      if (updateHolds.launch) {
        // Started before cloudMaintenance.start(), so the gate owns the launch check.
        void require("./update-launch-gate.cjs").createLaunchGate({
          controller: cloudMaintenance, request: updater.request,
          setHold: value => { updateHolds.launch = value; applyUpdateHold(); },
          publish: state => cloudMaintenance.setLaunchGate(state),
          onOpen: reason => {
            logger.event("maintenance", "launch_gate_open", { reason });
            productVideoRegistration?.service?.resumeAfterUpdate();
            digitalHumanRegistration?.service?.resumeAfterUpdate();
            openLaunchGate();
          }
        }).start();
      }
      cloudMaintenance.start();
      autoUpdate.start();
      failureCapsules = createFailureCapsules({
        rootDir: runtime.rootDir, logger, engineLogsDir: path.join(app.getPath("userData"), "content-engine", "logs"),
        serviceLogsDirs: { product_detail: path.join(app.getPath("userData"), "product-detail", "logs") },
        network: maintenanceConfig.enabled ? require("./cloud-transport.cjs").createTransport(maintenanceConfig) : null,
        identity: () => cloudMaintenance?.identity(), isEnabled: () => cloudMaintenance?.consentEnabled() === true,
        environment: () => ({ version: components.businessVersion(app), buildId: build.buildId, edition: appInfo.edition,
          dataProfile: appInfo.data_profile, os: require("node:os").release(), osVersion: require("node:os").version(),
          memoryMb: Math.round(require("node:os").totalmem() / 1048576), freeMemoryMb: Math.round(require("node:os").freemem() / 1048576),
          cpus: require("node:os").cpus().length, uptimeS: Math.round(process.uptime()),
          displays: screen.getAllDisplays().map(display => ({ width: display.size.width, height: display.size.height, scale: display.scaleFactor })) })
      });
      failureCapsules.start();
    }
    productDetailDownloadRegistration = registerProductDetailDownloads({
      session: mainWindow.webContents.session,
      getMainWindow: () => mainWindow,
      getProductDetailOrigin: () => productDetailController?.status().origin || "",
      getDesktopPath: () => app.getPath("desktop"),
      diagnostics: logger
    });
    // Daily Moments automation drives WeChat, so it waits for the launch update check.
    void launchGateOpened.then(() => momentsCampaignController?.initialize());
    logger.event("app", "ready", { window_created: true });
    const readyWindow = mainWindow;
    // Health must not wait for the launch gate: closing during an update download would otherwise
    // leave boot-attempt.json behind and roll back a working version on the next launch.
    Promise.resolve(readyWindow.__xiaoxiLoaded).then(() => readyWindow.webContents.executeJavaScript(
      "new Promise(resolve => { const until = Date.now() + 15000; const check = () => { if (document.getElementById('root')?.childElementCount) resolve(true); else if (Date.now() > until) resolve(false); else setTimeout(check, 100); }; check(); })"
    )).then(async ready => {
      if (!ready) return;
      components.markHealthy(); cloudMaintenance?.refreshLocalState();
      // Retry only previously registered retirement, after the real page works.
      // Unclassified historical backups and current/candidate versions stay protected.
      if (app.isPackaged) {
        await require("./update-startup-maintenance.cjs").maintainAfterStartup(components.updatePaths(app.getPath("userData")).directory,
          { profile: app.getPath("userData"), version: components.businessVersion(app), runtimeRoot: components.currentRoot() })
          .catch(error => logger.event("app", "startup_housekeeping_deferred", { code: error.code || error.message }));
        await require("./update-exit-maintenance.cjs").prepareExitMaintenance({ profile: app.getPath("userData"), runtimeRoot: components.currentRoot() });
      }
    }).catch(error => logger.event("app", "startup_housekeeping_deferred", { code: error.code || "housekeeping_failed" }));

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      if (mainWindow) mainWindow.show();
    });
  }).catch(error => {
    try { diagnostics().event('startup', 'initialization_failed', { error }, { level: 'fatal' }); } catch {}
    if (productDetailReleaseSmokeMode) console.error(error);
    else dialog.showErrorBox('软件未能启动', String(error.message || error));
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitCleanupComplete) return;
    event.preventDefault();
    if (quitCleanupStarted) return;
    quitCleanupStarted = true;
    const workflow = workflowController?.controlSnapshot?.();
    try { diagnostics().event("app", "quit_requested", { workflow_phase: workflow?.phase,
      workflow_enabled: workflow?.enabled }, { trace: true }); } catch {}
    cloudMaintenance?.stop();
    failureCapsules?.stop();
    feedbackController?.stop();
    feedbackAdmin?.stop();
    const cleanupTimeout = new Promise((resolve) => {
      setTimeout(resolve, 8_000);
    });
    Promise.race([
      Promise.allSettled([
        Promise.resolve(keywordAcquisitionRegistration?.dispose()),
        Promise.resolve(socialAcquisitionRegistration?.dispose()),
        Promise.resolve(socialNurtureRegistration?.dispose()),
        Promise.resolve(socialPublishRegistration?.dispose()),
        Promise.resolve(socialAccountsRegistration?.dispose()),
        Promise.resolve(businessWorkbenchRegistration?.dispose()),
        Promise.resolve(digitalHumanRegistration?.close()),
        Promise.resolve(productVideoRegistration?.close()),
        Promise.resolve(productDetailController?.dispose()),
        Promise.resolve(contentEngineController?.dispose()),
        Promise.resolve(workflowController?.dispose()),
        Promise.resolve(momentsPublishController?.dispose()),
        Promise.resolve(providerGatewayClient?.close())
      ]),
      cleanupTimeout
    ]).catch(() => undefined).finally(async () => {
      productDetailIpcRegistration?.dispose();
      productDetailDownloadRegistration?.dispose();
      contentEngineIpcRegistration?.dispose();
      momentsCampaignController?.dispose();
      await cloudMaintenance?.installOnExit();
      if (app.isPackaged && !cloudMaintenance?.status().updateRequested) {
        try {
          await require("./update-exit-maintenance.cjs").launchExitMaintenance({
            profile: app.getPath("userData"), runtimeRoot: components.currentRoot()
          });
        } catch (error) { diagnostics().event("app", "exit_housekeeping_deferred", { code: error.code || "housekeeping_failed" }); }
      }
      quitCleanupComplete = true;
      app.quit();
    });
  });
}
