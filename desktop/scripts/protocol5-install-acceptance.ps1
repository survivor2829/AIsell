param([ValidateSet('Install','Fault','Window')][string]$Mode,[string]$Scenario,[string]$Executable,[string]$File,[string]$Jobs,[string]$PackageHash,[string]$TargetVersion,[string]$Report)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'GitHub disposable Windows runner required' }
if ($Mode -eq 'Install') {
  $p=Start-Process -FilePath $File -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  if($p.ExitCode -ne 0){throw 'Published source NSIS failed'}
  return
}
$until=if($Mode -eq 'Window'){(Get-Date).AddMinutes(2)}else{(Get-Date).AddMinutes(18)}
while((Get-Date) -lt $until) {
  if($Mode -eq 'Window') {
    $window=Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $Executable -and $_.MainWindowHandle -ne 0 -and $_.Responding} | Select-Object -First 1
    if($window){[pscustomobject]@{pid=$window.Id;executable=$window.Path;creation=$window.StartTime;responding=$true} | ConvertTo-Json -Compress;return}
  } else {
    foreach($statusFile in (Get-ChildItem -LiteralPath $Jobs -Filter '*.status.json' -ErrorAction SilentlyContinue)) {
      try{$state=Get-Content -LiteralPath $statusFile.FullName -Raw | ConvertFrom-Json}catch{continue}
      $target=$null;$changed=$false;$jobId=$statusFile.Name -replace '\.status\.json$',''
      $package=Join-Path (Split-Path $Executable) 'resources/app/package.json'
      if($Scenario -eq 'installer-interruption' -and $state.phase -eq 'installing') {
        try{$changed=!(Test-Path -LiteralPath $package) -or (Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant() -ne $PackageHash}catch{$changed=$false}
        if($changed){$target=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $File} | Select-Object -First 1}
      } elseif($Scenario -eq 'startup-interruption' -and $state.phase -eq 'starting') {
        if(Test-Path -LiteralPath (Join-Path $Jobs ($jobId+'.ack.json'))){throw 'Startup already acknowledged; cannot claim startup fault'}
        try{$changed=(Get-Content -LiteralPath $package -Raw | ConvertFrom-Json).version -eq $TargetVersion}catch{$changed=$false}
        if($changed){$target=Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $Executable -and $_.CommandLine -match ('--xiaoxi-updated-launch\s+'+[regex]::Escape($jobId)+'(?:\s|$)')} | Select-Object -First 1}
      }
      if($target) {
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$target.ProcessId)
        if(!$current -or $current.CreationDate -ne $target.CreationDate -or $current.ExecutablePath -ne $target.ExecutablePath){throw 'Fault process identity changed'}
        if($Scenario -eq 'startup-interruption' -and (Test-Path -LiteralPath (Join-Path $Jobs ($jobId+'.ack.json')))){throw 'Startup acknowledged before interruption'}
        & taskkill.exe /PID $target.ProcessId /T /F | Out-Null
        if($LASTEXITCODE -ne 0){throw 'Real process interruption failed'}
        [pscustomobject]@{scenario=$Scenario;pid=$target.ProcessId;executable=$target.ExecutablePath;creation=$target.CreationDate;phase=$state.phase;programMutationObserved=$changed} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Report 'fault.json') -Encoding utf8
        return
      }
    }
  }
  Start-Sleep -Milliseconds 100
}
throw ('Real '+$Mode+' condition not reached')
