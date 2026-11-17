// After a verified send, read only a band of the chat body just above the
// composer and report whether WeChat added an undelivered notice: the contact
// deleted the user (friend verification required) or rejected the message.
// The worker returns a verdict only, never OCR text. Anything unreadable
// (window changed, not foreground, OCR unavailable) leaves the result as is.
const { WECHAT_SCREEN_PIXELS_POWERSHELL } = require("./wechat_screen_pixels.cjs");
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
  # The whole chat body: right of the session list, below the title bar and above the
  # composer (fixed ~130 px at 96 DPI). A short chat (a contact added recently, most touch
  # recipients) keeps its messages at the top, far above the composer: the old band of
  # 210 px above the composer missed "消息已发出，但被对方拒收了" 250 px up (2026-11-17).
  $left = [int]($rect.Left + [Math]::Max(240 * $scale, $width * 0.28))
  $right = [int]($rect.Right - 12 * $scale)
  $bottom = [int]($rect.Bottom - 130 * $scale)
  $top = [int]($rect.Top + 80 * $scale)
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
${WECHAT_SCREEN_PIXELS_POWERSHELL}
  if (-not [XiaoxiScreenPixels]::Copy($bitmap, $left, $top)) { throw "screen_copy_failed" }
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
  # Only the lowest text counts: the notice sits directly under the bubble just sent,
  # while an older notice in the history would sit above that bubble. The lowest line and
  # the one above it if it is within 26 px (a deletion notice wraps onto two lines); the
  # bubble just sent is taller than that, so an older notice never joins.
  $allBottoms = @($reading.Lines | ForEach-Object { $_.Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } })
  if ($allBottoms.Count -eq 0) { Write-NoticeResult @{ ok = $true; undelivered = $false; kind = ""; line_count = 0 } }
  $lowestLimit = ($allBottoms | Measure-Object -Maximum).Maximum - 26 * $scale * 2
  $lowestLines = @($reading.Lines | Where-Object {
    $wordBottoms = @($_.Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height })
    $wordBottoms.Count -gt 0 -and ($wordBottoms | Measure-Object -Maximum).Maximum -ge $lowestLimit
  })
  $text = (@($lowestLines | ForEach-Object { [string]$_.Text }) -join '').Normalize([Text.NormalizationForm]::FormKC)
  $text = [Text.RegularExpressions.Regex]::Replace($text, '\s+', '')
  # 被对方拒收: the contact blocked the user; 朋友验证 / 你还不是他(她)朋友: the contact deleted them.
  $blocked = [Text.RegularExpressions.Regex]::IsMatch($text, '被对方拒收|拒收了你的消息')
  $deleted = [Text.RegularExpressions.Regex]::IsMatch($text, '朋友验证|你还不是[他她]')
  $kind = $(if ($blocked) { "blocked" } elseif ($deleted) { "deleted" } else { "" })
  Write-NoticeResult @{ ok = $true; undelivered = ($blocked -or $deleted); kind = $kind; line_count = @($reading.Lines).Count }
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
    XIAOXI_EXPECTED_HWND: hWnd
  }, { ensure: false, timeout: 12_000, hosted: true });
  if (result?.ok !== true) return { ok: false, reason: String(result?.reason || "delivery_notice_unreadable") };
  const undelivered = result.undelivered === true;
  // blocked: 被对方拒收 (the contact blocked the user); deleted: 朋友验证 (the contact deleted them).
  const kind = undelivered && ["blocked", "deleted"].includes(result.kind) ? result.kind : "";
  return { ok: true, undelivered, ...(kind ? { kind } : {}) };
}

module.exports = { WECHAT_DELIVERY_NOTICE_SCRIPT, detectWechatDeliveryNoticeAsync, mentionsNotice };
