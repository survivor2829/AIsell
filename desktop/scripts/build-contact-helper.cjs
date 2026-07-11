const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const sourceDir = path.join(desktopDir, "rpa", "contact_sync");
const source = path.join(sourceDir, "wechat_contact_helper.py");
const buildDir = path.join(desktopDir, ".build");
const output = path.join(buildDir, "xiaoxi-contact-helper.exe");

function pythonCandidates() {
  const codexPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  const fromPath = spawnSync("where.exe", ["python.exe"], { encoding: "utf8", windowsHide: true });
  return [
    process.env.XIAOXI_BUILD_PYTHON,
    process.env.XIAOXI_CONTACT_SYNC_PYTHON,
    codexPython,
    ...(fromPath.status === 0 ? fromPath.stdout.split(/\r?\n/) : [])
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function usablePython() {
  for (const candidate of pythonCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const check = spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 10)"], { windowsHide: true });
    if (check.status === 0) return candidate;
  }
  return "";
}

const python = usablePython();
if (!python) throw new Error("Missing Python 3.10+ build runtime. Set XIAOXI_BUILD_PYTHON.");
const pyInstaller = spawnSync(python, ["-c", "import PyInstaller"], { windowsHide: true });
if (pyInstaller.status !== 0) throw new Error(`PyInstaller is missing. Run: \"${python}\" -m pip install -r requirements-build.txt`);

fs.rmSync(path.join(buildDir, "pyinstaller-work"), { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });
const result = spawnSync(python, [
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--noupx",
  "--name", "xiaoxi-contact-helper",
  "--paths", sourceDir,
  "--distpath", buildDir,
  "--workpath", path.join(buildDir, "pyinstaller-work"),
  "--specpath", buildDir,
  source
], { cwd: desktopDir, encoding: "utf8", windowsHide: true });
if (result.status !== 0 || !fs.existsSync(output)) throw new Error(result.stderr || result.stdout || "contact helper build failed");

const selfCheck = spawnSync(output, ["self-check"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
if (selfCheck.status !== 0) throw new Error(selfCheck.stderr || selfCheck.stdout || "contact helper self-check failed");
const payload = JSON.parse(selfCheck.stdout.trim());
if (payload.ok !== true) throw new Error("contact helper self-check returned not ok");
console.log(`contact helper built and verified: ${output}`);
