@echo off
echo ========================================================
echo Starting AI Interview Agent Services...
echo ========================================================

:: 1. Start LiveKit Server in a new window
echo Starting LiveKit Server...
start "LiveKit Server" cmd /c "title LiveKit Server && .\livekit-server.exe --dev || pause"

:: Wait 2 seconds for LiveKit to boot up
timeout /t 2 /nobreak > nul

:: 2. Start Token Server in a new window
echo Starting Token Server...
start "Token Server" cmd /c "title Token Server && cd token-server && node server.js || pause"

:: Wait 2 seconds for Token Server to start
timeout /t 2 /nobreak > nul

:: 3. Start Agent Node in a new window
echo Starting Agent Node...
start "Agent Node" cmd /c "title Agent Node && cd agent-node && node agent.js dev || pause"

echo.
echo ========================================================
echo All services have been launched in separate windows!
echo - LiveKit Server
echo - Token Server
echo - Agent Node
echo.
echo You can now open your frontend or close this window.
echo (To stop the services, just close the new command windows).
echo ========================================================
pause
