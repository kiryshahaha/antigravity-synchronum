@echo off
chcp 65001 >nul
echo [*] Stopping Synchronum background service...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 42125 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo [✓] Synchronum stopped.
