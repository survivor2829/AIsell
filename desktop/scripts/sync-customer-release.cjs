const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const releaseDir = path.resolve(desktopDir, "..", "release");
const legacyDir = path.join(releaseDir, "小玺AI员工");
const customerDir = path.join(releaseDir, "小玺AI员工-客户版");
const customerAppDir = path.join(customerDir, "resources", "app");

if (!fs.existsSync(customerDir)) {
  if (!fs.existsSync(legacyDir)) throw new Error("Missing portable Electron shell: release/小玺AI员工");
  // ponytail: copy the portable shell because Windows may lock the old executable while it is running.
  fs.cpSync(legacyDir, customerDir, { recursive: true });
}

fs.rmSync(customerAppDir, { recursive: true, force: true });
fs.mkdirSync(customerAppDir, { recursive: true });

for (const relativePath of ["package.json", "dist", "rpa", path.join("src", "main")]) {
  const source = path.join(desktopDir, relativePath);
  const target = path.join(customerAppDir, relativePath);
  fs.cpSync(source, target, {
    recursive: true,
    filter: (sourcePath) => !sourcePath.endsWith(".dev.cjs") && !sourcePath.endsWith("active-touch-dev-ipc.cjs") && !sourcePath.endsWith("self_check.cjs")
  });
}

const oldExe = path.join(customerDir, "小玺AI员工.exe");
const customerExe = path.join(customerDir, "小玺AI员工-客户版.exe");
if (fs.existsSync(oldExe) && !fs.existsSync(customerExe)) fs.renameSync(oldExe, customerExe);
fs.writeFileSync(path.join(customerDir, "版本标识.txt"), "小玺AI员工 客户版\n真实发送实验模块未包含。\n");
console.log(`customer release synced: ${customerDir}`);
