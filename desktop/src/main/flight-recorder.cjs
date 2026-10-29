// Collects what the WeChat workers recorded before a failure: the frames they
// recognised, what they read (OCR, menu candidates, inputs), the window list
// and control tree at the failure, and the task passport of the same moment.
// Workers write these under XIAOXI_FLIGHT_DIR (failure-evidence.cjs); only one
// WeChat operation runs at a time, so the minutes before a failure belong to it.
const fs = require("node:fs");
const path = require("node:path");

const FLIGHT_NAME = /^(\d{8}T\d{9})-\d+-\d{4}-([a-z0-9_.-]+)\.(jpg|png|json)$/;
const PASSPORT_NAME = /-(raw-reading|expected)\.json$|-screen\.png$/;

function stampTime(stamp) {
  const match = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3})$/.exec(stamp);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]) : NaN;
}

function flightDirectory(rootDir) { return path.join(rootDir, "flight-recorder"); }

// Newest steps first within the window, then oldest-first for reading. Replay
// frames (lossless menu scans) and the failure screen are always kept.
function collectFlight(rootDir, { at = Date.now(), windowMs = 10 * 60_000, maxSteps = 30, maxBytes = 15 * 1024 * 1024 } = {}) {
  const directory = flightDirectory(rootDir);
  let names;
  try { names = fs.readdirSync(directory); } catch { return { steps: [], files: [] }; }
  const notes = names.filter(name => name.endsWith(".json") && FLIGHT_NAME.test(name))
    .map(name => ({ name, ts: stampTime(FLIGHT_NAME.exec(name)[1]) }))
    .filter(item => item.ts <= at + 5_000 && at - item.ts <= windowMs)
    .sort((a, b) => b.ts - a.ts);
  const steps = [], files = [];
  let bytes = 0;
  for (const item of notes) {
    if (steps.length >= maxSteps) break;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(directory, item.name), "utf8")); } catch { continue; }
    const image = typeof meta.image === "string" && FLIGHT_NAME.test(meta.image) ? path.join(directory, meta.image) : "";
    let size = 0;
    try { size = image ? fs.statSync(image).size : 0; } catch { meta.image = ""; }
    const essential = /^failure\./.test(meta.step) || meta.lossless === true;
    if (size && bytes + size > maxBytes && !essential) { meta.image = ""; meta.imageOmitted = "size_limit"; size = 0; }
    if (size) { bytes += size; files.push({ name: meta.image, file: image }); }
    steps.push(meta);
  }
  return { steps: steps.reverse(), files };
}

// The passport written for the same task failure: real screen, raw reading, expectation.
function collectPassports(rootDir, { at = Date.now(), windowMs = 10 * 60_000, maxSets = 2 } = {}) {
  const root = path.join(rootDir, "task-passports");
  const found = [];
  const walk = (directory, depth) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (entry.isFile() && PASSPORT_NAME.test(entry.name)) {
        try {
          const stat = fs.statSync(file);
          if (stat.mtimeMs <= at + 60_000 && at - stat.mtimeMs <= windowMs && stat.size <= 12 * 1024 * 1024) found.push({ file, name: entry.name, at: stat.mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  const sets = new Map();
  for (const item of found.sort((a, b) => b.at - a.at)) {
    const base = item.name.replace(PASSPORT_NAME, "");
    if (!sets.has(base) && sets.size >= maxSets) continue;
    sets.set(base, [...(sets.get(base) || []), item]);
  }
  return [...sets.values()].flat().map(item => ({ name: `passport-${item.name}`, file: item.file }));
}

// Paths that report a failure without the PowerShell failure writer (auto
// reply, JS-side checks) still get the screen, window list and control tree,
// taken seconds after the failure when no worker captured one.
function hasRecentFailureScreen(rootDir, at = Date.now()) {
  return collectFlight(rootDir, { at, windowMs: 60_000, maxSteps: 60 }).steps.some(step => /^failure\./.test(step.step));
}

function captureFailureScreen(reason, { spawnProcess = require("node:child_process").spawn, timeoutMs = 15_000 } = {}) {
  if (!process.env.XIAOXI_FLIGHT_DIR) return Promise.resolve(false);
  const { FAILURE_SCREEN_SCRIPT } = require("../../rpa/active_touch/failure-evidence.cjs");
  const safe = /^[a-z0-9_.:-]{1,100}$/.test(String(reason)) ? reason : "unclassified";
  const script = `${FAILURE_SCREEN_SCRIPT}\nSave-XiaoxiFailureScreen 'late' '${safe}' ''`;
  const boot = Buffer.from('$ProgressPreference="SilentlyContinue";$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));. ([ScriptBlock]::Create($text))', "utf16le").toString("base64");
  return new Promise(resolve => {
    let child;
    try { child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", boot], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0); });
    child.stdin.end(Buffer.from(script, "utf16le").toString("base64"));
  });
}

module.exports = { collectFlight, collectPassports, flightDirectory, stampTime, hasRecentFailureScreen, captureFailureScreen };
