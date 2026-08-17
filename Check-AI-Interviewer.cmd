@echo off
setlocal
cd /d "%~dp0"
echo [deprecated] Use Check-AI-Virtual-Assistant.cmd
call "%~dp0Check-AI-Virtual-Assistant.cmd"
exit /b %ERRORLEVEL%
