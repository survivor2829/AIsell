const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WECHAT_SESSION_LIST_EDGE_POWERSHELL } = require("./wechat_session_list_edge.cjs");

// Auto-reply measured everything from a chat list assumed to be 300 dp wide; on customer PCs it was 0.27
// to 0.62 of the window (field strips 2026-11-15..21). The edge is now measured from the frame. Synthetic
// WeChat frames: icon bar, chat list with avatars, text and a selected row, chat with bubbles.
function frame({ scale, share, divider = false, popup = false, noList = false }) {
  const w = Math.round(1120 * scale), h = Math.round(760 * scale), stride = w * 4;
  const bytes = Buffer.alloc(stride * h);
  const nav = Math.round(67 * scale), edge = Math.round(w * share);
  const s = (v) => v * scale;
  const rowH = Math.round(s(64)), av = Math.round(s(40)), period = Math.round(s(90));
  const chatLeft = noList ? nav : edge;
  for (let y = 0; y < h; y++) {
    const inRow = y % rowH;
    const selected = !noList && y >= s(150) && y < s(150) + rowH;
    for (let x = 0; x < w; x++) {
      let v = x < nav ? 228 : noList || x >= edge ? 245 : selected ? 120 : 236;
      if (!noList && x >= nav && x < edge) {
        if (x >= nav + s(12) && x < nav + s(12) + av && inRow >= s(12) && inRow < s(12) + av) v = (x * 7 + y * 13) % 200;
        else if (x >= nav + s(64) && x < edge - s(50) && inRow >= s(18) && inRow < s(30) && x % 5 < 2) v = 40;
      }
      if (x >= chatLeft + s(60) && x < chatLeft + s(360) && y % period >= s(20) && y % period < s(60)) v = x % 6 < 2 ? 30 : 255;
      if (divider && x === edge) v = 214;
      if (popup && x >= edge - s(120) && x < edge + s(200) && y >= s(60) && y < s(600)) v = y % 9 < 3 ? 60 : 252;
      const o = y * stride + x * 4;
      bytes[o] = v; bytes[o + 1] = v; bytes[o + 2] = v; bytes[o + 3] = 255;
    }
  }
  return { bytes, stride, w, h, edge, scale };
}

const cases = {
  "100": { scale: 1, share: 0.275 },
  "125_wide_list": { scale: 1.25, share: 0.342, divider: true },
  "200": { scale: 2, share: 0.273 },
  "225_full_screen": { scale: 2.25, share: 0.615, divider: true },
  popup_over_edge: { scale: 1, share: 0.275, popup: true },
  icon_bar_only: { scale: 1, share: 0.275, noList: true }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-session-list-edge-"));
let run;
const frames = {};
try {
  const lines = [];
  for (const [name, options] of Object.entries(cases)) {
    const f = frames[name] = frame(options);
    const file = path.join(dir, `${name}.bin`);
    fs.writeFileSync(file, f.bytes);
    lines.push(`$out["${name}"] = Get-XiaoxiSessionListRight @{ bytes = [IO.File]::ReadAllBytes("${file}"); stride = ${f.stride}; width = ${f.w}; height = ${f.h} } ${f.scale}`);
  }
  const script = path.join(dir, "probe.ps1");
  fs.writeFileSync(script, `﻿${WECHAT_SESSION_LIST_EDGE_POWERSHELL}
$out = @{}
${lines.join("\n")}
$out["no_frame"] = Get-XiaoxiSessionListRight $null 1.0
$out | ConvertTo-Json -Compress
`, "utf8");
  run = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 120000 });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
assert.equal(run.status, 0, run.stderr || run.stdout);
assert.equal(run.stderr.trim(), "", run.stderr);
const found = JSON.parse(run.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
for (const name of ["100", "125_wide_list", "200", "225_full_screen"]) {
  const { edge, scale } = frames[name];
  assert.ok(Math.abs(found[name] - edge) <= Math.max(1, Math.round(scale)) + 1, `${name}: the list edge is found where it is (${found[name]} vs ${edge})`);
}
assert.equal(found.popup_over_edge, -1, "a popup over the edge: not found, the caller keeps its estimate");
assert.equal(found.icon_bar_only, -1, "the icon bar's edge is never taken for the list's");
assert.equal(found.no_frame, -1, "no frame: not found");

// Both auto-reply scripts measure from the frame they read; the field report says which was used.
const driver = fs.readFileSync(path.join(__dirname, "wechat_auto_reply_visual_driver.dev.cjs"), "utf8");
const send = fs.readFileSync(path.join(__dirname, "wechat_auto_reply_visual_send.dev.cjs"), "utf8");
assert.match(driver, /\$sidebarRight = Get-AutoReplyVisualSidebarRight \(\[double\]\$windowRect\.Width\) \$windowDpi \$frame\r?\n/u, "the scan measures from its frame");
assert.match(driver, /sidebarSource = \[string\]\$script:AutoReplyVisualSidebarSource/u, "and reports whether it measured");
for (const name of ["verifyFrame", "frame", "fresh"]) {
  assert.match(send, new RegExp(`Get-VisualSendSidebarRight \\(\\[double\\]\\$${name}\\.width\\) \\$\\w+ \\$${name}\\r?\\n`, "u"), `the send measures from $${name}`);
}
const { sanitizeStructuredScanDiagnostics } = require("../../src/main/auto-reply-diagnostics.cjs");
const reported = sanitizeStructuredScanDiagnostics({ window: { x: 0, y: 0, width: 1120, height: 760, sidebarRight: 308, sidebarSource: "measured" } }).window;
assert.deepEqual([reported.sidebar_right, reported.sidebar_source], [308, "measured"]);
assert.equal(sanitizeStructuredScanDiagnostics({ window: { width: 1, sidebarSource: "elsewhere" } }).window.sidebar_source, undefined, "only the two known words");
console.log("wechat session list edge self-check passed: the chat list's edge is measured, never guessed past a popup or the icon bar");

// OCR calibration (moments_visual_probe.dev.cjs): text resampled to about 28 px from the window's DPI,
// never past Windows OCR's image limit for the whole window, left alone when already close. On the dev PC
// at 100% a contact's name came back with two of three characters wrong at 1×, right at 2×.
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const factorStart = MOMENTS_VISUAL_READONLY_POWERSHELL.indexOf("function Get-MomentsTextOcrFactor");
const factorEnd = MOMENTS_VISUAL_READONLY_POWERSHELL.indexOf("function Get-MomentsResampledOcrObservation", factorStart);
assert.ok(factorStart > 0 && factorEnd > factorStart);
const factorRun = spawnSync("powershell.exe", ["-NoProfile", "-Command", `${MOMENTS_VISUAL_READONLY_POWERSHELL.slice(factorStart, factorEnd)}
@(@(1.0, 1120, 760), @(1.25, 1400, 950), @(1.5, 1680, 1140), @(1.75, 1960, 1330), @(2.0, 2240, 1520), @(2.25, 2520, 1710), @(2.5, 2800, 1900), @(3.0, 3360, 2280), @(1.0, 1600, 1000)) |
  ForEach-Object { Get-MomentsTextOcrFactor $_[0] $_[1] $_[2] } | ConvertTo-Json -Compress`], { encoding: "utf8", timeout: 60000 });
assert.equal(factorRun.status, 0, factorRun.stderr);
const factors = JSON.parse(factorRun.stdout.trim().split(/\r?\n/u).at(-1));
assert.deepEqual(factors, [2, 1.6, 1.333, 1, 1, 1, 0.8, 0.667, 1.625], "100% 2×, 125% 1.6×, 150% 1.33×, 175–225% as is, 250% 0.8×, 300% 0.67×; a wide window stays inside the OCR limit");
for (const [scale, width] of [[1, 1120], [1.25, 1400], [1.5, 1680], [2.5, 2800], [3, 3360], [1, 1600]]) {
  const factor = factors[[1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3].indexOf(scale)] ?? factors.at(-1);
  if (width === 1600) assert.ok(width * factors.at(-1) <= 2600);
  else assert.ok(width * factor <= 2600 && 14 * scale * factor >= 21, `${scale}: text at least 21 px and the image within the limit`);
}
