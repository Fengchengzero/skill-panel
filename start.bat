@echo off
setlocal
cd /d "%~dp0"

REM First click: reopen this script minimized so the console stays out of the way.
REM Restore it from the taskbar to see logs or stop the app (Ctrl+C / close).
if /i not "%~1"=="--min" (
  start "Skill Panel" /min cmd /c ""%~f0" --min"
  exit /b 0
)

echo.
echo  Skill Panel - running (minimized).
echo  Restore this window to view logs, or close it to stop.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

call npm run tauri dev
echo.
echo App exited.
pause
