[CmdletBinding()]
param(
  [ValidateRange(10, 900)][int]$DurationSeconds = 180,
  [ValidateRange(1, 10)][int]$IntervalSeconds = 2,
  [string]$OutputRoot = [Environment]::GetFolderPath("Desktop"),
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LiveTraceWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
}
"@

function Get-WindowTextValue([IntPtr]$Handle) {
  $builder = [Text.StringBuilder]::new(512)
  [void][LiveTraceWin32]::GetWindowText($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Get-ClassNameValue([IntPtr]$Handle) {
  $builder = [Text.StringBuilder]::new(256)
  [void][LiveTraceWin32]::GetClassName($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Find-WeChatWindow {
  $processIds = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($processIds.Count -eq 0) { return $null }
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [LiveTraceWin32+EnumWindowsProc]{
    param([IntPtr]$handle, [IntPtr]$unused)
    if (-not [LiveTraceWin32]::IsWindowVisible($handle)) { return $true }
    [uint32]$pid = 0; [void][LiveTraceWin32]::GetWindowThreadProcessId($handle, [ref]$pid)
    if ($processIds -notcontains $pid) { return $true }
    $rect = New-Object LiveTraceWin32+RECT
    if (-not [LiveTraceWin32]::GetWindowRect($handle, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
    if ($width -lt 600 -or $height -lt 500) { return $true }
    [void]$windows.Add([pscustomobject]@{
      handle = [int64]$handle; pid = [int]$pid; title = Get-WindowTextValue $handle; className = Get-ClassNameValue $handle
      left = $rect.Left; top = $rect.Top; width = $width; height = $height; area = [int64]$width * [int64]$height
    })
    return $true
  }
  [void][LiveTraceWin32]::EnumWindows($callback, [IntPtr]::Zero)
  return @($windows.ToArray() | Sort-Object area -Descending | Select-Object -First 1)[0]
}

function Capture-Window($Window, [string]$Path) {
  $bitmap = [Drawing.Bitmap]::new([int]$Window.width, [int]$Window.height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen([int]$Window.left, [int]$Window.top, 0, 0, [Drawing.Size]::new([int]$Window.width, [int]$Window.height), [Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose(); $bitmap.Dispose()
  }
}

function Test-BadgePixel([Drawing.Color]$Pixel) {
  return $Pixel.R -ge 235 -and $Pixel.G -ge 50 -and $Pixel.G -le 125 -and $Pixel.B -ge 45 -and $Pixel.B -le 125 -and
    ($Pixel.R - $Pixel.G) -ge 105 -and ($Pixel.R - $Pixel.B) -ge 105
}

function Get-BadgeComponents([string]$ImagePath, [double]$Dpi) {
  $bitmap = [Drawing.Bitmap]::FromFile($ImagePath)
  try {
    $scale = [Math]::Min(4.0, [Math]::Max(0.5, $Dpi / 120.0))
    $sidebarRight = [Math]::Min(300.0 * ($Dpi / 96.0), [Math]::Max(230.0 * ($Dpi / 96.0), $bitmap.Width * 0.45))
    $xStart = [int][Math]::Max(0, [Math]::Floor(58 * $scale)); $xEnd = [int][Math]::Min($bitmap.Width - 1, [Math]::Ceiling([Math]::Min($sidebarRight - (80 * $scale), 170 * $scale)))
    $yStart = [int][Math]::Max(0, [Math]::Floor(70 * $scale)); $yEnd = [int][Math]::Min($bitmap.Height - 1, [Math]::Ceiling($bitmap.Height - (42 * $scale)))
    $points = New-Object 'System.Collections.Generic.HashSet[string]'
    for ($y = $yStart; $y -le $yEnd; $y++) { for ($x = $xStart; $x -le $xEnd; $x++) { if (Test-BadgePixel $bitmap.GetPixel($x, $y)) { [void]$points.Add("$x,$y") } } }
    $result = New-Object System.Collections.Generic.List[object]
    while ($points.Count -gt 0) {
      $seed = $points | Select-Object -First 1; $queue = New-Object 'System.Collections.Generic.Queue[string]'; $queue.Enqueue($seed); [void]$points.Remove($seed)
      $minX = 999999; $maxX = 0; $minY = 999999; $maxY = 0; $count = 0
      while ($queue.Count -gt 0) {
        $item = $queue.Dequeue().Split(','); $x = [int]$item[0]; $y = [int]$item[1]
        $minX = [Math]::Min($minX, $x); $maxX = [Math]::Max($maxX, $x); $minY = [Math]::Min($minY, $y); $maxY = [Math]::Max($maxY, $y); $count += 1
        foreach ($dx in -1..1) { foreach ($dy in -1..1) { if ($dx -eq 0 -and $dy -eq 0) { continue }; $next = "$($x + $dx),$($y + $dy)"; if ($points.Remove($next)) { $queue.Enqueue($next) } } }
      }
      $width = $maxX - $minX + 1; $height = $maxY - $minY + 1; $ratio = [double][Math]::Max($width, $height) / [Math]::Max(1, [Math]::Min($width, $height)); $density = $count / [double]($width * $height)
      [void]$result.Add([ordered]@{ left = $minX; top = $minY; width = $width; height = $height; pixels = $count; ratio = [Math]::Round($ratio, 3); density = [Math]::Round($density, 3); accepted = $width -ge (8 * $scale) -and $width -le (28 * $scale) -and $height -ge (8 * $scale) -and $height -le (28 * $scale) -and $count -ge (28 * $scale * $scale) -and $ratio -le 1.65 -and $density -ge 0.25 })
    }
    return @($result)
  } finally { $bitmap.Dispose() }
}

function Get-UiaSnapshot([IntPtr]$Handle) {
  try {
    $root = [Windows.Automation.AutomationElement]::FromHandle($Handle)
    if ($null -eq $root) { return @() }
    $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    $items = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt [Math]::Min($all.Count, 500); $index++) {
      $element = $all.Item($index)
      try {
        $name = [string]$element.Current.Name; $automationId = [string]$element.Current.AutomationId
        if (-not $name -and -not $automationId) { continue }
        $bounds = $element.Current.BoundingRectangle
        [void]$items.Add([ordered]@{ name = $name; automationId = $automationId; controlType = [string]$element.Current.ControlType.ProgrammaticName; left = [Math]::Round($bounds.Left, 1); top = [Math]::Round($bounds.Top, 1); width = [Math]::Round($bounds.Width, 1); height = [Math]::Round($bounds.Height, 1) })
      } catch {}
    }
    return @($items)
  } catch { return @([ordered]@{ error = $_.Exception.Message }) }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path $OutputRoot "AutoReply-Live-Trace-$timestamp"
$zipPath = "$outputDirectory.zip"
$framesDirectory = Join-Path $outputDirectory "frames"
$dataRoot = Join-Path $env:APPDATA "xiaoxi-active-touch-delivery\data"
$timelinePath = Join-Path $outputDirectory "timeline.jsonl"
New-Item -ItemType Directory -Path $framesDirectory -Force | Out-Null

Write-Host "Live listener started for $DurationSeconds seconds." -ForegroundColor Green
Write-Host "Keep AI Customer auto reply running, then send two short test messages now." -ForegroundColor Yellow
Write-Host "This listener never clicks or sends anything." -ForegroundColor Cyan

$iterations = [Math]::Ceiling($DurationSeconds / $IntervalSeconds)
for ($index = 1; $index -le $iterations; $index++) {
  $observedAt = Get-Date
  $entry = [ordered]@{ sequence = $index; observedAt = $observedAt.ToString("o") }
  try {
    $window = Find-WeChatWindow
    if ($null -eq $window) {
      $entry.window = $null; $entry.error = "wechat_window_missing"
    } else {
      $handle = [IntPtr][int64]$window.handle
      $dpi = 96
      try { $reportedDpi = [LiveTraceWin32]::GetDpiForWindow($handle); if ($reportedDpi -ge 72 -and $reportedDpi -le 480) { $dpi = [int]$reportedDpi } } catch {}
      $frameName = "wechat-{0:D4}.png" -f $index; $framePath = Join-Path $framesDirectory $frameName
      Capture-Window $window $framePath
      $entry.window = $window; $entry.dpi = $dpi; $entry.foregroundHandle = [string][int64][LiveTraceWin32]::GetForegroundWindow()
      $entry.frame = $frameName; $entry.frameSha256 = (Get-FileHash -LiteralPath $framePath -Algorithm SHA256).Hash
      $entry.badgeComponents = @(Get-BadgeComponents $framePath $dpi)
      if ($index -eq 1 -or $index % 10 -eq 0) {
        Get-UiaSnapshot $handle | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputDirectory ("uia-{0:D4}.json" -f $index)) -Encoding UTF8
      }
    }
    $statePath = Join-Path $dataRoot "auto_reply\auto-reply-state.json"
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
      try { $entry.autoReplyState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { $entry.stateReadError = $_.Exception.Message }
    }
  } catch { $entry.error = $_.Exception.Message }
  ($entry | ConvertTo-Json -Depth 10 -Compress) | Add-Content -LiteralPath $timelinePath -Encoding UTF8
  $remaining = [Math]::Max(0, $DurationSeconds - ($index * $IntervalSeconds))
  Write-Host ("Captured {0}/{1}; {2}s remaining" -f $index, $iterations, $remaining)
  if ($index -lt $iterations) { Start-Sleep -Seconds $IntervalSeconds }
}

$copyItems = @(
  @{ Source = Join-Path $dataRoot "auto_reply\auto-reply-diagnostics.jsonl"; Target = "auto-reply-diagnostics.jsonl" },
  @{ Source = Join-Path $dataRoot "auto_reply\auto-reply-state.json"; Target = "auto-reply-state-final.json" },
  @{ Source = Join-Path $dataRoot "active_touch\contacts.json"; Target = "contacts.json" }
)
foreach ($item in $copyItems) { if (Test-Path -LiteralPath $item.Source -PathType Leaf) { Copy-Item -LiteralPath $item.Source -Destination (Join-Path $outputDirectory $item.Target) -Force } }

$summary = [ordered]@{ collectedAt = (Get-Date).ToString("o"); computerName = $env:COMPUTERNAME; userName = $env:USERNAME; durationSeconds = $DurationSeconds; intervalSeconds = $IntervalSeconds; dataRoot = $dataRoot; note = "Read-only trace. No clicks, typing, API calls, or sends are performed by this listener." }
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputDirectory "summary.json") -Encoding UTF8
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $outputDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host ""; Write-Host "Live trace ZIP created:" -ForegroundColor Green; Write-Host $zipPath -ForegroundColor Cyan
if (-not $NoOpen) { Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`"" }
