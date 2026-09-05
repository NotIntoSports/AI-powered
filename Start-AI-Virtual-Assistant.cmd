@echo off
setlocal
cd /d "%~dp0"
echo Starting AI Virtual Assistant...
call npm run tauri:dev
if errorlevel 1 (
  echo.
  echo Startup failed. Review the message above.
  pause
  exit /b 1
)
exit /b 0
