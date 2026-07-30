param(
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"

function Run-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host ""
  Write-Host ("== {0} ==" -f $Name)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw ("step failed: {0}" -f $Name)
  }
}

function Resolve-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { return "" }
  return $cmd.Source
}

function Resolve-OptionalPythonPath {
  if ($Python) { return $Python }

  $pathPython = Resolve-CommandPath "python"
  if ($pathPython) { return $pathPython }

  $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  if (Test-Path -LiteralPath $bundledPython) { return $bundledPython }

  return ""
}

function Write-PythonImportStatus {
  param(
    [string]$PythonPath,
    [string]$Module
  )
  try {
    & $PythonPath -c "import $Module" *> $null
    $importExitCode = $LASTEXITCODE
  } catch {
    $importExitCode = 1
  }
  if ($importExitCode -eq 0) {
    Write-Host ("{0}: OK" -f $Module)
  } else {
    Write-Host ("{0}: MISSING" -f $Module)
  }
  $global:LASTEXITCODE = 0
}

function Assert-NoSensitiveStatusPaths {
  $statusLines = git status --short --untracked-files=all
  $blocked = @()
  foreach ($line in $statusLines) {
    $path = $line.Substring([Math]::Min(3, $line.Length)).Trim()
    if (
      $path -eq ".env" -or
      $path.StartsWith(".env/") -or
      $path.StartsWith("instance/") -or
      $path.StartsWith("instance\") -or
      $path.StartsWith("test_batch_input/") -or
      $path.StartsWith("test_batch_input\")
    ) {
      $blocked += $line
    }
  }
  if ($blocked.Count -gt 0) {
    Write-Host "blocked paths detected in git status:"
    foreach ($line in $blocked) {
      Write-Host $line
    }
    throw "sensitive or local-only path is visible to git"
  }
  Write-Host "no sensitive/local-only paths visible to git status"

  if (Test-Path -LiteralPath "test_batch_input") {
    git check-ignore --quiet "test_batch_input/"
    if ($LASTEXITCODE -ne 0) {
      throw "test_batch_input exists but is not ignored by git"
    }
    Write-Host "test_batch_input is ignored by git"
  }
}

function Get-StatusPaths {
  $paths = @()
  $statusLines = git status --short --untracked-files=all
  foreach ($line in $statusLines) {
    if (-not $line.Trim()) { continue }
    $path = $line.Substring([Math]::Min(3, $line.Length)).Trim()
    if ($path) {
      $paths += $path
    }
  }
  return $paths
}

function Write-GitStatusSummary {
  $statusLines = @(git status --short --untracked-files=all)
  $modifiedCount = 0
  $untrackedCount = 0
  $totalCount = 0
  foreach ($line in $statusLines) {
    if (-not $line.Trim()) { continue }
    $path = $line.Substring([Math]::Min(3, $line.Length)).Trim()
    if (
      $path.StartsWith("test_batch_input/") -or
      $path.StartsWith("test_batch_input\")
    ) {
      continue
    }
    $totalCount += 1
    $statusCode = $line.Substring(0, [Math]::Min(2, $line.Length))
    if ($statusCode -eq "??") {
      $untrackedCount += 1
    } else {
      $modifiedCount += 1
    }
  }
  Write-Host ("worktree summary: {0} modified, {1} untracked, {2} total" -f $modifiedCount, $untrackedCount, $totalCount)
}

function Assert-NoSensitiveContentInStatusFiles {
  $patterns = @(
    @{ Name = "private key block"; Regex = "-----BEGIN (RSA |OPENSSH |DSA |EC |)PRIVATE KEY-----" },
    @{ Name = "aws access key"; Regex = "AKIA[0-9A-Z]{16}" },
    @{ Name = "long secret assignment"; Regex = "(?i)\b(secret|api[_-]?key|token|password)\s*=\s*['""]?[A-Za-z0-9_/\+=\.-]{24,}" },
    @{ Name = "openai-style key"; Regex = "\bsk-[A-Za-z0-9_-]{20,}" }
  )
  $findings = @()
  foreach ($path in Get-StatusPaths) {
    if (
      $path.StartsWith("test_batch_input/") -or
      $path.StartsWith("test_batch_input\")
    ) {
      continue
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }
    $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) {
      continue
    }
    foreach ($pattern in $patterns) {
      if ($content -match $pattern.Regex) {
        $findings += ("{0}: {1}" -f $path, $pattern.Name)
      }
    }
  }
  if ($findings.Count -gt 0) {
    Write-Host "sensitive content findings in current status files:"
    foreach ($finding in $findings) {
      Write-Host ("- {0}" -f $finding)
    }
    throw "sensitive-looking content found in current status files"
  }
  Write-Host "sensitive content scan OK: current status files"
}

function Assert-PowerShellSyntax {
  $scripts = @(
  "scripts/check_local_dev_env.ps1",
  "scripts/bootstrap_local_dev_env.ps1",
  "scripts/make_upload_ux_sample.ps1",
    "scripts/verify_2026_05_27_handoff_all.ps1"
  )
  foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      (Resolve-Path -LiteralPath $script).Path,
      [ref]$tokens,
      [ref]$errors
    ) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
      Write-Host ("PowerShell syntax errors in {0}:" -f $script)
      foreach ($errorItem in $errors) {
        Write-Host ("- {0}" -f $errorItem.Message)
      }
      throw ("PowerShell syntax check failed: {0}" -f $script)
    }
    Write-Host ("PowerShell syntax OK: {0}" -f $script)
  }
}

function Assert-BootstrapPlanOnly {
  $venvPath = ".venv"
  $hadVenvBefore = Test-Path -LiteralPath $venvPath
  $output = powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 2>&1
  $exitCode = $LASTEXITCODE
  $outputText = ($output | Out-String)
  if ($exitCode -ne 0) {
    Write-Host $outputText
    throw "bootstrap plan-only check failed"
  }
  foreach ($snippet in @(
    "Plan only; no files will be changed and no network access will be used.",
    "Would run:",
    "-ConfirmInstall"
  )) {
    if (-not $outputText.Contains($snippet)) {
      Write-Host $outputText
      throw ("bootstrap plan-only output missing snippet: {0}" -f $snippet)
    }
  }
  $hasVenvAfter = Test-Path -LiteralPath $venvPath
  if (-not $hadVenvBefore -and $hasVenvAfter) {
    throw "bootstrap plan-only created .venv unexpectedly"
  }
  Write-Host "bootstrap local dev env plan-only OK: no files changed, no network install"
}

Write-Host "2026-05-27 product-detail handoff verification"
Write-Host "This script is read-only: no installs, no network, no API calls."

$node = Resolve-CommandPath "node"
if (-not $node) {
  throw "node is required for handoff verification but was not found in PATH"
}

Run-Step "local dev environment probe" {
  if ($Python) {
    powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1 -Python $Python
  } else {
    powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1
  }
}

Run-Step "Codex bundled Python dependency boundary" {
  $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  if (Test-Path -LiteralPath $bundledPython) {
    Write-Host ("Codex bundled Python dependency probe: {0}" -f $bundledPython)
    Write-PythonImportStatus -PythonPath $bundledPython -Module "flask"
    Write-PythonImportStatus -PythonPath $bundledPython -Module "pytest"
    Write-PythonImportStatus -PythonPath $bundledPython -Module "playwright"
  } else {
    Write-Host "Codex bundled Python dependency probe skipped: bundled Python missing"
  }
}

Run-Step "PowerShell syntax checks" {
  Assert-PowerShellSyntax
}

Run-Step "bootstrap plan-only safety check" {
  Assert-BootstrapPlanOnly
}

Run-Step "planning path checks" {
  & $node scripts/verify_2026_05_27_planning_paths.js
}

Run-Step "commit manifest coverage check" {
  & $node scripts/verify_2026_05_27_commit_manifest.js
}

Run-Step "batch upload UX dependency-light checks" {
  $pythonForStatic = Resolve-OptionalPythonPath
  if ($pythonForStatic) {
    $previousPythonEnv = $env:PYTHON
    $env:PYTHON = $pythonForStatic
    try {
      & $node scripts/verify_batch_upload_ux_all.js
    } finally {
      $env:PYTHON = $previousPythonEnv
    }
  } else {
    & $node scripts/verify_batch_upload_ux_all.js
  }
}

Run-Step "git diff whitespace check" {
  git diff --check
}

Run-Step "sensitive/local ignored path guard" {
  Assert-NoSensitiveStatusPaths
}

Run-Step "sensitive content scan" {
  Assert-NoSensitiveContentInStatusFiles
}

Run-Step "upload UX sample guard" {
  $samplePath = "test_batch_input\upload_ux_sample"
  if (-not (Test-Path -LiteralPath $samplePath)) {
    throw ("upload UX sample path is missing: {0}" -f $samplePath)
  }
  Write-Host ("upload UX sample path exists: {0}" -f $samplePath)

  $sampleDirs = @(Get-ChildItem -LiteralPath $samplePath -Directory)
  $expectedSampleDirs = @("sample-product-a", "sample-product-b")
  $requiredSampleFiles = @("main.png", "detail-1.png", "info.txt")
  $sampleProductFileCount = 0
  foreach ($expectedDir in $expectedSampleDirs) {
    $expectedDirPath = Join-Path $samplePath $expectedDir
    if (Test-Path -LiteralPath $expectedDirPath) {
      foreach ($requiredFile in $requiredSampleFiles) {
        if (Test-Path -LiteralPath (Join-Path $expectedDirPath $requiredFile)) {
          $sampleProductFileCount += 1
        }
      }
    }
  }
  if ($sampleDirs.Count -lt 2 -or $sampleProductFileCount -lt 6) {
    throw ("upload UX sample is incomplete: {0} product dirs, {1} product files" -f $sampleDirs.Count, $sampleProductFileCount)
  }
  Write-Host ("upload UX sample content OK: {0} product dirs, {1} product files" -f $sampleDirs.Count, $sampleProductFileCount)

  foreach ($expectedDir in $expectedSampleDirs) {
    if (-not (Test-Path -LiteralPath (Join-Path $samplePath $expectedDir))) {
      throw ("upload UX sample product dir is missing: {0}" -f $expectedDir)
    }
  }
  Write-Host "upload UX sample product dirs OK: sample-product-a, sample-product-b"

  foreach ($expectedDir in $expectedSampleDirs) {
    $sampleDir = Get-Item -LiteralPath (Join-Path $samplePath $expectedDir)
    foreach ($requiredFile in $requiredSampleFiles) {
      $requiredPath = Join-Path $sampleDir.FullName $requiredFile
      if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw ("upload UX sample product is missing {0}: {1}" -f $requiredFile, $sampleDir.Name)
      }
      $requiredItem = Get-Item -LiteralPath $requiredPath
      if ($requiredItem.Length -le 0) {
        throw ("upload UX sample product file is empty: {0}" -f $requiredPath)
      }
    }
    foreach ($pngFile in @("main.png", "detail-1.png")) {
      $pngPath = Join-Path $sampleDir.FullName $pngFile
      $pngItem = Get-Item -LiteralPath $pngPath
      if ($pngItem.Length -lt 8) {
        throw ("upload UX sample image is too small for PNG header: {0}" -f $pngPath)
      }
      $pngHeader = [System.IO.File]::ReadAllBytes($pngPath)[0..7]
      $expectedHeader = @(137, 80, 78, 71, 13, 10, 26, 10)
      for ($i = 0; $i -lt $expectedHeader.Count; $i++) {
        if ($pngHeader[$i] -ne $expectedHeader[$i]) {
          throw ("upload UX sample image is not PNG: {0}" -f $pngPath)
        }
      }
    }
    $infoPath = Join-Path $sampleDir.FullName "info.txt"
    $infoText = Get-Content -LiteralPath $infoPath -Raw
    if (-not $infoText.Contains("synthetic upload UX browser validation sample") -or -not $infoText.Contains("no real customer data")) {
      throw ("upload UX sample info.txt is missing synthetic/no-customer-data markers: {0}" -f $infoPath)
    }
  }
  Write-Host "upload UX sample product files OK: main.png, detail-1.png, info.txt"
  Write-Host "upload UX sample product files are non-empty"
  Write-Host "upload UX sample PNG headers OK: main.png, detail-1.png"
  Write-Host "upload UX sample info markers OK: synthetic sample, no real customer data"
}

$pythonToUse = Resolve-OptionalPythonPath
if ($pythonToUse) {
  Run-Step "optional Python static upload UX check" {
    Write-Host ("using Python static verifier: {0}" -f $pythonToUse)
    & $pythonToUse scripts/verify_batch_upload_ux_static.py
  }
} else {
  Write-Host ""
  Write-Host "== optional Python static upload UX check =="
  Write-Host "skipped: no PATH python, no -Python override, and no Codex bundled Python"
}

Write-Host ""
Write-Host "== git working tree status =="
git status --short
Write-GitStatusSummary

Write-Host ""
Write-Host "handoff verification passed"
Write-Host "recommended route:"
Write-Host "1 first: commit current worktree to freeze handoff and validation assets"
Write-Host "2 next: restore Python/Flask environment and browser-test /batch/upload"
Write-Host "next decision options:"
Write-Host "1. commit current worktree"
Write-Host "2. restore Python/Flask environment"
Write-Host "3. planning only; no code/install/network/API"
Write-Host "entry docs:"
Write-Host "commit: docs/2026-05-27_commit-manifest.md"
Write-Host "environment: docs/2026-05-27_python-flask-env-recovery-options.md"
Write-Host "actions: docs/2026-05-27_next-action-tracker.md"
