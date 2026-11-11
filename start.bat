@echo off
chcp 65001 >nul
title 3X-UI Easy Installer - czlab.dev style
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

echo.
echo   3X-UI Easy Installer is starting...
echo   Your browser should open automatically. If not, visit:
echo   http://127.0.0.1:3930
echo.
start "" "http://127.0.0.1:3930"
node server.js
pause
