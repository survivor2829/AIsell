// Lists every request name the main process can answer, for the 免费体验 classification
// (src/main/demo-mode-channels.cjs). The self-check fails when a name is not classified, so a new
// feature has to decide whether the trial may use it (2026-11-18: guessing from words in the name
// let camelCase and noun-named actions through and refused noun-named reads).
const fs = require("node:fs");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "src", "main");
const CHANNEL = /["'`]([a-z][a-z0-9-]*):([a-zA-Z][a-zA-Z0-9-]*)["'`]/g;

// Keys at the top level of the object literal that starts at `open` (the "{").
function objectKeys(source, open) {
  const keys = [];
  let depth = 0, i = open, quote = "";
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) { if (ch === "\\") i += 1; else if (ch === quote) quote = ""; continue; }
    if (depth === 1 && (ch === "\"" || ch === "'") && /[{,\s]/.test(source[i - 1])) {
      const key = /^(["'])([A-Za-z0-9_-]+)\1\s*:/.exec(source.slice(i));
      if (key) { keys.push(key[2]); i += key[2].length + 1; continue; }
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") { depth -= 1; if (depth === 0) break; }
    else if (depth === 1 && /[A-Za-z_]/.test(ch) && /[{,\s]/.test(source[i - 1])) {
      const match = /^(?:async\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:(,}]/.exec(source.slice(i));
      if (match && !["async", "return", "const", "let", "await"].includes(match[1])) keys.push(match[1]);
      if (match) i += match[0].length - 2;
    }
  }
  return keys;
}

function scanTrialChannels() {
  const found = new Set();
  for (const name of fs.readdirSync(MAIN)) {
    if (!name.endsWith(".cjs") || name.includes("self_check")) continue;
    const source = fs.readFileSync(path.join(MAIN, name), "utf8");
    for (const match of source.matchAll(CHANNEL)) found.add(`${match[1]}:${match[2]}`);
    // ipcMain.handle(`area:${name}`) over `const methods = { … }`.
    for (const match of source.matchAll(/ipcMain\.handle\(`([a-z][a-z0-9-]*):\$\{name\}`/g)) {
      const methods = source.indexOf("const methods = {");
      if (methods >= 0) for (const key of objectKeys(source, source.indexOf("{", methods))) found.add(`${match[1]}:${key}`);
      // for (const name of ['list', 'play']) ipcMain.handle(`area:${name}`)
      const list = /for \(const name of \[([^\]]+)\]\) ipcMain\.handle\(`/.exec(source);
      if (list) for (const item of list[1].matchAll(/['"]([a-zA-Z-]+)['"]/g)) found.add(`${match[1]}:${item[1]}`);
    }
    // wechat-workflow: handle("name", action) helpers.
    const helper = /function handle\(name[^)]*\)\s*\{\s*ipcMain\.handle\(`([a-z-]+):\$\{name\}`/.exec(source);
    if (helper) for (const match of source.matchAll(/\bhandle\(\s*["']([a-zA-Z-]+)["']/g)) found.add(`${helper[1]}:${match[1]}`);
    // DIGITAL_HUMAN_CHANNELS-style maps built from a list of names with a fixed area.
    // ("content-engine:batch-" + each name in narrated-batch-ipc).
    for (const built of source.matchAll(/Object\.fromEntries\(\[([\s\S]*?)\]\.map\(\(name\) => \[name, `([a-z-]+):([a-z-]*)\$\{name\}`\]\)/g)) {
      for (const item of built[1].matchAll(/["']([a-zA-Z-]+)["']/g)) found.add(`${built[2]}:${built[3]}${item[1]}`);
    }
  }
  return [...found].sort();
}

module.exports = { scanTrialChannels };
if (require.main === module) console.log(scanTrialChannels().join("\n"));
