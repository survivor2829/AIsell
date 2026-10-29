const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { FAILURE_EVIDENCE_SCRIPT, FAILURE_SCREEN_SCRIPT } = require("./failure-evidence.cjs");
const { WECHAT_CLIPBOARD_POWERSHELL } = require("./wechat_clipboard.cjs");

// Antivirus engines scan each PowerShell script as a whole before it runs. On
// 2026-10-29 Defender blocked the clipboard self-check script as malicious once
// the shared prelude also held whole-screen capture and window-title listing;
// the real worker scripts still parsed, so which combinations trip it is not
// predictable. A block stops the WeChat task itself, so the capture lives in
// its own script (the structural rule below is the guarantee), and every
// worker script is also parsed, without running, with the prelude it gets.
const boot = Buffer.from('$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));try{[void][ScriptBlock]::Create($text);"parsed"}catch{"blocked: "+$_.Exception.GetType().Name}', "utf16le").toString("base64");
const scripts = [["failure screen capture", FAILURE_SCREEN_SCRIPT], ["prelude with clipboard", `${FAILURE_EVIDENCE_SCRIPT}\n${WECHAT_CLIPBOARD_POWERSHELL}`]];
for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith(".cjs") && !name.includes("self_check"))) {
  let exported;
  try { exported = require(path.join(__dirname, file)); } catch { continue; }
  for (const [key, value] of Object.entries(exported || {})) {
    if (typeof value === "string" && value.length > 2000 && /function [A-Z][a-z]+-/u.test(value) && value !== FAILURE_SCREEN_SCRIPT) {
      scripts.push([`${file} ${key}`, `${FAILURE_EVIDENCE_SCRIPT}\n${value}`]);
    }
  }
}
assert.ok(scripts.length > 10, "worker scripts were found");
for (const [name, text] of scripts) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", boot],
    { input: Buffer.from(text, "utf16le").toString("base64"), encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(String(result.stdout || "").trim(), "parsed", `${name} must not be blocked by antivirus or fail to parse: ${String(result.stdout || result.stderr).slice(0, 300)}`);
}
assert.ok(!/CopyFromScreen|EnumWindows|UIAutomationClient/u.test(FAILURE_EVIDENCE_SCRIPT), "the shared worker prelude never captures the screen or lists windows");
console.log(`worker antivirus self-check passed: ${scripts.length} scripts parse with the shared prelude`);
