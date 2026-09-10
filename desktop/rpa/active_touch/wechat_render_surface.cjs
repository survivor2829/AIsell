// A client rectangle is a capture boundary, not proof of a chat or Moments page.
// Callers must still verify the page, foreground ownership and action target.
const WECHAT_RENDER_SURFACE_POWERSHELL = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatRenderSurface {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
}
"@

function Get-MomentsRenderPaneEvidence([System.Windows.Automation.AutomationElement]$root, [int]$expectedPid) {
  if ($null -eq $root -or $expectedPid -le 0) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  try {
    if ([int]$root.Current.ProcessId -ne $expectedPid) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
    $paneType = [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Pane
    )
    $panes = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $paneType)
    $matches = New-Object System.Collections.Generic.List[object]
    for ($index = 0; $index -lt $panes.Count; $index++) {
      $pane = $panes.Item($index)
      if ([string]$pane.Current.Name -cne "MMUIRenderSubWindowHW" -or [int]$pane.Current.ProcessId -ne $expectedPid) { continue }
      $rect = $pane.Current.BoundingRectangle
      $controlType = [string]$pane.Current.ControlType.ProgrammaticName
      $runtimeId = [string]($pane.GetRuntimeId() -join ".")
      if (-not $runtimeId -or $controlType -cne "ControlType.Pane" -or $rect.Width -le 0 -or $rect.Height -le 0) {
        return @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
      }
      [void]$matches.Add(@{
        element = $pane; name = [string]$pane.Current.Name
        automationId = [string]$pane.Current.AutomationId; controlType = $controlType
        processId = $expectedPid; runtimeId = $runtimeId
        bounds = @{ left = [double]$rect.Left; top = [double]$rect.Top; width = [double]$rect.Width; height = [double]$rect.Height }
      })
    }
    if ($matches.Count -gt 0) {
      if ($matches.Count -ne 1) { return @{ ok = $false; reason = "moments_render_pane_ambiguous"; count = $matches.Count } }
      return @{ ok = $true; pane = $matches[0] }
    }
    # Do not silently replace conflicting or partially readable UIA evidence.
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    if ($children.Count -ne 0) { return @{ ok = $false; reason = "moments_render_pane_not_found" } }
    if ([string]$root.Current.ControlType.ProgrammaticName -cne "ControlType.Window") {
      return @{ ok = $false; reason = "moments_window_identity_mismatch" }
    }
    $hWnd = [IntPtr][int64]$root.Current.NativeWindowHandle
    [uint32]$actualPid = 0
    if (-not [Win32WechatRenderSurface]::IsWindow($hWnd) -or
      -not [Win32WechatRenderSurface]::IsWindowVisible($hWnd) -or [Win32WechatRenderSurface]::IsIconic($hWnd) -or
      [Win32WechatRenderSurface]::GetAncestor($hWnd, 2) -ne $hWnd -or
      [Win32WechatRenderSurface]::GetWindowThreadProcessId($hWnd, [ref]$actualPid) -eq 0 -or [int]$actualPid -ne $expectedPid) {
      return @{ ok = $false; reason = "moments_window_identity_mismatch" }
    }
    $client = New-Object Win32WechatRenderSurface+RECT
    $outer = New-Object Win32WechatRenderSurface+RECT
    $origin = New-Object Win32WechatRenderSurface+POINT
    if (-not [Win32WechatRenderSurface]::GetClientRect($hWnd, [ref]$client) -or
      -not [Win32WechatRenderSurface]::ClientToScreen($hWnd, [ref]$origin) -or
      -not [Win32WechatRenderSurface]::GetWindowRect($hWnd, [ref]$outer) -or
      $client.Right -le 0 -or $client.Bottom -le 0 -or $origin.X -lt $outer.Left -or $origin.Y -lt $outer.Top -or
      ($origin.X + $client.Right) -gt $outer.Right -or ($origin.Y + $client.Bottom) -gt $outer.Bottom) {
      return @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
    }
    $process = Get-Process -Id $expectedPid -ErrorAction Stop
    $generation = $process.StartTime.ToUniversalTime().Ticks
    return @{ ok = $true; pane = @{
      element = $null; name = "Win32ClientSurface"; automationId = ""; controlType = "Win32.Client"
      processId = $expectedPid; runtimeId = "win32:$($expectedPid):$($hWnd.ToInt64()):$generation"
      bounds = @{ left = [double]$origin.X; top = [double]$origin.Y; width = [double]$client.Right; height = [double]$client.Bottom }
    } }
  } catch { return @{ ok = $false; reason = "moments_surface_read_failed" } }
}

function Test-MomentsRenderSurfaceIdentity($expected) {
  if ([int]$expected.renderPaneProcessId -ne [int]$expected.pid) { return $false }
  if ([string]$expected.identityMode -ceq "visual_mmui_render") {
    return [string]$expected.renderPaneName -ceq "MMUIRenderSubWindowHW" -and
      [string]$expected.renderPaneControlType -ceq "ControlType.Pane" -and
      -not [string]::IsNullOrWhiteSpace([string]$expected.renderPaneRuntimeId)
  }
  if ([string]$expected.identityMode -ceq "visual_win32_client") {
    $prefix = "win32:$([int]$expected.pid):$([string]$expected.hWnd):"
    return [string]$expected.renderPaneName -ceq "Win32ClientSurface" -and
      [string]$expected.renderPaneControlType -ceq "Win32.Client" -and [string]$expected.renderPaneAutomationId -ceq "" -and
      ([string]$expected.renderPaneRuntimeId).StartsWith($prefix, [StringComparison]::Ordinal) -and
      [string]$expected.renderPaneRuntimeId -cmatch '^win32:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$'
  }
  return $false
}
`;

module.exports = { WECHAT_RENDER_SURFACE_POWERSHELL };
