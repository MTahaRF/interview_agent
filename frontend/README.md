# Interview Agent — LiveKit Frontend

A **zero-build** developer UI for connecting to the LiveKit Interview Agent.
Open `index.html` directly in your browser — no `npm install` needed.

---

## Quick Start (3 terminals)

### Terminal 1 — LiveKit Server
```bash
./livekit-server --dev
```

### Terminal 2 — Token Server
```bash
python token_server.py
```
This runs on `http://127.0.0.1:8081` and auto-generates JWT tokens for the frontend.

### Terminal 3 — Agent
```bash
python google-agent.py dev
```

### Open the UI
Open `frontend/index.html` in your browser (or serve it):
```bash
python -m http.server 3000 --directory frontend
```
Then go to `http://localhost:3000`.

---

## How It Works

```
┌──────────┐     WebSocket      ┌───────────────┐     gRPC/WS      ┌──────────┐
│ Frontend │ ◄═══════════════► │ LiveKit Server │ ◄═══════════════► │  Agent   │
│ (browser)│    (audio tracks)  │  :7880         │   (agent SDK)    │ (python) │
└──────────┘                    └───────────────┘                    └──────────┘
      │                                                                    
      │  GET /token                                                        
      ▼                                                                    
┌──────────────┐                                                           
│ Token Server │  Signs JWTs using LIVEKIT_API_KEY / SECRET               
│  :8081       │                                                           
└──────────────┘                                                           
```

### Connection Flow
1. Frontend calls `GET /token?room=test_room&identity=dev-user`
2. Token server returns a signed JWT
3. Frontend connects to `ws://127.0.0.1:7880` using the JWT
4. Frontend publishes microphone audio → LiveKit server
5. Agent subscribes to the user's audio, processes it (STT → LLM → TTS)
6. Agent publishes response audio → LiveKit server → Frontend plays it
7. Transcription appears in the transcript panel via `TranscriptionReceived` events

### Key LiveKit Concepts
- **Room**: A session where participants exchange media
- **Track**: A media stream (audio or video) published by a participant
- **Participant**: Anyone connected to the room (local = you, remote = agent)
- **Token**: A JWT granting permission to join a specific room
- **VAD**: Voice Activity Detection — determines when someone starts/stops speaking
- **STT/TTS**: Speech-to-Text / Text-to-Speech handled by the agent

---

## UI Panels

| Panel | Purpose |
|-------|---------|
| **Connection** | Configure server URL, credentials, room, and identity |
| **Microphone** | Mute/unmute + real-time level meter |
| **Participants** | Shows who's in the room (you + agent) |
| **Audio Visualizer** | Dual waveform — purple = agent, cyan = you |
| **Live Transcript** | Timestamped speech → text bubbles |
| **Debug Console** | All SDK events, errors, and connection logs |

---

## File Structure
```
frontend/
├── index.html      # Single HTML page
├── style.css       # All styling (dark dev-tools theme)
├── app.js          # LiveKit connection + UI logic
└── README.md       # This file

token_server.py     # JWT token endpoint (runs alongside agent)
```
