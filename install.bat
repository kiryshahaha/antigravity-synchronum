@echo off
chcp 65001 >nul
title Synchronum Setup - Antigravity 2.0
echo.
echo ========================================================
echo   🚀 Synchronum v1.0.0: One-Click Environment Setup
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ❌ Node.js не найден в вашей системе PATH!
  echo Пожалуйста, установите Node.js (v20 или новее) с https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo 📦 Установка плагина Synchronum в Antigravity 2.0...
cd /d "%~dp0"
node --experimental-sqlite ./dist/cli.js setup

echo.
echo ========================================================
echo   ✅ Установка завершена!
echo   Перезапустите Antigravity 2.0 или нажмите Ctrl+R
echo   Панель Synchronum доступна во вспомогательной панели справа.
echo ========================================================
echo.
pause
