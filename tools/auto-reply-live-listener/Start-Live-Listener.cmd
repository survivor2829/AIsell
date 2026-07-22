@echo off
setlocal
title AI Customer Auto Reply Live Listener

set "LOG=%USERPROFILE%\Desktop\AutoReply-Live-Listener-launch.log"
echo Starting live listener... > "%LOG%"
echo Script folder: %~dp0 >> "%LOG%"
echo Started at: %DATE% %TIME% >> "%LOG%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0AutoReply-Live-Listener.ps1" -DurationSeconds 180 -IntervalSeconds 2 >> "%LOG%" 2>&1
set "RESULT=%ERRORLEVEL%"

echo. >> "%LOG%"
echo Exit code: %RESULT% >> "%LOG%"
type "%LOG%"
echo.
if not "%RESULT%"=="0" (
  echo Listener failed. Send AutoReply-Live-Listener-launch.log from the Desktop.
) else (
  echo Listener completed. Send the AutoReply-Live-Trace ZIP from the Desktop.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b %RESULT%
