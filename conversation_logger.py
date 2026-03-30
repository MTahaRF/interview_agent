"""
conversation_logger.py
======================
Minimal conversation transcript logger for evaluation.

Writes a clean Interviewer/Candidate transcript to a timestamped file.
"""

import os
from datetime import datetime

TRANSCRIPT_DIR = os.path.join(os.path.dirname(__file__), "transcripts")


def _ensure_dir():
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)


def create_transcript(room_name: str = "session") -> str:
    """Create a new transcript file and return its path."""
    _ensure_dir()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = room_name.replace(" ", "_").replace("/", "_")
    path = os.path.join(TRANSCRIPT_DIR, f"{ts}_{safe_name}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("")
    return path


def log_turn(path: str, role: str, text: str) -> None:
    """Append a single turn to the transcript file.

    Args:
        path: Transcript file path from create_transcript().
        role: 'Interviewer' or 'Candidate'.
        text: What was said.
    """
    text = text.strip()
    if not text:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"{role}: {text}\n")
