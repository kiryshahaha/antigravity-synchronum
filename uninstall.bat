@echo off
chcp 65001 >nul
title Synchronum Uninstall - Antigravity 2.0
echo.
echo ========================================================
echo   [Synchronum] Complete removal from this device
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not found in PATH!
  pause
  exit /b 1
)

cd /d "%~dp0"
node --experimental-sqlite ./dist/cli.js uninstall

echo.
echo ========================================================
echo   [OK] Uninstall completed!
echo ========================================================
echo.
pause
