@echo off
setlocal EnableExtensions
title ZedWatch Server Studio
cd /d "%~dp0"

if not exist "%~dp0server\StartServer64.bat" (
  echo ZedWatch is not installed yet.
  echo Run "Install ZedWatch.bat" first.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manager\launch-manager.ps1"
if errorlevel 1 (
  echo.
  echo ZedWatch could not start. Run "Install ZedWatch.bat" to repair it.
  pause
  exit /b 1
)
exit /b 0
