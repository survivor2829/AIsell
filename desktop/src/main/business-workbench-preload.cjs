function createBusinessWorkbenchApi(ipcRenderer, domain) {
  return Object.freeze({
    invoke: (action, payload = {}) => ipcRenderer.invoke(`${domain}:invoke`, action, payload),
    onUpdate: listener => {
      const receive = (_event, state) => listener(state);
      ipcRenderer.on(`${domain}:update`, receive);
      return () => ipcRenderer.removeListener(`${domain}:update`, receive);
    }
  });
}
module.exports = { createBusinessWorkbenchApi };
