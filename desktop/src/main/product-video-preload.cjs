const { createTrustedClickGate } = require("./preload-api.cjs");

function createProductVideoApi(ipcRenderer) {
  const startClick = createTrustedClickGate('[data-product-video-action="start"]', "product-video:start");
  const retryClick = createTrustedClickGate('[data-product-video-action="retry-shot"]', "product-video:retry-shot");
  const confirmClick = createTrustedClickGate('[data-product-video-action="confirm-sheet"]', "product-video:confirm-sheet");
  const redoClick = createTrustedClickGate('[data-product-video-action="redo-sheet"]', "product-video:redo-sheet");
  const invoke = (name, payload = {}) => ipcRenderer.invoke(`product-video:${name}`, payload);
  return {
    capabilities: () => invoke("capabilities"),
    importImage: () => invoke("import-image"),
    importFacts: () => invoke("import-facts"),
    create: (payload) => invoke("create", payload),
    list: () => invoke("list"),
    get: (id) => invoke("get", { id }),
    start: (id) => invoke("start", { id, clickToken: startClick() }),
    // 「生成视频」 in one click: the click token is taken now, before the plan is saved, so the
    // start that follows is still bound to this click. A failed start returns the saved task too.
    createAndStart: async (payload) => {
      const clickToken = startClick();
      const created = await invoke("create", payload);
      if (!created?.ok) return created;
      const started = await invoke("start", { id: created.data.id, clickToken });
      return started?.ok ? started : { ...started, task: created.data };
    },
    retryShot: (id) => invoke("retry-shot", { id, clickToken: retryClick() }),
    refresh: (id) => invoke("refresh", { id }),
    media: (id) => invoke("media", { id }),
    shotMedia: (id, index) => invoke("shot-media", { id, index }),
    imageMedia: (id, key) => invoke("image-media", { id, key }),
    confirmSheet: (id) => invoke("confirm-sheet", { id, clickToken: confirmClick() }),
    redoSheet: (id) => invoke("redo-sheet", { id, clickToken: redoClick() }),
    export: (id) => invoke("export", { id }),
    exportSource: (id) => invoke("export-source", { id })
  };
}
module.exports = { createProductVideoApi };
