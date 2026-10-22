@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Nightlight.ps1" %*
set "nightlight_exit=%errorlevel%"
if not "%nightlight_exit%"=="0" pause
exit /b %nightlight_exit%
