# ASCII-only file name keeps the collector compatible with legacy Windows ZIP tools.
[CmdletBinding()]
param(
  [string]$OutputRoot = [Environment]::GetFolderPath("Desktop"),
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDirectory = Join-Path $OutputRoot "AI-Customer-Diagnostics-$timestamp"
$zipPath = "$outputDirectory.zip"
$dataRoot = Join-Path $env:APPDATA "xiaoxi-active-touch-delivery\data"

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$collected = New-Object System.Collections.Generic.List[string]
$missing = New-Object System.Collections.Generic.List[string]
$copyItems = @(
  @{ Source = Join-Path $dataRoot "auto_reply\auto-reply-diagnostics.jsonl"; Target = "auto-reply-diagnostics.jsonl" },
  @{ Source = Join-Path $dataRoot "auto_reply\auto-reply-state.json"; Target = "auto-reply-state.json" },
  @{ Source = Join-Path $dataRoot "active_touch\contacts.json"; Target = "contacts.json" }
)

foreach ($item in $copyItems) {
  if (Test-Path -LiteralPath $item.Source -PathType Leaf) {
    Copy-Item -LiteralPath $item.Source -Destination (Join-Path $outputDirectory $item.Target) -Force
    [void]$collected.Add($item.Target)
  } else {
    [void]$missing.Add($item.Source)
  }
}

$dpi = $null
try {
  $dpi = (Get-ItemProperty -LiteralPath "HKCU:\Control Panel\Desktop\WindowMetrics" -Name AppliedDPI -ErrorAction Stop).AppliedDPI
} catch {}

$screens = @()
try {
  Add-Type -AssemblyName System.Windows.Forms
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [ordered]@{
      deviceName = $_.DeviceName
      primary = $_.Primary
      bounds = [ordered]@{ width = $_.Bounds.Width; height = $_.Bounds.Height; x = $_.Bounds.X; y = $_.Bounds.Y }
      workingArea = [ordered]@{ width = $_.WorkingArea.Width; height = $_.WorkingArea.Height; x = $_.WorkingArea.X; y = $_.WorkingArea.Y }
    }
  })
} catch {}

$wechatProcesses = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object {
  $fileVersion = ""
  $path = ""
  try { $path = $_.Path } catch {}
  try { if ($path) { $fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion } } catch {}
  [ordered]@{
    processName = $_.ProcessName
    processId = $_.Id
    mainWindowTitle = $_.MainWindowTitle
    mainWindowHandle = [string]$_.MainWindowHandle
    path = $path
    fileVersion = $fileVersion
  }
})

$productName = "AI" + [char]33719 + [char]23458
$appProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -eq $productName -or $_.MainWindowTitle -like "$productName*"
} | ForEach-Object {
  $path = ""
  try { $path = $_.Path } catch {}
  [ordered]@{
    processName = $_.ProcessName
    processId = $_.Id
    mainWindowTitle = $_.MainWindowTitle
    path = $path
  }
})

$manifestCopied = $false
foreach ($appProcess in $appProcesses) {
  if (-not $appProcess.path) { continue }
  $manifestName = ([string][char]29256) + [char]26412 + [char]28165 + [char]21333 + ".json"
  $manifestPath = Join-Path (Split-Path -Parent $appProcess.path) $manifestName
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $outputDirectory "release-manifest.json") -Force
    [void]$collected.Add("release-manifest.json")
    $manifestCopied = $true
    break
  }
}
if (-not $manifestCopied) { [void]$missing.Add("release manifest next to the running application") }

$environment = [ordered]@{
  collectedAt = (Get-Date).ToString("o")
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  osVersion = [Environment]::OSVersion.VersionString
  osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  appliedDpi = $dpi
  displayScalePercent = if ($dpi) { [Math]::Round(([double]$dpi / 96.0) * 100) } else { $null }
  screens = $screens
  wechatProcesses = $wechatProcesses
  appProcesses = $appProcesses
  dataRoot = $dataRoot
  collectedFiles = @($collected)
  missingFiles = @($missing)
}
$environment | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDirectory "environment.json") -Encoding UTF8

$hashes = Get-ChildItem -LiteralPath $outputDirectory -File | ForEach-Object {
  [ordered]@{ file = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
}
$hashes | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputDirectory "file-hashes.json") -Encoding UTF8

$readme = @"
AI Customer Remote Diagnostics

Collected at: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Data root: $dataRoot

Collected files:
$(@($collected) -join "`r`n")

Missing files:
$(@($missing) -join "`r`n")

This tool never collects deepseek-api-key.bin, WeChat databases, chat databases, or unrelated folders.
contacts.json contains synchronized contact names and can be reviewed before sharing.
"@
$readme | Set-Content -LiteralPath (Join-Path $outputDirectory "README.txt") -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $outputDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "Diagnostics ZIP created:" -ForegroundColor Green
Write-Host $zipPath -ForegroundColor Cyan

if (-not $NoOpen) {
  Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`""
}
