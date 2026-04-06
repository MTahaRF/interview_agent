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
from conversation_logger import create_transcript, log_turn, log_topic_marker
from post_interview_processor import process_transcript
from livekit.rtc import ConnectionState
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
    def __init__(
        self,
        ctx: JobContext,
        system_prompt: str,
        transcript_path: str,
        interview_config: dict,
    ):
        super().__init__(instructions=system_prompt)
        self.ctx = ctx
        self._transcript_path = transcript_path
        self._interview_config = interview_config

        # Build a topic lookup for skill/level info
        self._topic_lookup = {}
        self.current_topic = None
        
        skills_by_name = {s["name"]: s["level"] for s in interview_config.get("skills", [])}
        for topic in interview_config.get("topics_to_ask", []):
            topic_skills = topic.get("based_on_skills", [])
            # Use the highest level among linked skills
            topic_levels = [skills_by_name.get(s, "N/A") for s in topic_skills]
            primary_level = max(topic_levels, default="N/A") if topic_levels else "N/A"
            self._topic_lookup[topic["name"]] = {
                "skills": topic_skills,
                "level": primary_level,
            }

        logger.info("InterviewAgent initialized with %d topics.", len(self._topic_lookup))

    @function_tool(description="Call this immediately AFTER you have spoken your transition phrase out loud. This logs that the conversation is moving to a new topic. Pass the exact name of the new topic.")
    async def transition_topic(self, next_topic_name: str):
        """Marks the end of the previous topic and the start of a new one."""
        if self.current_topic == next_topic_name:
            return f"You are already discussing {next_topic_name}. Continue the interview organically."

        # 1. End current topic if there is one active
        if self.current_topic:
            prev_info = self._topic_lookup.get(self.current_topic, {"skills": [], "level": "N/A"})
            logger.info(f"[TOPIC_END] {self.current_topic}")
            log_topic_marker(
                self._transcript_path, "END", self.current_topic, prev_info["skills"], prev_info["level"]
            )
        
        # 2. Start new topic
        info = self._topic_lookup.get(next_topic_name, {"skills": [], "level": "N/A"})
        skills_str = ", ".join(info["skills"])
        level = info["level"]

        logger.info(f"[TOPIC_START] {next_topic_name} ({skills_str}/{level})")
        log_topic_marker(
            self._transcript_path, "START", next_topic_name, info["skills"], level
        )
        
        # 3. Update active topic
        self.current_topic = next_topic_name
        return f"Transitioned to {next_topic_name}. Continue interviewing seamlessly."

    @function_tool(description="Ends the interview call when the interview is complete.")
    async def end_call(self):
        logger.info("Agent decided to end the call. Asking user to disconnect.")
        
        # Log session end
        with open(self._transcript_path, "a", encoding="utf-8") as f:
            f.write(f"\n[SESSION_END] {datetime.now().isoformat()}\n")
        
        async def delayed_disconnect():
            await asyncio.sleep(8)
            logger.info("Disconnecting room after saying farewell.")
            await self.ctx.room.disconnect()
            
        asyncio.create_task(delayed_disconnect())
        return "Say exactly this phrase to the user: 'It was nice interviewing you, Please press the disconnect button to end the call'."

# --- Server Setup --------------------------------------------------------

server = AgentServer()

@server.rtc_session()
async def entrypoint(ctx: JobContext):
    logger.info(f"New session started. Room: {ctx.room.name}")
    logger.info(f"Raw Room Metadata: '{ctx.room.metadata}'")

    # --- Per-session config from room metadata ---
    # Metadata sync can be slightly delayed in the agent entrypoint
    for i in range(15):
        if ctx.room.metadata:
            logger.info(f"Metadata synced after {i*0.2:.1f}s")
            break
        await asyncio.sleep(0.2)

    raw_metadata = ctx.room.metadata or "{}"
    logger.info(f"Raw Room Metadata: '{raw_metadata}'")
    logger.info(f"Job Metadata: '{ctx.job.metadata}'")

    metadata_str = raw_metadata if raw_metadata and raw_metadata != "{}" else None
    metadata = {}
    
    if metadata_str:
        metadata = json.loads(metadata_str)
    else:
        # Fallback: Check participant metadata if room metadata is empty
        logger.info("Room metadata empty, checking participants...")
        for p_id, p in ctx.room.remote_participants.items():
            if p.metadata:
                try:
                    metadata = json.loads(p.metadata)
                    logger.info(f"Found metadata on participant: {p.identity}")
                    break
                except Exception as e:
                    logger.warning(f"Failed to parse metadata for participant {p.identity}: {e}")

    resume_path = metadata.get("resume_path", "ML_Resume.pdf")
    interview_config_path = metadata.get("interview_config_path", None)
    job_id_raw = metadata.get("job_id", None)
    job_id = None
    if job_id_raw:
        # Strip any extra quotes or whitespace from the frontend
        job_id = str(job_id_raw).strip().strip('"').strip("'")
    
    logger.info(f"Resume path: {resume_path}")
    logger.info(f"Job ID (cleaned): {job_id}")

    system_prompt, interview_config = get_system_prompt(
        resume_path=resume_path, 
        interview_config_path=interview_config_path,
        job_id=job_id
    )
    logger.info(f"System prompt built ({len(system_prompt)} chars), {len(interview_config.get('topics_to_ask', []))} topics")

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

    # 3. Initialize Gemini TTS (Beta)
    google_tts = google.beta.GeminiTTS(
        model="gemini-2.5-flash-preview-tts",
        voice_name="Kore",
        instructions="Speak in a professional, clear, and friendly tone with a natural Indian English accent. Maintain a conversational pace suitable for a technical interview.",
    )
    logger.debug("Google TTS initialized.")

    # 4. Initialize Silero VAD (Voice Activity Detection)
    custom_vad = silero.VAD.load(
        activation_threshold=0.7,
        deactivation_threshold=0.3,
        min_speech_duration=0.1,
        min_silence_duration=1.0
    )
    logger.debug("Silero VAD initialized.")

    # --- Transcript setup (with config metadata header) ---
    transcript_path = create_transcript(ctx.room.name, interview_config, metadata)
    logger.info(f"Transcript file: {transcript_path}")

    # 5. Create the AgentSession
    session = AgentSession(
        stt=sarvam_stt,
        llm=google_llm,
        tts=google_tts,
        vad=custom_vad, 
        
        # --- TURN DETECTION & VAD SETTINGS ---
        
        turn_detection="vad",
        allow_interruptions=True,
        min_interruption_duration=0.2,
        min_endpointing_delay=0.8,
        max_endpointing_delay=3.0,
    )
    logger.info("AgentSession created. Starting session...")
    
    try:
        await session.start(
            room=ctx.room,
            agent=InterviewAgent(ctx, system_prompt, transcript_path, interview_config),
        )
        logger.info("Session started. Sending initial greeting.")

        # --- Conversation Transcript Logging ---
        @session.on("conversation_item_added")
        def _on_conversation_item(msg):
            if msg.item.role == "assistant":
                log_turn(transcript_path, "Interviewer", msg.item.text_content)
            elif msg.item.role == "user":
                log_turn(transcript_path, "Candidate", msg.item.text_content)

        await session.generate_reply(
            instructions="Greet the user warmly and introduce yourself as the technical interviewer. Keep it concise and professional."
        )

        # Keep the entrypoint alive until the room is disconnected
        while ctx.room.connection_state == ConnectionState.CONN_CONNECTED:
            await asyncio.sleep(1)

    except Exception as e:
        logger.error(f"Error during agent session: {e}")
    finally:
        logger.info(f"Session finished for {ctx.room.name}. Triggering MongoDB upload for {transcript_path}")
        try:
            process_transcript(transcript_path)
            logger.info("Post-interview processing complete and file deleted.")
        except Exception as e:
            logger.error(f"Post-interview processing failed: {e}")

if __name__ == "__main__":
    logger.info("Starting LiveKit CLI runner.")
    cli.run_app(server)
