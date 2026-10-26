function createSocialAcquisitionApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`social-acquisition:${name}`, payload);
  return {
    status: () => invoke("status"),
    saveTask: (task) => invoke("saveTask", {
      id: String(task?.id || ""), name: String(task?.name || ""), platform: String(task?.platform || ""), accountId: String(task?.accountId || ""),
      keywords: String(task?.keywords || ""), intentWords: String(task?.intentWords || ""), days: Number(task?.days) || 30, maxVideos: Number(task?.maxVideos) || 10,
      allComments: task?.allComments === true, skipAuthor: task?.skipAuthor !== false,
      mode: task?.mode === "comment" ? "comment" : "collect", texts: String(task?.texts || ""), maxComments: Number(task?.maxComments) || 5
    }),
    removeTask: (id) => invoke("removeTask", { id: String(id || "") }),
    start: (id) => invoke("start", { id: String(id || "") }),
    stop: () => invoke("stop"),
    setLead: (id, status) => invoke("setLead", { id: String(id || ""), status: String(status || "") }),
    queueActions: (leadIds, kinds) => invoke("queueActions", { leadIds: Array.isArray(leadIds) ? leadIds.map(String) : [], kinds: Array.isArray(kinds) ? kinds.map(String) : [] }),
    resume: () => invoke("resume"),
    cancelQueued: () => invoke("cancelQueued"),
    resolveAction: (id, outcome) => invoke("resolveAction", { id: String(id || ""), outcome: String(outcome || "") }),
    saveCaps: (caps) => invoke("saveCaps", { like: Number(caps?.like), follow: Number(caps?.follow), comment: Number(caps?.comment) }),
    exportCsv: (taskId) => invoke("exportCsv", { taskId: String(taskId || "") }),
    openLead: (id) => invoke("openLead", { id: String(id || "") }),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("social-acquisition:update", listener); return () => ipcRenderer.removeListener("social-acquisition:update", listener); }
  };
}
module.exports = { createSocialAcquisitionApi };
