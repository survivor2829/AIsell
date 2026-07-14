const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const releaseDir = path.resolve(desktopDir, "..", "release");
const isPackagedApp = path.basename(desktopDir).toLowerCase() === "app" && path.basename(path.dirname(desktopDir)).toLowerCase() === "resources";
const releaseAppDirs = isPackagedApp ? [desktopDir] : [
  path.resolve(desktopDir, "..", "release", "小玺AI员工-测试版", "resources", "app"),
  path.resolve(desktopDir, "..", "release", "小玺AI员工-交付版", "resources", "app")
];
const relativeRuntimeFiles = [
  path.join("ai-expert.json"),
  path.join("auto-reply-state.json"),
  path.join("rpa", "active_touch", "contacts.json"),
  path.join("rpa", "active_touch", "touch_task.json"),
  path.join("rpa", "active_touch", "run_logs.jsonl"),
  path.join("rpa", "active_touch", "state.json"),
  path.join("rpa", "contact_sync", "state.json")
];
const forbidden = [
  ...relativeRuntimeFiles.map((file) => path.join(desktopDir, file)),
  ...releaseAppDirs.flatMap((root) => relativeRuntimeFiles.map((file) => path.join(root, file))),
  ...[desktopDir, ...releaseAppDirs].flatMap((root) => [
    path.join(root, ".env.ai.local"),
    path.join(root, "data", "ai-expert.json"),
    path.join(root, "data", "auto_reply", "auto-reply-state.json"),
    path.join(root, "data", "deepseek-api-key.bin")
  ]),
  ...(isPackagedApp ? [path.join(desktopDir, ".env.ai.local")] : [])
].filter((file) => fs.existsSync(file));

function findEnvFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "dist-development", ".vite"].includes(entry.name) ? [] : findEnvFiles(file);
    return entry.isFile() && /^\.env(?:\.|$)/.test(entry.name) ? [file] : [];
  });
}

forbidden.push(...findEnvFiles(desktopDir), ...findEnvFiles(releaseDir));

if (forbidden.length) {
  console.error("Build blocked: runtime or secret files remain in source/release:");
  forbidden.forEach((file) => console.error(`- ${path.relative(path.resolve(desktopDir, ".."), file)}`));
  process.exit(1);
}

function scanForApiKeys(root) {
  if (!fs.existsSync(root)) return [];
  const hits = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "dist-development", ".vite"].includes(entry.name)) hits.push(...scanForApiKeys(file));
    }
    else if (entry.isFile() && fs.statSync(file).size <= 5 * 1024 * 1024) {
      const content = fs.readFileSync(file, "utf8");
      if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(content)) hits.push(file);
    }
  }
  return hits;
}

const keyHits = [...scanForApiKeys(desktopDir), ...scanForApiKeys(releaseDir)];
if (keyHits.length) {
  console.error("Build blocked: API Key-like content found in source or release:");
  keyHits.forEach((file) => console.error(`- ${path.relative(path.resolve(desktopDir, ".."), file)}`));
  process.exit(1);
}

console.log("clean-runtime check passed");
