function createSocialNurtureApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`social-nurture:${name}`, payload);
  return {
    status: () => invoke("status"),
    savePlan: (plan) => invoke("savePlan", {
      id: String(plan?.id || ""), accountId: String(plan?.accountId || ""), keywords: String(plan?.keywords || ""), comments: String(plan?.comments || ""), startTime: String(plan?.startTime || ""),
      testVideo: plan?.testVideo?.finishedVideoId ? { finishedVideoId: String(plan.testVideo.finishedVideoId), name: String(plan.testVideo.name || ""), title: String(plan.testVideo.title || "") } : null
    }),
    removePlan: (id) => invoke("removePlan", { id: String(id || "") }),
    setEnabled: (id, enabled) => invoke("setEnabled", { id: String(id || ""), enabled: enabled === true }),
    stop: () => invoke("stop"),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("social-nurture:update", listener); return () => ipcRenderer.removeListener("social-nurture:update", listener); }
  };
}
module.exports = { createSocialNurtureApi };
