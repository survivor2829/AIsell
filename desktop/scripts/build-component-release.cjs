const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const JSZip = require("jszip");
const { COMPONENTS, safePath, hashFile, treeHash, validateFiles, validateManifest, MAX_ARCHIVE } = require("../src/shared/component-contract.cjs");
const defaultLayout = require("../component-layout.json");
function classify(relative, layout) {
  for (const rule of layout.rules) for (const prefix of rule.prefixes) {
    if (prefix.endsWith("/") ? relative.startsWith(prefix) : relative === prefix) return rule.component;
  }
  return layout.default;
}
async function inventory(root, layout) {
  const files = [];
  if ((await fsp.lstat(root)).isSymbolicLink()) throw Error("component_symlink_forbidden");
  async function walk(directory, prefix = "") {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (["component-base.json", "component-complete.json"].includes(relative)) continue;
      safePath(relative);
      const full = path.join(directory, entry.name), stat = await fsp.lstat(full);
      if (stat.isSymbolicLink()) throw Error("component_symlink_forbidden");
      if (stat.isDirectory()) await walk(full, relative + "/");
      else if (stat.isFile()) {
        const component = classify(relative, layout);
        if (!["base", ...COMPONENTS].includes(component)) throw Error("component_layout_invalid");
        files.push({ path: relative, size: stat.size, sha256: await hashFile(full), component });
      } else throw Error("component_file_type_invalid");
    }
  }
  await walk(root); validateFiles(files);
  return files.sort((a,b) => a.path < b.path ? -1 : 1);
}
async function buildComponentRelease({ sourceRoot, outputDir, version, baseVersion = "1.1.0", appId, channel,
  notes = "", sequence = Date.now(), buildCommit = "", layout = defaultLayout }) {
  sourceRoot = path.resolve(sourceRoot); outputDir = path.resolve(outputDir);
  if (outputDir === sourceRoot || outputDir.startsWith(sourceRoot + path.sep)) throw Error("component_output_inside_source");
  const sourceManifest = JSON.parse(await fsp.readFile(path.join(sourceRoot, "版本清单.json"), "utf8"));
  if (sourceManifest.version !== version || (buildCommit && sourceManifest.commit !== buildCommit)) throw Error("component_source_identity_mismatch");
  notes = require("../src/shared/customer-release-notes.cjs").matchingReleaseNotes(version, notes);
  buildCommit = buildCommit || sourceManifest.commit || "";
  await fsp.mkdir(outputDir, { recursive: true });
  const files = await inventory(sourceRoot, layout);
  const baseline = { schema: 2, base: { version: baseVersion, fingerprint: treeHash(files.filter(f => f.component === "base")) }, dataSchema: 2, files, components: {} };
  const manifest = { schema: 2, appId, channel, platform: "win32", arch: "x64", version, base: baseline.base,
    minBaseVersion: baseVersion, dataSchema: 2, sequence, notes, publishedAt: new Date().toISOString(), components: {} };
  const artifacts = [];
  const retentionOwned = [];
  try {
    const previous = JSON.parse(await fsp.readFile(path.join(outputDir, "unsigned-component-release.json"), "utf8"));
    retentionOwned.push(...(previous.retentionOwned || []));
  } catch { /* First generation has no owned artifacts. */ }
  for (const name of COMPONENTS) {
    const ownFiles = files.filter(f => f.component === name).map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    if (!ownFiles.length) throw Error(`component_missing:${name}`);
    const treeSha256 = treeHash(ownFiles);
    const descriptor = { schema: 2, name, treeSha256, files: ownFiles };
    baseline.components[name] = descriptor;
    const cache = path.join(outputDir, `${name}-${treeSha256}.json`);
    let artifact;
    try {
      const cached = JSON.parse(await fsp.readFile(cache, "utf8"));
      const file = path.join(outputDir, `${cached.sha256}.zip`);
      if (/^[a-f0-9]{64}$/.test(cached.sha256) && cached.treeSha256 === treeSha256
          && (await fsp.stat(file)).size === cached.size && await hashFile(file) === cached.sha256) artifact = { ...cached, path: file };
    } catch { /* cache miss: build from the verified source inventory */ }
    if (!artifact) {
      const zip = new JSZip();
      const options = { date: new Date("2000-01-01T00:00:00Z"), createFolders: false, compression: "DEFLATE", compressionOptions: { level: 6 }, unixPermissions: 0o100644 };
      zip.file("component.json", JSON.stringify(descriptor), options);
      for (const file of ownFiles) {
        const data = await fsp.readFile(path.join(sourceRoot, file.path));
        if (data.length !== file.size || require("../src/shared/component-contract.cjs").digest(data) !== file.sha256) throw Error("component_source_changed");
        zip.file(`files/${file.path}`, data, options);
      }
      const buffer = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", streamFiles: true });
      if (buffer.length > MAX_ARCHIVE) throw Error("component_archive_too_large");
      const sha256 = require("../src/shared/component-contract.cjs").digest(buffer);
      const destination = path.join(outputDir, `${sha256}.zip`);
      try {
        await fsp.writeFile(destination, buffer, { flag: "wx" });
        retentionOwned.push(destination);
      } catch (error) {
        if (error.code !== "EEXIST" || await hashFile(destination) !== sha256) throw error;
      }
      artifact = { name, path: destination, sha256, size: buffer.length, treeSha256 };
      try { await fsp.access(cache); } catch { retentionOwned.push(cache); }
      await fsp.writeFile(cache, JSON.stringify(artifact));
    }
    manifest.components[name] = { name, sha256: artifact.sha256, size: artifact.size, treeSha256,
      file: `/components/${artifact.sha256}.zip`, expandedSize: validateFiles(ownFiles), fileCount: ownFiles.length };
    artifacts.push(artifact);
  }
  validateManifest(manifest, { appId, channel });
  const metadataFile = path.join(outputDir, "unsigned-component-release.json");
  await fsp.writeFile(metadataFile, JSON.stringify({ manifest, baseline, artifacts, buildCommit, retentionOwned: [...new Set(retentionOwned)],
    sourceManifest: { commit: sourceManifest.commit, dirty: sourceManifest.dirty, version: sourceManifest.version } }, null, 2));
  return { manifest, baseline, metadataFile, artifacts };
}
if (require.main === module) {
  const [sourceRoot, outputDir, version, appId, channel] = process.argv.slice(2);
  if (!channel) throw Error("Usage: node scripts/build-component-release.cjs <portable-root> <output-dir> <version> <app-id> <channel>");
  buildComponentRelease({ sourceRoot, outputDir, version, appId, channel }).then(r => console.log(r.metadataFile)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { buildComponentRelease, inventory, classify };
