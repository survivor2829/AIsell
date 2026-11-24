// While the app operates WeChat, WeChat types with Windows' own US keyboard instead of a third-party
// input method (user 2026-11-24). On a customer computer (47d2578f) Sogou's full-screen
// "SOGOUSmartAssistant" window was up while contacts the dropdown had found would not open; other
// third-party input methods (QQ, Baidu, WeType) bring the same kind of floating windows. Text is
// pasted, so the language never matters for what is typed. The previous input method comes back as
// soon as the app stops operating WeChat (between steps, pause, quit), so the customer types as before.
// Only the keyboard language of WeChat's own window is changed (Windows applies it to the whole
// session when per-app input is off, which is the default); a US layout the app had to load is
// unloaded again on restore.
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const NATIVE = String.raw`
if (-not ("XiaoxiInputMethod" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class XiaoxiInputMethod {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, IntPtr[] list);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr hkl);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
}
`;

// The largest visible unowned window of a Weixin/WeChat process is WeChat's main window.
const FIND_MAIN = String.raw`
function Find-WechatMain {
  $pids = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if (-not $pids.Count) { return [IntPtr]::Zero }
  $script:best = [IntPtr]::Zero; $script:bestArea = 0
  [void][XiaoxiInputMethod]::EnumWindows({ param($h, $l)
    if ([XiaoxiInputMethod]::IsWindowVisible($h) -and [XiaoxiInputMethod]::GetWindow($h, 4) -eq [IntPtr]::Zero) {
      [uint32]$owner = 0; [void][XiaoxiInputMethod]::GetWindowThreadProcessId($h, [ref]$owner)
      if ($pids -contains $owner) {
        $r = New-Object XiaoxiInputMethod+RECT
        if ([XiaoxiInputMethod]::GetWindowRect($h, [ref]$r)) {
          $area = [int64]($r.Right - $r.Left) * [int64]($r.Bottom - $r.Top)
          if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
        }
      }
    }
    return $true }, [IntPtr]::Zero)
  return $script:best
}
`;

const SWITCH_SCRIPT = `${NATIVE}${FIND_MAIN}
$ErrorActionPreference = "Stop"
$main = Find-WechatMain
if ($main -eq [IntPtr]::Zero) { @{ ok=$false; reason="wechat_window_not_found" } | ConvertTo-Json -Compress; exit }
[uint32]$ownerPid = 0; $thread = [XiaoxiInputMethod]::GetWindowThreadProcessId($main, [ref]$ownerPid)
$previous = [XiaoxiInputMethod]::GetKeyboardLayout($thread)
if (([int64]$previous -band 0xFFFFFFFF) -eq 0x04090409) { @{ ok=$true; changed=$false; hWnd=[int64]$main; previous=[int64]$previous } | ConvertTo-Json -Compress; exit }
$list = New-Object IntPtr[] 64
$count = [XiaoxiInputMethod]::GetKeyboardLayoutList(64, $list)
$us = [IntPtr]::Zero
for ($i = 0; $i -lt $count; $i++) { if (([int64]$list[$i] -band 0xFFFFFFFF) -eq 0x04090409) { $us = $list[$i] } }
$loaded = $false
if ($us -eq [IntPtr]::Zero) {
  # KLF_NOTELLSHELL (0x80): no language-bar announcement; the layout is unloaded again on restore.
  $us = [XiaoxiInputMethod]::LoadKeyboardLayout("00000409", 0x80)
  if ($us -eq [IntPtr]::Zero) { @{ ok=$false; reason="us_layout_unavailable"; hWnd=[int64]$main; previous=[int64]$previous } | ConvertTo-Json -Compress; exit }
  $loaded = $true
}
# WM_INPUTLANGCHANGEREQUEST to WeChat's window: WeChat itself accepts the change.
[void][XiaoxiInputMethod]::PostMessage($main, 0x0050, [IntPtr]::Zero, $us)
$after = $previous
for ($wait = 0; $wait -lt 15; $wait++) {
  Start-Sleep -Milliseconds 40
  $after = [XiaoxiInputMethod]::GetKeyboardLayout($thread)
  if ([int64]$after -eq [int64]$us) { break }
}
@{ ok=([int64]$after -eq [int64]$us); changed=$true; reason=$(if ([int64]$after -eq [int64]$us) { "" } else { "layout_not_applied" }); hWnd=[int64]$main; previous=[int64]$previous; us=[int64]$us; loaded=$loaded } | ConvertTo-Json -Compress
`;

const RESTORE_SCRIPT = `${NATIVE}
$ErrorActionPreference = "Stop"
$main = [IntPtr][int64][Environment]::GetEnvironmentVariable("XIAOXI_IME_HWND")
$previous = [IntPtr][int64][Environment]::GetEnvironmentVariable("XIAOXI_IME_PREVIOUS")
$us = [IntPtr][int64][Environment]::GetEnvironmentVariable("XIAOXI_IME_US")
$loaded = [Environment]::GetEnvironmentVariable("XIAOXI_IME_LOADED") -eq "1"
$restored = $false
if ([XiaoxiInputMethod]::IsWindow($main)) {
  [uint32]$ownerPid = 0; $thread = [XiaoxiInputMethod]::GetWindowThreadProcessId($main, [ref]$ownerPid)
  # Only put back what the app changed: a layout the customer picked meanwhile stays.
  if ([int64][XiaoxiInputMethod]::GetKeyboardLayout($thread) -eq [int64]$us) {
    [void][XiaoxiInputMethod]::PostMessage($main, 0x0050, [IntPtr]::Zero, $previous)
    for ($wait = 0; $wait -lt 15; $wait++) {
      Start-Sleep -Milliseconds 40
      if ([int64][XiaoxiInputMethod]::GetKeyboardLayout($thread) -eq [int64]$previous) { $restored = $true; break }
    }
  }
}
$unloaded = $false
if ($loaded -and $us -ne [IntPtr]::Zero) { $unloaded = [XiaoxiInputMethod]::UnloadKeyboardLayout($us) }
@{ ok=$true; restored=$restored; unloaded=$unloaded } | ConvertTo-Json -Compress
`;

function createWechatInputMethodGuard({ run = runPowerShellAsync, log = () => {} } = {}) {
  let wanted = false;
  let switched = null;
  let failedAt = 0;
  let queue = Promise.resolve();
  const step = () => {
    queue = queue.then(async () => {
      if (wanted && !switched) {
        // A failure is retried at most once a minute: the run never waits on the input method.
        if (Date.now() - failedAt < 60_000) return;
        const result = await run(SWITCH_SCRIPT, {}, { ensure: false, timeout: 15_000 }).catch((error) => ({ ok: false, reason: error?.code || "input_method_switch_failed" }));
        // Already on the US keyboard: remembered as done, so the 750 ms refresh does not ask again.
        if (result?.ok) switched = result.changed ? result : { noop: true };
        else failedAt = Date.now();
        if (result?.ok && !result.changed) return;
        log(result?.ok ? "input_method.switched" : "input_method.switch_failed", { changed: Boolean(result?.changed), reason: String(result?.reason || ""), loaded: Boolean(result?.loaded) });
      } else if (!wanted && switched) {
        const previous = switched; switched = null;
        if (previous.noop) return;
        const result = await run(RESTORE_SCRIPT, {
          XIAOXI_IME_HWND: String(previous.hWnd), XIAOXI_IME_PREVIOUS: String(previous.previous),
          XIAOXI_IME_US: String(previous.us), XIAOXI_IME_LOADED: previous.loaded ? "1" : "0"
        }, { ensure: false, timeout: 15_000 }).catch((error) => ({ ok: false, reason: error?.code || "input_method_restore_failed" }));
        log(result?.ok ? "input_method.restored" : "input_method.restore_failed", { restored: Boolean(result?.restored), unloaded: Boolean(result?.unloaded), reason: String(result?.reason || "") });
      }
    }).catch(() => undefined);
    return queue;
  };
  return {
    sync(active) { if (Boolean(active) !== wanted) { wanted = Boolean(active); } return step(); },
    restore() { wanted = false; return step(); },
    state: () => ({ wanted, switched: Boolean(switched) })
  };
}

module.exports = { createWechatInputMethodGuard, SWITCH_SCRIPT, RESTORE_SCRIPT };
