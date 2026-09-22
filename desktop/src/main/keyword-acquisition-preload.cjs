function createKeywordAcquisitionApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`keyword-acquisition:${name}`, payload);
  return {
    status: () => invoke("status"),
    saveTask: (payload) => invoke("save-task", payload),
    startTask: (taskId) => invoke("start-task", { taskId: String(taskId || "") }),
    stop: () => invoke("stop"),
    openBrowser: () => invoke("open-browser"),
    refreshAccount: () => invoke("refresh-account"),
    saveLead: (payload) => invoke("save-lead", payload),
    saveConversation: (payload) => invoke("save-conversation", payload),
    openSource: (leadId) => invoke("open-source", { leadId: String(leadId || "") }),
    openConversation: (leadId) => invoke("open-conversation", { leadId: String(leadId || "") }),
    syncConversation: (leadId) => invoke("sync-conversation", { leadId: String(leadId || "") }),
    generateDraft: (leadId) => invoke("generate-draft", { leadId: String(leadId || "") }),
    sendDraft: (leadId) => invoke("send-draft", { leadId: String(leadId || "") }),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("keyword-acquisition:update", listener); return () => ipcRenderer.removeListener("keyword-acquisition:update", listener); }
  };
}
module.exports = { createKeywordAcquisitionApi };
