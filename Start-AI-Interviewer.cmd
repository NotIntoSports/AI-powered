@echo off
setlocal
cd /d "%~dp0"
echo Starting AI Interviewer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\start-windows.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. Review the message above and .tools\logs\next.err.log.
  pause
  exit /b 1
)
exit /b 0
