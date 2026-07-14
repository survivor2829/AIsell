const { contextBridge, ipcRenderer } = require("electron");
const { createPreloadApis, createTrustedClickGate } = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
const consumeRealSendClick = createTrustedClickGate("[data-xiaoxi-real-send]");

const activeTouch = {
  calibrate: () => ipcRenderer.invoke("active-touch:dev-calibrate"),
  selectCustomer: (payload) => ipcRenderer.invoke("active-touch:dev-select-customer", payload),
  clickSearchResultDryRun: () => ipcRenderer.invoke("active-touch:dev-click-search-result"),
  inputMessageDryRun: (payload) => ipcRenderer.invoke("active-touch:dev-input-message", payload),
  sendDryRun: (payload) => ipcRenderer.invoke("active-touch:dev-send-dry-run", payload),
  sendSelectedContact: (payload) => {
    return ipcRenderer.invoke("active-touch:send-selected-contact", {
      contactId: String(payload?.contactId ?? ""),
      message: String(payload?.message ?? ""),
      clickToken: consumeRealSendClick()
    });
  },
  setRealSendArm: (payload) => ipcRenderer.invoke("active-touch:set-real-send-arm", payload),
  verifyRealSendSession: () => ipcRenderer.invoke("active-touch:verify-real-send-session"),
  failConversation: () => ipcRenderer.invoke("active-touch:fail-conversation")
};

contextBridge.exposeInMainWorld("xiaoxiActiveTouch", activeTouch);
contextBridge.exposeInMainWorld("xiaoxiAutoReply", apis.autoReply);
contextBridge.exposeInMainWorld("xiaoxiAiExpert", apis.aiExpert);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
