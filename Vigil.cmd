@echo off
rem One-click start for Vigil on Windows: runs scripts/vigil.sh inside WSL and
rem opens the UI. Extra arguments are passed through (e.g. "Vigil.cmd prod").
rem Press Ctrl+C in this window to stop.

title Vigil SCC
wsl.exe --cd "%~dp0." -e bash scripts/vigil.sh dev --open %*
if errorlevel 1 if not errorlevel 130 pause
