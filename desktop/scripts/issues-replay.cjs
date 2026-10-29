// Reruns today's recognition code on the exact frames and inputs a failure
// capsule recorded, on this computer. "Same as the field" proves the capsule
// reproduces the failure; after a fix, a changed result proves the fix covers it.
// Usage: npm.cmd run issues:replay -- <capsule id or prefix> [--out <dir>]
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEFAULT_OUT } = require("./issues-pull.cjs");
const { find } = require("./issues-show.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("../rpa/active_touch/moments_visual_probe.dev.cjs");

const BOOT = Buffer.from('$ProgressPreference="SilentlyContinue";$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));. ([ScriptBlock]::Create($text))', "utf16le").toString("base64");

// Recognition functions a flight step can name, with how to call them.
const REPLAYERS = {
  "Find-MomentsMenuDotsDetailed": {
    call: "Find-MomentsMenuDotsDetailed $frame (ConvertTo-ReplayValue $inputs.viewport) (ConvertTo-ReplayValue $inputs.avatars) (ConvertTo-ReplayValue $inputs.localBounds)",
    compare(recorded, replayed) {
      const centres = list => (list || []).map(menu => [Math.round(Number(menu.centerX)), Math.round(Number(menu.centerY))]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const left = centres(recorded.menus), right = centres(replayed.menus);
      const same = left.length === right.length && left.every(([x, y], index) => Math.abs(x - right[index][0]) <= 1 && Math.abs(y - right[index][1]) <= 1);
      return { same, field: left, now: right };
    }
  }
};

const HARNESS = String.raw`
function ConvertTo-ReplayValue($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [System.Management.Automation.PSCustomObject]) {
    $table = @{}
    foreach ($property in $value.PSObject.Properties) { $table[$property.Name] = ConvertTo-ReplayValue $property.Value }
    return $table
  }
  if ($value -is [System.Collections.IEnumerable] -and $value -isnot [string]) { return ,@($value | ForEach-Object { ConvertTo-ReplayValue $_ }) }
  return $value
}
$request = [IO.File]::ReadAllText($env:XIAOXI_REPLAY_REQUEST, [Text.Encoding]::UTF8) | ConvertFrom-Json
$results = @()
foreach ($item in $request) {
  $bitmap = [System.Drawing.Bitmap]::new($item.image)
  try {
    $copy = $bitmap.Clone([System.Drawing.Rectangle]::new(0, 0, $bitmap.Width, $bitmap.Height), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $data = $copy.LockBits([System.Drawing.Rectangle]::new(0, 0, $copy.Width, $copy.Height), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = [Math]::Abs([int]$data.Stride); $bytes = New-Object byte[] ($stride * $copy.Height)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    } finally { $copy.UnlockBits($data) }
    $frame = @{ ok = $true; bitmap = $copy; bytes = $bytes; stride = $stride; width = $copy.Width; height = $copy.Height; screenLeft = 0; screenTop = 0 }
    $inputs = $item.inputs
    $output = Invoke-Expression $item.call
    $results += ,@{ step = $item.step; ok = $true; output = $output }
  } catch {
    $results += ,@{ step = $item.step; ok = $false; error = $_.Exception.Message }
  } finally { $bitmap.Dispose() }
}
ConvertTo-Json @($results) -Depth 8 -Compress
`;

function replayable(directory) {
  const flightFile = path.join(directory, "attachments", "flight.json");
  if (!fs.existsSync(flightFile)) return [];
  const steps = JSON.parse(fs.readFileSync(flightFile, "utf8"));
  return steps.map(step => ({ step, replayer: REPLAYERS[step.note?.fn], image: step.image ? path.join(directory, "attachments", String(step.image).toLowerCase()) : "" }))
    .filter(item => item.replayer && item.step.lossless === true && item.image && fs.existsSync(item.image));
}

function replay(directory, { runPowerShell = runHarness } = {}) {
  const items = replayable(directory);
  if (!items.length) return { replayed: 0, results: [], verdict: "这个现场包没有可回放的识别记录（缺无损帧或识别输入），只能看截图，不能证实根因。" };
  const request = items.map(({ step, replayer, image }) => ({ step: `${step.ts} ${step.step}`, image, call: replayer.call, inputs: step.note }));
  const outputs = runPowerShell(request);
  const results = items.map((item, index) => {
    const output = outputs[index];
    if (!output?.ok) return { step: request[index].step, error: output?.error || "replay_failed" };
    return { step: request[index].step, ...item.replayer.compare(item.step.note, output.output) };
  });
  const failed = results.filter(result => result.error);
  const different = results.filter(result => !result.error && !result.same);
  const verdict = failed.length ? `有 ${failed.length} 步回放出错，先修回放本身。`
    : different.length ? `${different.length}/${results.length} 步用今天的代码得到不同结果：代码已改变这里的判断（修复生效），或现场与代码版本不符。`
      : `${results.length} 步全部与现场一致：在本机复现了客户电脑上的识别结果。`;
  return { replayed: results.length, results, verdict };
}

function runHarness(request) {
  const script = `${MOMENTS_VISUAL_READONLY_POWERSHELL}\n${HARNESS}`;
  // stdin carries the script itself, so the request travels in a file.
  const requestFile = path.join(require("node:os").tmpdir(), `xiaoxi-replay-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  let child;
  try {
    child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", BOOT], {
      input: Buffer.from(script, "utf16le").toString("base64") + "\n", encoding: "utf8", windowsHide: true, timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, XIAOXI_FLIGHT_DIR: "", XIAOXI_REPLAY_REQUEST: requestFile }
    });
  } finally { fs.rmSync(requestFile, { force: true }); }
  if (child.status !== 0) throw new Error(`replay harness failed: ${String(child.stderr || child.error).slice(-600)}`);
  return JSON.parse(child.stdout.trim());
}

module.exports = { replay, replayable, REPLAYERS, HARNESS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  const out = index >= 0 ? args[index + 1] : DEFAULT_OUT;
  const query = args.find((value, position) => !value.startsWith("--") && position !== index + 1) || "";
  try {
    const directory = find(out, query);
    const result = replay(directory);
    for (const item of result.results) console.log(item.error ? `✗ ${item.step} ${item.error}` : `${item.same ? "=" : "≠"} ${item.step} 现场 ${JSON.stringify(item.field)} 现在 ${JSON.stringify(item.now)}`);
    console.log(result.verdict);
    // After a fix is verified, keep this field case so issues:verify reruns it.
    if (args.includes("--keep") && result.replayed && !result.results.some(item => item.error)) {
      console.log(`已保存为现场回放用例：${require("./issues-verify.cjs").keep(directory, out, result)}`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
