const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const { COMPONENTS, hashFile, validateManifest, verifyComponentManifest } = require("../src/shared/component-contract.cjs");
const { matchingReleaseNotes } = require("../src/shared/customer-release-notes.cjs");
const { verifyPublishedRelease } = require("./release-readback.cjs");
const { verifyUpgradePaths } = require("./release-upgrade-path.cjs");
const { reserveBytes, uploadCopies } = require("./release-server-space.cjs");
const shellQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
function componentPreflightCommand(archives, remote) {
  if (!/^\/home\/ubuntu\/ai-components-\d+$/.test(remote)
      || archives.some(item => !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0)) throw Error("component_preflight_invalid");
  const rows = archives.map(({ sha256, size }) => ({ sha256, size }));
  const inspect = `import json,os; rows=${JSON.stringify(rows)}; missing=[r for r in rows if not os.path.isfile('/var/lib/ai-maintenance/components/'+r['sha256']+'.zip')]; print(json.dumps({'missing':[r['sha256'] for r in missing],'uploadBytes':sum(r['size'] for r in missing)}))`;
  // Only stdout is the machine-readable plan. Cleanup's explanatory output is
  // stderr so an interrupted preflight cannot masquerade as a successful plan.
  return `plan=$(sudo -n -u ai-maintenance python3 -c ${shellQuote(inspect)}) && required=$(printf '%s' "$plan" | python3 -c ${shellQuote(`import json,sys; print(${reserveBytes}+${uploadCopies}*json.load(sys.stdin)['uploadBytes'])`)}) && sudo -n python3 /opt/ai-maintenance/release_cleanup.py --apply --require-free-bytes "$required" >&2 && mkdir -m 755 ${remote} && printf '%s\\n' "$plan"`;
}
async function publishComponentRelease({ metadataFile, notesFile }) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  const config = cloudConfig({ developmentEdition: true });
  const manifest = { ...metadata.manifest };
  manifest.notes = matchingReleaseNotes(manifest.version, notesFile ? fs.readFileSync(notesFile, "utf8") : manifest.notes);
  validateManifest(manifest, config);
  const git = args => spawnSync("git", args, { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", windowsHide: true });
  const state = git(["status", "--porcelain", "--untracked-files=all"]), head = git(["rev-parse", "HEAD"]);
  if (state.status || head.status || state.stdout.trim() || metadata.buildCommit !== head.stdout.trim()
      || metadata.sourceManifest?.commit !== metadata.buildCommit || metadata.sourceManifest?.dirty !== false
      || metadata.sourceManifest?.version !== manifest.version) throw Error("Publish requires a clean checkout at the matching component build commit.");
  if (metadata.validation?.gate !== "packaged-application" || metadata.validation.commit !== metadata.buildCommit
      || metadata.validation.version !== manifest.version || !Number.isFinite(Date.parse(metadata.validation.completedAt))) throw Error("Component publish requires the completed packaged application release gate.");
  const archives = [];
  for (const name of COMPONENTS) {
    const component = manifest.components[name];
    const archive = path.join(path.dirname(path.resolve(metadataFile)), `${component.sha256}.zip`);
    if (fs.statSync(archive).size !== component.size || await hashFile(archive) !== component.sha256) throw Error("Component archive does not match metadata.");
    archives.push({ ...component, path: archive });
  }
  // Verify the legacy entry point and the actual full artifact before signing/uploading.
  const upgradePaths = await verifyUpgradePaths({ config, target: manifest });
  manifest.sequence = Date.now(); manifest.publishedAt = new Date().toISOString();
  const payload = JSON.stringify(manifest);
  const envelope = { payload, signature: crypto.sign(null, Buffer.from(payload), fs.readFileSync(path.join(os.homedir(), ".ssh", "ai-release-signing.pem"))).toString("base64") };
  verifyComponentManifest(envelope, config);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-components-publish-"));
  const document = path.join(temporary, "latest-components.json");
  fs.writeFileSync(document, JSON.stringify(envelope));
  const sshDir = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH");
  const flags = ["-i", path.join(os.homedir(), ".ssh", "ai-release-server_ed25519"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
  const host = `ubuntu@${new URL(config.origin).hostname}`;
  function run(command, args) {
    const result = spawnSync(path.join(sshDir, command), args, { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw Error(`${command} failed (${result.status})`);
    return result;
  }
  const remote = `/home/ubuntu/ai-components-${manifest.sequence}`;
  const incoming = `/var/lib/ai-maintenance/components-incoming-${manifest.sequence}`;
  try {
    const plan = JSON.parse(run("ssh.exe", [...flags, host, componentPreflightCommand(archives, remote)]).stdout);
    if (!Array.isArray(plan.missing) || new Set(plan.missing).size !== plan.missing.length
        || plan.missing.some(hash => !archives.some(item => item.sha256 === hash))) throw Error("component_preflight_invalid");
    const missing = archives.filter(archive => plan.missing.includes(archive.sha256));
    if (plan.uploadBytes !== missing.reduce((sum, item) => sum + item.size, 0)) throw Error("component_preflight_invalid");
    run("scp.exe", [...flags, ...missing.map(archive => archive.path), document, `${host}:${remote}/`]);
    const uploads = ["latest-components.json", ...missing.map(c => `${c.sha256}.zip`)].map(name => `${remote}/${name}`).join(" ");
    await verifyUpgradePaths({ config, target: manifest, expectedPayload: upgradePaths.payload, verifyArtifact: false });
    run("ssh.exe", [...flags, host, `sudo -n install -d -o ai-maintenance -g ai-maintenance -m 700 ${incoming} && sudo -n install -o ai-maintenance -g ai-maintenance -m 600 ${uploads} ${incoming}/ && sudo -n -u ai-maintenance python3 /opt/ai-maintenance/promote_components.py ${incoming}/latest-components.json ${incoming}`]);
    const readback = await verifyPublishedRelease({ config, envelope, schema: 2 });
    try { run("ssh.exe", [...flags, host, `sudo -n rm -rf -- ${incoming} ${remote}`]); }
    catch { console.warn("Release verified; upload staging cleanup deferred."); }
    return { published: true, version: manifest.version, channel: manifest.channel, uploadedArchives: missing.length,
      downloadedFileBytes: upgradePaths.downloadedBytes,
      uploadedFileBytes: missing.reduce((sum, item) => sum + item.size, 0) + fs.statSync(document).size, uploadedFiles: missing.length + 1, readback };
  } finally {
    fs.unlinkSync(document); fs.rmdirSync(temporary);
  }
}
if (require.main === module) {
  const [metadataFile, notesFile] = process.argv.slice(2);
  if (!metadataFile) throw Error("Usage: node scripts/publish-component-release.cjs <unsigned-component-release.json> [notes.txt]");
  publishComponentRelease({ metadataFile, notesFile }).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { publishComponentRelease, componentPreflightCommand };
