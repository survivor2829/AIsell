const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform, Writable } = require("node:stream");
const JSZip = require("jszip");
const { fail } = require("../shared/cloud-contract.cjs");
const { COMPONENTS, safePath, hashFile, treeHash, validateFiles, verifyComponentManifest, assertCompatible, digest } = require("../shared/component-contract.cjs");
async function readJson(file) { return JSON.parse(await fsp.readFile(file, "utf8")); }
async function regularFile(root, relative) {
  safePath(relative);
  let current = path.resolve(root);
  if ((await fsp.lstat(current)).isSymbolicLink()) fail("component_symlink_forbidden");
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) fail("component_file_type_invalid");
  }
  return current;
}
async function verifyFiles(root, files) {
  for (const file of files) {
    const full = await regularFile(root, file.path);
    if ((await fsp.stat(full)).size !== file.size || await hashFile(full) !== file.sha256) fail("component_file_corrupt");
  }
}
async function verifyGeneration(root, files) {
  validateFiles(files);
  const expected = new Set([...files.map(f => f.path), "component-base.json", "component-complete.json"]);
  async function walk(directory, prefix = "") {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) fail("component_symlink_forbidden");
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + "/");
      else if (!entry.isFile() || !expected.delete(relative)) fail("component_generation_invalid");
    }
  }
  await walk(root);
  if (expected.size) fail("component_generation_invalid");
  await verifyFiles(root, files);
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
async function copyVerified(sourceRoot, targetRoot, file) {
  const source = await regularFile(sourceRoot, file.path);
  if ((await fsp.stat(source)).size !== file.size || await hashFile(source) !== file.sha256) fail("component_file_corrupt");
  const target = path.join(targetRoot, safePath(file.path));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Hardlink only immutable generations/base; updater never edits linked files in place.
  try { await fsp.link(source, target); }
  catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EMLINK"].includes(error.code)) throw error;
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
}
async function unpack(archive, root, component) {
  if ((await fsp.stat(archive)).size !== component.size || await hashFile(archive) !== component.sha256) fail("component_archive_corrupt");
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
function createComponentStore({ rootDir, baseRoot, config, transport, onProgress }) {
  rootDir = path.resolve(rootDir); baseRoot = path.resolve(baseRoot);
  if (rootDir === baseRoot || rootDir.startsWith(baseRoot + path.sep)) fail("component_store_inside_base");
  let preparing = false;
  async function prepare(envelope) {
    if (preparing) fail("component_prepare_busy");
    preparing = true;
    try {
      const manifest = verifyComponentManifest(envelope, config);
      let baseline;
      try { baseline = await readJson(path.join(baseRoot, "component-base.json")); }
      catch (error) { if (error.code === "ENOENT") fail("full_upgrade_required"); throw error; }
      validateFiles(baseline.files); assertCompatible(manifest, baseline);
      if (baseline.files.some(f => !["base", ...COMPONENTS].includes(f.component))) fail("component_base_invalid");
      await fsp.mkdir(rootDir, { recursive: true });
      if ((await fsp.lstat(rootDir)).isSymbolicLink()) fail("component_symlink_forbidden");
      const archives = path.join(rootDir, "archives"), generations = path.join(rootDir, "generations");
      await fsp.mkdir(archives, { recursive: true }); await fsp.mkdir(generations, { recursive: true });
      for (const directory of [archives, generations]) if ((await fsp.lstat(directory)).isSymbolicLink()) fail("component_symlink_forbidden");
      const targetId = digest(envelope.payload), finalRoot = path.join(generations, targetId);
      const baseFiles = baseline.files.filter(f => f.component === "base");
      let existing;
      try { existing = await readJson(path.join(finalRoot, "component-complete.json")); } catch { /* no complete target */ }
      if (existing) {
        if (existing.payload !== envelope.payload) fail("component_generation_invalid");
        const full = await readJson(path.join(finalRoot, "component-base.json"));
        assertCompatible(manifest, full); validateFiles(full.files);
        if (full.files.some(f => !["base", ...COMPONENTS].includes(f.component))) fail("component_generation_invalid");
        for (const name of COMPONENTS) if (treeHash(full.files.filter(f => f.component === name)) !== manifest.components[name].treeSha256) fail("component_generation_invalid");
        await verifyGeneration(finalRoot, full.files);
        return { generationRoot: finalRoot, version: manifest.version, envelope, downloadedBytes: 0, totalBytes: 0 };
      }
      const disk = await fsp.statfs(rootDir);
      const required = validateFiles(baseFiles) + COMPONENTS.reduce((n, name) => n + manifest.components[name].expandedSize + manifest.components[name].size, 0) + 128 * 1024 ** 2;
      if (Number(disk.bavail) * Number(disk.bsize) < required) fail("component_disk_space_insufficient");
      const staging = await fsp.mkdtemp(path.join(generations, ".prepare-"));
      let downloadedBytes = 0, totalBytes = 0, copiedBytes = 0;
      const reused = new Set(), cached = new Set();
      for (const name of COMPONENTS) {
        const files = baseline.files.filter(f => f.component === name);
        if (treeHash(files) === manifest.components[name].treeSha256) reused.add(name);
        else {
          const component = manifest.components[name];
          try {
            const archive = await regularFile(archives, component.sha256 + ".zip");
            if ((await fsp.stat(archive)).size === component.size && await hashFile(archive) === component.sha256) cached.add(name);
          } catch { /* absent or corrupt complete archive needs a download */ }
          if (!cached.has(name)) totalBytes += component.size;
        }
      }
      const progress = phase => onProgress?.({ phase, downloadedBytes, totalBytes, copiedBytes });
      progress("prepare");
      const targetFiles = [...baseFiles], descriptors = {};
      for (const file of baseFiles) { await copyVerified(baseRoot, staging, file); copiedBytes += file.size; progress("compose"); }
      for (const name of COMPONENTS) {
        const component = manifest.components[name];
        let descriptor;
        if (reused.has(name)) {
          const files = baseline.files.filter(f => f.component === name).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
          descriptor = { schema: 2, name, treeSha256: component.treeSha256, files };
          for (const file of files) { await copyVerified(baseRoot, staging, file); copiedBytes += file.size; progress("compose"); }
        } else {
          const archive = path.join(archives, component.sha256 + ".zip");
          if (!cached.has(name)) {
            // Corrupt complete archives never become trusted by existence alone.
            const partial = archive + ".part";
            try { if ((await fsp.lstat(partial)).isSymbolicLink()) fail("component_symlink_forbidden"); } catch (e) { if (e.code !== "ENOENT") throw e; }
            const before = downloadedBytes;
            await transport.request(component.file, { destination: partial, expected: component, maxBytes: component.size, resume: true,
              onProgress: bytes => { downloadedBytes = before + bytes; progress("download"); } });
            if ((await fsp.stat(partial)).size !== component.size || await hashFile(partial) !== component.sha256) fail("component_archive_corrupt");
            await fsp.rename(partial, archive);
          }
          descriptor = await unpack(archive, staging, component);
        }
        descriptors[name] = descriptor;
        targetFiles.push(...descriptor.files.map(file => ({ ...file, component: name })));
      }
      validateFiles(targetFiles);
      await verifyFiles(staging, targetFiles);
      const full = { schema: 2, base: baseline.base, dataSchema: manifest.dataSchema, files: targetFiles, components: descriptors };
      await fsp.writeFile(path.join(staging, "component-base.json"), JSON.stringify(full), { flag: "wx" });
      await fsp.writeFile(path.join(staging, "component-complete.json.tmp"), JSON.stringify(envelope), { flag: "wx" });
      await fsp.rename(path.join(staging, "component-complete.json.tmp"), path.join(staging, "component-complete.json"));
      await fsp.rename(staging, finalRoot);
      progress("ready");
      return { generationRoot: finalRoot, version: manifest.version, envelope, downloadedBytes, totalBytes };
    } finally { preparing = false; }
  }
  return { prepare };
}
module.exports = { createComponentStore, unpack, verifyFiles, verifyGeneration };
