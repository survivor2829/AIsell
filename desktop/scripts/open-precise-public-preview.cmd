@echo off
cd /d "%~dp0.."
node scripts\precise-acquisition-preview.cjs --live-public
if errorlevel 1 pause
