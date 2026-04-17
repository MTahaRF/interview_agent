/**
 * postinstall.js — Auto-patches node_modules after `npm install`
 *
 * Fixes two latency issues:
 * 1. Sarvam TTS WebSocket 408 timeout: Injects a ping keep-alive every 5s.
 * 2. LiveKit SDK idle timeouts: Increases TTS_READ and FORWARD_AUDIO timeouts
 *    from 10s to 30s so slow LLMs (e.g. local Ollama) don't cause stream kills.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const nodeModules = path.resolve(__dirname, '..', 'node_modules');

let patchCount = 0;

function patchFile(relPath, patches) {
  const absPath = path.join(nodeModules, relPath);
  if (!fs.existsSync(absPath)) {
    console.warn(`[postinstall] SKIP: ${relPath} not found`);
    return;
  }

  let content = fs.readFileSync(absPath, 'utf8');
  let changed = false;

  for (const { find, replace, label } of patches) {
    if (content.includes(replace)) {
      console.log(`[postinstall] ✓ ${label} — already applied`);
      continue;
    }
    if (!content.includes(find)) {
      console.warn(`[postinstall] ⚠ ${label} — target string not found, skipping`);
      continue;
    }
    content = content.replace(find, replace);
    changed = true;
    patchCount++;
    console.log(`[postinstall] ✓ ${label} — applied`);
  }

  if (changed) {
    fs.writeFileSync(absPath, content, 'utf8');
  }
}

// ─── Patch 1: Sarvam TTS ping keep-alive ───────────────────────────────────
const sarvamPingFind = `    try {
      await Promise.all([inputTask(), sendTask(), recvTask()]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(\`Sarvam TTS streaming failed: \${msg}\`);
    } finally {
      await this.closeWebSocket(ws);
    }`;

const sarvamPingReplace = `    try {
      // Keep-alive: send periodic pings to prevent Sarvam 408 timeout
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 5000);
      try {
        await Promise.all([inputTask(), sendTask(), recvTask()]);
      } finally {
        clearInterval(pingInterval);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(\`Sarvam TTS streaming failed: \${msg}\`);
    } finally {
      await this.closeWebSocket(ws);
    }`;

patchFile('@livekit/agents-plugin-sarvam/dist/tts.js', [
  { find: sarvamPingFind, replace: sarvamPingReplace, label: 'Sarvam TTS ping keep-alive' },
]);

// ─── Patch 2: LiveKit SDK idle timeouts (10s → 30s) ────────────────────────
const sdkTimeoutPatches = [
  { find: 'const TTS_READ_IDLE_TIMEOUT_MS = 1e4;', replace: 'const TTS_READ_IDLE_TIMEOUT_MS = 3e4;', label: 'TTS_READ_IDLE_TIMEOUT 10s→30s' },
  { find: 'const FORWARD_AUDIO_IDLE_TIMEOUT_MS = 1e4;', replace: 'const FORWARD_AUDIO_IDLE_TIMEOUT_MS = 3e4;', label: 'FORWARD_AUDIO_IDLE_TIMEOUT 10s→30s' },
];

patchFile('@livekit/agents/dist/voice/generation.js', sdkTimeoutPatches);
patchFile('@livekit/agents/dist/voice/generation.cjs', sdkTimeoutPatches);

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n[postinstall] Done. ${patchCount} patch(es) applied.`);
