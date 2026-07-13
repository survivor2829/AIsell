const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const edition = process.argv[2] || "delivery";
if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported portable edition: ${edition}`);
const productName = edition === "test" ? "小玺AI员工-测试版" : "小玺AI员工-交付版";
const target = path.join(projectDir, "release", productName);
const appDir = path.join(target, "resources", "app");
const zip = path.join(projectDir, "release", `${productName}.zip`);
const executable = path.join(target, `${productName}.exe`);
const helper = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
const nativeLibDir = path.join(appDir, "rpa", "contact_sync", "libs");
const nativeLibraryNames = ["wx_key.dll", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const wxKeyDll = path.join(nativeLibDir, "wx_key.dll");
const databaseDecryptor = path.join(nativeLibDir, "xiaoxi-db-decrypt.exe");
const databaseFilePattern = /\.(?:db(?:-wal|-shm)?|sqlite3?)$/i;
const blockedNames = new Set(["python.exe", "dump_data.exe", "wechat-dump-rs.exe", "contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);

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
assert.equal(fs.existsSync(wxKeyDll), true, "authorized wx_key.dll must be packaged");
assert.equal(fs.existsSync(databaseDecryptor), true, "database decryptor must be packaged");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "版本清单.json"), "utf8"));
assert.equal(manifest.edition, edition);
assert.equal(manifest.architecture, "x64");
assert.ok(manifest.contactHelperSha256);
assert.equal(sha256(helper), manifest.contactHelperSha256, "packaged helper hash must match the manifest");
assert.equal(sha256(wxKeyDll), manifest.wxKeySha256, "packaged wx_key.dll hash must match the manifest");
assert.equal(sha256(databaseDecryptor), manifest.databaseDecryptorSha256, "packaged database decryptor hash must match the manifest");
assert.deepEqual(Object.keys(manifest.nativeLibrarySha256 || {}).sort(), [...nativeLibraryNames].sort(), "manifest must list every wx_key.dll native dependency");
for (const name of nativeLibraryNames) {
  const file = path.join(nativeLibDir, name);
  assert.equal(fs.existsSync(file), true, `${name} must be packaged beside wx_key.dll`);
  assert.equal(sha256(file), manifest.nativeLibrarySha256[name], `${name} hash must match the manifest`);
}

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

const wxKeyHelp = spawnSync(helper, ["wx-key", "--help"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(wxKeyHelp.status, 0, wxKeyHelp.stderr || wxKeyHelp.stdout || "packaged helper wx-key command failed");

const wxKeyLoad = spawnSync(helper, ["wx-key", "--dll", wxKeyDll, "--load-only"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(wxKeyLoad.status, 0, wxKeyLoad.stderr || wxKeyLoad.stdout || "packaged wx_key.dll failed to load");
assert.equal(JSON.parse(wxKeyLoad.stdout.trim()).stage, "dll_loaded", "packaged wx_key.dll load check must succeed");

for (const legacyName of ["小玺AI员工", "小玺AI员工-客户版", "小玺AI员工-受控试用版"]) {
  assert.equal(fs.existsSync(path.join(projectDir, "release", legacyName)), false, `legacy release directory must be absent: ${legacyName}`);
  assert.equal(fs.existsSync(path.join(projectDir, "release", `${legacyName}.zip`)), false, `legacy release ZIP must be absent: ${legacyName}`);
}

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
assert.equal(fs.existsSync(path.join(mainDir, "active-touch-dev-ipc.cjs")), edition === "test");
assert.equal(fs.existsSync(path.join(mainDir, "preload.dev.cjs")), edition === "test");
assert.equal(fs.readFileSync(path.join(mainDir, "preload.cjs"), "utf8").includes("sendReal"), false);
const activeDir = path.join(appDir, "rpa", "active_touch");
assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), true);
assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), true);
assert.equal(fs.existsSync(path.join(activeDir, "active_touch_cli.dev.cjs")), edition === "test");
const renderer = fs.readdirSync(path.join(appDir, "dist", "assets")).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(appDir, "dist", "assets", name), "utf8")).join("\n");
assert.equal(renderer.includes("内部测试"), edition === "test");
assert.equal(renderer.includes(edition === "test" ? "测试版" : "交付版"), true);
console.log(`${edition} portable release self-check passed`);
