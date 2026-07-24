const MOMENTS_VISUAL_READONLY_POWERSHELL = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsVisualReadOnly {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
[void][Win32WechatMomentsVisualReadOnly]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Wait-MomentsWinRt($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  if ($method -eq $null) { throw "windows_runtime_as_task_missing" }
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(1500)) { throw "windows_runtime_task_timeout" }
  return $task.Result
}

function Get-MomentsVisualRuntimeId([System.Windows.Automation.AutomationElement]$element) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return ""
}

function Get-MomentsRenderPaneEvidence([System.Windows.Automation.AutomationElement]$root, [int]$expectedPid) {
  $paneType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Pane
  )
  $panes = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $paneType)
  $matches = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $panes.Count; $index++) {
    $pane = $panes.Item($index)
    try {
      if ([string]$pane.Current.Name -cne "MMUIRenderSubWindowHW" -or [int]$pane.Current.ProcessId -ne $expectedPid) { continue }
      $rect = $pane.Current.BoundingRectangle
      $automationId = [string]$pane.Current.AutomationId
      $controlType = [string]$pane.Current.ControlType.ProgrammaticName
    } catch { continue }
    $runtimeId = Get-MomentsVisualRuntimeId $pane
    if (-not $runtimeId -or $controlType -cne "ControlType.Pane" -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
    [void]$matches.Add(@{
      element = $pane
      name = "MMUIRenderSubWindowHW"
      automationId = $automationId
      controlType = $controlType
      processId = $expectedPid
      runtimeId = $runtimeId
      bounds = @{
        left = [double]$rect.Left
        top = [double]$rect.Top
        width = [double]$rect.Width
        height = [double]$rect.Height
      }
    })
  }
  if ($matches.Count -eq 0) { return @{ ok = $false; reason = "moments_render_pane_not_found" } }
  if ($matches.Count -ne 1) { return @{ ok = $false; reason = "moments_render_pane_ambiguous"; count = $matches.Count } }
  return @{ ok = $true; pane = $matches[0] }
}

function Test-MomentsVisualViewportOwned($windowRect, [IntPtr]$expectedHWnd, [int]$expectedPid) {
  $width = [double]($windowRect.Right - $windowRect.Left)
  $height = [double]($windowRect.Bottom - $windowRect.Top)
  foreach ($xRatio in @(0.08, 0.5, 0.92)) {
    foreach ($yRatio in @(0.08, 0.5, 0.92)) {
      $point = New-Object Win32WechatMomentsVisualReadOnly+POINT
      $point.X = [int][Math]::Round($windowRect.Left + ($width * $xRatio))
      $point.Y = [int][Math]::Round($windowRect.Top + ($height * $yRatio))
      $hit = [Win32WechatMomentsVisualReadOnly]::WindowFromPoint($point)
      if ($hit -eq [IntPtr]::Zero) { return $false }
      $hitRoot = [Win32WechatMomentsVisualReadOnly]::GetAncestor($hit, 2)
      if ($hitRoot -ne $expectedHWnd) { return $false }
      [uint32]$hitPid = 0
      [void][Win32WechatMomentsVisualReadOnly]::GetWindowThreadProcessId($hit, [ref]$hitPid)
      if ([int]$hitPid -ne $expectedPid) { return $false }
    }
  }
  return $true
}

function Get-MomentsVisualFrame(
  [IntPtr]$hWnd,
  $windowRect,
  [int]$expectedPid,
  [bool]$activate = $true,
  [bool]$requireFullViewportOwnership = $true
) {
  if (-not [Win32WechatMomentsVisualReadOnly]::IsWindowVisible($hWnd) -or [Win32WechatMomentsVisualReadOnly]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "moments_window_not_found" }
  }
  if ($activate) {
    [void][Win32WechatMomentsVisualReadOnly]::ShowWindowAsync($hWnd, 9)
    [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($hWnd)
    Start-Sleep -Milliseconds 140
  }
  if ([Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -ne $hWnd) {
    return @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  if ($requireFullViewportOwnership -and -not (Test-MomentsVisualViewportOwned $windowRect $hWnd $expectedPid)) {
    return @{ ok = $false; reason = "moments_window_obscured" }
  }
  $width = [int]($windowRect.Right - $windowRect.Left)
  $height = [int]($windowRect.Bottom - $windowRect.Top)
  if ($width -lt 300 -or $height -lt 300) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  $bitmap = $null
  $graphics = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen(
      [int]$windowRect.Left,
      [int]$windowRect.Top,
      0,
      0,
      [System.Drawing.Size]::new($width, $height),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "moments_visual_capture_failed" }
  } finally {
    if ($graphics) { $graphics.Dispose() }
  }
  try {
    $lockRect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $bitmapData = $bitmap.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = [Math]::Abs([int]$bitmapData.Stride)
      $bytes = New-Object byte[] ($stride * $height)
      [System.Runtime.InteropServices.Marshal]::Copy($bitmapData.Scan0, $bytes, 0, $bytes.Length)
    } finally {
      $bitmap.UnlockBits($bitmapData)
    }
  } catch {
    $bitmap.Dispose()
    return @{ ok = $false; reason = "moments_visual_capture_failed" }
  }
  return @{
    ok = $true
    bitmap = $bitmap
    bytes = $bytes
    stride = $stride
    width = $width
    height = $height
    screenLeft = [int]$windowRect.Left
    screenTop = [int]$windowRect.Top
  }
}

function Close-MomentsVisualFrame($frame) {
  try { if ($frame -and $frame.bitmap) { $frame.bitmap.Dispose() } } catch {}
}

function Normalize-MomentsStableContentText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormKC)
  # Relative-time labels are presentation state, not post identity. Limit the
  # removal to the UI suffix so ordinary body text is not silently discarded.
  $normalized = [Text.RegularExpressions.Regex]::Replace(
    $normalized,
    "(?:刚刚|昨天|[0-9]+\s*(?:秒|分钟|小时|天)前)(?=(?:\s|赞|点赞|取消|取消赞|评论|删除)*$)",
    ""
  )
  return [Text.RegularExpressions.Regex]::Replace($normalized, "\s+", "").Trim()
}

function Get-MomentsBoundedEditDistance([string]$left, [string]$right, [int]$maximumDistance) {
  if ([Math]::Abs($left.Length - $right.Length) -gt $maximumDistance) { return $maximumDistance + 1 }
  $rightLength = $right.Length
  $infinity = $maximumDistance + 1
  $previous = New-Object int[] ($rightLength + 1)
  $initialEnd = [Math]::Min($rightLength, $maximumDistance)
  for ($column = 0; $column -le $initialEnd; $column++) { $previous[$column] = $column }
  if ($initialEnd -lt $rightLength) { $previous[$initialEnd + 1] = $infinity }
  for ($row = 1; $row -le $left.Length; $row++) {
    $current = New-Object int[] ($rightLength + 1)
    $start = [Math]::Max(1, $row - $maximumDistance)
    $end = [Math]::Min($rightLength, $row + $maximumDistance)
    if ($row -le $maximumDistance) { $current[0] = $row } else { $current[0] = $infinity }
    if ($start -gt 1) { $current[$start - 1] = $infinity }
    $rowMinimum = $infinity
    for ($column = $start; $column -le $end; $column++) {
      $substitutionCost = if ($left[$row - 1] -ceq $right[$column - 1]) { 0 } else { 1 }
      $current[$column] = [Math]::Min(
        [Math]::Min($previous[$column] + 1, $current[$column - 1] + 1),
        $previous[$column - 1] + $substitutionCost
      )
      $rowMinimum = [Math]::Min($rowMinimum, $current[$column])
    }
    if ($end -lt $rightLength) { $current[$end + 1] = $infinity }
    if ($rowMinimum -gt $maximumDistance) { return $infinity }
    $previous = $current
  }
  return [int]$previous[$rightLength]
}

function Test-MomentsStableContentSimilarity([string]$first, [string]$second) {
  $left = Normalize-MomentsStableContentText $first
  $right = Normalize-MomentsStableContentText $second
  if (-not $left -or -not $right) { return $false }
  if ($left -ceq $right) { return $true }
  $maximumLength = [Math]::Max($left.Length, $right.Length)
  $minimumLength = [Math]::Min($left.Length, $right.Length)
  if ($minimumLength -lt 16 -or $maximumLength -gt 512) { return $false }
  $allowed = [Math]::Min(3, [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.04)))
  $distance = Get-MomentsBoundedEditDistance $left $right $allowed
  return $distance -le $allowed -and ([double]$distance / [double]$maximumLength) -le 0.07
}

function Test-MomentsStablePostIdentityText(
  [string]$firstIdentity,
  [string]$secondIdentity,
  [string]$firstAnchor,
  [string]$secondAnchor
) {
  if (Test-MomentsStableContentSimilarity $firstIdentity $secondIdentity) { return $true }
  if ([string]::IsNullOrWhiteSpace($firstAnchor) -or [string]::IsNullOrWhiteSpace($secondAnchor)) {
    return $false
  }
  return Test-MomentsStableContentSimilarity $firstAnchor $secondAnchor
}

function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $null }
  $offset = ($y * $frame.stride) + ($x * 4)
  return @{
    b = [int]$frame.bytes[$offset]
    g = [int]$frame.bytes[$offset + 1]
    r = [int]$frame.bytes[$offset + 2]
  }
}

function Test-MomentsDarkNeutralPixel($pixel) {
  if ($pixel -eq $null) { return $false }
  $maximum = [Math]::Max($pixel.r, [Math]::Max($pixel.g, $pixel.b))
  $minimum = [Math]::Min($pixel.r, [Math]::Min($pixel.g, $pixel.b))
  return $minimum -ge 35 -and $maximum -le 180 -and ($maximum - $minimum) -le 55
}

function Test-MomentsLightPixel($pixel) {
  return $pixel -ne $null -and $pixel.r -ge 218 -and $pixel.g -ge 218 -and $pixel.b -ge 218
}

function Get-MomentsPatchLightRatio($frame, [int]$left, [int]$top, [int]$right, [int]$bottom) {
  $light = 0
  $total = 0
  for ($y = [Math]::Max(0, $top); $y -lt [Math]::Min($frame.height, $bottom); $y += 2) {
    for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x += 2) {
      if (Test-MomentsLightPixel (Get-MomentsPixel $frame $x $y)) { $light += 1 }
      $total += 1
    }
  }
  if ($total -eq 0) { return 0.0 }
  return [double]$light / [double]$total
}

function Find-MomentsMenuDots($frame) {
  # The interaction button lives in a dedicated right gutter. We classify the
  # icon by connected components: this WeChat render profile draws the menu
  # as two compact, separated dots on one baseline. Text ellipses use three
  # much smaller components, while a disclosure chevron is one component.
  $xStart = [int][Math]::Floor($frame.width * 0.86)
  $xEnd = [int][Math]::Ceiling($frame.width * 0.95)
  $gutterWidth = $xEnd - $xStart
  $yStart = [int][Math]::Max(48, [Math]::Floor($frame.height * 0.04))
  $yEnd = [int][Math]::Min($frame.height - 12, [Math]::Ceiling($frame.height * 0.99))
  $gutterHeight = $yEnd - $yStart
  if ($gutterWidth -lt 12 -or $gutterHeight -lt 40) { return @() }
  $mask = New-Object bool[] ($gutterWidth * $gutterHeight)
  for ($localY = 0; $localY -lt $gutterHeight; $localY++) {
    $y = $yStart + $localY
    for ($localX = 0; $localX -lt $gutterWidth; $localX++) {
      $x = $xStart + $localX
      $offset = ($y * $frame.stride) + ($x * 4)
      $blue = [int]$frame.bytes[$offset]
      $green = [int]$frame.bytes[$offset + 1]
      $red = [int]$frame.bytes[$offset + 2]
      $maximum = [Math]::Max($red, [Math]::Max($green, $blue))
      $minimum = [Math]::Min($red, [Math]::Min($green, $blue))
      $mask[($localY * $gutterWidth) + $localX] = $maximum -le 205 -and ($maximum - $minimum) -le 90
    }
  }
  $seen = New-Object bool[] $mask.Length
  $components = New-Object System.Collections.Generic.List[object]
  for ($seedY = 0; $seedY -lt $gutterHeight; $seedY++) {
    for ($seedX = 0; $seedX -lt $gutterWidth; $seedX++) {
      $seedIndex = ($seedY * $gutterWidth) + $seedX
      if (-not $mask[$seedIndex] -or $seen[$seedIndex]) { continue }
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seedIndex)
      $seen[$seedIndex] = $true
      $minX = $seedX; $maxX = $seedX; $minY = $seedY; $maxY = $seedY; $count = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $currentY = [int][Math]::Floor($current / $gutterWidth)
        $currentX = $current - ($currentY * $gutterWidth)
        $minX = [Math]::Min($minX, $currentX); $maxX = [Math]::Max($maxX, $currentX)
        $minY = [Math]::Min($minY, $currentY); $maxY = [Math]::Max($maxY, $currentY)
        $count += 1
        foreach ($delta in @(@(-1,0), @(1,0), @(0,-1), @(0,1))) {
          $nextX = $currentX + $delta[0]; $nextY = $currentY + $delta[1]
          if ($nextX -lt 0 -or $nextY -lt 0 -or $nextX -ge $gutterWidth -or $nextY -ge $gutterHeight) { continue }
          $nextIndex = ($nextY * $gutterWidth) + $nextX
          if ($mask[$nextIndex] -and -not $seen[$nextIndex]) {
            $seen[$nextIndex] = $true
            $queue.Enqueue($nextIndex)
          }
        }
      }
      $width = $maxX - $minX + 1
      $height = $maxY - $minY + 1
      if ($count -ge 1 -and $count -le 36 -and $width -ge 1 -and $width -le 7 -and $height -ge 1 -and $height -le 7) {
        [void]$components.Add(@{
          left = [double]($xStart + $minX)
          right = [double]($xStart + $maxX)
          top = [double]($yStart + $minY)
          bottom = [double]($yStart + $maxY)
          centerX = [double]($xStart + (($minX + $maxX) / 2.0))
          centerY = [double]($yStart + (($minY + $maxY) / 2.0))
          width = [int]$width
          height = [int]$height
          count = [int]$count
        })
      }
    }
  }
  $ordered = @($components.ToArray() | Sort-Object { [double]$_.centerY }, { [double]$_.centerX })
  $menus = New-Object System.Collections.Generic.List[object]
  for ($firstIndex = 0; $firstIndex -lt $ordered.Count; $firstIndex++) {
    for ($secondIndex = $firstIndex + 1; $secondIndex -lt $ordered.Count; $secondIndex++) {
      $first = $ordered[$firstIndex]; $second = $ordered[$secondIndex]
      if ($first.width -lt 4 -or $first.height -lt 3 -or $first.count -lt 10) { break }
      if ($second.width -lt 4 -or $second.height -lt 3 -or $second.count -lt 10) { continue }
      if ([Math]::Abs($first.centerY - $second.centerY) -gt 2.0) {
        if ($second.centerY -gt ($first.centerY + 2.0)) { break }
        continue
      }
      $gapOne = $second.left - $first.right - 1
      if ($gapOne -lt 2 -or $gapOne -gt 8 -or
        [Math]::Abs($first.width - $second.width) -gt 2 -or
        [Math]::Abs($first.height - $second.height) -gt 2 -or
        [Math]::Abs($first.count - $second.count) -gt 12) { continue }
      $matched = @($first, $second)
      $centerX = [double](($matched | ForEach-Object { [double]$_.centerX } | Measure-Object -Average).Average)
      $centerY = [double](($matched | ForEach-Object { [double]$_.centerY } | Measure-Object -Average).Average)
      $span = [double]$matched[-1].right - [double]$matched[0].left + 1
      if ($span -lt 5 -or $span -gt 28) { continue }
      $lightRatio = Get-MomentsPatchLightRatio $frame ([int]($centerX - 18)) ([int]($centerY - 12)) ([int]($centerX + 19)) ([int]($centerY + 13))
      if ($lightRatio -lt 0.58) { continue }
      $duplicate = $false
      foreach ($existing in $menus) {
        if ([Math]::Abs($existing.centerX - $centerX) -le 6 -and [Math]::Abs($existing.centerY - $centerY) -le 10) { $duplicate = $true; break }
      }
      if (-not $duplicate) {
        [void]$menus.Add(@{
          centerX = $centerX
          centerY = $centerY
          bounds = @{ left = $centerX - 18; top = $centerY - 12; width = 36; height = 24 }
        })
      }
      break
    }
  }
  return @($menus.ToArray() | Sort-Object { [double]$_.centerY }, { [double]$_.centerX })
}

function Measure-MomentsAvatarBox($frame, [int]$left, [int]$top, [int]$size) {
  $insideForeground = 0
  $insideTotal = 0
  for ($y = $top; $y -lt ($top + $size); $y += 4) {
    for ($x = $left; $x -lt ($left + $size); $x += 4) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $light = [int]$frame.bytes[$offset + 2] -ge 218 -and [int]$frame.bytes[$offset + 1] -ge 218 -and [int]$frame.bytes[$offset] -ge 218
      if (-not $light) { $insideForeground += 1 }
      $insideTotal += 1
    }
  }
  $ringLight = 0
  $ringTotal = 0
  $ring = [Math]::Max(3, [int][Math]::Round($size * 0.1))
  for ($y = $top - $ring; $y -lt ($top + $size + $ring); $y += 4) {
    for ($x = $left - $ring; $x -lt ($left + $size + $ring); $x += 4) {
      $inside = $x -ge $left -and $x -lt ($left + $size) -and $y -ge $top -and $y -lt ($top + $size)
      if ($inside) { continue }
      if ($x -ge 0 -and $y -ge 0 -and $x -lt $frame.width -and $y -lt $frame.height) {
        $offset = ($y * $frame.stride) + ($x * 4)
        if ([int]$frame.bytes[$offset + 2] -ge 218 -and [int]$frame.bytes[$offset + 1] -ge 218 -and [int]$frame.bytes[$offset] -ge 218) { $ringLight += 1 }
      }
      $ringTotal += 1
    }
  }
  if ($insideTotal -eq 0 -or $ringTotal -eq 0) { return @{ ok = $false; score = 0.0 } }
  $foregroundRatio = [double]$insideForeground / [double]$insideTotal
  $ringLightRatio = [double]$ringLight / [double]$ringTotal
  $ok = $foregroundRatio -ge 0.16 -and $foregroundRatio -le 0.98 -and $ringLightRatio -ge 0.50
  return @{ ok = $ok; score = (($foregroundRatio * 0.68) + ($ringLightRatio * 0.32)); foregroundRatio = $foregroundRatio; ringLightRatio = $ringLightRatio }
}

function Test-MomentsVisualBoundsInside($inner, $outer) {
  if ($inner -eq $null -or $outer -eq $null) { return $false }
  return [double]$inner.width -gt 0 -and [double]$inner.height -gt 0 -and
    [double]$outer.width -gt 0 -and [double]$outer.height -gt 0 -and
    [double]$inner.left -ge [double]$outer.left -and [double]$inner.top -ge [double]$outer.top -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height)
}

function Find-MomentsAvatarForMenu($frame, $menus, [int]$menuIndex, $viewportBounds) {
  $menu = $menus[$menuIndex]
  $size = [int][Math]::Max(32, [Math]::Min(52, [Math]::Round([double]$viewportBounds.width * 0.09)))
  $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
  $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
  $x = [int][Math]::Max([double]$viewportBounds.left, [Math]::Min($viewportRight - $size, [double]$viewportBounds.left + ([double]$viewportBounds.width * 0.055)))
  $previousMenuY = if ($menuIndex -gt 0) { [double]$menus[$menuIndex - 1].centerY } else { [double]$viewportBounds.top }
  $yStart = [int][Math]::Max([double]$viewportBounds.top, [Math]::Round($previousMenuY + ($size * 0.45)))
  $yEnd = [int][Math]::Min($viewportBottom - $size, [Math]::Floor($menu.centerY - ($size * 1.6)))
  if ($yEnd -lt $yStart) { return @{ ok = $false; reason = "moments_visual_avatar_not_found" } }
  $peaks = New-Object System.Collections.Generic.List[object]
  for ($y = $yStart; $y -le $yEnd; $y += 4) {
    $measure = Measure-MomentsAvatarBox $frame $x $y $size
    if (-not $measure.ok) { continue }
    [void]$peaks.Add(@{ left = $x; top = $y; size = $size; score = [double]$measure.score })
  }
  if ($peaks.Count -eq 0) { return @{ ok = $false; reason = "moments_visual_avatar_not_found" } }
  $ordered = @($peaks.ToArray() | Sort-Object @{ Expression = "score"; Descending = $true }, @{ Expression = "top"; Descending = $true })
  $best = $ordered[0]
  foreach ($other in $ordered | Select-Object -Skip 1) {
    if (($best.score - $other.score) -gt 0.035) { break }
    if ([Math]::Abs($best.top - $other.top) -gt ($size * 0.65)) {
      return @{ ok = $false; reason = "moments_visual_avatar_ambiguous" }
    }
  }
  return @{ ok = $true; bounds = @{ left = [double]$best.left; top = [double]$best.top; width = [double]$size; height = [double]$size }; score = $best.score }
}

function Get-MomentsPixelHash($frame, $rect) {
  $left = [int][Math]::Max(0, [Math]::Floor([double]$rect.left))
  $top = [int][Math]::Max(0, [Math]::Floor([double]$rect.top))
  $right = [int][Math]::Min($frame.width, [Math]::Ceiling([double]$rect.left + [double]$rect.width))
  $bottom = [int][Math]::Min($frame.height, [Math]::Ceiling([double]$rect.top + [double]$rect.height))
  if ($right -le $left -or $bottom -le $top) { return "" }
  $rowWidth = ($right - $left) * 4
  $buffer = New-Object byte[] ($rowWidth * ($bottom - $top))
  $destination = 0
  for ($y = $top; $y -lt $bottom; $y++) {
    [Array]::Copy($frame.bytes, ($y * $frame.stride) + ($left * 4), $buffer, $destination, $rowWidth)
    $destination += $rowWidth
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = $sha.ComputeHash($buffer) } finally { $sha.Dispose() }
  return ([BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant())
}

function ConvertTo-MomentsOcrBitmap($frame, $rect) {
  $left = [int][Math]::Max(0, [Math]::Floor([double]$rect.left))
  $top = [int][Math]::Max(0, [Math]::Floor([double]$rect.top))
  $right = [int][Math]::Min($frame.width, [Math]::Ceiling([double]$rect.left + [double]$rect.width))
  $bottom = [int][Math]::Min($frame.height, [Math]::Ceiling([double]$rect.top + [double]$rect.height))
  if ($right -le $left -or $bottom -le $top) { return $null }
  return $frame.bitmap.Clone(
    [System.Drawing.Rectangle]::new($left, $top, $right - $left, $bottom - $top),
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
}

function Get-MomentsOcrObservationFromBitmap($crop) {
  $memory = $null
  $random = $null
  $software = $null
  try {
    $memory = [IO.MemoryStream]::new()
    $crop.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $memory.ToArray()
    $random = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($random)
    $writer.WriteBytes($bytes)
    [void](Wait-MomentsWinRt ($writer.StoreAsync()) ([uint32]))
    [void](Wait-MomentsWinRt ($writer.FlushAsync()) ([bool]))
    $writer.DetachStream()
    $writer.Dispose()
    $random.Seek(0)
    $decoder = Wait-MomentsWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Wait-MomentsWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $language = [Windows.Globalization.Language]::new("zh-Hans-CN")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($engine -eq $null) { return @{ ok = $false; reason = "moments_visual_ocr_unavailable" } }
    $result = Wait-MomentsWinRt ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    $lines = New-Object System.Collections.Generic.List[object]
    $words = New-Object System.Collections.Generic.List[object]
    foreach ($line in $result.Lines) {
      $lineParts = New-Object System.Collections.Generic.List[string]
      $lineLeft = [double]::PositiveInfinity
      $lineTop = [double]::PositiveInfinity
      $lineRight = [double]::NegativeInfinity
      $lineBottom = [double]::NegativeInfinity
      foreach ($word in $line.Words) {
        $wordText = ([string]$word.Text).Normalize([Text.NormalizationForm]::FormKC).Trim()
        if (-not $wordText) { continue }
        $box = $word.BoundingRect
        [void]$lineParts.Add($wordText)
        $lineLeft = [Math]::Min($lineLeft, [double]$box.X)
        $lineTop = [Math]::Min($lineTop, [double]$box.Y)
        $lineRight = [Math]::Max($lineRight, [double]($box.X + $box.Width))
        $lineBottom = [Math]::Max($lineBottom, [double]($box.Y + $box.Height))
        [void]$words.Add(@{
          text = $wordText
          compact = [Text.RegularExpressions.Regex]::Replace($wordText, "\\s+", "")
          bounds = @{ left = [double]$box.X; top = [double]$box.Y; width = [double]$box.Width; height = [double]$box.Height }
        })
      }
      if ($lineParts.Count -eq 0) { continue }
      $lineText = [string]::Join(" ", $lineParts.ToArray())
      $compact = [Text.RegularExpressions.Regex]::Replace($lineText, "\\s+", "")
      [void]$lines.Add(@{
        text = $lineText
        compact = $compact
        bounds = @{ left = $lineLeft; top = $lineTop; width = $lineRight - $lineLeft; height = $lineBottom - $lineTop }
      })
    }
    $normalizedText = [string]::Join(" ", @($lines.ToArray() | ForEach-Object { $_.compact }))
    $normalizedText = [Text.RegularExpressions.Regex]::Replace($normalizedText.Normalize([Text.NormalizationForm]::FormKC), "\\s+", " ").Trim()
    $layoutRows = @($lines.ToArray() | ForEach-Object {
      @($_.compact, [Math]::Round($_.bounds.left, 1), [Math]::Round($_.bounds.top, 1), [Math]::Round($_.bounds.width, 1), [Math]::Round($_.bounds.height, 1))
    })
    $layoutJson = $(if ($layoutRows.Count -eq 0) { "[]" } else { $layoutRows | ConvertTo-Json -Compress -Depth 4 })
    $layoutBytes = [Text.Encoding]::UTF8.GetBytes($layoutJson)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $layoutDigest = $sha.ComputeHash($layoutBytes) } finally { $sha.Dispose() }
    $layoutHash = [BitConverter]::ToString($layoutDigest).Replace("-", "").ToLowerInvariant()
    return @{ ok = $true; text = $normalizedText; lines = $lines.ToArray(); words = $words.ToArray(); layoutHash = $layoutHash }
  } catch {
    return @{ ok = $false; reason = "moments_visual_ocr_failed"; detail = [string]$_.Exception.Message }
  } finally {
    if ($software) { $software.Dispose() }
    if ($random) { $random.Dispose() }
    if ($memory) { $memory.Dispose() }
  }
}

function Get-MomentsOcrObservation($frame, $rect) {
  $crop = ConvertTo-MomentsOcrBitmap $frame $rect
  if ($crop -eq $null) { return @{ ok = $false; reason = "moments_visual_ocr_region_invalid" } }
  try {
    return Get-MomentsOcrObservationFromBitmap $crop
  } finally {
    $crop.Dispose()
  }
}

function Get-MomentsDownscaledOcrObservation($frame, $rect, [int]$factor = 1) {
  $safeFactor = [Math]::Max(1, [Math]::Min($factor, 3))
  if ($safeFactor -le 1) { return Get-MomentsOcrObservation $frame $rect }
  $crop = ConvertTo-MomentsOcrBitmap $frame $rect
  if ($crop -eq $null) { return @{ ok = $false; reason = "moments_visual_ocr_region_invalid" } }
  $scaled = $null
  $graphics = $null
  try {
    $scaledWidth = [Math]::Max(1, [int][Math]::Round($crop.Width / [double]$safeFactor))
    $scaledHeight = [Math]::Max(1, [int][Math]::Round($crop.Height / [double]$safeFactor))
    $scaled = [System.Drawing.Bitmap]::new(
      $scaledWidth,
      $scaledHeight,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage(
      $crop,
      [System.Drawing.Rectangle]::new(0, 0, $scaledWidth, $scaledHeight),
      0,
      0,
      $crop.Width,
      $crop.Height,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $ocr = Get-MomentsOcrObservationFromBitmap $scaled
    if (-not $ocr.ok) { return $ocr }
    foreach ($line in @($ocr.lines)) {
      $line.bounds.left = [double]$line.bounds.left * $safeFactor
      $line.bounds.top = [double]$line.bounds.top * $safeFactor
      $line.bounds.width = [double]$line.bounds.width * $safeFactor
      $line.bounds.height = [double]$line.bounds.height * $safeFactor
    }
    foreach ($word in @($ocr.words)) {
      $word.bounds.left = [double]$word.bounds.left * $safeFactor
      $word.bounds.top = [double]$word.bounds.top * $safeFactor
      $word.bounds.width = [double]$word.bounds.width * $safeFactor
      $word.bounds.height = [double]$word.bounds.height * $safeFactor
    }
    $ocr["downscaleFactor"] = $safeFactor
    return $ocr
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($scaled) { $scaled.Dispose() }
    $crop.Dispose()
  }
}

function Get-MomentsScaledOcrObservation($frame, $rect, [int]$scale = 3) {
  $crop = ConvertTo-MomentsOcrBitmap $frame $rect
  if ($crop -eq $null) { return @{ ok = $false; reason = "moments_visual_ocr_region_invalid" } }
  $scaled = $null
  $graphics = $null
  try {
    $safeScale = [Math]::Max(2, [Math]::Min($scale, 4))
    $scaled = [System.Drawing.Bitmap]::new(
      $crop.Width * $safeScale,
      $crop.Height * $safeScale,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage(
      $crop,
      [System.Drawing.Rectangle]::new(0, 0, $scaled.Width, $scaled.Height),
      0,
      0,
      $crop.Width,
      $crop.Height,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $graphics.Dispose()
    $graphics = $null
    $observation = Get-MomentsOcrObservationFromBitmap $scaled
    if (-not $observation.ok) { return $observation }
    foreach ($line in @($observation.lines)) {
      if ($line -eq $null) { continue }
      foreach ($name in @("left", "top", "width", "height")) {
        $line.bounds.$name = [double]$line.bounds.$name / $safeScale
      }
    }
    foreach ($word in @($observation.words)) {
      if ($word -eq $null) { continue }
      foreach ($name in @("left", "top", "width", "height")) {
        $word.bounds.$name = [double]$word.bounds.$name / $safeScale
      }
    }
    return $observation
  } catch {
    return @{ ok = $false; reason = "moments_visual_ocr_failed"; detail = [string]$_.Exception.Message }
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($scaled) { $scaled.Dispose() }
    $crop.Dispose()
  }
}

function Get-MomentsHighContrastOcrObservation($frame, $rect, [int]$scale = 4) {
  $crop = ConvertTo-MomentsOcrBitmap $frame $rect
  if ($crop -eq $null) { return @{ ok = $false; reason = "moments_visual_ocr_region_invalid" } }
  $binary = $null
  $scaled = $null
  $graphics = $null
  try {
    $safeScale = [Math]::Max(2, [Math]::Min($scale, 5))
    $padding = 16
    $binary = [System.Drawing.Bitmap]::new($crop.Width, $crop.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y = 0; $y -lt $crop.Height; $y++) {
      for ($x = 0; $x -lt $crop.Width; $x++) {
        $color = $crop.GetPixel($x, $y)
        $maximum = [Math]::Max([int]$color.R, [Math]::Max([int]$color.G, [int]$color.B))
        $minimum = [Math]::Min([int]$color.R, [Math]::Min([int]$color.G, [int]$color.B))
        $isLightNeutral = $minimum -ge 138 -and ($maximum - $minimum) -le 72
        $binary.SetPixel($x, $y, $(if ($isLightNeutral) { [System.Drawing.Color]::Black } else { [System.Drawing.Color]::White }))
      }
    }
    $scaled = [System.Drawing.Bitmap]::new(
      ($crop.Width * $safeScale) + ($padding * 2),
      ($crop.Height * $safeScale) + ($padding * 2),
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $graphics.DrawImage(
      $binary,
      [System.Drawing.Rectangle]::new($padding, $padding, $crop.Width * $safeScale, $crop.Height * $safeScale),
      0,
      0,
      $crop.Width,
      $crop.Height,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $graphics.Dispose()
    $graphics = $null
    $observation = Get-MomentsOcrObservationFromBitmap $scaled
    if (-not $observation.ok) { return $observation }
    foreach ($line in @($observation.lines)) {
      if ($line -eq $null) { continue }
      $line.bounds.left = ([double]$line.bounds.left - $padding) / $safeScale
      $line.bounds.top = ([double]$line.bounds.top - $padding) / $safeScale
      $line.bounds.width = [double]$line.bounds.width / $safeScale
      $line.bounds.height = [double]$line.bounds.height / $safeScale
    }
    foreach ($word in @($observation.words)) {
      if ($word -eq $null) { continue }
      $word.bounds.left = ([double]$word.bounds.left - $padding) / $safeScale
      $word.bounds.top = ([double]$word.bounds.top - $padding) / $safeScale
      $word.bounds.width = [double]$word.bounds.width / $safeScale
      $word.bounds.height = [double]$word.bounds.height / $safeScale
    }
    return $observation
  } catch {
    return @{ ok = $false; reason = "moments_visual_ocr_failed"; detail = [string]$_.Exception.Message }
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($scaled) { $scaled.Dispose() }
    if ($binary) { $binary.Dispose() }
    $crop.Dispose()
  }
}

function Get-MomentsPostIdentityText($ocr, $postRect, $menuBounds) {
  # Keep the post's own rows through the menu row. Likes and comments render
  # below that row, so they remain part of the full snapshot but not identity.
  $menuRowBottom = [double]$menuBounds.top + [double]$menuBounds.height - [double]$postRect.top
  $identityLines = @($ocr.lines | Where-Object {
    $lineCenterY = [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
    $lineCenterY -le $menuRowBottom
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  $identityText = [string]::Join(" ", @($identityLines | ForEach-Object { [string]$_.compact }))
  return [Text.RegularExpressions.Regex]::Replace(
    $identityText.Normalize([Text.NormalizationForm]::FormKC),
    "\\s+",
    " "
  ).Trim()
}

function Get-MomentsPostStableAnchorText($ocr, $postRect, $avatarBounds) {
  # Author and fixed body lines render beside the avatar. A playing video or
  # photo is below this band, so its changing OCR must not veto a same-post
  # relock. Require at least two lines; author-only posts keep the strong path.
  $avatarRowTop = [double]$avatarBounds.top - [double]$postRect.top
  $avatarRowBottom = $avatarRowTop + [double]$avatarBounds.height
  $anchorLines = @($ocr.lines | Where-Object {
    $lineCenterY = [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
    $lineCenterY -ge $avatarRowTop -and $lineCenterY -le $avatarRowBottom
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  if ($anchorLines.Count -lt 2) { return "" }
  $anchorText = [string]::Join(" ", @($anchorLines | ForEach-Object { [string]$_.compact }))
  $normalized = [Text.RegularExpressions.Regex]::Replace(
    $anchorText.Normalize([Text.NormalizationForm]::FormKC),
    "\\s+",
    " "
  ).Trim()
  if ($normalized.Length -lt 16) { return "" }
  return $normalized
}

function Get-MomentsVisualPostCandidates($frame, $viewportBounds) {
  $frameBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not (Test-MomentsVisualBoundsInside $viewportBounds $frameBounds)) { return @{ menus = @(); posts = @() } }
  $menus = @(Find-MomentsMenuDots $frame | Where-Object { Test-MomentsVisualBoundsInside $_.bounds $viewportBounds })
  $posts = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $menus.Count; $index++) {
    $menu = $menus[$index]
    $avatar = Find-MomentsAvatarForMenu $frame $menus $index $viewportBounds
    if (-not $avatar.ok -or -not (Test-MomentsVisualBoundsInside $avatar.bounds $viewportBounds)) { continue }
    $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
    $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
    $postLeft = [Math]::Max([double]$viewportBounds.left, [double]$avatar.bounds.left - 6.0)
    $postTop = [Math]::Max([double]$viewportBounds.top, [double]$avatar.bounds.top - 6.0)
    $postRight = [Math]::Min($viewportRight, [double]$menu.bounds.left + [double]$menu.bounds.width + 5.0)
    $unclippedPostBottom = [double]$menu.bounds.top + [double]$menu.bounds.height + [Math]::Max(48.0, [double]$avatar.bounds.height * 1.35)
    $postBottom = [Math]::Min($viewportBottom, $unclippedPostBottom)
    if ($postRight -le $postLeft -or $postBottom -le $postTop) { continue }
    $postRect = @{ left = $postLeft; top = $postTop; width = $postRight - $postLeft; height = $postBottom - $postTop }
    $ocr = Get-MomentsOcrObservation $frame $postRect
    if (-not $ocr.ok -or -not $ocr.text -or $ocr.text.Length -lt 8 -or $ocr.text.Length -gt 2000) { continue }
    $identityText = Get-MomentsPostIdentityText $ocr $postRect $menu.bounds
    $stableAnchorText = Get-MomentsPostStableAnchorText $ocr $postRect $avatar.bounds
    if (-not $identityText -or $identityText.Length -gt 2000) { continue }
    $regionHash = Get-MomentsPixelHash $frame $postRect
    $avatarHash = Get-MomentsPixelHash $frame $avatar.bounds
    if (-not $regionHash -or -not $avatarHash) { continue }
    [void]$posts.Add(@{
      text = [string]$ocr.text
      identityText = [string]$identityText
      stableAnchorText = [string]$stableAnchorText
      regionHash = $regionHash
      avatarHash = $avatarHash
      layoutHash = [string]$ocr.layoutHash
      bounds = $postRect
      menuBounds = $menu.bounds
      avatarBounds = $avatar.bounds
      partialVisible = $unclippedPostBottom -gt $viewportBottom
      ocrLines = $ocr.lines
    })
  }
  return @{ menus = $menus; posts = @($posts.ToArray() | Sort-Object { $_.bounds.top }) }
}
`;

module.exports = { MOMENTS_VISUAL_READONLY_POWERSHELL };
