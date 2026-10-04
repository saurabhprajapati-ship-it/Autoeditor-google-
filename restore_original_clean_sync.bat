@echo off
echo ===================================================
echo     AutoEditor: Restore Original Clean Silence / Sync
echo ===================================================
echo.
echo Restoring original UI without CapCut panels...
if exist "out\silence_ui.js.bak" (
    copy /Y "out\silence_ui.js.bak" "out\silence_ui.js"
    echo [OK] Restored original silence_ui.js
) else (
    echo [INFO] No backup found.
)
echo.
echo Done! Please refresh http://localhost:4000 (Ctrl + F5).
pause
