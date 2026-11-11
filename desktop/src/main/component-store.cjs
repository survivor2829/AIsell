// Electron's patched fs treats *.asar as directories. Verify physical archive
// bytes just like the Node build tool, without entering virtual ASAR contents.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform, Writable } = require("node:stream");
const JSZip = require("jszip");
const { fail, token } = require("../shared/cloud-contract.cjs");
const { retainComponentArtifacts } = require("./update-retention.cjs");
const { componentsFor, safePath, hashFile, treeHash, validateFiles, verifyComponentManifest, assertCompatible, digest } = require("../shared/component-contract.cjs");
const { verifyDownload } = require("./download-verification.cjs");
// The application already holds its single-instance lock; also reject two stores
// preparing the same root concurrently within that process.
const preparingRoots = new Set();
async function readJson(file) { return JSON.parse(await fsp.readFile(file, "utf8")); }
async function checkedFile(root, relative, directories = new Map()) {
  safePath(relative);
  let current = path.resolve(root);
  async function directory(full) {
    if (!directories.has(full)) directories.set(full, fsp.lstat(full).then(stat => {
      if (stat.isSymbolicLink()) fail("component_symlink_forbidden");
      if (!stat.isDirectory()) fail("component_file_type_invalid");
    }));
    await directories.get(full);
  }
  await directory(current);
  const parts = relative.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    await directory(current);
  }
  const full = path.join(current, parts.at(-1)), stat = await fsp.lstat(full);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("component_file_type_invalid");
  return { full, stat };
}
async function regularFile(root, relative) {
  return (await checkedFile(root, relative)).full;
}
async function verifyFiles(root, files) {
  // Cache only directory checks within this verification, never file hashes or
  // trust across launches. Four readers bound memory and disk pressure while
  // avoiding one round trip per ancestor for every file in the same directory.
  const directories = new Map();
  let next = 0, failure;
  async function worker() {
    while (!failure && next < files.length) {
      const file = files[next++];
      try {
        const { full, stat } = await checkedFile(root, file.path, directories);
        if (stat.size !== file.size || await hashFile(full) !== file.sha256) fail("component_file_corrupt");
      } catch (error) { failure ||= error; }
    }
  }
  // Drain all in-flight readers before rejection; callers may remove a failed
  // staging directory as soon as verification settles.
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, () => worker()));
  if (failure) throw failure;
}
async function verifyStructure(root, files, group) {
  validateFiles(files);
  const { groupForPath } = require("../shared/component-verification.cjs");
  const selected = group ? files.filter(file => groupForPath(file.path) === group) : files;
  const expected = new Set([...selected.map(f => f.path), "component-base.json", "component-complete.json"]);
  const directories = new Set();
  for (const file of selected) {
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  async function walk(directory, prefix = "") {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (group && entry.isDirectory() && !directories.has(relative)
          && (group !== "startup" || groupForPath(relative + "/") !== "startup")) continue;
      if (group && !entry.isDirectory() && !["component-base.json", "component-complete.json"].includes(relative)
          && groupForPath(relative) !== group) continue;
      if (entry.isSymbolicLink()) fail("component_symlink_forbidden");
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + "/");
      else if (!entry.isFile() || !expected.delete(relative)) fail("component_generation_invalid");
    }
  }
  await walk(root);
  if (expected.size) fail("component_generation_invalid");
  const checkedDirectories = new Map();
  for (const file of selected) {
    if ((await checkedFile(root, file.path, checkedDirectories)).stat.size !== file.size) fail("component_file_corrupt");
  }
}
// Presence and size only (as copyVerified checks); contents are hashed later.
async function componentFilesPresent(root, files) {
  const directories = new Map();
  try {
    for (const file of files) {
      if ((await checkedFile(root, file.path, directories)).stat.size !== file.size) return false;
    }
    return true;
  } catch { return false; }
}
async function verifyGeneration(root, files, group) {
  await verifyStructure(root, files, group);
  const { groupForPath } = require("../shared/component-verification.cjs");
  await verifyFiles(root, group ? files.filter(file => groupForPath(file.path) === group) : files);
}
function inspectZip(buffer, expectedCount) {
  // JSZip normalizes paths and collapses duplicate central-directory names.
  // Check the original directory first so neither can hide an unsafe entry.
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50 && at + 22 + buffer.readUInt16LE(at + 20) === buffer.length) { end = at; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
      || buffer.readUInt16LE(end + 8) !== expectedCount || buffer.readUInt16LE(end + 10) !== expectedCount) fail("component_archive_directory_invalid");
  const length = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (start + length !== end) fail("component_archive_directory_invalid");
  let at = start; const seen = new Set();
  for (let i = 0; i < expectedCount; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) fail("component_archive_directory_invalid");
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10);
    const nameSize = buffer.readUInt16LE(at + 28), extraSize = buffer.readUInt16LE(at + 30), commentSize = buffer.readUInt16LE(at + 32);
    const next = at + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 1 || ![0, 8].includes(method) || buffer.readUInt16LE(at + 34)) fail("component_archive_directory_invalid");
    const nameBytes = buffer.subarray(at + 46, at + 46 + nameSize);
    const name = nameBytes.toString("utf8");
    if (!(flags & 0x800) && nameBytes.some(n => n > 127)) fail("component_archive_filename_invalid");
    if (!Buffer.from(name).equals(nameBytes)) fail("component_archive_filename_invalid");
    safePath(name);
    if (seen.has(name.toLowerCase())) fail("component_archive_duplicate");
    seen.add(name.toLowerCase());
    at = next;
  }
  if (at !== end) fail("component_archive_directory_invalid");
}
// Name the file when the running program (installed base or current generation) is incomplete,
// e.g. quarantined by security software. Retrying the download never repairs it; reinstalling
// the same base does (a full install resets the component selection to the installed program).
function baseFileFailure(code, file) { throw Object.assign(new Error(code), { code, path: file.path }); }
async function copyVerified(sourceRoot, targetRoot, file) {
  let checked;
  try { checked = await checkedFile(sourceRoot, file.path); }
  catch (error) { if (error?.code === "ENOENT") baseFileFailure("component_base_file_missing", file); throw error; }
  const { full: source, stat } = checked;
  if (stat.size !== file.size) baseFileFailure("component_base_file_damaged", file);
  const target = path.join(targetRoot, safePath(file.path));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Hardlink only immutable generations/base; updater never edits linked files in place.
  try { await fsp.link(source, target); }
  catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EMLINK"].includes(error.code)) throw error;
    const hash = crypto.createHash("sha256"); let size = 0;
    await pipeline(fs.createReadStream(source), new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length; hash.update(chunk); callback(null, chunk);
    } }), fs.createWriteStream(target, { flags: "wx" }));
    if (size !== file.size || hash.digest("hex") !== file.sha256) fail("component_file_corrupt");
  }
}
function retryableDownloadError(error) {
  const code = String(error?.code || error?.message || "");
  return /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|cloud_timeout|cloud_slow|cloud_download_invalid|cloud_http_408|cloud_http_425|cloud_http_429|cloud_http_5\d\d)$/u.test(code);
}
// Below 32 KB/s for 15 s the connection is replaced. Only twice per file: a line that is
// simply slow keeps downloading after that instead of reconnecting forever.
const SLOW_CONNECTION = { bytesPerSecond: 32 * 1024, windowMs: 15_000 }, SLOW_RECONNECTS = 2;
async function partialSize(file) { try { return (await fsp.stat(file)).size; } catch { return 0; } }
// Field 2026-11: an update crawled until the customer closed and reopened the app, which
// resumed on a fresh connection and finished at once. Do the same here: reconnect and resume
// right away while each attempt adds bytes; give up after three attempts in a row add none.
async function downloadArchive(transport, route, options, { onReconnect, slow = SLOW_CONNECTION } = {}) {
  const reconnects = { slow: 0, stall: 0, other: 0 }, started = performance.now();
  const resumedBytes = await partialSize(options.destination);
  let size = resumedBytes, idle = 0;
  const summary = () => ({ reconnects, resumedBytes, transferredBytes: Math.max(0, size - resumedBytes), durationMs: Math.round(performance.now() - started) });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await transport.request(route, { ...options, ...(slow && reconnects.slow < SLOW_RECONNECTS ? { minSpeed: slow } : {}) });
      size = options.expected?.size ?? size;
      return { ...result, download: summary() };
    } catch (error) {
      const now = await partialSize(options.destination);
      idle = now > size ? 0 : idle + 1; size = now;
      if (idle > 2 || attempt >= 30 || !retryableDownloadError(error)) throw Object.assign(error, { download: summary() });
      const code = String(error?.code || error?.message || "");
      reconnects[code === "cloud_slow" ? "slow" : code === "cloud_timeout" ? "stall" : "other"]++;
      onReconnect?.(reconnects);
      await new Promise((resolve) => setTimeout(resolve, 250 * (idle + 1)));
    }
  }
}
async function unpack(archive, root, component) {
  await verifyDownload(archive, component);
  const buffer = await fsp.readFile(archive);
  inspectZip(buffer, component.fileCount + 1);
  const zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
  const entries = Object.values(zip.files);
  if (entries.length !== component.fileCount + 1) fail("component_archive_entries_invalid");
  for (const entry of entries) {
    if (entry.dir || entry.unsafeOriginalName !== entry.name || (entry.unixPermissions && (entry.unixPermissions & 0o170000) !== 0o100000)) fail("component_archive_entry_invalid");
    safePath(entry.name);
  }
  const index = zip.file("component.json");
  if (!index || index._data.uncompressedSize > 16 * 1024 ** 2) fail("component_index_invalid");
  const chunks = []; let indexSize = 0;
  await pipeline(index.nodeStream(), new Writable({ write(chunk, _encoding, callback) {
    indexSize += chunk.length;
    if (indexSize > 16 * 1024 ** 2) return callback(Error("component_index_invalid"));
    chunks.push(chunk); callback();
  } }));
  const descriptor = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (descriptor.schema !== 2 || descriptor.name !== component.name || descriptor.treeSha256 !== component.treeSha256
      || descriptor.files?.length !== component.fileCount || treeHash(descriptor.files) !== component.treeSha256
      || validateFiles(descriptor.files) !== component.expandedSize) fail("component_index_invalid");
  for (const file of descriptor.files) {
    const entry = zip.file(`files/${file.path}`);
    if (!entry || entry._data.uncompressedSize !== file.size) fail("component_archive_entry_invalid");
    const target = path.join(root, safePath(file.path));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    let size = 0; const hash = crypto.createHash("sha256");
    await pipeline(entry.nodeStream(), new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > file.size) return callback(Error("component_archive_expansion_invalid"));
      hash.update(chunk); callback(null, chunk);
    } }), fs.createWriteStream(target, { flags: "wx" }));
    if (size !== file.size || hash.digest("hex") !== file.sha256) fail("component_file_corrupt");
  }
  return descriptor;
}
function createComponentStore({ rootDir, baseRoot, config, transport, onProgress, onMeasure, onDownload }) {
  rootDir = path.resolve(rootDir); baseRoot = path.resolve(baseRoot);
  if (rootDir === baseRoot || rootDir.startsWith(baseRoot + path.sep)) fail("component_store_inside_base");
  const prepareKey = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  async function prepare(envelope) {
    if (preparingRoots.has(prepareKey)) fail("component_prepare_busy");
    preparingRoots.add(prepareKey);
    const measurements = new Map(), started = performance.now();
    async function measured(phase, action, bytes = 0, files = 0) {
      const before = performance.now();
      try { return await action(); }
      finally {
        const item = measurements.get(phase) || { phase, durationMs: 0, bytes: 0, files: 0 };
        item.durationMs += performance.now() - before; item.bytes += bytes; item.files += files; measurements.set(phase, item);
      }
    }
    function recordPrepared(root) {
      const paths = { directory: rootDir };
      const components = require("./component-paths.cjs");
      const receipt = components.bootVerificationReceipt(paths, root, baseRoot);
      components.recordVerification(paths, receipt, "prepared");
    }
    try {
      const manifest = verifyComponentManifest(envelope, config);
      const names = componentsFor(manifest);
      let baseline;
      try { baseline = await readJson(path.join(baseRoot, "component-base.json")); }
      catch (error) { if (error.code === "ENOENT") fail("full_upgrade_required"); throw error; }
      validateFiles(baseline.files); assertCompatible(manifest, baseline);
      if (baseline.files.some(f => !["base", ...names].includes(f.component))) fail("component_base_invalid");
      await fsp.mkdir(rootDir, { recursive: true });
      if ((await fsp.lstat(rootDir)).isSymbolicLink()) fail("component_symlink_forbidden");
      const archives = path.join(rootDir, "archives"), generations = path.join(rootDir, "generations");
      await fsp.mkdir(archives, { recursive: true }); await fsp.mkdir(generations, { recursive: true });
      for (const directory of [archives, generations]) if ((await fsp.lstat(directory)).isSymbolicLink()) fail("component_symlink_forbidden");
      const targetId = digest(envelope.payload), finalRoot = path.join(generations, targetId);
      // Retire superseded failed downloads, keeping the last ready candidate.
      await retainComponentArtifacts(rootDir, envelope);
      const baseFiles = baseline.files.filter(f => f.component === "base");
      let existing;
      try { existing = await readJson(path.join(finalRoot, "component-complete.json")); } catch { /* no complete target */ }
      if (existing) {
        if (existing.payload !== envelope.payload) fail("component_generation_invalid");
        const full = await readJson(path.join(finalRoot, "component-base.json"));
        assertCompatible(manifest, full); validateFiles(full.files);
        if (full.files.some(f => !["base", ...names].includes(f.component))) fail("component_generation_invalid");
        for (const name of names) if (treeHash(full.files.filter(f => f.component === name)) !== manifest.components[name].treeSha256) fail("component_generation_invalid");
        if (manifest.verification) require("../shared/component-verification.cjs").validatePolicy(manifest.verification, full.files);
        await measured("structure", () => verifyStructure(finalRoot, full.files), 0, full.files.length);
        recordPrepared(finalRoot);
        await retainComponentArtifacts(rootDir, envelope, { ready: true });
        return { generationRoot: finalRoot, version: manifest.version, envelope, downloadedBytes: 0, totalBytes: 0 };
      }
      const disk = await fsp.statfs(rootDir);
      const required = validateFiles(baseFiles) + names.reduce((n, name) => n + manifest.components[name].expandedSize + manifest.components[name].size, 0) + 128 * 1024 ** 2;
      if (Number(disk.bavail) * Number(disk.bsize) < required) fail("component_disk_space_insufficient");
      const staging = await fsp.mkdtemp(path.join(generations, ".prepare-"));
      try {
      await retainComponentArtifacts(rootDir, envelope, { created: [staging], staging });
      let downloadedBytes = 0, totalBytes = 0, copiedBytes = 0, resumedBytes = 0, slowReconnects = 0;
      const reused = new Set(), cached = new Set(), createdMarkers = [];
      for (const name of names) {
        const files = baseline.files.filter(f => f.component === name);
        // An unchanged component is reused only while its files are still in the
        // running program; one removed after install (field 2026-11-07: a
        // content-engine asset vanished after a switch) is downloaded again.
        if (treeHash(files) === manifest.components[name].treeSha256 && await componentFilesPresent(baseRoot, files)) reused.add(name);
        else {
          const component = manifest.components[name];
          try {
            const archive = await regularFile(archives, component.sha256 + ".zip");
            const markerExisted = fs.existsSync(archive + ".verified.json");
            await measured("cache", () => verifyDownload(archive, component), component.size, 1); cached.add(name);
            if (!markerExisted) createdMarkers.push(archive + ".verified.json");
          } catch { /* absent or corrupt complete archive needs a download */ }
          if (!cached.has(name)) totalBytes += component.size;
        }
      }
      if (createdMarkers.length) await retainComponentArtifacts(rootDir, envelope, { created: createdMarkers, staging });
      const progress = phase => onProgress?.({ phase, downloadedBytes, totalBytes, copiedBytes, resumedBytes, slowReconnects });
      progress("prepare");
      const targetFiles = [...baseFiles], descriptors = {};
      for (const file of baseFiles) { await measured("compose", () => copyVerified(baseRoot, staging, file), file.size, 1); copiedBytes += file.size; progress("compose"); }
      for (const name of names) {
        const component = manifest.components[name];
        let descriptor;
        if (reused.has(name)) {
          const files = baseline.files.filter(f => f.component === name).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
          descriptor = { schema: 2, name, treeSha256: component.treeSha256, files };
          for (const file of files) { await measured("compose", () => copyVerified(baseRoot, staging, file), file.size, 1); copiedBytes += file.size; progress("compose"); }
        } else {
          const archive = path.join(archives, component.sha256 + ".zip");
          if (!cached.has(name)) {
            // Corrupt complete archives never become trusted by existence alone.
            const partial = archive + ".part";
            try { if ((await fsp.lstat(partial)).isSymbolicLink()) fail("component_symlink_forbidden"); } catch (e) { if (e.code !== "ENOENT") throw e; }
            try {
              const handle = await fsp.open(partial, "wx");
              await handle.close();
              await retainComponentArtifacts(rootDir, envelope, { created: [partial], staging });
            } catch (e) { if (e.code !== "EEXIST") throw e; }
            const before = downloadedBytes, slowBefore = slowReconnects;
            let resumeCounted = false;
            // Evidence for slow updates: how long this file took, how much was resumed, and why it reconnected.
            const report = (ok, error, summary) => { try { if (summary) onDownload?.({ name, ok, code: ok ? "ok" : token(error?.code, "download_failed"), ...summary }); } catch { /* Diagnostics cannot block an update. */ } };
            let download;
            try {
              download = await measured("download", () => downloadArchive(transport, component.file, { destination: partial, expected: component, maxBytes: component.size, resume: true,
                // The first report of a file is what an earlier attempt left on disk, not bytes fetched now.
                onProgress: bytes => { if (!resumeCounted) { resumeCounted = true; resumedBytes += bytes; } downloadedBytes = before + bytes; progress("download"); } },
              { onReconnect: counts => { slowReconnects = slowBefore + counts.slow; progress("download"); } }), component.size, 1);
            } catch (error) { report(false, error, error?.download); throw error; }
            report(true, null, download.download);
            // Leave the download stage before checking and unpacking, which report no bytes.
            progress("archive");
            const proof = await measured("archive", () => verifyDownload(partial, component, { proof: download?.verification }), component.size, 1);
            await fsp.rename(partial, archive);
            await verifyDownload(archive, component, { proof });
            await fsp.rm(partial + ".verified.json", { force: true });
            await retainComponentArtifacts(rootDir, envelope, { created: [archive, archive + ".verified.json"], staging });
          }
          descriptor = await measured("unpack", () => unpack(archive, staging, component), component.expandedSize, component.fileCount);
        }
        descriptors[name] = descriptor;
        targetFiles.push(...descriptor.files.map(file => ({ ...file, component: name })));
      }
      validateFiles(targetFiles);
      if (manifest.verification) require("../shared/component-verification.cjs").validatePolicy(manifest.verification, targetFiles);
      const full = { schema: 2, updateProtocol: manifest.updateProtocol, base: baseline.base, dataSchema: manifest.dataSchema, files: targetFiles, components: descriptors,
        ...(manifest.verification ? { verification: manifest.verification } : {}) };
      await fsp.writeFile(path.join(staging, "component-base.json"), JSON.stringify(full), { flag: "wx" });
      await fsp.writeFile(path.join(staging, "component-complete.json.tmp"), JSON.stringify(envelope), { flag: "wx" });
      await fsp.rename(path.join(staging, "component-complete.json.tmp"), path.join(staging, "component-complete.json"));
      await measured("structure", () => verifyStructure(staging, targetFiles), 0, targetFiles.length);
      // Persist ownership of the destination before the rename/receipt window.
      // An unknown existing directory is never adopted as an owned candidate.
      try { await fsp.lstat(finalRoot); fail("component_generation_invalid"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await retainComponentArtifacts(rootDir, envelope, { created: [finalRoot], staging });
      if (!require("../shared/artifact-retention.cjs").artifactOwnershipRegistered(rootDir, finalRoot)) fail("component_ownership_record_required");
      require("./atomic-file.cjs").replaceWithRetry(staging, finalRoot);
      recordPrepared(finalRoot);
      await retainComponentArtifacts(rootDir, envelope, { ready: true });
      progress("ready");
      return { generationRoot: finalRoot, version: manifest.version, envelope, downloadedBytes, totalBytes };
      } finally {
        // Keep resumable downloads, but never leave another partial program copy.
        await fsp.rm(staging, { recursive: true, force: true }).catch(error => console.warn(`Component staging cleanup deferred: ${error.code}`));
      }
    } finally {
      preparingRoots.delete(prepareKey);
      try {
        for (const item of measurements.values()) onMeasure?.({ ...item, durationMs: Math.round(item.durationMs) });
        onMeasure?.({ phase: "prepare", durationMs: Math.round(performance.now() - started), bytes: 0, files: 0 });
      } catch { /* Measurement must not change update success or failure. */ }
    }
  }
  return { prepare };
}
module.exports = { createComponentStore, downloadArchive, unpack, verifyFiles, verifyGeneration, verifyStructure };
