import csv
import json
import httpx
import os
import asyncio
import unicodedata
from datetime import datetime, date, timedelta
from logging.handlers import RotatingFileHandler
import logging
from dotenv import load_dotenv
from get_system_prompt import get_system_prompt
from conversation_logger import create_transcript, log_turn
from livekit.agents import (
    AgentServer,
    AgentSession,
    Agent,
    JobContext,
    RunContext,
    function_tool,
    cli,
) 
from livekit.plugins import google, silero, sarvam

# --- Logging Setup -------------------------------------------------------

LOG_FILE = "agent_log.txt"

log_formatter = logging.Formatter(
    fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

file_handler = RotatingFileHandler(
    LOG_FILE,
    maxBytes=5 * 1024 * 1024,
    backupCount=3,
    encoding="utf-8",
)
file_handler.setFormatter(log_formatter)
file_handler.setLevel(logging.DEBUG)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
console_handler.setLevel(logging.INFO)

class MaxLevelFilter(logging.Filter):
    def __init__(self, max_level):
        self.max_level = max_level
    def filter(self, record):
        return record.levelno <= self.max_level

console_handler.addFilter(MaxLevelFilter(logging.INFO))

logging.basicConfig(level=logging.DEBUG, handlers=[file_handler, console_handler])
logger = logging.getLogger("interview_agent")

# -------------------------------------------------------------------------

load_dotenv()
logger.info("Environment variables loaded.")

today_str = date.today().isoformat()
logger.info(f"Agent starting. Today's date: {today_str}")
# --- Agent ---------------------------------------------------------------

class InterviewAgent(Agent):
    def __init__(self, ctx: JobContext, system_prompt: str):
        super().__init__(instructions=system_prompt)
        self.ctx = ctx
        logger.info("InterviewAgent initialized.")

    @function_tool(description="Ends the interview call when the interview is complete.")
    async def end_call(self):
        logger.info("Agent decided to end the call. Asking user to disconnect.")
        
        async def delayed_disconnect():
            await asyncio.sleep(8)
            logger.info("Disconnecting room after saying farewell.")
            await self.ctx.room.disconnect()
            
        asyncio.create_task(delayed_disconnect())
        return "Say exactly this phrase to the user: 'It was nice interviwing you, Please press the disconnect button to end the call'."

# --- Server Setup --------------------------------------------------------

server = AgentServer()

@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info(f"New session started. Room: {ctx.room.name}")

    # --- Per-session system prompt from room metadata ---
    metadata = json.loads(ctx.room.metadata or "{}")
    resume_path = metadata.get("resume_path", "ML_Resume.pdf")
    logger.info(f"Resume path from room metadata: {resume_path}")
    system_prompt = get_system_prompt(resume_path)
    logger.info(f"System prompt built for this session ({len(system_prompt)} chars)")

    sarvam_stt = sarvam.STT(
        language="en-IN",
        model="saaras:v3",
        mode="transcribe",
        flush_signal=True,
    )
    logger.debug("Sarvam STT initialized.")

    # 2. Initialize Google Gemini LLM
    google_llm = google.LLM(
        model="gemini-2.5-flash", 
        temperature=0.4
    )
    logger.debug("Google LLM initialized.")

    # 3. Initialize Google TTS
    # Google offers Standard, Wavenet, Neural2, and Journey voices. 
    # For an Indian English female voice (equivalent to 'ritu'): "en-IN-Standard-A" or "en-IN-Neural2-A"
    google_tts = google.TTS(
        language= "en-IN",
        voice_name="en-IN-Chirp3-HD-Aoede", 
        gender="female",
    )
    logger.debug("Google TTS initialized.")

    # 4. Initialize Silero VAD (Voice Activity Detection)
    # You can customize these thresholds if the agent cuts you off too early
    custom_vad = silero.VAD.load(
        activation_threshold=0.7,   # Higher = requires louder voice to activate
        deactivation_threshold=0.3, # Lower than activation to prevent cutting off mid-word
        min_speech_duration=0.1,    # Ignore quick mic bumps
        min_silence_duration=1.0    # Wait 1s of silence before declaring end of speech
    )
    logger.debug("Silero VAD initialized.")

    # 5. Create the AgentSession
    session = AgentSession(
        stt=sarvam_stt,
        llm=google_llm,
        tts=google_tts,
        vad=custom_vad, 
        
        # --- TURN DETECTION & VAD SETTINGS ---
        
        turn_detection="vad",          # Use VAD for determining when user starts/stops talking
        allow_interruptions=True,      # Let the user interrupt the agent while it is speaking
        min_interruption_duration=0.2, # User must speak for at least 0.2s to trigger an interrupt
        # Endpointing Delay: How long the agent waits after the user stops talking before sending the text to the LLM. 
        # Increase these if the agent cuts the candidate off mid-thought.
        min_endpointing_delay=0.8,     # Default is 0.5s. 0.8s allows for conversational pauses.
        max_endpointing_delay=3.0,     # Absolute max time to wait before forcing a turn
    )
    logger.info("AgentSession created. Starting session...")
    
    await session.start(
        room=ctx.room,
        agent=InterviewAgent(ctx, system_prompt),
    )
    logger.info("Session started. Sending initial greeting.")

    # --- Conversation Transcript Logging ---
    transcript_path = create_transcript(ctx.room.name)
    logger.info(f"Transcript file: {transcript_path}")

    @session.on("conversation_item_added")
    def _on_conversation_item(msg):
        if msg.item.role == "assistant":
            log_turn(transcript_path, "Interviewer", msg.item.text_content)
        elif msg.item.role == "user":
            log_turn(transcript_path, "Candidate", msg.item.text_content)

    await session.generate_reply(
        instructions="Greet the user warmly and introduce yourself as the technical interviewer. Keep it concise and professional."
    )

if __name__ == "__main__":
    logger.info("Starting LiveKit CLI runner.")
    cli.run_app(server)
