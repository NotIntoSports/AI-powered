@echo off
setlocal
cd /d "%~dp0"
echo AI Virtual Assistant first-time setup
echo.
echo [M] Minimal: npm dependencies and OBS. Use manual reply input.
echo [F] Full:    Minimal plus local whisper.cpp transcription.
echo [L] Local:   Full plus Ollama and qwen3.5:4b (about 3.4GB model download).
echo [Q] Quit without installing.
echo.
choice /C MFLQ /N /M "Choose M, F, L, or Q: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto local
if errorlevel 2 goto full

:minimal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-windows.ps1" -SkipWhisper
goto finished

:full
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-windows.ps1"
goto finished

:local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-windows.ps1"
if errorlevel 1 goto failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-ollama.ps1"
goto finished

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
