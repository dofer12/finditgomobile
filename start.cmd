@echo off
rem FindItGo - double-click to run the app on this PC (opens http://localhost:8080)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
if errorlevel 1 pause
