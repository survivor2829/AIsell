function createPhoneMatrixApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`phone-matrix:${name}`, payload);
  return {
    status: () => invoke("status"),
    refresh: () => invoke("refresh"),
    update: (serial, fields) => invoke("update", { serial: String(serial || ""), ...fields }),
    forget: (serial) => invoke("forget", { serial: String(serial || "") }),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("phone-matrix:update", listener); return () => ipcRenderer.removeListener("phone-matrix:update", listener); }
  };
}
module.exports = { createPhoneMatrixApi };
