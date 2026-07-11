const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const edition = process.argv[2] === "pilot" ? "pilot" : "customer";
const productName = edition === "pilot" ? "小玺AI员工-受控试用版" : "小玺AI员工-客户版";
const target = path.join(projectDir, "release", productName);
const appDir = path.join(target, "resources", "app");
const zip = path.join(projectDir, "release", `${productName}.zip`);
const executable = path.join(target, `${productName}.exe`);
const helper = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
const databaseFilePattern = /\.(?:db(?:-wal|-shm)?|sqlite3?)$/i;
const blockedNames = new Set(["python.exe", "wx_key.dll", "dump_data.exe", "wechat-dump-rs.exe", "contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);

function assertNoBlockedFiles(names, label) {
  const normalized = names.map((name) => path.basename(String(name).replaceAll("/", path.sep)).toLowerCase()).filter(Boolean);
  for (const name of normalized) {
    assert.equal(blockedNames.has(name) || databaseFilePattern.test(name), false, `${label} must not contain ${name}`);
  }
  assert.equal(normalized.some((name) => name.endsWith(".py") || name.includes("dt-ai-helper")), false, `${label} must not contain Python sources or dt-ai-helper`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

assert.equal(fs.existsSync(executable), true, "portable executable must exist");
assert.equal(fs.existsSync(zip), true, "portable ZIP must exist");
assert.equal(fs.existsSync(helper), true, "contact helper must be packaged");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "版本清单.json"), "utf8"));
assert.equal(manifest.edition, edition);
assert.equal(manifest.architecture, "x64");
assert.ok(manifest.contactHelperSha256);
assert.equal(sha256(helper), manifest.contactHelperSha256, "packaged helper hash must match the manifest");

const files = [];
function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
}
walk(target);
const names = files.map((file) => path.basename(file).toLowerCase());
assertNoBlockedFiles(names, "release");

const archive = spawnSync("tar.exe", ["-tf", zip], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(archive.status, 0, archive.stderr || archive.stdout || "portable ZIP must be readable");
const archiveEntries = archive.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
assert.ok(archiveEntries.length > 0, "portable ZIP must not be empty");
assertNoBlockedFiles(archiveEntries, "portable ZIP");

const helperCheck = spawnSync(helper, ["self-check"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(helperCheck.status, 0, helperCheck.stderr || helperCheck.stdout || "packaged helper self-check failed");
assert.equal(JSON.parse(helperCheck.stdout.trim()).ok, true, "packaged helper self-check must return ok");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-self-check-"));
try {
  const contactSyncDir = path.join(tempDir, "contact_sync");
  const activeTouchDir = path.join(tempDir, "active_touch");
  fs.mkdirSync(contactSyncDir, { recursive: true });
  fs.mkdirSync(activeTouchDir, { recursive: true });
  const contactCli = path.join(appDir, "rpa", "contact_sync", "contact_sync_cli.cjs");
  const status = spawnSync(executable, [contactCli, "status", "--data-dir", contactSyncDir, "--active-touch-dir", activeTouchDir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.equal(status.status, 0, status.stderr || status.stdout || "packaged contact-sync status failed");
  const payload = JSON.parse(status.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.state?.helper_configured, true, "packaged runtime must discover the bundled helper");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const mainDir = path.join(appDir, "src", "main");
assert.equal(fs.existsSync(path.join(mainDir, "active-touch-dev-ipc.cjs")), false);
assert.equal(fs.existsSync(path.join(mainDir, "preload.dev.cjs")), false);
assert.equal(fs.readFileSync(path.join(mainDir, "preload.cjs"), "utf8").includes("sendReal"), false);
const activeDir = path.join(appDir, "rpa", "active_touch");
if (edition === "customer") {
  assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), false);
  assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), false);
} else {
  assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), true);
  assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), true);
  assert.equal(fs.existsSync(path.join(activeDir, "active_touch_cli.dev.cjs")), false);
}
const renderer = fs.readdirSync(path.join(appDir, "dist", "assets")).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(appDir, "dist", "assets", name), "utf8")).join("\n");
assert.equal(renderer.includes("开发验收"), false);
assert.equal(renderer.includes("受控试用版"), edition === "pilot");
console.log(`${edition} portable release self-check passed`);
