@echo off
chcp 65001 >nul
title Synchronum Uninstall - Antigravity 2.0
echo.
echo ========================================================
echo   🧹 Synchronum: Полное удаление с этого устройства
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ❌ Node.js не найден в вашей системе PATH!
  pause
  exit /b 1
)

cd /d "%~dp0"
node --experimental-sqlite ./dist/cli.js uninstall

echo.
echo ========================================================
echo   ✅ Удаление завершено!
echo ========================================================
echo.
pause
