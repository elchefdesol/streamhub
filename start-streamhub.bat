@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node 20 or newer from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting StreamHub...
echo.
node server.mjs
pause
