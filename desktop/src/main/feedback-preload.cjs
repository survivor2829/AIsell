function createFeedbackApi(ipcRenderer) {
  const payload = (value) => ({ id: String(value?.id || ""), text: String(value?.text || ""), category: String(value?.category || ""),
    visibility: value?.visibility === "private" ? "private" : "public", includeDiagnostics: value?.includeDiagnostics !== false,
    context: value?.context ? { module: String(value.context.module || ""), taskId: String(value.context.taskId || "") } : null });
  return {
    publicList: (offset) => ipcRenderer.invoke("feedback:publicList", offset),
    withdraw: (id) => ipcRenderer.invoke("feedback:withdraw", String(id || "")),
    adminAvailable: () => ipcRenderer.invoke("feedback:adminAvailable"),
    adminList: (value) => ipcRenderer.invoke("feedback:adminList", { offset: value?.offset, status: value?.status }),
    adminUpdate: (value) => ipcRenderer.invoke("feedback:adminUpdate", { id: value?.id, status: value?.status, officialReply: value?.officialReply, hidden: value?.hidden }),
    status: () => ipcRenderer.invoke("feedback:status"),
    submit: (value) => ipcRenderer.invoke("feedback:submit", payload(value)),
    saveDraft: (value) => ipcRenderer.invoke("feedback:saveDraft", payload(value)),
    retry: (id) => ipcRenderer.invoke("feedback:retry", String(id || "")),
    refresh: () => ipcRenderer.invoke("feedback:refresh"),
    onUpdate(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("feedback:update", handler);
      return () => ipcRenderer.removeListener("feedback:update", handler);
    }
  };
}
module.exports = { createFeedbackApi };
