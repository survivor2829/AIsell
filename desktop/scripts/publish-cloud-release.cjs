const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const { fileHash } = require("../src/main/cloud-maintenance.cjs");
const { verifyManifest, VERSION } = require("../src/shared/cloud-contract.cjs");

async function publish({ installer, manifestFile, notesFile, smoke = false }) {
  const config = cloudConfig({ developmentEdition: true });
  const metadata = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const appId = smoke ? "com.aihuoke.maintenance.smoke" : config.appId;
  if (metadata.appId !== appId || !VERSION.test(metadata.version) || metadata.artifactType !== "internal-evaluation") throw Error("A matching internal test installer manifest is required");
  const sha256 = await fileHash(installer), size = fs.statSync(installer).size;
  if (metadata.sha256 !== sha256 || metadata.size !== size) throw Error("Installer does not match its version manifest");
  const keyFile = path.join(os.homedir(), ".ssh", "ai-release-signing.pem");
  const sshKey = path.join(os.homedir(), ".ssh", "ai-release-server_ed25519");
  const manifest = {
    schema: 1, appId, channel: smoke ? "smoke" : config.channel,
    platform: "win32", arch: "x64", version: metadata.version,
    sequence: Date.now(), sha256, size, file: `/artifacts/${sha256}.exe`,
    notes: notesFile ? fs.readFileSync(notesFile, "utf8").trim() : "修复与体验改进"
  };
  const payload = JSON.stringify(manifest);
  const envelope = { payload, signature: crypto.sign(null, Buffer.from(payload), fs.readFileSync(keyFile)).toString("base64") };
  verifyManifest(envelope, { ...config, appId, channel: manifest.channel });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cloud-publish-"));
  const document = path.join(temporary, "latest.json");
  fs.writeFileSync(document, JSON.stringify(envelope));
  const sshDir = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH");
  const flags = ["-i", sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"];
  const host = `ubuntu@${new URL(config.origin).hostname}`;
  function run(command, args) {
    const result = spawnSync(path.join(sshDir, command), args, { stdio: "inherit", windowsHide: true });
    if (result.status !== 0) throw Error(`${command} failed`);
  }
  const remote = `/home/ubuntu/ai-release-${manifest.sequence}`;
  try {
    run("ssh.exe", [...flags, host, `mkdir -m 755 ${remote}`]);
    run("scp.exe", [...flags, path.resolve(installer), `${host}:${remote}/installer.exe`]);
    run("scp.exe", [...flags, document, `${host}:${remote}/latest.json`]);
    const incoming = `/var/lib/ai-maintenance/incoming-${manifest.sequence}`;
    run("ssh.exe", [...flags, host, `sudo -n install -d -o ai-maintenance -g ai-maintenance -m 700 ${incoming} && sudo -n install -o ai-maintenance -g ai-maintenance -m 600 ${remote}/latest.json ${remote}/installer.exe ${incoming}/ && sudo -n -u ai-maintenance python3 /opt/ai-maintenance/promote.py ${incoming}/latest.json ${incoming}/installer.exe`]);
    console.log(`Published ${manifest.channel} ${manifest.version}. Previous signed manifests retained on server.`);
  } finally {
    fs.rmSync(document, { force: true }); fs.rmdirSync(temporary);
  }
}
if (require.main === module) {
  const [installer, manifestFile, notesFile] = process.argv.slice(2).filter((arg) => arg !== "--smoke");
  if (!installer || !manifestFile) throw Error("Usage: node scripts/publish-cloud-release.cjs <installer.exe> <manifest.json> [notes.txt] [--smoke]");
  publish({ installer, manifestFile, notesFile, smoke: process.argv.includes("--smoke") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { publish };
