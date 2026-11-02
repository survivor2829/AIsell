function createGeoApi(ipcRenderer) {
  return {
    invoke: (action, payload = {}) => ipcRenderer.invoke("geo:invoke", String(action || ""), payload),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("geo:update", listener); return () => ipcRenderer.removeListener("geo:update", listener); }
  };
}
module.exports = { createGeoApi };
