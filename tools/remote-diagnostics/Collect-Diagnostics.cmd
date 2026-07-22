@echo off
setlocal
title AI Customer Diagnostics

set "LOG=%USERPROFILE%\Desktop\AI-Customer-Diagnostics-launch.log"
echo Starting diagnostics collector... > "%LOG%"
echo Script folder: %~dp0 >> "%LOG%"
echo Started at: %DATE% %TIME% >> "%LOG%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Collect-Diagnostics.ps1" >> "%LOG%" 2>&1
set "RESULT=%ERRORLEVEL%"

echo. >> "%LOG%"
echo Exit code: %RESULT% >> "%LOG%"
type "%LOG%"
echo.

if not "%RESULT%"=="0" (
  echo Diagnostics failed. Send AI-Customer-Diagnostics-launch.log from the Desktop.
) else (
  echo Diagnostics completed. Send the AI-Customer-Diagnostics ZIP from the Desktop.
)

echo.
echo Press any key to close this window.
pause >nul
exit /b %RESULT%
