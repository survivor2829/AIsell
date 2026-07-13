const { contextBridge, ipcRenderer } = require("electron");
const { createPreloadApis } = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
