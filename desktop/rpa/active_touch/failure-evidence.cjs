const path = require('node:path');
const crypto = require('node:crypto');

function evidenceEnvironment() {
  const index = process.argv.indexOf('--data-dir');
  const data = index >= 0 ? process.argv[index + 1] : '';
  return {
    XIAOXI_FAILURE_DIR: process.env.XIAOXI_FAILURE_DIR || (data && path.isAbsolute(data) ? path.join(path.dirname(data), 'failure-evidence') : ''),
    XIAOXI_FAILURE_TRACE: process.env.XIAOXI_FAILURE_TRACE || crypto.randomUUID()
  };
}

// Capture at the rejection site, before recovery/navigation. The internal test
// profile keeps the actual WeChat surface; other profiles retain the mask.
const FAILURE_EVIDENCE_SCRIPT = String.raw`
function Protect-XiaoxiDiagnosticText([string]$text) {
  $text = $text -replace '(?s)-----BEGIN [^-]*PRIVATE KEY[^-]*-----.*?(-----END [^-]+-----|$)', '[REDACTED_PRIVATE_KEY]'
  $text = $text -replace '(?i)\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+', '[REDACTED_AUTH]'
  $text = $text -replace '(?i)(?<![a-z0-9])((sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})', '[REDACTED_KEY]'
  $text = $text -replace '(?i)((api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)\s*[:=]\s*)[^\r\n,;]+', '$1[REDACTED]'
  if ($text.Length -gt 4000) { return $text.Substring(0,4000) + '[TRUNCATED]' }
  return $text
}
# Flight recorder: each step keeps the frame it recognised and what it read,
# so a failure arrives with the steps before it. Kept locally for two hours;
# only a failure capsule uploads it. Off unless XIAOXI_FLIGHT_DIR is set.
function Save-XiaoxiFlightFrame([string]$step, $bitmap = $null, $note = $null, [switch]$Force, [switch]$Lossless) {
  try {
    $dir = $env:XIAOXI_FLIGHT_DIR
    if (-not $dir -or $step -notmatch '^[a-z0-9_.:-]{1,80}$') { return }
    $now = [DateTime]::UtcNow
    if ($bitmap -and -not $Force -and $script:XiaoxiFlightLastFrame -and ($now - $script:XiaoxiFlightLastFrame).TotalMilliseconds -lt 400) { $bitmap = $null }
    if (-not $bitmap -and $null -eq $note) { return }
    [void][IO.Directory]::CreateDirectory($dir)
    $script:XiaoxiFlightSeq = [int]$script:XiaoxiFlightSeq + 1
    $name = $now.ToString('yyyyMMddTHHmmssfff') + '-' + $PID + '-' + ('{0:D4}' -f $script:XiaoxiFlightSeq) + '-' + ($step -replace '[^a-z0-9_.-]', '_')
    $meta = [ordered]@{ v = 1; ts = $now.ToString('o'); step = $step; pid = $PID; trace = $env:XIAOXI_FAILURE_TRACE }
    if ($bitmap -and $Lossless) {
      # Replays run recognition on this exact image, so no scaling or JPEG.
      $bitmap.Save((Join-Path $dir ($name + '.png')), [Drawing.Imaging.ImageFormat]::Png)
      $meta.image = $name + '.png'; $meta.width = [int]$bitmap.Width; $meta.height = [int]$bitmap.Height; $meta.scale = 1.0; $meta.lossless = $true
      $script:XiaoxiFlightLastFrame = $now
    } elseif ($bitmap) {
      Add-Type -AssemblyName System.Drawing
      $scale = [Math]::Min(1.0, 1600.0 / [Math]::Max([double]$bitmap.Width, [double]$bitmap.Height))
      $w = [Math]::Max(1, [int]($bitmap.Width * $scale)); $h = [Math]::Max(1, [int]($bitmap.Height * $scale))
      $copy = New-Object Drawing.Bitmap($w, $h)
      try {
        $g = [Drawing.Graphics]::FromImage($copy)
        try { $g.DrawImage($bitmap, 0, 0, $w, $h) } finally { $g.Dispose() }
        $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $parameters = New-Object Drawing.Imaging.EncoderParameters(1)
        $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]72)
        $copy.Save((Join-Path $dir ($name + '.jpg')), $codec, $parameters)
      } finally { $copy.Dispose() }
      $meta.image = $name + '.jpg'; $meta.width = [int]$bitmap.Width; $meta.height = [int]$bitmap.Height; $meta.scale = $scale
      $script:XiaoxiFlightLastFrame = $now
    }
    if ($null -ne $note) { $meta.note = $note }
    $json = $meta | ConvertTo-Json -Depth 9 -Compress
    if ($json.Length -gt 262144) { $meta.note = @{ truncated = $true; length = $json.Length }; $json = $meta | ConvertTo-Json -Depth 9 -Compress }
    [IO.File]::WriteAllText((Join-Path $dir ($name + '.json')), $json, (New-Object Text.UTF8Encoding($false)))
    if ($script:XiaoxiFlightSeq % 20 -eq 1) {
      $files = @(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -match '^\d{8}T\d{9}-\d+-\d{4}-[a-z0-9_.-]+\.(jpg|png|json)$' } | Sort-Object LastWriteTimeUtc -Descending)
      [long]$bytes = 0
      foreach ($file in $files) {
        $bytes += $file.Length
        if ($bytes -gt 120MB -or ($now - $file.LastWriteTimeUtc).TotalHours -gt 2) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
      }
    }
  } catch {}
}
function Add-XiaoxiFlightNote([string]$step, $note) { Save-XiaoxiFlightFrame $step $null $note }
function Write-XiaoxiFailure([string]$rule, [string]$reason) {
  try {
    if (-not $env:XIAOXI_FAILURE_DIR) { return $rule }
    $dir = $env:XIAOXI_FAILURE_DIR
    [void][IO.Directory]::CreateDirectory($dir)
    if ($rule -notmatch '^[a-z0-9_.-]{1,100}$' -or $reason -notmatch '^[a-z0-9_.:-]{1,120}$') { return $rule }
    $id = [Guid]::NewGuid().ToString('N')
    $at = [DateTime]::UtcNow.ToString('o')
    $detail = @{ rule_id=$rule; reason=$reason; evidence_id=$id; capture_status='unavailable'; redaction_mode='full_content'; decision_scope='branch_not_task_outcome' }
    $internalCapture = $env:XIAOXI_INTERNAL_DIAGNOSTICS -ceq '1'
    if ($internalCapture) { $detail.redaction_mode='internal_visible' }
    if ($Error.Count -gt 0) {
      # Error queue can contain an earlier exception: label it as context,
      # never claim it caused this rejection.
      $detail.context_exception_type = $Error[0].Exception.GetType().FullName
      $detail.context_exception_code = ('hresult_{0:X8}' -f $Error[0].Exception.HResult)
      if ($internalCapture) {
        $detail.context_exception_message = Protect-XiaoxiDiagnosticText ([string]$Error[0].Exception.Message)
        $detail.context_exception_stack = Protect-XiaoxiDiagnosticText ([string]$Error[0].ScriptStackTrace)
        $detail.context_script_line = $Error[0].InvocationInfo.ScriptLineNumber
      }
    }
    # Persist the branch BEFORE PrintWindow: a capture timeout must not erase
    # the rejection that triggered it. This is not a final send outcome.
    $detail.capture_status='pending'
    $entry=@{v=1;ts=$at;level='error';module='wechat_adapter';event='rule.rejected';code=$reason;trace_id=$env:XIAOXI_FAILURE_TRACE;details=$detail}
    [IO.File]::WriteAllText((Join-Path $dir ($id+'.json')),($entry|ConvertTo-Json -Depth 5 -Compress),(New-Object Text.UTF8Encoding($false)))
    try {
      # Internal probes can reject before another probe succeeds. Record every
      # branch, but capture at most once per process and once per five seconds.
      if ($script:XiaoxiFailureCaptured) { throw 'capture_throttled' }
      $latest = Get-ChildItem -LiteralPath $dir -Filter '*.png' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($latest -and ([DateTime]::UtcNow-$latest.LastWriteTimeUtc).TotalSeconds -lt 5) { throw 'capture_throttled' }
      $script:XiaoxiFailureCaptured=$true
      Add-Type -AssemblyName System.Drawing
      if (-not ('XiaoxiFailureCapture' -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XiaoxiFailureCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
}
"@
      }
      $hwnd = [XiaoxiFailureCapture]::GetForegroundWindow()
      [uint32]$owner = 0
      [void][XiaoxiFailureCapture]::GetWindowThreadProcessId($hwnd,[ref]$owner)
      $processName = (Get-Process -Id $owner -ErrorAction Stop).ProcessName
      if ($processName -notin @('WeChat','Weixin')) { throw 'foreground_not_wechat' }
      $rect = New-Object XiaoxiFailureCapture+RECT
      if (-not [XiaoxiFailureCapture]::GetWindowRect($hwnd,[ref]$rect)) { throw 'window_rect_unavailable' }
      $w=$rect.R-$rect.L; $h=$rect.B-$rect.T
      if ($w -lt 32 -or $h -lt 32 -or $w -gt 4096 -or $h -gt 4096) { throw 'window_size_unsupported' }
      $bitmap = New-Object Drawing.Bitmap($w,$h)
      try {
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        try {
          $dc=$graphics.GetHdc()
          try { $captured=[XiaoxiFailureCapture]::PrintWindow($hwnd,$dc,2) } finally { $graphics.ReleaseHdc($dc) }
          if (-not $captured) { throw 'print_window_failed' }
          # Cover title, avatars, content, controls and window edges. Only a
          # two-pixel outer border survives; no raw image ever reaches disk.
          if (-not $internalCapture) { $graphics.FillRectangle([Drawing.Brushes]::DimGray,0,0,$w,$h) }
        } finally { $graphics.Dispose() }
        $bitmap.Save((Join-Path $dir ($id+'.png')),[Drawing.Imaging.ImageFormat]::Png)
        $detail.capture_status='saved'
        $detail.window_width=$w; $detail.window_height=$h
        $detail.capture_hwnd=$hwnd.ToInt64(); $detail.capture_pid=$owner
        $detail.capture_at=[DateTime]::UtcNow.ToString('o')
      } finally { $bitmap.Dispose() }
    } catch {
      $detail.capture_status='failed'; $detail.capture_exception_type=$_.Exception.GetType().FullName
      if ($internalCapture) { $detail.capture_exception_message=Protect-XiaoxiDiagnosticText ([string]$_.Exception.Message) }
      if ([string]$_.Exception.Message -in @('foreground_not_wechat','window_rect_unavailable','window_size_unsupported','print_window_failed','capture_throttled')) {
        $detail.capture_failure_code=[string]$_.Exception.Message
        if ($detail.capture_failure_code -eq 'capture_throttled') { $detail.capture_status='throttled' }
      }
    }
    [IO.File]::WriteAllText((Join-Path $dir ($id+'.json')),($entry|ConvertTo-Json -Depth 5 -Compress),(New-Object Text.UTF8Encoding($false)))
    # Retain at most 50 events / 20 MiB, deleting only this collector's UUID files.
    $files=@(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -match '^[a-f0-9]{32}\.(json|png)$' } | Sort-Object LastWriteTimeUtc -Descending)
    [long]$bytes=0; $count=0
    foreach($file in $files) { $bytes+=$file.Length; $count++; if($count -gt 100 -or $bytes -gt 20MB) { Remove-Item -LiteralPath $file.FullName -Force } }
  } catch { [Console]::Error.WriteLine('xiaoxi_evidence_write_failed') }
  return $rule
}
`;

// Screen, window titles and the control tree are taken by a separate process
// the main process starts after a failure (flight-recorder.cjs). Kept out of
// FAILURE_EVIDENCE_SCRIPT: every worker script starts with that text, and with
// screen capture and window listing in it Defender blocked a clipboard script as
// malicious. A blocked worker would stop the WeChat task itself.
const FAILURE_SCREEN_SCRIPT = String.raw`
# Flight recorder: each step keeps the frame it recognised and what it read,
# so a failure arrives with the steps before it. Kept locally for two hours;
# only a failure capsule uploads it. Off unless XIAOXI_FLIGHT_DIR is set.
function Save-XiaoxiFlightFrame([string]$step, $bitmap = $null, $note = $null, [switch]$Force, [switch]$Lossless) {
  try {
    $dir = $env:XIAOXI_FLIGHT_DIR
    if (-not $dir -or $step -notmatch '^[a-z0-9_.:-]{1,80}$') { return }
    $now = [DateTime]::UtcNow
    if ($bitmap -and -not $Force -and $script:XiaoxiFlightLastFrame -and ($now - $script:XiaoxiFlightLastFrame).TotalMilliseconds -lt 400) { $bitmap = $null }
    if (-not $bitmap -and $null -eq $note) { return }
    [void][IO.Directory]::CreateDirectory($dir)
    $script:XiaoxiFlightSeq = [int]$script:XiaoxiFlightSeq + 1
    $name = $now.ToString('yyyyMMddTHHmmssfff') + '-' + $PID + '-' + ('{0:D4}' -f $script:XiaoxiFlightSeq) + '-' + ($step -replace '[^a-z0-9_.-]', '_')
    $meta = [ordered]@{ v = 1; ts = $now.ToString('o'); step = $step; pid = $PID; trace = $env:XIAOXI_FAILURE_TRACE }
    if ($bitmap -and $Lossless) {
      # Replays run recognition on this exact image, so no scaling or JPEG.
      $bitmap.Save((Join-Path $dir ($name + '.png')), [Drawing.Imaging.ImageFormat]::Png)
      $meta.image = $name + '.png'; $meta.width = [int]$bitmap.Width; $meta.height = [int]$bitmap.Height; $meta.scale = 1.0; $meta.lossless = $true
      $script:XiaoxiFlightLastFrame = $now
    } elseif ($bitmap) {
      Add-Type -AssemblyName System.Drawing
      $scale = [Math]::Min(1.0, 1600.0 / [Math]::Max([double]$bitmap.Width, [double]$bitmap.Height))
      $w = [Math]::Max(1, [int]($bitmap.Width * $scale)); $h = [Math]::Max(1, [int]($bitmap.Height * $scale))
      $copy = New-Object Drawing.Bitmap($w, $h)
      try {
        $g = [Drawing.Graphics]::FromImage($copy)
        try { $g.DrawImage($bitmap, 0, 0, $w, $h) } finally { $g.Dispose() }
        $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $parameters = New-Object Drawing.Imaging.EncoderParameters(1)
        $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]72)
        $copy.Save((Join-Path $dir ($name + '.jpg')), $codec, $parameters)
      } finally { $copy.Dispose() }
      $meta.image = $name + '.jpg'; $meta.width = [int]$bitmap.Width; $meta.height = [int]$bitmap.Height; $meta.scale = $scale
      $script:XiaoxiFlightLastFrame = $now
    }
    if ($null -ne $note) { $meta.note = $note }
    $json = $meta | ConvertTo-Json -Depth 9 -Compress
    if ($json.Length -gt 262144) { $meta.note = @{ truncated = $true; length = $json.Length }; $json = $meta | ConvertTo-Json -Depth 9 -Compress }
    [IO.File]::WriteAllText((Join-Path $dir ($name + '.json')), $json, (New-Object Text.UTF8Encoding($false)))
    if ($script:XiaoxiFlightSeq % 20 -eq 1) {
      $files = @(Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -match '^\d{8}T\d{9}-\d+-\d{4}-[a-z0-9_.-]+\.(jpg|png|json)$' } | Sort-Object LastWriteTimeUtc -Descending)
      [long]$bytes = 0
      foreach ($file in $files) {
        $bytes += $file.Length
        if ($bytes -gt 120MB -or ($now - $file.LastWriteTimeUtc).TotalHours -gt 2) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
      }
    }
  } catch {}
}
function Add-XiaoxiFlightNote([string]$step, $note) { Save-XiaoxiFlightFrame $step $null $note }
# Top-level windows in z-order: what was in front of WeChat, and where.
function Get-XiaoxiWindowSnapshot {
  if (-not ('XiaoxiFlightWindows' -as [type])) {
    Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class XiaoxiFlightWindows {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<object[]> List() {
    var rows = new List<object[]>();
    EnumWindows((hWnd, unused) => {
      if (!IsWindowVisible(hWnd) || rows.Count >= 80) return true;
      var title = new StringBuilder(256); GetWindowText(hWnd, title, 256);
      var cls = new StringBuilder(128); GetClassName(hWnd, cls, 128);
      RECT r; GetWindowRect(hWnd, out r); uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (r.R - r.L < 2 || r.B - r.T < 2) return true;
      rows.Add(new object[] { hWnd.ToInt64(), title.ToString(), cls.ToString(), r.L, r.T, r.R - r.L, r.B - r.T, (int)pid, IsIconic(hWnd) });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@
  }
  $foreground = [XiaoxiFlightWindows]::GetForegroundWindow().ToInt64()
  $names = @{}
  foreach ($row in [XiaoxiFlightWindows]::List()) {
    $owner = [int]$row[7]
    if (-not $names.ContainsKey($owner)) { $names[$owner] = try { (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { '' } }
    [ordered]@{ hwnd = $row[0]; title = $row[1]; class = $row[2]; left = $row[3]; top = $row[4]; width = $row[5]; height = $row[6]
      pid = $owner; process = $names[$owner]; minimized = $row[8]; foreground = ($row[0] -eq $foreground) }
  }
}
# The WeChat control tree, bounded: shows whether the window changed shape.
function Get-XiaoxiUiaTree([IntPtr]$hWnd) {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $script:XiaoxiUiaNodes = 0
    function Read-XiaoxiUiaNode($element, [int]$depth) {
      if ($null -eq $element -or $depth -gt 8 -or $script:XiaoxiUiaNodes -ge 500) { return $null }
      $script:XiaoxiUiaNodes++
      $current = $element.Current; $box = $current.BoundingRectangle; $label = [string]$current.Name
      $node = [ordered]@{ type = ($current.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $label.Substring(0, [Math]::Min(80, $label.Length))
        class = $current.ClassName; id = $current.AutomationId; rect = @([int]$box.X, [int]$box.Y, [int]$box.Width, [int]$box.Height) }
      $children = @(); $child = $walker.GetFirstChild($element)
      while ($null -ne $child -and $script:XiaoxiUiaNodes -lt 500) { $children += ,(Read-XiaoxiUiaNode $child ($depth + 1)); $child = $walker.GetNextSibling($child) }
      if ($children.Count) { $node.children = $children }
      return $node
    }
    return Read-XiaoxiUiaNode ([Windows.Automation.AutomationElement]::FromHandle($hWnd)) 0
  } catch { return @{ error = $_.Exception.GetType().Name } }
}
# Every monitor, so a popup or another program in front of WeChat is visible.
function Save-XiaoxiFailureScreen([string]$rule, [string]$reason, [string]$evidenceId) {
  if (-not $env:XIAOXI_FLIGHT_DIR -or $script:XiaoxiFlightScreenSaved) { return }
  $script:XiaoxiFlightScreenSaved = $true
  try {
    Add-Type -AssemblyName System.Drawing, System.Windows.Forms
    $windows = @(Get-XiaoxiWindowSnapshot)
    $wechat = $windows | Where-Object { $_.process -in @('WeChat', 'Weixin') -and -not $_.minimized } | Select-Object -First 1
    $note = [ordered]@{ rule = $rule; reason = $reason; evidence_id = $evidenceId; windows = $windows
      uia = $(if ($wechat) { Get-XiaoxiUiaTree ([IntPtr][int64]$wechat.hwnd) } else { $null }) }
    $area = [Windows.Forms.SystemInformation]::VirtualScreen
    $screen = New-Object Drawing.Bitmap($area.Width, $area.Height)
    try {
      $g = [Drawing.Graphics]::FromImage($screen)
      try { $g.CopyFromScreen($area.Left, $area.Top, 0, 0, $area.Size) } finally { $g.Dispose() }
      $note.screen = @{ left = $area.Left; top = $area.Top; width = $area.Width; height = $area.Height }
      Save-XiaoxiFlightFrame ('failure.' + $rule) $screen $note -Force
    } finally { $screen.Dispose() }
  } catch { Add-XiaoxiFlightNote ('failure.' + $rule) @{ rule = $rule; reason = $reason; capture_error = $_.Exception.GetType().Name } }
}
`;

module.exports = { evidenceEnvironment, FAILURE_EVIDENCE_SCRIPT, FAILURE_SCREEN_SCRIPT };
