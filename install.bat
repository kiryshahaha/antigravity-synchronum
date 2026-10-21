@echo off
chcp 65001 >nul
title Synchronum Setup - Antigravity 2.0
echo.
echo ========================================================
echo   [Synchronum] One-Click Environment Setup
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not found in PATH!
  echo Please install Node.js v20 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [*] Installing Synchronum plugin into Antigravity 2.0...
cd /d "%~dp0"
node --experimental-sqlite ./dist/cli.js setup

echo.
echo ========================================================
echo   [OK] Setup completed!
echo   Restart Antigravity 2.0 or press Ctrl+R
echo   Synchronum panel will be available in Auxiliary Bar.
echo ========================================================
echo.
pause
