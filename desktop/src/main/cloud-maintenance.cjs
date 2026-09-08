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
    consent: saved.consent === true, sequence: Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence : 0,
    lastUpload: typeof saved.lastUpload === "string" ? saved.lastUpload : "", pending: saved.pending || null,
    announcements: [],
    lastAnnouncementsCheck: typeof saved.lastAnnouncementsCheck === "string" ? saved.lastAnnouncementsCheck : ""
  };
  for (const item of [...(Array.isArray(saved.announcements) ? saved.announcements.slice(0, 20) : []), ...(saved.pending ? [{ envelope: saved.pending, read: false }] : [])]) {
    try {
      const manifest = verifyManifest(item.envelope, config);
      state.sequence = Math.max(state.sequence, manifest.sequence);
      if (!state.announcements.some((entry) => entry.sequence === manifest.sequence)) state.announcements.push({ sequence: manifest.sequence, envelope: item.envelope, read: item.read === true });
    } catch {}
  }
  state.announcements.sort((left, right) => right.sequence - left.sequence);
  state.announcements = state.announcements.slice(0, 20);
  const network = transport || (config?.enabled ? createTransport(config) : null);
  let queue = readJson(queueFile, []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter((item) => item?.report?.appId === config?.appId).slice(-200);
  if (!state.consent) queue = [];
  let checking = false, uploading = false, stopped = false, unsubscribe;
  let retryAt = 0, attempts = 0, checkTimer, uploadTimer, announcementTimer, latestRequest;
  let view = { stage: network ? "idle" : "disabled", progress: 0, nextVersion: "", error: "", uploadError: "", announcementError: "", announcementsChecking: false };
  const listeners = new Set();
  function save() { writeJsonAtomic(stateFile, state); }
  function commit(patch) {
    const next = { ...state, ...patch };
    writeJsonAtomic(stateFile, next);
    Object.assign(state, next);
  }
  function saveQueue() { writeJsonAtomic(queueFile, queue); }
  function status() {
    const announcements = state.announcements.map((item) => {
      const manifest = JSON.parse(item.envelope.payload);
      return { sequence: item.sequence, version: manifest.version, notes: manifest.notes, publishedAt: manifest.publishedAt || "", read: item.read };
    });
    return { ...view, enabled: Boolean(network), version, channel: config?.channel || "", consent: state.consent, queued: queue.length,
      lastUpload: state.lastUpload, canInstall: canInstall(), announcements, unreadAnnouncements: announcements.filter((item) => !item.read).length,
      lastAnnouncementsCheck: state.lastAnnouncementsCheck };
  }
  function notify(patch = {}) { view = { ...view, ...patch }; for (const listener of listeners) { try { listener(status()); } catch {} } }
  save();
  function readLatest() {
    if (latestRequest) return latestRequest;
    latestRequest = (async () => {
      const envelope = await network.request(`/v1/releases/${config.channel}/latest`);
      if (stopped) fail("cloud_stopped");
      if (envelope.empty === true) {
        commit({ lastAnnouncementsCheck: new Date().toISOString() }); notify({ announcementError: "" }); return null;
      }
      const manifest = verifyManifest(envelope, config);
      if (manifest.sequence < state.sequence) fail("cloud_release_rollback");
      const newerRelease = manifest.sequence > state.sequence;
      const prior = state.announcements.find((item) => item.sequence === manifest.sequence);
      if (prior && prior.envelope.payload !== envelope.payload) fail("cloud_release_conflict");
      commit({ sequence: manifest.sequence,
        announcements: [{ sequence: manifest.sequence, envelope, read: prior?.read === true }, ...state.announcements.filter((item) => item.sequence !== manifest.sequence)]
          .sort((left, right) => right.sequence - left.sequence).slice(0, 20),
        lastAnnouncementsCheck: new Date().toISOString() });
      notify({ announcementError: "", ...(newerRelease && view.stage === "ready" ? { stage: "idle", progress: 0, nextVersion: "" } : {}) });
      return { envelope, manifest };
    })().finally(() => { latestRequest = null; });
    return latestRequest;
  }
  async function refreshAnnouncements() {
    if (!network || stopped) return status();
    notify({ announcementsChecking: true, announcementError: "" });
    try { await readLatest(); }
    catch { if (!stopped) notify({ announcementError: "公告暂时刷新失败，已保留本机记录。" }); }
    finally { notify({ announcementsChecking: false }); }
    return status();
  }
  function markAnnouncementRead(sequence) {
    if (!Number.isSafeInteger(sequence)) return status();
    const item = state.announcements.find((candidate) => candidate.sequence === sequence);
    if (item && !item.read) {
      try {
        commit({ announcements: state.announcements.map((candidate) => candidate.sequence === sequence ? { ...candidate, read: true } : candidate) });
        notify({ announcementError: "" });
      } catch { notify({ announcementError: "已读状态暂未保存，请稍后重试。" }); }
    }
    return status();
  }
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
      const release = await readLatest();
      if (!release) { notify({ stage: "current" }); return status(); }
      const { envelope, manifest } = release;
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
        if (manifest.sequence < state.sequence) fail("cloud_release_superseded");
        fs.renameSync(temporary, destination); temporary = undefined;
      }
      if (stopped) fail("cloud_stopped");
      if (manifest.sequence < state.sequence) fail("cloud_release_superseded");
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
    announcementTimer = setInterval(() => void refreshAnnouncements(), 30 * 60_000); announcementTimer.unref?.();
    uploadTimer = setInterval(() => void flush(), 15_000); uploadTimer.unref?.();
  }
  function stop() { stopped = true; clearInterval(checkTimer); clearInterval(uploadTimer); clearInterval(announcementTimer); unsubscribe?.(); network?.close(); }
  return { status, check, refreshAnnouncements, markAnnouncementRead, flush, enqueue, setConsent, start, stop, prepareInstall, installOnExit,
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { createCloudMaintenance, fileHash };
