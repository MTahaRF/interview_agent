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

## Getting Started & Initialization

Follow these steps to initialize and run the project from scratch.

### 1. Prerequisite Installations
Ensure you have the following installed on your system:
- **Node.js** (v18 or higher)
- **MongoDB** (Local or Atlas connection string)
- **Git** 

### 2. Clone the Repository
```bash
git clone <your-repository-url>
cd <your-repository-directory>
```

### 3. Install Dependencies
You must install Node modules for both the agent worker and the token server.
```bash
# Install agent dependencies
cd agent-node
npm install
cd ..

# Install token server dependencies
cd token-server
npm install
cd ..
```

### 4. Configure Environment Variables
Create your configuration file from the template:
```bash
cp .env.example .env
```
Open `.env` in a text editor and populate your actual keys:
- `SARVAM_API_KEY` (For STT & TTS)
- `GOOGLE_API_KEY` (For Gemini 2.5 Flash)
- `MONGODB_URI` (Your MongoDB connection string)
- *(LiveKit keys can be left as default dev keys if using local server)*

### 5. Download LiveKit Server Binary
If you are running LiveKit locally, download the pre-compiled binary for your OS from the [LiveKit GitHub Releases](https://github.com/livekit/livekit/releases) page. Place the `livekit-server.exe` (or equivalent binary) directly into the root directory of this project.

### 6. Start the Project Services
A convenience batch file is provided for Windows users to launch all required services simultaneously.

**Option A: Using the Batch script (Windows)**
Simply double-click the `start.bat` file in the root directory. This will automatically open three separate command prompt windows running:
1. LiveKit Server (in `--dev` mode)
2. Token Server
3. Agent Worker Node

**Option B: Manual Startup (Mac/Linux/Windows)**
Open three separate terminal sessions in the root directory:

**Terminal 1 (LiveKit):**
```bash
./livekit-server --dev
```

**Terminal 2 (Token Server):**
```bash
cd token-server
npm run dev
```

**Terminal 3 (Agent Worker):**
```bash
cd agent-node
node agent.js dev
```

### 7. Open the Application
Once all three services are running successfully, open your browser and navigate to:
`http://localhost:8081`

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
