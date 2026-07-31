const { contextBridge, ipcRenderer } = require("electron");
const { createMomentsCampaignApi, createPreloadApis } = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
const momentsCampaign = createMomentsCampaignApi(ipcRenderer);
contextBridge.exposeInMainWorld("xiaoxiAutoReply", apis.autoReply);
contextBridge.exposeInMainWorld("xiaoxiAiExpert", apis.aiExpert);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiDiagnostics", apis.diagnostics);
contextBridge.exposeInMainWorld("xiaoxiContent", apis.content);
contextBridge.exposeInMainWorld("xiaoxiProductDetail", apis.productDetail);
contextBridge.exposeInMainWorld("xiaoxiProductDetailAiSettings", apis.productDetailAiSettings);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
contextBridge.exposeInMainWorld("xiaoxiMomentsCampaign", momentsCampaign);
