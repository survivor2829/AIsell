function createOfficialMaterialsApi(ipcRenderer) { return {
  list: (options) => ipcRenderer.invoke("official-materials:list", options),
  importMaterial: (id) => ipcRenderer.invoke("official-materials:importMaterial", id),
  previewMaterial: (id) => ipcRenderer.invoke("official-materials:previewMaterial", id),
  openSource: (url) => ipcRenderer.invoke("official-materials:openSource", url),
  search: (query) => ipcRenderer.invoke("official-materials:search", query),
  cancelSearch: (id) => ipcRenderer.invoke("official-materials:cancelSearch", id),
  onSearchUpdate: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("official-materials:searchUpdate", listener);
    return () => ipcRenderer.removeListener("official-materials:searchUpdate", listener);
  }
}; }
module.exports = { createOfficialMaterialsApi };
