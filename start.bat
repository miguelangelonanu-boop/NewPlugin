@echo off
rem ---------------------------------------------------------------
rem  StudioPilot Bridge launcher (Windows)
rem  Double-click this file. It finds Python, makes sure the
rem  `websockets` package is installed and starts the bridge.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"
mkdir logs 2>nul

echo [StudioPilot] Starting bridge...

rem ---- find a Python interpreter --------------------------------------
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  where python3 >nul 2>nul && set "PY=python3"
)
if not defined PY (
  echo.
  echo [StudioPilot] ERROR: Python was not found.
  echo Install Python 3.9+ from https://www.python.org/downloads/
  echo ^(tick "Add python.exe to PATH" during install^), then run this file again.
  echo.
  pause
  exit /b 1
)

rem ---- make sure the websockets package is available -------------------
%PY% -c "import websockets" >nul 2>nul
if errorlevel 1 (
  echo [StudioPilot] Installing the 'websockets' package (first run only)...
  %PY% -m pip install --user websockets >>logs\start.log 2>&1
  %PY% -c "import websockets" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [StudioPilot] ERROR: could not install 'websockets'.
    echo Check your internet connection, or run:
    echo    %PY% -m pip install --user websockets
    echo See logs\start.log for details.
    echo.
    pause
    exit /b 1
  )
)

rem ---- avoid a double launch -------------------------------------------
findstr /c:"%PID% " logs\bridge.pid >nul 2>nul

rem ---- run -------------------------------------------------------------
echo [StudioPilot] Bridge starting - keep this window open.
echo [StudioPilot] Log: %cd%\logs\bridge.log
echo.
%PY% bridge.py
echo.
echo [StudioPilot] Bridge exited.
pause
