@echo off
setlocal
cd /d "%~dp0"
echo AI Virtual Assistant first-time setup
echo.
echo [Y] Install npm dependencies, OBS, and the production application.
echo [Q] Quit without installing.
echo.
choice /C YQ /N /M "Choose Y to install or Q to quit: "
if errorlevel 2 exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-windows.ps1"

:finished
if errorlevel 1 goto failed
echo.
echo Setup completed. Running environment check...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\check-environment.ps1"
echo.
pause
exit /b 0

:failed
echo.
echo Setup failed. Review the message above.
pause
exit /b 1
