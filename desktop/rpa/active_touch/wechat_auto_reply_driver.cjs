const { normalizeWechatMainWindowAsync, runPowerShellAsync } = require("./wechat_window_driver.cjs");
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
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
}
"@
try { [void][Win32WechatAutoReply]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}

$script:sessionBaselines = $null
$script:pendingSessionConversation = ""
$script:sessionProbeDiagnostics = $null
$script:windowIdentity = $null
$script:windowDpi = $null
function Write-Result($value) {
  if ($value -is [System.Collections.IDictionary] -and $null -ne $script:sessionBaselines) {
    $value["sessionBaselines"] = @($script:sessionBaselines)
  }
  if ($value -is [System.Collections.IDictionary] -and -not [string]::IsNullOrWhiteSpace($script:pendingSessionConversation)) {
    $value["sessionBaselinePending"] = [string]$script:pendingSessionConversation
  }
  if ($value -is [System.Collections.IDictionary] -and $null -ne $script:sessionProbeDiagnostics) {
    $value["sessionProbe"] = $script:sessionProbeDiagnostics
  }
  if ($value -is [System.Collections.IDictionary] -and $null -ne $script:windowIdentity) {
    $value["window"] = $script:windowIdentity
  }
  if ($value -is [System.Collections.IDictionary] -and $null -ne $script:windowDpi) {
    $value["dpi"] = $script:windowDpi
  }
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

function Test-UnreadBadgeGeometry($rect, $itemRect) {
  if ($rect -eq $null -or $itemRect -eq $null -or $itemRect.Height -le 0 -or $itemRect.Width -le 0) { return $false }
  $badgeWidth = [Math]::Max(30.0, $itemRect.Height * 0.75)
  $badgeHeight = [Math]::Max(24.0, $itemRect.Height * 0.58)
  $badgeRight = $itemRect.Left + ($itemRect.Width * 0.48)
  $badgeBottom = $itemRect.Top + ($itemRect.Height * 0.50)
  return (
    $rect.Width -le $badgeWidth -and
    $rect.Height -le $badgeHeight -and
    $rect.Left -ge $itemRect.Left -and
    $rect.Left -lt $badgeRight -and
    $rect.Top -ge $itemRect.Top -and
    $rect.Bottom -le $badgeBottom
  )
}

function Test-UnreadName([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  return $text.Trim() -match "^(?:未读|新消息|unread|new message|\\[[1-9][0-9]*条\\])$"
}

function Test-AggregateSessionUnread([string]$text, [string]$name) {
  if ([string]::IsNullOrWhiteSpace($text) -or [string]::IsNullOrWhiteSpace($name)) { return $false }
  $normalized = [regex]::Replace($text.Normalize([Text.NormalizationForm]::FormKC).Trim(), "\\s+", " ")
  if (-not $normalized.StartsWith($name, [System.StringComparison]::Ordinal)) { return $false }
  $remainder = $normalized.Substring($name.Length)
  if ($remainder.Length -eq 0 -or (-not [char]::IsWhiteSpace($remainder[0]) -and $remainder[0] -ne "[")) { return $false }
  return $remainder.TrimStart() -match "^\\[[1-9][0-9]*条\\](?:\\s|$)"
}

function Test-Unread([System.Windows.Automation.AutomationElement]$item) {
  try { $itemRect = $item.Current.BoundingRectangle } catch { $itemRect = $null }
  $itemText = Get-ElementText $item
  if (Test-UnreadName $itemText) { return $true }
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
      if ((Test-UnreadName $text) -or $childStatus -match "未读|新消息|unread|new message" -or $helpText -match "未读|新消息|unread|new message") { return $true }
      if ($text -notmatch "^[1-9][0-9]{0,2}$") { continue }
      try { $rect = $child.Current.BoundingRectangle } catch { continue }
      if (Test-UnreadBadgeGeometry $rect $itemRect) { return $true }
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

function Test-SessionMetaElement([System.Windows.Automation.AutomationElement]$element, $itemRect) {
  if ($itemRect -eq $null) { return $false }
  try {
    $rect = $element.Current.BoundingRectangle
    $text = Get-ElementText $element
  } catch { return $false }
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  return (
    $rect.Left -ge ($itemRect.Left + ($itemRect.Width * 0.55)) -and
    $rect.Top -le ($itemRect.Top + ($itemRect.Height * 0.58)) -and
    $rect.Width -le ($itemRect.Width * 0.45) -and
    $text.Length -le 32
  )
}

function Get-SessionTextSignature([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return "" }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") })
  } finally { $sha.Dispose() }
}

function Normalize-SessionAggregatePreview([string]$text, [string]$name) {
  if ([string]::IsNullOrWhiteSpace($text) -or [string]::IsNullOrWhiteSpace($name)) { return "" }
  $text = [regex]::Replace($text.Normalize([Text.NormalizationForm]::FormKC).Trim(), "\\s+", " ")
  if (-not $text.StartsWith($name, [System.StringComparison]::Ordinal)) { return "" }
  $remainder = $text.Substring($name.Length)
  if ($remainder.Length -gt 0 -and -not [char]::IsWhiteSpace($remainder[0]) -and $remainder[0] -ne "[") { return "" }
  $text = $remainder.Trim()
  $text = [regex]::Replace($text, "^\\s*(?:\\[[1-9][0-9]*条\\]|[1-9][0-9]*条(?:未读|新)消息)\\s*", "")
  $text = [regex]::Replace($text, "(?:^|\\s)(?:刚刚|(?:[01]?[0-9]|2[0-3]):[0-5][0-9]|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])\\s*$", "")
  if ($text -match "(?:^|\\s)(?:刚刚|(?:[01]?[0-9]|2[0-3]):[0-5][0-9]|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])(?:\\s|$)") { return "" }
  if (
    [string]::IsNullOrWhiteSpace($text) -or
    $text -ceq $name -or
    $text -match "^(?:未读|新消息|unread|new message)$"
  ) { return "" }
  return $text.Trim()
}

function Get-SessionAggregatePreview([System.Windows.Automation.AutomationElement]$item, [string]$name) {
  return Normalize-SessionAggregatePreview (Get-ElementText $item) $name
}

function Get-SessionPreviewSignature([System.Windows.Automation.AutomationElement]$item, [string]$name) {
  $parts = New-Object System.Collections.Generic.List[string]
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $elements = New-Object System.Collections.Generic.List[object]
  try { $itemRect = $item.Current.BoundingRectangle } catch { return "" }
  try {
    $children = $item.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $children.Count; $index++) { [void]$elements.Add($children.Item($index)) }
  } catch {}
  if ($elements.Count -eq 0) {
    return Get-SessionTextSignature (Get-SessionAggregatePreview $item $name)
  }
  foreach ($element in $elements) {
    if (Test-SessionMetaElement $element $itemRect) { continue }
    $text = Get-ElementText $element
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $text = [regex]::Replace($text.Trim(), "\\s+", " ")
    if ($text.StartsWith($name, [System.StringComparison]::Ordinal)) { $text = $text.Substring($name.Length).Trim() }
    $text = [regex]::Replace($text, "^\\s*\\[[1-9][0-9]*条\\]\\s*", "")
    if (
      [string]::IsNullOrWhiteSpace($text) -or
      $text -ceq $name -or
      $text -match "^(?:昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|未读|新消息|unread|new message)$"
    ) { continue }
    if ($seen.Add($text)) { [void]$parts.Add($text) }
  }
  if ($parts.Count -eq 0) {
    return Get-SessionTextSignature (Get-SessionAggregatePreview $item $name)
  }
  return Get-SessionTextSignature ($parts -join [Environment]::NewLine)
}

function Get-SessionDisplayTime([System.Windows.Automation.AutomationElement]$item) {
  $elements = New-Object System.Collections.Generic.List[object]
  try { $itemRect = $item.Current.BoundingRectangle } catch { return "" }
  try {
    $children = $item.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $children.Count; $index++) { [void]$elements.Add($children.Item($index)) }
  } catch {}
  foreach ($element in $elements) {
    if (-not (Test-SessionMetaElement $element $itemRect)) { continue }
    $text = Get-ElementText $element
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    if ($text.Trim() -ceq "刚刚") { return "now" }
    if ($text.Trim() -match "^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$") { return $text.Trim() }
  }
  return ""
}

function Test-SessionSincePrime([string]$displayTime, [long]$primedAtMs) {
  if ($primedAtMs -le 0 -or [string]::IsNullOrWhiteSpace($displayTime)) { return $false }
  if ($displayTime -ceq "now") { return $false }
  if ($displayTime -notmatch "^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$") { return $false }
  try {
    $parts = $displayTime.Split(":")
    $displayed = [DateTime]::Today.AddHours([int]$parts[0]).AddMinutes([int]$parts[1])
    $primed = [DateTimeOffset]::FromUnixTimeMilliseconds($primedAtMs).LocalDateTime
    $nowLocal = [DateTime]::Now
    return $displayed -gt $primed.Date.AddHours($primed.Hour).AddMinutes($primed.Minute) -and $displayed -le $nowLocal.AddMinutes(1)
  } catch { return $false }
}

function Resolve-UniqueAggregateSessionName([string]$text, $allowedSet) {
  if ([string]::IsNullOrWhiteSpace($text)) { return "" }
  $normalized = [regex]::Replace($text.Normalize([Text.NormalizationForm]::FormKC).Trim(), "\\s+", " ")
  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($allowedName in $allowedSet) {
    $candidate = [string]$allowedName
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not $normalized.StartsWith($candidate, [System.StringComparison]::Ordinal)) { continue }
    $remainder = $normalized.Substring($candidate.Length)
    if ($remainder.Length -gt 0 -and -not [char]::IsWhiteSpace($remainder[0]) -and $remainder[0] -ne "[") { continue }
    [void]$matches.Add($candidate)
  }
  if ($matches.Count -eq 1) { return [string]$matches[0] }
  return ""
}

function Test-AggregateSessionListItem([System.Windows.Automation.AutomationElement]$item, $listRect) {
  try {
    if ($item.Current.IsOffscreen) { return $false }
    $isListItem = $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem
    $itemRect = $item.Current.BoundingRectangle
  } catch { return $false }
  $supportsSelection = $false
  try {
    $selection = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $supportsSelection = $null -ne $selection
  } catch {}
  if (-not $isListItem -and -not $supportsSelection) { return $false }
  if (
    $itemRect.Left -lt $listRect.Left -or $itemRect.Top -lt $listRect.Top -or
    $itemRect.Right -gt $listRect.Right -or $itemRect.Bottom -gt $listRect.Bottom
  ) { return $false }
  try {
    $descendants = $item.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    if ($descendants.Count -gt 0) { return $false }
  } catch { return $false }
  return $true
}

function Find-EligibleSessionRows($all, $allowedSet, $windowRect) {
  $windowWidth = $windowRect.Right - $windowRect.Left
  $windowHeight = $windowRect.Bottom - $windowRect.Top
  $leftLimit = $windowRect.Left + [Math]::Max(280, $windowWidth * 0.42)
  $topLimit = $windowRect.Top + [Math]::Max(35, $windowHeight * 0.04)
  $bottomLimit = $windowRect.Bottom - [Math]::Max(20, $windowHeight * 0.03)
  $minimumRowWidth = [Math]::Min(240.0, [Math]::Max(120.0, $windowWidth * 0.10))
  $minimumRowHeight = [Math]::Max(24, $windowHeight * 0.025)
  $maximumRowHeight = [Math]::Max(120, $windowHeight * 0.20)
  $rows = New-Object System.Collections.Generic.List[object]
  $seenNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $schemaObserved = $false
  $automationIdSessionItems = 0
  $automationIdAllowedMatches = 0
  $allowedTextMatches = 0
  $parentCandidates = 0
  $emptySignatures = 0
  $listContainerCount = 0
  $listRowCount = 0
  $rejectedRowLeftBoundary = 0
  $rejectedRowTooNarrow = 0
  $rejectedRowVertical = 0
  $rejectedRowHeight = 0
  $sessionLists = New-Object System.Collections.Generic.List[object]
  $exactElementIndices = New-Object System.Collections.Generic.List[int]
  $exactElementIndexSet = [System.Collections.Generic.HashSet[int]]::new()
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    try { $automationId = [string]$element.Current.AutomationId } catch { $automationId = "" }
    if ($automationId.StartsWith("session_item_", [System.StringComparison]::Ordinal)) {
      $automationIdSessionItems += 1
      $schemaObserved = $true
      $candidateName = $automationId.Substring("session_item_".Length)
      if ($allowedSet.Contains($candidateName)) {
        $automationIdAllowedMatches += 1
        [void]$exactElementIndices.Add($index)
        [void]$exactElementIndexSet.Add($index)
      }
    }
    try {
      if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::List) { continue }
      if ((Get-ElementText $element) -cne "会话") { continue }
      if ($element.Current.IsOffscreen) { continue }
      $listRect = $element.Current.BoundingRectangle
      if (
        $listRect.Left -lt $windowRect.Left -or $listRect.Top -lt $windowRect.Top -or
        $listRect.Right -gt $leftLimit -or $listRect.Bottom -gt $windowRect.Bottom -or
        $listRect.Width -lt $minimumRowWidth -or $listRect.Height -lt $minimumRowHeight
      ) { continue }
      $listContainerCount += 1
      [void]$sessionLists.Add($element)
      $listChildren = $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      $listRowCount += [int]$listChildren.Count
    } catch {}
  }
  $aggregateList = $null
  if ($sessionLists.Count -eq 1) {
    $aggregateList = $sessionLists[0]
    $schemaObserved = $true
  }
  $orderedElementIndices = New-Object System.Collections.Generic.List[int]
  foreach ($index in $exactElementIndices) { [void]$orderedElementIndices.Add($index) }
  for ($index = 0; $index -lt $all.Count; $index++) {
    if (-not $exactElementIndexSet.Contains($index)) { [void]$orderedElementIndices.Add($index) }
  }
  foreach ($index in $orderedElementIndices) {
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
      if ($allowedSet.Contains([string]$candidateName)) {
        $allowedTextMatches += 1
        try { $rect = $element.Current.BoundingRectangle } catch { continue }
        if ($rect.Left -ge $leftLimit) { $rejectedRowLeftBoundary += 1; continue }
        if ($rect.Top -lt $topLimit -or $rect.Bottom -gt $bottomLimit) { $rejectedRowVertical += 1; continue }
        $name = [string]$candidateName
        $item = $element
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        for ($level = 0; $level -lt 10; $level++) {
          try { $itemRect = $item.Current.BoundingRectangle } catch { $item = $null; break }
          if ($itemRect.Width -ge $minimumRowWidth -and $itemRect.Height -ge $minimumRowHeight -and $itemRect.Height -le $maximumRowHeight -and $itemRect.Left -lt $leftLimit) { break }
          try { $item = $walker.GetParent($item) } catch { $item = $null }
          if ($item -eq $null) { break }
        }
      } else { continue }
    }
    if ($item -eq $null -or $seenNames.Contains($name)) { continue }
    $parentCandidates += 1
    try { $itemRect = $item.Current.BoundingRectangle } catch { continue }
    $rowRejected = $false
    if ($itemRect.Left -ge $leftLimit -or $itemRect.Right -gt $leftLimit) { $rejectedRowLeftBoundary += 1; $rowRejected = $true }
    if ($itemRect.Width -lt $minimumRowWidth) { $rejectedRowTooNarrow += 1; $rowRejected = $true }
    if ($itemRect.Top -lt $topLimit -or $itemRect.Bottom -gt $bottomLimit) { $rejectedRowVertical += 1; $rowRejected = $true }
    if ($itemRect.Height -lt $minimumRowHeight -or $itemRect.Height -gt $maximumRowHeight) { $rejectedRowHeight += 1; $rowRejected = $true }
    if ($rowRejected) { continue }
    $schemaObserved = $true
    [void]$seenNames.Add($name)
    $signature = Get-SessionPreviewSignature $item $name
    if ([string]::IsNullOrWhiteSpace([string]$signature)) { $emptySignatures += 1 }
    $unread = Test-Unread $item
    [void]$rows.Add([pscustomobject]@{
      name = $name
      item = $item
      unread = [bool]$unread
      preview = Get-SessionPreview $item $name
      signature = $signature
      displayTime = Get-SessionDisplayTime $item
      top = [double]$itemRect.Top
    })
  }
  if ($aggregateList -ne $null) {
    try {
      $aggregateListRect = $aggregateList.Current.BoundingRectangle
      $aggregateChildren = $aggregateList.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    } catch {
      $aggregateChildren = $null
    }
    if ($aggregateChildren -ne $null) {
      for ($childIndex = 0; $childIndex -lt $aggregateChildren.Count; $childIndex++) {
        $item = $aggregateChildren.Item($childIndex)
        if (-not (Test-AggregateSessionListItem $item $aggregateListRect)) { continue }
        $itemText = Get-ElementText $item
        $name = Resolve-UniqueAggregateSessionName $itemText $allowedSet
        if ([string]::IsNullOrWhiteSpace($name) -or $seenNames.Contains($name)) { continue }
        if (-not (Test-AggregateSessionUnread $itemText $name)) { continue }
        try { $itemRect = $item.Current.BoundingRectangle } catch { continue }
        $rowRejected = $false
        if ($itemRect.Left -ge $leftLimit -or $itemRect.Right -gt $leftLimit) { $rejectedRowLeftBoundary += 1; $rowRejected = $true }
        if ($itemRect.Width -lt $minimumRowWidth) { $rejectedRowTooNarrow += 1; $rowRejected = $true }
        if ($itemRect.Top -lt $topLimit -or $itemRect.Bottom -gt $bottomLimit) { $rejectedRowVertical += 1; $rowRejected = $true }
        if ($itemRect.Height -lt $minimumRowHeight -or $itemRect.Height -gt $maximumRowHeight) { $rejectedRowHeight += 1; $rowRejected = $true }
        if ($rowRejected) { continue }
        $allowedTextMatches += 1
        $parentCandidates += 1
        [void]$seenNames.Add($name)
        $signature = Get-SessionPreviewSignature $item $name
        if ([string]::IsNullOrWhiteSpace([string]$signature)) { $emptySignatures += 1 }
        [void]$rows.Add([pscustomobject]@{
          name = $name
          item = $item
          unread = $true
          preview = Get-SessionPreview $item $name
          signature = $signature
          displayTime = Get-SessionDisplayTime $item
          top = [double]$itemRect.Top
        })
      }
    }
  }
  $signatureCount = @($rows.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.signature) }).Count
  return @{
    rows = @($rows.ToArray())
    schemaObserved = $schemaObserved
    diagnostics = [ordered]@{
      v = 1
      failure = ""
      schemaObserved = [bool]$schemaObserved
      elementCount = [int]$all.Count
      automationIdSessionItems = [int]$automationIdSessionItems
      automationIdAllowedMatches = [int]$automationIdAllowedMatches
      allowedTextMatches = [int]$allowedTextMatches
      parentCandidates = [int]$parentCandidates
      listContainerCount = [int]$listContainerCount
      listRowCount = [int]$listRowCount
      rejectedRowLeftBoundary = [int]$rejectedRowLeftBoundary
      rejectedRowTooNarrow = [int]$rejectedRowTooNarrow
      rejectedRowVertical = [int]$rejectedRowVertical
      rejectedRowHeight = [int]$rejectedRowHeight
      eligibleRowCount = [int]$rows.Count
      signatureCount = [int]$signatureCount
      emptySignatureCount = [int]$emptySignatures
      windowWidth = [int][Math]::Round($windowWidth)
      windowHeight = [int][Math]::Round($windowHeight)
      leftLimitOffset = [int][Math]::Round($leftLimit - $windowRect.Left)
      minimumRowWidth = [int][Math]::Round($minimumRowWidth)
      minimumRowHeight = [int][Math]::Round($minimumRowHeight)
      maximumRowHeight = [int][Math]::Round($maximumRowHeight)
    }
  }
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
try { $sessionPreviewBaselines = [Environment]::GetEnvironmentVariable("XIAOXI_SESSION_BASELINES") | ConvertFrom-Json } catch { $sessionPreviewBaselines = $null }
$sessionPreviewPrimed = [Environment]::GetEnvironmentVariable("XIAOXI_SESSION_PRIMED") -ceq "true"
try { $sessionPrimedAtMs = [long][Environment]::GetEnvironmentVariable("XIAOXI_SESSION_PRIMED_AT") } catch { $sessionPrimedAtMs = 0 }
try { $sessionExpectedPid = [int][Environment]::GetEnvironmentVariable("XIAOXI_SESSION_EXPECTED_PID") } catch { $sessionExpectedPid = 0 }
try { $sessionExpectedHwnd = [int64][Environment]::GetEnvironmentVariable("XIAOXI_SESSION_EXPECTED_HWND") } catch { $sessionExpectedHwnd = 0 }

$processes = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "微信" })
if ($processes.Count -eq 0) { Write-Result @{ ok = $false; reason = "wechat_window_missing" } }
if ($processes.Count -ne 1) { Write-Result @{ ok = $false; reason = "wechat_window_ambiguous" } }
$process = $processes[0]
if ($mode -eq "scan" -and $sessionPreviewPrimed) {
  if ($sessionExpectedPid -gt 0 -and $sessionExpectedPid -ne $process.Id) {
    Write-Result @{ ok = $false; reason = "wechat_process_changed"; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
  }
  if ($sessionExpectedHwnd -gt 0 -and $sessionExpectedHwnd -ne [int64]$process.MainWindowHandle) {
    Write-Result @{ ok = $false; reason = "wechat_window_changed"; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
  }
}
if ($mode -eq "verify") {
  if ($expectedPid -and [int]$expectedPid -ne $process.Id) { Write-Result @{ ok = $false; reason = "wechat_process_changed" } }
  if ($expectedHwnd -and [int64]$expectedHwnd -ne [int64]$process.MainWindowHandle) { Write-Result @{ ok = $false; reason = "wechat_window_changed" } }
}

$hWnd = [IntPtr]$process.MainWindowHandle
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
if ($root -eq $null) { Write-Result @{ ok = $false; reason = "automation_root_missing" } }
$windowRect = $root.Current.BoundingRectangle
if ($windowRect.Width -lt 400 -or $windowRect.Height -lt 300) { Write-Result @{ ok = $false; reason = "wechat_window_not_ready" } }
$script:windowIdentity = @{
  x = [int][Math]::Round($windowRect.Left)
  y = [int][Math]::Round($windowRect.Top)
  width = [int][Math]::Round($windowRect.Width)
  height = [int][Math]::Round($windowRect.Height)
}
$script:windowDpi = [int]96
try {
  $reportedDpi = [Win32WechatAutoReply]::GetDpiForWindow($hWnd)
  if ($reportedDpi -ge 72 -and $reportedDpi -le 480) { $script:windowDpi = [int]$reportedDpi }
} catch {}
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$sessionProbe = $null
$sessionRows = @()
if ($mode -eq "prime" -or $mode -eq "scan") {
  $sessionProbe = Find-EligibleSessionRows $all $allowedSet $windowRect
  $sessionRows = @($sessionProbe.rows)
  $script:sessionBaselines = @($sessionRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.signature) } | ForEach-Object {
    [pscustomobject]@{ conversation = [string]$_.name; signature = [string]$_.signature }
  })
  $script:sessionProbeDiagnostics = $sessionProbe.diagnostics
  if (-not $sessionProbe.schemaObserved) { $script:sessionProbeDiagnostics["failure"] = "schema_not_observed" }
}

if ($mode -eq "prime") {
  if (-not $sessionProbe.schemaObserved) {
    Write-Result @{ ok = $false; reason = "session_probe_unsupported"; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
  }
  $primeConversation = Find-CurrentEligibleConversation $all $allowedSet $windowRect
  if ([string]::IsNullOrWhiteSpace($primeConversation)) {
    Write-Result @{ ok = $true; source = "session_prime"; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
  }
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
  if (-not $sessionProbe.schemaObserved) {
    Write-Result @{ ok = $false; reason = "session_probe_unsupported"; pid = [int]$process.Id; hWnd = [int64]$process.MainWindowHandle }
  }
  $match = $null
  $matchChanged = $false
  foreach ($row in @($sessionRows | Sort-Object top)) {
    $previewBaseline = Get-CurrentBaseline $sessionPreviewBaselines ([string]$row.name)
    $firstSeen = $sessionPreviewPrimed -and -not [string]::IsNullOrWhiteSpace([string]$row.signature) -and [string]::IsNullOrWhiteSpace($previewBaseline) -and (Test-SessionSincePrime ([string]$row.displayTime) $sessionPrimedAtMs)
    $changed = -not [string]::IsNullOrWhiteSpace([string]$row.signature) -and -not [string]::IsNullOrWhiteSpace($previewBaseline) -and $previewBaseline -cne [string]$row.signature
    if ($row.unread -or $changed -or $firstSeen) { $match = $row; $matchChanged = $changed -or $firstSeen; break }
  }
  if ($match -eq $null) {
    $expectedConversation = Find-CurrentEligibleConversation $all $allowedSet $windowRect
    if ([string]::IsNullOrWhiteSpace($expectedConversation)) {
      Write-Result @{ ok = $false; reason = "no_unread_message" }
    }
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
    if (-not $matchChanged -and [string]::IsNullOrWhiteSpace([string]$match.preview)) { Write-Result @{ ok = $false; reason = "unread_preview_missing" } }
    $script:pendingSessionConversation = [string]$match.name
    if (-not (Open-Session $match.item $hWnd)) { Write-Result @{ ok = $false; reason = "conversation_open_failed" } }
    $expectedConversation = $match.name
    $candidateSource = $(if ($matchChanged) { "preview_change" } else { "unread" })
    $expectedMessage = $(if ($candidateSource -eq "unread") { [string]$match.preview } else { "" })
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
  const payload = gzipSync(Buffer.from(script, "utf8"), { level: 9 }).toString("base64");
  return `
$c = [Convert]::FromBase64String("${payload}")
$m = [IO.MemoryStream]::new($c)
$g = [IO.Compression.GZipStream]::new($m, [IO.Compression.CompressionMode]::Decompress)
Invoke-Expression ([IO.StreamReader]::new($g).ReadToEnd())
`;
}

const AUTO_REPLY_RUN_SCRIPT = compressedPowerShell(AUTO_REPLY_SCAN_SCRIPT);

function createWechatAutoReplyDriver(powerShellRunner = runPowerShellAsync, windowNormalizer = normalizeWechatMainWindowAsync) {
  const currentSessionBaselines = new Map();
  const sessionPreviewBaselines = new Map();
  const retryCandidates = [];
  let baselineEpoch = 0;
  let retryAfterFresh = false;
  let sessionPreviewPrimed = false;
  let sessionPreviewPrimedAt = 0;
  let sessionPreviewProcess = null;
  let needsReprime = false;
  let normalizedWindowIdentity = null;
  let windowNormalized = false;
  let normalizedForReprime = false;
  // WeChat 4.1.x exposes only a compositor pane through UIA on many machines.
  // Pick one adapter for the whole run instead of probing UIA and then silently
  // switching baselines underneath the visual scanner.
  let activeScanMode = "visual";
  let visualDriver = null;

  const scanFenceReasons = new Set([
    "chat_boundary_unresolved",
    "latest_message_role_unresolved",
    "wechat_focus_failed"
  ]);

  function scanFenceResult(result) {
    const directReason = String(result?.reason || "").trim();
    if (result?.ok !== true && scanFenceReasons.has(directReason)) return result;
    const probeReason = String(result?.scanProbe?.reason || "").trim();
    if (!scanFenceReasons.has(probeReason)) return null;
    return { ok: false, reason: probeReason, scanProbe: result.scanProbe };
  }

  function getVisualDriver() {
    if (visualDriver) return visualDriver;
    try {
      const { createWechatVisualAutoReplyDriver } = require("./wechat_auto_reply_visual_driver.dev.cjs");
      visualDriver = createWechatVisualAutoReplyDriver(powerShellRunner, () => normalizedWindowIdentity);
      return visualDriver;
    } catch {
      return null;
    }
  }

  function visualCandidate(result) {
    return result?.ok === true && result?.conversation
      ? { ...result, visualMode: "visual_render_v1" }
      : result;
  }

  function isVisualCandidate(candidate = {}) {
    const runtimeId = String(candidate.runtimeId || "");
    const evidenceRuntimeId = String(candidate.visualEvidenceRuntimeId || "");
    return candidate.visualMode === "visual_render_v1"
      || /^visual:v[12]:[a-f0-9]{64}$/u.test(runtimeId)
      || /^visual:v1:[a-f0-9]{64}$/u.test(evidenceRuntimeId);
  }

  async function switchToVisualPrime(allowed, fallbackResult) {
    const driver = getVisualDriver();
    if (!driver) return fallbackResult;
    const primed = await driver.primeWechatSession(allowed);
    if (primed?.ok === true) activeScanMode = "visual";
    return primed;
  }

  function allowedNames(names) {
    return [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || "").trim()).filter(Boolean))];
  }

  function processIdentity(result) {
    const pid = Math.floor(Number(result?.pid));
    const hWnd = String(result?.hWnd || "").trim();
    return Number.isSafeInteger(pid) && pid > 0 && /^[1-9][0-9]{0,19}$/.test(hWnd) ? { pid, hWnd } : null;
  }

  function windowIdentity(result) {
    const process = processIdentity(result);
    if (!process) return null;
    const window = result?.window && typeof result.window === "object" ? result.window : result;
    const number = (...values) => {
      const value = values.map(Number).find(Number.isFinite);
      return value === undefined ? null : Math.round(value);
    };
    const x = number(window.x, window.left);
    const y = number(window.y, window.top);
    const width = number(window.width, Number(window.right) - Number(window.left));
    const height = number(window.height, Number(window.bottom) - Number(window.top));
    const dpi = number(result?.dpi, result?.DPI, result?.windowDpi, window.dpi, window.DPI);
    return { ...process, x, y, width, height, dpi };
  }

  function materiallyChangedWindow(expected, observed) {
    if (!expected || !observed) return false;
    if (expected.pid !== observed.pid || expected.hWnd !== observed.hWnd) return true;
    for (const field of ["x", "y", "width", "height"]) {
      if (expected[field] !== null && observed[field] !== null && Math.abs(expected[field] - observed[field]) > 3) return true;
    }
    return expected.dpi !== null && observed.dpi !== null && expected.dpi !== observed.dpi;
  }

  function resetSessionIdentityForReprime({ windowAlreadyNormalized = false } = {}) {
    currentSessionBaselines.clear();
    sessionPreviewBaselines.clear();
    sessionPreviewPrimed = false;
    sessionPreviewPrimedAt = 0;
    sessionPreviewProcess = null;
    needsReprime = true;
    normalizedForReprime = windowAlreadyNormalized;
  }

  async function normalizeWindowForExecution(expectedIdentity = null) {
    let normalized;
    try {
      normalized = await Promise.resolve(windowNormalizer(expectedIdentity ? {
        expectedPid: expectedIdentity.pid,
        expectedHWnd: expectedIdentity.hWnd
      } : {}));
    } catch {
      return { ok: false, reason: "wechat_window_not_ready" };
    }
    if (normalized?.ok !== true) return normalized?.reason ? normalized : { ok: false, reason: "wechat_window_not_ready" };
    normalizedWindowIdentity = windowIdentity(normalized);
    windowNormalized = true;
    return null;
  }

  async function normalizeChangedWindow(result) {
    const observed = windowIdentity(result);
    if (!observed || !normalizedWindowIdentity
      || observed.pid !== normalizedWindowIdentity.pid
      || observed.hWnd !== normalizedWindowIdentity.hWnd
      || !materiallyChangedWindow(normalizedWindowIdentity, observed)) return false;
    const failure = await normalizeWindowForExecution(observed);
    resetSessionIdentityForReprime({ windowAlreadyNormalized: !failure });
    return failure || { ok: false, reason: "wechat_window_changed", pid: observed.pid, hWnd: observed.hWnd };
  }

  function applySessionBaselines(result, allowed, { priming = false } = {}) {
    const rows = Array.isArray(result?.sessionBaselines) ? result.sessionBaselines : [];
    const pending = String(result?.sessionBaselinePending || "").trim();
    const commitPending = result?.ok === true || result?.reason === "latest_message_not_incoming";
    for (const row of rows.slice(0, 1_000)) {
      const conversation = String(row?.conversation || "").trim();
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !/^[a-f0-9]{64}$/.test(signature)) continue;
      const previous = sessionPreviewBaselines.get(conversation);
      if (conversation === pending && !commitPending) {
        if (!previous) sessionPreviewBaselines.set(conversation, "0".repeat(64));
        continue;
      }
      if (conversation !== pending && previous && previous !== signature) continue;
      if (conversation !== pending && !previous && !priming) continue;
      sessionPreviewBaselines.set(conversation, signature);
    }
    while (sessionPreviewBaselines.size > 1_000) sessionPreviewBaselines.delete(sessionPreviewBaselines.keys().next().value);
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
    if (normalizedForReprime) normalizedForReprime = false;
    else {
      const windowFailure = await normalizeWindowForExecution();
      if (windowFailure) return windowFailure;
    }
    if (activeScanMode === "visual") {
      const driver = getVisualDriver();
      return driver ? driver.primeWechatSession(allowed) : { ok: false, reason: "visual_driver_missing" };
    }
    const activeBaselineEpoch = baselineEpoch;
    const result = await Promise.resolve(powerShellRunner(AUTO_REPLY_RUN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "prime",
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
      XIAOXI_SESSION_BASELINES: JSON.stringify(Object.fromEntries(sessionPreviewBaselines)),
      XIAOXI_SESSION_PRIMED: "false",
      XIAOXI_SESSION_PRIMED_AT: "0"
    }, { ensure: false }));
    if (activeBaselineEpoch !== baselineEpoch) return { ok: false, reason: "baseline_epoch_changed" };
    if (result?.reason === "session_probe_unsupported") return switchToVisualPrime(allowed, result);
    if (result?.ok !== true) return result;
    const identity = processIdentity(result);
    if (!identity) return { ok: false, reason: "incoming_identity_missing" };
    applySessionBaselines(result, allowed, { priming: true });
    if (result.source === "session_prime") {
      sessionPreviewPrimed = true;
      sessionPreviewPrimedAt = Date.now();
      sessionPreviewProcess = identity;
      needsReprime = false;
      return { ok: true, primed: true };
    }
    const conversation = String(result.conversation || "").trim();
    const runtimeId = String(result.runtimeId || "").trim();
    if (!conversation || !runtimeId) return { ok: false, reason: "incoming_identity_missing" };
    currentSessionBaselines.set(`${result.pid || ""}:${result.hWnd || ""}:${conversation}`, runtimeId);
    sessionPreviewPrimed = true;
    sessionPreviewPrimedAt = Date.now();
    sessionPreviewProcess = identity;
    needsReprime = false;
    return { ok: true, primed: true };
  }

  async function scanWechatIncoming(names) {
    const allowed = allowedNames(names);
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    if (needsReprime) {
      const primed = await primeWechatSession(allowed);
      return primed?.ok === true ? { ok: false, reason: "current_session_baselined" } : primed;
    }
    if (!windowNormalized) {
      const windowFailure = await normalizeWindowForExecution();
      if (windowFailure) return windowFailure;
    }
    if (activeScanMode === "visual") {
      const driver = getVisualDriver();
      if (!driver) return { ok: false, reason: "visual_driver_missing" };
      const result = visualCandidate(await driver.scanWechatIncoming(allowed));
      if (result?.reason === "wechat_process_changed" || result?.reason === "wechat_window_changed") {
        // The visual adapter has dropped its old binding. Drop the shared
        // normalizer identity too; otherwise the next prime would be forced
        // back onto the dead HWND forever.
        normalizedWindowIdentity = null;
        windowNormalized = false;
        return result;
      }
      const changedWindow = await normalizeChangedWindow(result);
      if (changedWindow) return changedWindow;
      const fenced = scanFenceResult(result);
      if (!fenced) return result;
      if (result?.ok === true && result?.scanProbe) driver.scanWechatIncoming?.requeue?.(result);
      return fenced;
    }
    if (retryAfterFresh) {
      retryAfterFresh = false;
      const retry = takeRetryCandidate(allowed);
      if (retry) return retry;
    }
    const activeBaselineEpoch = baselineEpoch;
    const result = await Promise.resolve(powerShellRunner(AUTO_REPLY_RUN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "scan",
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
      XIAOXI_CURRENT_BASELINES: JSON.stringify(Object.fromEntries(currentSessionBaselines)),
      XIAOXI_SESSION_BASELINES: JSON.stringify(Object.fromEntries(sessionPreviewBaselines)),
      XIAOXI_SESSION_PRIMED: sessionPreviewPrimed ? "true" : "false",
      XIAOXI_SESSION_PRIMED_AT: String(sessionPreviewPrimedAt || 0),
      XIAOXI_SESSION_EXPECTED_PID: String(sessionPreviewProcess?.pid || 0),
      XIAOXI_SESSION_EXPECTED_HWND: String(sessionPreviewProcess?.hWnd || 0)
    }, { ensure: false }));
    if (activeBaselineEpoch !== baselineEpoch) return { ok: false, reason: "baseline_epoch_changed" };
    if (result?.reason === "session_probe_unsupported") {
      const primed = await switchToVisualPrime(allowed, result);
      return primed?.ok === true ? { ok: false, reason: "current_session_baselined" } : primed;
    }
    const changedWindow = await normalizeChangedWindow(result);
    if (changedWindow) return changedWindow;
    const fenced = scanFenceResult(result);
    if (fenced) return fenced;
    const observedIdentity = processIdentity(result);
    const identityChanged = sessionPreviewProcess && observedIdentity && (
      sessionPreviewProcess.pid !== observedIdentity.pid || sessionPreviewProcess.hWnd !== observedIdentity.hWnd
    );
    if (identityChanged || result?.reason === "wechat_process_changed" || result?.reason === "wechat_window_changed") {
      const observed = windowIdentity(result);
      const windowFailure = observed ? await normalizeWindowForExecution(observed) : null;
      resetSessionIdentityForReprime({ windowAlreadyNormalized: Boolean(observed) && !windowFailure });
      return result?.reason === "wechat_window_changed" ? result : { ...result, ok: false, reason: "wechat_process_changed" };
    }
    applySessionBaselines(result, allowed);
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
    if (isVisualCandidate(candidate)) {
      const driver = getVisualDriver();
      return driver ? driver.verifyWechatIncoming(candidate) : { ok: false, reason: "visual_driver_missing" };
    }
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
  scanWechatIncoming.restorePendingObservation = (metadata) => {
    const driver = getVisualDriver();
    const restored = driver?.scanWechatIncoming?.restorePendingObservation?.(metadata) === true;
    if (restored) {
      activeScanMode = "visual";
      needsReprime = false;
    }
    return restored;
  };
  scanWechatIncoming.noteVerifiedSend = (candidate, metadata) => {
    if (!isVisualCandidate(candidate)) return false;
    return getVisualDriver()?.scanWechatIncoming?.noteVerifiedSend?.(candidate, metadata) === true;
  };
  scanWechatIncoming.noteSendAttempted = (candidate, metadata) => {
    if (!isVisualCandidate(candidate)) return false;
    return getVisualDriver()?.scanWechatIncoming?.noteSendAttempted?.(candidate, metadata) || false;
  };
  scanWechatIncoming.restoreTurnBoundaries = (values) => {
    const driver = getVisualDriver();
    if (!driver?.scanWechatIncoming?.restoreTurnBoundaries) return 0;
    activeScanMode = "visual";
    return driver.scanWechatIncoming.restoreTurnBoundaries(values);
  };
  scanWechatIncoming.requeue = (candidate) => {
    if (candidate?.ok !== true) return false;
    if (isVisualCandidate(candidate)) {
      return getVisualDriver()?.scanWechatIncoming?.requeue?.(candidate) === true;
    }
    const { scanProbe: _discardedProbe, ...retryCandidate } = candidate;
    const key = [retryCandidate.conversation, retryCandidate.runtimeId, retryCandidate.message].map(String).join("\n");
    if (retryCandidates.some((item) => [item.conversation, item.runtimeId, item.message].map(String).join("\n") === key)) return true;
    if (retryCandidates.length >= 1_000) return false;
    retryCandidates.push(retryCandidate);
    return true;
  };
  scanWechatIncoming.resetBaselines = () => {
    baselineEpoch += 1;
    activeScanMode = "visual";
    currentSessionBaselines.clear();
    sessionPreviewBaselines.clear();
    sessionPreviewPrimed = false;
    sessionPreviewPrimedAt = 0;
    sessionPreviewProcess = null;
    needsReprime = false;
    normalizedWindowIdentity = null;
    windowNormalized = false;
    normalizedForReprime = false;
    visualDriver?.scanWechatIncoming?.resetBaselines?.();
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
