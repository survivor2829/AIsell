const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(projectDir, "release");
const electronDir = path.join(desktopDir, "node_modules", "electron", "dist");
const nativeLibDir = path.join(desktopDir, "rpa", "contact_sync", "libs");
const helper = path.join(nativeLibDir, "xiaoxi-contact-helper.exe");
const CONTACT_HELPER_SHA256 = "f9c90aec8589ac11a93db7acfbc9b3b92c0c9c2a3b9175642829fba2e0f12eeb";
const DATABASE_DECRYPTOR_NAME = "xiaoxi-db-decrypt.exe";
const DATABASE_DECRYPTOR_SHA256 = "2e6d190f3a0f33112cd4b7baeadea9947cb70688a94f3787a6be236287dc1815";
const NATIVE_LIBRARY_SHA256 = Object.freeze({
  "wx_key.dll": "f946ef8cb2a59bc03ce0b6ae0e22ed905a57e4c8228ed6b1c2b07fd54ecb9a05",
  "msvcp140.dll": "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9",
  "vcruntime140.dll": "d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066",
  "vcruntime140_1.dll": "1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f"
});
const runtimeFiles = new Set(["ai-expert.json", "auto-reply-state.json", "contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);
const databaseFilePattern = /\.(?:db(?:-wal|-shm)?|sqlite3?)$/i;

function isBlockedRuntimeFile(name) {
  const lower = String(name).toLowerCase();
  return runtimeFiles.has(lower) || databaseFilePattern.test(lower);
}

function insideRelease(target) {
  const resolved = path.resolve(target);
  return resolved.startsWith(`${releaseDir}${path.sep}`) && resolved !== releaseDir;
}

function removeGenerated(target) {
  if (!insideRelease(target)) throw new Error(`Refusing to remove path outside release: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

function sourceAllowed(source, edition) {
  const relative = path.relative(desktopDir, source).replaceAll("\\", "/");
  const name = path.basename(source);
  const lower = name.toLowerCase();
  if (isBlockedRuntimeFile(name) || lower.endsWith(".py") || lower.endsWith(".pyc") || lower.includes("self_check")) return false;
  if (relative.includes("/__pycache__/") || relative.includes("/libs/") || /(?:dump_data|wechat-dump|wx_key\.dll)/i.test(name)) return false;
  if (edition !== "test" && relative.startsWith("src/main/") && ["active-touch-dev-ipc.cjs", "preload.dev.cjs"].includes(name)) return false;
  if (name.endsWith(".dev.cjs")) {
    const allowed = ["state_machine.dev.cjs", "wechat_window_driver.dev.cjs"];
    if (edition === "test") allowed.push("active_touch_cli.dev.cjs", "preload.dev.cjs");
    return allowed.includes(name);
  }
  return true;
}

function resolveInstalledPackage(packageName, fromDir) {
  const parts = packageName.split("/");
  let current = path.resolve(fromDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ...parts);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Missing runtime package: ${packageName}`);
}

function copyRuntimePackageTree(packageName, appDir, fromDir = desktopDir, copied = new Map()) {
  const source = resolveInstalledPackage(packageName, fromDir);
  const existing = copied.get(packageName);
  if (existing) {
    if (existing !== source) throw new Error(`Conflicting runtime package versions: ${packageName}`);
    return;
  }
  copied.set(packageName, source);
  const target = path.join(appDir, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const packageJson = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    copyRuntimePackageTree(dependency, appDir, source, copied);
  }
}

function copyAppSource(appDir, edition) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(desktopDir, "package.json"), path.join(appDir, "package.json"));
  const rendererSource = path.join(desktopDir, edition === "test" ? "dist-development" : "dist-pilot");
  if (!fs.existsSync(path.join(rendererSource, "build-edition.json"))) throw new Error(`Missing renderer build: ${rendererSource}`);
  fs.cpSync(rendererSource, path.join(appDir, "dist"), { recursive: true });
  for (const relative of ["rpa", path.join("src", "main")]) {
    const source = path.join(desktopDir, relative);
    fs.cpSync(source, path.join(appDir, relative), {
      recursive: true,
      filter: (sourcePath) => sourceAllowed(sourcePath, edition)
    });
  }
  copyRuntimePackageTree("mammoth", appDir);
  const helperTarget = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
  fs.copyFileSync(helper, helperTarget);
  if (sha256(helperTarget) !== CONTACT_HELPER_SHA256) throw new Error("Packaged contact helper hash mismatch");
  const nativeLibTarget = path.join(appDir, "rpa", "contact_sync", "libs");
  fs.mkdirSync(nativeLibTarget, { recursive: true });
  for (const [name, expectedHash] of Object.entries(NATIVE_LIBRARY_SHA256)) {
    const target = path.join(nativeLibTarget, name);
    fs.copyFileSync(path.join(nativeLibDir, name), target);
    if (sha256(target) !== expectedHash) throw new Error(`Packaged ${name} hash mismatch`);
  }
  const databaseDecryptorTarget = path.join(nativeLibTarget, DATABASE_DECRYPTOR_NAME);
  fs.copyFileSync(path.join(nativeLibDir, DATABASE_DECRYPTOR_NAME), databaseDecryptorTarget);
  if (sha256(databaseDecryptorTarget) !== DATABASE_DECRYPTOR_SHA256) throw new Error(`Packaged ${DATABASE_DECRYPTOR_NAME} hash mismatch`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitText(args) {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function scanRelease(target) {
  const blocked = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const lower = entry.name.toLowerCase();
        if (isBlockedRuntimeFile(entry.name) || lower === "python.exe" || lower.endsWith(".py") || lower.includes("dump_data") || lower.includes("wechat-dump") || lower.includes("dt-ai-helper")) blocked.push(file);
        if (entry.isFile() && fs.statSync(file).size <= 5 * 1024 * 1024) {
          const content = fs.readFileSync(file, "utf8");
          if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(content)) blocked.push(file);
        }
      }
    }
  };
  visit(target);
  if (blocked.length) throw new Error(`Release contains blocked files or secrets:\n${blocked.join("\n")}`);
}

function removeLegacyProducts() {
  for (const name of ["小玺AI员工", "小玺AI员工-客户版", "小玺AI员工-受控试用版"]) {
    const directory = path.join(releaseDir, name);
    if (fs.existsSync(directory)) removeGenerated(directory);
    const zip = path.join(releaseDir, `${name}.zip`);
    if (fs.existsSync(zip)) fs.rmSync(zip, { force: true });
  }
}

function buildPortable(edition = "delivery") {
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported edition: ${edition}`);
  if (!fs.existsSync(path.join(electronDir, "electron.exe"))) throw new Error("Electron portable runtime is missing; run npm ci first");
  if (!fs.existsSync(helper) || sha256(helper) !== CONTACT_HELPER_SHA256) throw new Error("Pinned contact helper is missing or has the wrong hash");
  for (const [name, expectedHash] of Object.entries(NATIVE_LIBRARY_SHA256)) {
    const file = path.join(nativeLibDir, name);
    if (!fs.existsSync(file) || sha256(file) !== expectedHash) throw new Error(`${name} is missing or has the wrong hash`);
  }
  const databaseDecryptor = path.join(nativeLibDir, DATABASE_DECRYPTOR_NAME);
  if (!fs.existsSync(databaseDecryptor) || sha256(databaseDecryptor) !== DATABASE_DECRYPTOR_SHA256) {
    throw new Error(`${DATABASE_DECRYPTOR_NAME} is missing or has the wrong hash`);
  }

  const commit = gitText(["rev-parse", "HEAD"]);
  const dirty = Boolean(gitText(["status", "--porcelain"]));
  if (dirty) throw new Error("Refusing to build a portable release from a dirty worktree");

  const productName = edition === "test" ? "小玺AI员工-测试版" : "小玺AI员工";
  const target = path.join(releaseDir, productName);
  const zip = path.join(releaseDir, `${productName}.zip`);
  fs.mkdirSync(releaseDir, { recursive: true });
  removeLegacyProducts();
  removeGenerated(target);
  if (fs.existsSync(zip)) fs.rmSync(zip, { force: true });
  fs.cpSync(electronDir, target, { recursive: true });
  const electronExe = path.join(target, "electron.exe");
  fs.renameSync(electronExe, path.join(target, `${productName}.exe`));
  const appDir = path.join(target, "resources", "app");
  fs.rmSync(appDir, { recursive: true, force: true });
  copyAppSource(appDir, edition);

  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  const electronPackage = JSON.parse(fs.readFileSync(path.join(desktopDir, "node_modules", "electron", "package.json"), "utf8"));
  const manifest = {
    product: "小玺AI员工",
    edition,
    version: packageJson.version,
    commit,
    dirty,
    architecture: process.arch,
    electron: electronPackage.version,
    contactHelperSha256: CONTACT_HELPER_SHA256,
    wxKeySha256: NATIVE_LIBRARY_SHA256["wx_key.dll"],
    databaseDecryptorSha256: DATABASE_DECRYPTOR_SHA256,
    nativeLibrarySha256: NATIVE_LIBRARY_SHA256,
    verifiedWeixin: "4.1.11.24",
    releaseStage: "auto-reply-v2-ai-expert",
    commercialReady: false,
    builtAt: new Date().toISOString(),
    signed: false
  };
  fs.writeFileSync(path.join(target, "版本清单.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(target, "版本标识.txt"), edition === "test"
    ? "小玺AI员工 测试版\n用于联系人同步、主动触达、AI专家话术与全私聊自动回复内部验收；朋友圈等功能下一阶段开放。\n"
    : "小玺AI员工\n已完成联系人同步、主动触达、AI专家话术与全私聊自动回复；朋友圈等功能下一阶段开放，本包不代表完整商品。\n", "utf8");
  scanRelease(target);

  const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, "-C", releaseDir, productName], { encoding: "utf8", windowsHide: true });
  if (archive.status !== 0 || !fs.existsSync(zip)) throw new Error(archive.stderr || archive.stdout || "portable ZIP creation failed");
  console.log(`${edition} portable release built: ${zip}`);
  return { target, zip, manifest };
}

if (require.main === module) buildPortable(process.argv[2] || "delivery");

module.exports = { buildPortable, copyRuntimePackageTree };
