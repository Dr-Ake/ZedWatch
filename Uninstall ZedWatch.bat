@echo off
setlocal EnableExtensions
title Uninstall ZedWatch
cd /d "%~dp0"

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0'"
  exit /b
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Uninstall-ZedWatch.ps1"
if errorlevel 1 (
  echo.
  echo ZedWatch could not be uninstalled safely.
  pause
  exit /b 1
)
pause
exit /b 0
