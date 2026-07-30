@echo off
setlocal EnableExtensions
title Install ZedWatch
cd /d "%~dp0"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
  exit /b
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-ZedWatch.ps1"
if errorlevel 1 (
  echo.
  echo ZedWatch installation did not finish successfully.
  echo The error above has also been written to manager\logs\install.log when possible.
  pause
  exit /b 1
)

echo.
echo ZedWatch is ready.
pause
exit /b 0
