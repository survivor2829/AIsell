[CmdletBinding()]
param(
  [ValidateSet("test", "delivery")]
  [string]$Edition = "test",
  [string]$AppExe = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-AppExecutable([string]$RequestedPath) {
  if ($RequestedPath) {
    $resolved = (Resolve-Path -LiteralPath $RequestedPath).Path
    if ([IO.Path]::GetExtension($resolved) -ne ".exe") { throw "指定路径不是 exe：$resolved" }
    return $resolved
  }

  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowTitle -like "*AI获客*" -and $_.Path -and (Test-Path -LiteralPath $_.Path)
  } | Select-Object -ExpandProperty Path -Unique)
  if ($running.Count -eq 1) { return $running[0] }

  $shortcutRoots = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("CommonDesktopDirectory"),
    [Environment]::GetFolderPath("StartMenu"),
    [Environment]::GetFolderPath("CommonStartMenu")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $shell = New-Object -ComObject WScript.Shell
  $targets = @()
  foreach ($root in $shortcutRoots) {
    foreach ($shortcut in Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue) {
      if ($shortcut.Name -notlike "*AI获客*") { continue }
      try {
        $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
        if ($target -and (Test-Path -LiteralPath $target)) { $targets += $target }
      } catch {}
    }
  }
  $targets = @($targets | Select-Object -Unique)
  if ($targets.Count -eq 1) { return $targets[0] }

  $typed = Read-Host "未能自动定位程序。请粘贴 AI获客 exe 的完整路径"
  $typed = $typed.Trim().Trim('"')
  if (-not (Test-Path -LiteralPath $typed -PathType Leaf)) { throw "找不到程序：$typed" }
  return (Resolve-Path -LiteralPath $typed).Path
}

function Wait-UntilAppClosed([string]$Executable) {
  while (@(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -eq [IO.Path]::GetFullPath($Executable)) } catch { $false }
  }).Count -gt 0) {
    Write-Host "请先正常关闭 AI获客。脚本不会强制结束程序，也不会中断正在执行的任务。" -ForegroundColor Yellow
    [void](Read-Host "关闭后按回车继续")
  }
}

if ($Edition -eq "test") {
  $profileName = "xiaoxi-active-touch-test"
} else {
  $profileName = "xiaoxi-active-touch-delivery"
}
$userData = Join-Path $env:APPDATA $profileName
$componentDirectory = Join-Path $userData "data\cloud-maintenance\components"
$selectionFile = Join-Path $componentDirectory "selection.json"
if (-not (Test-Path -LiteralPath $selectionFile -PathType Leaf)) {
  throw "找不到组件更新记录：$selectionFile。请确认这台电脑已安装并运行过 1.1.33。"
}
$selection = Get-Content -Raw -LiteralPath $selectionFile | ConvertFrom-Json
$generationId = [string]$selection.active
if ($generationId -notmatch '^[a-f0-9]{64}$') { throw "当前没有有效的增量组件版本，脚本停止，未修改任何文件。" }
$generationRoot = Join-Path (Join-Path $componentDirectory "generations") $generationId
$completeFile = Join-Path $generationRoot "component-complete.json"
if (-not (Test-Path -LiteralPath $completeFile -PathType Leaf)) { throw "当前组件代际不完整，脚本停止。" }
$envelope = Get-Content -Raw -LiteralPath $completeFile | ConvertFrom-Json
$manifest = if ($envelope.payload -is [string]) { $envelope.payload | ConvertFrom-Json } else { $envelope.payload }
if ([string]$manifest.version -ne "1.1.33") {
  throw "此脚本只允许诊断 1.1.33，当前是 $($manifest.version)。脚本停止，未修改任何文件。"
}

$driverFile = Join-Path $generationRoot "resources\app\rpa\active_touch\wechat_window_driver.dev.cjs"
if (-not (Test-Path -LiteralPath $driverFile -PathType Leaf)) { throw "找不到精准触达执行器：$driverFile" }
$appExecutable = Resolve-AppExecutable $AppExe
Wait-UntilAppClosed $appExecutable

$startedAt = [DateTime]::UtcNow
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$desktop = [Environment]::GetFolderPath("Desktop")
$sessionRoot = Join-Path $env:TEMP ("xiaoxi-touch-diagnostic-" + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $sessionRoot)
$backupFile = Join-Path $sessionRoot "wechat_window_driver.dev.cjs.original"
$probeFile = Join-Path $sessionRoot "clipboard-exceptions.jsonl"
$workflowFile = Join-Path $sessionRoot "workflow-diagnostics.jsonl"
$metadataFile = Join-Path $sessionRoot "session.json"
$zipFile = Join-Path $desktop ("AI获客精准触达诊断-$stamp.zip")
$originalHash = Get-Sha256 $driverFile
Copy-Item -LiteralPath $driverFile -Destination $backupFile

$needle = @'
  } catch {
    $result = New-InputDraftFailure "input_draft_read_failed" $inputReadStage ([Win32WechatMessageProof]::GetForegroundWindow() -eq $expectedHWnd)
  } finally {
'@
$replacement = @'
  } catch {
    $caughtInputReadError = $_
    $result = New-InputDraftFailure "input_draft_read_failed" $inputReadStage ([Win32WechatMessageProof]::GetForegroundWindow() -eq $expectedHWnd)
    try {
      $sanitizeToken = {
        param([object]$value)
        $token = [regex]::Replace([string]$value, "[^A-Za-z0-9_.:-]", "_").Trim("_")
        if ($token.Length -gt 120) { return $token.Substring(0, 120) }
        return $token
      }
      $winFormsProbeOk = $false
      $winFormsProbeFormatCount = -1
      $winFormsProbeExceptionType = ""
      $winFormsProbeExceptionHResult = ""
      try {
        $probeData = [System.Windows.Forms.Clipboard]::GetDataObject()
        $winFormsProbeFormatCount = $(if ($null -eq $probeData) { 0 } else { @($probeData.GetFormats($false)).Count })
        $winFormsProbeOk = $true
      } catch {
        $winFormsProbeExceptionType = & $sanitizeToken $_.Exception.GetType().FullName
        $winFormsProbeExceptionHResult = & $sanitizeToken ("hresult_{0:X8}" -f $_.Exception.HResult)
      }
      $record = [ordered]@{
        schema = 1
        diagnostic_version = "touch-diag-1"
        ts = [DateTime]::UtcNow.ToString("o")
        stage = & $sanitizeToken $inputReadStage
        exception_type = & $sanitizeToken $caughtInputReadError.Exception.GetType().FullName
        exception_id = & $sanitizeToken $caughtInputReadError.FullyQualifiedErrorId
        exception_hresult = & $sanitizeToken ("hresult_{0:X8}" -f $caughtInputReadError.Exception.HResult)
        exception_category = & $sanitizeToken $caughtInputReadError.CategoryInfo.Category
        powershell_version = & $sanitizeToken $PSVersionTable.PSVersion.ToString()
        apartment_state = & $sanitizeToken ([Threading.Thread]::CurrentThread.GetApartmentState().ToString())
        is_64_bit_process = [Environment]::Is64BitProcess
        same_window = [Win32WechatMessageProof]::GetForegroundWindow() -eq $expectedHWnd
        set_clipboard_available = $null -ne (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)
        get_clipboard_available = $null -ne (Get-Command Get-Clipboard -ErrorAction SilentlyContinue)
        winforms_read_probe_ok = $winFormsProbeOk
        winforms_read_probe_format_count = $winFormsProbeFormatCount
        winforms_read_probe_exception_type = $winFormsProbeExceptionType
        winforms_read_probe_exception_hresult = $winFormsProbeExceptionHResult
      }
      $line = $record | ConvertTo-Json -Compress
      [IO.File]::AppendAllText($env:XIAOXI_TOUCH_DIAGNOSTIC_FILE, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch {}
  } finally {
'@

$patched = $false
$restored = $false
$launched = $null
try {
  $source = [IO.File]::ReadAllText($driverFile)
  if (-not $source.Contains($needle)) {
    throw "1.1.33 执行器内容与诊断脚本预期不一致，脚本停止，未启动测试。"
  }

  $previousDiagnosticPath = [Environment]::GetEnvironmentVariable("XIAOXI_TOUCH_DIAGNOSTIC_FILE", "Process")
  [Environment]::SetEnvironmentVariable("XIAOXI_TOUCH_DIAGNOSTIC_FILE", $probeFile, "Process")
  try {
    $launched = Start-Process -FilePath $appExecutable -PassThru
  } finally {
    [Environment]::SetEnvironmentVariable("XIAOXI_TOUCH_DIAGNOSTIC_FILE", $previousDiagnosticPath, "Process")
  }
  $windowReady = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Seconds 1
    $launched.Refresh()
    if ($launched.HasExited) { break }
    if ($launched.MainWindowHandle -ne [IntPtr]::Zero) {
      $windowReady = $true
      break
    }
  }
  if (-not $windowReady) { throw "AI获客在 90 秒内未出现主窗口，脚本未修改执行器。" }

  $patchedSource = $source.Replace($needle, $replacement)
  [IO.File]::WriteAllText($driverFile, $patchedSource, (New-Object Text.UTF8Encoding($false)))
  $patched = $true
  Write-Host ""
  Write-Host "诊断模式已经就绪。" -ForegroundColor Green
  Write-Host "请在刚打开的 AI获客里，用测试账号和测试联系人完整运行一次精准触达。"
  Write-Host "可以真实发送测试消息；不要关闭或重新启动 AI获客。"
  Write-Host "看到成功或失败结果后，回到这个窗口按回车。"
  [void](Read-Host)
} finally {
  if ($patched -and (Test-Path -LiteralPath $backupFile -PathType Leaf)) {
    Copy-Item -LiteralPath $backupFile -Destination $driverFile -Force
    $restored = (Get-Sha256 $driverFile) -eq $originalHash
    if (-not $restored) { Write-Host "警告：执行器自动恢复校验失败，请保留本窗口并联系开发。" -ForegroundColor Red }
  }
}

$logDirectory = Join-Path $userData "data\logs"
$diagnosticCount = 0
if (Test-Path -LiteralPath $logDirectory -PathType Container) {
  foreach ($log in Get-ChildItem -LiteralPath $logDirectory -Filter "diagnostics.jsonl*" -File -ErrorAction SilentlyContinue) {
    foreach ($line in Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue) {
      try {
        $entry = $line | ConvertFrom-Json
        $entryTime = [DateTime]::Parse([string]$entry.ts).ToUniversalTime()
        if ($entryTime -ge $startedAt.AddSeconds(-5)) {
          [IO.File]::AppendAllText($workflowFile, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
          $diagnosticCount++
        }
      } catch {}
    }
  }
}

$wechatVersions = @(Get-Process -Name "Weixin", "WeChat" -ErrorAction SilentlyContinue | ForEach-Object {
  try { $_.MainModule.FileVersionInfo.FileVersion } catch { $null }
} | Where-Object { $_ } | Select-Object -Unique)
$appBuild = try { (Get-Item -LiteralPath $appExecutable).VersionInfo.ProductVersion } catch { "" }
$metadata = [ordered]@{
  schema = 1
  diagnostic_version = "touch-diag-1"
  started_at = $startedAt.ToString("o")
  finished_at = [DateTime]::UtcNow.ToString("o")
  app_version = [string]$manifest.version
  app_build = $appBuild
  edition = $Edition
  os_version = [Environment]::OSVersion.Version.ToString()
  powershell_version = $PSVersionTable.PSVersion.ToString()
  powershell_apartment_state = [Threading.Thread]::CurrentThread.GetApartmentState().ToString()
  wechat_versions = $wechatVersions
  original_driver_sha256 = $originalHash
  restored_driver = $restored
  workflow_diagnostic_count = $diagnosticCount
  clipboard_exception_count = $(if (Test-Path -LiteralPath $probeFile) { @(Get-Content -LiteralPath $probeFile).Count } else { 0 })
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
if (-not (Test-Path -LiteralPath $probeFile)) { "" | Set-Content -LiteralPath $probeFile -Encoding UTF8 }
if (-not (Test-Path -LiteralPath $workflowFile)) { "" | Set-Content -LiteralPath $workflowFile -Encoding UTF8 }

Compress-Archive -LiteralPath $metadataFile, $probeFile, $workflowFile -DestinationPath $zipFile -Force
Write-Host ""
Write-Host "诊断完成，原执行器已恢复：$restored" -ForegroundColor Green
Write-Host "请把这个文件发给我：$zipFile" -ForegroundColor Cyan
Write-Host "这个 ZIP 不包含联系人姓名、消息正文或剪贴板内容。"
[void](Read-Host "按回车关闭")
