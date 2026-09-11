const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const components = require("./component-paths.cjs");
const productBrand = require("../../product-brand.json");
const installerTargets = require("../../installer-targets.json");
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
const { cloudConfig } = require("./cloud-config.cjs");
const { createCloudMaintenance } = require("./cloud-maintenance.cjs");
const { registerCloudMaintenanceIpc } = require("./cloud-maintenance-ipc.cjs");
const { createRolePreferences, registerRolePreferencesIpc } = require("./role-preferences.cjs");
const { createFeedbackController } = require("./feedback-controller.cjs");
const { createFeedbackAdmin } = require("./feedback-admin.cjs");
const { registerFeedbackIpc } = require("./feedback-ipc.cjs");
const { createLicenseStore, registerLicenseAuthIpc } = require("./license-auth-ipc.cjs");
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
const { createBailianApiKeyStore } = require("./bailian-api-key.cjs");
const { createVolcengineTtsKeyStore, createVolcengineAsrStore } = require("./volcengine-tts-settings.cjs");
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
let workflowController = null;
let momentsCampaignController = null;
let momentsPublishController = null;
let productDetailController = null;
let productDetailIpcRegistration = null;
let productDetailDownloadRegistration = null;
let contentEngineController = null;
let contentEngineIpcRegistration = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let cloudMaintenance = null;
let feedbackController = null;
let feedbackAdmin = null;
let providerGatewayClient = null;

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
  const configuredPath = String(process.env.XIAOXI_PRODUCT_DETAIL_SIDECAR || "").trim();
  if (configuredPath) return configuredPath;
  return resolveDefaultDevelopmentSidecarRuntime("product-detail");
}

function contentEngineRuntimePath() {
  if (app.isPackaged) {
    return path.join(
      components.resourcesPath(),
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
  const entryPath = String(process.env.XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY || "").trim();
  return entryPath ? [entryPath] : [];
}

function remotionRuntimeEnvironment() {
  return resolveRemotionRuntimeEnvironment({
    environment: process.env,
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    moduleDir: __dirname,
    resourcesPath: components.resourcesPath()
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
if (productDetailReleaseSmokeMode && productDetailReleaseSmokeDataDirIsValid) {
  app.setPath("userData", productDetailReleaseSmokeDataDir);
} else if (developmentEdition) {
  app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-test"));
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
    icon: path.join(__dirname, `../../${rendererDir}/app-icon.ico`),
    title: [productBrand.displayName, editionLabel].filter(Boolean).join(" "),
    webPreferences: productDetailWebPreferences()
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
      if (productDetailReleaseSmokeMode) {
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
    const logger = configureDiagnostics({
      rootDir: runtime.rootDir,
      appInfo: {
        name: app.getName(),
        version: components.businessVersion(app),
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
    const maintenanceConfig = cloudConfig({ developmentEdition });
    const licenseStore = createLicenseStore({ rootDir: runtime.rootDir, safeStorage });
    providerGatewayClient = createProviderGatewayClient({
      config: {
        enabled: !productDetailReleaseSmokeMode && developmentEdition && maintenanceConfig.enabled === true,
        origin: maintenanceConfig.origin,
        caPem: maintenanceConfig.caPem
      },
      licenseStore,
      appId: maintenanceConfig.appId,
      channel: maintenanceConfig.channel,
      version: components.businessVersion(app),
      buildId: build.buildId || process.env.XIAOXI_BUILD_ID || "",
      installId: (() => {
        try { return fs.readFileSync(path.join(logger.logsDir, "install-id"), "utf8").trim(); }
        catch { return ""; }
      })()
    });
    const gatewayStatus = await providerGatewayClient.initialize();
    logger.event("provider_gateway", "session_initialized", {
      state: gatewayStatus.ready ? "ready" : "unavailable",
      code: gatewayStatus.code || "",
      deepseek: gatewayStatus.capabilities?.deepseek === true,
      bailian: gatewayStatus.capabilities?.bailian === true,
      volcengine_ark: gatewayStatus.capabilities?.volcengine_ark === true,
      volcengine_tts: gatewayStatus.capabilities?.volcengine_tts === true,
      volcengine_asr: gatewayStatus.capabilities?.volcengine_asr === true,
      apimart: gatewayStatus.capabilities?.apimart === true
    });
    registerLicenseAuthIpc({
      ipcMain,
      store: licenseStore,
      onChanged: async ({ action }) => {
        if (action === "logged_out") providerGatewayClient?.invalidate();
        else await providerGatewayClient?.initialize({ force: true });
        logger.event("provider_gateway", action === "logged_out" ? "session_invalidated" : "session_refreshed", {
          state: providerGatewayClient?.status().ready ? "ready" : "unavailable",
          code: providerGatewayClient?.status().code || ""
        });
        await restartImageProviderConsumers();
      }
    });
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
      if (providerGatewaySupports("deepseek")) {
        providerEnvironment.DEEPSEEK_API_KEY = providerGatewayClient.token();
        providerEnvironment.DEEPSEEK_API_URL = providerGatewayClient.url("/deepseek/v1/chat/completions");
      } else if (deepSeekKeyStore.status().configured) {
        providerEnvironment.DEEPSEEK_API_KEY = deepSeekKeyStore.read();
      }
      const refineStatus = productDetailAiSettingsStore.status();
      if (providerGatewaySupports("apimart")) {
        providerEnvironment.REFINE_API_KEY = providerGatewayClient.token();
        providerEnvironment.REFINE_API_BASE_URL = providerGatewayClient.url("/apimart");
      } else if (refineStatus.ready) {
        const refine = productDetailAiSettingsStore.runtimeConfig();
        providerEnvironment.REFINE_API_KEY = refine.apiKey;
        providerEnvironment.REFINE_API_BASE_URL = refine.baseUrl;
      }
      return providerEnvironment;
    };
    coordinator.initialize();
    productDetailController = createProductDetailSidecar({
      runtimePath: productDetailRuntimePath(),
      dataDir: productDetailDataDir,
      getTrustedRuntimeEnvironment: productDetailRuntimeEnvironment,
      getProviderEnvironment: productDetailReleaseSmokeMode
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
        rendererPath: path.join(__dirname, `../../${rendererDir}/index.html`)
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
    registerContactSyncIpc({
      dataDir: runtime.contactSyncDir, activeTouchDir: runtime.activeTouchDir, coordinator,
      withProgress: (operation, readProgress) => workflowController.runContactSync(operation, readProgress)
    });
    registerDiagnosticsIpc({ autoReplyDir: runtime.autoReplyDir });
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
        const gatewayToken = providerGatewayClient?.token() || "";
        if (providerGatewaySupports("bailian")) {
          providerEnvironment.DASHSCOPE_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_BAILIAN_API_HOST = providerGatewayClient.url("/bailian");
        } else if (bailianKeyStore.status().configured) {
          providerEnvironment.DASHSCOPE_API_KEY = bailianKeyStore.read();
          const bailianStatus = bailianKeyStore.status();
          if (bailianStatus.apiHost) providerEnvironment.XIAOXI_BAILIAN_API_HOST = bailianStatus.apiHost;
        }
        if (providerGatewaySupports("volcengine_tts")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_GATEWAY_ENABLED = "1";
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_API_URL = providerGatewayClient.url("/volcengine/tts/sse");
        } else if (volcengineTtsKeyStore.status().configured) {
          providerEnvironment.XIAOXI_VOLCENGINE_TTS_API_KEY = volcengineTtsKeyStore.read();
        }
        if (providerGatewaySupports("volcengine_asr")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_GATEWAY_ENABLED = "1";
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_ENDPOINT = providerGatewayClient.url("/volcengine/asr/recognize/flash");
        } else if (volcengineAsrStore.status().configured) {
          const asr = volcengineAsrStore.read();
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_APP_ID = asr.appId;
          providerEnvironment.XIAOXI_VOLCENGINE_ASR_ACCESS_TOKEN = asr.accessToken;
        }
        providerEnvironment.XIAOXI_CONTENT_PROVIDER = "volcengine";
        if (providerGatewaySupports("volcengine_ark")) {
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_TOKEN = gatewayToken;
          providerEnvironment.XIAOXI_PROVIDER_GATEWAY_ORIGIN = maintenanceConfig.origin;
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_KEY = gatewayToken;
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_URL = providerGatewayClient.url("/volcengine/ark/chat/completions");
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_HOST = providerGatewayClient.url("/volcengine/ark");
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_COMPATIBLE_ORIGIN = providerGatewayClient.url("/volcengine/ark");
        } else if (volcengineArkKeyStore.status().configured) {
          providerEnvironment.XIAOXI_VOLCENGINE_ARK_API_KEY = volcengineArkKeyStore.read();
        }
        if (providerGatewaySupports("apimart")) {
          providerEnvironment.APIMART_API_KEY = gatewayToken;
          providerEnvironment.APIMART_API_BASE_URL = providerGatewayClient.url("/apimart");
          providerEnvironment.APIMART_IMAGE_MODEL = "gpt-image-2";
        } else if (productDetailAiSettingsStore.status().ready) {
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
      volcengineTtsKeyStore,
      volcengineArkKeyStore,
      volcengineAsrStore,
      dialog,
      shell,
      getMainWindow: () => mainWindow
    });
    contentEngineController.start().catch(() => undefined);
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
    workflowController = registerWechatWorkflowIpc({
      ...runtime,
      logger,
      getMomentsProgress: (task) => momentsCampaignController?.workflowProgress(task),
      getMainWindow: () => mainWindow,
      isQuitting: () => quitCleanupStarted,
      preloadPath: path.join(__dirname, preloadFile),
      rendererPath: path.join(__dirname, `../../${rendererDir}/index.html`),
      getAccount: () => {
        try { return String(JSON.parse(fs.readFileSync(path.join(runtime.contactSyncDir, "state.json"), "utf8")).account_name || ""); }
        catch { return ""; }
      },
      executors: {
        touch: {
          prepareWorkflowTask: (_id, payload) => touchTaskController.prepareWorkflowTask(payload),
          runWorkflowStep: touchTaskController.runWorkflowStep,
          canRetryWorkflowTask: touchTaskController.canRetryWorkflowTask,
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
        version: components.businessVersion(app), buildId: build.buildId, logger, safeStorage });
      feedbackAdmin = createFeedbackAdmin({ config: maintenanceConfig });
      registerFeedbackIpc({ ipcMain, admin: feedbackAdmin, controller: feedbackController, getMainWindow: () => mainWindow });
      feedbackController.start();
      cloudMaintenance = createCloudMaintenance({
        rootDir: runtime.rootDir, config: maintenanceConfig,
        version: components.businessVersion(app), buildId: build.buildId, logger,
        componentBaseRoot: app.isPackaged ? components.currentRoot() : null, userData: app.getPath("userData"),
        canInstall: () => app.isPackaged && process.platform === "win32" && developmentEdition
          && path.dirname(process.execPath).toLowerCase() === path.join(process.env.LOCALAPPDATA || "", "Programs", installerTargets.test.installDirectoryName).toLowerCase()
      });
      registerCloudMaintenanceIpc({ ipcMain, controller: cloudMaintenance, getMainWindow: () => mainWindow,
        restart: async () => {
          if (global.__xiaoxiUpdateHold) return cloudMaintenance.status();
          if (!await cloudMaintenance.prepareInstall()) return cloudMaintenance.status();
          const response = await dialog.showMessageBox(mainWindow, {
            type: "question", title: "安装更新", buttons: ["稍后", "退出并更新"], defaultId: 0, cancelId: 0,
            message: "退出软件并安装已下载的更新？", detail: "请先保存编辑内容，并结束微信和视频制作任务。"
          });
          if (response.response !== 1) return cloudMaintenance.status();
          global.__xiaoxiUpdateHold = true;
          let leaving = false;
          try {
            const workflow = workflowController?.status();
            if (workflow?.enabled || workflow?.contactSync?.running || coordinator.status().lock) {
              return cloudMaintenance.setInstallBlocked("微信任务仍在运行，请先暂停或完成任务，再点击退出并更新。");
            }
            const content = contentEngineController?.updateStatus();
            if (content?.pending || (content?.alive && content.state !== "ready")) return cloudMaintenance.setInstallBlocked("内容任务尚未结束，请完成当前操作后再更新。");
            const summary = content?.state === "ready" ? await contentEngineController.productionSummary() : { active: 0 };
            const product = await productDetailController?.prepareUpdate(true);
            if (summary.active > 0 || product?.busy) return cloudMaintenance.setInstallBlocked("还有视频或图片正在制作。已保留更新，制作完成后再点击退出并更新。");
            leaving = await cloudMaintenance.beginInstall();
            if (leaving) app.quit();
          } catch {
            cloudMaintenance.setInstallBlocked("暂时无法确认任务是否结束，尚未退出。请稍后重试更新。");
          } finally {
            if (!leaving) { global.__xiaoxiUpdateHold = false; await productDetailController?.prepareUpdate(false).catch(() => {}); }
          }
          return cloudMaintenance.status();
        }
      });
      cloudMaintenance.start();
    }
    productDetailDownloadRegistration = registerProductDetailDownloads({
      session: mainWindow.webContents.session,
      getMainWindow: () => mainWindow,
      getProductDetailOrigin: () => productDetailController?.status().origin || "",
      getDesktopPath: () => app.getPath("desktop"),
      diagnostics: logger
    });
    momentsCampaignController?.initialize();
    logger.event("app", "ready", { window_created: true });
    const readyWindow = mainWindow;
    Promise.resolve(readyWindow.__xiaoxiLoaded).then(() => readyWindow.webContents.executeJavaScript(
      "new Promise(resolve => { const until = Date.now() + 15000; const check = () => { if (document.getElementById('root')?.childElementCount) resolve(true); else if (Date.now() > until) resolve(false); else setTimeout(check, 100); }; check(); })"
    )).then(ready => { if (ready) { components.markHealthy(); cloudMaintenance?.refreshLocalState(); } }).catch(() => {});

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
    cloudMaintenance?.stop();
    feedbackController?.stop();
    feedbackAdmin?.stop();
    const cleanupTimeout = new Promise((resolve) => {
      setTimeout(resolve, 8_000);
    });
    Promise.race([
      Promise.allSettled([
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
      quitCleanupComplete = true;
      app.quit();
    });
  });
}
