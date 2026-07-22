@echo off
chcp 65001 >nul
title AI获客异机诊断收集

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0收集异机诊断.ps1"
if errorlevel 1 (
  echo.
  echo 诊断收集失败，请把本窗口截图发给开发人员。
  pause
  exit /b 1
)

echo.
echo 诊断收集完成，桌面已生成 AI获客诊断 ZIP。
pause

