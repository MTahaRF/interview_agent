import * as agents from '@livekit/agents';
const { cli, defineAgent, voice, llm, WorkerOptions, initializeLogger } = agents;
import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as silero from '@livekit/agents-plugin-silero';
import { ConnectionState } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { z } from 'zod';
import { getSystemPrompt } from './prompts.js';
import { endCallTool } from './tools.js';
import { createTranscript, logTurn, logTopicMarker, logSessionEnd } from './logger.js';
import { processTranscript } from './processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from parent directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Main Agent Definition
 */
const agent = defineAgent({
  prewarm: async (proc) => {
    console.log('[Prewarm] Loading Silero VAD weights into memory...');
    proc.userData.vad = await silero.VAD.load({
      activationThreshold: 0.8,
      deactivationThreshold: 0.3,
      minSpeechDuration: 0.8,
      minSilenceDuration: 0.8,
    });
    console.log('[Prewarm] Silero VAD prewarmed successfully.');
  },
  entry: async (ctx) => {
    console.log(`[Agent] Connecting to room...`);
    await ctx.connect();
    console.log(`[Agent] Connected to room: ${ctx.room.name}`);

    // 1. Wait for metadata to sync
    let metadataStr = ctx.room.metadata;
    for (let i = 0; i < 15; i++) {
      if (metadataStr && metadataStr !== '{}') break;
      await new Promise(resolve => setTimeout(resolve, 200));
      metadataStr = ctx.room.metadata;
    }

    // 2. Fallback to participant metadata
    let metadata = {};
    try {
      if (metadataStr && metadataStr !== '{}') {
        metadata = JSON.parse(metadataStr);
      } else {
        console.log('[Agent] Room metadata empty, checking participants...');
        for (const p of ctx.room.participants.values()) {
          if (p.metadata) {
            try {
              metadata = JSON.parse(p.metadata);
              console.log(`[Agent] Found metadata on participant: ${p.identity}`);
              break;
            } catch (e) { }
          }
        }
      }
    } catch (e) {
      console.error(`[Agent] Failed to parse metadata: ${e.message}`);
    }

    const jobId = metadata.job_id || null;
    const applicationId = metadata.application_id || null;
    const resumePath = path.resolve(__dirname, '..', metadata.resume_path || 'ML_Resume.pdf');
    const targetDurationMins = metadata.duration ? parseInt(metadata.duration, 10) : 30;
    console.log(`[Agent] Resume Path: ${resumePath} | Job ID: ${jobId} | Application ID: ${applicationId} | Duration: ${targetDurationMins}m`);

    // 3. Build System Prompt and Load Config
    const { systemPrompt, interviewConfig } = await getSystemPrompt(resumePath, jobId, applicationId);
    console.log(`[Agent] Prompt built. Topics: ${interviewConfig.topics_to_ask?.length || 0}`);

    // 3b. Build topic lookup for skills/level info (matches Python InterviewAgent)
    const skillsByName = {};
    for (const s of (interviewConfig.skills || [])) {
      skillsByName[s.name] = s.level;
    }
    const topicLookup = {};
    for (const topic of (interviewConfig.topics_to_ask || [])) {
      const topicSkills = topic.based_on_skills || [];
      const topicLevels = topicSkills.map(s => skillsByName[s] || 'N/A');
      const primaryLevel = topicLevels.length > 0 ? topicLevels.sort().pop() : 'N/A';
      topicLookup[topic.name] = { skills: topicSkills, level: primaryLevel };
    }
    let currentTopic = null;
    console.log(`[Agent] Topic lookup built: ${Object.keys(topicLookup).length} topics`);
    for (const [name, info] of Object.entries(topicLookup)) {
      console.log(`[Agent]   → ${name}: skills=[${info.skills.join(', ')}] level=${info.level}`);
    }

    // 4. Setup Transcript File
    console.log('[Agent] Creating transcript file in transcripts directory...');
    const transcriptPath = createTranscript(ctx.room.name, interviewConfig, metadata);
    console.log(`[Agent] Transcript initialized: ${transcriptPath}`);

    // 5. Initialize AI Components
    const stt = new sarvam.STT({
      language: 'en-IN',
      model: 'saaras:v3',
      mode: 'transcribe'
    });

    const model = new openai.LLM({
      model: process.env.OLLAMA_MODEL || 'llama3.1',
      baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    });

    const tts = new sarvam.TTS({
      language: 'en-IN',
      model: 'bulbul:v3',
      speaker: 'ritu',
      apiKey: process.env.SARVAM_API_KEY,
    });

    // Catch TTS errors to prevent ERR_UNHANDLED_ERROR crash after session close
    tts.on('error', (err) => {
      console.warn(`[Agent] TTS error (ignored): ${err.message || err}`);
    });

    const vad = ctx.proc.userData.vad;
    console.log('[Agent] AI Components initialized.');
    
    // 6. Setup Time and Topic Tracking
    let sessionStartTime = null;
    let topicsCompleted = 0;
    const totalTopics = interviewConfig.topics_to_ask ? interviewConfig.topics_to_ask.length : 1;

    const transitionTopicTool = llm.tool({
      name: 'transition_topic',
      description: 'Call this immediately AFTER you have spoken your transition phrase out loud. This logs that the conversation is moving to a new topic. Pass the exact name of the new topic.',
      parameters: z.object({
        next_topic_name: z.string().describe('The exact name of the new topic being started.')
      }),
      execute: async ({ next_topic_name }) => {
        if (!sessionStartTime) sessionStartTime = Date.now();
        topicsCompleted++;
        
        const elapsedMs = Date.now() - sessionStartTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        const remainingTopicsCount = Math.max(0, totalTopics - topicsCompleted);
        
        const note = `SYSTEM NOTE: ${elapsedMins} minute(s) have passed out of the ${targetDurationMins}-minute target limit. You have ${remainingTopicsCount} topics remaining. If time is running short, prioritize completing the remaining topics by asking fewer follow-ups and moving quickly.`;
        
        console.log(`[Agent] Time/Topic Tracker: Topic ${topicsCompleted}/${totalTopics} | Elapsed: ${elapsedMins}m/${targetDurationMins}m`);
        return `Transitioned to topic: ${next_topic_name}. ${note}`;
      },
    });

    // 7. Create Voice Agent (instructions + tools only)
    console.log('[Agent] Initializing voice.Agent...');
    const assistant = new voice.Agent({
      instructions: systemPrompt,
      tools: {
        end_call: endCallTool,
        transition_topic: transitionTopicTool
      }
    });
    console.log('[Agent] voice.Agent ready.');

    // 8. Create AgentSession (pipeline components)
    console.log('[Agent] Creating AgentSession...');
    const session = new voice.AgentSession({
      stt,
      llm: model,
      tts,
      vad,
      turnDetection: 'vad',
      allowInterruptions: true,
      minInterruptionDuration: 0.5,
      minEndpointingDelay: 0.5,
      maxEndpointingDelay: 1.5,
    });

    // 9. Start session with agent + room
    console.log('[Agent] Starting session...');
    await session.start({
      agent: assistant,
      room: ctx.room,
    });
    sessionStartTime = Date.now();
    console.log('[Agent] Session started successfully!');


    // 10. Listen for conversation items (transcripts)
    session.on('conversation_item_added', (evt) => {
      try {
        const item = evt.item || evt;
        const role = item.role;
        // text can be a string or array — extract safely
        let text = item.text || item.content;
        if (Array.isArray(text)) {
          text = text.join(' ');
        } else if (text && typeof text !== 'string') {
          text = String(text);
        }
        if (!text || !role) return;
        if (role === 'user') {
          logTurn(transcriptPath, 'Candidate', text);
          console.log(`[Agent] Logged user turn: ${text.substring(0, 60)}`);
        } else if (role === 'assistant') {
          logTurn(transcriptPath, 'Interviewer', text);
          console.log(`[Agent] Logged agent turn: ${text.substring(0, 60)}`);
        }
      } catch (e) {
        console.error(`[Agent] Transcript log error: ${e.message}`);
      }
    });

    // Flag to signal the while loop to exit
    let shouldExit = false;

    // 11. Listen for tool execution results
    session.on('function_tools_executed', (evt) => {
      try {
        for (const call of (evt.functionCalls || [])) {
          const args = typeof call.args === 'string' ? JSON.parse(call.args) : (call.args || {});
          if (call.name === 'transition_topic') {
            const nextTopicName = args.next_topic_name || args.topic_name;

            // Skip if already on this topic
            if (currentTopic === nextTopicName) {
              console.log(`[Agent] Already on topic: ${nextTopicName}, skipping.`);
              continue;
            }

            // End current topic if one is active
            if (currentTopic) {
              const prevInfo = topicLookup[currentTopic] || { skills: [], level: 'N/A' };
              logTopicMarker(transcriptPath, 'END', currentTopic, prevInfo.skills, prevInfo.level);
              console.log(`[Agent] [TOPIC_END] ${currentTopic}`);
            }

            // Start new topic
            const info = topicLookup[nextTopicName] || { skills: [], level: 'N/A' };
            logTopicMarker(transcriptPath, 'START', nextTopicName, info.skills, info.level);
            currentTopic = nextTopicName;
            console.log(`[Agent] [TOPIC_START] ${nextTopicName} (${info.skills.join(', ')}/${info.level})`);

          } else if (call.name === 'end_call') {
            console.log('[Agent] AI decided to end the call. Will exit after farewell...');

            // End current topic if active
            if (currentTopic) {
              const prevInfo = topicLookup[currentTopic] || { skills: [], level: 'N/A' };
              logTopicMarker(transcriptPath, 'END', currentTopic, prevInfo.skills, prevInfo.level);
            }
            // Log session end
            logSessionEnd(transcriptPath);

            // Wait for farewell TTS, then signal exit
            setTimeout(() => {
              console.log('[Agent] Farewell timeout reached. Signaling exit...');
              shouldExit = true;
            }, 8000);
          }
        }
      } catch (e) {
        console.error(`[Agent] Tool handler error: ${e.message}`);
      }
    });

    // 12. Trigger initial greeting
    console.log('[Agent] Triggering initial greeting...');
    session.say('Hello! My name is Ritu, and I will be your interviewer today. How has your day been so far?');

    // Keep entrypoint alive until disconnected or exit signaled
    console.log('[Agent] Waiting for interview to complete...');
    while (ctx.room.connectionState === ConnectionState.CONN_CONNECTED && !shouldExit) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Close session and process transcript BEFORE disconnecting
    console.log('[Agent] Exiting interview loop. Closing session...');
    try {
      await session.close();
      console.log('[Agent] Session closed.');
    } catch (e) {
      console.warn('[Agent] Session close error (expected):', e.message);
    }

    // Post-interview: upload transcript to MongoDB
    console.log(`[Agent] Processing transcript: ${transcriptPath}`);
    try {
      await processTranscript(transcriptPath);
      console.log('[Agent] Transcript processing complete.');
    } catch (err) {
      console.error(`[Agent] Transcript processing error: ${err.message}`);
    }

    // Now disconnect the room
    console.log('[Agent] Disconnecting room...');
    try {
      await ctx.room.disconnect();
    } catch (e) {
      console.warn('[Agent] Room disconnect error:', e.message);
    }
    console.log('[Agent] Done.');
  }
});

export default agent;

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  initializeLogger({ pretty: true, level: 'info' });
  cli.runApp(new WorkerOptions({
    agent: currentFile,
    url: process.env.LIVEKIT_URL
  }));
}
