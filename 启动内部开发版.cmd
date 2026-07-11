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
start "" "%CD%\node_modules\electron\dist\electron.exe" .
endlocal
