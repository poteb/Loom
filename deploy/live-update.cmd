@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0live-update.ps1" %*
