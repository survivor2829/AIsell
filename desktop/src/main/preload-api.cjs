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
  return {
    activeTouch: {
      status: () => ipcRenderer.invoke("active-touch:status"),
      calibrate: () => ipcRenderer.invoke("active-touch:calibrate"),
      clearCustomer: () => ipcRenderer.invoke("active-touch:clear-customer"),
      sendDryRun: (payload) => ipcRenderer.invoke("active-touch:send-dry-run", payload),
      selectCustomer: (payload) => ipcRenderer.invoke("active-touch:select-customer", payload),
      verifyConversation: (payload) => ipcRenderer.invoke("active-touch:verify-conversation", payload),
      locateConversation: () => ipcRenderer.invoke("active-touch:locate-conversation"),
      openConversationDryRun: () => ipcRenderer.invoke("active-touch:open-conversation-dry-run"),
      searchConversationDryRun: () => ipcRenderer.invoke("active-touch:search-conversation-dry-run"),
      clickSearchResultDryRun: () => ipcRenderer.invoke("active-touch:click-search-result-dry-run"),
      inputMessageDryRun: (payload) => ipcRenderer.invoke("active-touch:input-message-dry-run", payload),
      queueDryRun: (payload) => ipcRenderer.invoke("active-touch:queue-dry-run", payload),
      verifySendResultDryRun: () => ipcRenderer.invoke("active-touch:verify-send-result-dry-run"),
      verifyMessageBubble: () => ipcRenderer.invoke("active-touch:verify-message-bubble"),
      verifyWindowTitle: () => ipcRenderer.invoke("active-touch:verify-window-title")
    },
    contactSync: {
      status: () => ipcRenderer.invoke("contact-sync:status"),
      sync: () => ipcRenderer.invoke("contact-sync:sync"),
      capture: () => ipcRenderer.invoke("contact-sync:capture")
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
