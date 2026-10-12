# Runs ONLY in a disposable sandbox or GitHub-hosted Windows runner.
param([ValidateSet('success','installer-interruption','startup-interruption')][string]$Scenario='success')
$ErrorActionPreference = 'Stop'
$report = 'C:/Evidence/sandbox-real-upgrade'
$disposableRunner = $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows'
if ((!$disposableRunner -and $env:USERNAME -ne 'WDAGUtilityAccount') -or !(Test-Path 'C:/Inputs/original-1.1.64.exe')) { throw 'Disposable Windows identity required' }
New-Item -ItemType Directory -Path $report -Force | Out-Null
Start-Transcript -LiteralPath "$report/run.log" -Force
function Read-Json($file) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
function Assert-True($value,$message) { if (!$value) { throw $message } }
try {
  Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class SandboxClose {
 public delegate bool Visit(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(Visit f,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Visit f,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,StringBuilder s,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 static string Text(IntPtr h){var s=new StringBuilder(2048);if(Class(h).StartsWith("WindowsForms10.EDIT.")){UIntPtr result;SendMessageTimeout(h,0xD,(UIntPtr)s.Capacity,s,2,2000,out result);}else GetWindowText(h,s,s.Capacity);return s.ToString();}
 static string Class(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,s.Capacity);return s.ToString();}
 public static IntPtr UpdateButton(uint pid){var found=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid)EnumChildWindows(h,(c,q)=>{if(Text(c)=="立即更新" && Class(c).StartsWith("WindowsForms10.BUTTON.") && IsWindowEnabled(c))found=c;return true;},IntPtr.Zero);return true;},IntPtr.Zero);return found;}
 public static string[] Inspect(uint pid){var a=new List<string>();EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid){a.Add(Class(h)+" "+Text(h));EnumChildWindows(h,(c,q)=>{a.Add(Class(c)+" "+Text(c));return true;},IntPtr.Zero);}return true;},IntPtr.Zero);return a.ToArray();}
}
'@
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
  $jobs=Join-Path $profile 'data/cloud-maintenance/components/jobs'
  $originalExeHash=(Get-FileHash (Join-Path $program 'AI获客 V1.0版本-测试版.exe')).Hash
  $fault=$null
  if($Scenario -ne 'success') {
    # Interrupt only this disposable runner's real installer or its new startup.
    # No altered installer, mocked exit code, or production profile is involved.
    $fault=Start-Job -ArgumentList $Scenario,$program,$jobs,$downloads,$newHash,$originalExeHash -ScriptBlock {
      param($mode,$root,$jobRoot,$cache,$digest,$originalHash)
      $ErrorActionPreference='Stop';$until=(Get-Date).AddMinutes(8)
      $exe=Join-Path $root 'AI获客 V1.0版本-测试版.exe'
      while((Get-Date) -lt $until) {
        $statusFile=Get-ChildItem $jobRoot -Filter '*.status.json' -ErrorAction SilentlyContinue | Select-Object -First 1
        if($statusFile) {
          try {$state=Get-Content $statusFile.FullName -Raw | ConvertFrom-Json} catch {Start-Sleep -Milliseconds 100;continue}
          $target=$null;$changed=$false
          if($mode -eq 'installer-interruption' -and $state.phase -eq 'installing') {
            $target=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq (Join-Path $cache ($digest+'.exe'))} | Select-Object -First 1
            if($target) {
              try {$changed=!(Test-Path $exe) -or (Get-FileHash $exe).Hash -ne $originalHash} catch {$changed=$false}
              if(!$changed){$target=$null}
            }
          } elseif($mode -eq 'startup-interruption' -and $state.phase -eq 'starting') {
            $jobId=$statusFile.BaseName -replace '\.status$',''
            $target=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $exe -and $_.CommandLine -match ('--xiaoxi-updated-launch\s+'+[regex]::Escape($jobId))} | Select-Object -First 1
          }
          if($target) {
            $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$target.ProcessId)
            if($current.CreationDate -ne $target.CreationDate -or $current.ExecutablePath -ne $target.ExecutablePath){throw 'Fault target identity changed'}
            & taskkill.exe /PID $target.ProcessId /T /F | Out-Null
            if($LASTEXITCODE -ne 0){throw 'Controlled interruption did not execute'}
            return [pscustomobject]@{scenario=$mode;pid=$target.ProcessId;executable=$target.ExecutablePath;creation=$target.CreationDate;phase=$state.phase;partialProgramMutationObserved=$changed}
          }
        }
        Start-Sleep -Milliseconds 100
      }
      throw 'Controlled fault was not reached'
    }
  }
  $assistant=Start-Process 'C:/Inputs/official-update-assistant.exe' -PassThru
  $until=(Get-Date).AddSeconds(30); $button=[IntPtr]::Zero
  do {
    $button=[SandboxClose]::UpdateButton($assistant.Id)
    if($button -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 200}
  }while($button -eq [IntPtr]::Zero -and (Get-Date) -lt $until)
  Assert-True ($button -ne [IntPtr]::Zero) 'Native update action unavailable'
  Assert-True ([SandboxClose]::PostMessage($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)) 'Native button click could not be posted'
  $status=$null;$statusFile=$null
  $until=(Get-Date).AddMinutes(8)
  do {
    if(Test-Path $jobs){$statusFile=Get-ChildItem $jobs -Filter '*.status.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($statusFile){$status=Read-Json $statusFile.FullName}}
    if($status.phase -in @('complete','error')){break}
    if(!$statusFile) {
      if([SandboxClose]::Inspect($assistant.Id) -match '更新已安全停止'){throw 'Official assistant stopped before installation; see native-window.json'}
    }
    Start-Sleep -Milliseconds 500
  }while((Get-Date) -lt $until)
  if($statusFile){Copy-Item -LiteralPath $statusFile.FullName -Destination "$report/status.json"}
  if($Scenario -ne 'success') {
    $injected=Receive-Job -Job $fault -Wait -ErrorAction Stop
    $injected | ConvertTo-Json -Depth 4 | Set-Content "$report/fault.json"
    Assert-True ($injected.scenario -eq $Scenario) 'Expected real-process fault did not execute'
    Assert-True ($status.phase -eq 'error' -and $status.failure.code -eq 'update_start_rolled_back') ('Rollback not confirmed: '+($status|ConvertTo-Json -Compress))
    $jobFile=$statusFile.FullName -replace '\.status\.json$','.json';$job=Read-Json $jobFile
    foreach($file in $job.programBackup.files) {
      $restored=Join-Path $program $file.path
      Assert-True ((Test-Path $restored) -and (Get-Item $restored).Length -eq $file.size -and (Get-FileHash $restored).Hash.ToLowerInvariant() -eq $file.sha256) ('Restored program mismatch: '+$file.path)
    }
    Assert-True ((Read-Json "$program/resources/app/package.json").version -eq '1.1.64') 'Previous application not restored'
    $selection=Read-Json "$profile/data/cloud-maintenance/components/selection.json"
    Assert-True ($selection.active -eq $job.programBackup.selection.active -and $selection.previous -eq $job.programBackup.selection.previous -and !$selection.pending) 'Previous version selection not restored'
    Assert-True ((Get-FileHash "$profile/data/acceptance-preserve.json").Hash -eq $receiptHash) 'Original receipt changed during rollback'
    $until=(Get-Date).AddSeconds(30)
    do {$restoredProcess=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq (Join-Path $program 'AI获客 V1.0版本-测试版.exe')};if($restoredProcess){break};Start-Sleep -Milliseconds 500} while((Get-Date) -lt $until)
    Assert-True ($null -ne $restoredProcess) 'Previous application was not reopened'
    [pscustomobject]@{ok=$true;scenario=$Scenario;realPublishedInstaller=$true;controlledProcessFailure=$true;restoredVersion='1.1.64';verifiedProgramFiles=$job.programBackup.files.Count;originalReceiptPreserved=$true;previousProgramReopened=$true} | ConvertTo-Json | Set-Content "$report/result.json"
    return
  }
  Assert-True ($status.phase -eq 'complete') ('Real upgrade did not complete: '+($status|ConvertTo-Json -Compress))
  $ackFile=$statusFile.FullName -replace '\.status\.json$','.ack.json'; $ack=Read-Json $ackFile
  Assert-True ($ack.ok -and $ack.version -eq '1.1.86') 'Target startup did not acknowledge success'
  Assert-True ((Read-Json "$program/resources/app/package.json").version -eq '1.1.86') 'Target program was not installed'
  Assert-True ((Get-FileHash "$profile/data/acceptance-preserve.json").Hash -eq $receiptHash) 'Original receipt changed'
  [pscustomobject]@{ok=$true;source='1.1.64';target='1.1.86';originalInstallerExecuted=$true;publishedTargetInstallerExecuted=$true;nativeAssistantClicked=$true;startupAck=$ack;originalReceiptPreserved=$true;prevalidatedDownloadCache=$true;remoteCustomerComputerVerified=$false;profile=$profile} | ConvertTo-Json -Depth 6 | Set-Content "$report/result.json" -Encoding UTF8
} catch {
  $_ | Out-String | Set-Content "$report/error.txt"
  Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Depth 3 | Set-Content "$report/processes.json"
  if($assistant){[SandboxClose]::Inspect($assistant.Id) | ConvertTo-Json | Set-Content "$report/native-window.json"}
  Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Json | Set-Content "$report/space.json"
  throw
} finally { if($fault){Stop-Job $fault -ErrorAction SilentlyContinue;Remove-Job $fault -Force -ErrorAction SilentlyContinue};Stop-Transcript }
