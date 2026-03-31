# LiveKit AI Interview Agent — Node.js

A real-time AI-powered interview agent built on [LiveKit](https://livekit.io/) Agents SDK (Node.js 1.x). The agent conducts structured technical interviews using voice, with automatic transcription, topic tracking, and MongoDB integration.

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Frontend      │───▶│   Token Server   │───▶│  LiveKit Server │
│ (HTML/JS/CSS)   │    │  (Express, 8081) │    │   (ws://7880)   │
└─────────────────┘    └──────────────────┘    └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │   Agent Worker   │
                                               │  (agent-node/)   │
                                               │                  │
                                               │  STT: Sarvam AI  │
                                               │  TTS: Sarvam AI  │
                                               │  LLM: Gemini 2.5 │
                                               │  VAD: Silero     │
                                               └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │    MongoDB       │
                                               │  (Transcripts)   │
                                               └─────────────────┘
```

## Project Structure

```
├── agent-node/              # LiveKit Agent Worker (Node.js)
│   ├── agent.js             # Main entry point — session lifecycle
│   ├── prompts.js           # System prompt builder (resume + MongoDB job config)
│   ├── tools.js             # LLM tools (transition_topic, end_call)
│   ├── logger.js            # Transcript file writer with structured markers
│   ├── processor.js         # Post-interview MongoDB upload
│   └── package.json
│
├── token-server/            # Express server for LiveKit token generation
│   ├── server.js            # Token endpoint + resume upload + static serving
│   └── package.json
│
├── frontend/                # Browser-based interview UI
│   ├── index.html           # Interview page
│   ├── app.js               # LiveKit SDK client logic
│   └── style.css            # Styling
│
├── .env.example             # Environment variable template
├── .gitignore
└── README.md
```

## Prerequisites

- **Node.js** ≥ 18
- **LiveKit Server** — Self-hosted or cloud ([docs](https://docs.livekit.io/home/self-hosting/local/))
- **API Keys**:
  - [Sarvam AI](https://www.sarvam.ai/) — STT (saaras:v3) & TTS (bulbul:v3)
  - [Google AI](https://aistudio.google.com/) — Gemini 2.5 Flash
- **MongoDB** — For job configs and transcript storage

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/techpranee-org/livekit-deployment.git
cd livekit-deployment

# Install agent dependencies
cd agent-node && npm install && cd ..

# Install token server dependencies
cd token-server && npm install && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your actual API keys and MongoDB URI
```

### 3. Start LiveKit Server (Development)

```bash
# Download from https://github.com/livekit/livekit/releases
./livekit-server --dev
```

### 4. Start Token Server

```bash
cd token-server
npm run dev
```

### 5. Start Agent Worker

```bash
cd agent-node
node agent.js dev
```

### 6. Open Frontend

Navigate to `http://localhost:8081` in your browser.

## How It Works

### Interview Flow

1. **User uploads resume** → Token server stores PDF and creates a LiveKit room with metadata
2. **Agent joins room** → Reads room metadata (resume path, job ID)
3. **System prompt built** → Parses resume PDF + fetches job config from MongoDB
4. **Voice interview begins** → Agent greets candidate and follows topic structure
5. **Topic tracking** → `transition_topic` tool logs `[TOPIC_START/END]` markers with skills & proficiency levels
6. **End call** → `end_call` tool logs `[SESSION_END]`, says farewell, and triggers shutdown
7. **Post-processing** → Transcript parsed and uploaded to MongoDB with structured document

### Transcript Format

```
[SESSION_START] 2026-03-31T16:03:18.000Z | Job: Senior React Developer
[METADATA] CAND:user123 | APP:app456 | JOB:69cbbe0730202aca28dd4281
[SKILLS] React:L4, JavaScript:L4, TypeScript:L3, HTML/CSS Development:L3
[TOPICS] Frontend Development & UI Implementation, Type Safety & Application Architecture

Interviewer: Hello! My name is Ritu, and I will be your interviewer today.
Candidate: Hi Ritu, my day has been good.

[TOPIC_START] Frontend Development & UI Implementation | React, JavaScript, HTML/CSS Development | L4 | 2026-03-31T...
Interviewer: Could you describe your experience developing responsive web applications?
Candidate: Sure, at my previous role I built...
[TOPIC_END] Frontend Development & UI Implementation | React, JavaScript, HTML/CSS Development | L4 | 2026-03-31T...

[SESSION_END] 2026-03-31T16:15:00.000Z
```

### MongoDB Document Schema

```json
{
  "candidate_id": "user123",
  "application_id": "app456",
  "job_id": "69cbbe07...",
  "conversation_log": "Interviewer: Hello!...\nCandidate: Hi...",
  "topics": [{ "name": "Frontend Dev", "skills_based_on": ["React", "JS"] }],
  "skills": ["React:L4", "JavaScript:L4"],
  "topic_logs": [{
    "topic": "Frontend Dev",
    "skills": ["React", "JS"],
    "start_time": "2026-03-31T...",
    "end_time": "2026-03-31T...",
    "log": "Interviewer: Could you...\nCandidate: Sure..."
  }],
  "created_at": "2026-03-31T...",
  "status": "completed"
}
```

## AI Components

| Component | Provider | Model | Purpose |
|-----------|----------|-------|---------|
| STT | Sarvam AI | saaras:v3 | Speech-to-text (Hindi/English) |
| TTS | Sarvam AI | bulbul:v3 (ritu) | Text-to-speech |
| LLM | Google | gemini-2.5-flash | Interview responses & tool calls |
| VAD | Silero | — | Voice activity detection |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `SARVAM_API_KEY` | Sarvam AI API key (STT + TTS) |
| `GOOGLE_API_KEY` | Google Gemini API key |
| `INTERVIEW_API_KEY` | Token server auth key |
| `TOKEN_SERVER_PORT` | Token server port (default: 8081) |
| `MONGODB_URI` | MongoDB connection string |
| `INTERVIEW_DB` | Database name |
| `TRANSCRIPT_COLLECTION` | Collection for transcripts |
| `JOB_COLLECTION` | Collection for job configs |

## Deployment Notes

- The agent worker runs as a persistent process and auto-accepts job requests from LiveKit
- Resume PDFs are stored in `resumes/` (gitignored) and cleaned up by the token server
- Transcripts are written to `transcripts/` during interviews and deleted after MongoDB upload
- For production, use `LIVEKIT_URL=wss://your-livekit-domain.com` with proper TLS
