const { createPhoneMatrix, VENDOR_DIR } = require("./phone-matrix.cjs");
const { createPhoneScreens, serverPathIn } = require("./phone-screens.cjs");
const { createPhoneBatch } = require("./phone-batch.cjs");
const path = require("node:path");

// 手机矩阵: the page reads the phone list, edits a phone's name / number / note / group, and gets
// updates as phones are plugged in or allow debugging.
// onActivity: what 小玺 shows while a batch runs; sayDone: 小玺's one line when it ends.
function registerPhoneMatrixIpc({ ipcMain, dialog, shell, dataDir, screenshotDir, getMainWindow, onActivity = () => {}, sayDone = () => {}, options = {} }) {
  const toPage = (channel, payload) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
  const matrix = createPhoneMatrix({ dataDir, ...options, onChange: (state) => toPage("phone-matrix:update", state) });
  const screens = createPhoneScreens({ adbPath: matrix.adbPath, serverPath: options.serverPath || serverPathIn(VENDOR_DIR), send: toPage });
  const batch = createPhoneBatch({ adbPath: matrix.adbPath, screenshotDir, paste: (serial, text) => screens.paste(serial, text),
    onState: (state) => { toPage("phone-matrix:batch", state); onActivity(batchActivity(state)); } });
  const fromPage = (event) => { const trusted = getMainWindow()?.webContents; return Boolean(trusted && event.sender === trusted); };
  const methods = {
    status: () => matrix.snapshot(),
    refresh: async () => { await matrix.poll(); return matrix.snapshot(); },
    update: (payload) => matrix.update(String(payload?.serial || ""), {
      ...(payload?.name !== undefined ? { name: payload.name } : {}), ...(payload?.note !== undefined ? { note: payload.note } : {}),
      ...(payload?.number !== undefined ? { number: payload.number } : {}), ...(payload?.group !== undefined ? { group: payload.group } : {})
    }),
    forget: (payload) => matrix.forget(String(payload?.serial || "")),
    // Batch actions answer at once with the batch; its progress comes through phone-matrix:batch.
    batchStart: (payload) => {
      const { batch: started, finished } = batch.start({ kind: String(payload?.kind || ""), serials: Array.isArray(payload?.serials) ? payload.serials : [], options: payload?.options || {} });
      void finished.then((done) => sayDone(batchSummary(done)));
      return started;
    },
    batchStop: () => batch.stop(),
    batchStatus: () => batch.status(),
    // The files for 传到相册 / 装 App, chosen in the system dialog.
    pickFiles: async (payload) => {
      const apk = payload?.kind === "install";
      const settings = { title: apk ? "选要安装的 App（.apk）" : "选要传到手机相册的视频或图片", properties: apk ? ["openFile"] : ["openFile", "multiSelections"],
        filters: apk ? [{ name: "安卓安装包", extensions: ["apk"] }] : [{ name: "视频和图片", extensions: ["mp4", "mov", "m4v", "3gp", "webm", "jpg", "jpeg", "png", "gif", "webp", "heic"] }] };
      const window = getMainWindow();
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      return result.canceled ? [] : result.filePaths;
    },
    openFolder: async (payload) => {
      const folder = String(payload?.folder || "");
      // Only a folder this page made (the screenshots), never any path the page names.
      const root = path.resolve(screenshotDir || "");
      if (!screenshotDir || !path.resolve(folder).startsWith(root + path.sep)) return false;
      return (await shell.openPath(folder)) === "";
    },
    // The phones whose screens the page shows now, and the one opened large.
    watch: async (payload) => {
      const serials = Array.isArray(payload?.serials) ? payload.serials.map(String).slice(0, 80) : [];
      void screens.watch({ serials, main: String(payload?.main || "") });
      return matrix.snapshot();
    }
  };
  // Touches and keys go straight through, without a reply, so dragging on a screen keeps up.
  const onInput = (event, payload) => {
    if (!fromPage(event)) return;
    const targets = Array.isArray(payload?.targets) ? payload.targets.map(String).slice(0, 80) : [];
    screens.input({ targets, kind: String(payload?.kind || ""), action: Number(payload?.action) || 0, x: Number(payload?.x), y: Number(payload?.y),
      keycode: Number(payload?.keycode) || 0, text: String(payload?.text || "").slice(0, 2000), on: payload?.on === true,
      jitterMs: Math.max(0, Math.min(5000, Number(payload?.jitterMs) || 0)) });
  };
  ipcMain.on("phone-matrix:input", onInput);
  const channels = Object.keys(methods).map((name) => `phone-matrix:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`phone-matrix:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted) return { ok: false, code: "PHONE_IPC_FORBIDDEN", error: "当前页面无权操作手机矩阵。" };
    try { return { ok: true, state: await method(payload, event) }; }
    catch (error) { return { ok: false, code: error.code || "PHONE_OPERATION_FAILED", error: /^PHONE_/.test(String(error.code || "")) ? error.message : "操作未完成，请稍后重试。" }; }
  });
  matrix.start();
  return { matrix, screens, batch, dispose() { matrix.stop(); screens.stopAll(); batch.stop(); ipcMain.removeListener("phone-matrix:input", onInput); channels.forEach((channel) => ipcMain.removeHandler(channel)); } };
}

// 小玺 while a batch runs: what it does and how far along it is.
function batchActivity(state) {
  if (!state?.running) return null;
  if (state.waitingUser) return { title: `手机矩阵 · ${state.label}`, detail: `有 ${state.waitingUser} 部手机在等你在手机上确认安装`, attention: true, done: state.done, total: state.total };
  return { title: `手机矩阵 · ${state.label}`, detail: `${state.done}/${state.total} 部手机${state.failed ? `，${state.failed} 部没成` : ""}${state.stopping ? "，正在停下" : ""}`, done: state.done, total: state.total };
}
function batchSummary(state) {
  const ok = state.results.filter((item) => item.status === "done").length;
  if (!state.failed) return { text: `${state.label}：${ok} 部手机都做好了`, mood: "done" };
  return { text: `${state.label}：${ok} 部做好，${state.failed} 部没成`, sub: "回到手机矩阵看是哪几部", mood: "error" };
}

module.exports = { registerPhoneMatrixIpc, batchActivity, batchSummary };
