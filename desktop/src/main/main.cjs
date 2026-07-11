const { app, BrowserWindow, dialog, safeStorage } = require("electron");
const path = require("node:path");
const { registerActiveTouchIpc } = require("./active-touch-ipc.cjs");
const { registerContactSyncIpc } = require("./contact-sync-ipc.cjs");
const { migrateLegacyRuntimeData } = require("./runtime-data.cjs");
const { registerTouchTaskIpc } = require("./touch-task-ipc.cjs");
const { createRuntimeCoordinator } = require("./runtime-coordinator.cjs");
const { createDeepSeekClient, createDeepSeekKeyStore } = require("./deepseek-api.cjs");
const { registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");
const { developmentEdition, editionLabel, preloadFile } = require("./edition.cjs");

let mainWindow = null;
let disarmDevelopmentRealSend = null;

// ponytail: development needs a separate Electron profile so it can run beside the customer edition.
if (developmentEdition) app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-development"));

const gotSingleInstanceLock = app.requestSingleInstanceLock();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    autoHideMenuBar: true,
    backgroundColor: "#f8d9df",
    title: `小玺AI员工 ${editionLabel}`,
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.on("close", () => {
    disarmDevelopmentRealSend?.();
  });
  mainWindow.on("blur", () => {
    disarmDevelopmentRealSend?.();
  });
  mainWindow.on("minimize", () => {
    disarmDevelopmentRealSend?.();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
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
    const coordinator = createRuntimeCoordinator(runtime.rootDir);
    const deepSeekKeyStore = createDeepSeekKeyStore({ rootDir: runtime.rootDir, safeStorage });
    const deepSeekClient = createDeepSeekClient({ keyStore: deepSeekKeyStore });
    coordinator.initialize();
    registerActiveTouchIpc({ dataDir: runtime.activeTouchDir, coordinator });
    const developmentRealSend = developmentEdition ? require("./active-touch-dev-ipc.cjs") : null;
    if (developmentRealSend) developmentRealSend.registerActiveTouchDevIpc({ dataDir: runtime.activeTouchDir, getMainWindow: () => mainWindow });
    if (developmentRealSend) disarmDevelopmentRealSend = () => developmentRealSend.disarmRealSend(runtime.activeTouchDir);
    registerContactSyncIpc({ dataDir: runtime.contactSyncDir, activeTouchDir: runtime.activeTouchDir, coordinator });
    registerDeepSeekApiIpc({ keyStore: deepSeekKeyStore, client: deepSeekClient });
    registerTouchTaskIpc({ getMainWindow: () => mainWindow, dataDir: runtime.activeTouchDir, coordinator, deepSeekClient, onPause: developmentRealSend ? () => developmentRealSend.disarmRealSend(runtime.activeTouchDir) : undefined });
    createWindow();

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      if (mainWindow) mainWindow.show();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
