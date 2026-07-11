const { contextBridge, ipcRenderer } = require("electron");
const { randomUUID } = require("node:crypto");
const { createPreloadApis } = require("./preload-api.cjs");

const apis = createPreloadApis(ipcRenderer);
let trustedRealSendClick = "";

window.addEventListener("click", (event) => {
  if (!event.isTrusted || !event.target?.closest?.("[data-xiaoxi-real-send]")) return;
  const token = randomUUID();
  trustedRealSendClick = token;
  setTimeout(() => {
    if (trustedRealSendClick === token) trustedRealSendClick = "";
  }, 1000);
}, true);

Object.assign(apis.activeTouch, {
  calibrate: () => ipcRenderer.invoke("active-touch:dev-calibrate"),
  selectCustomer: (payload) => ipcRenderer.invoke("active-touch:dev-select-customer", payload),
  clickSearchResultDryRun: () => ipcRenderer.invoke("active-touch:dev-click-search-result"),
  inputMessageDryRun: (payload) => ipcRenderer.invoke("active-touch:dev-input-message", payload),
  sendDryRun: (payload) => ipcRenderer.invoke("active-touch:dev-send-dry-run", payload),
  sendSelectedContact: (payload) => {
    const clickToken = trustedRealSendClick;
    trustedRealSendClick = "";
    return ipcRenderer.invoke("active-touch:send-selected-contact", {
      contactId: String(payload?.contactId ?? ""),
      message: String(payload?.message ?? ""),
      clickToken
    });
  },
  setRealSendArm: (payload) => ipcRenderer.invoke("active-touch:set-real-send-arm", payload),
  verifyRealSendSession: () => ipcRenderer.invoke("active-touch:verify-real-send-session"),
  failConversation: () => ipcRenderer.invoke("active-touch:fail-conversation")
});

contextBridge.exposeInMainWorld("xiaoxiActiveTouch", apis.activeTouch);
contextBridge.exposeInMainWorld("xiaoxiContactSync", apis.contactSync);
contextBridge.exposeInMainWorld("xiaoxiDeepSeekApi", apis.deepSeekApi);
contextBridge.exposeInMainWorld("xiaoxiTouchTask", apis.touchTask);
