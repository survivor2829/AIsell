// Only shipped by the source-locked legacy bridge, never a persistent startup task.
const fs = require("node:fs");
const path = require("node:path");
const { readJson, updatePaths } = require("./component-paths.cjs");
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function claimContinuation({ userData, context, argv = process.argv, isAlive = alive }) {
  const flag = argv.indexOf("--xiaoxi-updated-launch"), id = flag < 0 ? "" : argv[flag + 1];
  if (!/^[a-f0-9-]{36}$/.test(id || "") || !context?.id) return null;
  const paths = updatePaths(userData), job = readJson(path.join(paths.jobs, id + ".json"));
  const selection = readJson(paths.selection), ready = readJson(path.join(paths.jobs, id + ".ready.json"));
  const active = readJson(path.join(paths.directory, "active-job.json"));
  if (selection?.pending?.jobId !== id || selection.active !== context.id
      || job?.id !== id || job.prepared?.kind !== "components" || job.targetVersion !== context.version
      || path.resolve(job.prepared.generationRoot || "") !== path.resolve(context.root)
      || !Number.isInteger(ready?.pid) || ready.pid <= 0 || active?.id !== id || active.pid !== ready.pid || !isAlive(ready.pid)) return null;
  // Claim before any await. A crash, cancellation or ordinary restart cannot replay it.
  try { fs.writeFileSync(path.join(paths.jobs, id + ".bridge-consumed.json"), JSON.stringify({ id, version: context.version }), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") return null; throw error; }
  return { id, pid: ready.pid, paths, version: context.version };
}

function progressWindow(getMainWindow, cancel) {
  const { BrowserWindow } = require("electron");
  const window = new BrowserWindow({ width: 490, height: 270, parent: getMainWindow(), resizable: false, autoHideMenuBar: true,
    title: "软件更新", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  let committed = false;
  window.on("close", event => { if (committed) event.preventDefault(); else cancel(); });
  window.webContents.on("will-navigate", (event, url) => { event.preventDefault(); if (url === "xiaoxi-update-cancel://request" && !committed) cancel(); });
  const loaded = window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><meta charset="utf-8"><style>body{padding:24px;font:16px "Microsoft YaHei",sans-serif;background:#fff5f7;color:#273442}h1{font-size:24px}p{line-height:1.6}a{color:#bb2344}</style><h1>正在完成更新</h1><p id="state">正在准备剩余更新，请稍候。</p><a id="cancel" href="xiaoxi-update-cancel://request">取消等待</a>'));
  return { update(message, installing = false) { committed = installing; void loaded.then(() => {
    if (!window.isDestroyed()) return window.webContents.executeJavaScript(`document.getElementById('state').textContent=${JSON.stringify(message)};document.getElementById('cancel').hidden=${installing}`);
  }).catch(() => {}); }, close() { if (!window.isDestroyed()) window.destroy(); } };
}

function createLegacyContinuation({ app, controller, userData, context = global.__xiaoxiComponents, getMainWindow,
  prepare, release, setHold = value => { global.__xiaoxiUpdateHold = value; },
  argv = process.argv, isAlive = alive, showProgress = cancel => progressWindow(getMainWindow, cancel), intervalMs = 1000 }) {
  const inherited = claimContinuation({ userData, context, argv, isAlive });
  let requested = false, installing = false, running = false, stopped = false, epoch = 0, timer, window;
  let awaitingFirst = inherited;
  async function cancel() {
    if (installing) return controller.status();
    requested = false; epoch++; clearInterval(timer); setHold(false); window?.close(); window = null;
    await release(); return controller.status();
  }
  async function tick(ticket) {
    if (!requested || stopped || running || ticket !== epoch) return;
    running = true;
    try {
      if (awaitingFirst) {
        const first = awaitingFirst, result = readJson(path.join(first.paths.jobs, first.id + ".status.json"));
        const ack = readJson(path.join(first.paths.jobs, first.id + ".ack.json"));
        if (result?.phase === "error") throw Error("first_stage_failed");
        if (result?.phase !== "complete" || !ack?.ok || ack.version !== first.version || isAlive(first.pid)) return;
        awaitingFirst = null;
      }
      const state = controller.status();
      if (state.stage === "error" || state.stage === "disabled") throw Error("download_not_ready");
      if (["checking", "downloading", "verifying", "idle"].includes(state.stage)) {
        window?.update(state.stage === "downloading" ? `正在下载 ${Math.round(state.progress || 0)}%` : "正在校验更新，请稍候。"); return;
      }
      if (!await controller.prepareInstall()) throw Error("update_not_prepared");
      const waiting = await prepare();
      if (!requested || stopped || ticket !== epoch) return;
      if (waiting) { window?.update(waiting); return; }
      installing = true; window?.update("正在准备安装，当前工作已保存。", true);
      if (await controller.beginInstall()) { requested = false; clearInterval(timer); window?.close(); app.quit(); }
      else { installing = false; await cancel(); }
    } catch {
      installing = false; await cancel();
      if (!stopped) controller.setInstallBlocked("更新已暂停，现有数据保留。请点击立即更新重试。");
    } finally {
      if ((!requested || stopped) && !installing) await release();
      running = false;
    }
  }
  async function request() {
    if (stopped || requested || installing) return controller.status();
    requested = true; const ticket = ++epoch; setHold(true);
    window = showProgress(() => { void cancel(); });
    timer = setInterval(() => void tick(ticket), intervalMs); timer.unref?.();
    // check() preserves resumable downloads. Cancellation only drops this intent.
    void controller.check().then(() => tick(ticket)).catch(() => cancel());
    void tick(ticket); return controller.status();
  }
  app.on("before-quit", () => { stopped = true; requested = false; epoch++; clearInterval(timer); window?.close();
    if (!installing) { setHold(false); void release(); } });
  return { request, cancel, start() { if (inherited) void request(); }, inherited: Boolean(inherited) };
}

function legacySafety({ workflow, coordinator, productVideo, digitalHuman, contentEngine, productDetail }) {
  let pausing;
  return {
    async prepare() {
      const state = workflow?.status();
      if (state?.enabled && !pausing) { pausing = workflow.pause("update"); pausing.catch(() => {}); }
      if (state?.enabled || state?.phase === "pausing" || state?.contactSync?.running || coordinator.status().lock) return "正在等待微信操作完成并保存结果。";
      if (pausing) await pausing;
      const media = await Promise.all([productVideo?.prepareForUpdate(), digitalHuman?.prepareForUpdate()]);
      if (media.some(value => value?.busy)) return "正在等待视频任务保存。";
      const content = contentEngine?.updateStatus();
      if (content?.pending || (content?.alive && content.state !== "ready")) return "正在等待内容任务完成。";
      const summary = content?.state === "ready" ? await contentEngine.productionSummary() : { active: 0 };
      const product = await productDetail?.prepareUpdate(true);
      return summary.active > 0 || product?.busy ? "正在等待图片和视频制作完成。" : "";
    },
    async release() {
      pausing = null; productVideo?.resumeAfterUpdate(); digitalHuman?.resumeAfterUpdate();
      await productDetail?.prepareUpdate(false).catch(() => {});
    }
  };
}
module.exports = { claimContinuation, createLegacyContinuation, legacySafety };
