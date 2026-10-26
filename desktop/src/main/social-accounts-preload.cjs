function createSocialAccountsApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`social-accounts:${name}`, payload);
  return {
    status: () => invoke("status"),
    add: (platform, label) => invoke("add", { platform: String(platform || ""), label: String(label || "") }),
    rename: (id, label) => invoke("rename", { id: String(id || ""), label: String(label || "") }),
    login: (id) => invoke("login", { id: String(id || "") }),
    refresh: () => invoke("refresh"),
    remove: (id) => invoke("remove", { id: String(id || "") }),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("social-accounts:update", listener); return () => ipcRenderer.removeListener("social-accounts:update", listener); }
  };
}
module.exports = { createSocialAccountsApi };
