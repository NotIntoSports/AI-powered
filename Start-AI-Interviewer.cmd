@echo off
setlocal
cd /d "%~dp0"
echo [deprecated] Use Start-AI-Virtual-Assistant.cmd
call "%~dp0Start-AI-Virtual-Assistant.cmd"
exit /b %ERRORLEVEL%
