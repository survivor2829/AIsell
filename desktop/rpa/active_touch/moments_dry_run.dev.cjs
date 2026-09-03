const crypto = require("node:crypto");
const {
  appendLog,
  loadState,
  saveState
} = require("./state_machine.cjs");
const { runPowerShell } = require("./wechat_window_driver.cjs");
const { probeVisualWechatMomentsWindow } = require("./moments_visual_dry_run.dev.cjs");
const {
  normalizeExpectedMomentsSurface,
  validMomentsSurfaceRoot
} = require("./moments_surface_profile.dev.cjs");

const MAX_MOMENTS_COMMENT_LENGTH = 500;
const MOMENTS_STRUCTURAL_PROBE_TIMEOUT_MS = 5_000;
const MOMENTS_VISUAL_TOP_EDGE_RATIO = 0.035;

const MOMENTS_NON_CONTENT_SUFFIX_TOKENS = new Set(["赞", "点赞", "取消", "取消赞", "评论", "删除"]);

function lastVolatileTimeToken(value) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const matches = [...normalized.matchAll(/(?:^|\s)(?:刚刚|昨天|\d+\s*(?:秒|分钟|小时|天)前|(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s+\d{1,2}:\d{2})?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{1,2}:\d{2})(?=\s|$)/gu)];
  const match = matches.at(-1);
  if (!match) return { normalized, match: undefined };
  const suffix = normalized.slice(match.index + match[0].length).trim();
  const suffixTokens = suffix ? suffix.split(" ") : [];
  const suffixIsNonContentUi = suffixTokens.every((token) => MOMENTS_NON_CONTENT_SUFFIX_TOKENS.has(token));
  const suffixContainsCommentRow = /(?:^|\s)\S{1,80}\s*[:：]\s*\S/u.test(suffix);
  return { normalized, match: suffixIsNonContentUi || suffixContainsCommentRow ? match : undefined };
}

function stableMomentsPostLabel(value) {
  const { normalized, match } = lastVolatileTimeToken(value);
  if (!match) return normalized;
  return normalized.slice(0, match.index).trim();
}

function momentsPostIdentityPrefix(value) {
  const { normalized, match } = lastVolatileTimeToken(value);
  return (match ? normalized.slice(0, match.index) : normalized).trim();
}

function momentsPostFingerprint(value) {
  const stableLabel = stableMomentsPostLabel(value);
  if (!stableLabel) return "";
  return crypto.createHash("sha256").update(JSON.stringify({
    version: 1,
    label: stableLabel
  }), "utf8").digest("hex");
}

function normalizeMomentsStableContentText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/(?:刚刚|昨天|[0-9]+\s*(?:秒|分钟|小时|天)前)(?=(?:\s|赞|点赞|取消|取消赞|评论|删除)*$)/gu, "")
    .replace(/\s+/gu, "")
    .trim();
}

function boundedMomentsEditDistance(left, right, maximumDistance) {
  if (Math.abs(left.length - right.length) > maximumDistance) return maximumDistance + 1;
  const infinity = maximumDistance + 1;
  let previous = Array(right.length + 1).fill(infinity);
  for (let column = 0; column <= Math.min(right.length, maximumDistance); column += 1) {
    previous[column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    const current = Array(right.length + 1).fill(infinity);
    const start = Math.max(1, row - maximumDistance);
    const end = Math.min(right.length, row + maximumDistance);
    if (row <= maximumDistance) current[0] = row;
    let rowMinimum = infinity;
    for (let column = start; column <= end; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }
    if (rowMinimum > maximumDistance) return infinity;
    previous = current;
  }
  return previous[right.length];
}

function stableMomentsContentSimilarity(first, second) {
  const left = normalizeMomentsStableContentText(first);
  const right = normalizeMomentsStableContentText(second);
  if (!left || !right) return false;
  if (left === right) return true;
  const maximumLength = Math.max(left.length, right.length);
  const minimumLength = Math.min(left.length, right.length);
  if (minimumLength < 16 || maximumLength > 512) return false;
  const allowed = Math.min(3, Math.max(1, Math.floor(maximumLength * 0.04)));
  const distance = boundedMomentsEditDistance(left, right, allowed);
  return distance <= allowed && distance / maximumLength <= 0.07;
}

function stableMomentsPostIdentityText(firstIdentity, secondIdentity, firstAnchor, secondAnchor) {
  if (stableMomentsContentSimilarity(firstIdentity, secondIdentity)) return true;
  if (!String(firstAnchor ?? "").trim() || !String(secondAnchor ?? "").trim()) return false;
  return stableMomentsContentSimilarity(firstAnchor, secondAnchor);
}

// Duplicate suppression only, never proof authorizing a click or a send.
// A longer OCR crop can prepend/append text without changing the underlying post.
function momentsCommentTextContainsPrevious(first, second) {
  const left = normalizeMomentsStableContentText(first);
  const right = normalizeMomentsStableContentText(second);
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 24 && shorter.length >= longer.length / 2 && longer.includes(shorter);
}

function normalizedMomentsPostText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function momentsPostTextOverlap(first, second) {
  const left = normalizedMomentsPostText(first).toLowerCase();
  const right = normalizedMomentsPostText(second).toLowerCase();
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const grams = (value) => {
    const compact = value.replace(/[\p{P}\p{S}\s]+/gu, "");
    const result = new Set();
    for (let index = 0; index < compact.length - 1; index += 1) {
      result.add(compact.slice(index, index + 2));
    }
    for (const token of value.split(/[^\p{L}\p{N}]+/gu)) {
      if (token.length >= 2) result.add(token);
    }
    return result;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return false;
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1;
  }
  return shared / Math.min(leftGrams.size, rightGrams.size) >= 0.3;
}

function momentsPostBound(value, key) {
  const aliases = {
    bounds: ["bounds"],
    menu_bounds: ["menu_bounds", "menuBounds"],
    avatar_bounds: ["avatar_bounds", "avatarBounds"]
  };
  for (const alias of aliases[key] ?? []) {
    if (strictBounds(value?.[alias])) return value[alias];
  }
  return null;
}

function momentsPostDisplacementMatches(first, second, scrollDelta) {
  const expectedDelta = Number(scrollDelta);
  if (!Number.isFinite(expectedDelta)) return false;
  const tolerance = Math.max(72, Math.abs(expectedDelta) * 0.6);
  const pairs = ["bounds", "menu_bounds", "avatar_bounds"]
    .map((key) => [
      Number(momentsPostBound(first, key)?.top),
      Number(momentsPostBound(second, key)?.top)
    ])
    .filter(([firstTop, secondTop]) => Number.isFinite(firstTop) && Number.isFinite(secondTop));
  if (pairs.length === 0) return false;
  let matching = 0;
  for (const [firstTop, secondTop] of pairs) {
    if (Math.abs((secondTop - firstTop) - expectedDelta) <= tolerance) matching += 1;
  }
  return matching >= Math.min(2, pairs.length);
}

const MOMENTS_BLOCK_ERRORS = Object.freeze({
  moments_action_missing: "请至少选择点赞或评论",
  moments_mode_invalid: "朋友圈预演模式无效",
  moments_comment_missing: "启用评论后必须填写评论文案",
  moments_probe_failed: "朋友圈窗口检查执行失败，请稍后重试",
  moments_window_not_found: "请先在微信中打开朋友圈窗口",
  moments_window_ambiguous: "检测到多个朋友圈窗口，请只保留一个后重试",
  moments_window_identity_mismatch: "当前窗口不是可确认的个人微信朋友圈",
  moments_feed_not_found: "当前朋友圈列表无法读取",
  moments_feed_ambiguous: "当前朋友圈列表结构不唯一",
  moments_render_pane_not_found: "新版微信朋友圈渲染区域无法确认",
  moments_render_pane_ambiguous: "新版微信朋友圈渲染区域不唯一",
  moments_render_pane_bounds_invalid: "新版微信朋友圈渲染区域越界",
  moments_integrated_surface_not_proven: "当前微信主窗口无法唯一确认已进入朋友圈，系统未执行任何操作",
  moments_visual_capture_failed: "朋友圈视觉快照获取失败",
  moments_visual_ocr_unavailable: "本机简体中文视觉识别不可用",
  moments_visual_ocr_failed: "朋友圈文字识别失败",
  moments_window_not_foreground: "朋友圈窗口无法保持在前台",
  moments_window_obscured: "朋友圈窗口被其他窗口遮挡",
  moments_post_not_found: "暂未找到可操作的朋友圈内容，系统未执行任何操作",
  moments_post_ambiguous: "暂时无法唯一确认目标朋友圈内容，系统未执行任何操作",
  moments_post_changed: "朋友圈内容正在变化，系统未执行任何操作，请保持页面稳定后重试",
  moments_post_identity_missing: "当前可见内容缺少稳定身份或完整菜单锚点，系统未执行任何操作"
  ,
  moments_post_position_unsafe: "\u9876\u90e8\u5e16\u5b50\u4f4d\u7f6e\u4e0d\u9002\u5408\u64cd\u4f5c\uff0c\u5df2\u8df3\u8fc7\u5e76\u7ee7\u7eed\u67e5\u627e\u4e0b\u4e00\u6761",
});

const MOMENTS_WINDOW_PROBE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 6
  exit
}

function Get-ExpectedMomentsSurface {
  try {
    if ([string]::IsNullOrWhiteSpace([string]$env:XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64)) { return $null }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64))
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
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

function Get-StableMomentPostText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormKC)
  $normalized = [Text.RegularExpressions.Regex]::Replace(
    $normalized,
    "(?:刚刚|昨天|[0-9]+\s*(?:秒|分钟|小时|天)前)(?=(?:\s|赞|点赞|取消|取消赞|评论|删除)*$)",
    ""
  )
  return [Text.RegularExpressions.Regex]::Replace($normalized, "\s+", " ").Trim()
}

function Get-RuntimeId([System.Windows.Automation.AutomationElement]$element) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return ""
}

function Get-TopLevelFeedItemDepth(
  [System.Windows.Automation.AutomationElement]$feed,
  [System.Windows.Automation.AutomationElement]$item
) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try { $ancestor = $walker.GetParent($item) } catch { return -1 }
  $depth = 1
  while ($ancestor -ne $null -and $depth -le 16) {
    if ([System.Windows.Automation.Automation]::Compare($ancestor, $feed)) { return $depth }
    try {
      if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) { return -1 }
      $ancestor = $walker.GetParent($ancestor)
    } catch { return -1 }
    $depth += 1
  }
  return -1
}

function Get-VisibleMomentPosts([System.Windows.Automation.AutomationElement]$root) {
  $feedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "sns_list")
  $feeds = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $feedCondition)
  if ($feeds.Count -eq 0) { return @{ ok = $false; reason = "moments_feed_not_found" } }
  if ($feeds.Count -ne 1) { return @{ ok = $false; reason = "moments_feed_ambiguous" } }
  $feed = $feeds.Item(0)
  $feedRuntimeId = Get-RuntimeId $feed
  if ([string]::IsNullOrWhiteSpace($feedRuntimeId)) { return @{ ok = $false; reason = "moments_post_identity_missing" } }
  try { $feedRect = $feed.Current.BoundingRectangle } catch { return @{ ok = $false; reason = "moments_feed_not_found" } }
  if ($feedRect.Width -le 0 -or $feedRect.Height -le 0) { return @{ ok = $false; reason = "moments_feed_not_found" } }

  $listItemCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
  $items = $feed.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItemCondition)
  $posts = New-Object System.Collections.Generic.List[object]
  $hadIdentityMissing = $false
  for ($index = 0; $index -lt $items.Count; $index++) {
    $item = $items.Item($index)
    $feedDepth = Get-TopLevelFeedItemDepth $feed $item
    if ($feedDepth -lt 1) { continue }
    try {
      if ($item.Current.IsOffscreen) { continue }
      $rect = $item.Current.BoundingRectangle
      $automationId = [string]$item.Current.AutomationId
    } catch { continue }
    $text = Get-ElementText $item
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    if ($text.Length -gt 2000) { return @{ ok = $false; reason = "moments_post_identity_missing" } }
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    # ponytail: nested comment rows are tiny list items; raise this only if a real post layout becomes shorter.
    if ($rect.Height -lt 120 -or $text.Length -lt 8) { continue }
    $fullyVisible = $rect.Left -ge ($feedRect.Left - 2) -and $rect.Top -ge ($feedRect.Top - 2) -and $rect.Right -le ($feedRect.Right + 2) -and $rect.Bottom -le ($feedRect.Bottom + 2)
    if (-not $fullyVisible) { continue }
    $runtimeId = Get-RuntimeId $item
    if ([string]::IsNullOrWhiteSpace($runtimeId)) { $hadIdentityMissing = $true; continue }
    [void]$posts.Add([pscustomobject]@{
      runtimeId = $runtimeId
      automationId = $automationId
      structureVerified = $true
      feedDepth = $feedDepth
      text = $text
      left = [double]$rect.Left
      top = [double]$rect.Top
      width = [double]$rect.Width
      height = [double]$rect.Height
    })
  }
  return @{ ok = $true; feedAutomationId = [string]$feed.Current.AutomationId; feedRuntimeId = $feedRuntimeId; feedCount = 1; hadIdentityMissing = $hadIdentityMissing; posts = @($posts.ToArray() | Sort-Object top, left) }
}

function Test-PostSequence($first, $second) {
  $left = @($first)
  $right = @($second)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index++) {
    foreach ($field in @("runtimeId", "automationId", "structureVerified", "feedDepth", "left", "top", "width", "height")) {
      if ([string]$left[$index].$field -cne [string]$right[$index].$field) { return $false }
    }
    if ((Get-StableMomentPostText ([string]$left[$index].text)) -cne (Get-StableMomentPostText ([string]$right[$index].text))) { return $false }
  }
  return $true
}

$processNames = @("Weixin", "WeChat")
$expectedSurface = Get-ExpectedMomentsSurface
$script:matches = @()
$callback = [Win32WechatMomentsProbe+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [Win32WechatMomentsProbe]::IsWindowVisible($hWnd)) { return $true }
  $titleText = New-Object System.Text.StringBuilder 512
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsProbe]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  [void][Win32WechatMomentsProbe]::GetClassName($hWnd, $classText, $classText.Capacity)
  $title = $titleText.ToString().Trim()
  $className = $classText.ToString().Trim()
  if ($title -ne "朋友圈") { return $true }
  if ($expectedSurface -ne $null -and
    ([string]$expectedSurface.hWnd -cne [string]$hWnd.ToInt64() -or
      [string]$expectedSurface.title -cne $title -or
      [string]$expectedSurface.className -cne $className)) { return $true }
  [uint32]$windowProcessId = 0
  [void][Win32WechatMomentsProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  if ($process -eq $null -or $processNames -notcontains $process.ProcessName) { return $true }
  if ($expectedSurface -ne $null -and [int]$expectedSurface.pid -ne [int]$windowProcessId) { return $true }
  $rect = New-Object Win32WechatMomentsProbe+RECT
  if (-not [Win32WechatMomentsProbe]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 300 -or $height -lt 300) { return $true }
  $script:matches += @{
    ok = $true
    title = $title
    className = $className
    processName = $process.ProcessName
    pid = $windowProcessId
    hWnd = $hWnd.ToInt64()
    left = $rect.Left
    top = $rect.Top
    width = $width
    height = $height
  }
  return $true
}
[void][Win32WechatMomentsProbe]::EnumWindows($callback, [IntPtr]::Zero)
if ($matches.Count -eq 0) {
  Write-Result @{ ok = $false; reason = "moments_window_not_found" }
}
if ($matches.Count -gt 1) {
  Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $matches.Count }
}
$matched = $matches[0]
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$matched.hWnd) } catch { $root = $null }
if ($root -eq $null) { Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" } }
try {
  $rootAutomationId = [string]$root.Current.AutomationId
  $rootName = [string]$root.Current.Name
  $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
  $rootProcessId = [int]$root.Current.ProcessId
} catch {
  Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
}
if ($rootProcessId -ne [int]$matched.pid -or $rootName -cne "朋友圈" -or $rootControlType -cne "ControlType.Window" -or @("", "SNSWindow") -notcontains $rootAutomationId) {
  Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
}
$firstRead = Get-VisibleMomentPosts $root
if (-not $firstRead.ok) { Write-Result $firstRead }
Start-Sleep -Milliseconds 120
$secondRead = Get-VisibleMomentPosts $root
if (-not $secondRead.ok) { Write-Result $secondRead }
if ($firstRead.feedRuntimeId -cne $secondRead.feedRuntimeId -or [bool]$firstRead.hadIdentityMissing -ne [bool]$secondRead.hadIdentityMissing -or
  -not (Test-PostSequence $firstRead.posts $secondRead.posts)) { Write-Result @{ ok = $false; reason = "moments_post_changed" } }
$identityMode = if ($rootAutomationId -ceq "SNSWindow") { "automation_id" } else { "structural_sns_feed" }
$matched["automationId"] = $rootAutomationId
$matched["surfaceMode"] = "standalone"
$matched["identityMode"] = $identityMode
$matched["rootName"] = $rootName
$matched["rootControlType"] = $rootControlType
$matched["rootProcessId"] = $rootProcessId
$matched["feedAutomationId"] = [string]$secondRead.feedAutomationId
$matched["feedRuntimeId"] = [string]$secondRead.feedRuntimeId
$matched["feedCount"] = [int]$secondRead.feedCount
$posts = @($secondRead.posts)
if ($posts.Count -eq 0) {
  Write-Result @{ ok = $false; reason = $(if ($secondRead.hadIdentityMissing) { "moments_post_identity_missing" } else { "moments_post_not_found" }) }
}
$matched["posts"] = $posts
Write-Result $matched
`;

function probeWechatMomentsWindow(expectedWindow) {
  const expectedSurface = normalizeExpectedMomentsSurface(expectedWindow);
  return runPowerShell(MOMENTS_WINDOW_PROBE_SCRIPT, {
    XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64: expectedSurface
      ? Buffer.from(JSON.stringify(expectedSurface), "utf8").toString("base64")
      : ""
  }, {
    ensure: false,
    timeout: MOMENTS_STRUCTURAL_PROBE_TIMEOUT_MS
  });
}

function normalizeMomentsWindow(windowResult) {
  const pid = Number(windowResult?.pid);
  const hWnd = String(windowResult?.hWnd ?? "").trim();
  const bounds = {
    left: Number(windowResult?.left),
    top: Number(windowResult?.top),
    width: Number(windowResult?.width),
    height: Number(windowResult?.height)
  };
  const validHandle = /^[1-9]\d*$/u.test(hWnd);
  const validBounds = Object.values(bounds).every(Number.isFinite) && bounds.width >= 300 && bounds.height >= 300;
  if (!Number.isInteger(pid) || pid <= 0 || !validHandle || !validBounds) return null;
  return { pid, hWnd, ...bounds };
}

function momentsWindowSnapshot(windowResult, verifiedWindow) {
  return {
    surfaceMode: windowResult.surfaceMode,
    title: windowResult.title,
    className: windowResult.className,
    automationId: windowResult.automationId,
    identityMode: windowResult.identityMode,
    rootName: windowResult.rootName,
    rootControlType: windowResult.rootControlType,
    rootProcessId: windowResult.rootProcessId,
    feedAutomationId: windowResult.feedAutomationId,
    feedRuntimeId: windowResult.feedRuntimeId,
    feedCount: windowResult.feedCount,
    renderPaneName: windowResult.renderPaneName,
    renderPaneAutomationId: windowResult.renderPaneAutomationId,
    renderPaneControlType: windowResult.renderPaneControlType,
    renderPaneProcessId: windowResult.renderPaneProcessId,
    renderPaneRuntimeId: windowResult.renderPaneRuntimeId,
    renderPaneBounds: windowResult.renderPaneBounds,
    processName: windowResult.processName,
    pid: verifiedWindow.pid,
    hWnd: verifiedWindow.hWnd,
    left: verifiedWindow.left,
    top: verifiedWindow.top,
    width: verifiedWindow.width,
    height: verifiedWindow.height
  };
}

function momentsSurfaceMatchesExpected(windowResult, expectedSurface) {
  return !expectedSurface || (
    windowResult?.surfaceMode === expectedSurface.surfaceMode
    && Number(windowResult?.pid) === expectedSurface.pid
    && String(windowResult?.hWnd) === expectedSurface.hWnd
    && windowResult?.title === expectedSurface.title
    && windowResult?.className === expectedSurface.className
  );
}

function strictBounds(bounds, minimumWidth = 0, minimumHeight = 0) {
  return bounds !== null
    && typeof bounds === "object"
    && [bounds.left, bounds.top, bounds.width, bounds.height].every((value) => typeof value === "number" && Number.isFinite(value))
    && bounds.width > minimumWidth
    && bounds.height > minimumHeight;
}

function boundsWithin(inner, outer) {
  return strictBounds(inner)
    && strictBounds(outer)
    && inner.left >= outer.left
    && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width
    && inner.top + inner.height <= outer.top + outer.height;
}

function momentsCandidateBounds(post) {
  const source = post?.bounds && typeof post.bounds === "object"
    ? post.bounds
    : { left: post?.left, top: post?.top, width: post?.width, height: post?.height };
  return {
    left: Number(source?.left),
    top: Number(source?.top),
    width: Number(source?.width),
    height: Number(source?.height)
  };
}

function boundsIntersection(inner, outer) {
  if (!strictBounds(inner) || !strictBounds(outer)) return null;
  const left = Math.max(inner.left, outer.left);
  const top = Math.max(inner.top, outer.top);
  const right = Math.min(inner.left + inner.width, outer.left + outer.width);
  const bottom = Math.min(inner.top + inner.height, outer.top + outer.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function stableMomentsCandidateKey(post) {
  const runtimeId = String(post?.runtimeId ?? "").trim();
  if (runtimeId) return `uia:${runtimeId}`;
  const identityText = String(post?.identityText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const avatarHash = String(post?.avatarHash ?? "").trim();
  const bounds = momentsCandidateBounds(post);
  const menuBounds = post?.menuBounds;
  if (!identityText || !/^[0-9a-f]{64}$/u.test(avatarHash) || !strictBounds(bounds) || !strictBounds(menuBounds)) return "";
  return [
    "visual",
    momentsPostFingerprint(identityText),
    avatarHash,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    menuBounds.left,
    menuBounds.top,
    menuBounds.width,
    menuBounds.height
  ].join(":");
}

function roundedMomentsRatio(value) {
  const normalized = Math.min(1, Math.max(0, Number(value)));
  return Number(normalized.toFixed(4));
}

function momentsCandidatePosition(post, viewportBounds, partialVisible = false) {
  const viewport = strictBounds(viewportBounds) ? viewportBounds : null;
  if (!viewport) return {};
  const bounds = momentsCandidateBounds(post);
  if (!strictBounds(bounds)) return {};
  const runtimeId = String(post?.runtimeId ?? "").trim();
  const relativeTop = (bounds.top - viewport.top) / viewport.height;
  const relativeCenter = (bounds.top + (bounds.height / 2) - viewport.top) / viewport.height;
  const menuBounds = strictBounds(post?.menuBounds) ? post.menuBounds : null;
  const relativeMenuCenter = menuBounds
    ? (menuBounds.top + (menuBounds.height / 2) - viewport.top) / viewport.height
    : undefined;
  const topRatio = roundedMomentsRatio(relativeTop);
  const centerRatio = roundedMomentsRatio(relativeCenter);
  const menuYRatio = Number.isFinite(relativeMenuCenter) ? roundedMomentsRatio(relativeMenuCenter) : undefined;
  const topEdgeUnsafe = !runtimeId && relativeTop < MOMENTS_VISUAL_TOP_EDGE_RATIO;
  return {
    position_zone: topEdgeUnsafe ? "top_edge" : partialVisible ? "bottom_partial" : runtimeId ? "uia" : "actionable",
    top_edge_unsafe: topEdgeUnsafe,
    target_top_ratio: topRatio,
    target_center_y_ratio: centerRatio,
    ...(menuYRatio === undefined ? {} : { target_menu_y_ratio: menuYRatio })
  };
}

function assessVisibleMomentsCandidate(post, viewportBounds) {
  const viewport = strictBounds(viewportBounds) ? viewportBounds : null;
  const bounds = momentsCandidateBounds(post);
  const visibleBounds = boundsIntersection(bounds, viewport);
  if (!viewport || !visibleBounds) return { ok: false };
  const partialVisible = post?.partialVisible === true || !boundsWithin(bounds, viewport);
  const position = momentsCandidatePosition(post, viewport, partialVisible);
  const stableKey = stableMomentsCandidateKey(post);
  if (!stableKey || post?.structureVerified !== true) return { ok: false };

  if (String(post?.runtimeId ?? "").trim()) {
    const label = String(post?.text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const feedDepth = Number(post?.feedDepth);
    if (!label || label.length > 2000 || !Number.isInteger(feedDepth) || feedDepth < 1 || feedDepth > 16
      || partialVisible) return { ok: false };
  } else {
    const label = String(post?.text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const identityText = String(post?.identityText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const hashesValid = [post?.regionHash, post?.avatarHash, post?.layoutHash]
      .every((value) => /^[0-9a-f]{64}$/u.test(String(value ?? "")));
    if (!label || label.length > 2000 || !identityText || identityText.length > 2000 || !hashesValid
      || !boundsWithin(post?.menuBounds, viewport) || !boundsWithin(post?.avatarBounds, viewport)) return { ok: false };
  }
  if (position.top_edge_unsafe) return { ok: false, rejection: "top_edge", position };
  return { ok: true, post, partialVisible, stableKey, visibleBounds, position };
}

function rankVisibleMomentsPosts(posts, viewportBounds) {
  const viewport = strictBounds(viewportBounds)
    ? viewportBounds
    : { left: 0, top: 0, width: 1, height: 1 };
  const viewportCenterX = viewport.left + (viewport.width / 2);
  const viewportCenterY = viewport.top + (viewport.height / 2);
  return posts.map((post, index) => {
    const bounds = momentsCandidateBounds(post);
    const valid = strictBounds(bounds);
    const centerX = bounds.left + (bounds.width / 2);
    const centerY = bounds.top + (bounds.height / 2);
    const xDistance = valid ? Math.abs(centerX - viewportCenterX) / viewport.width : Number.POSITIVE_INFINITY;
    const yDistance = valid ? Math.abs(centerY - viewportCenterY) / viewport.height : Number.POSITIVE_INFINITY;
    return {
      post,
      index,
      distance: (xDistance * xDistance) + (yDistance * yDistance),
      yDistance,
      top: bounds.top,
      left: bounds.left,
      stableKey: String(post?.runtimeId ?? post?.identityText ?? post?.text ?? "")
    };
  }).sort((left, right) => left.distance - right.distance
    || left.yDistance - right.yDistance
    || left.top - right.top
    || left.left - right.left
    || (left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
    || left.index - right.index);
}

function normalizeMomentsTargetPost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = String(value.source ?? "").trim();
  const runtimeId = String(value.runtime_id ?? "").trim();
  const identityText = normalizedMomentsPostText(value.identity_text);
  const stableAnchorText = normalizedMomentsPostText(value.stable_anchor_text);
  const avatarHash = String(value.avatar_hash ?? "").trim();
  const expectedScrollDelta = Number(value.expected_scroll_delta ?? 0);
  const structured = value.structure_verified === true;
  const bounds = momentsPostBound(value, "bounds");
  const visual = source.startsWith("visual:");
  if (!Number.isFinite(expectedScrollDelta) || Math.abs(expectedScrollDelta) > 2_000 || !bounds) return null;
  if (runtimeId && !visual) {
    return { ...value, source, runtime_id: runtimeId, expected_scroll_delta: expectedScrollDelta };
  }
  if (!visual || !structured || !identityText || !/^[0-9a-f]{64}$/u.test(avatarHash)) return null;
  return {
    ...value,
    source,
    identity_text: identityText,
    stable_anchor_text: stableAnchorText,
    avatar_hash: avatarHash,
    expected_scroll_delta: expectedScrollDelta
  };
}

function momentsTargetPostMatches(targetPost, candidate) {
  const target = normalizeMomentsTargetPost(targetPost);
  if (!target) return false;
  const runtimeId = String(candidate?.runtimeId ?? "").trim();
  if (target.runtime_id && runtimeId) return target.runtime_id === runtimeId;
  const candidateAvatarHash = String(candidate?.avatarHash ?? "").trim();
  const stableAvatar = /^[0-9a-f]{64}$/u.test(candidateAvatarHash)
    && candidateAvatarHash === target.avatar_hash;
  const structured = candidate?.structureVerified === true;
  const textOverlap = stableMomentsPostIdentityText(
    target.identity_text,
    candidate?.identityText,
    target.stable_anchor_text,
    candidate?.stableAnchorText
  ) || momentsPostTextOverlap(target.identity_text, candidate?.identityText)
    || momentsPostTextOverlap(target.stable_anchor_text, candidate?.stableAnchorText);
  return stableAvatar
    && structured
    && textOverlap
    && momentsPostDisplacementMatches(target, candidate, target.expected_scroll_delta);
}

function selectLockedMomentsPost(posts, targetPost) {
  const target = normalizeMomentsTargetPost(targetPost);
  if (!target) return { ok: false, reason: "moments_post_identity_missing", matchedCount: 0 };
  const matches = posts.filter((post) => momentsTargetPostMatches(target, post));
  if (matches.length === 0) return { ok: false, reason: "moments_post_not_found", matchedCount: 0 };
  if (matches.length > 1) return { ok: false, reason: "moments_post_ambiguous", matchedCount: matches.length };
  return { ok: true, post: matches[0], matchedCount: 1 };
}

function selectVisibleMomentsPost(posts, viewportBounds, targetPost = null) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { ok: false, reason: "moments_post_not_found", acceptedCount: 0 };
  }
  const assessments = posts.map((post) => assessVisibleMomentsCandidate(post, viewportBounds));
  const accepted = assessments.filter((entry) => entry.ok);
  const topRejected = assessments.filter((entry) => entry.rejection === "top_edge");
  const baseDiagnostics = {
    candidate_count: posts.length,
    accepted_count: accepted.length,
    rejected_top_count: topRejected.length
  };
  if (accepted.length === 0) {
    const topPosition = topRejected[0]?.position;
    return { ok: false, reason: topRejected.length > 0 ? "moments_post_position_unsafe" : "moments_post_identity_missing", acceptedCount: 0, diagnostics: { ...baseDiagnostics, ...(topPosition ?? {}) } };
  }
  const partialKeyCounts = new Map();
  for (const entry of accepted) {
    if (!entry.partialVisible) continue;
    partialKeyCounts.set(entry.stableKey, (partialKeyCounts.get(entry.stableKey) ?? 0) + 1);
  }
  const unambiguous = accepted.filter((entry) => !entry.partialVisible || partialKeyCounts.get(entry.stableKey) === 1);
  if (unambiguous.length === 0) {
    return { ok: false, reason: "moments_post_ambiguous", acceptedCount: 0, diagnostics: baseDiagnostics };
  }
  let selected;
  let targetDiagnostics = {};
  if (targetPost) {
    const locked = selectLockedMomentsPost(unambiguous.map((entry) => entry.post), targetPost);
    targetDiagnostics = { target_locked: true, target_matched_count: locked.matchedCount };
    if (!locked.ok) {
      return {
        ok: false,
        reason: locked.reason,
        acceptedCount: 0,
        diagnostics: { ...baseDiagnostics, ...targetDiagnostics }
      };
    }
    selected = locked.post;
  } else {
    selected = rankVisibleMomentsPosts(unambiguous.map((entry) => entry.post), viewportBounds)[0]?.post;
  }
  const assessment = unambiguous.find((entry) => entry.post === selected);
  return { ok: true, post: selected, partialVisible: assessment?.partialVisible === true, acceptedCount: unambiguous.length, diagnostics: { ...baseDiagnostics, accepted_count: unambiguous.length, ...targetDiagnostics, ...(assessment?.position ?? {}) } };
}

function preferredVisibleMomentsPost(posts, viewportBounds, targetPost = null) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  if (targetPost) {
    const locked = selectLockedMomentsPost(posts, targetPost);
    return locked.ok ? locked.post : null;
  }
  return rankVisibleMomentsPosts(posts, viewportBounds)[0]?.post ?? null;
}

function validMomentsWindowIdentity(windowResult) {
  const automationId = String(windowResult?.automationId ?? "");
  const identityMode = String(windowResult?.identityMode ?? "");
  const surfaceMode = String(windowResult?.surfaceMode ?? "");
  const surfaceRoot = validMomentsSurfaceRoot(windowResult);
  const commonRoot = surfaceRoot
    && ["Weixin", "WeChat"].includes(windowResult?.processName)
    && typeof windowResult?.className === "string"
    && Boolean(windowResult.className.trim())
    && windowResult?.rootControlType === "ControlType.Window"
    && Number(windowResult?.rootProcessId) === Number(windowResult?.pid);
  if (!commonRoot) return false;
  const uiaFeed = windowResult?.feedAutomationId === "sns_list"
    && windowResult?.feedCount === 1
    && Boolean(String(windowResult?.feedRuntimeId ?? "").trim());
  if (identityMode === "automation_id") return automationId === "SNSWindow" && uiaFeed;
  if (identityMode === "structural_sns_feed") return automationId === "" && uiaFeed;
  const windowBounds = {
    left: Number(windowResult?.left),
    top: Number(windowResult?.top),
    width: Number(windowResult?.width),
    height: Number(windowResult?.height)
  };
  return identityMode === "visual_mmui_render"
    && automationId === ""
    && windowResult?.feedAutomationId === ""
    && windowResult?.feedRuntimeId === ""
    && windowResult?.feedCount === 0
    && windowResult?.renderPaneName === "MMUIRenderSubWindowHW"
    && typeof windowResult?.renderPaneAutomationId === "string"
    && windowResult?.renderPaneControlType === "ControlType.Pane"
    && Number(windowResult?.renderPaneProcessId) === Number(windowResult?.pid)
    && Boolean(String(windowResult?.renderPaneRuntimeId ?? "").trim())
    && boundsWithin(windowResult?.renderPaneBounds, windowBounds);
}

function visualMomentsPostSnapshot(windowResult, verifiedWindow, options = {}) {
  const posts = Array.isArray(windowResult?.posts) ? windowResult.posts : [];
  if (posts.length === 0) {
    const readingPosts = Array.isArray(windowResult?.readingPosts) ? windowResult.readingPosts : [];
    if (options.allowBodyOnly === true && readingPosts.length > 0) {
      const renderPaneBounds = windowResult?.renderPaneBounds;
      const validReadingPosts = readingPosts.filter((post) => {
        const identityText = String(post?.identityText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
        const stableAnchorText = String(post?.stableAnchorText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
        return post?.bodyOnly === true
          && post?.structureVerified === true
          && identityText.length >= 16
          && identityText.length <= 2000
          && stableAnchorText.length >= 16
          && stableAnchorText.length <= 2000
          && [post?.regionHash, post?.avatarHash, post?.layoutHash]
            .every((value) => /^[0-9a-f]{64}$/u.test(String(value ?? "")))
          && boundsWithin(post?.bounds, renderPaneBounds)
          && boundsWithin(post?.avatarBounds, renderPaneBounds);
      });
      const post = preferredVisibleMomentsPost(validReadingPosts, renderPaneBounds, options.targetPost);
      if (post) {
        const label = String(post.text).normalize("NFKC").replace(/\s+/gu, " ").trim();
        const identityText = String(post.identityText).normalize("NFKC").replace(/\s+/gu, " ").trim();
        const stableAnchorText = String(post.stableAnchorText).normalize("NFKC").replace(/\s+/gu, " ").trim();
        const postFingerprint = momentsPostFingerprint(identityText);
        const bounds = post.bounds;
        const avatarBounds = post.avatarBounds;
        const observationPayload = JSON.stringify({
          version: 7,
          surfaceMode: String(windowResult.surfaceMode ?? ""),
          pid: Number(windowResult.pid),
          hWnd: String(windowResult.hWnd),
          source: "visual:windows_media_ocr_body",
          structureVerified: true,
          regionHash: String(post.regionHash),
          avatarHash: String(post.avatarHash),
          layoutHash: String(post.layoutHash),
          identityText,
          stableAnchorText,
          postFingerprint,
          bounds,
          avatarBounds
        });
        return {
          ok: true,
          visiblePostCount: validReadingPosts.length,
          partialVisible: true,
          diagnostics: {
            candidate_count: readingPosts.length,
            accepted_count: validReadingPosts.length,
            position_zone: "body_only"
          },
          snapshot: {
            observation_id: crypto.createHash("sha256").update(observationPayload, "utf8").digest("hex"),
            post_fingerprint: postFingerprint,
            source: "visual:windows_media_ocr_body",
            identity_scope: "window_session_only",
            structure_verified: true,
            ocr_provider: "windows_media_ocr",
            ocr_language: "zh-Hans-CN",
            region_hash: String(post.regionHash),
            avatar_hash: String(post.avatarHash),
            layout_hash: String(post.layoutHash),
            label,
            identity_text: identityText,
            stable_anchor_text: stableAnchorText,
            preview: label.length > 160 ? `${label.slice(0, 157)}...` : label,
            bounds,
            avatar_bounds: avatarBounds,
            body_only: true,
            like_state: "unknown",
            comment_state: "unknown"
          }
        };
      }
      if (options.targetPost) {
        return {
          ok: false,
          reason: "moments_post_not_found",
          error: MOMENTS_BLOCK_ERRORS.moments_post_not_found,
          diagnostics: {
            candidate_count: readingPosts.length,
            accepted_count: validReadingPosts.length,
            target_locked: true,
            target_matched_count: 0
          }
        };
      }
    }
    const menuOnlyMenus = Array.isArray(windowResult?.menuOnlyMenus) ? windowResult.menuOnlyMenus : [];
    if (options.targetPost || options.allowMenuOnly !== true || menuOnlyMenus.length === 0) {
      return { ok: false, reason: "moments_post_not_found", error: MOMENTS_BLOCK_ERRORS.moments_post_not_found };
    }
    const menuOnly = [...menuOnlyMenus]
      .filter((entry) => /^[0-9a-f]{64}$/u.test(String(entry?.menuHash ?? "")))
      .sort((left, right) => Number(right?.menuBounds?.top) - Number(left?.menuBounds?.top))[0];
    const menuBounds = menuOnly?.menuBounds;
    const windowBounds = {
      left: verifiedWindow.left,
      top: verifiedWindow.top,
      width: verifiedWindow.width,
      height: verifiedWindow.height
    };
    if (!menuOnly || !boundsWithin(windowResult?.renderPaneBounds, windowBounds)
      || !boundsWithin(menuBounds, windowResult?.renderPaneBounds)) {
      return { ok: false, reason: "moments_post_identity_missing", error: MOMENTS_BLOCK_ERRORS.moments_post_identity_missing };
    }
    const menuHash = String(menuOnly.menuHash);
    const identityText = `visible-menu:${menuHash}:${Math.round(Number(menuBounds.left))}:${Math.round(Number(menuBounds.top))}`;
    const label = identityText;
    const postFingerprint = momentsPostFingerprint(identityText);
    const layoutHash = crypto.createHash("sha256").update(`menu-only-layout:${menuHash}`, "utf8").digest("hex");
    const avatarBounds = { left: 0, top: 0, width: 0, height: 0 };
    const observationPayload = JSON.stringify({
      version: 6,
      surfaceMode: String(windowResult.surfaceMode ?? ""),
      className: String(windowResult.className ?? ""),
      pid: Number(windowResult.pid),
      hWnd: String(windowResult.hWnd),
      windowBounds,
      windowAutomationId: String(windowResult.automationId ?? ""),
      windowIdentityMode: String(windowResult.identityMode ?? ""),
      windowRootName: String(windowResult.rootName ?? ""),
      windowRootControlType: String(windowResult.rootControlType ?? ""),
      windowRootProcessId: Number(windowResult.rootProcessId),
      windowFeedAutomationId: String(windowResult.feedAutomationId ?? ""),
      windowFeedRuntimeId: String(windowResult.feedRuntimeId ?? ""),
      windowFeedCount: Number(windowResult.feedCount),
      windowRenderPaneName: String(windowResult.renderPaneName ?? ""),
      windowRenderPaneAutomationId: String(windowResult.renderPaneAutomationId ?? ""),
      windowRenderPaneControlType: String(windowResult.renderPaneControlType ?? ""),
      windowRenderPaneProcessId: Number(windowResult.renderPaneProcessId),
      windowRenderPaneRuntimeId: String(windowResult.renderPaneRuntimeId ?? ""),
      windowRenderPaneBounds: {
        left: Number(windowResult.renderPaneBounds?.left),
        top: Number(windowResult.renderPaneBounds?.top),
        width: Number(windowResult.renderPaneBounds?.width),
        height: Number(windowResult.renderPaneBounds?.height)
      },
      source: "visual:windows_media_ocr",
      identityScope: "window_session_only",
      structureVerified: true,
      ocrProvider: "windows_media_ocr",
      ocrLanguage: "zh-Hans-CN",
      regionHash: menuHash,
      avatarHash: "",
      layoutHash,
      label,
      identityText,
      postFingerprint,
      bounds: menuBounds,
      menuBounds,
      avatarBounds
    });
    return {
      ok: true,
      visiblePostCount: 1,
      partialVisible: false,
      diagnostics: { candidate_count: 1, accepted_count: 1, position_zone: "menu_only" },
      snapshot: {
        observation_id: crypto.createHash("sha256").update(observationPayload, "utf8").digest("hex"),
        post_fingerprint: postFingerprint,
        source: "visual:windows_media_ocr",
        identity_scope: "window_session_only",
        structure_verified: true,
        ocr_provider: "windows_media_ocr",
        ocr_language: "zh-Hans-CN",
        region_hash: menuHash,
        menu_hash: menuHash,
        avatar_hash: "",
        layout_hash: layoutHash,
        label,
        identity_text: identityText,
        stable_anchor_text: "",
        preview: "可见朋友圈互动菜单",
        bounds: menuBounds,
        menu_bounds: menuBounds,
        avatar_bounds: avatarBounds,
        menu_only: true,
        like_state: "unknown",
        comment_state: "unknown"
      }
    };
  }
  const renderPaneBounds = windowResult?.renderPaneBounds;
  const selectedPost = options.selectedPost;
  const selection = selectedPost
    ? {
        ok: posts.includes(selectedPost),
        post: selectedPost,
        partialVisible: selectedPost?.partialVisible === true,
        acceptedCount: posts.length,
        diagnostics: {
          candidate_count: posts.length,
          accepted_count: posts.length,
          position_zone: selectedPost?.partialVisible === true ? "top_edge_anchor_complete" : "full"
        }
      }
    : selectVisibleMomentsPost(posts, renderPaneBounds, options.targetPost);
  if (!selection.ok) return { ok: false, reason: selection.reason, error: MOMENTS_BLOCK_ERRORS[selection.reason], diagnostics: selection.diagnostics };
  const post = selection.post;
  const interactionOnly = post.interactionOnly === true;
  const source = interactionOnly ? "visual:interaction_anchor" : "visual:windows_media_ocr";
  const label = interactionOnly
    ? "visible moments interaction anchor"
    : String(post.text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const identityText = String(post.identityText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const stableAnchorText = String(post.stableAnchorText ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const postFingerprint = momentsPostFingerprint(identityText);
  const regionHash = String(post.regionHash ?? "").trim();
  const avatarHash = String(post.avatarHash ?? "").trim();
  const layoutHash = String(post.layoutHash ?? "").trim();
  const menuHash = String(post.menuHash ?? regionHash).trim();
  const bounds = post.bounds;
  const menuBounds = post.menuBounds;
  const avatarBounds = post.avatarBounds;
  const windowBounds = {
    left: verifiedWindow.left,
    top: verifiedWindow.top,
    width: verifiedWindow.width,
    height: verifiedWindow.height
  };
  if (!label || label.length > 2000 || !identityText || identityText.length > 2000 || stableAnchorText.length > 2000 || !postFingerprint || !/^[0-9a-f]{64}$/u.test(regionHash)
    || !/^[0-9a-f]{64}$/u.test(avatarHash) || !/^[0-9a-f]{64}$/u.test(layoutHash) || post.structureVerified !== true
    || !boundsWithin(renderPaneBounds, windowBounds) || !boundsWithin(bounds, renderPaneBounds)
    || !boundsWithin(menuBounds, renderPaneBounds) || !boundsWithin(avatarBounds, renderPaneBounds)) {
    return { ok: false, reason: "moments_post_identity_missing", error: MOMENTS_BLOCK_ERRORS.moments_post_identity_missing };
  }
  const observationPayload = JSON.stringify({
    version: interactionOnly ? 7 : 6,
    surfaceMode: String(windowResult.surfaceMode ?? ""),
    className: String(windowResult.className ?? ""),
    pid: Number(windowResult.pid),
    hWnd: String(windowResult.hWnd),
    windowBounds,
    windowAutomationId: String(windowResult.automationId ?? ""),
    windowIdentityMode: String(windowResult.identityMode ?? ""),
    windowRootName: String(windowResult.rootName ?? ""),
    windowRootControlType: String(windowResult.rootControlType ?? ""),
    windowRootProcessId: Number(windowResult.rootProcessId),
    windowFeedAutomationId: String(windowResult.feedAutomationId ?? ""),
    windowFeedRuntimeId: String(windowResult.feedRuntimeId ?? ""),
    windowFeedCount: Number(windowResult.feedCount),
    windowRenderPaneName: String(windowResult.renderPaneName ?? ""),
    windowRenderPaneAutomationId: String(windowResult.renderPaneAutomationId ?? ""),
    windowRenderPaneControlType: String(windowResult.renderPaneControlType ?? ""),
    windowRenderPaneProcessId: Number(windowResult.renderPaneProcessId),
    windowRenderPaneRuntimeId: String(windowResult.renderPaneRuntimeId ?? ""),
    windowRenderPaneBounds: {
      left: Number(windowResult.renderPaneBounds?.left),
      top: Number(windowResult.renderPaneBounds?.top),
      width: Number(windowResult.renderPaneBounds?.width),
      height: Number(windowResult.renderPaneBounds?.height)
    },
    source,
    identityScope: "window_session_only",
    structureVerified: true,
    ocrProvider: interactionOnly ? "" : "windows_media_ocr",
    ocrLanguage: interactionOnly ? "" : "zh-Hans-CN",
    regionHash,
    avatarHash,
    layoutHash,
    ...(interactionOnly ? { menuHash } : {}),
    label,
    identityText,
    ...(stableAnchorText ? { stableAnchorText } : {}),
    postFingerprint,
    bounds: {
      left: Number(bounds.left),
      top: Number(bounds.top),
      width: Number(bounds.width),
      height: Number(bounds.height)
    },
    menuBounds: {
      left: Number(menuBounds.left),
      top: Number(menuBounds.top),
      width: Number(menuBounds.width),
      height: Number(menuBounds.height)
    },
    avatarBounds: {
      left: Number(avatarBounds.left),
      top: Number(avatarBounds.top),
      width: Number(avatarBounds.width),
      height: Number(avatarBounds.height)
    }
  });
  return {
    ok: true,
    visiblePostCount: selection.acceptedCount,
    partialVisible: selection.partialVisible,
    diagnostics: selection.diagnostics,
    snapshot: {
      observation_id: crypto.createHash("sha256").update(observationPayload, "utf8").digest("hex"),
      post_fingerprint: postFingerprint,
      source,
      identity_scope: "window_session_only",
      structure_verified: true,
      ocr_provider: interactionOnly ? "" : "windows_media_ocr",
      ocr_language: interactionOnly ? "" : "zh-Hans-CN",
      region_hash: regionHash,
      avatar_hash: avatarHash,
      layout_hash: layoutHash,
      ...(interactionOnly ? { menu_hash: menuHash, interaction_only: true } : {}),
      label,
      identity_text: identityText,
      stable_anchor_text: stableAnchorText,
      preview: interactionOnly ? "可见朋友圈互动菜单" : (label.length > 160 ? `${label.slice(0, 157)}...` : label),
      bounds,
      menu_bounds: menuBounds,
      avatar_bounds: avatarBounds,
      like_state: "unknown",
      comment_state: "unknown"
    }
  };
}

function momentsPostSnapshot(windowResult, verifiedWindow, options = {}) {
  if (windowResult?.identityMode === "visual_mmui_render") {
    return visualMomentsPostSnapshot(windowResult, verifiedWindow, options);
  }
  const posts = Array.isArray(windowResult?.posts) ? windowResult.posts : [];
  if (posts.length === 0) return { ok: false, reason: "moments_post_not_found", error: MOMENTS_BLOCK_ERRORS.moments_post_not_found };
  const selection = selectVisibleMomentsPost(posts, verifiedWindow, options.targetPost);
  if (!selection.ok) return { ok: false, reason: selection.reason, error: MOMENTS_BLOCK_ERRORS[selection.reason], diagnostics: selection.diagnostics };
  const post = selection.post;
  const runtimeId = String(post.runtimeId ?? "").trim();
  const automationId = String(post.automationId ?? "").trim();
  const feedDepth = Number(post.feedDepth);
  const validStructure = post.structureVerified === true && Number.isInteger(feedDepth) && feedDepth >= 1 && feedDepth <= 16;
  const label = String(post.text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const postFingerprint = momentsPostFingerprint(label);
  const bounds = {
    left: Number(post.left),
    top: Number(post.top),
    width: Number(post.width),
    height: Number(post.height)
  };
  const validBounds = Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
  if (!verifiedWindow || !runtimeId || !validStructure || !label || !postFingerprint || label.length > 2000 || !validBounds) {
    return { ok: false, reason: "moments_post_identity_missing", error: MOMENTS_BLOCK_ERRORS.moments_post_identity_missing };
  }

  const observationPayload = JSON.stringify({
    version: 2,
    pid: verifiedWindow.pid,
    hWnd: verifiedWindow.hWnd,
    windowBounds: {
      left: verifiedWindow.left,
      top: verifiedWindow.top,
      width: verifiedWindow.width,
      height: verifiedWindow.height
    },
    windowAutomationId: String(windowResult.automationId ?? ""),
    windowIdentityMode: String(windowResult.identityMode ?? ""),
    windowRootName: String(windowResult.rootName ?? ""),
    windowRootControlType: String(windowResult.rootControlType ?? ""),
    windowRootProcessId: Number(windowResult.rootProcessId),
    windowFeedAutomationId: String(windowResult.feedAutomationId ?? ""),
    windowFeedRuntimeId: String(windowResult.feedRuntimeId ?? ""),
    windowFeedCount: Number(windowResult.feedCount),
    runtimeId,
    automationId,
    feedDepth,
    label,
    postFingerprint,
    bounds
  });
  return {
    ok: true,
    visiblePostCount: selection.acceptedCount,
    partialVisible: selection.partialVisible,
    diagnostics: selection.diagnostics,
    snapshot: {
      observation_id: crypto.createHash("sha256").update(observationPayload, "utf8").digest("hex"),
      post_fingerprint: postFingerprint,
      source: "uia:sns_list",
      identity_scope: "window_session_only",
      runtime_id: runtimeId,
      automation_id: automationId,
      structure_verified: true,
      feed_depth: feedDepth,
      label,
      preview: label.length > 160 ? `${label.slice(0, 157)}...` : label,
      bounds,
      like_state: "unknown",
      comment_state: "unknown"
    }
  };
}

function momentsDryRunBlock(baseDir, state, reason, error, plan = {}, diagnostics = undefined) {
  const nextState = {
    ...state,
    moments_dry_run: {
      ...plan,
      status: "blocked",
      blocked_reason: reason,
      prepared_at: new Date().toISOString()
    }
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "朋友圈安全预演", error);
  return {
    ok: false,
    action: "moments-dry-run",
    blocked_reason: reason,
    dry_run: true,
    error,
    real_action_attempted: false,
    ...(diagnostics && typeof diagnostics === "object" ? { diagnostics } : {})
  };
}

function prepareMomentsDryRun(baseDir = __dirname, payload = {}, driver = probeWechatMomentsWindow) {
  const state = loadState(baseDir);
  const mode = String(payload.mode ?? "").trim();
  const likeEnabled = payload.likeEnabled === true;
  const commentEnabled = payload.commentEnabled === true;
  const commentText = commentEnabled ? String(payload.commentText ?? "").trim() : "";
  const commentIntentOnly = commentEnabled && payload.commentIntentOnly === true && !commentText;
  const plan = {
    mode,
    like_enabled: likeEnabled,
    comment_enabled: commentEnabled,
    comment_intent_only: commentIntentOnly,
    comment_text: commentText,
    target_verified: false
  };

  if (!likeEnabled && !commentEnabled) return momentsDryRunBlock(baseDir, state, "moments_action_missing", MOMENTS_BLOCK_ERRORS.moments_action_missing, plan);
  if (!["targeted", "random"].includes(mode)) return momentsDryRunBlock(baseDir, state, "moments_mode_invalid", MOMENTS_BLOCK_ERRORS.moments_mode_invalid, plan);
  if (commentEnabled && !commentIntentOnly && !commentText) return momentsDryRunBlock(baseDir, state, "moments_comment_missing", MOMENTS_BLOCK_ERRORS.moments_comment_missing, plan);
  if (commentText.length > MAX_MOMENTS_COMMENT_LENGTH) return momentsDryRunBlock(baseDir, state, "moments_comment_too_long", `评论文案不能超过 ${MAX_MOMENTS_COMMENT_LENGTH} 个字符`, plan);

  const targetPostRequired = payload.targetPostRequired === true
    || Object.prototype.hasOwnProperty.call(payload, "targetPost");
  const targetPost = normalizeMomentsTargetPost(payload.targetPost);
  if (targetPostRequired && !targetPost) {
    return momentsDryRunBlock(baseDir, state, "moments_post_identity_missing", MOMENTS_BLOCK_ERRORS.moments_post_identity_missing, plan);
  }

  const expectedWindowRequired = payload.expectedWindowRequired === true
    || Object.prototype.hasOwnProperty.call(payload, "expectedWindow");
  const expectedSurface = normalizeExpectedMomentsSurface(payload.expectedWindow);
  if (expectedWindowRequired && !expectedSurface) {
    return momentsDryRunBlock(
      baseDir,
      state,
      "moments_window_identity_mismatch",
      MOMENTS_BLOCK_ERRORS.moments_window_identity_mismatch,
      plan
    );
  }
  const visualProbeOptions = {
    allowBodyOnly: payload.allowBodyOnly === true,
    interactionOnly: likeEnabled && !commentEnabled && !targetPost
  };
  let windowResult = driver === probeWechatMomentsWindow && expectedSurface?.surfaceMode === "integrated"
    ? probeVisualWechatMomentsWindow(expectedSurface, visualProbeOptions)
    : driver(expectedSurface);
  if (
    driver === probeWechatMomentsWindow
    && windowResult?.ok === false
    && ["moments_feed_not_found", "moments_window_not_found", "powershell_timeout"].includes(windowResult?.reason)
  ) {
    windowResult = probeVisualWechatMomentsWindow(expectedSurface, visualProbeOptions);
  }
  if (!windowResult?.ok) {
    const reason = windowResult?.reason || "moments_probe_failed";
    const error = MOMENTS_BLOCK_ERRORS[reason] || "朋友圈窗口检查执行失败，请稍后重试";
    const safeDiagnostics = windowResult?.diagnostics && typeof windowResult.diagnostics === "object"
      ? { visual_diagnostics: windowResult.diagnostics }
      : {};
    const blocked = momentsDryRunBlock(baseDir, state, reason, error, { ...plan, ...safeDiagnostics });
    const provenSurface = reason === "moments_post_not_found" ? windowResult?.surface : null;
    const provenWindow = validMomentsWindowIdentity(provenSurface)
      && momentsSurfaceMatchesExpected(provenSurface, expectedSurface)
      ? normalizeMomentsWindow(provenSurface)
      : null;
    return provenWindow
      ? { ...blocked, window: momentsWindowSnapshot(provenSurface, provenWindow) }
      : blocked;
  }
  const windowVerified = validMomentsWindowIdentity(windowResult);
  const verifiedWindow = normalizeMomentsWindow(windowResult);
  if (!windowVerified || !verifiedWindow) return momentsDryRunBlock(baseDir, state, "moments_window_identity_mismatch", MOMENTS_BLOCK_ERRORS.moments_window_identity_mismatch, plan);
  if (!momentsSurfaceMatchesExpected(windowResult, expectedSurface)) {
    return momentsDryRunBlock(baseDir, state, "moments_window_identity_mismatch", MOMENTS_BLOCK_ERRORS.moments_window_identity_mismatch, plan);
  }
  const window = momentsWindowSnapshot(windowResult, verifiedWindow);
  const snapshotOptions = {
    // A generic three-dot crop is not a post identity. It may be reused for
    // read-only diagnostics, but it must never authorize a real Like.
    allowMenuOnly: false,
    allowBodyOnly: payload.allowBodyOnly === true,
    targetPost
  };
  const interactionCandidates = windowResult.identityMode === "visual_mmui_render"
    && likeEnabled
    && !commentEnabled
    && !targetPost
    && Array.isArray(windowResult.posts)
    && windowResult.posts.every((post) => post?.interactionOnly === true)
    ? (Array.isArray(windowResult.posts) ? windowResult.posts : [])
    : [];
  const interactionResults = interactionCandidates
    .map((selectedPost) => momentsPostSnapshot(windowResult, verifiedWindow, { ...snapshotOptions, selectedPost }))
    .filter((result) => result.ok)
    .sort((left, right) => Number(right.snapshot?.menu_bounds?.top) - Number(left.snapshot?.menu_bounds?.top));
  const snapshotResult = interactionResults[0]
    ?? momentsPostSnapshot(windowResult, verifiedWindow, snapshotOptions);
  if (!snapshotResult.ok) {
    return {
      ...momentsDryRunBlock(baseDir, state, snapshotResult.reason, snapshotResult.error, { ...plan, position_diagnostics: snapshotResult.diagnostics }, snapshotResult.diagnostics),
      window
    };
  }
  const postSnapshot = snapshotResult.snapshot;
  const postSnapshots = interactionResults.length > 0
    ? interactionResults.map((result) => result.snapshot)
    : [postSnapshot];
  const visiblePostCount = snapshotResult.visiblePostCount;

  const configuredOrder = mode === "targeted" ? ["comment", "like"] : ["like", "comment"];
  const actionOrder = configuredOrder.filter((action) => action === "like" ? likeEnabled : commentEnabled);
  const preparedPlan = {
    ...plan,
    action_order: actionOrder,
    visible_post_count: visiblePostCount,
    target_partial_visible: snapshotResult.partialVisible === true,
    position_diagnostics: snapshotResult.diagnostics,
    verification_level: windowResult.identityMode === "visual_mmui_render" ? "visual_post_snapshot_only" : "post_snapshot_only"
  };
  const nextState = {
    ...state,
    moments_dry_run: {
      ...preparedPlan,
      post_snapshot: postSnapshot,
      post_snapshots: postSnapshots,
      status: "prepared",
      prepared_at: new Date().toISOString(),
      window
    }
  };
  saveState(baseDir, nextState);
  appendLog(baseDir, "朋友圈安全预演", `已从 ${visiblePostCount} 条具有稳定锚点的可见内容中锁定一条；动作顺序：${actionOrder.join(" -> ")}；未执行真实点赞或评论`);
  return {
    ok: true,
    action: "moments-dry-run",
    dry_run: true,
    plan: preparedPlan,
    post_snapshot: postSnapshot,
    post_snapshots: postSnapshots,
    real_action_attempted: false,
    diagnostics: {
      ...snapshotResult.diagnostics,
      ...(windowResult?.diagnostics ? { visual: windowResult.diagnostics } : {})
    },
    window
  };
}

module.exports = {
  MAX_MOMENTS_COMMENT_LENGTH,
  momentsPostIdentityPrefix,
  momentsPostFingerprint,
  momentsPostDisplacementMatches,
  momentsPostTextOverlap,
  prepareMomentsDryRun,
  preferredVisibleMomentsPost,
  probeWechatMomentsWindow,
  stableMomentsContentSimilarity,
  stableMomentsPostIdentityText,
  momentsCommentTextContainsPrevious,
  stableMomentsPostLabel
};
