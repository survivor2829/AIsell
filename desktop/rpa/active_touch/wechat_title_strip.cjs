// AI 看图 for the chat title (2026-11-21). The rules read the title from a fixed band (34–74 logical
// pixels below the window top); on a 225% laptop (8a37d741, 1.3.46) WeChat drew the title at about
// 106, so the band held only grey, the right chat was open and every name-search contact was skipped
// as search_result_not_opened. Instead of a new fixed band, the whole top strip of the window is shown
// to the vision model, which says what the title is and where; the code then decides.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WECHAT_SCREEN_PIXELS_POWERSHELL } = require("./wechat_screen_pixels.cjs");
const { runPowerShell } = require("./wechat_window_driver.cjs");
const { decodePng, sameRegion } = require("./png_pixels.cjs");

const TITLE_CAPTURE_NAME = /^xiaoxi-title-capture-[a-f0-9]{32}\.png$/u;

// The strip: the full window width, from the window top down to 30% of its height but at most 200
// logical pixels (title, search box, the top of a dropdown; the 225% title sat at about 106).
const TITLE_STRIP_SCRIPT = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XiaoxiTitleStripWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
${WECHAT_SCREEN_PIXELS_POWERSHELL}
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHandle = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$file = [Environment]::GetEnvironmentVariable("XIAOXI_TITLE_STRIP_FILE")
if ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]::IsNullOrWhiteSpace($expectedHandle) -or [string]::IsNullOrWhiteSpace($file)) {
  @{ ok = $false; outcome = "title_strip_context_missing" } | ConvertTo-Json -Compress; exit
}
$hWnd = [IntPtr][int64]$expectedHandle
[uint32]$windowPid = 0
$rect = New-Object XiaoxiTitleStripWindow+RECT
$owned = [XiaoxiTitleStripWindow]::IsWindow($hWnd) -and [XiaoxiTitleStripWindow]::IsWindowVisible($hWnd) -and
  [XiaoxiTitleStripWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) -ne 0 -and $windowPid -eq [uint32][int]$expectedPid -and
  [XiaoxiTitleStripWindow]::GetWindowRect($hWnd, [ref]$rect)
$process = Get-Process -Id ([int]$expectedPid) -ErrorAction SilentlyContinue
if (-not $owned -or $process -eq $null -or @("Weixin", "WeChat") -notcontains $process.ProcessName) {
  @{ ok = $false; outcome = "real_send_session_changed" } | ConvertTo-Json -Compress; exit
}
if ([XiaoxiTitleStripWindow]::GetForegroundWindow() -ne $hWnd) {
  @{ ok = $false; outcome = "wechat_window_not_foreground" } | ConvertTo-Json -Compress; exit
}
$dpi = [int][XiaoxiTitleStripWindow]::GetDpiForWindow($hWnd)
if ($dpi -le 0) { $dpi = 96 }
$width = $rect.Right - $rect.Left
$height = [int][Math]::Min(($rect.Bottom - $rect.Top) * 0.3, 200 * $dpi / 96.0)
if ($width -lt 400 -or $height -lt 40) { @{ ok = $false; outcome = "title_strip_too_small" } | ConvertTo-Json -Compress; exit }
$bitmap = $null; $stream = $null
try {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  if (-not [XiaoxiScreenPixels]::Copy($bitmap, $rect.Left, $rect.Top)) { throw "screen_copy_failed" }
  $stream = New-Object System.IO.FileStream($file, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
} catch {
  @{ ok = $false; outcome = "title_strip_capture_failed" } | ConvertTo-Json -Compress; exit
} finally {
  if ($stream -ne $null) { $stream.Dispose() }
  if ($bitmap -ne $null) { $bitmap.Dispose() }
}
@{ ok = $true; pid = [int]$expectedPid; hWnd = $hWnd.ToInt64(); processName = $process.ProcessName; dpi = $dpi
  rect = @{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom } } | ConvertTo-Json -Compress
`;

function newTitleCaptureFile() {
  return path.join(os.tmpdir(), `xiaoxi-title-capture-${crypto.randomBytes(16).toString("hex")}.png`);
}

function ownTitleCapture(file) {
  const resolved = path.resolve(String(file || ""));
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && TITLE_CAPTURE_NAME.test(path.basename(resolved)) ? resolved : "";
}

function discardTitleCapture(file) {
  const own = ownTitleCapture(file);
  if (own) { try { fs.unlinkSync(own); } catch {} }
}

// Takes the strip of the given WeChat window (it must be in front) into a new temp file.
function captureWechatTitleStrip(context = {}, run = runPowerShell) {
  const file = newTitleCaptureFile();
  const result = run(TITLE_STRIP_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_TITLE_STRIP_FILE: file
  }, { ensure: false });
  // "outcome", not "reason": these only explain an AI title check that did not confirm the chat.
  if (!result?.ok) { discardTitleCapture(file); return { ok: false, outcome: String(result?.outcome || result?.reason || "title_strip_capture_failed") }; }
  return { ...result, file };
}

function titleCaptureSha256(file) {
  const own = ownTitleCapture(file);
  try { return own ? crypto.createHash("sha256").update(fs.readFileSync(own)).digest("hex") : ""; } catch { return ""; }
}

// "--vision-title 0.4210,0.3100,0.5520,0.4800,<sha256>,<xiaoxi-title-capture-….png>": where the model
// saw the title (fractions of the strip) and which of our temp pictures it read.
function parseVisionTitle(value) {
  const match = String(value || "").match(/^((?:0\.\d{1,6},){4})([a-f0-9]{64}),(xiaoxi-title-capture-[a-f0-9]{32}\.png)$/u);
  if (!match) return undefined;
  const [left, top, right, bottom] = match[1].split(",").filter(Boolean).map(Number);
  if (!(left < right && top < bottom)) return undefined;
  return { box: { left, top, right, bottom }, capture: match[2], reference: match[3] };
}

// The new strip must show exactly the pixels the model read around the title: same window size, and
// the title with a small margin unchanged. Anything else (another chat, a typing notice, a moved
// window) means the reading no longer applies.
function sameTitleStrip(visionTitle, currentFile) {
  try {
    const reference = path.join(os.tmpdir(), String(visionTitle?.reference || ""));
    if (!ownTitleCapture(reference) || !ownTitleCapture(currentFile)) return false;
    const bytes = fs.readFileSync(reference);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== visionTitle.capture) return false;
    const { box } = visionTitle;
    return sameRegion(decodePng(bytes), decodePng(fs.readFileSync(currentFile)), {
      left: Math.max(0, box.left - 0.01), right: Math.min(1, box.right + 0.01),
      top: Math.max(0, box.top - 0.03), bottom: Math.min(1, box.bottom + 0.03)
    });
  } catch { return false; }
}

// Old strips left by a crash are swept with the search captures (cleanupStaleSearchCaptures).
module.exports = { TITLE_STRIP_SCRIPT, captureWechatTitleStrip, discardTitleCapture, ownTitleCapture,
  parseVisionTitle, sameTitleStrip, titleCaptureSha256 };
