@echo off
setlocal
cd /d "%~dp0"

echo.
echo  Skill Panel - building Windows installer...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

where rustc >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Rust not found. Install from https://rustup.rs
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

call npm run build:win
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo  Done. Installer:
echo  src-tauri\target\release\bundle\nsis\
dir /b "src-tauri\target\release\bundle\nsis\*.exe" 2>nul
echo.
echo  Double-click the .exe to install (current user, no admin needed).
echo.
pause
