const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createTransport } = require("./cloud-transport.cjs");
const { compareVersions, fail, token, UUID, VERSION, verifyManifest } = require("../shared/cloud-contract.cjs");
const { reportEntry } = require("../shared/cloud-report.cjs");
const { verifyComponentManifest, assertCompatible, hashFile: fileHash } = require("../shared/component-contract.cjs");
const { createComponentStore } = require("./component-store.cjs");
const componentPaths = require("./component-paths.cjs");
const { bundledAnnouncements } = require("../shared/customer-release-notes.cjs");
const { updateFailure, formatUpdateFailure } = require("./update-storage.cjs");
const { retainArtifacts, retryArtifacts } = require("../shared/artifact-retention.cjs");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function announcementId(manifest) { return `${manifest.schema}:${manifest.sequence}`; }
function createCloudMaintenance({ rootDir, config, version, buildId, logger, canInstall = () => false, transport, launch = spawn,
  componentBaseRoot, userData, getLicenseStatus = () => null }) {
  const dir = path.join(rootDir, "cloud-maintenance");
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json");
  const queueFile = path.join(dir, "outbox.json");
  const saved = readJson(stateFile, {});
  // Display-only bundled text; never add an unsigned entry to trusted update state.
  let installedAnnouncements = [];
  try { installedAnnouncements = bundledAnnouncements(version); } catch {}
  const state = {
    installId: UUID.test(saved.installId || "") ? saved.installId : crypto.randomUUID(),
    consent: saved.consent === true, sequence: Number.isSafeInteger(saved.sequence) && saved.sequence >= 0 ? saved.sequence : 0,
    lastUpload: typeof saved.lastUpload === "string" ? saved.lastUpload : "", pending: saved.pending || null,
    announcements: [],
    readAnnouncementVersions: Array.isArray(saved.readAnnouncementVersions) ? saved.readAnnouncementVersions.filter(value => typeof value === "string").slice(-100) : [],
    lastAnnouncementsCheck: typeof saved.lastAnnouncementsCheck === "string" ? saved.lastAnnouncementsCheck : "",
    componentSequence: Number.isSafeInteger(saved.componentSequence) ? saved.componentSequence : 0
  };
  if (saved.bridgeTarget && saved.pending && !saved.pending.kind) {
    try {
      const installer = verifyManifest(saved.pending, config);
      const target = verifyComponentManifest(saved.bridgeTarget.envelope, config);
      if (saved.bridgeTarget.installerSha256 === installer.sha256
          && require("../shared/component-contract.cjs").supportsComponentBridge(installer, target)) {
        state.bridgeTarget = saved.bridgeTarget;
      }
    } catch { /* An untrusted bridge hint must not survive into install state. */ }
  }
  for (const item of [...(Array.isArray(saved.announcements) ? saved.announcements.slice(0, 20) : []), ...(saved.pending ? [{ envelope: saved.pending, read: false }] : [])]) {
    try {
      const manifest = JSON.parse(item.envelope.payload).schema === 2 ? verifyComponentManifest(item.envelope, config) : verifyManifest(item.envelope, config);
      if (manifest.schema === 2) state.componentSequence = Math.max(state.componentSequence, manifest.sequence);
      else state.sequence = Math.max(state.sequence, manifest.sequence);
      const id = announcementId(manifest);
      if (!state.announcements.some((entry) => entry.id === id)) state.announcements.push({ id, sequence: manifest.sequence, envelope: item.envelope, read: item.read === true });
    } catch {}
  }
  state.announcements.sort((left, right) => right.sequence - left.sequence);
  state.announcements = state.announcements.slice(0, 20);
  const network = transport || (config?.enabled ? createTransport(config) : null);
  // Release routing uses only technical capabilities. Do not attach install IDs,
  // profile paths or account data, and continue verifying every returned envelope.
  const releaseHeaders = { "X-Xiaoxi-Update-Protocol": "5",
    ...(require("../shared/update-capabilities.json").protocol >= 4 ? { "X-Xiaoxi-Bridge-Update": "1" } : {}) };
  if (VERSION.test(version)) releaseHeaders["X-Xiaoxi-Version"] = version;
  const baseline = componentBaseRoot && readJson(path.join(componentBaseRoot, "component-base.json"));
  if (baseline?.schema === 2 && VERSION.test(baseline.base?.version) && /^[a-f0-9]{64}$/.test(baseline.base?.fingerprint)) {
    releaseHeaders["X-Xiaoxi-Base-Version"] = baseline.base.version;
    releaseHeaders["X-Xiaoxi-Base-Fingerprint"] = baseline.base.fingerprint;
  }
  let queue = readJson(queueFile, []);
  if (!Array.isArray(queue)) queue = [];
  queue = queue.filter((item) => item?.report?.appId === config?.appId).slice(-200);
  if (!state.consent) queue = [];
  let checking = false, uploading = false, stopped = false, unsubscribe, updateLaunching = false;
  let retryAt = 0, attempts = 0, checkTimer, uploadTimer, announcementTimer, latestRequest, latestComponentRequest;
  let view = { stage: network ? "idle" : "disabled", progress: 0, downloadedBytes: 0, totalBytes: 0, nextVersion: "", error: "", uploadError: "", announcementError: "", announcementsChecking: false };
  const listeners = new Set();
  function save() { writeJsonAtomic(stateFile, state); }
  function commit(patch) {
    const next = { ...state, ...patch };
    writeJsonAtomic(stateFile, next);
    Object.assign(state, next);
  }
  function saveQueue() { writeJsonAtomic(queueFile, queue); }
  function status() {
    const byVersion = new Map();
    for (const item of state.announcements) {
      const manifest = JSON.parse(item.envelope.payload);
      const existing = byVersion.get(manifest.version);
      const read = item.read || state.readAnnouncementVersions.includes(manifest.version);
      if (existing) { existing.read ||= read; continue; }
      byVersion.set(manifest.version, { id: item.id, sequence: item.sequence, version: manifest.version,
        notes: manifest.notes, publishedAt: manifest.publishedAt || "", read });
    }
    for (const entry of installedAnnouncements) if (!byVersion.has(entry.version)) byVersion.set(entry.version, {
      id: `installed:${entry.version}`, sequence: 0, ...entry, publishedAt: "",
      read: state.readAnnouncementVersions.includes(entry.version)
    });
    const announcements = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)).slice(0, 20);
    const selection = userData ? readJson(componentPaths.updatePaths(userData).selection, {}) : {};
    return { ...view, lastUpdate: selection.lastUpdate || null, updateFailure: selection.failure || "", enabled: Boolean(network), version, channel: config?.channel || "", consent: state.consent, queued: queue.length,
      lastUpload: state.lastUpload, canInstall: canInstall(), announcements, unreadAnnouncements: announcements.filter((item) => !item.read).length,
      lastAnnouncementsCheck: state.lastAnnouncementsCheck };
  }
  function notify(patch = {}) { view = { ...view, ...patch }; for (const listener of listeners) { try { listener(status()); } catch {} } }
  function fullDownloadPaths(manifest) {
    const installer = path.join(dir, manifest.sha256 + ".exe"), partial = path.join(dir, manifest.sha256 + ".part");
    return [installer, installer + ".verified.json", partial, partial + ".verified.json"];
  }
  function fullRetentionOptions() {
    const helperActive = userData && require("./update-helper.cjs").hasLiveUpdateHelper(componentPaths.updatePaths(userData).directory);
    const busy = updateLaunching || view.updateRequested === true || helperActive;
    return { deferCleanup: busy ? "active_update" : false };
  }
  function retainFullDownload(manifest, ready, owned = []) {
    return retainArtifacts(dir, ready ? "full-ready-downloads" : "full-downloading-downloads",
      fullDownloadPaths(manifest).slice(0, ready ? 2 : 4), 1, owned, fullRetentionOptions());
  }
  function protectPendingFullDownload() {
    if (!state.pending || state.pending.kind) return;
    let manifest;
    try { manifest = verifyManifest(state.pending, config); } catch { return; }
    // Do this before any branch replaces pending. A prior ready-registration
    // failure may have left this complete candidate protected only as downloading.
    if (!retainFullDownload(manifest, true)) fail("update_cache_registration_failed");
  }
  save();
  function readLatest() {
    if (latestRequest) return latestRequest;
    latestRequest = (async () => {
      const envelope = await network.request(`/v1/releases/${config.channel}/latest`, { headers: releaseHeaders });
      if (stopped) fail("cloud_stopped");
      if (envelope.empty === true) {
        commit({ lastAnnouncementsCheck: new Date().toISOString() }); notify({ announcementError: "" }); return null;
      }
      const manifest = verifyManifest(envelope, config);
      if (manifest.sequence < state.sequence) fail("cloud_release_rollback");
      const newerRelease = manifest.sequence > state.sequence;
      const id = announcementId(manifest);
      const prior = state.announcements.find((item) => item.id === id);
      if (prior && prior.envelope.payload !== envelope.payload) fail("cloud_release_conflict");
      commit({ sequence: manifest.sequence,
        announcements: [{ id, sequence: manifest.sequence, envelope, read: prior?.read === true }, ...state.announcements.filter((item) => item.id !== id)]
          .sort((left, right) => right.sequence - left.sequence).slice(0, 20),
        lastAnnouncementsCheck: new Date().toISOString() });
      notify({ announcementError: "", ...(newerRelease && view.stage === "ready" ? { stage: "idle", progress: 0, nextVersion: "" } : {}) });
      return { envelope, manifest };
    })().finally(() => { latestRequest = null; });
    return latestRequest;
  }
  function readLatestComponents() {
    if (!componentBaseRoot || !fs.existsSync(path.join(componentBaseRoot, "component-base.json"))) return Promise.resolve(null);
    if (latestComponentRequest) return latestComponentRequest;
    latestComponentRequest = (async () => {
      let envelope;
      try { envelope = await network.request(`/v2/releases/${config.channel}/latest`, { headers: releaseHeaders }); }
      catch (error) { if (error?.status === 404 || error?.statusCode === 404 || error?.code === "cloud_http_404") return null; throw error; }
      if (stopped) fail("cloud_stopped");
      if (envelope.empty) return null;
      const manifest = verifyComponentManifest(envelope, config);
      if (manifest.sequence < state.componentSequence) fail("cloud_release_rollback");
      const newerRelease = manifest.sequence > state.componentSequence;
      const id = announcementId(manifest);
      const prior = state.announcements.find(item => item.id === id);
      if (prior && prior.envelope.payload !== envelope.payload) fail("cloud_release_conflict");
      commit({ componentSequence: manifest.sequence,
        announcements: [{ id, sequence: manifest.sequence, envelope, read: prior?.read === true }, ...state.announcements.filter(item => item.id !== id)].sort((a, b) => b.sequence - a.sequence).slice(0, 20),
        lastAnnouncementsCheck: new Date().toISOString() });
      notify({ announcementError: "", ...(newerRelease && view.stage === "ready" ? { stage: "idle", progress: 0, nextVersion: "" } : {}) });
      return { envelope, manifest };
    })().finally(() => { latestComponentRequest = null; });
    return latestComponentRequest;
  }
  async function refreshAnnouncements() {
    if (!network || stopped) return status();
    notify({ announcementsChecking: true, announcementError: "" });
    try { await Promise.all([readLatest(), readLatestComponents()]); }
    catch { if (!stopped) notify({ announcementError: "公告暂时刷新失败，已保留本机记录。" }); }
    finally { notify({ announcementsChecking: false }); }
    return status();
  }
  function markAnnouncementRead(key) {
    const id = Number.isSafeInteger(key) ? `1:${key}` : key;
    const stored = state.announcements.find(candidate => candidate.id === id);
    const storedVersion = stored ? JSON.parse(stored.envelope.payload).version : "";
    const item = status().announcements.find((candidate) => candidate.id === id || candidate.version === storedVersion);
    if (item && !item.read) {
      try {
        commit({ readAnnouncementVersions: [...new Set([...state.readAnnouncementVersions, item.version])].slice(-100),
          announcements: state.announcements.map((candidate) => JSON.parse(candidate.envelope.payload).version === item.version ? { ...candidate, read: true } : candidate) });
        notify({ announcementError: "" });
      } catch { notify({ announcementError: "已读状态暂未保存，请稍后重试。" }); }
    }
    return status();
  }
  function markAnnouncementsRead() {
    const unreadVersions = status().announcements.filter((item) => !item.read).map((item) => item.version);
    if (!unreadVersions.length) return status();
    try {
      const readVersions = [...new Set([...state.readAnnouncementVersions, ...unreadVersions])].slice(-100);
      const readSet = new Set(readVersions);
      commit({
        readAnnouncementVersions: readVersions,
        announcements: state.announcements.map((candidate) => {
          const candidateVersion = JSON.parse(candidate.envelope.payload).version;
          return readSet.has(candidateVersion) ? { ...candidate, read: true } : candidate;
        })
      });
      notify({ announcementError: "" });
    } catch { notify({ announcementError: "已读状态暂未保存，请稍后重试。" }); }
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
    if (!network || checking || stopped || view.updateRequested) return status();
    checking = true; notify({ stage: "checking", error: "" });
    let temporary, fullUpgradeRequired = false;
    try {
      // Drain before replacing an identity within a retention category. This
      // avoids depending on UUID order when requests share a millisecond.
      if (!retryArtifacts(dir, fullRetentionOptions())) fail("update_cache_registration_failed");
      protectPendingFullDownload();
      const [release, componentRelease] = await Promise.all([readLatest(), readLatestComponents()]);
      if (componentRelease && (!release || compareVersions(componentRelease.manifest.version, release.manifest.version) >= 0)) {
          let { envelope } = componentRelease;
          const { manifest } = componentRelease;
          if (compareVersions(manifest.version, version) > 0) {
            try { assertCompatible(manifest, readJson(path.join(componentBaseRoot, "component-base.json"))); }
            catch (error) { if (error.code !== "full_upgrade_required" && error.message !== "full_upgrade_required") throw error; envelope = null; fullUpgradeRequired = true; }
            if (envelope) {
              const paths = componentPaths.updatePaths(userData);
              notify({ stage: "preparing", nextVersion: manifest.version, downloadedBytes: 0, totalBytes: 0 });
              let lastPhase = "", lastProgressAt = 0;
              const prepared = await createComponentStore({ rootDir: paths.directory, baseRoot: componentBaseRoot, config, transport: network,
                onMeasure: measurement => {
                  try { logger?.event?.("maintenance", "update.phase", { phase: measurement.phase, bytes: measurement.bytes, entries: measurement.files },
                    { durationMs: measurement.durationMs, phase: measurement.phase, trace: true }); } catch { /* Diagnostics cannot block an update. */ }
                },
                onProgress: progress => {
                  if (stopped) fail("cloud_stopped");
                  const now = Date.now();
                  if (progress.phase === lastPhase && now - lastProgressAt < 100 && progress.phase !== "ready") return;
                  lastPhase = progress.phase; lastProgressAt = now;
                  notify({ stage: progress.phase === "download" ? "downloading" : progress.phase === "ready" ? "ready" : "verifying",
                  downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes,
                  progress: progress.totalBytes ? Math.floor(progress.downloadedBytes / progress.totalBytes * 100) : 0 });
                } }).prepare(envelope);
              if (stopped) fail("cloud_stopped");
              if (manifest.sequence < state.componentSequence) fail("cloud_release_superseded");
              commit({ pending: { kind: "components", envelope, generationRoot: prepared.generationRoot } });
              notify({ stage: "ready", progress: 100 }); return status();
            }
          }
      }
      if (!release) { if (fullUpgradeRequired) fail("full_upgrade_required"); commit({ pending: null }); notify({ stage: "current", nextVersion: "" }); return status(); }
      const { envelope, manifest } = release;
      const bridge = fullUpgradeRequired && componentRelease && compareVersions(manifest.version, componentRelease.manifest.version) < 0;
      if (bridge && !require("../shared/component-contract.cjs").supportsComponentBridge(manifest, componentRelease.manifest)) fail("full_upgrade_required");
      if (compareVersions(manifest.version, version) <= 0) {
        if (fullUpgradeRequired) fail("full_upgrade_required");
        state.pending = null; save(); notify({ stage: "current", nextVersion: "" }); return status();
      }
      const destination = path.join(dir, `${manifest.sha256}.exe`);
      // Claim only absent paths, before proof creation or network writes. Merely
      // using an older installer/partial never transfers deletion ownership.
      const created = fullDownloadPaths(manifest).filter(file => !fs.existsSync(file));
      if (!retainFullDownload(manifest, false, created)) fail("update_cache_registration_failed");
      notify({ stage: "downloading", nextVersion: manifest.version, progress: 0, downloadedBytes: 0, totalBytes: manifest.size });
      const { verifyDownload } = require("./download-verification.cjs");
      let existing = false;
      try { await verifyDownload(destination, manifest); existing = true; } catch { /* Missing or changed download must be fetched. */ }
      if (!existing) {
        const free = fs.statfsSync(dir);
        if (free.bavail * free.bsize < manifest.size * 2 + 256 * 1024 ** 2) fail("cloud_disk_full");
        temporary = path.join(dir, `${manifest.sha256}.part`);
        let lastProgress = -1;
        const download = await network.request(manifest.file, { destination: temporary, expected: manifest, maxBytes: manifest.size, resume: true,
          onProgress: (size) => {
            const progress = Math.floor(size / manifest.size * 100);
            if (progress !== lastProgress) { lastProgress = progress; notify({ progress, downloadedBytes: size }); }
          } });
        if (stopped) fail("cloud_stopped");
        if (manifest.sequence < state.sequence) fail("cloud_release_superseded");
        const proof = await verifyDownload(temporary, manifest, { proof: download?.verification });
        notify({ stage: "verifying" }); fs.renameSync(temporary, destination); temporary = undefined;
        await verifyDownload(destination, manifest, { proof });
        fs.rmSync(path.join(dir, `${manifest.sha256}.part.verified.json`), { force: true });
      }
      if (stopped) fail("cloud_stopped");
      if (manifest.sequence < state.sequence) fail("cloud_release_superseded");
      commit({ pending: envelope,
        bridgeTarget: bridge ? { envelope: componentRelease.envelope, installerSha256: manifest.sha256 } : null });
      // Keep the downloading reference until the next candidate. If this ready
      // write fails, saved pending repairs it before that reference can change.
      retainFullDownload(manifest, true);
      notify({ stage: "ready", progress: 100 });
    } catch (error) {
      try { logger?.event?.("maintenance", "update.failed", { stage: view.stage }, {
        level: "error", code: updateFailure(error, "prepare").code, phase: "check"
      }); } catch {}
      const message = ["cloud_disk_full", "component_disk_space_insufficient", "ENOSPC"].includes(error?.code) ? "磁盘空间不足，请释放空间后重试。"
        : error?.code === "full_upgrade_required" ? "新版正在准备，请稍后重试。故障编号：full_upgrade_required"
        : error?.code === "cloud_signature_invalid" ? "更新签名校验失败，未安装此更新。请稍后重新检查。" : "更新检查或下载失败，已保留下载进度，请稍后重试。";
      notify({ stage: "error", error: message });
    } finally {
      // Keep the hash-addressed partial file for a verified Range resume.
      checking = false;
    }
    return status();
  }
  async function prepareInstall() {
    if (stopped || checking || !state.pending || !canInstall()) return null;
    const authorization = getLicenseStatus();
    if (["license_decryption_failed", "license_read_failed", "secure_storage_unavailable", "license_recovery_backup_failed"].includes(authorization?.code)) {
      notify({ stage: "blocked", error: authorization.error || "请先恢复本机授权读取，再安装更新。原数据仍保留。" });
      return null;
    }
    if (state.pending.kind === "components") {
      const manifest = verifyComponentManifest(state.pending.envelope, config);
      if ((!view.updateRequested && manifest.sequence < state.componentSequence) || compareVersions(manifest.version, version) <= 0) return null;
      return { ...state.pending, version: manifest.version };
    }
    const m = verifyManifest(state.pending, config);
    if ((!view.updateRequested && m.sequence < state.sequence) || compareVersions(m.version, version) <= 0) return null;
    const file = path.join(dir, `${m.sha256}.exe`);
    await require("./download-verification.cjs").verifyDownload(file, m);
    const finalTarget = state.bridgeTarget?.installerSha256 === m.sha256
      ? verifyComponentManifest(state.bridgeTarget.envelope, config) : null;
    return { kind: "full", file, version: m.version, envelope: state.pending,
      ...(finalTarget && require("../shared/component-contract.cjs").supportsComponentBridge(m, finalTarget)
        ? { finalTargetVersion: finalTarget.version } : {}) };
  }
  async function beginInstall() {
    if (updateLaunching || !userData) return false;
    updateLaunching = true;
    let phase = "prepare";
    let launchedJobFile;
    try {
      const prepared = await prepareInstall();
      if (!prepared) return false;
      notify({ stage: "preparing", error: "" });
      phase = "helper";
      const { file, job } = await require("./update-helper.cjs").createUpdateJob({ userData, prepared, currentVersion: version, channel: config.channel });
      launchedJobFile = file;
      phase = "launch";
      await new Promise((resolve, reject) => {
        // This Electron helper owns the user-visible update progress window.
        const child = launch(job.helperExecutable, ["--xiaoxi-update-job", file], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(job.helperExecutable) });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      phase = "ready";
      const ready = path.join(path.dirname(file), job.id + ".ready.json"), deadline = Date.now() + 30000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      if (!fs.existsSync(ready)) fail("update_helper_not_ready");
      notify({ stage: "waiting", error: "" });
      require("./update-helper.cjs").authorizeUpdateJob(file, job);
      return true;
    } catch (error) {
      if (launchedJobFile) {
        try { require("./update-helper.cjs").revokeUpdateJob(launchedJobFile); } catch { /* Without a commit, a late helper cannot install. */ }
      }
      const failure = updateFailure(error, phase);
      // Diagnostics may share the failing disk. Never let their write hide the cause or permit app exit.
      try { logger?.event?.("maintenance", "update.failed", { stage: failure.phase }, {
        level: "error", code: failure.code, phase: failure.phase
      }); } catch {}
      notify({ stage: "error", error: formatUpdateFailure(failure) });
      return false;
    }
    finally { updateLaunching = false; }
  }
  function installOnExit() { return false; }
  function setUpdateRequest(requested, waitingReason = "") {
    let stage = requested ? "waiting" : view.stage === "waiting" ? "ready" : view.stage;
    if (!requested && stage === "ready" && state.pending) {
      const pending = JSON.parse((state.pending.envelope || state.pending).payload);
      if (pending.sequence < (state.pending.kind === "components" ? state.componentSequence : state.sequence)) stage = "idle";
    }
    notify({ updateRequested: requested, waitingReason, stage }); return status();
  }
  function setInstallBlocked(message) { notify({ stage: "ready", error: message }); return status(); }
  // Launch update gate state (update-launch-gate.cjs), shown full screen by the renderer.
  function setLaunchGate(launchGate) { notify({ launchGate }); return status(); }
  function acknowledgeUpdate() {
    if (userData) { const paths = componentPaths.updatePaths(userData), selected = readJson(paths.selection, {});
      if (selected.lastUpdate) componentPaths.saveSelection(paths, { ...selected, lastUpdate: { ...selected.lastUpdate, unread: false } }); }
    notify(); return status();
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
  function stop() { stopped = true; clearInterval(checkTimer); clearInterval(uploadTimer); clearInterval(announcementTimer); unsubscribe?.(); network?.close(); retryArtifacts(dir, fullRetentionOptions()); }
  return { status, check, refreshAnnouncements, markAnnouncementRead, markAnnouncementsRead, flush, enqueue, setConsent, start, stop, prepareInstall, installOnExit, beginInstall, setUpdateRequest, setInstallBlocked, setLaunchGate, acknowledgeUpdate, refreshLocalState: () => notify(),
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { createCloudMaintenance, fileHash };
