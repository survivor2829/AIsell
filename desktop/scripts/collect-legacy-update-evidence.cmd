@echo off
chcp 65001 >nul
echo 只读采集旧版程序文件，不需要管理员权限，无需关闭软件。
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-legacy-update-evidence.ps1" %*
set collectorExit=%ERRORLEVEL%
echo.
pause
exit /b %collectorExit%
