const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const { COMPONENTS, hashFile, validateManifest, verifyComponentManifest } = require("../src/shared/component-contract.cjs");
async function publishComponentRelease({ metadataFile, notesFile }) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  const config = cloudConfig({ developmentEdition: true });
  const manifest = { ...metadata.manifest };
  if (notesFile) manifest.notes = fs.readFileSync(notesFile, "utf8").trim();
  if (!manifest.notes || manifest.notes.length > 2000) throw Error("Provide concrete customer release notes (1–2000 characters).");
  validateManifest(manifest, config);
  const git = args => spawnSync("git", args, { cwd: path.resolve(__dirname, "../.."), encoding: "utf8", windowsHide: true });
  const state = git(["status", "--porcelain", "--untracked-files=all"]), head = git(["rev-parse", "HEAD"]);
  if (state.status || head.status || state.stdout.trim() || metadata.buildCommit !== head.stdout.trim()
      || metadata.sourceManifest?.commit !== metadata.buildCommit || metadata.sourceManifest?.dirty !== false
      || metadata.sourceManifest?.version !== manifest.version) throw Error("Publish requires a clean checkout at the matching component build commit.");
  const archives = [];
  for (const name of COMPONENTS) {
    const component = manifest.components[name];
    const archive = path.join(path.dirname(path.resolve(metadataFile)), `${component.sha256}.zip`);
    if (fs.statSync(archive).size !== component.size || await hashFile(archive) !== component.sha256) throw Error("Component archive does not match metadata.");
    archives.push({ ...component, path: archive });
  }
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
  function run(command, args, allowMissing = false) {
    const result = spawnSync(path.join(sshDir, command), args, { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 && !(allowMissing && result.status === 1)) throw Error(`${command} failed (${result.status})`);
    return result.status;
  }
  const remote = `/home/ubuntu/ai-components-${manifest.sequence}`;
  const incoming = `/var/lib/ai-maintenance/components-incoming-${manifest.sequence}`;
  try {
    const missing = [];
    for (const archive of archives) {
      if (run("ssh.exe", [...flags, host, `sudo -n -u ai-maintenance test -f /var/lib/ai-maintenance/components/${archive.sha256}.zip`], true) === 1) missing.push(archive);
    }
    run("ssh.exe", [...flags, host, `mkdir -m 755 ${remote}`]);
    for (const archive of missing) run("scp.exe", [...flags, archive.path, `${host}:${remote}/${archive.sha256}.zip`]);
    run("scp.exe", [...flags, document, `${host}:${remote}/latest-components.json`]);
    const uploads = ["latest-components.json", ...missing.map(c => `${c.sha256}.zip`)].map(name => `${remote}/${name}`).join(" ");
    run("ssh.exe", [...flags, host, `sudo -n install -d -o ai-maintenance -g ai-maintenance -m 700 ${incoming} && sudo -n install -o ai-maintenance -g ai-maintenance -m 600 ${uploads} ${incoming}/ && sudo -n -u ai-maintenance python3 /opt/ai-maintenance/promote_components.py ${incoming}/latest-components.json ${incoming}`]);
    return { published: true, version: manifest.version, channel: manifest.channel, uploadedArchives: missing.length };
  } finally {
    fs.unlinkSync(document); fs.rmdirSync(temporary);
  }
}
if (require.main === module) {
  const [metadataFile, notesFile] = process.argv.slice(2);
  if (!metadataFile) throw Error("Usage: node scripts/publish-component-release.cjs <unsigned-component-release.json> [notes.txt]");
  publishComponentRelease({ metadataFile, notesFile }).then(console.log).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { publishComponentRelease };
