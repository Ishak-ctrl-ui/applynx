@echo off
cd /d "%~dp0"
echo Starting appkittie-clone on http://localhost:8001 ...
echo Keep this window open. Press Ctrl+C to stop.
python server.py
if errorlevel 1 (
  echo.
  echo Server stopped or failed to start. Is Python installed?
  pause
)
