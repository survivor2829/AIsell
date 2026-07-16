const { randomUUID } = require("node:crypto");

function createTrustedClickGate(selector) {
  let trustedClick = "";
  if (typeof window !== "undefined") {
    window.addEventListener("click", (event) => {
      if (!event.isTrusted || !event.target?.closest?.(selector)) return;
      const token = randomUUID();
      trustedClick = token;
      setTimeout(() => {
        if (trustedClick === token) trustedClick = "";
      }, 1000);
    }, true);
  }
  return () => {
    const token = trustedClick;
    trustedClick = "";
    return token;
  };
}

function createPreloadApis(ipcRenderer) {
  const consumeBatchClick = createTrustedClickGate("[data-xiaoxi-batch-authorize]");
  const consumeAutoReplyClick = createTrustedClickGate("[data-xiaoxi-auto-reply-start], [data-xiaoxi-auto-reply-acknowledge]");
  return {
    autoReply: {
      status: () => ipcRenderer.invoke("auto-reply:status"),
      start: () => ipcRenderer.invoke("auto-reply:start", { clickToken: consumeAutoReplyClick() }),
      pause: () => ipcRenderer.invoke("auto-reply:pause"),
      acknowledgeManualFollowup: () => ipcRenderer.invoke("auto-reply:acknowledge-manual-followup", { clickToken: consumeAutoReplyClick() })
    },
    aiExpert: {
      status: () => ipcRenderer.invoke("ai-expert:status"),
      chooseAndImport: () => ipcRenderer.invoke("ai-expert:choose-and-import"),
      remove: () => ipcRenderer.invoke("ai-expert:remove")
    },
    contactSync: {
      status: () => ipcRenderer.invoke("contact-sync:status"),
      sync: () => ipcRenderer.invoke("contact-sync:sync"),
      capture: () => ipcRenderer.invoke("contact-sync:capture"),
      chooseWechatExe: () => ipcRenderer.invoke("contact-sync:choose-wechat-exe"),
      chooseWechatRoot: () => ipcRenderer.invoke("contact-sync:choose-wechat-root"),
      autoDetectPaths: () => ipcRenderer.invoke("contact-sync:auto-detect-paths")
    },
    deepSeekApi: {
      status: () => ipcRenderer.invoke("deepseek-api:status"),
      save: (payload) => ipcRenderer.invoke("deepseek-api:save", payload),
      test: (payload) => ipcRenderer.invoke("deepseek-api:test", payload),
      remove: () => ipcRenderer.invoke("deepseek-api:delete")
    },
    touchTask: {
      start: (payload) => ipcRenderer.invoke("touch-task:start", { ...payload, clickToken: consumeBatchClick() }),
      status: () => ipcRenderer.invoke("touch-task:status"),
      pause: () => ipcRenderer.invoke("touch-task:pause"),
      resume: () => ipcRenderer.invoke("touch-task:resume", { clickToken: consumeBatchClick() }),
      stop: () => ipcRenderer.invoke("touch-task:stop"),
      resolveUnknown: (payload) => ipcRenderer.invoke("touch-task:resolve-unknown", payload),
      showMain: () => ipcRenderer.invoke("touch-task:show-main"),
      closeFloating: () => ipcRenderer.invoke("touch-task:close-floating"),
      onUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("touch-task:update", handler);
        return () => ipcRenderer.removeListener("touch-task:update", handler);
      }
    }
  };
}

module.exports = { createPreloadApis, createTrustedClickGate };
