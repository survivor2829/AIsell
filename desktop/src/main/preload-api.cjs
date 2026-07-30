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

function createMomentsCampaignApi(ipcRenderer) {
  const consumeStartClick = createTrustedClickGate(
    "[data-xiaoxi-moments-campaign-start], [data-xiaoxi-moments-daily-run]"
  );
  return {
    status: () => ipcRenderer.invoke("moments-campaign:status"),
    configureDaily: (payload) => ipcRenderer.invoke("moments-campaign:configure-daily", {
      enabled: payload?.enabled === true,
      target: Number(payload?.target || 20),
      startTime: String(payload?.startTime || "09:00"),
      likeEnabled: payload?.likeEnabled !== false,
      commentEnabled: payload?.commentEnabled === true,
      commentGuidance: String(payload?.commentGuidance || "")
    }),
    start: (payload) => ipcRenderer.invoke("moments-campaign:start", {
      maxPosts: Number(payload?.maxPosts || 10),
      likeEnabled: payload?.likeEnabled !== false,
      commentEnabled: payload?.commentEnabled === true,
      commentGuidance: String(payload?.commentGuidance || ""),
      clickToken: consumeStartClick()
    }),
    runDailyNow: () => ipcRenderer.invoke("moments-campaign:run-daily-now", {
      clickToken: consumeStartClick()
    }),
    pause: () => ipcRenderer.invoke("moments-campaign:pause"),
    stop: () => ipcRenderer.invoke("moments-campaign:stop"),
    onUpdate: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("moments-campaign:update", handler);
      return () => ipcRenderer.removeListener("moments-campaign:update", handler);
    }
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
      acknowledgeManualFollowup: () => ipcRenderer.invoke("auto-reply:acknowledge-manual-followup", { clickToken: consumeAutoReplyClick() }),
      onUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("auto-reply:update", handler);
        return () => ipcRenderer.removeListener("auto-reply:update", handler);
      }
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
    diagnostics: {
      status: () => ipcRenderer.invoke("diagnostics:status"),
      openFolder: () => ipcRenderer.invoke("diagnostics:open-folder"),
      export: () => ipcRenderer.invoke("diagnostics:export")
    },
    productDetail: {
      status: () => ipcRenderer.invoke("product-detail:status"),
      start: () => ipcRenderer.invoke("product-detail:start"),
      restart: () => ipcRenderer.invoke("product-detail:restart"),
      stop: () => ipcRenderer.invoke("product-detail:stop"),
      onUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("product-detail:update", handler);
        return () => ipcRenderer.removeListener("product-detail:update", handler);
      }
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

module.exports = { createMomentsCampaignApi, createPreloadApis, createTrustedClickGate };
