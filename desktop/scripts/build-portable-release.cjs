const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(projectDir, "release");
const electronDir = path.join(desktopDir, "node_modules", "electron", "dist");
const helper = path.join(desktopDir, ".build", "xiaoxi-contact-helper.exe");
const runtimeFiles = new Set(["contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);
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
  if (relative.startsWith("src/main/") && ["active-touch-dev-ipc.cjs", "preload.dev.cjs"].includes(name)) return false;
  if (name.endsWith(".dev.cjs")) {
    return edition === "pilot" && ["state_machine.dev.cjs", "wechat_window_driver.dev.cjs"].includes(name);
  }
  return true;
}

function copyAppSource(appDir, edition) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(desktopDir, "package.json"), path.join(appDir, "package.json"));
  const rendererSource = path.join(desktopDir, edition === "pilot" ? "dist-pilot" : "dist");
  if (!fs.existsSync(path.join(rendererSource, "build-edition.json"))) throw new Error(`Missing renderer build: ${rendererSource}`);
  fs.cpSync(rendererSource, path.join(appDir, "dist"), { recursive: true });
  for (const relative of ["rpa", path.join("src", "main")]) {
    const source = path.join(desktopDir, relative);
    fs.cpSync(source, path.join(appDir, relative), {
      recursive: true,
      filter: (sourcePath) => sourceAllowed(sourcePath, edition)
    });
  }
  const helperTarget = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
  fs.copyFileSync(helper, helperTarget);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitText(args) {
  const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function scanRelease(target) {
  const blocked = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const lower = entry.name.toLowerCase();
        if (isBlockedRuntimeFile(entry.name) || lower === "python.exe" || lower.endsWith(".py") || lower === "wx_key.dll" || lower.includes("dump_data") || lower.includes("wechat-dump") || lower.includes("dt-ai-helper")) blocked.push(file);
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

function buildPortable(edition = "customer") {
  if (!["customer", "pilot"].includes(edition)) throw new Error(`Unsupported edition: ${edition}`);
  if (!fs.existsSync(path.join(electronDir, "electron.exe"))) throw new Error("Electron portable runtime is missing; run npm ci first");
  if (!fs.existsSync(helper)) throw new Error("Contact helper is missing; run npm run build:helper first");

  const productName = edition === "pilot" ? "小玺AI员工-受控试用版" : "小玺AI员工-客户版";
  const target = path.join(releaseDir, productName);
  const zip = path.join(releaseDir, `${productName}.zip`);
  fs.mkdirSync(releaseDir, { recursive: true });
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
    commit: gitText(["rev-parse", "HEAD"]),
    dirty: Boolean(gitText(["status", "--porcelain"])),
    architecture: process.arch,
    electron: electronPackage.version,
    contactHelperSha256: sha256(helper),
    verifiedWeixin: "4.1.11.24",
    builtAt: new Date().toISOString(),
    signed: false
  };
  fs.writeFileSync(path.join(target, "版本清单.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(target, "版本标识.txt"), edition === "pilot"
    ? "小玺AI员工 受控试用版\n每批最多50个冻结联系人；仅用于本人测试号或明确同意的内部试用。\n"
    : "小玺AI员工 客户版\n只写草稿，不包含真实发送执行模块。\n", "utf8");
  scanRelease(target);

  const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, "-C", releaseDir, productName], { encoding: "utf8", windowsHide: true });
  if (archive.status !== 0 || !fs.existsSync(zip)) throw new Error(archive.stderr || archive.stdout || "portable ZIP creation failed");
  console.log(`${edition} portable release built: ${zip}`);
  return { target, zip, manifest };
}

if (require.main === module) buildPortable(process.argv[2] || "customer");

module.exports = { buildPortable };
