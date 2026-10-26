const { createTrustedClickGate } = require("./preload-api.cjs");

function createDigitalHumanApi(ipcRenderer) {
  const clicks = Object.fromEntries(["preview", "confirm", "resume", "voice-preview", "voice-train", "reference-prepare", "reference-confirm", "reference-resume", "reference-train", "reference-write-script", "reference-cover-generate", "reference-viral-pipeline-start", "reference-viral-pipeline-retry", "reference-confirm-consent", "reference-viral-pipeline-start-script", "reference-viral-library-build", "reference-viral-library-publish"].map((action) => [
    action, createTrustedClickGate(`[data-xiaoxi-digital-human-action="${action}"]`, `digital-human:${action}`)
  ]));
  const invoke = (name, payload = {}) => ipcRenderer.invoke(`digital-human:${name}`, payload);
  return {
    reference: {
      capabilities: () => invoke('reference-capabilities'),
      workspace: () => invoke('reference-workspace'),
      saveWorkspace: (payload) => invoke('reference-save-workspace', payload),
      scriptQuota: () => invoke('reference-script-quota'),
      sourceStatus: () => invoke('reference-source-status'),
      sourceConnect: (payload) => invoke('reference-source-connect', payload),
      sourceSearch: (payload) => invoke('reference-source-search', payload),
      sourceRead: (payload) => invoke('reference-source-read', payload),
      viralScan: (payload) => invoke('reference-viral-scan', payload),
      viralStop: () => invoke('reference-viral-stop'),
      viralPipelineStart: (payload) => invoke('reference-viral-pipeline-start', { ...payload, clickToken: clicks['reference-viral-pipeline-start']() }),
      viralPipelineList: () => invoke('reference-viral-pipeline-list'),
      viralLibrary: () => invoke('reference-viral-library'),
      confirmConsent: (payload) => invoke('reference-confirm-consent', { ...payload, clickToken: clicks['reference-confirm-consent']() }),
      viralStartScript: (payload) => invoke('reference-viral-pipeline-start-script', { ...payload, clickToken: clicks['reference-viral-pipeline-start-script']() }),
      viralLibraryBuild: (payload) => invoke('reference-viral-library-build', { ...payload, clickToken: clicks['reference-viral-library-build']() }),
      viralLibraryExport: () => invoke('reference-viral-library-export'),
      viralLibraryPublish: () => invoke('reference-viral-library-publish', { clickToken: clicks['reference-viral-library-publish']() }),
      viralLibraryPublishToken: (payload) => invoke('reference-viral-library-publish-token', payload),
      viralLibraryRemove: (payload) => invoke('reference-viral-library-remove', payload),
      viralPipelineRetry: (payload) => invoke('reference-viral-pipeline-retry', { ...payload, clickToken: clicks['reference-viral-pipeline-retry']() }),
      viralPipelineRemove: (payload) => invoke('reference-viral-pipeline-remove', payload),
      viralPipelineCover: (payload) => invoke('reference-viral-pipeline-cover', payload),
      onViralPipeline: (callback) => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('digital-human:viral-pipeline', listener);
        return () => ipcRenderer.removeListener('digital-human:viral-pipeline', listener);
      },
      onViralProgress: (callback) => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('digital-human:viral-progress', listener);
        return () => ipcRenderer.removeListener('digital-human:viral-progress', listener);
      },
      importVideo: () => invoke('reference-import'),
      assets: () => invoke('reference-assets'), list: () => invoke('reference-list'),
      create: (payload) => invoke('reference-create', payload), get: (payload) => invoke('reference-get', payload),
      quote: (payload) => invoke('reference-quote', payload),
      repackage: (payload) => invoke('reference-repackage', payload),
      coverFrame: (payload) => invoke('reference-cover-frame', payload),
      coverQuote: (payload) => invoke('reference-cover-quote', payload),
      generateCover: (payload) => invoke('reference-cover-generate', { ...payload, clickToken: clicks['reference-cover-generate']() }),
      writeScript: async (payload, workspace) => {
        const clickToken = clicks['reference-write-script']();
        if (!clickToken) return { ok: false, error: '请点击页面按钮开始写稿。' };
        if (workspace) { const saved = await invoke('reference-save-workspace', workspace); if (!saved.ok) return saved; }
        return invoke('reference-write-script', { ...payload, clickToken });
      },
      prepare: (payload) => invoke('reference-prepare', { ...payload, clickToken: clicks['reference-prepare']() }),
      confirm: (payload) => invoke('reference-confirm', { ...payload, clickToken: clicks['reference-confirm']() }),
      resume: (payload) => invoke('reference-resume', { ...payload, clickToken: clicks['reference-resume']() }),
      refresh: (payload) => invoke('reference-refresh', payload), speechMedia: (payload) => invoke('reference-speech', payload),
      trainVoice: (payload) => invoke('reference-train', { ...payload, clickToken: clicks['reference-train']() }),
      voiceStatus: (payload) => invoke('reference-voice-status', payload),
    },
    capabilities: () => invoke("capabilities"),
    list: () => invoke("list"),
    get: (payload) => invoke("get", payload),
    importImage: () => invoke("import-image"),
    importAudio: () => invoke("import-audio"),
    recommendVoice: (payload) => invoke("recommend-voice", payload),
    previewVoice: (payload) => invoke("voice-preview", { ...payload, clickToken: clicks["voice-preview"]() }),
    selectVoice: (payload) => invoke("voice-select", payload),
    voiceClones: () => invoke("voice-clones"),
    trainVoice: (payload) => invoke("voice-train", { ...payload, clickToken: clicks["voice-train"]() }),
    cloneStatus: (payload) => invoke("voice-clone-status", payload),
    create: (payload) => invoke("create", payload),
    saveAndPreview: async (payload) => {
      // Capture the real click before a slow disk/IPC save outlives the gate.
      const clickToken = clicks.preview();
      if (!clickToken) return { ok: false, code: "trusted_user_click_required", error: "请点击页面按钮开始制作。" };
      const saved = await invoke("create", payload);
      if (!saved.ok || !saved.data?.id) return saved;
      const result = await invoke("preview", { id: saved.data.id, clickToken });
      // Keep the saved draft selected if generation is temporarily unavailable.
      return result.ok ? result : { ...result, data: saved.data };
    },
    preview: (payload) => invoke("preview", { ...payload, clickToken: clicks.preview() }),
    confirm: (payload) => invoke("confirm", { ...payload, clickToken: clicks.confirm() }),
    resume: (payload) => invoke("resume", { ...payload, clickToken: clicks.resume() }),
    refresh: (payload) => invoke("refresh", payload),
    media: (payload) => invoke("media", payload),
    speechMedia: (payload) => invoke("speech-media", payload),
    images: (payload) => invoke("images", payload)
  };
}

module.exports = { createDigitalHumanApi };
