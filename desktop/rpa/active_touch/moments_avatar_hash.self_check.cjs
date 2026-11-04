// WeChat 4.2 Moments (development machine 4.2.0.12, 2026-11-04): avatars are
// ~40 px while detection uses a 52 px box on a 4 px scan step. The detected box
// drifted 4 px after scrolling to the post's menu, its pixel hash changed, and
// the locked post was "not found" (moments_post_not_found) before any like.
// Real frames showed old hashes 690a.../ade7... and one tight hash 3bb3... for
// both. This replays the same geometry on a drawn avatar, not a real person.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { HARNESS } = require("../../scripts/issues-replay.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-avatar-hash-"));
const BOOT = Buffer.from('$ProgressPreference="SilentlyContinue";$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));. ([ScriptBlock]::Create($text))', "utf16le").toString("base64");
function powershell(script, env = {}) {
  const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", BOOT], {
    input: Buffer.from(script, "utf16le").toString("base64") + "\n", encoding: "utf8", windowsHide: true,
    timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, XIAOXI_FLIGHT_DIR: "", ...env }
  });
  assert.equal(child.status, 0, String(child.stderr).slice(-1500));
  return child.stdout.trim();
}
try {
  // Two frames: the avatar at (100,60), then scrolled up 50 px, on the feed background.
  const draw = (file, top) => `
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 320, 200
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::FromArgb(249, 249, 249))
for ($y = 0; $y -lt 40; $y++) { for ($x = 0; $x -lt 40; $x++) {
  $b.SetPixel(100 + $x, ${top} + $y, [System.Drawing.Color]::FromArgb((60 + $x * 4) % 256, (120 + $y * 3) % 256, (($x * $y) % 200) + 30)) } }
$g.Dispose(); $b.Save("${file.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()`;
  const before = path.join(dir, "before.png");
  const after = path.join(dir, "after.png");
  powershell(draw(before, 60));
  powershell(draw(after, 10));

  const call = "@{ old = (Get-MomentsPixelHash $frame $inputs.rect); new = (Get-MomentsAvatarHash $frame $inputs.rect); tight = (Get-MomentsTightAvatarRect $frame $inputs.rect); anchors = @(Get-MomentsAvatarAnchorHashes $frame $inputs.rect) }";
  const request = [
    { step: "before", image: before, call, inputs: { rect: { left: 96, top: 48, width: 52, height: 52 } } },
    { step: "after-drifted", image: after, call, inputs: { rect: { left: 92, top: 2, width: 52, height: 52 } } },
    { step: "background-only", image: before, call, inputs: { rect: { left: 220, top: 120, width: 52, height: 52 } } }
  ];
  const requestFile = path.join(dir, "request.json");
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const [first, second, empty] = JSON.parse(powershell(`${MOMENTS_VISUAL_READONLY_POWERSHELL}\n${HARNESS}`, { XIAOXI_REPLAY_REQUEST: requestFile }))
    .map((result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result.output; });

  assert.notEqual(first.old, second.old, "the detected-box hash drifts with a 4 px detection offset (the field failure)");
  assert.deepEqual([first.tight.left, first.tight.top, first.tight.width, first.tight.height], [100, 60, 40, 40]);
  assert.deepEqual([second.tight.left, second.tight.top, second.tight.width, second.tight.height], [100, 10, 40, 40]);
  assert.equal(first.new, second.new, "the tight avatar hash is the same before and after the scroll");
  assert.ok(first.anchors.some((hash) => second.anchors.includes(hash)), "anchor hashes overlap across the drift");
  assert.equal(empty.new, empty.old, "with no avatar inside, the detected box is used unchanged");
  console.log("moments avatar hash self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
