const { WECHAT_RENDER_SURFACE_POWERSHELL } = require("./wechat_render_surface.cjs");
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
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsVisualReadOnly {
  // This scan runs thousands of times per frame. Keep the exact sampled pixels
  // and isolation rules, but avoid interpreting the inner loops in PowerShell.
  public static double[] MeasureAvatar(byte[] bytes, int stride, int width, int height, int left, int top, int size) {
    if (size <= 0 || left < 0 || top < 0 || left + size > width || top + size > height)
      return new double[] { 0, 0 };
    int foreground = 0, total = 0;
    for (int y = top; y < top + size; y += 4) {
      for (int x = left; x < left + size; x += 4) {
        int offset = y * stride + x * 4;
        if (!(bytes[offset + 2] >= 218 && bytes[offset + 1] >= 218 && bytes[offset] >= 218)) foreground++;
        total++;
      }
    }
    if (total == 0) return new double[] { 0, 0 };
    double foregroundRatio = (double)foreground / total;
    if (foregroundRatio < 0.16 || foregroundRatio > 0.98) return new double[] { 0, 0 };
    int ring = Math.Max(3, (int)Math.Round(size * 0.1));
    int ringLight = 0, ringTotal = 0;
    int[] sideLight = new int[4], sideTotal = new int[4];
    for (int y = top - ring; y < top + size + ring; y += 4) {
      for (int x = left - ring; x < left + size + ring; x += 4) {
        if (x >= left && x < left + size && y >= top && y < top + size) continue;
        int side = y < top ? 0 : y >= top + size ? 1 : x < left ? 2 : 3;
        sideTotal[side]++;
        if (x >= 0 && y >= 0 && x < width && y < height) {
          int offset = y * stride + x * 4;
          if (bytes[offset + 2] >= 218 && bytes[offset + 1] >= 218 && bytes[offset] >= 218) {
            ringLight++; sideLight[side]++;
          }
        }
        ringTotal++;
      }
    }
    if (ringTotal == 0) return new double[] { 0, 0 };
    double ringRatio = (double)ringLight / ringTotal;
    bool isolated = true;
    for (int side = 0; side < 4; side++) {
      if (sideTotal[side] == 0 || (double)sideLight[side] / sideTotal[side] < 0.50) { isolated = false; break; }
    }
    return new double[] { isolated ? 1 : 0, foregroundRatio * 0.68 + ringRatio * 0.32, foregroundRatio, ringRatio };
  }
  private static bool SelectedGreen(byte[] bytes, int offset) {
    int blue = bytes[offset], green = bytes[offset + 1], red = bytes[offset + 2];
    return green >= 105 && green - red >= 30 && green - blue >= 12;
  }
  public static double SelectedGreenRatio(byte[] bytes, int stride, int left, int top, int right, int bottom) {
    int selected = 0, total = 0;
    for (int y = top; y < bottom; y += 2) {
      for (int x = left; x < right; x += 2) {
        if (SelectedGreen(bytes, y * stride + x * 4)) selected++;
        total++;
      }
    }
    return total == 0 ? 0.0 : (double)selected / total;
  }
  public static int[] SelectedGreenRows(byte[] bytes, int stride, int left, int top, int right, int bottom) {
    var rows = new List<int>();
    for (int y = top; y <= bottom; y++) {
      int selected = 0, total = 0;
      for (int x = left; x <= right; x += 4) {
        if (SelectedGreen(bytes, y * stride + x * 4)) selected++;
        total++;
      }
      if (total > 0 && (double)selected / total >= 0.55) rows.Add(y);
    }
    return rows.ToArray();
  }
  public static int[] SelectedGreenColumns(byte[] bytes, int stride, int left, int top, int right, int bottom) {
    var columns = new List<int>();
    for (int x = left; x <= right; x++) {
      int selected = 0, total = 0;
      for (int y = top; y <= bottom; y += 2) {
        if (SelectedGreen(bytes, y * stride + x * 4)) selected++;
        total++;
      }
      if (total > 0 && (double)selected / total >= 0.45) columns.Add(x);
    }
    return columns.ToArray();
  }
  public static double LightRatio(byte[] bytes, int stride, int left, int top, int right, int bottom) {
    int light = 0, total = 0;
    for (int y = top; y < bottom; y += 2) {
      for (int x = left; x < right; x += 2) {
        int offset = y * stride + x * 4;
        if (bytes[offset + 2] >= 218 && bytes[offset + 1] >= 218 && bytes[offset] >= 218) light++;
        total++;
      }
    }
    return total == 0 ? 0.0 : (double)light / total;
  }
  public struct AvatarPeak { public int Left, Top; public double Score; }
  public static AvatarPeak[] AvatarPeaks(byte[] bytes, int stride, int width, int height, int[] columns, int top, int bottom, int size) {
    var peaks = new List<AvatarPeak>();
    foreach (int x in columns) {
      for (int y = top; y <= bottom; y += 4) {
        double[] measure = MeasureAvatar(bytes, stride, width, height, x, y, size);
        if (measure[0] == 1) peaks.Add(new AvatarPeak { Left = x, Top = y, Score = measure[1] });
      }
    }
    return peaks.ToArray();
  }
  public struct MenuComponent { public int Left, Right, Top, Bottom, Width, Height, Count; public double CenterX, CenterY; }
  public static MenuComponent[] MenuComponents(byte[] bytes, int stride, int left, int top, int right, int bottom, int[] bands) {
    int width = right - left, height = bottom - top;
    var mask = new bool[width * height];
    // The bands and four-neighbour connectivity match the original scan exactly.
    for (int x = 0; x < width; x++) {
      bool inside = false;
      for (int band = 0; band < bands.Length; band += 2) {
        if (x + left >= bands[band] && x + left < bands[band + 1]) { inside = true; break; }
      }
      if (!inside) continue;
      for (int y = 0; y < height; y++) {
        int offset = (top + y) * stride + (left + x) * 4;
        int blue = bytes[offset], green = bytes[offset + 1], red = bytes[offset + 2];
        int maximum = Math.Max(red, Math.Max(green, blue)), minimum = Math.Min(red, Math.Min(green, blue));
        mask[y * width + x] = maximum <= 205 && maximum - minimum <= 90;
      }
    }
    var components = new List<MenuComponent>();
    var queue = new Queue<int>();
    int[] dx = { -1, 1, 0, 0 }, dy = { 0, 0, -1, 1 };
    for (int seed = 0; seed < mask.Length; seed++) {
      if (!mask[seed]) continue;
      mask[seed] = false;
      queue.Enqueue(seed);
      int minX = seed % width, maxX = minX, minY = seed / width, maxY = minY, count = 0;
      while (queue.Count > 0) {
        int current = queue.Dequeue(), x = current % width, y = current / width;
        minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y); count++;
        for (int direction = 0; direction < 4; direction++) {
          int nextX = x + dx[direction], nextY = y + dy[direction];
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          int next = nextY * width + nextX;
          if (mask[next]) { mask[next] = false; queue.Enqueue(next); }
        }
      }
      int componentWidth = maxX - minX + 1, componentHeight = maxY - minY + 1;
      if (count >= 1 && count <= 36 && componentWidth >= 1 && componentWidth <= 7 && componentHeight >= 1 && componentHeight <= 7) {
        components.Add(new MenuComponent { Left = left + minX, Right = left + maxX, Top = top + minY, Bottom = top + maxY,
          Width = componentWidth, Height = componentHeight, Count = count, CenterX = left + (minX + maxX) / 2.0, CenterY = top + (minY + maxY) / 2.0 });
      }
    }
    return components.ToArray();
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
[void][Win32WechatMomentsVisualReadOnly]::SetThreadDpiAwarenessContext([IntPtr](-4))
$script:momentsMenuAboveWhitespaceMinimum = 0.66
$script:momentsMenuLeftWhitespaceMinimum = 0.60

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

${WECHAT_RENDER_SURFACE_POWERSHELL}

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
  [bool]$activate = $false,
  [bool]$requireFullViewportOwnership = $true
) {
  if (-not [Win32WechatMomentsVisualReadOnly]::IsWindowVisible($hWnd) -or [Win32WechatMomentsVisualReadOnly]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "moments_window_not_found" }
  }
  if ($activate) {
    return @{ ok = $false; reason = "moments_foreground_handoff_not_allowed" }
  }
  $foregroundReady = [Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -eq $hWnd
  if (-not $foregroundReady) {
    return @{
      ok = $false
      reason = "moments_window_not_foreground"
      expectedHWnd = [int64]$hWnd
      actualForegroundHWnd = [int64][Win32WechatMomentsVisualReadOnly]::GetForegroundWindow()
    }
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

function Get-MomentsPatchLightRatio($frame, [int]$left, [int]$top, [int]$right, [int]$bottom) {
  return [Win32WechatMomentsVisualReadOnly]::LightRatio($frame.bytes, $frame.stride,
    [Math]::Max(0, $left), [Math]::Max(0, $top), [Math]::Min($frame.width, $right), [Math]::Min($frame.height, $bottom))
}

function Get-MomentsVisualFeedScanProfile($viewportBounds, $avatarCandidates = $null) {
  $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
  $avatarSize = [int][Math]::Max(32, [Math]::Min(52, [Math]::Round([double]$viewportBounds.width * 0.09)))
  $anchorCandidates = New-Object System.Collections.Generic.List[double]
  [void]$anchorCandidates.Add([double]$viewportBounds.left + ([double]$viewportBounds.width * 0.055))
  [void]$anchorCandidates.Add(
    [double]$viewportBounds.left + ([double]$viewportBounds.width / 2.0) - ($avatarSize * 5.0)
  )
  foreach ($avatar in @($avatarCandidates)) {
    if ($avatar -ne $null -and [double]$avatar.width -gt 0 -and [double]$avatar.height -gt 0) {
      [void]$anchorCandidates.Add([double]$avatar.left)
    }
  }

  $anchors = New-Object System.Collections.Generic.List[double]
  foreach ($candidate in @($anchorCandidates.ToArray())) {
    $clamped = [Math]::Max(
      [double]$viewportBounds.left,
      [Math]::Min($viewportRight - $avatarSize, [double]$candidate)
    )
    $duplicate = $false
    foreach ($existing in $anchors) {
      if ([Math]::Abs([double]$existing - $clamped) -le 2.0) { $duplicate = $true; break }
    }
    if (-not $duplicate) { [void]$anchors.Add($clamped) }
  }

  $avatarXPositions = New-Object System.Collections.Generic.HashSet[int]
  foreach ($anchor in $anchors) {
    # Centered feeds can put the avatar a full text-column gap left of the
    # estimated anchor. Include that lane instead of scanning only the body.
    for ($offset = -($avatarSize * 2); $offset -le $avatarSize; $offset += 4) {
      $x = [int][Math]::Round([Math]::Max(
        [double]$viewportBounds.left,
        [Math]::Min($viewportRight - $avatarSize, [double]$anchor + $offset)
      ))
      [void]$avatarXPositions.Add($x)
    }
    foreach ($offset in @(-2, 0, 2)) {
      $x = [int][Math]::Round([Math]::Max(
        [double]$viewportBounds.left,
        [Math]::Min($viewportRight - $avatarSize, [double]$anchor + $offset)
      ))
      [void]$avatarXPositions.Add($x)
    }
  }

  $menuBands = New-Object System.Collections.Generic.List[object]
  $expandedLayout = $avatarSize -ge 48
  $rightGutterLeftRatio = $(if ($expandedLayout) { 0.74 } else { 0.86 })
  $rightGutterRightRatio = $(if ($expandedLayout) { 0.84 } else { 0.95 })
  $rightGutterLeft = [Math]::Floor([double]$viewportBounds.left + ([double]$viewportBounds.width * $rightGutterLeftRatio))
  $rightGutterRight = [Math]::Ceiling([double]$viewportBounds.left + ([double]$viewportBounds.width * $rightGutterRightRatio))
  if (($rightGutterRight - $rightGutterLeft) -ge 12.0) {
    [void]$menuBands.Add(@{ left = [double]$rightGutterLeft; right = [double]$rightGutterRight })
  }
  return @{
    avatarSize = $avatarSize
    avatarXPositions = @($avatarXPositions | Sort-Object)
    menuBands = @($menuBands.ToArray())
  }
}

function Get-MomentsInteractionWhitespaceEvidence($frame, $menu, [double]$avatarSize, $viewportBounds) {
  $aboveDepth = [Math]::Max(44.0, $avatarSize * 1.1)
  $leftDepth = [Math]::Max(52.0, $avatarSize * 1.2)
  $aboveTop = [int][Math]::Max([double]$viewportBounds.top, [double]$menu.centerY - $aboveDepth)
  $aboveBottom = [int][Math]::Floor([double]$menu.centerY - 14.0)
  $leftEdge = [int][Math]::Max([double]$viewportBounds.left, [double]$menu.centerX - $leftDepth)
  $leftRight = [int][Math]::Floor([double]$menu.centerX - 20.0)
  $aboveRatio = Get-MomentsPatchLightRatio $frame ([int]([double]$menu.centerX - 18.0)) $aboveTop ([int]([double]$menu.centerX + 19.0)) $aboveBottom
  $leftRatio = Get-MomentsPatchLightRatio $frame $leftEdge ([int]([double]$menu.centerY - 12.0)) $leftRight ([int]([double]$menu.centerY + 13.0))
  return @{
    ok = $aboveBottom -gt $aboveTop -and $leftRight -gt $leftEdge -and
      $aboveRatio -ge $script:momentsMenuAboveWhitespaceMinimum -and
      $leftRatio -ge $script:momentsMenuLeftWhitespaceMinimum
    aboveRatio = $aboveRatio
    leftRatio = $leftRatio
  }
}

function Find-MomentsMenuDotsDetailed($frame, $viewportBounds = $null, $avatarCandidates = $null, $localBounds = $null) {
  # The interaction button lives in a dedicated right gutter. We classify the
  # icon by connected components: this WeChat render profile draws the menu
  # as two compact, separated dots on one baseline. Text ellipses use three
  # much smaller components, while a disclosure chevron is one component.
  $frameBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  $scanViewport = $viewportBounds
  if (-not (Test-MomentsVisualBoundsInside $scanViewport $frameBounds)) {
    $scanViewport = $script:momentsVisualViewportBounds
  }
  if (-not (Test-MomentsVisualBoundsInside $scanViewport $frameBounds)) {
    $scanViewport = $frameBounds
  }
  $viewportRight = [double]$scanViewport.left + [double]$scanViewport.width
  $viewportBottom = [double]$scanViewport.top + [double]$scanViewport.height
  $scanProfile = Get-MomentsVisualFeedScanProfile $scanViewport $avatarCandidates
  $scanBands = @($scanProfile.menuBands)
  if ($scanBands.Count -eq 0) {
    return @{
      menus = @()
      diagnostics = @{
        componentCount = 0
        rawCandidateCount = 0
        acceptedCandidateCount = 0
        rejectedWhitespaceCount = 0
        rejectedAvatarLaneCount = 0
      }
    }
  }
  $xStart = [int][Math]::Max(
    [double]$scanViewport.left,
    [Math]::Floor(($scanBands | ForEach-Object { [double]$_.left } | Measure-Object -Minimum).Minimum)
  )
  $xEnd = [int][Math]::Min(
    $viewportRight,
    [Math]::Ceiling(($scanBands | ForEach-Object { [double]$_.right } | Measure-Object -Maximum).Maximum)
  )
  if (Test-MomentsVisualBoundsInside $localBounds $scanViewport) {
    $xStart = [int][Math]::Max($xStart, [Math]::Floor([double]$localBounds.left))
    $xEnd = [int][Math]::Min($xEnd, [Math]::Ceiling([double]$localBounds.left + [double]$localBounds.width))
  }
  $gutterWidth = $xEnd - $xStart
  $yStart = [int][Math]::Max(
    [double]$scanViewport.top,
    [double]$scanViewport.top + [Math]::Max(48.0, [Math]::Floor([double]$scanViewport.height * 0.04))
  )
  $yEnd = [int][Math]::Min(
    $viewportBottom - 12.0,
    [double]$scanViewport.top + [Math]::Ceiling([double]$scanViewport.height * 0.99)
  )
  if (Test-MomentsVisualBoundsInside $localBounds $scanViewport) {
    $yStart = [int][Math]::Max($yStart, [Math]::Floor([double]$localBounds.top))
    $yEnd = [int][Math]::Min($yEnd, [Math]::Ceiling([double]$localBounds.top + [double]$localBounds.height))
  }
  $gutterHeight = $yEnd - $yStart
  if ($gutterWidth -lt 12 -or $gutterHeight -lt 12) {
    return @{ menus = @(); diagnostics = @{ componentCount = 0; rawCandidateCount = 0; acceptedCandidateCount = 0; rejectedWhitespaceCount = 0; rejectedAvatarLaneCount = 0 } }
  }
  $bands = [int[]]@($scanBands | ForEach-Object { [int][Math]::Floor([double]$_.left); [int][Math]::Ceiling([double]$_.right) })
  $components = [Win32WechatMomentsVisualReadOnly]::MenuComponents($frame.bytes, $frame.stride, $xStart, $yStart, $xEnd, $yEnd, $bands)
  $ordered = @($components | Sort-Object { [double]$_.centerY }, { [double]$_.centerX })
  $menus = New-Object System.Collections.Generic.List[object]
  $rawCandidateCount = 0
  $rejectedWhitespaceCount = 0
  $rejectedAvatarLaneCount = 0
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
      $rawCandidateCount += 1
      $candidateMenu = @{ centerX = $centerX; centerY = $centerY; bounds = @{ left = $centerX - 18; top = $centerY - 12; width = 36; height = 24 } }
      $whitespace = Get-MomentsInteractionWhitespaceEvidence $frame $candidateMenu ([double]$scanProfile.avatarSize) $scanViewport
      if (-not $whitespace.ok) { $rejectedWhitespaceCount += 1; continue }
      if (@($avatarCandidates).Count -gt 0) {
        $laneMatches = @($avatarCandidates | Where-Object {
          $horizontalSpan = [double]$candidateMenu.centerX - [double]$_.left
          [double]$_.top -le ([double]$candidateMenu.centerY - ([double]$scanProfile.avatarSize * 1.2)) -and
            $horizontalSpan -ge ([double]$scanProfile.avatarSize * 3.0) -and
            $horizontalSpan -le ([double]$scanViewport.width * 0.95)
        })
        if ($laneMatches.Count -eq 0) { $rejectedAvatarLaneCount += 1; continue }
      }
      $duplicate = $false
      foreach ($existing in $menus) {
        if ([Math]::Abs($existing.centerX - $centerX) -le 6 -and [Math]::Abs($existing.centerY - $centerY) -le 10) { $duplicate = $true; break }
      }
      if (-not $duplicate) {
        [void]$menus.Add(@{
          centerX = $centerX
          centerY = $centerY
          bounds = $candidateMenu.bounds
          aboveWhitespaceRatio = [double]$whitespace.aboveRatio
          leftWhitespaceRatio = [double]$whitespace.leftRatio
        })
      }
      break
    }
  }
  $accepted = @($menus.ToArray() | Sort-Object { [double]$_.centerY }, { [double]$_.centerX })
  return @{
    menus = $accepted
    diagnostics = @{
      componentCount = [int]$components.Count
      rawCandidateCount = [int]$rawCandidateCount
      acceptedCandidateCount = [int]$accepted.Count
      rejectedWhitespaceCount = [int]$rejectedWhitespaceCount
      rejectedAvatarLaneCount = [int]$rejectedAvatarLaneCount
    }
  }
}

function Find-MomentsMenuDots($frame, $viewportBounds = $null, $avatarCandidates = $null) {
  $result = Find-MomentsMenuDotsDetailed $frame $viewportBounds $avatarCandidates $null
  return @($result.menus)
}

function Resolve-MomentsInteractionAnchor(
  $frame,
  $viewportBounds,
  $expectedMenuBounds,
  $expectedAvatarBounds,
  [string]$expectedAvatarHash,
  [double]$tolerance = 12.0
) {
  if (-not (Test-MomentsVisualBoundsInside $expectedMenuBounds $viewportBounds) -or
    ($expectedAvatarBounds -ne $null -and -not (Test-MomentsVisualBoundsInside $expectedAvatarBounds $viewportBounds))) {
    return @{ ok = $false; reason = "moments_visual_target_lock_invalid"; diagnostics = @{ rawCandidateCount = 0; acceptedCandidateCount = 0 } }
  }
  if ($expectedAvatarBounds -ne $null -and $expectedAvatarHash) {
    $avatarHash = Get-MomentsPixelHash $frame $expectedAvatarBounds
    $avatarHashMatched = [bool]($avatarHash -and [string]$avatarHash -ceq $expectedAvatarHash)
  } else {
    $avatarHash = ""
    $avatarHashMatched = $true
  }
  $localBounds = @{
    left = [Math]::Max([double]$viewportBounds.left, [double]$expectedMenuBounds.left - $tolerance)
    top = [Math]::Max([double]$viewportBounds.top, [double]$expectedMenuBounds.top - $tolerance)
    width = [double]$expectedMenuBounds.width + ($tolerance * 2.0)
    height = [double]$expectedMenuBounds.height + ($tolerance * 2.0)
  }
  $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
  $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
  $localBounds.width = [Math]::Min([double]$localBounds.width, $viewportRight - [double]$localBounds.left)
  $localBounds.height = [Math]::Min([double]$localBounds.height, $viewportBottom - [double]$localBounds.top)
  $avatars = $(if ($expectedAvatarBounds -ne $null) { @($expectedAvatarBounds) } else { @() })
  $read = Find-MomentsMenuDotsDetailed $frame $viewportBounds $avatars $localBounds
  $matches = @($read.menus | Where-Object {
    [Math]::Abs([double]$_.bounds.left - [double]$expectedMenuBounds.left) -le $tolerance -and
      [Math]::Abs([double]$_.bounds.top - [double]$expectedMenuBounds.top) -le $tolerance -and
      [Math]::Abs([double]$_.bounds.width - [double]$expectedMenuBounds.width) -le 3.0 -and
      [Math]::Abs([double]$_.bounds.height - [double]$expectedMenuBounds.height) -le 3.0
  })
  $diagnostics = @{
    componentCount = [int]$read.diagnostics.componentCount
    rawCandidateCount = [int]$read.diagnostics.rawCandidateCount
    acceptedCandidateCount = [int]$matches.Count
    rejectedWhitespaceCount = [int]$read.diagnostics.rejectedWhitespaceCount
    rejectedAvatarLaneCount = [int]$read.diagnostics.rejectedAvatarLaneCount
    searchBounds = $localBounds
    avatarHashMatched = $avatarHashMatched
  }
  if ($matches.Count -eq 0) { return @{ ok = $false; reason = "moments_menu_not_found"; diagnostics = $diagnostics } }
  if ($matches.Count -ne 1) { return @{ ok = $false; reason = "moments_menu_ambiguous"; diagnostics = $diagnostics } }
  return @{ ok = $true; reason = ""; menu = $matches[0]; avatarHash = $avatarHash; diagnostics = $diagnostics }
}

function Test-MomentsVisualBoundsInside($inner, $outer) {
  if ($inner -eq $null -or $outer -eq $null) { return $false }
  return [double]$inner.width -gt 0 -and [double]$inner.height -gt 0 -and
    [double]$outer.width -gt 0 -and [double]$outer.height -gt 0 -and
    [double]$inner.left -ge [double]$outer.left -and [double]$inner.top -ge [double]$outer.top -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height)
}

function Find-MomentsAvatarForMenu($frame, $menus, [int]$menuIndex, $viewportBounds, $visibleAvatars = $null) {
  $menu = $menus[$menuIndex]
  $profile = Get-MomentsVisualFeedScanProfile $viewportBounds $visibleAvatars
  $size = [int]$profile.avatarSize
  $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
  $previousMenuY = if ($menuIndex -gt 0) { [double]$menus[$menuIndex - 1].centerY } else { [double]$viewportBounds.top }
  $yStart = [int][Math]::Max([double]$viewportBounds.top, [Math]::Round($previousMenuY + ($size * 0.45)))
  $yEnd = [int][Math]::Min($viewportBottom - $size, [Math]::Floor($menu.centerY - ($size * 1.6)))
  if ($yEnd -lt $yStart) { return @{ ok = $false; reason = "moments_visual_avatar_not_found" } }
  if ($visibleAvatars -ne $null) {
    $avatars = @($visibleAvatars)
  } else {
    $avatars = @(Find-MomentsVisibleAvatars $frame $viewportBounds)
  }
  $candidates = @($avatars | Where-Object {
    [double]$_.top -ge $yStart -and [double]$_.top -le $yEnd -and
      ([double]$_.left + [double]$_.width) -lt ([double]$menu.centerX - ($size * 1.5))
  })
  if ($candidates.Count -eq 0) { return @{ ok = $false; reason = "moments_visual_avatar_not_found" } }
  # Prefer the isolated avatar evidence, not the image/text patch nearest
  # the footer. Distance is only a tie-breaker within the same post interval.
  $ordered = @($candidates | Sort-Object @{ Expression = { [double]$_.score }; Descending = $true }, @{ Expression = {
    [double]$menu.centerY - ([double]$_.top + [double]$_.height)
  }; Descending = $false })
  $best = $ordered[0]
  if ($ordered.Count -gt 1) {
    $bestGap = [double]$menu.centerY - ([double]$best.top + [double]$best.height)
    $nextGap = [double]$menu.centerY - ([double]$ordered[1].top + [double]$ordered[1].height)
    if ([Math]::Abs($bestGap - $nextGap) -le ($size * 0.20) -and
      [Math]::Abs([double]$best.top - [double]$ordered[1].top) -gt ($size * 0.35)) {
      return @{ ok = $false; reason = "moments_visual_avatar_ambiguous" }
    }
  }
  return @{ ok = $true; bounds = @{ left = [double]$best.left; top = [double]$best.top; width = [double]$size; height = [double]$size }; score = $best.score }
}

function Find-MomentsVisibleAvatars($frame, $viewportBounds) {
  $profile = Get-MomentsVisualFeedScanProfile $viewportBounds
  $size = [int]$profile.avatarSize
  $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
  $peaks = [Win32WechatMomentsVisualReadOnly]::AvatarPeaks($frame.bytes, $frame.stride, $frame.width, $frame.height,
    [int[]]$profile.avatarXPositions, [int][Math]::Ceiling([double]$viewportBounds.top), [int][Math]::Floor($viewportBottom - $size), $size)
  $avatars = New-Object System.Collections.Generic.List[object]
  foreach ($peak in @($peaks | Sort-Object @{ Expression = { [double]$_.score }; Descending = $true }, @{ Expression = { [double]$_.top }; Descending = $false })) {
    $duplicate = $false
    foreach ($existing in $avatars) {
      if ([Math]::Abs([double]$existing.left - [double]$peak.left) -le ($size * 0.9) -and
        [Math]::Abs([double]$existing.top - [double]$peak.top) -le ($size * 1.15)) { $duplicate = $true; break }
    }
    if (-not $duplicate) {
      [void]$avatars.Add(@{
        left = [double]$peak.left
        top = [double]$peak.top
        width = [double]$size
        height = [double]$size
        score = [double]$peak.score
      })
    }
  }
  return @($avatars.ToArray() | Sort-Object { [double]$_.top }, { [double]$_.left })
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

function Get-MomentsAvatarAnchorHashes($frame, $rect) {
  # Keep exact interior pixels, allowing only a one-pixel detection offset.
  $size = [Math]::Floor([Math]::Min([double]$rect.width, [double]$rect.height)) - 8
  if ($size -lt 24) { return @() }
  $hashes = @()
  for ($dy = -1; $dy -le 1; $dy++) {
    for ($dx = -1; $dx -le 1; $dx++) {
      $crop = @{ left=([Math]::Floor([double]$rect.left)+4+$dx); top=([Math]::Floor([double]$rect.top)+4+$dy); width=$size; height=$size }
      $hashes += Get-MomentsPixelHash $frame $crop
    }
  }
  return @($hashes | Select-Object -Unique)
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
    [void]$writer.DetachStream()
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
          compact = [Text.RegularExpressions.Regex]::Replace($wordText, "\s+", "")
          bounds = @{ left = [double]$box.X; top = [double]$box.Y; width = [double]$box.Width; height = [double]$box.Height }
        })
      }
      if ($lineParts.Count -eq 0) { continue }
      $lineText = [string]::Join(" ", $lineParts.ToArray())
      $compact = [Text.RegularExpressions.Regex]::Replace($lineText, "\s+", "")
      [void]$lines.Add(@{
        text = $lineText
        compact = $compact
        bounds = @{ left = $lineLeft; top = $lineTop; width = $lineRight - $lineLeft; height = $lineBottom - $lineTop }
      })
    }
    $normalizedText = [string]::Join(" ", @($lines.ToArray() | ForEach-Object { $_.compact }))
    $normalizedText = [Text.RegularExpressions.Regex]::Replace($normalizedText.Normalize([Text.NormalizationForm]::FormKC), "\s+", " ").Trim()
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

function Get-MomentsPostContentText($ocr, $postRect, $avatarBounds, $menuBounds = $null) {
  $bodyTop = [double]$avatarBounds.top + ([double]$avatarBounds.height / 2.0) - [double]$postRect.top
  $bodyBottom = if ($menuBounds) { [double]$menuBounds.top - [double]$postRect.top } else { [double]$postRect.height }
  if (-not $menuBounds) {
    $footer = @($ocr.lines | Where-Object {
      ([string]$_.compact -match '^(刚刚|昨天|前天|今天|\d+(分钟|小时|天)前|\d{1,2}月\d{1,2}日)') -and
      [double]$_.bounds.top -gt $bodyTop
    } | Sort-Object { [double]$_.bounds.top } | Select-Object -First 1)
    if ($footer.Count -gt 0) { $bodyBottom = [double]$footer[0].bounds.top }
  }
  $lines = @($ocr.lines | Where-Object {
    $centerY = [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
    $centerY -gt $bodyTop -and $centerY -lt $bodyBottom -and [string]$_.compact -notmatch '^(全文|收起)$'
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  return [string]::Join([Environment]::NewLine, @($lines | ForEach-Object { [string]$_.compact }))
}

function Get-MomentsVisualPostCandidates($frame, $viewportBounds, [bool]$includeText = $true, $previousRead = $null) {
  $frameBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not (Test-MomentsVisualBoundsInside $viewportBounds $frameBounds)) {
    return @{ menus = @(); posts = @(); interactionPosts = @(); postBoundaries = @(); visibleAvatars = @() }
  }
  $viewportHash = Get-MomentsPixelHash $frame $viewportBounds
  $sameViewport = $previousRead -ne $null -and $viewportHash -and
    [string]$previousRead.viewportHash -ceq $viewportHash
  foreach ($coordinate in @("left", "top", "width", "height")) {
    if ($previousRead -eq $null -or [double]$previousRead.viewportBounds.$coordinate -ne [double]$viewportBounds.$coordinate) { $sameViewport = $false }
  }
  # Reuse only geometry from a byte-identical viewport. Text is still read from
  # the second frame; any pixel or bounds change takes the normal full scan.
  if ($sameViewport) {
    $visibleAvatars = @($previousRead.visibleAvatars)
    $menuRead = @{ menus = @($previousRead.menus); diagnostics = $previousRead.menuDiagnostics }
  } else {
    $visibleAvatars = @(Find-MomentsVisibleAvatars $frame $viewportBounds)
    $menuRead = Find-MomentsMenuDotsDetailed $frame $viewportBounds $visibleAvatars
  }
  $menus = @($menuRead.menus | Where-Object { Test-MomentsVisualBoundsInside $_.bounds $viewportBounds })
  $posts = New-Object System.Collections.Generic.List[object]
  $interactionPosts = New-Object System.Collections.Generic.List[object]
  $postBoundaries = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $menus.Count; $index++) {
    $menu = $menus[$index]
    $avatar = Find-MomentsAvatarForMenu $frame $menus $index $viewportBounds $visibleAvatars
    if (-not $avatar.ok -or -not (Test-MomentsVisualBoundsInside $avatar.bounds $viewportBounds)) {
      [void]$postBoundaries.Add(@{
        ok = $false
        menuBounds = $menu.bounds
        reason = $(if ($avatar.reason) { [string]$avatar.reason } else { "moments_visual_avatar_not_found" })
      })
      continue
    }
    $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
    $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
    $postLeft = [Math]::Max([double]$viewportBounds.left, [double]$avatar.bounds.left - 6.0)
    $postTop = [Math]::Max([double]$viewportBounds.top, [double]$avatar.bounds.top - 6.0)
    [void]$postBoundaries.Add(@{
      ok = $true
      top = $postTop
      menuBounds = $menu.bounds
      avatarBounds = $avatar.bounds
    })
    $postRight = [Math]::Min($viewportRight, [double]$menu.bounds.left + [double]$menu.bounds.width + 5.0)
    $unclippedPostBottom = [double]$menu.bounds.top + [double]$menu.bounds.height + [Math]::Max(48.0, [double]$avatar.bounds.height * 1.35)
    $postBottom = [Math]::Min($viewportBottom, $unclippedPostBottom)
    if ($postRight -le $postLeft -or $postBottom -le $postTop) { continue }
    $postRect = @{ left = $postLeft; top = $postTop; width = $postRight - $postLeft; height = $postBottom - $postTop }
    $menuHash = Get-MomentsPixelHash $frame $menu.bounds
    $avatarHash = Get-MomentsPixelHash $frame $avatar.bounds
    if (-not $menuHash -or -not $avatarHash) { continue }
    [void]$interactionPosts.Add(@{
      text = ""
      identityText = ("interaction-anchor:{0}:{1}" -f $avatarHash, $menuHash)
      stableAnchorText = ""
      structureVerified = $true
      interactionOnly = $true
      regionHash = $menuHash
      menuHash = $menuHash
      avatarHash = $avatarHash
      layoutHash = $menuHash
      bounds = $postRect
      menuBounds = $menu.bounds
      avatarBounds = $avatar.bounds
      partialVisible = $unclippedPostBottom -gt $viewportBottom
    })
    if (-not $includeText) { continue }
    $ocr = Get-MomentsOcrObservation $frame $postRect
    if (-not $ocr.ok -or -not $ocr.text -or $ocr.text.Length -lt 8 -or $ocr.text.Length -gt 2000) { continue }
    $identityText = Get-MomentsPostIdentityText $ocr $postRect $menu.bounds
    $stableAnchorText = Get-MomentsPostStableAnchorText $ocr $postRect $avatar.bounds
    if (-not $identityText -or $identityText.Length -gt 2000) { continue }
    $regionHash = Get-MomentsPixelHash $frame $postRect
    if (-not $regionHash) { continue }
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
      contentText = Get-MomentsPostContentText $ocr $postRect $avatar.bounds $menu.bounds
      avatarAnchorHashes = @(Get-MomentsAvatarAnchorHashes $frame $avatar.bounds)
    })
  }
  return @{
    menus = $menus
    viewportHash = $viewportHash
    viewportBounds = $viewportBounds
    geometryReused = [bool]$sameViewport
    posts = @($posts.ToArray() | Sort-Object { $_.bounds.top })
    interactionPosts = @($interactionPosts.ToArray() | Sort-Object { $_.bounds.top })
    menuDiagnostics = $menuRead.diagnostics
    postBoundaries = @($postBoundaries.ToArray() | Sort-Object { [double]$_.menuBounds.top })
    visibleAvatars = $visibleAvatars
  }
}

function Get-MomentsVisualReadingCandidates($frame, $viewportBounds, $visibleAvatars = $null) {
  $frameBounds = @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not (Test-MomentsVisualBoundsInside $viewportBounds $frameBounds)) { return @() }
  if ($visibleAvatars -ne $null) {
    $avatars = @($visibleAvatars)
  } else {
    $avatars = @(Find-MomentsVisibleAvatars $frame $viewportBounds)
  }
  $viewportRight = [double]$viewportBounds.left + [double]$viewportBounds.width
  $viewportBottom = [double]$viewportBounds.top + [double]$viewportBounds.height
  $readingCandidates = New-Object System.Collections.Generic.List[object]
  # All post avatars share the leading column. Blue comment text and image
  # details to its right can pass the coarse square detector, but are not posts.
  if ($avatars.Count -gt 0) {
    $leadingAvatar = @($avatars | Sort-Object { [double]$_.left })[0]
    $avatars = @($avatars | Where-Object {
      [Math]::Abs([double]$_.left - [double]$leadingAvatar.left) -le ([double]$leadingAvatar.width * 0.35)
    })
  }
  for ($index = 0; $index -lt $avatars.Count; $index++) {
    $avatar = $avatars[$index]
    # Author text beside a real avatar is not a second post on the same row.
    $strongerSameRow = @($avatars | Where-Object {
      [Math]::Abs([double]$_.top - [double]$avatar.top) -lt ([double]$avatar.height / 2.0) -and
      [double]$_.score -gt [double]$avatar.score
    })
    if ($strongerSameRow.Count -gt 0) { continue }
    $postLeft = [Math]::Max([double]$viewportBounds.left, [double]$avatar.left - 6.0)
    $postTop = [Math]::Max([double]$viewportBounds.top, [double]$avatar.top - 6.0)
    # Text and thumbnails beside the avatar must not split a reading region.
    $nextTop = $viewportBottom
    foreach ($candidate in $avatars) {
      if ([double]$candidate.top -gt ([double]$avatar.top + [double]$avatar.height) -and
        [Math]::Abs([double]$candidate.left - [double]$avatar.left) -le ([double]$avatar.width * 0.35)) {
        $nextTop = [Math]::Min($nextTop, [double]$candidate.top - 12.0)
      }
    }
    $postRight = [Math]::Min($viewportRight, [double]$viewportBounds.left + ([double]$viewportBounds.width * 0.95))
    $postBottom = [Math]::Min($viewportBottom, $nextTop)
    if ($postRight -le $postLeft -or $postBottom -le ($postTop + [double]$avatar.height)) { continue }
    $postRect = @{ left = $postLeft; top = $postTop; width = $postRight - $postLeft; height = $postBottom - $postTop }
    $ocr = Get-MomentsOcrObservation $frame $postRect
    if (-not $ocr.ok) { continue }
    $stableAnchorText = Get-MomentsPostStableAnchorText $ocr $postRect $avatar
    if (-not $stableAnchorText -or $stableAnchorText.Length -gt 2000) { continue }
    $regionHash = Get-MomentsPixelHash $frame $postRect
    $avatarHash = Get-MomentsPixelHash $frame $avatar
    if (-not $regionHash -or -not $avatarHash) { continue }
    [void]$readingCandidates.Add(@{
      text = [string]$ocr.text
      identityText = [string]$ocr.text
      contentText = Get-MomentsPostContentText $ocr $postRect $avatar
      stableAnchorText = [string]$stableAnchorText
      structureVerified = $true
      regionHash = [string]$regionHash
      avatarHash = [string]$avatarHash
      layoutHash = [string]$ocr.layoutHash
      bounds = $postRect
      avatarBounds = $avatar
      partialVisible = $true
      bodyOnly = $true
      avatarAnchorHashes = @(Get-MomentsAvatarAnchorHashes $frame $avatar)
    })
  }
  return @($readingCandidates.ToArray() | Sort-Object { [double]$_.bounds.top })
}
`;

module.exports = { MOMENTS_VISUAL_READONLY_POWERSHELL };
