const fs = require("node:fs");
const path = require("node:path");
const { build, Platform, Arch } = require("electron-builder");
const { fileHash } = require("../src/main/cloud-maintenance.cjs");

async function main() {
  const desktop = path.resolve(__dirname, "..");
  const root = path.join(desktop, ".build", "cloud-smoke", String(Date.now()));
  fs.mkdirSync(root, { recursive: true });
  for (const version of ["0.1.0", "0.1.1"]) {
    const project = path.join(root, version);
    fs.mkdirSync(path.join(project, "src", "main"), { recursive: true });
    fs.mkdirSync(path.join(project, "src", "shared"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "aihuoke-maintenance-smoke", version, main: "main.cjs", description: "Isolated updater smoke test", author: "AIhuoke", private: true }));
    fs.copyFileSync(path.join(__dirname, "cloud-smoke-app.cjs"), path.join(project, "main.cjs"));
    for (const file of ["cloud-maintenance.cjs", "cloud-transport.cjs", "cloud-config.cjs", "cloud-test-ca.crt", "diagnostics.cjs", "atomic-file.cjs"]) fs.copyFileSync(path.join(desktop, "src", "main", file), path.join(project, "src", "main", file));
    for (const file of ["cloud-contract.cjs", "visual-send-receipt.cjs"]) fs.copyFileSync(path.join(desktop, "src", "shared", file), path.join(project, "src", "shared", file));
    const output = path.join(project, "output");
    await build({ projectDir: project, targets: Platform.WINDOWS.createTarget("nsis", Arch.x64), config: {
      appId: "com.aihuoke.maintenance.smoke", productName: "AIhuoke Maintenance Smoke",
      electronVersion: require("electron/package.json").version, electronDist: path.join(desktop, "node_modules", "electron", "dist"),
      npmRebuild: false, asar: false, directories: { output },
      win: { artifactName: `maintenance-smoke-${version}.exe`, signAndEditExecutable: false },
      nsis: { oneClick: true, perMachine: false, runAfterFinish: true, createDesktopShortcut: false, createStartMenuShortcut: false, deleteAppDataOnUninstall: false, differentialPackage: false }
    } });
    const installer = path.join(output, `maintenance-smoke-${version}.exe`);
    fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ appId: "com.aihuoke.maintenance.smoke", artifactType: "internal-evaluation", version, sha256: await fileHash(installer), size: fs.statSync(installer).size }, null, 2));
  }
  console.log(`SMOKE_ROOT=${root}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

