const { createTrustedClickGate } = require("./preload-api.cjs");

function createProductVideoApi(ipcRenderer) {
  const startClick = createTrustedClickGate('[data-product-video-action="start"]', "product-video:start");
  const retryClick = createTrustedClickGate('[data-product-video-action="retry-shot"]', "product-video:retry-shot");
  const invoke = (name, payload = {}) => ipcRenderer.invoke(`product-video:${name}`, payload);
  return {
    capabilities: () => invoke("capabilities"),
    importImage: () => invoke("import-image"),
    create: (payload) => invoke("create", payload),
    list: () => invoke("list"),
    get: (id) => invoke("get", { id }),
    start: (id) => invoke("start", { id, clickToken: startClick() }),
    retryShot: (id) => invoke("retry-shot", { id, clickToken: retryClick() }),
    refresh: (id) => invoke("refresh", { id }),
    media: (id) => invoke("media", { id }),
    export: (id) => invoke("export", { id })
  };
}
module.exports = { createProductVideoApi };
