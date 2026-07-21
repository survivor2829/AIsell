const { runPowerShellAsync } = require("./wechat_window_driver.cjs");
const { gzipSync } = require("node:zlib");

function classifyAvatarSide({ leftAvatar = false, rightAvatar = false } = {}) {
  if (leftAvatar === true && rightAvatar !== true) return "user";
  if (rightAvatar === true && leftAvatar !== true) return "assistant";
  return null;
}

function normalizeContextItem(item) {
  const role = item?.role === "user" || item?.role === "assistant" ? item.role : "";
  const content = String(item?.content || "").trim();
  const key = String(item?.key || "").trim();
  return role && content && key ? { role, content, key } : null;
}

function mergeContextPages(currentPage, previousPage) {
  if (!Array.isArray(currentPage) || currentPage.length === 0) return { ok: false, reason: "history_empty" };
  const current = currentPage.map(normalizeContextItem);
  if (current.some((item) => !item)) return { ok: false, reason: "history_item_invalid" };
  if (new Set(current.map((item) => item.key)).size !== current.length) return { ok: false, reason: "history_overlap_ambiguous" };
  if (previousPage === undefined || previousPage === null) return { ok: true, context: current.slice(-12) };
  if (!Array.isArray(previousPage) || previousPage.length === 0) return { ok: false, reason: "history_overlap_missing" };

  const previous = previousPage.map(normalizeContextItem);
  if (previous.some((item) => !item)) return { ok: false, reason: "history_item_invalid" };
  if (new Set(previous.map((item) => item.key)).size !== previous.length) return { ok: false, reason: "history_overlap_ambiguous" };
  const overlapStarts = previous
    .map((item, index) => item.key === current[0].key ? index : -1)
    .filter((index) => index >= 0);
  if (overlapStarts.length === 0) return { ok: false, reason: "history_overlap_missing" };
  if (overlapStarts.length !== 1) return { ok: false, reason: "history_overlap_ambiguous" };

  const overlapStart = overlapStarts[0];
  const overlapLength = previous.length - overlapStart;
  if (overlapLength > current.length) return { ok: false, reason: "history_overlap_mismatch" };
  for (let index = 0; index < overlapLength; index += 1) {
    const older = previous[overlapStart + index];
    const newer = current[index];
    if (older.key !== newer.key || older.role !== newer.role || older.content !== newer.content) {
      return { ok: false, reason: "history_overlap_mismatch" };
    }
  }

  const context = previous.slice(0, overlapStart).concat(current);
  if (new Set(context.map((item) => item.key)).size !== context.length) return { ok: false, reason: "history_overlap_ambiguous" };
  return { ok: true, context: context.slice(-12) };
}

const AUTO_REPLY_SCAN_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatAutoReply {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][Win32WechatAutoReply]::SetProcessDPIAware()

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 5
  exit
}

function Get-ElementText([System.Windows.Automation.AutomationElement]$element) {
  try {
    $name = [string]$element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { return $name.Trim() }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern -and -not [string]::IsNullOrWhiteSpace($pattern.Current.Value)) { return ([string]$pattern.Current.Value).Trim() }
  } catch {}
  return ""
}

function Get-ElementKey([System.Windows.Automation.AutomationElement]$element, $rect, [string]$text) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return [string]("rect:{0}:{1}:{2}:{3}:{4}" -f [int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom, $text)
}

function Get-ChatList([System.Windows.Automation.AutomationElement]$root) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    try { $automationId = [string]$element.Current.AutomationId } catch { continue }
    if ($automationId -ceq "chat_message_list") { return $element }
  }
  return $null
}

function Test-ViewportOwned($rect, [IntPtr]$expectedHwnd, [int]$expectedPid) {
  foreach ($xRatio in @(0.08, 0.5, 0.92)) {
    foreach ($yRatio in @(0.12, 0.5, 0.88)) {
      $point = New-Object Win32WechatAutoReply+POINT
      $point.X = [int]($rect.Left + ($rect.Width * $xRatio))
      $point.Y = [int]($rect.Top + ($rect.Height * $yRatio))
      $pointWindow = [Win32WechatAutoReply]::WindowFromPoint($point)
      if ($pointWindow -eq [IntPtr]::Zero) { return $false }
      if ([Win32WechatAutoReply]::GetAncestor($pointWindow, 2) -ne $expectedHwnd) { return $false }
      $pointPid = [uint32]0
      [void][Win32WechatAutoReply]::GetWindowThreadProcessId($pointWindow, [ref]$pointPid)
      if ([int]$pointPid -ne $expectedPid) { return $false }
    }
  }
  return $true
}

function Capture-Viewport($rect, [IntPtr]$hWnd, [int]$expectedPid) {
  if ([Win32WechatAutoReply]::IsIconic($hWnd) -or [Win32WechatAutoReply]::GetForegroundWindow() -ne $hWnd) {
    return @{ ok = $false; reason = "history_window_not_foreground" }
  }
  if (-not (Test-ViewportOwned $rect $hWnd $expectedPid)) {
    return @{ ok = $false; reason = "history_window_obscured" }
  }
  $width = [int][Math]::Floor($rect.Width)
  $height = [int][Math]::Floor($rect.Height)
  if ($width -lt 240 -or $height -lt 160) { return @{ ok = $false; reason = "history_viewport_invalid" } }

  $bitmap = $null
  $graphics = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen(
      [int]$rect.Left,
      [int]$rect.Top,
      0,
      0,
      [System.Drawing.Size]::new($width, $height),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "history_screenshot_failed" }
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
    return @{ ok = $false; reason = "history_screenshot_failed" }
  } finally {
    $bitmap.Dispose()
  }
  return @{ ok = $true; width = $width; height = $height; stride = $stride; bytes = $bytes }
}

function Measure-AvatarBand($image, [int]$xStart, [int]$xEnd, [int]$yStart, [int]$yEnd) {
  $xStart = [Math]::Max(0, [Math]::Min($image.width, $xStart))
  $xEnd = [Math]::Max($xStart, [Math]::Min($image.width, $xEnd))
  $yStart = [Math]::Max(0, [Math]::Min($image.height, $yStart))
  $yEnd = [Math]::Max($yStart, [Math]::Min($image.height, $yEnd))
  $counts = @{}
  $total = 0
  for ($y = $yStart; $y -lt $yEnd; $y += 2) {
    for ($x = $xStart; $x -lt $xEnd; $x += 2) {
      $offset = ($y * $image.stride) + ($x * 4)
      $blue = [int]$image.bytes[$offset]
      $green = [int]$image.bytes[$offset + 1]
      $red = [int]$image.bytes[$offset + 2]
      $bucket = ((($red -shr 5) -shl 10) -bor (($green -shr 5) -shl 5) -bor ($blue -shr 5))
      if ($counts.ContainsKey($bucket)) { $counts[$bucket] += 1 } else { $counts[$bucket] = 1 }
      $total += 1
    }
  }
  if ($total -lt 100) { return 0.0 }
  $largestBucket = 0
  foreach ($count in $counts.Values) { if ([int]$count -gt $largestBucket) { $largestBucket = [int]$count } }
  return 1.0 - ([double]$largestBucket / [double]$total)
}

function Get-VisibleBubbles([System.Windows.Automation.AutomationElement]$root, $viewportRect) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $bubbleCandidates = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    try {
      if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { continue }
      if ([string]$element.Current.AutomationId -cne "chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view") { continue }
      if ($element.Current.IsOffscreen) { continue }
      $rect = $element.Current.BoundingRectangle
    } catch { continue }
    $text = Get-ElementText $element
    if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 500) { continue }
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    if ($rect.Top -lt ($viewportRect.Top - 1) -or $rect.Bottom -gt ($viewportRect.Bottom + 1)) { continue }
    [void]$bubbleCandidates.Add([pscustomobject]@{
      content = [string]$text
      key = Get-ElementKey $element $rect $text
      rect = $rect
      top = [double]$rect.Top
      bottom = [double]$rect.Bottom
    })
  }
  if ($bubbleCandidates.Count -gt 0) { return $bubbleCandidates.ToArray() | Sort-Object top, bottom }
  return @()
}

function Test-BubbleSequence($first, $second) {
  $left = @($first)
  $right = @($second)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index++) {
    if ($left[$index].key -cne $right[$index].key -or $left[$index].content -cne $right[$index].content) { return $false }
  }
  return $true
}

function Read-VisibleMessagePage([System.Windows.Automation.AutomationElement]$root, [System.Windows.Automation.AutomationElement]$chatList, $windowRect, [IntPtr]$hWnd, [int]$expectedPid, [double]$avatarVariationMinimum) {
  try { $viewportRect = $chatList.Current.BoundingRectangle } catch { return @{ ok = $false; reason = "history_viewport_missing" } }
  if ($viewportRect.Left -lt ($windowRect.Left - 2) -or $viewportRect.Top -lt ($windowRect.Top - 2) -or $viewportRect.Right -gt ($windowRect.Right + 2) -or $viewportRect.Bottom -gt ($windowRect.Bottom + 2)) {
    return @{ ok = $false; reason = "history_viewport_invalid" }
  }
  $before = @(Get-VisibleBubbles $root $viewportRect)
  if ($before.Count -eq 0) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  $capture = Capture-Viewport $viewportRect $hWnd $expectedPid
  if (-not $capture.ok) { return $capture }
  $after = @(Get-VisibleBubbles $root $viewportRect)
  if (-not (Test-BubbleSequence $before $after)) { return @{ ok = $false; reason = "history_changed_during_scan" } }

  $margin = [int][Math]::Max(2, [Math]::Round($capture.width * 0.012))
  $bandWidth = [int][Math]::Max(24, [Math]::Round($capture.width * 0.11))
  $bandWidth = [int][Math]::Min($bandWidth, [Math]::Floor($capture.width * 0.22))
  $leftStart = $margin
  $leftEnd = [Math]::Min([int]($capture.width / 2), $leftStart + $bandWidth)
  $rightEnd = $capture.width - $margin
  $rightStart = [Math]::Max([int]($capture.width / 2), $rightEnd - $bandWidth)
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($bubble in $before) {
    $rowTop = [int][Math]::Max(0, [Math]::Ceiling($bubble.rect.Top - $viewportRect.Top))
    $rowBottom = [int][Math]::Min($capture.height, [Math]::Floor($bubble.rect.Bottom - $viewportRect.Top))
    $sampleHeight = [int][Math]::Min($rowBottom - $rowTop, [Math]::Round($bandWidth * 1.1))
    if ($sampleHeight -lt 16) { return @{ ok = $false; reason = "history_avatar_ambiguous" } }
    $sampleBottom = $rowTop + $sampleHeight
    $leftScore = Measure-AvatarBand $capture $leftStart $leftEnd $rowTop $sampleBottom
    $rightScore = Measure-AvatarBand $capture $rightStart $rightEnd $rowTop $sampleBottom
    $leftAvatar = $leftScore -ge $avatarVariationMinimum
    $rightAvatar = $rightScore -ge $avatarVariationMinimum
    if ($leftAvatar -eq $rightAvatar) { return @{ ok = $false; reason = "history_avatar_ambiguous" } }
    [void]$items.Add([pscustomobject]@{
      role = $(if ($leftAvatar) { "user" } else { "assistant" })
      content = [string]$bubble.content
      key = [string]$bubble.key
    })
  }
  $keys = @($items | ForEach-Object { $_.key })
  if (@($keys | Select-Object -Unique).Count -ne $keys.Count) { return @{ ok = $false; reason = "history_overlap_ambiguous" } }
  return @{ ok = $true; items = @($items.ToArray()); viewportRect = $viewportRect }
}

function Test-ContextSequence($first, $second) {
  $left = @($first)
  $right = @($second)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index++) {
    if (
      $left[$index].key -cne $right[$index].key -or
      $left[$index].role -cne $right[$index].role -or
      $left[$index].content -cne $right[$index].content
    ) { return $false }
  }
  return $true
}

function Merge-HistoryPages($currentItems, $previousItems) {
  $current = @($currentItems)
  $previous = @($previousItems)
  if ($current.Count -eq 0) { return @{ ok = $false; reason = "history_empty" } }
  $currentKeys = @($current | ForEach-Object { $_.key })
  $previousKeys = @($previous | ForEach-Object { $_.key })
  if (
    @($currentKeys | Select-Object -Unique).Count -ne $currentKeys.Count -or
    @($previousKeys | Select-Object -Unique).Count -ne $previousKeys.Count
  ) { return @{ ok = $false; reason = "history_overlap_ambiguous" } }
  $overlapStarts = @()
  for ($index = 0; $index -lt $previous.Count; $index++) {
    if ($previous[$index].key -ceq $current[0].key) { $overlapStarts += $index }
  }
  if ($overlapStarts.Count -eq 0) { return @{ ok = $false; reason = "history_overlap_missing" } }
  if ($overlapStarts.Count -ne 1) { return @{ ok = $false; reason = "history_overlap_ambiguous" } }
  $overlapStart = [int]$overlapStarts[0]
  $overlapLength = $previous.Count - $overlapStart
  if ($overlapLength -gt $current.Count) { return @{ ok = $false; reason = "history_overlap_mismatch" } }
  for ($index = 0; $index -lt $overlapLength; $index++) {
    $older = $previous[$overlapStart + $index]
    $newer = $current[$index]
    if ($older.key -cne $newer.key -or $older.role -cne $newer.role -or $older.content -cne $newer.content) {
      return @{ ok = $false; reason = "history_overlap_mismatch" }
    }
  }
  $merged = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $overlapStart; $index++) { [void]$merged.Add($previous[$index]) }
  foreach ($item in $current) { [void]$merged.Add($item) }
  $mergedKeys = @($merged | ForEach-Object { $_.key })
  if (@($mergedKeys | Select-Object -Unique).Count -ne $mergedKeys.Count) { return @{ ok = $false; reason = "history_overlap_ambiguous" } }
  return @{ ok = $true; context = @($merged.ToArray() | Select-Object -Last 12) }
}

function Test-Unread([System.Windows.Automation.AutomationElement]$item) {
  $itemText = Get-ElementText $item
  if ($itemText -match "\\[[1-9][0-9]*条\\]" -or $itemText -match "unread|new message") { return $true }
  try {
    if ([string]$item.Current.ItemStatus -match "未读|新消息|unread|new message") { return $true }
  } catch {}
  try {
    if ([string]$item.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HelpTextProperty) -match "未读|新消息|unread|new message") { return $true }
  } catch {}
  try {
    $children = $item.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $children.Count; $index++) {
      $child = $children.Item($index)
      $text = Get-ElementText $child
      try { $childStatus = [string]$child.Current.ItemStatus } catch { $childStatus = "" }
      try { $helpText = [string]$child.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HelpTextProperty) } catch { $helpText = "" }
      if ($text -match "未读|新消息|unread|new message" -or $childStatus -match "未读|新消息|unread|new message" -or $helpText -match "未读|新消息|unread|new message") { return $true }
      if ($text -notmatch "^[1-9][0-9]{0,2}$") { continue }
      try { $rect = $child.Current.BoundingRectangle } catch { continue }
      if ($rect.Width -le 40 -and $rect.Height -le 30) { return $true }
    }
  } catch {}
  return $false
}

function Get-SessionPreview([System.Windows.Automation.AutomationElement]$item, [string]$name) {
  $itemText = Get-ElementText $item
  if ([string]::IsNullOrWhiteSpace($itemText)) { return "" }
  if ($itemText.StartsWith($name, [System.StringComparison]::Ordinal)) {
    $itemText = $itemText.Substring($name.Length).Trim()
  }
  $itemText = [regex]::Replace($itemText, "^\\s*\\[[1-9][0-9]*条\\]\\s*", "")
  $itemText = [regex]::Replace($itemText, "\\s+(?:[01]?\\d|2[0-3]):[0-5]\\d$", "")
  return $itemText.Trim()
}

function Find-UnreadSessionMatches($all, $allowedSet, $windowRect) {
  $windowWidth = $windowRect.Right - $windowRect.Left
  $leftLimit = $windowRect.Left + [Math]::Max(280, $windowWidth * 0.42)
  $matches = New-Object System.Collections.Generic.List[object]
  $seenNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    $name = ""
    $item = $null
    try { $automationId = [string]$element.Current.AutomationId } catch { $automationId = "" }
    if ($automationId.StartsWith("session_item_", [System.StringComparison]::Ordinal)) {
      $candidateName = $automationId.Substring("session_item_".Length)
      if ($allowedSet.Contains($candidateName)) {
        $name = $candidateName
        $item = $element
      }
    }
    if ($item -eq $null) {
      $candidateName = Get-ElementText $element
      if (-not $allowedSet.Contains([string]$candidateName)) { continue }
      try { $rect = $element.Current.BoundingRectangle } catch { continue }
      if ($rect.Left -ge $leftLimit -or $rect.Top -lt ($windowRect.Top + 55) -or $rect.Bottom -gt ($windowRect.Bottom - 35)) { continue }
      $name = [string]$candidateName
      $item = $element
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      for ($level = 0; $level -lt 7; $level++) {
        try { $itemRect = $item.Current.BoundingRectangle } catch { $item = $null; break }
        if ($itemRect.Width -ge 150 -and $itemRect.Height -ge 36 -and $itemRect.Height -le 120 -and $itemRect.Left -lt $leftLimit) { break }
        try { $item = $walker.GetParent($item) } catch { $item = $null }
        if ($item -eq $null) { break }
      }
    }
    if ($item -eq $null -or $seenNames.Contains($name) -or -not (Test-Unread $item)) { continue }
    try { $itemRect = $item.Current.BoundingRectangle } catch { continue }
    if ($itemRect.Left -ge $leftLimit -or $itemRect.Top -lt ($windowRect.Top + 55) -or $itemRect.Bottom -gt ($windowRect.Bottom - 35)) { continue }
    [void]$seenNames.Add($name)
    [void]$matches.Add([pscustomobject]@{ name = $name; item = $item; preview = Get-SessionPreview $item $name; top = [double]$itemRect.Top })
  }
  return $matches.ToArray()
}

function Find-CurrentEligibleConversation($all, $allowedSet, $windowRect) {
  $headerLeft = $windowRect.Left + [Math]::Max(240, $windowRect.Width * 0.22)
  $matches = New-Object System.Collections.Generic.List[string]
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    $text = Get-ElementText $element
    if ([string]::IsNullOrWhiteSpace($text) -or -not $allowedSet.Contains([string]$text)) { continue }
    try { $rect = $element.Current.BoundingRectangle } catch { continue }
    if ($rect.Left -ge $headerLeft -and $rect.Top -ge ($windowRect.Top + 25) -and $rect.Top -le ($windowRect.Top + 125)) {
      [void]$matches.Add($text)
    }
  }
  $unique = @($matches | Select-Object -Unique)
  if ($unique.Count -eq 1) { return [string]$unique[0] }
  return ""
}

function Get-CurrentBaseline($baselines, [string]$key) {
  if ($baselines -eq $null -or [string]::IsNullOrWhiteSpace($key)) { return "" }
  foreach ($property in $baselines.PSObject.Properties) {
    if ($property.Name -ceq $key) { return [string]$property.Value }
  }
  return ""
}

function Open-Session([System.Windows.Automation.AutomationElement]$item, [IntPtr]$hWnd) {
  [void][Win32WechatAutoReply]::ShowWindowAsync($hWnd, 9)
  [void][Win32WechatAutoReply]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 150
  try {
    $selection = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection) { $selection.Select(); Start-Sleep -Milliseconds 150 }
  } catch {}
  try {
    $invoke = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invoke) { $invoke.Invoke(); Start-Sleep -Milliseconds 150 }
  } catch {}
  try {
    $rect = $item.Current.BoundingRectangle
    $point = New-Object Win32WechatAutoReply+POINT
    [void][Win32WechatAutoReply]::GetCursorPos([ref]$point)
    [void][Win32WechatAutoReply]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
    [Win32WechatAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [Win32WechatAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 450
    [void][Win32WechatAutoReply]::SetCursorPos($point.X, $point.Y)
    return $true
  } catch { return $false }
}

$mode = [Environment]::GetEnvironmentVariable("XIAOXI_AUTO_REPLY_MODE")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedMessage = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE")
$expectedRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_RUNTIME_ID")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$candidateSource = $(if ($mode -eq "verify") { "verify" } else { "unread" })
$avatarVariationMinimum = 0.16
try {
  $configuredAvatarVariation = [double][Environment]::GetEnvironmentVariable("XIAOXI_AVATAR_VARIATION_MIN")
  if ($configuredAvatarVariation -ge 0.05 -and $configuredAvatarVariation -le 0.8) { $avatarVariationMinimum = $configuredAvatarVariation }
} catch {}
try { $allowed = @(([Environment]::GetEnvironmentVariable("XIAOXI_ALLOWED_NAMES") | ConvertFrom-Json)) } catch { Write-Result @{ ok = $false; reason = "whitelist_invalid" } }
if ($allowed.Count -eq 0) { Write-Result @{ ok = $false; reason = "whitelist_empty" } }
$allowedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($name in $allowed) {
  if (-not [string]::IsNullOrWhiteSpace([string]$name)) { [void]$allowedSet.Add(([string]$name).Trim()) }
}
if ($allowedSet.Count -eq 0) { Write-Result @{ ok = $false; reason = "whitelist_empty" } }
try { $currentBaselines = [Environment]::GetEnvironmentVariable("XIAOXI_CURRENT_BASELINES") | ConvertFrom-Json } catch { $currentBaselines = $null }

$processes = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "微信" })
if ($processes.Count -eq 0) { Write-Result @{ ok = $false; reason = "wechat_window_missing" } }
if ($processes.Count -ne 1) { Write-Result @{ ok = $false; reason = "wechat_window_ambiguous" } }
$process = $processes[0]
if ($mode -eq "verify") {
  if ($expectedPid -and [int]$expectedPid -ne $process.Id) { Write-Result @{ ok = $false; reason = "wechat_process_changed" } }
  if ($expectedHwnd -and [int64]$expectedHwnd -ne [int64]$process.MainWindowHandle) { Write-Result @{ ok = $false; reason = "wechat_window_changed" } }
}

$hWnd = [IntPtr]$process.MainWindowHandle
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
if ($root -eq $null) { Write-Result @{ ok = $false; reason = "automation_root_missing" } }
$windowRect = $root.Current.BoundingRectangle
if ($windowRect.Width -lt 400 -or $windowRect.Height -lt 300) { Write-Result @{ ok = $false; reason = "wechat_window_not_ready" } }
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

if ($mode -eq "prime") {
  $primeConversation = Find-CurrentEligibleConversation $all $allowedSet $windowRect
  if ([string]::IsNullOrWhiteSpace($primeConversation)) { Write-Result @{ ok = $false; reason = "no_current_conversation" } }
  $primeChatList = Get-ChatList $root
  if ($primeChatList -eq $null) { Write-Result @{ ok = $false; reason = "history_viewport_missing" } }
  try {
    $primeScroll = $primeChatList.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($primeScroll -and $primeScroll.Current.VerticallyScrollable -and [double]$primeScroll.Current.VerticalScrollPercent -lt 98.5) {
      Write-Result @{ ok = $false; reason = "history_not_at_bottom" }
    }
  } catch {}
  try { $primeViewportRect = $primeChatList.Current.BoundingRectangle } catch { Write-Result @{ ok = $false; reason = "history_viewport_missing" } }
  $primeBubblesBefore = @(Get-VisibleBubbles $root $primeViewportRect)
  $primeBubblesAfter = @(Get-VisibleBubbles $root $primeViewportRect)
  if (-not (Test-BubbleSequence $primeBubblesBefore $primeBubblesAfter)) { Write-Result @{ ok = $false; reason = "history_changed_during_scan" } }
  $primeAllAfter = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  if ((Find-CurrentEligibleConversation $primeAllAfter $allowedSet $windowRect) -cne $primeConversation) {
    Write-Result @{ ok = $false; reason = "conversation_title_changed" }
  }
  $primeLatest = $primeBubblesAfter | Select-Object -Last 1
  $primeRuntimeId = $(if ($primeLatest -eq $null) { "__empty_conversation__" } else { [string]$primeLatest.key })
  Write-Result @{ ok = $true; source = "current_probe"; conversation = $primeConversation; runtimeId = $primeRuntimeId; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
}

if ($mode -eq "scan") {
  $matches = @(Find-UnreadSessionMatches $all $allowedSet $windowRect)
  $match = $matches | Sort-Object top | Select-Object -First 1
  if ($match -eq $null) {
    $expectedConversation = Find-CurrentEligibleConversation $all $allowedSet $windowRect
    if ([string]::IsNullOrWhiteSpace($expectedConversation)) { Write-Result @{ ok = $false; reason = "no_unread_message" } }
    $expectedMessage = ""
    $candidateSource = "current_open"

    $probeChatList = Get-ChatList $root
    if ($probeChatList -eq $null) { Write-Result @{ ok = $false; reason = "history_viewport_missing" } }
    try { $probeViewportRect = $probeChatList.Current.BoundingRectangle } catch { Write-Result @{ ok = $false; reason = "history_viewport_missing" } }
    $probeBubbles = @(Get-VisibleBubbles $root $probeViewportRect)
    $probeLatest = $probeBubbles | Select-Object -Last 1
    if ($probeLatest -eq $null) { Write-Result @{ ok = $false; reason = "latest_text_message_missing" } }
    $sessionKey = "{0}:{1}:{2}" -f $process.Id, [int64]$process.MainWindowHandle, $expectedConversation
    $currentBaseline = Get-CurrentBaseline $currentBaselines $sessionKey
    if ([string]::IsNullOrWhiteSpace($currentBaseline)) {
      Write-Result @{ ok = $true; source = "current_probe"; conversation = $expectedConversation; runtimeId = [string]$probeLatest.key; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
    }
    if ($currentBaseline -ceq [string]$probeLatest.key) { Write-Result @{ ok = $false; reason = "no_unread_message" } }
  } else {
    if ([string]::IsNullOrWhiteSpace([string]$match.preview)) { Write-Result @{ ok = $false; reason = "unread_preview_missing" } }
    if (-not (Open-Session $match.item $hWnd)) { Write-Result @{ ok = $false; reason = "conversation_open_failed" } }
    $expectedConversation = $match.name
    $expectedMessage = [string]$match.preview
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  }
}

$titleFound = $false
$headerLeft = $windowRect.Left + [Math]::Max(240, $windowRect.Width * 0.22)
for ($index = 0; $index -lt $all.Count; $index++) {
  $element = $all.Item($index)
  if ((Get-ElementText $element) -cne $expectedConversation) { continue }
  try { $rect = $element.Current.BoundingRectangle } catch { continue }
  if ($rect.Left -ge $headerLeft -and $rect.Top -ge ($windowRect.Top + 25) -and $rect.Top -le ($windowRect.Top + 125)) { $titleFound = $true; break }
}
if (-not $titleFound) { Write-Result @{ ok = $false; reason = "conversation_title_mismatch" } }

[void][Win32WechatAutoReply]::ShowWindowAsync($hWnd, 9)
[void][Win32WechatAutoReply]::SetForegroundWindow($hWnd)
Start-Sleep -Milliseconds 180
if ([Win32WechatAutoReply]::GetForegroundWindow() -ne $hWnd) { Write-Result @{ ok = $false; reason = "history_window_not_foreground" } }
$chatList = Get-ChatList $root
if ($chatList -eq $null) { Write-Result @{ ok = $false; reason = "history_viewport_missing" } }
$scrollPattern = $null
$beforePercent = 100.0
if ($mode -eq "scan") {
  try { $scrollPattern = $chatList.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern) } catch {}
  if ($scrollPattern -and $scrollPattern.Current.VerticallyScrollable) {
    $beforePercent = [double]$scrollPattern.Current.VerticalScrollPercent
    if ($beforePercent -lt 98.5) { Write-Result @{ ok = $false; reason = "history_not_at_bottom" } }
  }
}
$currentPage = Read-VisibleMessagePage $root $chatList $windowRect $hWnd $process.Id $avatarVariationMinimum
if (-not $currentPage.ok) { Write-Result @{ ok = $false; reason = [string]$currentPage.reason } }
$currentItems = @($currentPage.items)
$context = @($currentItems | Select-Object -Last 12)

if ($mode -eq "scan" -and $currentItems.Count -lt 12 -and $scrollPattern) {
  if ($scrollPattern -and $scrollPattern.Current.VerticallyScrollable) {
    $viewSize = [double]$scrollPattern.Current.VerticalViewSize
    $targetPercent = [Math]::Max(0.0, $beforePercent - [Math]::Max(1.0, $viewSize * 0.6))
    if (($beforePercent - $targetPercent) -gt 0.5) {
      $previousPage = $null
      $scrollFailure = ""
      try {
        $scrollPattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $targetPercent)
        Start-Sleep -Milliseconds 280
        $afterPercent = [double]$scrollPattern.Current.VerticalScrollPercent
        if ([Math]::Abs($afterPercent - $beforePercent) -lt 0.5) {
          $scrollFailure = "history_scroll_failed"
        } else {
          $previousPage = Read-VisibleMessagePage $root $chatList $windowRect $hWnd $process.Id $avatarVariationMinimum
        }
      } catch {
        $scrollFailure = "history_scroll_failed"
      }

      $restoreOk = $true
      $restoredPage = $null
      try {
        $scrollPattern.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $beforePercent)
        Start-Sleep -Milliseconds 280
        $restoredPercent = [double]$scrollPattern.Current.VerticalScrollPercent
        if ([Math]::Abs($restoredPercent - $beforePercent) -gt 1.0) {
          $restoreOk = $false
        } else {
          $restoredPage = Read-VisibleMessagePage $root $chatList $windowRect $hWnd $process.Id $avatarVariationMinimum
          if (-not $restoredPage.ok -or -not (Test-ContextSequence $currentItems $restoredPage.items)) { $restoreOk = $false }
        }
      } catch {
        $restoreOk = $false
      }
      if (-not $restoreOk) { Write-Result @{ ok = $false; reason = "history_restore_failed" } }
      if ($scrollFailure) { Write-Result @{ ok = $false; reason = $scrollFailure } }
      if ($previousPage -eq $null -or -not $previousPage.ok) {
        Write-Result @{ ok = $false; reason = $(if ($previousPage -and $previousPage.reason) { [string]$previousPage.reason } else { "history_scroll_failed" }) }
      }
      $merged = Merge-HistoryPages $currentItems $previousPage.items
      if (-not $merged.ok) { Write-Result @{ ok = $false; reason = [string]$merged.reason } }
      $context = @($merged.context)
    }
  }
}

$latest = $currentItems | Select-Object -Last 1
if ($latest -eq $null) { Write-Result @{ ok = $false; reason = "latest_text_message_missing" } }
if ($candidateSource -ne "current_open" -and $latest.role -cne "user") { Write-Result @{ ok = $false; reason = "latest_message_not_incoming" } }
if ($candidateSource -eq "unread" -and $latest.content -cne $expectedMessage) {
  Write-Result @{ ok = $false; reason = "unread_preview_mismatch" }
}
if ($mode -eq "verify" -and ($latest.content -cne $expectedMessage -or $latest.key -cne $expectedRuntimeId)) {
  Write-Result @{ ok = $false; reason = "incoming_message_changed" }
}

Write-Result @{
  ok = $true
  conversation = [string]$expectedConversation
  message = [string]$latest.content
  runtimeId = [string]$latest.key
  pid = [int]$process.Id
  hWnd = [int64]$process.MainWindowHandle
  source = [string]$candidateSource
  latestRole = [string]$latest.role
  context = @($context)
}
`;

function compressedPowerShell(script) {
  const payload = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  return `
$compressed = [Convert]::FromBase64String("${payload}")
$memory = [System.IO.MemoryStream]::new($compressed)
$gzip = [System.IO.Compression.GZipStream]::new($memory, [System.IO.Compression.CompressionMode]::Decompress)
$reader = [System.IO.StreamReader]::new($gzip, [System.Text.Encoding]::UTF8)
try { $source = $reader.ReadToEnd() } finally { $reader.Dispose() }
Invoke-Expression $source
`;
}

const AUTO_REPLY_RUN_SCRIPT = compressedPowerShell(AUTO_REPLY_SCAN_SCRIPT);

function createWechatAutoReplyDriver(powerShellRunner = runPowerShellAsync) {
  const currentSessionBaselines = new Map();
  const retryCandidates = [];
  let baselineEpoch = 0;
  let retryAfterFresh = false;

  function allowedNames(names) {
    return [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || "").trim()).filter(Boolean))];
  }

  function takeRetryCandidate(allowed, scanProbe = { ok: null, reason: "retry_candidate_without_probe" }) {
    while (retryCandidates.length) {
      const candidate = retryCandidates.shift();
      if (allowed.includes(String(candidate.conversation || "").trim())) return { ...candidate, scanProbe };
    }
    return null;
  }

  async function primeWechatSession(names) {
    const allowed = allowedNames(names);
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    const activeBaselineEpoch = baselineEpoch;
    const result = await Promise.resolve(powerShellRunner(AUTO_REPLY_RUN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "prime",
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed)
    }, { ensure: false }));
    if (activeBaselineEpoch !== baselineEpoch) return { ok: false, reason: "baseline_epoch_changed" };
    if (result?.ok !== true) return result;
    const conversation = String(result.conversation || "").trim();
    const runtimeId = String(result.runtimeId || "").trim();
    if (!conversation || !runtimeId) return { ok: false, reason: "incoming_identity_missing" };
    currentSessionBaselines.set(`${result.pid || ""}:${result.hWnd || ""}:${conversation}`, runtimeId);
    return { ok: true, primed: true };
  }

  async function scanWechatIncoming(names) {
    const allowed = allowedNames(names);
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    if (retryAfterFresh) {
      retryAfterFresh = false;
      const retry = takeRetryCandidate(allowed);
      if (retry) return retry;
    }
    const activeBaselineEpoch = baselineEpoch;
    const result = await Promise.resolve(powerShellRunner(AUTO_REPLY_RUN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "scan",
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
      XIAOXI_CURRENT_BASELINES: JSON.stringify(Object.fromEntries(currentSessionBaselines))
    }, { ensure: false }));
    if (activeBaselineEpoch !== baselineEpoch) return { ok: false, reason: "baseline_epoch_changed" };
    if (result?.ok !== true) {
      return takeRetryCandidate(allowed, { ok: false, reason: result?.reason || "scan_result_invalid" }) || result;
    }
    const conversation = String(result.conversation || "").trim();
    const runtimeId = String(result.runtimeId || "").trim();
    const sessionKey = `${result.pid || ""}:${result.hWnd || ""}:${conversation}`;
    if (!conversation || !runtimeId) return { ok: false, reason: "incoming_identity_missing" };
    const previous = currentSessionBaselines.get(sessionKey);
    currentSessionBaselines.set(sessionKey, runtimeId);
    if (currentSessionBaselines.size > 1_000) currentSessionBaselines.delete(currentSessionBaselines.keys().next().value);
    if (result.source === "current_probe") return takeRetryCandidate(allowed, { ok: true, reason: "current_session_baselined" }) || { ok: false, reason: "current_session_baselined" };
    if (result.source !== "current_open") {
      if (retryCandidates.length) retryAfterFresh = true;
      return result;
    }
    if (!previous) return takeRetryCandidate(allowed, { ok: true, reason: "current_session_baselined" }) || { ok: false, reason: "current_session_baselined" };
    if (previous === runtimeId) return takeRetryCandidate(allowed, { ok: true, reason: "no_unread_message" }) || { ok: false, reason: "no_unread_message" };
    if (result.latestRole !== "user") return takeRetryCandidate(allowed, { ok: true, reason: "latest_message_not_incoming" }) || { ok: false, reason: "latest_message_not_incoming" };
    if (retryCandidates.length) retryAfterFresh = true;
    return result;
  }

  async function verifyWechatIncoming(candidate = {}) {
    const conversation = String(candidate.conversation || "").trim();
    const message = String(candidate.message || "").trim();
    const runtimeId = String(candidate.runtimeId || "").trim();
    if (!conversation || !message) return { ok: false, reason: "incoming_message_missing" };
    if (!runtimeId) return { ok: false, reason: "incoming_identity_missing" };
    return Promise.resolve(powerShellRunner(AUTO_REPLY_RUN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "verify",
      XIAOXI_ALLOWED_NAMES: JSON.stringify([conversation]),
      XIAOXI_EXPECTED_CONVERSATION: conversation,
      XIAOXI_EXPECTED_MESSAGE: message,
      XIAOXI_EXPECTED_RUNTIME_ID: runtimeId,
      XIAOXI_EXPECTED_PID: String(candidate.pid || ""),
      XIAOXI_EXPECTED_HWND: String(candidate.hWnd || "")
    }, { ensure: false }));
  }

  scanWechatIncoming.primeBaselines = primeWechatSession;
  scanWechatIncoming.requeue = (candidate) => {
    if (candidate?.ok !== true) return false;
    const { scanProbe: _discardedProbe, ...retryCandidate } = candidate;
    const key = [retryCandidate.conversation, retryCandidate.runtimeId, retryCandidate.message].map(String).join("\n");
    if (retryCandidates.some((item) => [item.conversation, item.runtimeId, item.message].map(String).join("\n") === key)) return true;
    if (retryCandidates.length >= 1_000) return false;
    retryCandidates.push(retryCandidate);
    return true;
  };
  scanWechatIncoming.resetBaselines = () => {
    baselineEpoch += 1;
    currentSessionBaselines.clear();
  };
  return { primeWechatSession, scanWechatIncoming, verifyWechatIncoming };
}

const driver = createWechatAutoReplyDriver();

module.exports = {
  AUTO_REPLY_SCAN_SCRIPT,
  classifyAvatarSide,
  createWechatAutoReplyDriver,
  mergeContextPages,
  ...driver
};
