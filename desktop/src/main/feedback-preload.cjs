function createFeedbackApi(ipcRenderer) {
  const payload = (value) => ({ id: String(value?.id || ""), text: String(value?.text || ""), category: String(value?.category || ""),
    includeDiagnostics: value?.includeDiagnostics !== false,
    context: value?.context ? { module: String(value.context.module || ""), taskId: String(value.context.taskId || "") } : null });
  return {
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
