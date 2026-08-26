const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const { createBailianApiKeyStore } = require("../src/main/bailian-api-key.cjs");

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}.`);
    values[key.slice(2)] = value;
  }
  return values;
}

function findPython(explicit) {
  const candidates = [
    explicit,
    process.env.XIAOXI_CONTENT_ENGINE_DEV_PYTHON,
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

const args = readArgs(process.argv.slice(2));
const profile = String(args.profile || "test");
if (!new Set(["test", "delivery"]).has(profile)) throw new Error("--profile must be test or delivery.");
const profileRoot = path.join(app.getPath("appData"), `xiaoxi-active-touch-${profile}`);
app.setPath("userData", profileRoot);
const input = path.resolve(String(args.input || ""));
const output = path.resolve(String(args.output || ""));
if (!fs.existsSync(input)) throw new Error("--input must point to a pilot JSON file.");
if (!args.output) throw new Error("--output is required.");

app.whenReady().then(() => {
  const rootDir = path.join(profileRoot, "content-engine");
  const keyStore = createBailianApiKeyStore({ rootDir, safeStorage });
  const python = findPython(args.python);
  if (!python) throw new Error("A Python runtime is required for the Bailian motion pilot.");
  const result = spawnSync(
    python,
    [path.join(__dirname, "plan-bailian-motion-pilot.py"), "--input", input, "--output", output],
    {
      cwd: path.join(__dirname, ".."),
      input: keyStore.read(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000
    }
  );
  if (result.status !== 0) throw new Error((result.stderr || "Bailian motion planning failed.").trim());
  process.stdout.write(result.stdout || "");
}).then(
  () => app.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
);
