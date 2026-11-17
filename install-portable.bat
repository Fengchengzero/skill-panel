@echo off
setlocal
cd /d "%~dp0"

REM Portable installer: no NSIS, no admin, no WebView2 download during setup.
set "SRC=%~dp0release\skill-panel-portable.exe"
if not exist "%SRC%" set "SRC=%~dp0src-tauri\target\release\skill-panel.exe"
if not exist "%SRC%" (
  echo [ERROR] Portable exe not found. Run build-win.bat first, or place
  echo         release\skill-panel-portable.exe next to this script.
  pause
  exit /b 1
)

set "DEST=%LOCALAPPDATA%\Skill Panel"
mkdir "%DEST%" 2>nul
copy /Y "%SRC%" "%DEST%\skill-panel.exe" >nul
if errorlevel 1 (
  echo [ERROR] Copy failed.
  pause
  exit /b 1
)

REM Desktop shortcut
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Skill Panel.lnk');" ^
  "$s.TargetPath='%DEST%\skill-panel.exe'; $s.WorkingDirectory='%DEST%'; $s.Description='Skill Panel'; $s.Save()"

REM Start Menu shortcut
powershell -NoProfile -Command ^
  "$dir=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Skill Panel'; New-Item -ItemType Directory -Force -Path $dir | Out-Null;" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $dir 'Skill Panel.lnk'));" ^
  "$s.TargetPath='%DEST%\skill-panel.exe'; $s.WorkingDirectory='%DEST%'; $s.Save()"

echo.
echo  Installed to: %DEST%
echo  Desktop shortcut created.
echo  If Windows SmartScreen appears: More info -^> Run anyway
echo  If the window is blank, install WebView2 Runtime:
echo  https://developer.microsoft.com/microsoft-edge/webview2/
echo.
start "" "%DEST%\skill-panel.exe"
pause
