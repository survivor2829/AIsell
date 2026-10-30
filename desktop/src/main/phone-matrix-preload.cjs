function createPhoneMatrixApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`phone-matrix:${name}`, payload);
  return {
    status: () => invoke("status"),
    refresh: () => invoke("refresh"),
    update: (serial, fields) => invoke("update", { serial: String(serial || ""), ...fields }),
    forget: (serial) => invoke("forget", { serial: String(serial || "") }),
    watch: (serials, main) => invoke("watch", { serials: Array.isArray(serials) ? serials.map(String) : [], main: String(main || "") }),
    batchStart: (kind, serials, options) => invoke("batchStart", { kind: String(kind || ""), serials: Array.isArray(serials) ? serials.map(String) : [], options: options || {} }),
    batchStop: () => invoke("batchStop"),
    batchStatus: () => invoke("batchStatus"),
    pickFiles: (kind) => invoke("pickFiles", { kind: String(kind || "") }),
    openFolder: (folder) => invoke("openFolder", { folder: String(folder || "") }),
    onBatch: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("phone-matrix:batch", listener); return () => ipcRenderer.removeListener("phone-matrix:batch", listener); },
    input: (payload) => ipcRenderer.send("phone-matrix:input", payload),
    onScreen: (callback) => { const listener = (_event, packet) => callback(packet); ipcRenderer.on("phone-matrix:screen", listener); return () => ipcRenderer.removeListener("phone-matrix:screen", listener); },
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("phone-matrix:update", listener); return () => ipcRenderer.removeListener("phone-matrix:update", listener); }
  };
}
module.exports = { createPhoneMatrixApi };
