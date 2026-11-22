const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");

// At 200% one 朋友圈 「··」 button drew three components, paired (1,2) and (2,3) with centres just past the
// 6 px duplicate rule: two menus for one button, neither stable across two frames, so every probe read
// "moments_post_changed" and a campaign paused (dev PC 2026-11-22). A dot already in an accepted button
// belongs to it, whatever the scale. Two real buttons, one per post, stay two.
function frame(dots) {
  const width = 800, height = 600, stride = width * 4;
  const bytes = Buffer.alloc(stride * height, 255);
  for (const [left, top, w, h] of dots) {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
      const o = y * stride + x * 4; bytes[o] = 90; bytes[o + 1] = 90; bytes[o + 2] = 90; bytes[o + 3] = 255;
    }
  }
  return { bytes, stride, width, height };
}
const cases = {
  // Three equal components 4 px apart on one baseline: one button.
  threeComponents: frame([[700, 300, 6, 6], [710, 300, 6, 6], [720, 300, 6, 6]]),
  // Two buttons on two posts: two menus.
  twoButtons: frame([[700, 200, 6, 6], [710, 200, 6, 6], [700, 420, 6, 6], [710, 420, 6, 6]])
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-menu-dots-"));
let run;
try {
  const lines = Object.entries(cases).map(([name, f]) => {
    const file = path.join(dir, `${name}.bin`);
    fs.writeFileSync(file, f.bytes);
    return `$out["${name}"] = @((Find-MomentsMenuDotsDetailed @{ ok = $true; bytes = [IO.File]::ReadAllBytes("${file}"); stride = ${f.stride}; width = ${f.width}; height = ${f.height} } @{ left = 0.0; top = 0.0; width = ${f.width}.0; height = ${f.height}.0 }).menus).Count`;
  });
  const script = path.join(dir, "probe.ps1");
  fs.writeFileSync(script, `﻿${MOMENTS_VISUAL_READONLY_POWERSHELL}
function Test-XiaoxiFlight { return $false }
$out = @{}
${lines.join("\n")}
$out | ConvertTo-Json -Compress
`, "utf8");
  run = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 120000 });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
assert.equal(run.status, 0, run.stderr || run.stdout);
const counts = JSON.parse(run.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
assert.equal(counts.threeComponents, 1, "three components of one button: one menu");
assert.equal(counts.twoButtons, 2, "one button per post: two menus");
console.log("moments menu dots self-check passed: a button drawn in three components is one menu");
