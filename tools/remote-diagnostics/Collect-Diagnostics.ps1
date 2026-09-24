# ASCII-only source keeps PowerShell 5.1 ANSI loading predictable.
[CmdletBinding()]
param(
  [string]$OutputRoot = [Environment]::GetFolderPath("Desktop"),
  [ValidateSet("auto", "test", "delivery")][string]$DataProfile = "auto",
  [string]$DataRoot,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression

$testRoot = Join-Path $env:APPDATA "xiaoxi-active-touch-test\data"
$deliveryRoot = Join-Path $env:APPDATA "xiaoxi-active-touch-delivery\data"
$testLog = Join-Path $testRoot "logs\diagnostics.jsonl"
$deliveryLog = Join-Path $deliveryRoot "logs\diagnostics.jsonl"
$otherProfileExists = $false

if ($DataRoot) {
  $selectedRoot = [IO.Path]::GetFullPath($DataRoot)
  $profile = "custom"
} elseif ($DataProfile -eq "test") {
  $selectedRoot = $testRoot
  $profile = "test"
  $otherProfileExists = Test-Path -LiteralPath $deliveryRoot -PathType Container
} elseif ($DataProfile -eq "delivery") {
  $selectedRoot = $deliveryRoot
  $profile = "delivery"
  $otherProfileExists = Test-Path -LiteralPath $testRoot -PathType Container
} else {
  $candidates = @()
  if (Test-Path -LiteralPath $testLog -PathType Leaf) {
    $candidates += [pscustomobject]@{ profile = "test"; root = $testRoot; modified = (Get-Item -LiteralPath $testLog).LastWriteTimeUtc }
  }
  if (Test-Path -LiteralPath $deliveryLog -PathType Leaf) {
    $candidates += [pscustomobject]@{ profile = "delivery"; root = $deliveryRoot; modified = (Get-Item -LiteralPath $deliveryLog).LastWriteTimeUtc }
  }
  if ($candidates.Count -eq 0) { throw "No diagnostics.jsonl found in test or delivery profile. Use -DataRoot to select a custom data folder." }
  $chosen = $candidates | Sort-Object modified -Descending | Select-Object -First 1
  $selectedRoot = $chosen.root
  $profile = $chosen.profile
  $otherProfileExists = if ($profile -eq "test") { Test-Path -LiteralPath $deliveryRoot -PathType Container } else { Test-Path -LiteralPath $testRoot -PathType Container }
}

function Count-JsonEntries([string]$file, [string]$property) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return 0 }
  try {
    $data = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $data) { return 0 }
    if ($property -and $null -ne $data.$property) { $data = $data.$property }
    if ($data -is [array]) { return $data.Count }
    if ($data -is [pscustomobject]) { return @($data.PSObject.Properties).Count }
  } catch {}
  return 0
}

$files = New-Object System.Collections.Generic.List[object]
$missing = New-Object System.Collections.Generic.List[string]
foreach ($spec in @(
  @{ relative = "logs"; pattern = "diagnostics.jsonl*"; target = "" },
  @{ relative = "auto_reply"; pattern = "auto-reply-diagnostics.jsonl*"; target = "auto_reply/" }
)) {
  $directory = Join-Path $selectedRoot $spec.relative
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    [void]$missing.Add("$($spec.relative)/$($spec.pattern)")
    continue
  }
  $found = @(Get-ChildItem -LiteralPath $directory -File -Filter $spec.pattern | Where-Object {
    $_.Name -match '^(diagnostics|auto-reply-diagnostics)\.jsonl(\.\d+)?$'
  } | Sort-Object Name)
  if ($found.Count -eq 0) { [void]$missing.Add("$($spec.relative)/$($spec.pattern)") }
  foreach ($file in $found) {
    $files.Add([pscustomobject]@{ source = $file.FullName; name = "$($spec.target)$($file.Name)" })
  }
}

$dpi = $null
try { $dpi = (Get-ItemProperty -LiteralPath "HKCU:\Control Panel\Desktop\WindowMetrics" -Name AppliedDPI -ErrorAction Stop).AppliedDPI } catch {}
$screens = @()
try {
  Add-Type -AssemblyName System.Windows.Forms
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [ordered]@{
      primary = $_.Primary
      bounds = [ordered]@{ width = $_.Bounds.Width; height = $_.Bounds.Height; x = $_.Bounds.X; y = $_.Bounds.Y }
      workingArea = [ordered]@{ width = $_.WorkingArea.Width; height = $_.WorkingArea.Height; x = $_.WorkingArea.X; y = $_.WorkingArea.Y }
    }
  })
} catch {}

$wechatProcesses = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object {
  $version = ""
  try { if ($_.Path) { $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($_.Path).FileVersion } } catch {}
  [ordered]@{ processName = $_.ProcessName; processId = $_.Id; fileVersion = $version }
})

$productName = "AI" + [char]33719 + [char]23458
$manifestName = ([string][char]29256) + [char]26412 + [char]28165 + [char]21333 + ".json"
$manifest = $null
$appProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $productName })
foreach ($process in $appProcesses) {
  try {
    if (-not $process.Path) { continue }
    $candidate = Join-Path (Split-Path -Parent $process.Path) $manifestName
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $manifest = $candidate; break }
  } catch {}
}
if ($manifest) { $files.Add([pscustomobject]@{ source = $manifest; name = "release-manifest.json" }) }
else { [void]$missing.Add("release-manifest.json") }

$environment = [ordered]@{
  collectedAt = (Get-Date).ToUniversalTime().ToString("o")
  profile = $profile
  otherProfileExists = [bool]$otherProfileExists
  osVersion = [Environment]::OSVersion.VersionString
  osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  appliedDpi = $dpi
  displayScalePercent = if ($dpi) { [Math]::Round(([double]$dpi / 96.0) * 100) } else { $null }
  screens = $screens
  wechatProcesses = $wechatProcesses
  appProcessCount = $appProcesses.Count
  contactCount = Count-JsonEntries (Join-Path $selectedRoot "active_touch\contacts.json") ""
  receptionStateCount = Count-JsonEntries (Join-Path $selectedRoot "auto_reply\auto-reply-state.json") "contact_states"
  collectedFiles = @($files | ForEach-Object { $_.name })
  missingFiles = @($missing)
}
$readme = @(
  "AI Customer Remote Diagnostics",
  "",
  "Profile: $profile",
  "Collected files:",
  (@($files | ForEach-Object { $_.name }) -join ", "),
  "Missing relative entries:",
  (@($missing) -join ", "),
  "",
  "This archive excludes contact names, chat content, screenshots, local account paths and secrets."
) -join [Environment]::NewLine

if (-not (Test-Path -LiteralPath $OutputRoot -PathType Container)) { New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$zipPath = Join-Path $OutputRoot "AI-Customer-Diagnostics-$profile-$timestamp.zip"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stream = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($file in $files) {
      $entry = $archive.CreateEntry($file.name, [IO.Compression.CompressionLevel]::Optimal)
      $inputStream = [IO.File]::OpenRead($file.source)
      $entryStream = $entry.Open()
      try { $inputStream.CopyTo($entryStream) }
      finally { $entryStream.Dispose(); $inputStream.Dispose() }
    }
    foreach ($item in @(
      @{ name = "environment.json"; text = ($environment | ConvertTo-Json -Depth 8) },
      @{ name = "README.txt"; text = $readme }
    )) {
      $entry = $archive.CreateEntry($item.name, [IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try {
        $bytes = $utf8.GetBytes($item.text)
        $entryStream.Write($bytes, 0, $bytes.Length)
      } finally { $entryStream.Dispose() }
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

Write-Host "Diagnostics ZIP created: $(Split-Path -Leaf $zipPath)"
if (-not $NoOpen) { Start-Process explorer.exe -ArgumentList ('/select,"{0}"' -f $zipPath) -WindowStyle Hidden }
