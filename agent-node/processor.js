import fs from 'fs';
import path from 'path';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Parses a transcript file into the structured MongoDB document layout.
 * Matches the Python post_interview_processor.py format exactly.
 */
function parseTranscript(transcriptPath) {
  const rawContent = fs.readFileSync(transcriptPath, 'utf8');
  const lines = rawContent.split('\n');

  const result = {
    candidate_id: null,
    application_id: null,
    job_id: null,
    metadata: {},
    conversation_log: '',   // string, not array
    topics: [],
    skills: [],
    topic_logs: [],
  };

  const convoLines = [];

  // Regex patterns matching Python's markers
  const topicStartRe = /^\[TOPIC_START\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(.+)$/;
  const topicEndRe = /^\[TOPIC_END\]\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\S+)\s*\|\s*(.+)$/;
  const sessionStartRe = /^\[SESSION_START\]/;
  const sessionEndRe = /^\[SESSION_END\]/;
  const skillsRe = /^\[SKILLS\]\s*(.+)$/;
  const topicsRe = /^\[TOPICS\]\s*(.+)$/;
  const metadataRe = /^\[METADATA\]\s*CAND:(.*?)\s*\|\s*APP:(.*?)\s*\|\s*JOB:(.*?)$/;
  // Simple topic start (from logger.js format: [TOPIC_START] TopicName)
  const simpleTopicStartRe = /^\[TOPIC_START\]\s*(.+)$/;

  let currentTopic = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // --- Header metadata (from transcript header) ---
    if (line.startsWith('Job ID:')) {
      result.job_id = line.split(':').slice(1).join(':').trim();
      continue;
    }
    if (line.startsWith('Candidate ID:')) {
      result.candidate_id = line.split(':').slice(1).join(':').trim();
      continue;
    }
    if (line.startsWith('Application ID:')) {
      result.application_id = line.split(':').slice(1).join(':').trim();
      continue;
    }

    // --- Structured metadata lines ---
    if (sessionStartRe.test(line)) {
      result.metadata.session_start = line;
      continue;
    }
    if (sessionEndRe.test(line)) {
      result.metadata.session_end = line;
      continue;
    }

    const mSkills = skillsRe.exec(line);
    if (mSkills) {
      result.skills = mSkills[1].split(',').map(s => s.split(':')[0].trim());
      continue;
    }

    const mTopics = topicsRe.exec(line);
    if (mTopics) {
      continue; // topics built from TOPIC_START markers
    }

    const mMeta = metadataRe.exec(line);
    if (mMeta) {
      result.candidate_id = mMeta[1].trim();
      result.application_id = mMeta[2].trim();
      result.job_id = mMeta[3].trim();
      continue;
    }

    // --- Full Topic START (with skills, id, time) ---
    const mStart = topicStartRe.exec(line);
    if (mStart) {
      const name = mStart[1].trim();
      const skillsForTopic = mStart[2].split(',').map(s => s.trim());

      if (!result.topics.some(t => t.name === name)) {
        result.topics.push({ name, skills_based_on: skillsForTopic });
      }

      currentTopic = {
        topic: name,
        skills: skillsForTopic,
        start_time: mStart[4].trim(),
        end_time: null,
        log_lines: [],
      };
      result.topic_logs.push(currentTopic);
      continue;
    }

    // --- Simple Topic START (from logger.js: [TOPIC_START] TopicName) ---
    const mSimpleStart = simpleTopicStartRe.exec(line);
    if (mSimpleStart && !topicStartRe.test(line)) {
      const name = mSimpleStart[1].trim();

      if (!result.topics.some(t => t.name === name)) {
        result.topics.push({ name, skills_based_on: [] });
      }

      currentTopic = {
        topic: name,
        skills: [],
        start_time: new Date().toISOString(),
        end_time: null,
        log_lines: [],
      };
      result.topic_logs.push(currentTopic);
      continue;
    }

    // --- Topic END ---
    const mEnd = topicEndRe.exec(line);
    if (mEnd) {
      if (currentTopic && currentTopic.topic === mEnd[1].trim()) {
        currentTopic.end_time = mEnd[4].trim();
      }
      currentTopic = null;
      continue;
    }

    // --- Conversation lines ---
    if (line.startsWith('Interviewer:') || line.startsWith('Candidate:')) {
      convoLines.push(line);
      if (currentTopic !== null) {
        currentTopic.log_lines.push(line);
      }
    }
  }

  // Flatten logs into strings (matching Python format)
  result.conversation_log = convoLines.join('\n');
  for (const tlog of result.topic_logs) {
    tlog.log = tlog.log_lines.join('\n');
    delete tlog.log_lines;
  }

  return result;
}

/**
 * Parses the raw transcript file and uploads it to MongoDB.
 * Document format matches Python's post_interview_processor.py exactly.
 */
export async function processTranscript(transcriptPath) {
  const mongoUri = process.env.MONGODB_URI;
  const dbName = process.env.INTERVIEW_DB || 'interview_db';
  const transcriptCollName = process.env.TRANSCRIPT_COLLECTION || 'transcripts';

  if (!mongoUri) {
    console.error('[Agent] MONGODB_URI not set, skipping upload.');
    return;
  }
  if (!fs.existsSync(transcriptPath)) {
    console.error(`[Agent] Transcript file not found: ${transcriptPath}`);
    return;
  }

  const client = new MongoClient(mongoUri);
  try {
    const parsed = parseTranscript(transcriptPath);

    // Assemble document matching Python schema
    const doc = {
      candidate_id: parsed.candidate_id,
      application_id: parsed.application_id,
      job_id: parsed.job_id,
      conversation_log: parsed.conversation_log,
      topics: parsed.topics,
      skills: parsed.skills,
      topic_logs: parsed.topic_logs,
      created_at: new Date(),
      status: 'completed',
    };

    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(transcriptCollName);

    const result = await collection.insertOne(doc);
    console.log(`[Agent] Interview saved to MongoDB: ${result.insertedId}`);

    // Cleanup file after successful upload
    fs.unlinkSync(transcriptPath);
    console.log(`[Agent] Transcript file deleted: ${transcriptPath}`);

  } catch (error) {
    console.error(`[Agent] Post-processing failed: ${error.message}`);
  } finally {
    await client.close();
  }
}
