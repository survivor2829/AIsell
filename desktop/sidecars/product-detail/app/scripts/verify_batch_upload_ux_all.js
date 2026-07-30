// Run all dependency-light batch upload UX verifiers.
//
// This wrapper is useful on machines without Flask/pytest. It expects Node to
// be available. Python is optional; set PYTHON=/path/to/python to choose a
// specific interpreter. In Codex Desktop, this script also tries the bundled
// Python runtime. If a Python interpreter is found, the Python checks are
// required and fail the wrapper on regression.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const requiredCommands = [
  [process.execPath, ["scripts/verify_batch_upload_inline_js_syntax.js"]],
  [process.execPath, ["scripts/verify_batch_upload_runtime_smoke.js"]],
];

function run(cmd, args, options = {}) {
  const label = [cmd, ...args].join(" ");
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.error) {
    if (options.optional) {
      console.warn(`optional check skipped: ${label}`);
      console.warn(result.error.message);
      return false;
    }
    console.error(`failed to run: ${label}`);
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (options.optional) {
      console.warn(`optional check failed (${result.status}): ${label}`);
      return false;
    }
    console.error(`command failed (${result.status}): ${label}`);
    process.exit(result.status || 1);
  }
  return true;
}

for (const [cmd, args] of requiredCommands) {
  run(cmd, args);
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.PYTHON) {
    candidates.push(process.env.PYTHON);
  }
  candidates.push("python");
  if (process.env.USERPROFILE) {
    candidates.push(path.join(
      process.env.USERPROFILE,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      "python.exe"
    ));
  }
  return candidates;
}

let python = "";
for (const candidate of pythonCandidates()) {
  if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
    continue;
  }
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  if (probe.status === 0) {
    python = candidate;
    break;
  }
}

if (python) {
  console.log(`using Python static verifier: ${python}`);
  run(python, ["scripts/verify_batch_upload_ux_static.py"]);
  const sourceGuardRunner = String.raw`
import importlib.util
import pathlib

files = [
    "tests/test_batch_upload_ux.py",
    "tests/test_batch_progress_ui.py",
]
total = 0
failures = []

for file in files:
    path = pathlib.Path(file)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name, obj in sorted(vars(mod).items()):
        if isinstance(obj, type) and name.startswith("Test"):
            inst = obj()
            for method in sorted(n for n in dir(inst) if n.startswith("test_")):
                total += 1
                try:
                    getattr(inst, method)()
                except Exception as exc:
                    failures.append(f"{file}::{name}::{method}: {exc}")

if failures:
    print("\n".join(failures))
    raise SystemExit(1)

print(f"stdlib source guard tests passed: {total} tests across {len(files)} files")
`;
  run(python, ["-c", sourceGuardRunner]);
} else {
  console.warn("optional Python static check skipped: set PYTHON=/path/to/python to enable it");
}

console.log("all batch upload UX checks passed");
