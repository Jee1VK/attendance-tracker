@echo off
title Staff Attendance Tracker (NAS Multi-PC Launcher)
:: Launch PowerShell runner which natively supports NAS network share paths (UNC) across all PCs
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
