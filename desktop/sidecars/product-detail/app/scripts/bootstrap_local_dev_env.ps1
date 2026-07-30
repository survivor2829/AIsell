param(
  [string]$Python = "",
  [switch]$SkipPlaywrightBrowsers,
  [switch]$ConfirmInstall
)

$ErrorActionPreference = "Stop"

function Resolve-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) { return "" }
  return $cmd.Source
}

Write-Host "product-detail local Flask dev environment bootstrap"
Write-Host "Default mode is plan-only. Add -ConfirmInstall after explicit approval to create/update .venv and install dependencies."
Write-Host ""

$pythonCmd = if ($Python) { $Python } else { Resolve-CommandPath "python" }
if ((-not $pythonCmd) -and $ConfirmInstall) {
  throw "No Python found. Pass -Python C:\path\to\python.exe or install Python first."
}

if (-not (Test-Path -LiteralPath "requirements.txt")) {
  throw "requirements.txt not found. Run from the product-detail repository root."
}

if (-not $ConfirmInstall) {
  $planPython = if ($pythonCmd) { $pythonCmd } else { "python or -Python C:\path\to\python.exe" }
  Write-Host "Plan only; no files will be changed and no network access will be used."
  Write-Host ""
  Write-Host "Would run:"
  Write-Host "- $planPython -m venv .venv (if .venv is missing)"
  Write-Host "- .venv\Scripts\python.exe -m pip install --upgrade pip"
  Write-Host "- .venv\Scripts\python.exe -m pip install -r requirements.txt pytest"
  if ($SkipPlaywrightBrowsers) {
    Write-Host "- skip Playwright Chromium browser binary install"
  } else {
    Write-Host "- .venv\Scripts\python.exe -m playwright install chromium"
  }
  Write-Host ""
  Write-Host "To execute after approval:"
  Write-Host "powershell -ExecutionPolicy Bypass -File scripts/bootstrap_local_dev_env.ps1 -ConfirmInstall"
  Write-Host ""
  exit 0
}

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
  Write-Host "Creating .venv..."
  & $pythonCmd -m venv .venv
} else {
  Write-Host ".venv already exists; reusing it."
}

$venvPython = ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
  throw ".venv Python was not created at $venvPython"
}

Write-Host "Upgrading pip..."
& $venvPython -m pip install --upgrade pip

Write-Host "Installing requirements.txt and pytest..."
& $venvPython -m pip install -r requirements.txt pytest

if ($SkipPlaywrightBrowsers) {
  Write-Host "Skipping Playwright browser binary install by request."
} else {
  Write-Host "Installing Playwright Chromium browser binary..."
  & $venvPython -m playwright install chromium
}

Write-Host ""
Write-Host "Bootstrap complete. Next suggested checks:"
Write-Host "powershell -ExecutionPolicy Bypass -File scripts/check_local_dev_env.ps1 -Python .\.venv\Scripts\python.exe"
Write-Host "powershell -ExecutionPolicy Bypass -File scripts/verify_2026_05_27_handoff_all.ps1 -Python .\.venv\Scripts\python.exe"
