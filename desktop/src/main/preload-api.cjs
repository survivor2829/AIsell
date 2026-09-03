const {
  constants: cryptoConstants,
  publicEncrypt,
  randomUUID
} = require("node:crypto");
const { PRODUCT_DETAIL_CHANNELS } = require("./product-detail-ipc.cjs");
const { CONTENT_ENGINE_CHANNELS } = require("./content-engine-ipc.cjs");

const AUTO_MIX_TRUSTED_CLICK_CHANNELS = Object.freeze({
  create: CONTENT_ENGINE_CHANNELS.createAutoMixV2,
  prepare: CONTENT_ENGINE_CHANNELS.prepareGuidedAutoMixV2,
  generateGuidedScript: CONTENT_ENGINE_CHANNELS.generateGuidedAutoMixScriptV2,
  generateSupplementalImage: CONTENT_ENGINE_CHANNELS.createGuidedAutoMixSupplementalImageV2,
  regenerate: CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer,
  importMusic: CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
  designVoice: CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona,
  previewVoice: CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona,
  approveVoice: CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
});

function createTrustedClickGate(selector, operation = "") {
  let trustedClick = "";
  if (typeof window !== "undefined") {
    window.addEventListener("click", (event) => {
      if (!event.isTrusted || !event.target?.closest?.(selector)) return;
      const uuid = randomUUID();
      const token = operation ? `${operation}:${uuid}` : uuid;
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
    showMain: () => ipcRenderer.invoke("moments-campaign:show-main"),
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
    resolveUnknown: async (payload) => {
      const result = await ipcRenderer.invoke("moments-publish:resolve-unknown", {
        resolution: String(payload?.resolution || ""),
        clickToken: consumeResolveClick()
      });
      if (result?.ok) await ipcRenderer.invoke("wechat-workflow:status").catch(() => undefined);
      return result;
    },
    onUpdate: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("moments-publish:update", handler);
      return () => ipcRenderer.removeListener("moments-publish:update", handler);
    }
  };
}

function visualRendererPayload(value) {
  if (value == null) return {};
  return {
    visualRenderer: {
      requestedEngine: String(value.requestedEngine || ""),
      ...(value.visualStyleId == null
        ? {}
        : { visualStyleId: String(value.visualStyleId || "") }),
      requestedStyleVersion: Number(value.requestedStyleVersion),
      allowFallback: value.allowFallback !== false
    }
  };
}

function createContentEngineApi(ipcRenderer) {
  const batchChannels = require("./narrated-batch-ipc.cjs").CHANNELS;
  const batchClicks = Object.fromEntries(["recommend", "samples", "continue"].map((action) => [
    action, createTrustedClickGate(`[data-batch-action="${action}"]`, batchChannels[action])
  ]));
  const consumeAutoMixCreateClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-create]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.create
  );
  const consumeAutoMixPrepareClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-prepare]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.prepare
  );
  const consumeAutoMixGenerateScriptClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-script]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.generateGuidedScript
  );
  const consumeAutoMixSupplementalImageClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-supplemental-image]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.generateSupplementalImage
  );
  const consumeAutoMixRegenerateClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-regenerate]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.regenerate
  );
  const consumeAutoMixMusicImportClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-music-import]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.importMusic
  );
  const consumeAutoMixVoicePreviewClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-voice-preview]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.previewVoice
  );
  const consumeAutoMixVoiceDesignClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-voice-design]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.designVoice
  );
  const consumeAutoMixVoiceApproveClick = createTrustedClickGate(
    "[data-xiaoxi-auto-mix-voice-approve]",
    AUTO_MIX_TRUSTED_CLICK_CHANNELS.approveVoice
  );
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
    batch: Object.fromEntries(Object.entries(batchChannels).map(([action, channel]) => [
      action, (payload = {}) => ipcRenderer.invoke(channel, batchClicks[action]
        ? { ...payload, clickToken: batchClicks[action]() } : payload)
    ])),
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
      }),
      download: (payload) => ipcRenderer.invoke("content-engine:download-finished", {
        finishedVideoId: String(payload?.finishedVideoId || "")
      })
    },
    settings: {
      status: () => ipcRenderer.invoke("content-engine:settings-status"),
      bailianKeyStatus: () => ipcRenderer.invoke(
        "content-engine:bailian-key-status"
      ),
      saveBailianKey: async (payload) => {
        const handshake = await ipcRenderer.invoke(
          "content-engine:bailian-key-encryption"
        );
        if (!handshake?.ok || !handshake.data?.keyId || !handshake.data?.publicKey) {
          return handshake;
        }
        try {
          const ciphertext = publicEncrypt(
            {
              key: handshake.data.publicKey,
              padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256"
            },
            Buffer.from(String(payload?.apiKey || ""), "utf8")
          ).toString("base64");
          const apiHost = String(payload?.apiHost || "").trim();
          return ipcRenderer.invoke("content-engine:save-bailian-key", {
            keyId: String(handshake.data.keyId),
            ciphertext,
            ...(apiHost ? { apiHost } : {})
          });
        } catch {
          return {
            ok: false,
            code: "BAILIAN_KEY_ENCRYPTION_INVALID",
            error: "百炼 Key 安全传输失败，请重试。"
          };
        }
      },
      deleteBailianKey: () => ipcRenderer.invoke(
        "content-engine:delete-bailian-key"
      ),
      chooseCacheDirectory: () => ipcRenderer.invoke(
        "content-engine:choose-cache-directory"
      ),
      updateCacheLimit: (payload) => ipcRenderer.invoke(
        "content-engine:update-cache-limit",
        { limitGb: Number(payload?.limitGb || 0) }
      )
    },
    creative: {
      analyzeAssets: (payload) => ipcRenderer.invoke(
        "content-engine:analyze-assets",
        {
          assetIds: Array.isArray(payload?.assetIds)
            ? payload.assetIds.map((item) => String(item || ""))
            : []
        }
      ),
      listSegments: (payload) => ipcRenderer.invoke(
        "content-engine:list-media-segments",
        {
          ...(payload?.assetId == null
            ? {}
            : { assetId: String(payload.assetId || "") }),
          ...(payload?.role == null ? {} : { role: String(payload.role || "") }),
          limit: Number(payload?.limit || 2_000)
        }
      ),
      generateCourseCuts: (payload) => ipcRenderer.invoke(
        "content-engine:generate-course-cuts",
        {
          assetId: String(payload?.assetId || ""),
          minDurationMs: Number(payload?.minDurationMs || 30_000),
          maxDurationMs: Number(payload?.maxDurationMs || 90_000),
          count: Number(payload?.count || 5),
          theme: String(payload?.theme || "培训现场价值"),
          subtitleFontSize: Number(payload?.subtitleFontSize || 48),
          subtitleMarginBottom: Number(payload?.subtitleMarginBottom || 170),
          experimentMode: "standard",
          subtitlePreset: "dynamic_clean",
          packagingMode: String(payload?.packagingMode || "auto"),
          ...(payload?.packagingPresetId == null
            ? {}
            : { packagingPresetId: String(payload.packagingPresetId || "") }),
          ...(payload?.brandProfileId == null
            ? {}
            : { brandProfileId: String(payload.brandProfileId || "") }),
          coverMode: String(payload?.coverMode || "ai_generate"),
          ...(payload?.confirmPaidCalls === true ? { confirmPaidCalls: true } : {}),
          ...visualRendererPayload(payload?.visualRenderer)
        }
      ),
      generateMixBatch: (payload) => ipcRenderer.invoke(
        "content-engine:generate-mix-batch",
        {
          assetIds: Array.isArray(payload?.assetIds)
            ? payload.assetIds.map((item) => String(item || ""))
            : [],
          theme: String(payload?.theme || "培训现场价值"),
          targetCount: Number(payload?.targetCount || 30),
          ...(payload?.voiceAssetId == null
            ? {}
            : { voiceAssetId: String(payload.voiceAssetId || "") }),
          ...(payload?.pilotMode === true ? { pilotMode: true } : {}),
          packagingMode: String(payload?.packagingMode || "auto"),
          ...(payload?.packagingPresetId == null
            ? {}
            : { packagingPresetId: String(payload.packagingPresetId || "") }),
          ...(payload?.brandProfileId == null
            ? {}
            : { brandProfileId: String(payload.brandProfileId || "") }),
          coverMode: String(payload?.coverMode || "ai_generate"),
          ...(payload?.confirmPaidCalls === true ? { confirmPaidCalls: true } : {}),
          ...visualRendererPayload(payload?.visualRenderer)
        }
      ),
      createOneClickProject: (payload) => ipcRenderer.invoke(
        "content-engine:create-one-click-project",
        {
          name: String(payload?.name || "商品展示一键成片"),
          assetIds: Array.isArray(payload?.assetIds)
            ? payload.assetIds.map((item) => String(item || ""))
            : [],
          options: {
            brief: payload?.brief && typeof payload.brief === "object" ? payload.brief : {},
            ratio: String(payload?.ratio || "9:16"),
            durationMs: Number(payload?.durationMs || 75_000),
            targetCount: Number(payload?.targetCount || 3),
            coverMode: String(payload?.coverMode || "ai_generate"),
            ...(payload?.bgmAssetId == null ? {} : { bgmAssetId: String(payload.bgmAssetId || "") })
          }
        }
      ),
      createAutoMixV2: (payload) => {
        const base = {
          specVersion: String(payload?.specVersion || ""),
          clickToken: consumeAutoMixCreateClick()
        };
        const request = payload?.guidedSessionId == null
          ? {
            ...base,
            assetIds: Array.isArray(payload?.assetIds)
              ? payload.assetIds.map((item) => String(item || ""))
              : [],
            title: String(payload?.title || ""),
            copyFramework: String(payload?.copyFramework || "")
          }
          : {
            ...base,
            guidedSessionId: String(payload.guidedSessionId || ""),
            scriptRevision: Number(payload?.scriptRevision || 0)
          };
        return ipcRenderer.invoke(AUTO_MIX_TRUSTED_CLICK_CHANNELS.create, request);
      },
      prepareGuidedAutoMixV2: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.prepare,
        {
          assetIds: Array.isArray(payload?.assetIds)
            ? payload.assetIds.map((item) => String(item || ""))
            : [],
          clickToken: consumeAutoMixPrepareClick()
        }
      ),
      getGuidedAutoMixSessionV2: (payload) => ipcRenderer.invoke(
        CONTENT_ENGINE_CHANNELS.getGuidedAutoMixSessionV2,
        payload?.sessionId == null
          ? { taskId: String(payload?.taskId || "") }
          : { sessionId: String(payload.sessionId || "") }
      ),
      generateGuidedAutoMixScriptV2: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.generateGuidedScript,
        {
          sessionId: String(payload?.sessionId || ""),
          ...(payload?.analysisTaskId
            ? { analysisTaskId: String(payload.analysisTaskId) }
            : {}),
          title: String(payload?.title || ""),
          answers: {
            companyName: String(payload?.answers?.companyName || ""),
            productName: String(payload?.answers?.productName || ""),
            targetScene: String(payload?.answers?.targetScene || ""),
            keyMessage: String(payload?.answers?.keyMessage || ""),
            extraNotes: String(payload?.answers?.extraNotes || "")
          },
          clickToken: consumeAutoMixGenerateScriptClick()
        }
      ),
      getGuidedAutoMixSupplementalImageV2: (payload) => ipcRenderer.invoke(
        CONTENT_ENGINE_CHANNELS.getGuidedAutoMixSupplementalImageV2,
        {
          sessionId: String(payload?.sessionId || ""),
          scriptRevision: Number(payload?.scriptRevision || 0)
        }
      ),
      createGuidedAutoMixSupplementalImageV2: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.generateSupplementalImage,
        {
          sessionId: String(payload?.sessionId || ""),
          scriptRevision: Number(payload?.scriptRevision || 0),
          draftHash: String(payload?.draftHash || ""),
          confirmPaidCalls: payload?.confirmPaidCalls === true,
          clickToken: consumeAutoMixSupplementalImageClick()
        }
      ),
      getAutoMixPlanV2: (payload) => ipcRenderer.invoke(
        "content-engine:get-auto-mix-plan-v2",
        {
          ...(payload?.projectId == null
            ? {}
            : { projectId: String(payload.projectId || "") }),
          ...(payload?.runId == null ? {} : { runId: String(payload.runId || "") })
        }
      ),
      regenerateAutoMixLayer: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.regenerate,
        {
          projectId: String(payload?.projectId || ""),
          ...(payload?.expectedRunId == null
            ? {}
            : { expectedRunId: String(payload.expectedRunId || "") }),
          layer: String(payload?.layer || ""),
          clickToken: consumeAutoMixRegenerateClick()
        }
      ),
      importMusicCatalogTrack: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.importMusic,
        {
          displayName: String(payload?.displayName || ""),
          source: String(payload?.source || ""),
          commercialScope: String(payload?.commercialScope || ""),
          commercialUseAllowed: payload?.commercialUseAllowed === true,
          licenseStatus: String(payload?.licenseStatus || "unknown"),
          expiresAt: payload?.expiresAt == null ? null : String(payload.expiresAt || ""),
          credentialReference: String(payload?.credentialReference || ""),
          bpm: payload?.bpm == null ? null : Number(payload.bpm),
          moods: Array.isArray(payload?.moods)
            ? payload.moods.map((item) => String(item || ""))
            : [],
          energy: Number(payload?.energy ?? 0.5),
          loopStartMs: payload?.loopStartMs == null ? null : Number(payload.loopStartMs),
          loopEndMs: payload?.loopEndMs == null ? null : Number(payload.loopEndMs),
          clickToken: consumeAutoMixMusicImportClick()
        }
      ),
      listMusicCatalogTracks: () => ipcRenderer.invoke(
        "content-engine:list-music-catalog-tracks",
        {}
      ),
      listAutoMixVoicePersonas: () => ipcRenderer.invoke(
        "content-engine:list-auto-mix-voice-personas",
        {}
      ),
      designAutoMixVoicePersona: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.designVoice,
        {
          voicePersonaId: String(payload?.voicePersonaId || ""),
          clickToken: consumeAutoMixVoiceDesignClick()
        }
      ),
      previewAutoMixVoicePersona: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.previewVoice,
        {
          voicePersonaId: String(payload?.voicePersonaId || ""),
          clickToken: consumeAutoMixVoicePreviewClick()
        }
      ),
      approveAutoMixVoicePersona: (payload) => ipcRenderer.invoke(
        AUTO_MIX_TRUSTED_CLICK_CHANNELS.approveVoice,
        {
          voicePersonaId: String(payload?.voicePersonaId || ""),
          clickToken: consumeAutoMixVoiceApproveClick()
        }
      ),
      analyzeProductAssets: (payload) => ipcRenderer.invoke(
        "content-engine:analyze-product-assets",
        { projectId: String(payload?.projectId || "") }
      ),
      generateProductCopy: (payload) => ipcRenderer.invoke(
        "content-engine:generate-product-copy",
        {
          projectId: String(payload?.projectId || ""),
          brief: payload?.brief && typeof payload.brief === "object" ? payload.brief : {}
        }
      ),
      generateProductVoice: (payload) => ipcRenderer.invoke(
        "content-engine:generate-product-voice",
        {
          projectId: String(payload?.projectId || ""),
          ...(payload?.scriptId == null ? {} : { scriptId: String(payload.scriptId || "") })
        }
      ),
      generateOneClickCandidates: (payload) => ipcRenderer.invoke(
        "content-engine:generate-one-click-candidates",
        {
          projectId: String(payload?.projectId || ""),
          options: {
            targetCount: Number(payload?.targetCount || 3),
            durationMs: Number(payload?.durationMs || 75_000),
            coverMode: String(payload?.coverMode || "ai_generate")
          }
        }
      ),
      listOneClickCandidates: (payload) => ipcRenderer.invoke(
        "content-engine:list-one-click-candidates",
        {
          projectId: String(payload?.projectId || ""),
          limit: Number(payload?.limit || 20)
        }
      ),
      listPackagingPresets: (payload) => ipcRenderer.invoke(
        "content-engine:list-packaging-presets",
        payload?.kind ? { kind: String(payload.kind) } : {}
      ),
      listBrandProfiles: () => ipcRenderer.invoke(
        "content-engine:list-brand-profiles",
        {}
      ),
      saveBrandProfile: (payload) => ipcRenderer.invoke(
        "content-engine:save-brand-profile",
        {
          ...(payload?.brandProfileId == null
            ? {}
            : { brandProfileId: String(payload.brandProfileId || "") }),
          name: String(payload?.name || ""),
          ...(payload?.logoAssetId == null ? {} : { logoAssetId: String(payload.logoAssetId || "") }),
          primaryColor: String(payload?.primaryColor || ""),
          accentColor: String(payload?.accentColor || ""),
          fontPreset: String(payload?.fontPreset || ""),
          ...(payload?.referenceAssetId == null
            ? {}
            : { referenceAssetId: String(payload.referenceAssetId || "") }),
          outroText: String(payload?.outroText || "")
        }
      ),
      getPackagingCostEstimate: (payload) => ipcRenderer.invoke(
        "content-engine:get-packaging-cost-estimate",
        {
          candidateIds: Array.isArray(payload?.candidateIds)
            ? payload.candidateIds.map((item) => String(item || ""))
            : [],
          coverMode: String(payload?.coverMode || "ai_generate"),
          ...(payload?.packagingMode == null
            ? {}
            : { packagingMode: String(payload.packagingMode || "") }),
          ...(payload?.plannedCount == null ? {} : { plannedCount: Number(payload.plannedCount) }),
          ...(payload?.assetIds == null ? {} : { assetIds: payload.assetIds.map((item) => String(item || "")) }),
          ...(payload?.generationKind == null ? {} : { generationKind: String(payload.generationKind || "") })
        }
      ),
      recordMediaReview: (payload) => ipcRenderer.invoke(
        "content-engine:record-media-review",
        {
          candidateId: String(payload?.candidateId || ""),
          device: String(payload?.device || "phone"),
          verdict: String(payload?.verdict || "pass"),
          reason: String(payload?.reason || ""),
          reviewer: String(payload?.reviewer || "")
        }
      ),
      listMediaReviews: (payload) => ipcRenderer.invoke(
        "content-engine:list-media-reviews",
        { candidateId: String(payload?.candidateId || "") }
      ),
      packageGeneratedVideos: (payload) => ipcRenderer.invoke(
        "content-engine:package-generated-videos",
        {
          candidateIds: Array.isArray(payload?.candidateIds)
            ? payload.candidateIds.map((item) => String(item || ""))
            : [],
          packagingMode: String(payload?.packagingMode || "auto"),
          ...(payload?.packagingPresetId == null
            ? {}
            : { packagingPresetId: String(payload.packagingPresetId || "") }),
          ...(payload?.brandProfileId == null
            ? {}
            : { brandProfileId: String(payload.brandProfileId || "") }),
          coverMode: String(payload?.coverMode || "ai_generate"),
          reuseCover: payload?.reuseCover !== false
        }
      ),
      repackageVideo: (payload) => ipcRenderer.invoke(
        "content-engine:repackage-video",
        {
          candidateId: String(payload?.candidateId || ""),
          packagingMode: String(payload?.packagingMode || "auto"),
          ...(payload?.packagingPresetId == null
            ? {}
            : { packagingPresetId: String(payload.packagingPresetId || "") }),
          ...(payload?.brandProfileId == null
            ? {}
            : { brandProfileId: String(payload.brandProfileId || "") }),
          coverMode: String(payload?.coverMode || "ai_generate"),
          reuseCover: true
        }
      ),
      preflightVisualComparison: (payload) => ipcRenderer.invoke(
        "content-engine:preflight-visual-comparison",
        { candidateId: String(payload?.candidateId || "") }
      ),
      createVisualComparisonTask: (payload) => ipcRenderer.invoke(
        "content-engine:create-visual-comparison-task",
        { candidateId: String(payload?.candidateId || "") }
      ),
      regenerateCover: (payload) => ipcRenderer.invoke(
        "content-engine:regenerate-cover",
        { candidateId: String(payload?.candidateId || "") }
      ),
      getProject: (payload) => ipcRenderer.invoke(
        "content-engine:get-creative-project",
        { projectId: String(payload?.projectId || "") }
      ),
      listGenerated: (payload) => ipcRenderer.invoke(
        "content-engine:list-generated-videos",
        {
          ...(payload?.projectId == null
            ? {}
            : { projectId: String(payload.projectId || "") }),
          ...(payload?.status == null ? {} : { status: String(payload.status || "") }),
          limit: Number(payload?.limit || 500)
        }
      ),
      regenerate: (payload) => ipcRenderer.invoke(
        "content-engine:regenerate-video",
        { candidateId: String(payload?.candidateId || "") }
      ),
      reject: (payload) => ipcRenderer.invoke(
        "content-engine:reject-generated-video",
        { candidateId: String(payload?.candidateId || "") }
      ),
      queue: (payload) => ipcRenderer.invoke(
        "content-engine:queue-generated-videos",
        {
          candidateIds: Array.isArray(payload?.candidateIds)
            ? payload.candidateIds.map((item) => String(item || ""))
            : [],
          channel: String(payload?.channel || "internal")
        }
      ),
      mediaUrl: (payload) => ipcRenderer.invoke(
        "content-engine:generated-media-url",
        {
          candidateId: String(payload?.candidateId || ""),
          variant: payload?.variant === "thumbnail" ? "thumbnail" : "video"
        }
      ),
      open: (payload) => ipcRenderer.invoke(
        "content-engine:open-generated-video",
        { candidateId: String(payload?.candidateId || "") }
      ),
      exportCandidate: (payload) => ipcRenderer.invoke(
        "content-engine:export-candidate",
        { candidateId: String(payload?.candidateId || "") }
      ),
      downloadCandidate: (payload) => ipcRenderer.invoke(
        "content-engine:download-candidate",
        { candidateId: String(payload?.candidateId || "") }
      ),
      reveal: (payload) => ipcRenderer.invoke(
        "content-engine:reveal-generated-video",
        { candidateId: String(payload?.candidateId || "") }
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
  const consumeWorkflowStart = createTrustedClickGate("[data-xiaoxi-workflow-start]");
  const consumeWorkflowSave = createTrustedClickGate("[data-xiaoxi-workflow-save]");
  const consumeBatchClick = createTrustedClickGate("[data-xiaoxi-batch-authorize]");
  const consumeAutoReplyClick = createTrustedClickGate("[data-xiaoxi-auto-reply-start], [data-xiaoxi-auto-reply-acknowledge], [data-xiaoxi-auto-reply-resume]");
  return {
    content: createContentEngineApi(ipcRenderer),
    workflow: {
      status: () => ipcRenderer.invoke("wechat-workflow:status"),
      start: () => ipcRenderer.invoke("wechat-workflow:start", { clickToken: consumeWorkflowStart() }),
      pause: () => ipcRenderer.invoke("wechat-workflow:pause"),
      addTask: (payload) => ipcRenderer.invoke("wechat-workflow:add-task", { ...payload, clickToken: consumeWorkflowSave() }),
      updateTask: (payload) => ipcRenderer.invoke("wechat-workflow:update-task", { ...payload, clickToken: consumeWorkflowSave() }),
      getTask: (id) => ipcRenderer.invoke("wechat-workflow:get-task", { id: String(id || "") }),
      cancelTask: (id) => ipcRenderer.invoke("wechat-workflow:cancel-task", { id: String(id || "") }),
      retryTask: (id) => ipcRenderer.invoke("wechat-workflow:retry-task", { id: String(id || ""), clickToken: consumeWorkflowSave() }),
      removeRecipient: (id) => ipcRenderer.invoke("wechat-workflow:remove-recipient", { id: String(id || "") }),
      setReplyEnabled: (enabled) => ipcRenderer.invoke("wechat-workflow:set-reply-enabled", { enabled: enabled === true }),
      showFloating: () => ipcRenderer.invoke("wechat-workflow:show-floating"),
      showMain: () => ipcRenderer.invoke("wechat-workflow:show-main"),
      onUpdate: (callback) => {
        const handler = (_event, state) => callback(state);
        ipcRenderer.on("wechat-workflow:update", handler);
        return () => ipcRenderer.removeListener("wechat-workflow:update", handler);
      }
    },
    autoReply: {
      status: () => ipcRenderer.invoke("auto-reply:status"),
      start: (payload = {}) => ipcRenderer.invoke("auto-reply:start", {
        clickToken: consumeAutoReplyClick(),
        contactId: String(payload?.contactId || "")
      }),
      pause: () => ipcRenderer.invoke("auto-reply:pause"),
      showMain: () => ipcRenderer.invoke("auto-reply:show-main"),
      acknowledgeManualFollowup: () => ipcRenderer.invoke("auto-reply:acknowledge-manual-followup", { clickToken: consumeAutoReplyClick() }),
      resumeContact: (contactId) => ipcRenderer.invoke("auto-reply:resume-contact", {
        clickToken: consumeAutoReplyClick(),
        contactId: String(contactId || "")
      }),
      onUpdate: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("auto-reply:update", handler);
        return () => ipcRenderer.removeListener("auto-reply:update", handler);
      }
    },
    aiExpert: {
      status: () => ipcRenderer.invoke("ai-expert:status"),
      read: () => ipcRenderer.invoke("ai-expert:read"),
      conversation: () => ipcRenderer.invoke("ai-expert:conversation"),
      chat: (payload) => ipcRenderer.invoke("ai-expert:chat", {
        message: String(payload?.message || ""),
        ...(typeof payload?.expertRules === "string" ? { expertRules: payload.expertRules } : {}),
        ...(typeof payload?.businessKnowledge === "string" ? { businessKnowledge: payload.businessKnowledge } : {})
      }),
      save: (payload) => ipcRenderer.invoke("ai-expert:save", {
        expertRules: String(payload?.expertRules || ""), businessKnowledge: String(payload?.businessKnowledge || "")
      }),
      chooseAndImport: (kind) => ipcRenderer.invoke("ai-expert:choose-and-import", String(kind || "")),
      remove: (kind) => ipcRenderer.invoke("ai-expert:remove", String(kind || ""))
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
