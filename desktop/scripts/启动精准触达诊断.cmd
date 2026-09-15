@echo off
setlocal
chcp 65001 >nul
title AI获客 - 精准触达诊断
cd /d "%~dp0"

if not exist "%~dp0run-touch-diagnostic.ps1" (
  echo [失败] 找不到同目录下的 run-touch-diagnostic.ps1
  echo 请把 CMD 和 PS1 两个文件放在同一个文件夹后重试。
  echo.
  pause
  exit /b 2
)

echo 正在启动精准触达诊断，请不要关闭本窗口……
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-touch-diagnostic.ps1"
set "XIAOXI_DIAG_EXIT=%ERRORLEVEL%"

echo.
if not "%XIAOXI_DIAG_EXIT%"=="0" (
  echo [诊断脚本未完成] 退出码：%XIAOXI_DIAG_EXIT%
  echo 请拍下本窗口内从“失败”或红字开始的完整内容发给开发。
) else (
  echo 诊断脚本已完成。
)
echo.
pause
exit /b %XIAOXI_DIAG_EXIT%
