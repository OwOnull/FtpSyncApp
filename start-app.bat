@echo off
setlocal
cd /d %~dp0

echo [FtpSyncApp] checking dependencies...
if not exist "node_modules" (
  echo [FtpSyncApp] node_modules not found, installing...
  call npm install
  if errorlevel 1 (
    echo [FtpSyncApp] npm install failed.
    pause
    exit /b 1
  )
)

echo [FtpSyncApp] starting app...
call npm run start
if errorlevel 1 (
  echo [FtpSyncApp] app exited with error.
  pause
  exit /b 1
)

endlocal
