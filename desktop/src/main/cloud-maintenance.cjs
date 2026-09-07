const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createTransport } = require("./cloud-transport.cjs");
const { compareVersions, fail, reportEntry, token, UUID, verifyManifest } = require("../shared/cloud-contract.cjs");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
async function fileHash(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function createCloudMaintenance({ rootDir, config, version, buildId, logger, canInstall = () => false, transport, launch = spawn }) {
  const dir = path.join(rootDir, "cloud-maintenance");
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json");
  const queueFile = path.join(dir, "outbox.json");
  const saved = readJson(stateFile, {});
  const state = {
    installId: UUID.test(saved.installId || "") ? saved.installId : crypto.randomUUID(),
    consent: saved.consent === true, sequence: Number.isSafeInteger(saved.sequence) ? saved.sequence : 0,
    lastUpload: typeof saved.lastUpload === "string" ? saved.lastUpload : "", pending: saved.pending || null
  };
  const network = transport || (config?.enabled ? createTransport(config) : null);
  let queue = readJson(queueFile, []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter((item) => item?.report?.appId === config?.appId).slice(-200);
  if (!state.consent) queue = [];
  let checking = false, uploading = false, stopped = false, unsubscribe;
  let retryAt = 0, attempts = 0, checkTimer, uploadTimer;
  let view = { stage: network ? "idle" : "disabled", progress: 0, nextVersion: "", error: "", uploadError: "" };
  const listeners = new Set();
  function save() { writeJsonAtomic(stateFile, state); }
  function saveQueue() { writeJsonAtomic(queueFile, queue); }
  function status() { return { ...view, enabled: Boolean(network), version, channel: config?.channel || "", consent: state.consent, queued: queue.length, lastUpload: state.lastUpload, canInstall: canInstall() }; }
  function notify(patch = {}) { view = { ...view, ...patch }; for (const listener of listeners) { try { listener(status()); } catch {} } }
  save();
  function envelopeFor(entries) {
    return { schema: 1, appId: config.appId, channel: config.channel, installId: state.installId,
      version, buildId: token(buildId), platform: process.platform, arch: process.arch,
      osRelease: token(os.release()), entries };
  }
  function enqueue(entry) {
    if (!network || !state.consent || stopped) return;
    const sanitized = reportEntry(entry, state);
    if (!sanitized) return;
    queue.push({ report: envelopeFor([sanitized]), created: Date.now() });
    queue = queue.filter((item) => item.created > Date.now() - 30 * 86400000).slice(-200);
    saveQueue(); notify();
  }
  function lifecycle(event, code) {
    enqueue({ ts: new Date().toISOString(), run_id: crypto.randomUUID(), seq: 1,
      level: "info", module: "maintenance", event, code });
  }
  async function flush() {
    if (!network || !state.consent || uploading || stopped || Date.now() < retryAt || !queue.length) return status();
    uploading = true;
    try {
      // Preserve the originating version/build on offline reports after an upgrade.
      for (const item of queue.slice(0, 10)) {
        if (!state.consent || stopped) break;
        const result = await network.request("/v1/reports", { body: item.report });
        if (!Array.isArray(result.accepted) || !item.report.entries.every((entry) => result.accepted.includes(entry.id))) fail("cloud_ack_invalid");
        queue = queue.filter((candidate) => candidate !== item);
        state.lastUpload = new Date().toISOString(); saveQueue(); save();
      }
      attempts = 0; retryAt = 0; notify({ uploadError: "" });
    } catch {
      retryAt = Date.now() + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(attempts++, 7));
      notify({ uploadError: "上传暂未成功，已保存在本机，联网后自动重试。" });
    } finally { uploading = false; notify(); }
    return status();
  }
  async function check() {
    if (!network || checking || stopped) return status();
    checking = true; notify({ stage: "checking", error: "" });
    let temporary;
    try {
      const envelope = await network.request(`/v1/releases/${config.channel}/latest`);
      if (envelope.empty === true) { notify({ stage: "current" }); return status(); }
      const manifest = verifyManifest(envelope, config);
      if (manifest.sequence < state.sequence) fail("cloud_release_rollback");
      state.sequence = manifest.sequence; save();
      if (compareVersions(manifest.version, version) <= 0) {
        state.pending = null; save(); notify({ stage: "current", nextVersion: "" }); return status();
      }
      const destination = path.join(dir, `${manifest.sha256}.exe`);
      notify({ stage: "downloading", nextVersion: manifest.version, progress: 0 });
      const existing = fs.existsSync(destination) && fs.statSync(destination).size === manifest.size
        && await fileHash(destination) === manifest.sha256;
      if (!existing) {
        const free = fs.statfsSync(dir);
        if (free.bavail * free.bsize < manifest.size * 2 + 256 * 1024 ** 2) fail("cloud_disk_full");
        temporary = path.join(dir, `${crypto.randomUUID()}.part`);
        let lastProgress = -1;
        await network.request(manifest.file, { destination: temporary, expected: manifest, maxBytes: manifest.size,
          onProgress: (size) => {
            const progress = Math.floor(size / manifest.size * 100);
            if (progress !== lastProgress) { lastProgress = progress; notify({ progress }); }
          } });
        if (stopped) fail("cloud_stopped");
        fs.renameSync(temporary, destination); temporary = undefined;
      }
      state.pending = envelope; save();
      notify({ stage: "ready", progress: 100 });
    } catch (error) {
      const message = error?.code === "cloud_disk_full" ? "磁盘空间不足，请清理空间后重试。" : "更新检查或下载失败，请稍后重试。";
      notify({ stage: "error", error: message });
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      checking = false;
    }
    return status();
  }
  async function prepareInstall() {
    if (!state.pending || !canInstall()) return null;
    const m = verifyManifest(state.pending, config);
    if (m.sequence < state.sequence || compareVersions(m.version, version) <= 0) return null;
    const file = path.join(dir, `${m.sha256}.exe`);
    if (fs.statSync(file).size !== m.size || await fileHash(file) !== m.sha256) fail("cloud_download_invalid");
    return { file, version: m.version };
  }
  // Called only after the app's normal shutdown/sidecar cleanup has completed.
  async function installOnExit() {
    try {
      const prepared = await prepareInstall();
      if (!prepared) return false;
      await new Promise((resolve, reject) => {
        const child = launch(prepared.file, ["/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      return true;
    } catch { notify({ stage: "error", error: "更新安装未启动，下次打开后可重试。" }); return false; }
  }
  function setConsent(enabled) {
    state.consent = enabled === true;
    if (!state.consent) { queue = []; saveQueue(); }
    save(); notify();
    if (state.consent) { lifecycle("diagnostics_enabled", "ok"); void flush(); }
    return status();
  }
  function start() {
    if (!network || stopped || checkTimer) return;
    unsubscribe = logger?.subscribe?.((entry) => { try { enqueue(entry); } catch {} });
    lifecycle("app_started", "ok");
    void check(); void flush();
    checkTimer = setInterval(() => void check(), 6 * 60 * 60_000); checkTimer.unref?.();
    uploadTimer = setInterval(() => void flush(), 15_000); uploadTimer.unref?.();
  }
  function stop() { stopped = true; clearInterval(checkTimer); clearInterval(uploadTimer); unsubscribe?.(); network?.close(); }
  return { status, check, flush, enqueue, setConsent, start, stop, prepareInstall, installOnExit,
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { createCloudMaintenance, fileHash };
