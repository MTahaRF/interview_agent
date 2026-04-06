"""
post_interview_processor.py
============================
Parses a raw interview transcript and pushes it to MongoDB.
"""

import os
import re
import sys
from datetime import datetime
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

def parse_transcript(transcript_path: str) -> dict:
    """Parse a transcript file into structured MongoDB document layout."""
    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    result = {
        "candidate_id": None,
        "application_id": None,
        "job_id": None,
        "metadata": {},
        "conversation_log": "", # string instead of array
        "topics": [],
        "skills": [],
        "topic_logs": [],
    }
    
    convo_lines = [] # Temporary list for joining later

    # Regex patterns for markers
    topic_start_re = re.compile(r"^\[TOPIC_START\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(.+)$")
    topic_end_re = re.compile(r"^\[TOPIC_END\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(.+)$")
    session_start_re = re.compile(r"^\[SESSION_START\]")
    session_end_re = re.compile(r"^\[SESSION_END\]")
    skills_re = re.compile(r"^\[SKILLS\]\s*(.+)$")
    topics_re = re.compile(r"^\[TOPICS\]\s*(.+)$")
    metadata_re = re.compile(r"^\[METADATA\]\s*CAND:(.*?)\s*\|\s*APP:(.*?)\s*\|\s*JOB:(.*?)$")

    current_topic = None

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        # --- Metadata lines ---
        if session_start_re.match(line):
            result["metadata"]["session_start"] = line
            continue
        if session_end_re.match(line):
            result["metadata"]["session_end"] = line
            continue

        m_skills = skills_re.match(line)
        if m_skills:
            result["skills"] = [s.split(":")[0].strip() for s in m_skills.group(1).split(",")]
            continue

        m_topics = topics_re.match(line)
        if m_topics:
            topics_str = m_topics.group(1).strip()
            # The structured topics array will be built from [TOPIC_START] markers
            continue

        m_meta = metadata_re.match(line)
        if m_meta:
            result["candidate_id"] = m_meta.group(1).strip()
            result["application_id"] = m_meta.group(2).strip()
            result["job_id"] = m_meta.group(3).strip()
            continue

        # --- Topic START ---
        m_start = topic_start_re.match(line)
        if m_start:
            name = m_start.group(1).strip()
            skills_for_topic = [s.strip() for s in m_start.group(2).split(",")]
            
            # update result["topics"] structure
            if not any(t["name"] == name for t in result["topics"]):
                result["topics"].append({
                    "name": name,
                    "skills_based_on": skills_for_topic
                })

            current_topic = {
                "topic": name,
                "skills": skills_for_topic,
                "start_time": m_start.group(4).strip(),
                "end_time": None,
                "log_lines": [],
            }
            result["topic_logs"].append(current_topic)
            continue

        # --- Topic END ---
        m_end = topic_end_re.match(line)
        if m_end:
            if current_topic and current_topic["topic"] == m_end.group(1).strip():
                current_topic["end_time"] = m_end.group(4).strip()
            current_topic = None
            continue

        # --- Conversation lines ---
        if line.startswith("Interviewer:") or line.startswith("Candidate:"):
            convo_lines.append(line)
            if current_topic is not None:
                current_topic["log_lines"].append(line)

    # Flatten logs into strings
    result["conversation_log"] = "\n".join(convo_lines)
    for tlog in result["topic_logs"]:
        tlog["log"] = "\n".join(tlog.pop("log_lines", [])) # string instead of array

    return result

def push_to_mongodb(parsed: dict) -> str:
    """Push the parsed document to MongoDB."""
    mongo_uri = os.environ.get("MONGODB_URI")
    if not mongo_uri:
        raise ValueError("MONGODB_URI not found in environment variables")
        
    interview_db = os.environ.get("INTERVIEW_DB", "interview_db") 
    transcript_collection = os.environ.get("TRANSCRIPT_COLLECTION", "transcripts")
    client = MongoClient(mongo_uri)
    db = client[interview_db]
    collection = db[transcript_collection]
    
    # Assemble document according to requested schema
    doc = {
        "candidate_id": parsed.get("candidate_id"),
        "application_id": parsed.get("application_id"),
        "job_id": parsed.get("job_id"),
        "conversation_log": parsed.get("conversation_log", []),
        "topics": parsed.get("topics", []),
        "skills": parsed.get("skills", []),
        "topic_logs": parsed.get("topic_logs", []),
        "created_at": datetime.now()
    }
    
    res = collection.insert_one(doc)
    return str(res.inserted_id)

def process_transcript(transcript_path: str) -> None:
    """Main entry point: parse transcript, insert into MongoDB, delete file."""
    if not os.path.isfile(transcript_path):
        print(f"Error: File not found: {transcript_path}")
        sys.exit(1)

    parsed = parse_transcript(transcript_path)
    
    try:
        inserted_id = push_to_mongodb(parsed)
        print(f"Successfully pushed to MongoDB with ID {inserted_id}")
        
        # Delete original file as requested
        os.remove(transcript_path)
        print(f"Deleted transcript file: {transcript_path}")
    except Exception as e:
        print(f"Failed to push to MongoDB: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python post_interview_processor.py <transcript_path>")
        sys.exit(1)

    process_transcript(sys.argv[1])
