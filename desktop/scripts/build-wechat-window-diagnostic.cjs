const fs = require("node:fs");
const path = require("node:path");
const { NORMALIZE_WECHAT_WINDOW_SCRIPT } = require("../rpa/active_touch/wechat_window_driver.cjs");

// Reuse discovery and selection from the application, stopping before any
// activation, resizing or input. Export only technical metadata and nav labels.
function buildDiagnostic(outputDirectory) {
  const stop = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("$expectedHandleWasProvided =");
  if (stop < 0) throw new Error("Window discovery boundary missing");
  const probe = `
$env:XIAOXI_EXPECTED_PID = ''
$env:XIAOXI_EXPECTED_HWND = ''
$env:XIAOXI_WECHAT_INSPECT_ONLY = '1'
${NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(0, stop)}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$windows = @()
foreach ($handle in [Win32WechatWindow]::WindowsForProcesses([int[]]@($wechatProcesses.Keys))) {
  $candidate = Get-WechatWindowCandidate $handle $true
  if (-not $candidate) { continue }
  $row = @{}
  foreach ($key in @('windowClass','hasMainRenderChild','toolWindow','processName','width','height','minimized','visible','layoutRank','styleRank')) { $row[$key] = $candidate[$key] }
  $row.hasOwner = [int64]$candidate.owner -ne 0
  $row.titleKind = if (@('微信','WeChat','Weixin') -contains $candidate.title) { 'wechat' } elseif ([string]::IsNullOrWhiteSpace($candidate.title)) { 'empty' } else { 'other_redacted' }
  try { $row.version = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate.processPath).FileVersion } catch {}
  $row.shellNavigation = Test-WechatShellNavigation $candidate
  $row.navigation = @()
  if ($candidate.visible -and -not $candidate.minimized -and $candidate.layoutRank -gt 0) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      $bounds = $root.Current.BoundingRectangle
      $row.rootControl = $root.Current.ControlType.ProgrammaticName
      $row.rootClass = $root.Current.ClassName
      $row.rootFramework = $root.Current.FrameworkId
      $row.rootSameProcess = $root.Current.ProcessId -eq $candidate.pid
      # Name-independent structure distinguishes renamed controls from a missing
      # accessibility tree. Do not export arbitrary descendant names or values.
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $row.descendantCount = $all.Count
      $row.structure = @()
      $row.sidebarControls = @()
      $typeCounts = @{}
      for ($j=0; $j -lt [Math]::Min(2000,$all.Count); $j++) {
        $item = $all.Item($j).Current
        $kind = [string]$item.ControlType.ProgrammaticName
        $typeCounts[$kind] = [int]$typeCounts[$kind] + 1
        $box = $item.BoundingRectangle
        $metadata = @{
          control=$kind; class=$item.ClassName; framework=$item.FrameworkId
          hasName=-not [string]::IsNullOrWhiteSpace($item.Name)
          offscreen=$item.IsOffscreen; sameProcess=$item.ProcessId -eq $candidate.pid
        }
        if ($row.structure.Count -lt 40) { $row.structure += $metadata }
        # Only the narrow app-navigation strip below the account avatar may
        # expose names. Exclude the conversation list, header and chat pane.
        if (-not $item.IsOffscreen -and $item.ProcessId -eq $candidate.pid -and
            $box.Width -gt 0 -and $box.Height -gt 0 -and
            $box.Left -ge $bounds.Left -and $box.Right -le ($bounds.Left+$bounds.Width*0.065) -and
            $box.Top -ge ($bounds.Top+$bounds.Height*0.11) -and
            $box.Bottom -le ($bounds.Top+$bounds.Height*0.60) -and $row.sidebarControls.Count -lt 20) {
          $navMetadata = $metadata.Clone()
          $navMetadata.name = ([string]$item.Name).Substring(0,[Math]::Min(80,([string]$item.Name).Length))
          $navMetadata.x = [Math]::Round($box.Left-$bounds.Left)
          $navMetadata.y = [Math]::Round($box.Top-$bounds.Top)
          $navMetadata.width = $box.Width; $navMetadata.height = $box.Height
          $row.sidebarControls += $navMetadata
        }
      }
      $row.controlTypeCounts = $typeCounts
      $row.structureTruncated = $all.Count -gt 2000
      $names = @('聊天','通讯录','Chats','Contacts','微信','WeChat','联系人','通訊錄')
      $conditions = @($names | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $_) })
      $condition = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conditions)
      $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      $row.navigationCount = $elements.Count
      for ($i=0; $i -lt [Math]::Min(30,$elements.Count); $i++) {
        $element = $elements.Item($i)
        $current = $element.Current
        $rect = $current.BoundingRectangle
        $row.navigation += @{
          name = $current.Name; control = $current.ControlType.ProgrammaticName
          offscreen = $current.IsOffscreen; sameProcess = $current.ProcessId -eq $candidate.pid
          x = [Math]::Round($rect.Left-$bounds.Left); y = [Math]::Round($rect.Top-$bounds.Top)
          width = $rect.Width; height = $rect.Height
        }
      }
      $row.rootWidth = $bounds.Width; $row.rootHeight = $bounds.Height
    } catch { $row.uiaErrorType = $_.Exception.GetType().FullName; $row.uiaErrorCode = $_.Exception.HResult }
  }
  $windows += $row
}
@{ schema=2; readOnly=$true; osVersion=[Environment]::OSVersion.Version.ToString(); windows=$windows } | ConvertTo-Json -Depth 8 -Compress
`;
  const encoded = Buffer.from(probe, "utf16le").toString("base64");
  const wrapper = `$ErrorActionPreference = 'Stop'
$probe = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$job = Start-Job -ScriptBlock { param($code) & ([ScriptBlock]::Create($code)) } -ArgumentList $probe
try {
  if (Wait-Job $job -Timeout 45) {
    $result = @(Receive-Job $job -ErrorAction SilentlyContinue | Where-Object { $_ -is [string] -and $_.StartsWith('{') }) | Select-Object -Last 1
    if (-not $result) { $result = '{"error":"diagnostic_failed"}' }
  } else { $result = '{"error":"diagnostic_timeout"}' }
  $destination = Join-Path $PSScriptRoot 'wechat-window-diagnostic-v2.json'
  [IO.File]::WriteAllText($destination, $result, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Saved: $destination"
} finally { Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue }
`;
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, "collect-wechat-window.ps1"), `\uFEFF${wrapper}`);
  fs.writeFileSync(path.join(outputDirectory, "collect-wechat-window.cmd"), '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-wechat-window.ps1"\r\npause\r\n');
  return outputDirectory;
}
if (require.main === module) console.log(buildDiagnostic(path.resolve(process.argv[2] || "../outputs/wechat-window-diagnostic")));
module.exports = { buildDiagnostic };
