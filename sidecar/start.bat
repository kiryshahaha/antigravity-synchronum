@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --experimental-sqlite "%~dp0dist\sidecar-server.js"
