import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRANSCRIPT_DIR = path.resolve(__dirname, '..', 'transcripts');

function ensureDir() {
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  }
}

/**
 * Creates a transcript file with structured metadata header.
 * Matches Python conversation_logger.py format exactly.
 */
export function createTranscript(roomName, config = null, roomMetadata = null) {
  ensureDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_');
  const safeName = roomName.replace(/ /g, '_').replace(/\//g, '_');
  const transcriptPath = path.join(TRANSCRIPT_DIR, `${ts}_${safeName}.txt`);

  let header = '';

  if (config) {
    const jdTitle = (config.job_description || '').substring(0, 80).replace(/\n/g, ' ');
    header += `[SESSION_START] ${new Date().toISOString()} | Job: ${jdTitle}\n`;

    if (roomMetadata) {
      const cid = roomMetadata.candidate_id || 'N/A';
      const aid = roomMetadata.application_id || 'N/A';
      const jid = roomMetadata.job_id || 'N/A';
      header += `[METADATA] CAND:${cid} | APP:${aid} | JOB:${jid}\n`;
    }

    // Skills summary
    const skills = config.skills || [];
    if (skills.length > 0) {
      const skillsStr = skills.map(s => `${s.name}:${s.level}`).join(', ');
      header += `[SKILLS] ${skillsStr}\n`;
    }

    // Topics summary
    const topics = config.topics_to_ask || [];
    if (topics.length > 0) {
      const topicsStr = topics.map(t => t.name).join(', ');
      header += `[TOPICS] ${topicsStr}\n`;
    }

    header += '\n';
  }

  fs.writeFileSync(transcriptPath, header);
  console.log(`[Agent] Transcript started: ${transcriptPath}`);
  return transcriptPath;
}

/**
 * Logs a single turn (Interviewer or Candidate) to the transcript file.
 */
export function logTurn(transcriptPath, role, text) {
  text = (text || '').trim();
  if (!text) return;
  fs.appendFileSync(transcriptPath, `${role}: ${text}\n`);
}

/**
 * Logs a topic marker (START or END) to the transcript file.
 * Format: [TOPIC_START] TopicName | skill1, skill2 | Level | ISO_timestamp
 */
export function logTopicMarker(transcriptPath, markerType, topicName, skills = [], level = 'N/A') {
  const ts = new Date().toISOString();
  const skillsStr = skills.length > 0 ? skills.join(', ') : 'N/A';
  const levelStr = level || 'N/A';
  const marker = `[TOPIC_${markerType}] ${topicName} | ${skillsStr} | ${levelStr} | ${ts}`;
  fs.appendFileSync(transcriptPath, `\n${marker}\n`);
}

/**
 * Logs a [SESSION_END] marker to the transcript file.
 */
export function logSessionEnd(transcriptPath) {
  fs.appendFileSync(transcriptPath, `\n[SESSION_END] ${new Date().toISOString()}\n`);
}
