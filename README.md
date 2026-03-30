# AI Interview Agent

An interactive, AI-powered interview agent built with **LiveKit**. This application allows users to experience a fully conversational voice interview with an AI agent that listens, understands, and responds in real-time.

---

## 🏗️ Architecture

The system consists of four main components running together:

1. **LiveKit Server (SFU)**: The core engine that handles real-time audio/video streaming via WebRTC.
2. **Token Server (Node.js)**: A backend server that authenticates users, generates LiveKit JWTs (tokens), and serves the static frontend.
3. **Agent (Python)**: The "brain" of the AI. It uses the LiveKit SDK to connect to rooms, processes user speech, and orchestrates the AI pipeline (VAD → STT → LLM → TTS).
4. **Frontend (HTML/JS)**: The user interface where candidates connect to the room, speak through their microphone, and see live transcripts.

### How it works with LiveKit

```
┌──────────┐     WebSocket      ┌───────────────┐     gRPC/WS      ┌──────────┐
│ Frontend │ ◄═══════════════► │ LiveKit Server │ ◄═══════════════► │  Agent   │
│ (Browser)│    (Audio Tracks)  │  :7880         │   (Agent SDK)    │ (Python) │
└──────────┘                    └───────────────┘                    └──────────┘
      │                                                                    
      │  GET /token                                                        
      ▼                                                                    
┌──────────────┐                                                           
│ Token Server │  Generates JWT using LIVEKIT_API_KEY / SECRET             
│  :8081       │                                                           
└──────────────┘                                                           
```

1. **Authentication**: The Frontend requests a token from the **Token Server**.
2. **Connection**: The Token Server returns a JWT, which the Frontend uses to connect to the **LiveKit Server**.
3. **Streaming**: The Frontend publishes microphone audio to LiveKit. The **Agent** subscribes to this audio.
4. **AI Pipeline (Agent)**:
    - **VAD** (Silero Voice Activity Detection) detects when the user starts and stops talking.
    - **STT** (Sarvam) converts the user's speech into text.
    - **LLM** (Google Gemini) generates the interviewer's response based on the candidate's answer and the provided resume.
    - **TTS** (Google Text-to-Speech) converts the LLM's text response back into an audio stream.
5. **Response**: The Agent publishes the resulting audio track back to LiveKit, which the Frontend plays to the candidate.

---

## 🚀 Getting Started

### Prerequisites

- **Python 3.9+**
- **Node.js 18+**
- A Google API Key (for Gemini and Google Cloud TTS)
- Sarvam API Key (for Speech-to-Text)

### 1. Installation

**Python Dependencies (Agent)**:
```bash
python -m venv .venv

# On Windows:
.venv\Scripts\activate
# On Mac/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
```

**Node Dependencies (Token Server)**:
```bash
cd token-server
npm install
cd ..
```

### 2. Environment Variables
Create a `.env` file in the root of the project directory based on your API credentials:

```ini
# LiveKit setup
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# Internal auth for your token server
INTERVIEW_API_KEY=dev-interview-key

# AI Providers
GOOGLE_API_KEY=your_google_ai_studio_or_gcp_key
SARVAM_API_KEY=your_sarvam_api_key
```
*(Make sure to replace the placeholder API keys with your actual keys)*

---

## 🏃‍♂️ How to Run

Running the app requires starting 3 separate processes. Open 3 terminal tabs in the root directory.

### Terminal 1: Start the LiveKit Server
Start the local LiveKit WebRTC server in development mode.
```bash
./livekit-server.exe --dev
```
*(On Mac/Linux, download the respective LiveKit binaries or use Docker)*

### Terminal 2: Start the Token & Web Server
This starts the backend Node server which issues tokens and also serves the frontend files.
```bash
cd token-server
npm run dev
# or npm start
```

### Terminal 3: Start the Python AI Agent
Ensure your python virtual environment is activated, then run:
```bash
python google-agent.py dev
```
*Note: Depending on how the system prompt is generated, make sure you have a `resumes/` folder or upload the resume via the token server's `/upload-resume` endpoint.*

---

## 🎮 Using the Application

1. Open your browser and navigate to the frontend served by the token server: **`http://localhost:8081`**
2. In the connection UI, ensure the credentials match what is in your `.env` file (e.g. `dev-interview-key` for the Auth Key).
3. Click "Connect". 
4. The Agent should greet you. You can talk to the agent naturally through your microphone. 
5. A live transcript of the conversation alongside audio visualization will be displayed on the screen!

---

## 📁 File Structure

- `livekit-server.exe` — The local development WebRTC SFU server.
- `google-agent.py` — The core AI logic (using LiveKit Agents Python SDK).
- `get_system_prompt.py` — Logic used by the agent to parse resumes and generate customized context for the LLM.
- `frontend/` — The raw HTML, JS, and CSS for the interview interface.
- `token-server/` — An Express.js backend for authentication, resume uploads, and serving the frontend.
