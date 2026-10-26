function createSocialPublishApi(ipcRenderer) {
  const invoke = (name, payload) => ipcRenderer.invoke(`social-publish:${name}`, payload);
  const id = (value) => ({ id: String(value || "") });
  return {
    status: () => invoke("status"),
    submit: (payload) => invoke("submit", {
      videos: (Array.isArray(payload?.videos) ? payload.videos : []).map((video) => ({ finishedVideoId: String(video?.finishedVideoId || ""), name: String(video?.name || "") })),
      accountIds: (Array.isArray(payload?.accountIds) ? payload.accountIds : []).map(String),
      title: String(payload?.title || ""), description: String(payload?.description || ""), visibility: payload?.visibility === "private" ? "private" : "public",
      copies: Object.fromEntries(Object.entries(payload?.copies && typeof payload.copies === "object" ? payload.copies : {}).map(([platform, copy]) => [String(platform), { title: String(copy?.title || ""), description: String(copy?.description || "") }]))
    }),
    covers: (ids) => invoke("covers", { ids: (Array.isArray(ids) ? ids : []).map(String) }),
    suggest: (payload) => invoke("suggest", { hint: String(payload?.hint || ""), platforms: (Array.isArray(payload?.platforms) ? payload.platforms : []).map(String), videos: (Array.isArray(payload?.videos) ? payload.videos : []).map((video) => ({ title: String(video?.title || ""), name: String(video?.name || ""), context: String(video?.context || "") })) }),
    cancel: (jobId) => invoke("cancel", id(jobId)),
    retry: (jobId) => invoke("retry", id(jobId)),
    resolve: (jobId, published) => invoke("resolve", { ...id(jobId), published: published === true }),
    remove: (jobId) => invoke("remove", id(jobId)),
    onUpdate: (callback) => { const listener = (_event, state) => callback(state); ipcRenderer.on("social-publish:update", listener); return () => ipcRenderer.removeListener("social-publish:update", listener); }
  };
}
module.exports = { createSocialPublishApi };
