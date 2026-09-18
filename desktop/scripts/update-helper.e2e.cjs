// Real Electron processes exercise the updater; the inert installer touches only this fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(100); }
  throw Error(`Timed out: ${label}`);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
async function main() {
  assert.equal(process.platform, "win32", "the update process test requires Windows");
  const desktop = path.resolve(__dirname, ".."), parent = path.join(desktop, ".build/update-process-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  const source = path.resolve(process.argv[2] || desktop), legacy = process.argv.includes("--expect-legacy-failure");
  const installed = path.join(root, "installed"), application = path.join(installed, "resources/app"), userData = path.join(root, "profile");
  const electronRoot = path.dirname(require("electron"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const initialVersion = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8")).version;
  const targetVersion = initialVersion.split(".").map((part, index) => index === 2 ? Number(part) + 1 : part).join(".");
  const fixtureFiles = { "settings.json": Buffer.from('{"theme":"test"}'), "data/contacts.db": Buffer.from([0, 255, 3, 9]),
    "data/materials/content.txt": Buffer.from("business fixture must survive") };
  const children = new Set();
  let passed = false;
  try {
    await fs.mkdir(installed, { recursive: true });
    for (const item of await fs.readdir(electronRoot, { withFileTypes: true })) {
      if (item.isFile()) await fs.copyFile(path.join(electronRoot, item.name), path.join(installed, item.name === "electron.exe" ? "UpdateFixture.exe" : item.name));
      else if (item.name === "locales") await fs.cp(path.join(electronRoot, item.name), path.join(installed, item.name), { recursive: true });
    }
    for (const directory of ["src/main", "src/shared"]) await fs.mkdir(path.join(application, directory), { recursive: true });
    const modules = ["src/main/update-helper.cjs", "src/main/atomic-file.cjs", "src/main/component-paths.cjs",
      "src/shared/cloud-contract.cjs", "src/shared/component-contract.cjs"];
    for (const file of modules) await fs.copyFile(path.join(source, file), path.join(application, file));
    try { await fs.copyFile(path.join(source, "src/main/update-storage.cjs"), path.join(application, "src/main/update-storage.cjs")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const helperBytes = await fs.readFile(path.join(source, "src/main/update-helper.cjs"));
    assert.deepEqual(await fs.readFile(path.join(application, "src/main/update-helper.cjs")), helperBytes, "the starting updater must be byte-identical to the selected source");
    const helperSha256 = crypto.createHash("sha256").update(helperBytes).digest("hex");
    const config = { enabled: true, appId: "com.xiaoxi.update.fixture", channel: "test", signingPublicKey: publicKey.export({ type: "spki", format: "pem" }) };
    // Only the trust fixture changes: no production key, server or user profile is accessed.
    await fs.writeFile(path.join(application, "src/main/cloud-config.cjs"), `module.exports.cloudConfig=()=>(${JSON.stringify(config)});`);
    await fs.copyFile(path.join(__dirname, "update-helper.e2e-entry.cjs"), path.join(application, "entry.cjs"));
    const packageJson = { name: "xiaoxi-update-fixture", version: initialVersion, main: "entry.cjs" };
    await fs.writeFile(path.join(application, "package.json"), JSON.stringify(packageJson));
    await fs.writeFile(path.join(root, "fixture-marker"), "isolated-update-e2e");
    for (const [file, bytes] of Object.entries(fixtureFiles)) {
      await fs.mkdir(path.dirname(path.join(userData, file)), { recursive: true });
      await fs.writeFile(path.join(userData, file), bytes);
    }
    const cache = path.join(userData, "data/cloud-maintenance/components/generations/old/resources");
    await fs.mkdir(cache, { recursive: true });
    await fs.copyFile(path.join(electronRoot, "resources/default_app.asar"), path.join(cache, "default_app.asar"));
    await fs.mkdir(path.join(root, "payload"));
    await fs.writeFile(path.join(root, "payload/package.json"), JSON.stringify({ ...packageJson, version: targetVersion }));
    const installerSource = `using System; using System.IO; using System.Reflection;
class FixtureInstaller { static int Main(string[] args) {
  string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
  if (args.Length != 1 || args[0] != "/S" || File.ReadAllText(Path.Combine(root, "fixture-marker")) != "isolated-update-e2e") return 10;
  string app = Path.Combine(root, "installed", "resources", "app");
  File.Copy(Path.Combine(root, "payload", "package.json"), Path.Combine(app, "package.json"), true);
  File.WriteAllText(Path.Combine(root, "installer-ran.json"), "{\\"ok\\":true}");
  return 0;
} }`;
    const cs = path.join(root, "FixtureInstaller.cs"), installer = path.join(root, "FixtureInstaller.exe");
    await fs.writeFile(cs, installerSource);
    await run(path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/target:winexe", `/out:${installer}`, cs], { windowsHide: true, timeout: 30000 });
    const bytes = await fs.readFile(installer), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const payload = JSON.stringify({ schema: 1, ...{ appId: config.appId, channel: config.channel }, platform: "win32", arch: "x64",
      version: targetVersion, sequence: 1, sha256, size: bytes.length, file: `/artifacts/${sha256}.exe`, notes: "isolated process fixture only" });
    const prepared = { kind: "full", version: targetVersion, file: installer,
      envelope: { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") } };
    await fs.writeFile(path.join(root, "spec.json"), JSON.stringify({ prepared, initialVersion, targetVersion, userData }));
    const env = { ...process.env, XIAOXI_UPDATE_E2E_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(installed, "UpdateFixture.exe"), ["--no-sandbox", "--disable-gpu"], { env, windowsHide: true, stdio: "ignore" });
    children.add(child.pid);
    const parentReceipt = await waitFor(async () => {
      const error = await readJson(path.join(root, "entry-error.json")); if (error) throw Error(JSON.stringify(error));
      return readJson(path.join(root, "parent.json"));
    }, "parent creates an actual helper");
    children.add(parentReceipt.helperPid);
    const statusFile = parentReceipt.file.replace(/\.json$/, ".status.json");
    const status = await waitFor(async () => {
      const result = await readJson(statusFile);
      return ["error", "complete"].includes(result?.phase) ? result : null;
    }, "helper reaches a terminal stage", 150000);
    if (legacy) {
      assert.equal(status.phase, "error");
      assert.match(status.detail, /Invalid package/);
      assert.equal(await readJson(path.join(root, "installer-ran.json")), null, "the unchanged legacy updater must not be misreported as a successful upgrade");
    } else {
      assert.equal(status.phase, "complete", JSON.stringify(status));
      assert.equal((await readJson(path.join(root, "installer-ran.json"))).ok, true);
      const boot = await readJson(path.join(root, "boot.json"));
      children.add(boot.pid);
      assert.equal(boot.version, targetVersion);
      assert.equal((await readJson(parentReceipt.file.replace(/\.json$/, ".ack.json"))).ok, true);
      const backup = path.join(root, "profile-update-backups", parentReceipt.id);
      for (const [file, value] of Object.entries(fixtureFiles)) assert.deepEqual(await fs.readFile(path.join(backup, file)), value);
      await assert.rejects(fs.stat(path.join(backup, "data/cloud-maintenance")), { code: "ENOENT" });
    }
    for (const [file, value] of Object.entries(fixtureFiles)) assert.deepEqual(await fs.readFile(path.join(userData, file)), value);
    const result = { ok: true, source, helperSha256, initialVersion, targetVersion, observedPhase: status.phase,
      legacyBlocked: legacy, fixtureInstaller: true, productionInstallerVerified: false, dataUnchanged: true };
    await fs.writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, evidence: path.join(root, "result.json") }));
    passed = true;
  } finally {
    try {
      // Include a restarted fixture that timed out before writing its boot receipt.
      const snapshot = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 ** 2 });
      const rows = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, ""));
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row?.ExecutablePath && path.resolve(row.ExecutablePath).toLowerCase().startsWith(root.toLowerCase() + path.sep)) children.add(row.ProcessId);
      }
    } catch { /* Existing receipts still provide candidates; every PID is rechecked below. */ }
    for (const pid of children) if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        const snapshot = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty ExecutablePath`], { windowsHide: true, timeout: 10000 });
        const executable = snapshot.stdout.trim();
        // A PID may have been reused after a fixture process exited. Never kill by PID alone.
        if (executable && path.resolve(executable).toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
          await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
        }
      } catch { /* No positive ownership evidence: leave the process alone. */ }
    }
    // Successful runs retain receipts, logs and data, not two disposable Electron distributions.
    if (passed) {
      for (const directory of [installed, path.join(userData, "data/cloud-maintenance/components/helper-runtime")]) {
        try {
          const realRoot = await fs.realpath(root), realDirectory = await fs.realpath(directory);
          assert.equal(path.dirname(root), parent);
          assert.equal(await fs.readFile(path.join(root, "fixture-marker"), "utf8"), "isolated-update-e2e");
          assert.ok(realDirectory.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep));
          assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
          await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) { console.warn(`Fixture runtime retained: ${directory} (${error.code || error.message})`); }
      }
    }
    if (!passed) console.error(`Update process fixture retained: ${root}`);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
