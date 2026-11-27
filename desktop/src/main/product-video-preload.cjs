const { createTrustedClickGate } = require("./preload-api.cjs");

function createProductVideoApi(ipcRenderer) {
  const startClick = createTrustedClickGate('[data-product-video-action="start"]', "product-video:start");
  const retryClick = createTrustedClickGate('[data-product-video-action="retry-shot"]', "product-video:retry-shot");
  const confirmClick = createTrustedClickGate('[data-product-video-action="confirm-sheet"]', "product-video:confirm-sheet");
  const redoClick = createTrustedClickGate('[data-product-video-action="redo-sheet"]', "product-video:redo-sheet");
  const sceneClick = createTrustedClickGate('[data-product-video-action="confirm-scene"]', "product-video:confirm-scene");
  const redoSceneClick = createTrustedClickGate('[data-product-video-action="redo-scene"]', "product-video:redo-scene");
  const redoShotClick = createTrustedClickGate('[data-product-video-action="redo-shot"]', "product-video:redo-shot");
  const updateShotClick = createTrustedClickGate('[data-product-video-action="update-shot"]', "product-video:update-shot");
  const storyboardClick = createTrustedClickGate('[data-product-video-action="confirm-storyboard"]', "product-video:confirm-storyboard");
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
    confirmScene: (id) => invoke("confirm-scene", { id, clickToken: sceneClick() }),
    redoScene: (id) => invoke("redo-scene", { id, clickToken: redoSceneClick() }),
    redoShot: (id, index) => invoke("redo-shot", { id, index, clickToken: redoShotClick() }),
    updateShot: (id, index, change) => invoke("update-shot", { id, index, change, clickToken: updateShotClick() }),
    confirmStoryboard: (id) => invoke("confirm-storyboard", { id, clickToken: storyboardClick() }),
    export: (id) => invoke("export", { id }),
    exportSource: (id) => invoke("export-source", { id })
  };
}
module.exports = { createProductVideoApi };
