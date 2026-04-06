"""
conversation_logger.py
======================
Conversation transcript logger with structured topic markers for evaluation.

Writes a clean Interviewer/Candidate transcript with [TOPIC_START] and
[TOPIC_END] markers that can be parsed by the post-interview processor.
"""

import os
from datetime import datetime

TRANSCRIPT_DIR = os.path.join(os.path.dirname(__file__), "transcripts")


def _ensure_dir():
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)


def create_transcript(
    room_name: str = "session",
    config: dict | None = None,
    room_metadata: dict | None = None,
) -> str:
    """Create a new transcript file with a metadata header.

    Parameters
    ----------
    room_name : str
        LiveKit room name (used in filename).
    config : dict | None
        Interview config dict. If provided, a metadata header is written.
    room_metadata : dict | None
        Room metadata containing candidate_id, application_id, job_id.

    Returns
    -------
    str
        Path to the created transcript file.
    """
    _ensure_dir()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = room_name.replace(" ", "_").replace("/", "_")
    path = os.path.join(TRANSCRIPT_DIR, f"{ts}_{safe_name}.txt")

    with open(path, "w", encoding="utf-8") as f:
        # Write metadata header if config is available
        if config:
            jd_title = config.get("job_description", "")[:80].replace("\n", " ")
            f.write(f"[SESSION_START] {datetime.now().isoformat()} | Job: {jd_title}\n")
            
            if room_metadata:
                cid = room_metadata.get("candidate_id") or "N/A"
                aid = room_metadata.get("application_id") or "N/A"
                jid = room_metadata.get("job_id") or "N/A"
                f.write(f"[METADATA] CAND:{cid} | APP:{aid} | JOB:{jid}\n")

            # Skills summary
            skills = config.get("skills", [])
            if skills:
                skills_str = ", ".join(f"{s['name']}:{s['level']}" for s in skills)
                f.write(f"[SKILLS] {skills_str}\n")

            # Topics summary
            topics = config.get("topics_to_ask", [])
            if topics:
                topics_str = ", ".join(t["name"] for t in topics)
                f.write(f"[TOPICS] {topics_str}\n")

            f.write("\n")

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


def log_topic_marker(
    path: str,
    marker_type: str,
    topic_name: str,
    skills: list[str] | None = None,
    level: str | None = None,
) -> None:
    """Append a topic marker line to the transcript.

    Args:
        path: Transcript file path.
        marker_type: "START" or "END".
        topic_name: Name of the topic.
        skills: List of skill names this topic is based on.
        level: Skill level (e.g., "L3"). For multi-skill topics, the primary level.
    """
    ts = datetime.now().isoformat()
    skills_str = ", ".join(skills) if skills else "N/A"
    level_str = level or "N/A"
    marker = f"[TOPIC_{marker_type}] {topic_name} | {skills_str} | {level_str} | {ts}"

    with open(path, "a", encoding="utf-8") as f:
        f.write(f"\n{marker}\n")
