@echo off
REM AMCN Verifier panel launcher for Windows (INSTALL.md section 6).
REM
REM Usage, from a Command Prompt or by double-clicking after editing HUB below:
REM   panel.cmd 192.168.1.10
REM   panel.cmd 192.168.1.10 47180 3
REM
REM A .cmd rather than a .ps1 on purpose: PowerShell refuses to run unsigned
REM scripts by default, and a batch file has no such restriction. All it does
REM is call panel.js, which is where the real logic lives.

setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found on PATH. Install Node 20+ from https://nodejs.org
  echo then reopen this window.
  pause
  exit /b 1
)

set HUB=%1
if "%HUB%"=="" set HUB=127.0.0.1

node "%~dp0panel.js" %HUB% %2 %3
set RC=%errorlevel%
if not "%RC%"=="0" pause
exit /b %RC%
