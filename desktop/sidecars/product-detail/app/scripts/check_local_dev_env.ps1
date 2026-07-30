param(
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"

function Write-Item {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Detail = ""
  )
  if ($Detail) {
    Write-Host ("{0}: {1} - {2}" -f $Name, $Status, $Detail)
  } else {
    Write-Host ("{0}: {1}" -f $Name, $Status)
  }
}

function Resolve-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { return "" }
  return $cmd.Source
}

Write-Host "product-detail local dev environment probe"
Write-Host ("cwd: {0}" -f (Get-Location).Path)
Write-Host ""

$git = Resolve-CommandPath "git"
$node = Resolve-CommandPath "node"
$docker = Resolve-CommandPath "docker"
$dockerCompose = Resolve-CommandPath "docker-compose"
$pythonCmd = if ($Python) { $Python } else { Resolve-CommandPath "python" }
$pyLauncher = Resolve-CommandPath "py"
$pip = Resolve-CommandPath "pip"
$bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$hasBundledPython = Test-Path -LiteralPath $bundledPython
$commonPythonRoots = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Python"),
  "C:\Program Files",
  "C:\Program Files (x86)"
)

Write-Item "git" ($(if ($git) { "OK" } else { "MISSING" })) $git
Write-Item "node" ($(if ($node) { "OK" } else { "MISSING" })) $node
Write-Item "docker" ($(if ($docker) { "OK" } else { "MISSING" })) $docker
Write-Item "docker-compose" ($(if ($dockerCompose) { "OK" } else { "MISSING" })) $dockerCompose
Write-Item "python" ($(if ($pythonCmd) { "OK" } else { "MISSING" })) $pythonCmd
Write-Item "py launcher" ($(if ($pyLauncher) { "OK" } else { "MISSING" })) $pyLauncher
Write-Item "pip" ($(if ($pip) { "OK" } else { "MISSING" })) $pip
Write-Item "Codex bundled Python" ($(if ($hasBundledPython) { "OK" } else { "MISSING" })) ($(if ($hasBundledPython) { "$bundledPython - stdlib static checks only, not the project Flask env" } else { "" }))

Write-Host ""

$venvCandidates = @(
  ".venv\Scripts\python.exe",
  "venv\Scripts\python.exe",
  ".venv\bin\python",
  "venv\bin\python"
)

$foundVenv = @()
foreach ($candidate in $venvCandidates) {
  if (Test-Path -LiteralPath $candidate) {
    $foundVenv += $candidate
  }
}

if ($foundVenv.Count -gt 0) {
  Write-Item "local venv" "OK" ($foundVenv -join ", ")
} else {
  Write-Item "local venv" "MISSING" "no .venv/venv Python executable found"
}

$commonPythonCandidates = @()
foreach ($root in $commonPythonRoots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $commonPythonCandidates += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "Python*" } |
    ForEach-Object {
      $candidate = Join-Path $_.FullName "python.exe"
      if (Test-Path -LiteralPath $candidate) { $candidate }
    }
}

if ($commonPythonCandidates.Count -gt 0) {
  Write-Item "common Python candidates" "OK" (($commonPythonCandidates | Select-Object -Unique) -join ", ")
} else {
  Write-Item "common Python candidates" "MISSING" "none found in LocalAppData/Programs/Python or Program Files"
}

Write-Item "requirements.txt" ($(if (Test-Path -LiteralPath "requirements.txt") { "OK" } else { "MISSING" })) "required for local Flask recovery"
Write-Item "app.py" ($(if (Test-Path -LiteralPath "app.py") { "OK" } else { "MISSING" })) "Flask entry candidate"
Write-Item "tests/test_batch_upload_ux.py" ($(if (Test-Path -LiteralPath "tests/test_batch_upload_ux.py") { "OK" } else { "MISSING" })) "upload UX guard"
Write-Item "tests/test_batch_progress_ui.py" ($(if (Test-Path -LiteralPath "tests/test_batch_progress_ui.py") { "OK" } else { "MISSING" })) "batch progress UI guard"
Write-Item "tests/test_batch_pipeline_smoke.py" ($(if (Test-Path -LiteralPath "tests/test_batch_pipeline_smoke.py") { "OK" } else { "MISSING" })) "batch pipeline smoke guard"

if (-not $pythonCmd) {
  Write-Host ""
  Write-Host "Python import checks skipped: no PATH python and no -Python override."
  Write-Host "Next: provide -Python C:\path\to\python.exe or restore PATH/.venv."
  exit 0
}

Write-Host ""
Write-Host "Python version:"
& $pythonCmd --version

Write-Host ""
Write-Host "Python import checks:"
$imports = @("flask", "pytest", "playwright")
foreach ($module in $imports) {
  try {
    & $pythonCmd -c "import $module; print('$module OK')" *> $null
    $importExitCode = $LASTEXITCODE
  } catch {
    $importExitCode = 1
  }
  if ($importExitCode -eq 0) {
    Write-Item $module "OK"
  } else {
    Write-Item $module "MISSING"
  }
}

Write-Host ""
Write-Host "Probe complete. No files were modified."
