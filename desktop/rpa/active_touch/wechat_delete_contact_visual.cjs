// Deleting a friend by looking at the screen, for a WeChat that gives no UI Automation tree (user 2026-11-26:
// b070e34b, 4.2.0.52 on a 200% laptop, showed only its outer window, so the UIA steps in wechat_delete_contact.cjs
// found nothing; touch kept working there because it reads the screen). Same path as the UIA steps, read the way
// touch reads: screen copy (wechat_screen_pixels.cjs) and Windows OCR (wechat_screen_ocr.cjs).
//
// prepare: the open chat (opened and title-checked by the caller with touch's own search) → its "…" (聊天信息) →
// the one member left of 添加 → profile card: the name, and the 微信号 when the list has one → the card's "…" →
// 删除联系人 → the confirm naming this person. Nothing is deleted. commit: the same confirm read again, its 删除
// pressed, then the card and the confirm must be gone. Every press first checks nobody else used the mouse or
// keyboard since our own last input. Anything that does not match closes what we opened (WM_CLOSE, never Esc:
// Esc hides WeChat 4) and stops.
//
// 1.3.76 (b070e34b field run on 1.3.75, user: "我们的AI呢？"): Windows' OCR joined a label with its neighbour into one
// line (the member's name and 添加 read as "钱总一添加") and cannot read emoji in a name (秋🌸花姐 in the confirm), and
// every whole-line comparison then missed. Labels are now found by their own characters inside a line (Find-Label),
// names are compared by their letters and digits only (Core), and when the screen still cannot be read the picture
// goes to the same vision model touch uses (Ask-Eyes → wechat-vision-check.cjs deleteStep). The model only lists what
// it sees; the code picks the one element and every identity check stays as it is.
const { WECHAT_SCREEN_PIXELS_POWERSHELL } = require("./wechat_screen_pixels.cjs");
const { WECHAT_SCREEN_OCR_POWERSHELL } = require("./wechat_screen_ocr.cjs");

const VISUAL_DELETE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${WECHAT_SCREEN_PIXELS_POWERSHELL}
${WECHAT_SCREEN_OCR_POWERSHELL}
if (-not ("XiaoxiVisualDelete" -as [type])) {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
public static class XiaoxiVisualDelete {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  // Which process owns the top-level window under a screen point.
  public static uint OwnerAt(int x, int y) { var p = new POINT { X = x, Y = y }; IntPtr root = GetAncestor(WindowFromPoint(p), 2); uint pid; GetWindowThreadProcessId(root, out pid); return pid; }
  public static uint LastInput() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
    if (Environment.GetEnvironmentVariable("XIAOXI_UNATTENDED_INPUT") == "1") return 1u; return GetLastInputInfo(ref i) ? i.dwTime : UInt32.MaxValue; }
  public static List<long> Windows(uint pid) {
    var list = new List<long>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return list;
  }
  // Every "…" (three small dark dots in a row, equal size and spacing) in a region of a bitmap, as centres.
  public static List<int[]> Dots(Bitmap b, int left, int top, int width, int height) {
    int right = Math.Min(b.Width, left + width), bottom = Math.Min(b.Height, top + height);
    left = Math.Max(0, left); top = Math.Max(0, top);
    var seen = new bool[b.Width, b.Height];
    var blobs = new List<int[]>();
    for (int y = top; y < bottom; y++) for (int x = left; x < right; x++) {
      if (seen[x, y] || !Dark(b.GetPixel(x, y))) continue;
      int minX = x, maxX = x, minY = y, maxY = y, count = 0;
      var stack = new Stack<Point>(); stack.Push(new Point(x, y)); seen[x, y] = true;
      while (stack.Count > 0 && count < 400) {
        var p = stack.Pop(); count++;
        minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X); minY = Math.Min(minY, p.Y); maxY = Math.Max(maxY, p.Y);
        foreach (var q in new[] { new Point(p.X + 1, p.Y), new Point(p.X - 1, p.Y), new Point(p.X, p.Y + 1), new Point(p.X, p.Y - 1) })
          if (q.X >= left && q.X < right && q.Y >= top && q.Y < bottom && !seen[q.X, q.Y] && Dark(b.GetPixel(q.X, q.Y))) { seen[q.X, q.Y] = true; stack.Push(q); }
      }
      int w = maxX - minX + 1, h = maxY - minY + 1;
      if (w >= 2 && h >= 2 && w <= 9 && h <= 9 && Math.Abs(w - h) <= 2) blobs.Add(new[] { (minX + maxX) / 2, (minY + maxY) / 2, w });
    }
    blobs.Sort((a, c) => a[0].CompareTo(c[0]));
    var found = new List<int[]>();
    for (int i = 0; i < blobs.Count; i++) for (int j = i + 1; j < blobs.Count; j++) {
      int gap = blobs[j][0] - blobs[i][0];
      if (gap < blobs[i][2] + 1 || gap > blobs[i][2] * 4 + 4 || Math.Abs(blobs[j][1] - blobs[i][1]) > 1) continue;
      for (int k = j + 1; k < blobs.Count; k++) {
        if (Math.Abs(blobs[k][0] - blobs[j][0] - gap) > 1 || Math.Abs(blobs[k][1] - blobs[i][1]) > 1) continue;
        if (Math.Abs(blobs[k][2] - blobs[i][2]) > 1 || Math.Abs(blobs[j][2] - blobs[i][2]) > 1) continue;
        found.Add(new[] { blobs[j][0], blobs[j][1] });
      }
    }
    return found;
  }
  // The block (an avatar) nearest left of x0 in rows top..bottom: columns holding non-background pixels, grouped.
  public static int[] BlockLeftOf(Bitmap b, int x0, int top, int bottom) {
    Color bg = b.GetPixel(Math.Max(0, x0 - 2), Math.Max(0, top));
    int right = -1, left = -1;
    for (int x = Math.Min(b.Width - 1, x0 - 4); x >= 0; x--) {
      bool ink = false;
      for (int y = Math.Max(0, top); y <= Math.Min(b.Height - 1, bottom); y++) { Color c = b.GetPixel(x, y); if (Math.Abs(c.R - bg.R) + Math.Abs(c.G - bg.G) + Math.Abs(c.B - bg.B) > 60) { ink = true; break; } }
      if (ink && right < 0) right = x;
      if (!ink && right >= 0) { left = x + 1; break; }
    }
    if (right < 0 || left < 0) return null;
    int t = -1, bm = -1;
    for (int y = Math.Max(0, top); y <= Math.Min(b.Height - 1, bottom); y++) {
      bool ink = false;
      for (int x = left; x <= right; x++) { Color c = b.GetPixel(x, y); if (Math.Abs(c.R - bg.R) + Math.Abs(c.G - bg.G) + Math.Abs(c.B - bg.B) > 60) { ink = true; break; } }
      if (ink) { if (t < 0) t = y; bm = y; }
    }
    return t < 0 ? null : new[] { left, t, right, bm };
  }
  static bool Dark(Color c) { return c.R < 140 && c.G < 140 && c.B < 140 && Math.Abs(c.R - c.G) < 30 && Math.Abs(c.G - c.B) < 30; }
}
"@
}
[void][XiaoxiVisualDelete]::SetProcessDPIAware()
$phase = [string]$env:XIAOXI_VDEL_PHASE
$name = [string]$env:XIAOXI_DELETE_NAME
$wechatId = [string]$env:XIAOXI_DELETE_WECHAT_ID
$uniqueName = $env:XIAOXI_DELETE_UNIQUE_NAME -eq "1"
# The chat title could not be confirmed: only an exactly matching 微信号 on the card lets the delete go on.
$requireId = $env:XIAOXI_DELETE_REQUIRE_ID -eq "1"
$confirm = $env:XIAOXI_DELETE_CONFIRM -eq "1"
$mainHwnd = [int64]$env:XIAOXI_EXPECTED_HWND
$pid0 = [uint32]$env:XIAOXI_EXPECTED_PID
$engine = Initialize-XiaoxiOcr
function Out-Result($ok, $stage, $reason, $extra = @{}) {
  $result = @{ ok = [bool]$ok; stage = [string]$stage; reason = [string]$reason; visual = $true }
  # Every stop on commit before the press: 删除 was certainly not pressed, so it may be tried again.
  if (-not $ok -and $phase -eq "commit" -and -not $script:pressedCommit -and -not $extra.outcomeUnknown) { $result.notClicked = $true }
  foreach ($key in $extra.Keys) { $result[$key] = $extra[$key] }
  if (@($script:eyes).Count) { $result.eyes = @($script:eyes) }
  $result | ConvertTo-Json -Compress -Depth 5
  exit 0
}

# Windows' OCR misreads small gray text by a character or two (查找聊天内容 → 亘找孽天内容): a label counts when
# all but a couple of its characters are there, in order.
function Like([string]$text, [string]$target, [int]$slack = 2) {
  # A label, not a sentence: chat messages that mention these words are longer than the label.
  if ($text.Length -gt $target.Length + 2) { return $false }
  $i = 0; $hit = 0
  foreach ($ch in $target.ToCharArray()) { $j = $text.IndexOf($ch, $i); if ($j -ge 0) { $hit++; $i = $j + 1 } }
  return $hit -ge [Math]::Max(2, $target.Length - $slack)
}
function Fold([string]$text) { ([string]$text).Normalize([Text.NormalizationForm]::FormKC) -replace '[\s​-‏﻿]', '' }
$plainName = Fold ($name -replace '\[[^\[\]]{1,12}\]', '')
# A name by its letters and digits: OCR cannot read emoji or symbols (秋🌸花姐 read without the flower), so both sides
# drop them before comparing. A name with fewer than two such characters is never confirmed by its text alone.
function Core([string]$text) { (Fold ($text -replace '\[[^\[\]]{1,12}\]', '')) -replace '[^\p{L}\p{N}]', '' }
$coreName = Core $name
function Rect([int64]$h) { $r = New-Object XiaoxiVisualDelete+RECT; [void][XiaoxiVisualDelete]::GetWindowRect([IntPtr]$h, [ref]$r); $r }
# OCR lines of a screen rectangle, in screen coordinates: @{ text; left; top; right; bottom; x; y }.
function Read-Lines([int]$left, [int]$top, [int]$width, [int]$height, [int]$scale = 3) {
  if ($width -lt 8 -or $height -lt 8) { return @() }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $big = $null
  try {
    if (-not [XiaoxiScreenPixels]::Copy($bitmap, $left, $top)) { return @() }
    $big = New-Object System.Drawing.Bitmap ($width * $scale), ($height * $scale)
    $g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bitmap, 0, 0, $width * $scale, $height * $scale); $g.Dispose()
    $ocr = Read-SearchOcrBitmap $big $engine
    @($ocr.Lines | ForEach-Object {
      $words = @($_.Words); if (-not $words.Count) { return }
      $l = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum / $scale + $left
      $t = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum / $scale + $top
      $r = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum / $scale + $left
      $b = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum / $scale + $top
      $parts = @($words | ForEach-Object { $box = $_.BoundingRect; @{ t = (Fold $_.Text); l = $box.X / $scale + $left; r = ($box.X + $box.Width) / $scale + $left;
        top = $box.Y / $scale + $top; b = ($box.Y + $box.Height) / $scale + $top } })
      @{ text = (Fold (($words | ForEach-Object { $_.Text }) -join "")); left = $l; top = $t; right = $r; bottom = $b; x = ($l + $r) / 2; y = ($t + $b) / 2; words = $parts }
    })
  } finally { $bitmap.Dispose(); if ($big) { $big.Dispose() } }
}
function Find-Dots([int]$left, [int]$top, [int]$width, [int]$height) {
  $bitmap = New-Object System.Drawing.Bitmap ([Math]::Max(1, $width)), ([Math]::Max(1, $height))
  try {
    if (-not [XiaoxiScreenPixels]::Copy($bitmap, $left, $top)) { return @() }
    # Only dots on WeChat itself: a card's window includes a see-through shadow, and dots behind it belong to
    # another program (dev machine 2026-11-26: a terminal's "…" behind the card's shadow).
    @([XiaoxiVisualDelete]::Dots($bitmap, 0, 0, $width, $height) | ForEach-Object { @{ x = $_[0] + $left; y = $_[1] + $top } } |
      Where-Object { [XiaoxiVisualDelete]::OwnerAt([int]$_.x, [int]$_.y) -eq $pid0 })
  } finally { $bitmap.Dispose() }
}
# A label by its own characters inside an OCR line, at its own place: Windows' OCR joins a label with its neighbour
# (b070e34b, 2026-11-26: "钱总一添加" for the member's name and 添加), so a whole-line comparison misses it. Lines
# longer than maxLine are sentences, not labels.
function Find-Label($lines, [string]$target, [int]$maxLine = 0) {
  foreach ($line in @($lines)) {
    if (-not $line -or ($maxLine -gt 0 -and $line.text.Length -gt $maxLine)) { continue }
    $chars = New-Object System.Collections.ArrayList
    foreach ($w in @($line.words)) { $n = ([string]$w.t).Length; for ($k = 0; $k -lt $n; $k++) {
      [void]$chars.Add(@{ c = $w.t[$k]; l = $w.l + ($w.r - $w.l) * $k / $n; r = $w.l + ($w.r - $w.l) * ($k + 1) / $n; t = $w.top; b = $w.b }) } }
    $text = -join @($chars | ForEach-Object { $_.c })
    $i = $text.IndexOf($target, [StringComparison]::Ordinal)
    if ($i -lt 0) { continue }
    $span = @($chars[$i..($i + $target.Length - 1)])
    $l = ($span | ForEach-Object { $_.l } | Measure-Object -Minimum).Minimum; $r = ($span | ForEach-Object { $_.r } | Measure-Object -Maximum).Maximum
    $t = ($span | ForEach-Object { $_.t } | Measure-Object -Minimum).Minimum; $b = ($span | ForEach-Object { $_.b } | Measure-Object -Maximum).Maximum
    return @{ text = $target; left = $l; top = $t; right = $r; bottom = $b; x = ($l + $r) / 2; y = ($t + $b) / 2; line = $line.text }
  }
  return $null
}
# AI 看图 (微信之眼), as touch: the picture of one screen area is handed to the desktop app through a folder it watches
# (XIAOXI_VDEL_ASK_DIR); the app asks the vision model and answers with the points it picked, as fractions of the
# picture. Without the folder, or without an answer in time, the step stops as before.
$askDir = [string]$env:XIAOXI_VDEL_ASK_DIR
# Development only: these steps go to the vision model even when the screen reading found them (to test that path live).
$forcedEyes = @(([string]$env:XIAOXI_VDEL_FORCE_EYES) -split ',' | Where-Object { $_ })
function Forced([string]$kind) { $askDir -and $forcedEyes -contains $kind }
$script:eyes = @()
function Ask-Eyes([string]$kind, [int]$left, [int]$top, [int]$width, [int]$height) {
  if (-not $askDir -or -not (Test-Path -LiteralPath $askDir) -or $width -lt 20 -or $height -lt 20) { return $null }
  $id = "$phase-$kind-$($script:eyes.Count + 1)"
  $file = Join-Path $askDir "$id.png"
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  try { if (-not [XiaoxiScreenPixels]::Copy($bitmap, $left, $top)) { return $null }; $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
  $request = @{ id = $id; kind = $kind; file = $file } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $askDir "$id.req.tmp"), $request, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath (Join-Path $askDir "$id.req.tmp") -Destination (Join-Path $askDir "$id.req.json") -Force
  $answerFile = Join-Path $askDir "$id.res.json"
  $stop = [Environment]::TickCount + 40000
  $answer = $null
  while ([Environment]::TickCount -lt $stop) {
    if (Test-Path -LiteralPath $answerFile) { $answer = [IO.File]::ReadAllText($answerFile, [Text.Encoding]::UTF8) | ConvertFrom-Json; break }
    Start-Sleep -Milliseconds 200
  }
  $script:eyes += "$($kind):$(if ($answer -and $answer.ok) { 'found' } elseif ($answer) { [string]$answer.reason } else { 'no_answer' })"
  if (-not $answer) { return $null }
  # Points in screen pixels; only points inside the picture.
  $points = @{}
  if ($answer.points) { foreach ($p in $answer.points.PSObject.Properties) {
    $fx = [double]$p.Value.x; $fy = [double]$p.Value.y
    if ($fx -gt 0 -and $fx -lt 1 -and $fy -gt 0 -and $fy -lt 1) { $points[$p.Name] = @{ x = $left + $fx * $width; y = $top + $fy * $height } } } }
  return @{ ok = [bool]$answer.ok; group = [bool]$answer.group; reason = [string]$answer.reason; points = $points }
}
# Our own input only: nobody else may have touched the mouse or keyboard since our last press.
$script:lease = [XiaoxiVisualDelete]::LastInput()
function Press($x, $y, [string]$stage) {
  # Only a real point inside one of WeChat's windows is ever pressed (a lost value once made it (0, 0)).
  if ($null -eq $x -or $null -eq $y -or [double]::IsNaN([double]$x) -or [double]::IsNaN([double]$y)) { Close-Opened; Out-Result $false $stage "visual_point_invalid" }
  $inside = $false
  foreach ($h in @($mainHwnd) + @(Get-Popups)) { $r = Rect $h; if ($x -gt $r.Left + 2 -and $x -lt $r.Right - 2 -and $y -gt $r.Top + 2 -and $y -lt $r.Bottom - 2) { $inside = $true } }
  if (-not $inside) { Close-Opened; Out-Result $false $stage "visual_point_invalid" }
  $x = [double]$x; $y = [double]$y
  if ([XiaoxiVisualDelete]::LastInput() -ne $script:lease) { Close-Opened; Out-Result $false $stage "wechat_external_input_detected" }
  $ours = { $front = [XiaoxiVisualDelete]::GetForegroundWindow().ToInt64(); $front -eq $mainHwnd -or @(Get-Popups) -contains $front }
  # On commit nothing is brought to the front: a switch can close the confirm and the press would land in the chat.
  if (-not (& $ours) -and $stage -ne "commit") { [void][XiaoxiVisualDelete]::SetForegroundWindow([IntPtr]$mainHwnd); Start-Sleep -Milliseconds 250 }
  # Windows may refuse the switch (another program in front, 2026-11-26 on the dev machine): never press then.
  if (-not (& $ours)) { Close-Opened; Out-Result $false $stage "wechat_window_not_foreground" }
  # The point itself must be on a WeChat window, not on something drawn over it.
  if ([XiaoxiVisualDelete]::OwnerAt([int]$x, [int]$y) -ne $pid0) { Close-Opened; Out-Result $false $stage "wechat_target_changed" }
  if ([XiaoxiVisualDelete]::LastInput() -ne $script:lease) { Close-Opened; Out-Result $false $stage "wechat_external_input_detected" }
  [void][XiaoxiVisualDelete]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 90
  # Development only: every check of the commit press ran; stop just before it and close what was opened.
  if ($stage -eq "commit" -and $env:XIAOXI_VDEL_NO_PRESS -eq "1") { Close-Opened; Out-Result $false "commit" "dry_commit_reached" }
  if ($stage -eq "commit") { $script:pressedCommit = $true }
  [XiaoxiVisualDelete]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [XiaoxiVisualDelete]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  $script:lease = [XiaoxiVisualDelete]::LastInput()
}
# WeChat's windows other than the chat window (card, menu, confirm).
# Only windows that appeared after this delete began: the user's own detached chats or image viewers are never taken
# for the card, closed, or counted (the prepare run's baseline is handed to commit).
function Get-WechatWindows { @([XiaoxiVisualDelete]::Windows($pid0) | Where-Object { $_ -ne $mainHwnd } | Where-Object { $r = Rect $_; ($r.Right - $r.Left) -gt 60 -and ($r.Bottom - $r.Top) -gt 40 }) }
# An empty list handed in is still a list (no other window was open): only prepare takes its own.
# @( ) outside the if: an empty list must stay a list (PowerShell turns an empty statement result into $null).
# Handles may be negative (bit 31 sign-extended by ToInt64), so a sign is allowed.
$script:baseline = @(if ($env:XIAOXI_VDEL_HAS_BASELINE -eq "1") { [string]$env:XIAOXI_VDEL_BASELINE -split ',' | Where-Object { $_ -match '^-?[0-9]+$' } | ForEach-Object { [int64]$_ } } else { Get-WechatWindows })
$script:baselineReady = $true
function Get-Popups { @(Get-WechatWindows | Where-Object { $script:baseline -notcontains $_ }) }
# Anything that breaks midway: close what this run opened and say so. After the press on commit the result is
# unknown (never retried); before it, nothing was deleted.
trap {
  if ($script:baselineReady -and (Get-Command Get-Popups -ErrorAction SilentlyContinue)) {
    foreach ($h in @(Get-Popups)) { try { [void][XiaoxiVisualDelete]::SendMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } catch { } }
  }
  if ($script:pressedCommit) { @{ ok = $false; stage = "commit"; reason = "delete_outcome_unknown"; outcomeUnknown = $true; visual = $true } | ConvertTo-Json -Compress; exit 0 }
  @{ ok = $false; stage = $(if ($phase -eq "commit") { "commit" } else { "script" }); reason = "visual_script_failed"; notClicked = ($phase -eq "commit"); visual = $true } | ConvertTo-Json -Compress
  exit 0
}
function Close-Opened { foreach ($h in @(Get-Popups)) { [void][XiaoxiVisualDelete]::SendMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } }
function Wait-For([scriptblock]$probe, [int]$ms = 3000) {
  $stop = [Environment]::TickCount + $ms
  do { $value = & $probe; if ($value) { return $value }; Start-Sleep -Milliseconds 250 } while ([Environment]::TickCount -lt $stop)
  return $null
}
# The confirm: a line naming this person with 删除, and a separate 删除 button, on any WeChat window.
function Read-Confirm {
  foreach ($h in @(Get-Popups) + @($mainHwnd)) {
    $r = Rect $h; $lines = @(Read-Lines $r.Left $r.Top ($r.Right - $r.Left) ($r.Bottom - $r.Top) | Sort-Object { $_.top })
    if ($coreName.Length -lt 2) { return $null }
    # The question may wrap onto a second line (a long name), so a line with 删除 and the one below are read together.
    $question = $null
    for ($i = 0; $i -lt $lines.Count -and -not $question; $i++) {
      $text = $lines[$i].text
      if ($text -notmatch '删除' -or $text -eq '删除联系人' -or $text -eq '删除') { continue }
      $next = if ($i + 1 -lt $lines.Count) { $lines[$i + 1].text } else { "" }
      if ((Core ($text + $next)).Contains($coreName)) { $question = $lines[$i] }
    }
    if (-not $question) { continue }
    # The buttons may be read as one line (取消删除).
    $below = @($lines | Where-Object { $_.top -gt $question.bottom })
    return @{ hwnd = $h; button = (Find-Label $below '删除' 6); cancel = (Find-Label $below '取消' 6); by = "ocr" }
  }
  return $null
}

# The confirm read from the screen, else by the vision model on the topmost window this run opened (the app checks that
# its question names this person with 删除). An AI-found 删除 must lie inside that window.
function Find-Confirm([int]$ms) {
  $dialog = Wait-For { Read-Confirm } $ms
  if ($dialog -and $dialog.button -and -not (Forced "confirm")) { return $dialog }
  $h = if ($dialog) { $dialog.hwnd } else { @(Get-Popups) | Select-Object -First 1 }
  if (-not $h) { $h = $mainHwnd }
  $r = Rect $h
  $ai = Ask-Eyes "confirm" $r.Left $r.Top ($r.Right - $r.Left) ($r.Bottom - $r.Top)
  if (-not $ai -or -not $ai.ok -or -not $ai.points.delete) { return $dialog }
  $b = $ai.points.delete
  if ($b.x -le $r.Left -or $b.x -ge $r.Right -or $b.y -le $r.Top -or $b.y -ge $r.Bottom) { return $dialog }
  return @{ hwnd = $h; button = $b; cancel = $ai.points.cancel; by = "ai" }
}
$main = Rect $mainHwnd
$mw = $main.Right - $main.Left; $mh = $main.Bottom - $main.Top
if (-not $engine) { if ($phase -eq "commit") { Close-Opened }; Out-Result $false "visual" "ocr_unavailable" }
if ($mw -lt 300 -or $mh -lt 300) { if ($phase -eq "commit") { Close-Opened }; Out-Result $false "window" "wechat_main_window_not_found" }

if ($phase -eq "commit") {
  $dialog = Find-Confirm 1500
  if (-not $dialog -or -not $dialog.button) { Close-Opened; Out-Result $false "commit" "confirm_dialog_gone" @{ notClicked = $true } }
  Press $dialog.button.x $dialog.button.y "commit"
  # Deleted when the confirm and the card are gone and the chat of this person is closed (its title no longer shown).
  $gone = Wait-For { if (-not (Read-Confirm) -and -not @(Get-Popups).Count) { $true } } 4000
  if ($gone) {
    $head = @(Read-Lines ($main.Left + [int]($mw * 0.25)) $main.Top ([int]($mw * 0.75)) ([Math]::Max(40, [int]($mh * 0.1))))
    # Tolerant on purpose (a title can lose a character): a doubtful title makes it unknown, never "deleted".
    $stillOpen = $head | Where-Object { $t = Core $_.text; $cut = $_.text -match '(…|\.{2,})$'
      $t -eq $coreName -or ($coreName.Length -ge 3 -and (Like $t $coreName 1)) -or ($cut -and $t.Length -ge 2 -and $coreName.StartsWith($t)) }
    # A name without two readable letters cannot be looked for in the title: unknown, never "deleted".
    if (-not $stillOpen -and $coreName.Length -ge 2) { Out-Result $true "commit" "" @{ deleted = $true } }
  }
  Out-Result $false "verify" "delete_outcome_unknown" @{ outcomeUnknown = $true }
}

# Look only (development): what the steps below would see, nothing pressed.
if ($phase -eq "probe") {
  $band = [Math]::Max(40, [int]($mh * 0.1))
  $dots = @(Find-Dots ($main.Left + [int]($mw * 0.6)) $main.Top ([int]($mw * 0.4)) $band)
  $right = @(Read-Lines ($main.Left + [int]($mw * 0.55)) $main.Top ([int]($mw * 0.45)) $mh)  # same crop as $panelProbe
  Out-Result $true "probe" "" @{ window = @($main.Left, $main.Top, $mw, $mh); band = $band; dots = @($dots | ForEach-Object { "$($_.x),$($_.y)" });
    lines = @($right | Select-Object -First 25 | ForEach-Object { "$([int]$_.left),$([int]$_.top) $($_.text) like:$((Like $_.text '查找聊天内容'))" }) }
}
# 1. The chat's "…" (聊天信息): the rightmost three dots in the band of the chat title, unless the panel is open.
$script:panelReads = 0; $script:panelLines = 0
$panelProbe = { $lines = @(Read-Lines ($main.Left + [int]($mw * 0.55)) $main.Top ([int]($mw * 0.45)) $mh); $script:panelReads++; $script:panelLines = $lines.Count
  # Two of its labels in one column: a short chat message alone (say 消息免打扰) is not the panel.
  $labels = @($lines | Where-Object { (Like $_.text '查找聊天内容' 2) -or (Like $_.text '消息免打扰' 1) -or (Like $_.text '置顶聊天' 1) } | Sort-Object { $_.top })
  foreach ($a in $labels) { if (@($labels | Where-Object { $_ -ne $a -and [Math]::Abs($_.left - $a.left) -le 12 }).Count) { return $a } }
  return $null }
$script:panelPresses = @()
$panel = & $panelProbe
# A press right after the chat opened can be swallowed while WeChat still switches (seen on the dev machine):
# settle first, and press once more when the panel does not come.
for ($try = 0; -not $panel -and $try -lt 2; $try++) {
  Start-Sleep -Milliseconds 600
  $band = [Math]::Max(40, [int]($mh * 0.1))
  # @( ) around the sort too: one result would otherwise be a bare hashtable, and [0] of it is $null.
  $dots = @(@(Find-Dots ($main.Left + [int]($mw * 0.6)) $main.Top ([int]($mw * 0.4)) $band) | Sort-Object { $_.x } -Descending)
  if (-not $dots.Count) { Out-Result $false "member" "chat_info_button_not_found" }
  $script:panelPresses += "$($dots[0].x),$($dots[0].y)"
  Press $dots[0].x $dots[0].y "member"
  # The panel slides in and one reading takes about a second: wait before looking, and long enough. A second
  # press on an open panel would close it again.
  Start-Sleep -Milliseconds 800
  $panel = Wait-For $panelProbe 4000
}
if (-not $panel) { Close-Opened; Out-Result $false "member" "chat_info_panel_not_shown" @{ presses = $script:panelPresses; reads = $script:panelReads; last_line_count = $script:panelLines } }

# 2. The one member: the avatar left of 添加 on its row (its label is too small to read reliably; who it is is
# checked on the card). A group's panel lists group settings and is refused.
$lines = @(Read-Lines ([int]$panel.left - 30) $main.Top ($main.Right - [int]$panel.left + 30) ($main.Bottom - $main.Top))
$groupLabels = @(@('群聊名称', '群公告', '我在本群的昵称', '显示群成员昵称') | Where-Object { $label = $_; $lines | Where-Object { Like $_.text $label 1 } })
if ($groupLabels.Count -ge 2) { Close-Opened; Out-Result $false "member" "chat_member_mismatch" @{ group = $true } }
# 添加 sits above the panel's labels, under its box; it may be read in one line with the member's name.
$add = Find-Label @($lines | Where-Object { $_.top -lt $panel.top }) '添加' 12
$block = $null
if ($add) {
  $addHeight = $add.bottom - $add.top
  $rowTop = [int]($add.top - 5 * $addHeight); $rowBottom = [int]$add.top - 2
  # Start left of the 添加 box, which is wider than its label (about 2.8 label heights across).
  $scanRight = [int]($add.x - 2 * $addHeight)
  if (($scanRight - $panel.left + 30) -ge 8 -and ($rowBottom - $rowTop) -ge 8) {
    $shot = New-Object System.Drawing.Bitmap ([int]($scanRight - $panel.left + 30)), ([int]($rowBottom - $rowTop))
    try {
      [void][XiaoxiScreenPixels]::Copy($shot, [int]$panel.left - 30, $rowTop)
      $block = [XiaoxiVisualDelete]::BlockLeftOf($shot, $shot.Width - 2, 0, $shot.Height - 1)
    } finally { $shot.Dispose() }
  }
}
if ($block -and -not (Forced "member")) { $avatarX = [int]$panel.left - 30 + ($block[0] + $block[2]) / 2; $avatarY = $rowTop + ($block[1] + $block[3]) / 2 }
else {
  # The vision model on the panel: one member's avatar, not a group. Who it is is still checked on the card.
  $ai = Ask-Eyes "member" ([int]$panel.left - 30) $main.Top ($main.Right - [int]$panel.left + 30) ($main.Bottom - $main.Top)
  if ($ai -and $ai.group) { Close-Opened; Out-Result $false "member" "chat_member_mismatch" @{ group = $true } }
  if (-not $ai -or -not $ai.ok -or -not $ai.points.main) { Close-Opened; Out-Result $false "member" "chat_member_not_found" @{ add_found = [bool]$add; line_count = $lines.Count } }
  $avatarX = $ai.points.main.x; $avatarY = $ai.points.main.y
}
Press $avatarX $avatarY "profile"

# 3. The profile card: a new WeChat window showing this name, and the same 微信号 when the list has one.
$card = Wait-For { @(Get-Popups) | Select-Object -First 1 } 3000
if (-not $card) { Close-Opened; Out-Result $false "profile" "profile_card_not_found" }
Start-Sleep -Milliseconds 400
$cr = Rect $card; $cw = $cr.Right - $cr.Left; $ch = $cr.Bottom - $cr.Top
$cardLines = @(Read-Lines $cr.Left $cr.Top $cw $ch)
# The whole line, or the line with one extra character (the card's small person icon read as a character).
$nameShown = $coreName.Length -ge 2 -and [bool]($cardLines | Where-Object { $t = Core $_.text; $t -eq $coreName -or ($t.StartsWith($coreName) -and $t.Length -eq $coreName.Length + 1) })
$idLine = $cardLines | Where-Object { $_.text -match '^微信号[:：]?(.+)$' } | Select-Object -First 1
$shownId = if ($idLine) { [regex]::Match($idLine.text, '^微信号[:：]?(.+)$').Groups[1].Value } else { "" }
$normal = { param($text) ([string]$text -replace '[\s​-‏﻿]', '').ToLowerInvariant() }
# The 微信号 is small gray text that Windows' OCR can shorten (14 characters read as 12 on the dev machine): its line
# alone is read again at larger scales, and a reading equal to the stored 微信号 counts. An exact match cannot be
# made up from another person's 微信号, so extra readings never let a different person through.
# First the desktop app's PP-OCRv4 line reader (the one touch uses for this caption), when it runs.
if ($idLine -and $wechatId -and (& $normal $shownId) -ne (& $normal $wechatId)) {
  $bandWidth = [int]($idLine.right - $idLine.left) + 60; $bandHeight = [int]($idLine.bottom - $idLine.top) + 10
  $bandBitmap = New-Object System.Drawing.Bitmap $bandWidth, $bandHeight
  try {
    if ([XiaoxiScreenPixels]::Copy($bandBitmap, [int]$idLine.left - 6, [int]$idLine.top - 5)) {
      $script:lineOcrBudget.Restart(); $script:lineOcrIdErrors = 0
      $lineReading = Read-SearchLineOcr $bandBitmap 0 0 $bandWidth $bandHeight
      if ($lineReading -and [double]$lineReading.score -ge 0.8) {
        $read = [regex]::Match((Fold ([string]$lineReading.text)), '微信号[:：]?(.+)$').Groups[1].Value
        if ($read) { $shownId = $read; $idCheck_line = $true }
      }
    }
  } finally { $bandBitmap.Dispose() }
}
if ($idLine -and $wechatId -and (& $normal $shownId) -ne (& $normal $wechatId)) {
  foreach ($zoom in 4, 5, 6) {
    $again = @(Read-Lines ([int]$idLine.left - 6) ([int]$idLine.top - 4) ([int]($idLine.right - $idLine.left) + 40) ([int]($idLine.bottom - $idLine.top) + 8) $zoom) |
      Where-Object { $_.text -match '微信号[:：]?(.+)$' } | Select-Object -First 1
    if ($again) { $read = [regex]::Match($again.text, '微信号[:：]?(.+)$').Groups[1].Value; if ((& $normal $read) -eq (& $normal $wechatId)) { $shownId = $read; break } }
  }
}
$idCheck = @{ id_label_kind = $(if ($idLine) { "inline" } else { "none" }); id_value_kind = "ocr"; shown_length = $shownId.Length; stored_length = $wechatId.Length;
  same_ignoring_case = ((& $normal $shownId) -eq (& $normal $wechatId)) }
$idCheck.id_check_state = if (-not $wechatId) { "no_stored_id" } elseif ($idCheck.same_ignoring_case) { "matched" } elseif ($shownId) { "mismatch" } elseif ($uniqueName) { "degraded_unread" } else { "unread" }
# A 微信号 read on the card that differs is another person (or a misreading): always stop, a delete cannot be undone.
$idCheck.line_reader = [bool]$idCheck_line
if (-not $nameShown -and $idCheck.id_check_state -ne "matched") { Close-Opened; Out-Result $false "profile" "chat_title_mismatch" @{ id_check = $idCheck } }
if ($idCheck.id_check_state -eq "mismatch") { Close-Opened; Out-Result $false "profile" "profile_wechat_id_mismatch" @{ id_check = $idCheck } }
if ($idCheck.id_check_state -eq "unread") { Close-Opened; Out-Result $false "profile" "profile_wechat_id_unreadable" @{ id_check = $idCheck } }
if ($requireId -and $idCheck.id_check_state -ne "matched") { Close-Opened; Out-Result $false "profile" "chat_title_mismatch" @{ id_check = $idCheck } }

# 4. The card's "…" (on the name's row, top right) → 删除联系人. A card without it is not a friend any more.
$more = @(Find-Dots ($cr.Left + [int]($cw * 0.5)) $cr.Top ([int]($cw * 0.5)) ([int]($ch * 0.3))) | Sort-Object { $_.x } -Descending | Select-Object -First 1
# No "…": not a friend any more only when the card shows 发消息 without 语音聊天/视频聊天 (dev machine 2026-11-26);
# otherwise the dots were just not seen (dark mode, animation) and the person may be tried again.
if (Forced "card_more") { $more = $null }
if (-not $more) {
  $notFriend = ($cardLines | Where-Object { Like $_.text '发消息' 0 }) -and -not ($cardLines | Where-Object { (Like $_.text '语音聊天' 1) -or (Like $_.text '视频聊天' 1) })
  if ($notFriend) { Close-Opened; Out-Result $false "menu" "contact_not_friend" @{ id_check = $idCheck } }
  $ai = Ask-Eyes "card_more" $cr.Left $cr.Top $cw ([int]($ch * 0.4))
  if (-not $ai -or -not $ai.ok -or -not $ai.points.main) { Close-Opened; Out-Result $false "menu" "profile_more_not_found" @{ id_check = $idCheck } }
  $more = $ai.points.main
}
Press $more.x $more.y "menu"
$item = Wait-For {
  foreach ($h in @(Get-Popups)) { $r = Rect $h; $hit = Find-Label @(Read-Lines $r.Left $r.Top ($r.Right - $r.Left) ($r.Bottom - $r.Top)) '删除联系人' 10; if ($hit) { return $hit } }
} 3000
if (Forced "menu_item") { $item = $null }
if (-not $item) {
  # The menu is the topmost window this run opened other than the card (or drawn on the card itself).
  $menuWindow = @(Get-Popups | Where-Object { $_ -ne $card }) | Select-Object -First 1
  if (-not $menuWindow) { $menuWindow = $card }
  $r = Rect $menuWindow
  $ai = Ask-Eyes "menu_item" $r.Left $r.Top ($r.Right - $r.Left) ($r.Bottom - $r.Top)
  if (-not $ai -or -not $ai.ok -or -not $ai.points.main) { Close-Opened; Out-Result $false "menu" "delete_menu_item_not_found" @{ id_check = $idCheck } }
  $item = $ai.points.main
}
Press $item.x $item.y "confirm"

# 5. The confirm names this person; it is left open for commit (or cancelled on a look-only run).
$dialog = Find-Confirm 4000
if (-not $dialog) { Close-Opened; Out-Result $false "confirm" "confirm_dialog_not_shown" @{ id_check = $idCheck } }
if (-not $dialog.button) { if ($dialog.cancel) { Press $dialog.cancel.x $dialog.cancel.y "confirm" }; Close-Opened; Out-Result $false "confirm" "confirm_button_not_found" @{ id_check = $idCheck } }
if (-not $confirm) {
  if ($dialog.cancel) { Press $dialog.cancel.x $dialog.cancel.y "confirm" }
  Close-Opened; Out-Result $false "confirm" "dry_run_stopped_before_delete" @{ dryRun = $true; reached = "confirm"; id_check = $idCheck }
}
Out-Result $true "confirm" "" @{ ready = $true; id_check = $idCheck; baseline = (@($script:baseline) -join ',') }
`;

module.exports = { VISUAL_DELETE_SCRIPT };
