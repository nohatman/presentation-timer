@echo off
rem Foxy Local Show Server - double-click to manage the local server (start, stop,
rem restart, open Control/Display, see the LAN address). All logic lives in
rem tools\local-server\foxy-local.js; this is only the entry point.
rem Extra arguments are passed through, e.g.:  Foxy-Local-Show-Server.bat status
title Foxy Local Show Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC. Install Node.js 20 or newer, then run this again.
  pause
  exit /b 1
)
node "tools\local-server\foxy-local.js" %*
if errorlevel 1 if "%~1"=="" pause
