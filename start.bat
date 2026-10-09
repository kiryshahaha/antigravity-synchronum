@echo off
chcp 65001 >nul
title Synchronum - Google Antigravity 2.0 Sync
echo =======================================================
echo          Synchronum: Google Antigravity 2.0 Sync       
echo =======================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install
)

if not exist "dist\sidecar-server.js" (
    echo [*] Building project...
    call npm run build
)

echo [*] Registering Sidecar in Antigravity...
set "SIDECAR_TARGET=%USERPROFILE%\.gemini\antigravity\sidecars\synchronum"
if not exist "%SIDECAR_TARGET%" mkdir "%SIDECAR_TARGET%"
xcopy /s /y /q "sidecar\*" "%SIDECAR_TARGET%\" >nul 2>nul
echo [✓] Sidecar successfully registered in Antigravity!

echo.
echo [*] Launching Synchronum Dashboard...
start http://localhost:42125

echo.
echo [✓] Synchronum is running at http://localhost:42125
echo Press Ctrl+C in this window to stop the server.
echo.
node --experimental-sqlite ./dist/sidecar-server.js
