const { randomUUID } = require("node:crypto");
const { PRODUCT_DETAIL_CHANNELS } = require("./product-detail-ipc.cjs");

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

function createMomentsPublishApi(ipcRenderer) {
  const consumeChooseClick = createTrustedClickGate("[data-xiaoxi-moments-publish-choose]");
  const consumePrepareClick = createTrustedClickGate("[data-xiaoxi-moments-publish-prepare]");
  const consumeConfirmClick = createTrustedClickGate("[data-xiaoxi-moments-publish-confirm]");
  const consumeResolveClick = createTrustedClickGate(
    "[data-xiaoxi-moments-publish-resolve-published], [data-xiaoxi-moments-publish-resolve-not-published]"
  );
  return {
    status: () => ipcRenderer.invoke("moments-publish:status"),
    chooseMedia: () => ipcRenderer.invoke("moments-publish:choose-media", {
      clickToken: consumeChooseClick()
    }),
    prepare: (payload) => ipcRenderer.invoke("moments-publish:prepare", {
      content: String(payload?.content || ""),
      selectionId: String(payload?.selectionId || ""),
      clickToken: consumePrepareClick()
    }),
    confirm: (payload) => ipcRenderer.invoke("moments-publish:confirm", {
      draftId: String(payload?.draftId || ""),
      clickToken: consumeConfirmClick()
    }),
    reset: () => ipcRenderer.invoke("moments-publish:reset"),
    resolveUnknown: (payload) => ipcRenderer.invoke("moments-publish:resolve-unknown", {
      resolution: String(payload?.resolution || ""),
      clickToken: consumeResolveClick()
    }),
    onUpdate: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("moments-publish:update", handler);
      return () => ipcRenderer.removeListener("moments-publish:update", handler);
    }
  };
}
function createContentEngineApi(ipcRenderer) {
  const mixSlots = (value) => Array.isArray(value)
    ? value.map((slot) => ({
      name: String(slot?.name || ""),
      required: slot?.required !== false,
      assetIds: Array.isArray(slot?.assetIds)
        ? slot.assetIds.map((assetId) => String(assetId || ""))
        : [],
      ...(slot?.fixedAssetId == null
        ? {}
        : { fixedAssetId: String(slot.fixedAssetId || "") }),
      ...(slot?.minDurationMs == null
        ? {}
        : { minDurationMs: Number(slot.minDurationMs) }),
      ...(slot?.maxDurationMs == null
        ? {}
        : { maxDurationMs: Number(slot.maxDurationMs) }),
      ...(slot?.targetDurationMs == null
        ? {}
        : { targetDurationMs: Number(slot.targetDurationMs) })
    }))
    : [];
  const mixConstraints = (value) => ({
    ...(Object.hasOwn(value || {}, "allowRepeatedAssets")
      ? { allowRepeatedAssets: value.allowRepeatedAssets === true }
      : {}),
    ...(value?.minDurationMs == null
      ? {}
      : { minDurationMs: Number(value.minDurationMs) }),
    ...(value?.maxDurationMs == null
      ? {}
      : { maxDurationMs: Number(value.maxDurationMs) }),
    ...(value?.scoreWeights && typeof value.scoreWeights === "object"
      ? {
        scoreWeights: {
          durationFit: Number(value.scoreWeights.durationFit),
          diversity: Number(value.scoreWeights.diversity),
          freshness: Number(value.scoreWeights.freshness)
        }
      }
      : {})
  });
  return {
    status: () => ipcRenderer.invoke("content-engine:status"),
    restart: () => ipcRenderer.invoke("content-engine:restart"),
    library: {
      list: (payload) => ipcRenderer.invoke("content-engine:list-assets", {
        includeArchived: payload?.includeArchived === true,
        limit: Number(payload?.limit || 200)
      }),
      chooseFiles: () => ipcRenderer.invoke("content-engine:choose-files"),
      chooseFolder: (payload) => ipcRenderer.invoke("content-engine:choose-folder", {
        recursive: payload?.recursive !== false
      }),
      probe: (payload) => ipcRenderer.invoke("content-engine:probe-asset", {
        assetId: String(payload?.assetId || "")
      }),
      probePending: (payload) => ipcRenderer.invoke("content-engine:probe-pending", {
        limit: Number(payload?.limit || 10)
      }),
      updateRights: (payload) => ipcRenderer.invoke(
        "content-engine:update-asset-rights",
        {
          assetId: String(payload?.assetId || ""),
          rightsStatus: String(payload?.rightsStatus || "")
        }
      ),
      archive: (payload) => ipcRenderer.invoke("content-engine:archive-asset", {
        assetId: String(payload?.assetId || "")
      }),
      reveal: (payload) => ipcRenderer.invoke("content-engine:reveal-asset", {
        assetId: String(payload?.assetId || "")
      })
    },
    tasks: {
      list: (payload) => ipcRenderer.invoke("content-engine:list-tasks", {
        status: payload?.status == null ? undefined : String(payload.status),
        limit: Number(payload?.limit || 200)
      }),
      pause: (payload) => ipcRenderer.invoke("content-engine:pause-task", {
        taskId: String(payload?.taskId || "")
      }),
      resume: (payload) => ipcRenderer.invoke("content-engine:resume-task", {
        taskId: String(payload?.taskId || "")
      }),
      cancel: (payload) => ipcRenderer.invoke("content-engine:cancel-task", {
        taskId: String(payload?.taskId || "")
      })
    },
    finished: {
      list: (payload) => ipcRenderer.invoke("content-engine:list-finished", {
        limit: Number(payload?.limit || 200)
      }),
      chooseAndRegister: (payload) => ipcRenderer.invoke(
        "content-engine:choose-and-register-finished",
        {
          title: String(payload?.title || ""),
          taskId: String(payload?.taskId || "")
        }
      ),
      open: (payload) => ipcRenderer.invoke("content-engine:open-finished", {
        finishedVideoId: String(payload?.finishedVideoId || "")
      }),
      reveal: (payload) => ipcRenderer.invoke("content-engine:reveal-finished", {
        finishedVideoId: String(payload?.finishedVideoId || "")
      })
    },
    settings: {
      status: () => ipcRenderer.invoke("content-engine:settings-status"),
      chooseCacheDirectory: () => ipcRenderer.invoke(
        "content-engine:choose-cache-directory"
      ),
      updateCacheLimit: (payload) => ipcRenderer.invoke(
        "content-engine:update-cache-limit",
        { limitGb: Number(payload?.limitGb || 0) }
      )
    },
    mix: {
      createProject: (payload) => ipcRenderer.invoke(
        "content-engine:create-mix-project",
        {
          name: String(payload?.name || ""),
          slots: mixSlots(payload?.slots),
          constraints: mixConstraints(payload?.constraints)
        }
      ),
      updateProject: (payload) => ipcRenderer.invoke(
        "content-engine:update-mix-project",
        {
          projectId: String(payload?.projectId || ""),
          ...(Object.hasOwn(payload || {}, "name")
            ? { name: String(payload.name || "") }
            : {}),
          ...(Object.hasOwn(payload || {}, "slots")
            ? { slots: mixSlots(payload.slots) }
            : {}),
          ...(Object.hasOwn(payload || {}, "constraints")
            ? { constraints: mixConstraints(payload.constraints) }
            : {})
        }
      ),
      getProject: (payload) => ipcRenderer.invoke(
        "content-engine:get-mix-project",
        { projectId: String(payload?.projectId || "") }
      ),
      listProjects: (payload) => ipcRenderer.invoke(
        "content-engine:list-mix-projects",
        { limit: Number(payload?.limit || 500) }
      ),
      calculateCombinations: (payload) => ipcRenderer.invoke(
        "content-engine:calculate-mix-combinations",
        { projectId: String(payload?.projectId || "") }
      ),
      generateCandidates: (payload) => ipcRenderer.invoke(
        "content-engine:generate-mix-candidates",
        {
          projectId: String(payload?.projectId || ""),
          limit: Number(payload?.limit || 20),
          ...(payload?.seed == null ? {} : { seed: payload.seed })
        }
      ),
      listCandidates: (payload) => ipcRenderer.invoke(
        "content-engine:list-mix-candidates",
        {
          ...(payload?.projectId == null
            ? {}
            : { projectId: String(payload.projectId || "") }),
          ...(payload?.reviewStatus == null
            ? {}
            : { reviewStatus: String(payload.reviewStatus || "") }),
          limit: Number(payload?.limit || 500)
        }
      ),
      reviewCandidate: (payload) => ipcRenderer.invoke(
        "content-engine:review-mix-candidate",
        {
          candidateId: String(payload?.candidateId || ""),
          reviewStatus: String(payload?.reviewStatus || ""),
          ...(payload?.reviewNote == null
            ? {}
            : { reviewNote: String(payload.reviewNote || "") })
        }
      )
    },
    publishQueue: {
      list: (payload) => ipcRenderer.invoke("content-engine:list-publish-queue", {
        ...(payload?.status == null ? {} : { status: String(payload.status || "") }),
        limit: Number(payload?.limit || 500)
      }),
      update: (payload) => ipcRenderer.invoke(
        "content-engine:update-publish-queue-item",
        {
          queueItemId: String(payload?.queueItemId || ""),
          status: String(payload?.status || ""),
          ...(payload?.errorMessage == null
            ? {}
            : { errorMessage: String(payload.errorMessage || "") })
        }
      )
    },
    exportPackages: {
      render: (payload) => ipcRenderer.invoke(
        "content-engine:render-mix-candidate",
        {
          candidateId: String(payload?.candidateId || ""),
          ...(Array.isArray(payload?.platforms)
            ? { platforms: payload.platforms.map((item) => String(item || "")) }
            : {}),
          ...(payload?.title == null ? {} : { title: String(payload.title || "") }),
          ...(payload?.description == null
            ? {}
            : { description: String(payload.description || "") })
        }
      ),
      list: (payload) => ipcRenderer.invoke(
        "content-engine:list-export-packages",
        {
          ...(payload?.candidateId == null
            ? {}
            : { candidateId: String(payload.candidateId || "") }),
          limit: Number(payload?.limit || 500)
        }
      ),
      open: (payload) => ipcRenderer.invoke(
        "content-engine:open-export-package",
        { packageId: String(payload?.packageId || "") }
      ),
      reveal: (payload) => ipcRenderer.invoke(
        "content-engine:reveal-export-package",
        { packageId: String(payload?.packageId || "") }
      )
    },
    onUpdate: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("content-engine:update", handler);
      return () => ipcRenderer.removeListener("content-engine:update", handler);
    }
  };
}
function createPreloadApis(ipcRenderer) {
  const consumeBatchClick = createTrustedClickGate("[data-xiaoxi-batch-authorize]");
  const consumeAutoReplyClick = createTrustedClickGate("[data-xiaoxi-auto-reply-start], [data-xiaoxi-auto-reply-acknowledge]");
  return {
    content: createContentEngineApi(ipcRenderer),
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
      status: () => ipcRenderer.invoke(PRODUCT_DETAIL_CHANNELS.status),
      start: () => ipcRenderer.invoke(PRODUCT_DETAIL_CHANNELS.start),
      restart: () => ipcRenderer.invoke(PRODUCT_DETAIL_CHANNELS.restart),
      stop: () => ipcRenderer.invoke(PRODUCT_DETAIL_CHANNELS.stop),
      onUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on(PRODUCT_DETAIL_CHANNELS.update, handler);
        return () => ipcRenderer.removeListener(PRODUCT_DETAIL_CHANNELS.update, handler);
      },
      onDownloadUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on(PRODUCT_DETAIL_CHANNELS.downloadUpdate, handler);
        return () => ipcRenderer.removeListener(PRODUCT_DETAIL_CHANNELS.downloadUpdate, handler);
      }
    },
    productDetailAiSettings: {
      status: () => ipcRenderer.invoke("product-detail-ai-settings:status"),
      save: (payload) => ipcRenderer.invoke("product-detail-ai-settings:save", {
        ...(Object.hasOwn(payload || {}, "apiKey")
          ? { apiKey: String(payload.apiKey || "") }
          : {}),
        ...(Object.hasOwn(payload || {}, "baseUrl")
          ? { baseUrl: String(payload.baseUrl || "") }
          : {}),
        ...(Object.hasOwn(payload || {}, "enabled")
          ? { enabled: payload.enabled === true }
          : {})
      }),
      delete: () => ipcRenderer.invoke("product-detail-ai-settings:delete"),
      validate: (payload) => ipcRenderer.invoke("product-detail-ai-settings:validate", {
        ...(Object.hasOwn(payload || {}, "apiKey")
          ? { apiKey: String(payload.apiKey || "") }
          : {}),
        ...(Object.hasOwn(payload || {}, "baseUrl")
          ? { baseUrl: String(payload.baseUrl || "") }
          : {}),
        ...(Object.hasOwn(payload || {}, "enabled")
          ? { enabled: payload.enabled === true }
          : {})
      })
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

module.exports = {
  createContentEngineApi,
  createMomentsCampaignApi,
  createMomentsPublishApi,
  createPreloadApis,
  createTrustedClickGate
};
