@echo off
title AutoEditor (Video + Audio Editor Studio)
cd /d "%~dp0"

echo ======================================================================
echo   AutoEditor v2 -- Video and Audio Editor Studio
echo ======================================================================
echo.

:: Clean up any previously stuck processes on port 4000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4000 ^| findstr LISTENING') do (
    echo Freeing port 4000 from old instance (PID: %%a)
    taskkill /F /PID %%a >nul 2>&1
)

:: Set environment variables
set FFMPEG_PATH=%~dp0ffmpeg.exe
set CAPTION_FONT_PATH=%~dp0caption.ttf
set FRONTEND_DIR=%~dp0out
set PORT=4000
set OPEN_BROWSER=1

echo.
echo ======================================================================
echo   WEBSITE LINK:  http://localhost:4000
echo ======================================================================
echo.
echo   - 🎬 Video Editor: Sync timestamped images + voiceover to MP4
echo   - 🎙️ Audio Editor: Upload voiceover, cut silence, download clean MP3
echo.
echo   Keep this black window open while working!
echo   Close this window or press Ctrl+C when you want to exit.
echo ======================================================================
echo.

:: Check for node.exe in current folder or PATH
if exist "%~dp0node.exe" (
    "%~dp0node.exe" bundle.cjs
) else (
    node bundle.cjs
)

pause
