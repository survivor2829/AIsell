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

// Called at the rejection site, before recovery or window navigation. Never
// persist a raw bitmap. Full content masking is intentional: OCR cannot prove
// that all private text and images have been located on an unfamiliar version.
const FAILURE_EVIDENCE_SCRIPT = String.raw`
function Write-XiaoxiFailure([string]$rule, [string]$reason) {
  try {
    if (-not $env:XIAOXI_FAILURE_DIR) { return $rule }
    $dir = $env:XIAOXI_FAILURE_DIR
    [void][IO.Directory]::CreateDirectory($dir)
    if ($rule -notmatch '^[a-z0-9_.-]{1,100}$' -or $reason -notmatch '^[a-z0-9_.:-]{1,120}$') { return $rule }
    $id = [Guid]::NewGuid().ToString('N')
    $at = [DateTime]::UtcNow.ToString('o')
    $detail = @{ rule_id=$rule; reason=$reason; evidence_id=$id; capture_status='unavailable'; redaction_mode='full_content'; decision_scope='branch_not_task_outcome' }
    if ($Error.Count -gt 0) {
      # Error queue can contain an earlier exception: label it as context,
      # never claim it caused this rejection.
      $detail.context_exception_type = $Error[0].Exception.GetType().FullName
      $detail.context_exception_code = ('hresult_{0:X8}' -f $Error[0].Exception.HResult)
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
          $graphics.FillRectangle([Drawing.Brushes]::DimGray,0,0,$w,$h)
        } finally { $graphics.Dispose() }
        $bitmap.Save((Join-Path $dir ($id+'.png')),[Drawing.Imaging.ImageFormat]::Png)
        $detail.capture_status='saved'
        $detail.window_width=$w; $detail.window_height=$h
      } finally { $bitmap.Dispose() }
    } catch {
      $detail.capture_status='failed'; $detail.capture_exception_type=$_.Exception.GetType().FullName
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

module.exports = { evidenceEnvironment, FAILURE_EVIDENCE_SCRIPT };
