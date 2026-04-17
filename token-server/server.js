/**
 * Token Server — Node.js Express replacement for token_server.py
 * ═══════════════════════════════════════════════════════════════
 *
 * Run:   npm start         (or:  npm run dev  for auto-reload)
 *
 * Endpoints:
 *   GET  /token?room=<room>&identity=<identity>   →  { token }
 *   POST /start-interview                          →  { roomName }
 *   GET  /health                                  →  { status: "ok" }
 *
 * Auth:
 *   All endpoints except /health require:
 *     Authorization: Bearer <INTERVIEW_API_KEY>
 *
 * Env vars (loaded from ../.env):
 *   LIVEKIT_URL          LiveKit server URL (ws://... or wss://...)
 *   LIVEKIT_API_KEY      LiveKit API key
 *   LIVEKIT_API_SECRET   LiveKit API secret
 *   INTERVIEW_API_KEY    Auth key for this server's endpoints
 *   TOKEN_SERVER_PORT    Port to listen on (default: 8081)
 */

import 'dotenv/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

// Load .env from the parent directory (project root)
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

// ─── Config ────────────────────────────────────────────────────
const PORT            = parseInt(process.env.TOKEN_SERVER_PORT || '8081', 10);
const LIVEKIT_URL     = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const API_KEY         = process.env.LIVEKIT_API_KEY || 'devkey';
const API_SECRET      = process.env.LIVEKIT_API_SECRET || 'secret';
const INTERVIEW_KEY   = process.env.INTERVIEW_API_KEY || 'dev-interview-key';

// Convert ws:// to http:// for the RoomServiceClient
const LIVEKIT_HTTP_URL = LIVEKIT_URL
  .replace('wss://', 'https://')
  .replace('ws://', 'http://');

const roomMetadataCache = new Map(); // Store metadata by roomName for token sync

// ─── Express App ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ─── Logging Middleware ────────────────────────────────────────
app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[TokenServer] ${ts}  ${req.method} ${req.path}`);
  next();
});

// ─── Serve Frontend Static Files ──────────────────────────────
const FRONTEND_DIR = resolve(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

// ─── Auth Middleware ───────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.slice(7);
  if (token !== INTERVIEW_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

// ─── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── GET /token ────────────────────────────────────────────────
app.get('/token', authMiddleware, async (req, res) => {
  try {
    const roomName = req.query.room || 'test_room';
    const identity = req.query.identity || 'dev-user';

    const at = new AccessToken(API_KEY, API_SECRET, {
      identity,
      name: identity,
      ttl: '2h',
    });

    // Populate token metadata from cache if available
    if (roomMetadataCache.has(roomName)) {
      at.metadata = roomMetadataCache.get(roomName);
      console.log(`[TokenServer] Attached metadata to token for ${identity} in ${roomName}`);
    }

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await at.toJwt();

    console.log(`[TokenServer] Token issued for "${identity}" in room "${roomName}"`);
    res.json({ token: jwt });
  } catch (err) {
    console.error('[TokenServer] Token generation failed:', err.message);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

// ─── POST /start-interview ────────────────────────────────────
app.post('/start-interview', authMiddleware, async (req, res) => {
  try {
    console.log('[TokenServer] /start-interview body:', req.body);

    const identity = req.body.identity || 'candidate';
    const sessionId = uuidv4();
    const roomName = `interview-${sessionId}`;

    // Save interview config if provided
    let interviewConfigPath = null;
    if (req.body.interviewConfig) {
      try {
        // Validate it's valid JSON
        const configData = JSON.parse(req.body.interviewConfig);
        const configFilename = `${sessionId}_config.json`;
        const configDir = resolve(__dirname, '..', 'configs');
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }
        const configFullPath = resolve(configDir, configFilename);

        const { writeFileSync } = await import('fs');
        writeFileSync(configFullPath, JSON.stringify(configData, null, 2), 'utf-8');

        interviewConfigPath = `configs/${configFilename}`;
        console.log(`[TokenServer] Interview config saved: ${interviewConfigPath}`);
      } catch (parseErr) {
        console.error('[TokenServer] Invalid interview config JSON:', parseErr.message);
        return res.status(400).json({ error: 'Invalid interviewConfig JSON' });
      }
    }

    // Pre-create the LiveKit room with metadata
    const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET);
    const roomMetadata = {
      candidate_identity: identity,
      candidate_id: req.body.candidate_id || null,
      application_id: req.body.application_id || null,
      job_id: req.body.job_id || null,
      duration: req.body.duration || 30,
      created_at: new Date().toISOString(),
    };

    if (interviewConfigPath) {
      roomMetadata.interview_config_path = interviewConfigPath;
    }

    const roomMetadataStr = JSON.stringify(roomMetadata);
    console.log('[TokenServer] Creating room with metadata:', roomMetadataStr);
    
    // Store in cache for token endpoint
    roomMetadataCache.set(roomName, roomMetadataStr);
    // Cleanup cache after 15 minutes
    setTimeout(() => roomMetadataCache.delete(roomName), 15 * 60 * 1000);

    await roomService.createRoom({
      name: roomName,
      metadata: roomMetadataStr,
      emptyTimeout: 600,    // Auto-delete room after 10 min idle
      maxParticipants: 3,   // Candidate + Agent + optional observer
    });

    console.log(`[TokenServer] Room pre-created: ${roomName}`);

    res.json({
      roomName,
      interviewConfigPath,
    });
  } catch (err) {
    console.error('[TokenServer] Interview start failed:', err.message);
    res.status(500).json({ error: 'Interview start failed' });
  }
});

// ─── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[TokenServer] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log(`║  Token Server (Node.js) running on port ${PORT}      ║`);
  console.log(`║  GET  http://127.0.0.1:${PORT}/token                 ║`);
  console.log(`║  POST http://127.0.0.1:${PORT}/start-interview        ║`);
  console.log(`║  GET  http://127.0.0.1:${PORT}/health                ║`);
  console.log('║                                                   ║');
  console.log(`║  Auth: Bearer ${INTERVIEW_KEY.slice(0, 8)}…${' '.repeat(Math.max(0, 26 - INTERVIEW_KEY.slice(0, 8).length))}║`);
  console.log(`║  LiveKit: ${LIVEKIT_HTTP_URL.slice(0, 30).padEnd(30)}          ║`);
  console.log('╚═══════════════════════════════════════════════════╝');
});
