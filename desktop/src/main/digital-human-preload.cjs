const { createTrustedClickGate } = require("./preload-api.cjs");

function createDigitalHumanApi(ipcRenderer) {
  const clicks = Object.fromEntries(["preview", "confirm", "resume"].map((action) => [
    action, createTrustedClickGate(`[data-xiaoxi-digital-human-action="${action}"]`, `digital-human:${action}`)
  ]));
  const invoke = (name, payload = {}) => ipcRenderer.invoke(`digital-human:${name}`, payload);
  return {
    capabilities: () => invoke("capabilities"),
    list: () => invoke("list"),
    get: (payload) => invoke("get", payload),
    importImage: () => invoke("import-image"),
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
    images: (payload) => invoke("images", payload)
  };
}

module.exports = { createDigitalHumanApi };
