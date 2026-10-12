# Runs ONLY in a disposable sandbox or GitHub-hosted Windows runner.
$ErrorActionPreference = 'Stop'
$report = 'C:/Evidence/sandbox-real-upgrade'
$disposableRunner = $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows'
if ((!$disposableRunner -and $env:USERNAME -ne 'WDAGUtilityAccount') -or !(Test-Path 'C:/Inputs/original-1.1.64.exe')) { throw 'Disposable Windows identity required' }
New-Item -ItemType Directory -Path $report -Force | Out-Null
Start-Transcript -LiteralPath "$report/run.log" -Force
function Read-Json($file) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
function Assert-True($value,$message) { if (!$value) { throw $message } }
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class SandboxClose{[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'
  $oldHash=(Get-FileHash 'C:/Inputs/original-1.1.64.exe' -Algorithm SHA256).Hash.ToLowerInvariant()
  $newHash=(Get-FileHash 'C:/Inputs/latest-1.1.86.exe' -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ($oldHash -eq 'df85caee5c47cd4eb1ccc6bcbac3d844b737aa653b6ab9c488f4fb973bb8209a') 'Original installer changed'
  Assert-True ($newHash -eq 'c7b3c4b51e09276dbe1602a71e2fb35b225c4e2c991022b96671927db308a8ff') 'Published installer changed'
  $install=Start-Process 'C:/Inputs/original-1.1.64.exe' -ArgumentList '/S' -PassThru -Wait
  Assert-True ($install.ExitCode -eq 0) 'Original real NSIS install failed'
  $program=Join-Path $env:LOCALAPPDATA 'Programs/AI获客-测试版'
  $profile=Join-Path $env:APPDATA 'xiaoxi-active-touch-test'
  $until=(Get-Date).AddSeconds(90)
  do { $oldProcesses=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $program 'AI获客 V1.0版本-测试版.exe') }; if($oldProcesses){break}; Start-Sleep -Milliseconds 500 } while((Get-Date) -lt $until)
  foreach($p in $oldProcesses){if($p.MainWindowHandle){[void][SandboxClose]::PostMessage($p.MainWindowHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)}}
  $until=(Get-Date).AddSeconds(30)
  do { $live=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($program+'\',[StringComparison]::OrdinalIgnoreCase) }; if(!$live){break}; Start-Sleep -Milliseconds 500 } while((Get-Date) -lt $until)
  Assert-True (!$live) 'Original app did not exit safely'
  Assert-True ((Read-Json "$program/resources/app/package.json").version -eq '1.1.64') 'Original application version mismatch'
  New-Item -ItemType Directory -Path "$profile/data" -Force | Out-Null
  Set-Content -LiteralPath "$profile/data/acceptance-preserve.json" -Value '{"outcome":"outcome_unknown","scope":"isolated sandbox only"}' -Encoding UTF8
  $receiptHash=(Get-FileHash "$profile/data/acceptance-preserve.json").Hash
  New-Item -ItemType Directory -Path "$profile/product-detail/.runtime-links" -Force | Out-Null
  New-Item -ItemType Junction -Path "$profile/product-detail/.runtime-links/resources" -Target "$program/resources" | Out-Null
  $downloads=Join-Path $env:LOCALAPPDATA 'AI获客更新助手/downloads'
  New-Item -ItemType Directory -Path $downloads -Force | Out-Null
  Copy-Item -LiteralPath 'C:/Inputs/latest-1.1.86.exe' -Destination (Join-Path $downloads ($newHash+'.exe'))
  $assistant=Start-Process 'C:/Inputs/official-update-assistant.exe' -PassThru
  $until=(Get-Date).AddSeconds(30); $button=$null
  do {
    $window=[Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$assistant.Id))
    if($window){$button=$window.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'立即更新'))}
    if(!$button){Start-Sleep -Milliseconds 200}
  }while(!$button -and (Get-Date) -lt $until)
  Assert-True ($null -ne $button) 'Native update action unavailable'
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  $jobs=Join-Path $profile 'data/cloud-maintenance/components/jobs';$status=$null;$statusFile=$null
  $until=(Get-Date).AddMinutes(8)
  do {
    if(Test-Path $jobs){$statusFile=Get-ChildItem $jobs -Filter '*.status.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($statusFile){$status=Read-Json $statusFile.FullName}}
    if($status.phase -in @('complete','error')){break}
    Start-Sleep -Milliseconds 500
  }while((Get-Date) -lt $until)
  if($statusFile){Copy-Item -LiteralPath $statusFile.FullName -Destination "$report/status.json"}
  Assert-True ($status.phase -eq 'complete') ('Real upgrade did not complete: '+($status|ConvertTo-Json -Compress))
  $ackFile=$statusFile.FullName -replace '\.status\.json$','.ack.json'; $ack=Read-Json $ackFile
  Assert-True ($ack.ok -and $ack.version -eq '1.1.86') 'Target startup did not acknowledge success'
  Assert-True ((Read-Json "$program/resources/app/package.json").version -eq '1.1.86') 'Target program was not installed'
  Assert-True ((Get-FileHash "$profile/data/acceptance-preserve.json").Hash -eq $receiptHash) 'Original receipt changed'
  [pscustomobject]@{ok=$true;source='1.1.64';target='1.1.86';originalInstallerExecuted=$true;publishedTargetInstallerExecuted=$true;nativeAssistantClicked=$true;startupAck=$ack;originalReceiptPreserved=$true;prevalidatedDownloadCache=$true;remoteCustomerComputerVerified=$false;profile=$profile} | ConvertTo-Json -Depth 6 | Set-Content "$report/result.json" -Encoding UTF8
} catch {
  $_ | Out-String | Set-Content "$report/error.txt"
  throw
} finally { Stop-Transcript }
