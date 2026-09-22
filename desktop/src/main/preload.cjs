const { contextBridge, ipcRenderer } = require("electron");
const {
  createMomentsCampaignApi,
  createMomentsPublishApi,
  createPreloadApis
} = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
contextBridge.exposeInMainWorld("xiaoxiDigitalHuman", require("./digital-human-preload.cjs").createDigitalHumanApi(ipcRenderer));
contextBridge.exposeInMainWorld("xiaoxiKeywordAcquisition", require("./keyword-acquisition-preload.cjs").createKeywordAcquisitionApi(ipcRenderer));
contextBridge.exposeInMainWorld("xiaoxiLicenseAuth", apis.licenseAuth);
contextBridge.exposeInMainWorld("xiaoxiWindowChrome", { setMode: (mode) => ipcRenderer.send("window-chrome:set-mode", mode) });
contextBridge.exposeInMainWorld("xiaoxiWorkflow", apis.workflow);
const momentsCampaign = createMomentsCampaignApi(ipcRenderer);
const momentsPublish = createMomentsPublishApi(ipcRenderer);
contextBridge.exposeInMainWorld("xiaoxiAutoReply", apis.autoReply);
contextBridge.exposeInMainWorld("xiaoxiAiExpert", apis.aiExpert);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiDiagnostics", apis.diagnostics);
contextBridge.exposeInMainWorld("xiaoxiCloudMaintenance", apis.cloudMaintenance);
contextBridge.exposeInMainWorld("xiaoxiRolePreferences", apis.rolePreferences);
contextBridge.exposeInMainWorld("xiaoxiFeedback", apis.feedback);
contextBridge.exposeInMainWorld("xiaoxiContent", apis.content);
contextBridge.exposeInMainWorld("xiaoxiProductDetail", apis.productDetail);
contextBridge.exposeInMainWorld("xiaoxiProductDetailAiSettings", apis.productDetailAiSettings);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
contextBridge.exposeInMainWorld("xiaoxiMomentsCampaign", momentsCampaign);
contextBridge.exposeInMainWorld("xiaoxiMomentsPublish", momentsPublish);
