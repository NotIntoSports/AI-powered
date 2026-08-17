@echo off
setlocal
cd /d "%~dp0"
echo Checking AI Virtual Assistant environment...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\check-environment.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %CHECK_EXIT%
