const { contextBridge, ipcRenderer } = require("electron");
const { createPreloadApis } = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
contextBridge.exposeInMainWorld("xiaoxiAutoReply", apis.autoReply);
contextBridge.exposeInMainWorld("xiaoxiAiExpert", apis.aiExpert);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiDiagnostics", apis.diagnostics);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
