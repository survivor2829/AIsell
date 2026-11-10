const path = require("node:path");
const { createSocialAccounts } = require("./social-accounts.cjs");
const { createGeoWorkbench } = require("./geo-workbench.cjs");
const { reportSocialFailure } = require("./social-publish-ipc.cjs");
const { createGeoBrowserAdapter, GEO_CHANNELS, GEO_ACCOUNT_PLATFORMS } = require("./geo-publish-drivers.cjs");

const ACCOUNT_ACTIONS = new Set(["account-add", "account-login", "account-refresh", "account-remove"]);

// GEO keeps its media accounts apart from the short-video accounts of 一键分发: a separate list and
// separate Chrome profiles, so these platforms never show up as video publishing targets.
function registerGeoWorkbenchIpc({ ipcMain, shell, dataDir, deepSeekClient, getMainWindow, logger, evidenceDir, options = {} }) {
  let geo, accounts, initializationError;
  const send = (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("geo:update", state); };
  try {
    accounts = options.accounts || createSocialAccounts({ dataDir: path.join(dataDir, "accounts"), platforms: GEO_ACCOUNT_PLATFORMS, probe: async () => false, onChange: () => geo?.emit() });
    geo = createGeoWorkbench({ dataDir, accounts, channels: GEO_CHANNELS, adapter: options.adapter || createGeoBrowserAdapter(), onChange: send,
      // Same log and screenshot folder as 一键分发, which failure capsules and the diagnostic package collect.
      onFailure: (failure) => reportSocialFailure({ logger, evidenceDir }, "geo_publish", failure),
      generateText: ({ prompt }) => deepSeekClient.geoContent({ prompt }) });
  } catch (error) { initializationError = { ok: false, code: error.code || "GEO_UNAVAILABLE", error: error.code === "GEO_STATE_INVALID" ? error.message : "GEO 暂时无法打开，请重新打开软件。" }; }
  const known = /^(GEO|SOCIAL)_/;
  const accountStep = async (action, payload) => {
    if (action === "account-add") await accounts.add({ platform: String(payload.platform || ""), label: String(payload.label || "") });
    else if (action === "account-login") await accounts.login(String(payload.id || ""));
    else if (action === "account-refresh") await accounts.refresh();
    else await accounts.remove(String(payload.id || ""));
    return geo.snapshot();
  };
  // Only the link of a publication the app itself recorded opens, in the user's default browser.
  const openLink = async (payload) => {
    const item = geo.snapshot().publications.find((row) => row.id === String(payload.id || ""));
    const url = new URL(item?.url || "about:blank");
    if (url.protocol !== "https:") throw Object.assign(new Error("这条记录没有可打开的链接。"), { code: "GEO_LINK_INVALID" });
    await shell.openExternal(url.href);
    return geo.snapshot();
  };
  ipcMain.handle("geo:invoke", async (event, action, payload = {}) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "GEO_IPC_FORBIDDEN", error: "当前页面无权使用 GEO。" };
    if (initializationError) return initializationError;
    try {
      if (typeof action !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("操作参数不对。"), { code: "GEO_ACTION_INVALID" });
      if (ACCOUNT_ACTIONS.has(action)) return { ok: true, state: await accountStep(action, payload) };
      if (action === "open-link") return { ok: true, state: await openLink(payload) };
      const state = await geo.dispatch(action, payload);
      return { ok: true, state };
    } catch (error) {
      return { ok: false, code: error.code || "GEO_OPERATION_FAILED", error: known.test(String(error.code || "")) ? error.message : (/^(AI_|API_KEY_|SECURE_STORAGE_|PROVIDER_GATEWAY_)/.test(String(error.code || "")) ? String(error.message) : "操作没有完成，已有内容都保留了，请稍后再试。"), state: geo.snapshot() };
    }
  });
  return { geo, isBusy: () => Boolean(geo?.isBusy()), async dispose() { ipcMain.removeHandler("geo:invoke"); await geo?.dispose(); await accounts?.dispose?.(); } };
}
module.exports = { registerGeoWorkbenchIpc };
