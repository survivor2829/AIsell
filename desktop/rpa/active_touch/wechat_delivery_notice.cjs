// After a verified send, read only a band of the chat body just above the
// composer and report whether WeChat added an undelivered notice: the contact
// deleted the user (friend verification required) or rejected the message.
// The worker returns a verdict only, never OCR text. Anything unreadable
// (window changed, not foreground, OCR unavailable) leaves the result as is.
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

// Kept in sync with the PowerShell pattern below.
const NOTICE_PATTERN = /朋友验证|你还不是[他她]|被对方拒收|拒收了你的消息/u;

const WECHAT_DELIVERY_NOTICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatDeliveryNotice {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
function Write-NoticeResult($value) { $value | ConvertTo-Json -Compress; exit }
$bitmap=$null; $scaled=$null; $graphics=$null; $scaleGraphics=$null; $memory=$null; $random=$null; $writer=$null; $software=$null
try {
  $hWnd = [IntPtr][int64]$env:XIAOXI_EXPECTED_HWND
  [uint32]$windowPid = 0
  [void][Win32WechatDeliveryNotice]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  if ($windowPid -ne [uint32]$env:XIAOXI_EXPECTED_PID) { Write-NoticeResult @{ ok = $false; reason = "delivery_notice_window_changed" } }
  # The notice arrives after the server round trip, a moment after the send.
  Start-Sleep -Milliseconds 900
  if ([Win32WechatDeliveryNotice]::GetForegroundWindow() -ne $hWnd) { Write-NoticeResult @{ ok = $false; reason = "delivery_notice_not_foreground" } }
  $rect = New-Object Win32WechatDeliveryNotice+RECT
  if (-not [Win32WechatDeliveryNotice]::GetWindowRect($hWnd, [ref]$rect)) { Write-NoticeResult @{ ok = $false; reason = "delivery_notice_window_changed" } }
  $dpi = [Win32WechatDeliveryNotice]::GetDpiForWindow($hWnd)
  if ($dpi -lt 72) { $dpi = 96 }
  $scale = $dpi / 96.0
  $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
  $yRatio = 0.84
  if ([double]::TryParse([string]$env:XIAOXI_INPUT_Y_RATIO, [ref]$null)) { $yRatio = [double]$env:XIAOXI_INPUT_Y_RATIO }
  if ($yRatio -lt 0.5 -or $yRatio -gt 0.97) { $yRatio = 0.84 }
  # Chat body only: right of the session list, above the composer toolbar.
  $left = [int]($rect.Left + [Math]::Max(240 * $scale, $width * 0.28))
  $right = [int]($rect.Right - 12 * $scale)
  $bottom = [int]($rect.Top + $height * $yRatio - 64 * $scale)
  $top = [int]([Math]::Max($rect.Top + 80 * $scale, $bottom - 220 * $scale))
  if ($right - $left -lt 160 -or $bottom - $top -lt 40) { Write-NoticeResult @{ ok = $false; reason = "delivery_notice_region_invalid" } }
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]
  $null=[Windows.Storage.Streams.DataWriter,Windows.Foundation,ContentType=WindowsRuntime]
  $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  function Wait-Notice($operation, [Type]$type) {
    $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation))
    if (-not $task.Wait(3000)) { throw 'delivery_notice_timeout' }
    return $task.Result
  }
  $bitmap=[System.Drawing.Bitmap]::new($right-$left,$bottom-$top)
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left,$top,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
  $graphics.Dispose(); $graphics=$null
  # The notice is small grey text; upscale it for WinRT line detection.
  $scaled=[System.Drawing.Bitmap]::new($bitmap.Width*2,$bitmap.Height*2)
  $scaleGraphics=[System.Drawing.Graphics]::FromImage($scaled)
  $scaleGraphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $scaleGraphics.DrawImage($bitmap,[System.Drawing.Rectangle]::new(0,0,$scaled.Width,$scaled.Height),0,0,$bitmap.Width,$bitmap.Height,[System.Drawing.GraphicsUnit]::Pixel)
  $scaleGraphics.Dispose(); $scaleGraphics=$null
  $memory=[IO.MemoryStream]::new(); $scaled.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
  $random=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer=[Windows.Storage.Streams.DataWriter]::new($random); $writer.WriteBytes($memory.ToArray())
  [void](Wait-Notice ($writer.StoreAsync()) ([uint32]))
  [void](Wait-Notice ($writer.FlushAsync()) ([bool]))
  [void]$writer.DetachStream(); $writer.Dispose(); $writer=$null; $random.Seek(0)
  $decoder=Wait-Notice ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $software=Wait-Notice ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
  if ($null -eq $engine) { Write-NoticeResult @{ ok = $false; reason = "delivery_notice_ocr_unavailable" } }
  $reading=Wait-Notice ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  $text = (@($reading.Lines | ForEach-Object { [string]$_.Text }) -join '').Normalize([Text.NormalizationForm]::FormKC)
  $text = [Text.RegularExpressions.Regex]::Replace($text, '\s+', '')
  $undelivered = [Text.RegularExpressions.Regex]::IsMatch($text, '朋友验证|你还不是[他她]|被对方拒收|拒收了你的消息')
  Write-NoticeResult @{ ok = $true; undelivered = $undelivered; line_count = @($reading.Lines).Count }
} catch {
  Write-NoticeResult @{ ok = $false; reason = "delivery_notice_unreadable" }
} finally {
  foreach ($resource in @($software,$writer,$random,$memory,$scaleGraphics,$scaled,$graphics,$bitmap)) {
    if ($null -ne $resource) { $resource.Dispose() }
  }
}
`;

function mentionsNotice(message) {
  return NOTICE_PATTERN.test(String(message || "").normalize("NFKC").replace(/\s+/gu, ""));
}

async function detectWechatDeliveryNoticeAsync(context = {}, run = runPowerShellAsync) {
  const pid = Math.floor(Number(context.pid));
  const hWnd = String(context.hWnd || "").trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[1-9][0-9]{0,19}$/u.test(hWnd)) return { ok: false, reason: "delivery_notice_window_unknown" };
  // Our own text would match the pattern and prove nothing.
  if (mentionsNotice(context.message)) return { ok: false, reason: "delivery_notice_message_ambiguous" };
  const result = await run(WECHAT_DELIVERY_NOTICE_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(pid),
    XIAOXI_EXPECTED_HWND: hWnd,
    XIAOXI_INPUT_Y_RATIO: String(context.inputPoint?.yRatio ?? "")
  }, { ensure: false, timeout: 12_000 });
  if (result?.ok !== true) return { ok: false, reason: String(result?.reason || "delivery_notice_unreadable") };
  return { ok: true, undelivered: result.undelivered === true };
}

module.exports = { WECHAT_DELIVERY_NOTICE_SCRIPT, detectWechatDeliveryNoticeAsync, mentionsNotice };
