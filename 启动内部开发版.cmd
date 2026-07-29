@echo off
setlocal
cd /d "%~dp0desktop"

if not exist "dist-development\index.html" (
  echo Development build is missing. Please ask Codex to rebuild it.
  pause
  exit /b 1
)

set "XIAOXI_EDITION=development"
set "VITE_XIAOXI_EDITION=development"
set "VITE_DEV_SERVER_URL=file:///%CD:\=/%/dist-development/index.html"

rem A second Electron launch only focuses the existing single instance. Stop
rem this repository's own old development processes first so the rebuilt main
rem process and renderer are actually loaded. Other Electron apps are ignored.
powershell.exe -NoProfile -NonInteractive -Command ^
  "$target = [IO.Path]::GetFullPath('%CD%\node_modules\electron\dist\electron.exe'); Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target } | Stop-Process -Force"
timeout /t 1 /nobreak >nul

start "" "%CD%\node_modules\electron\dist\electron.exe" .
endlocal
