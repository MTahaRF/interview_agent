/* ═══════════════════════════════════════════════════════════════
   Interview Agent — LiveKit Frontend (app.js)
   ═══════════════════════════════════════════════════════════════
   Two-phase flow:
     1. Setup Screen — enter name + IDs → POST /start-interview + GET /token
     2. Interview Screen — mic, visualizer, transcript (same as before)

   The token server (Node.js) handles:
     - Interview setup → pre-creates room with metadata
     - Token generation → JWT for the created room
   ═══════════════════════════════════════════════════════════════ */

const {
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  ConnectionState,
  DisconnectReason,
  ParticipantEvent,
  DataPacket_Kind,
} = LivekitClient;

// ─── DOM References — Setup Screen ─────────────────────────────
const $setupScreen     = document.getElementById('setup-screen');
const $candidateName   = document.getElementById('input-candidate-name');
const $btnStart        = document.getElementById('btn-start-interview');
const $setupError      = document.getElementById('setup-error');

// ─── DOM References — Advanced Settings ─────────────────────────
const $wsUrl           = document.getElementById('input-ws-url');
const $apiKey          = document.getElementById('input-api-key');
const $tokenServerUrl  = document.getElementById('input-token-server');

// ─── DOM References — Interview Screen ──────────────────────────
const $appMain         = document.getElementById('app-main');
const $badge           = document.getElementById('connection-badge');
const $micSection      = document.getElementById('mic-section');
const $btnMute         = document.getElementById('btn-mute');
const $micFill         = document.getElementById('mic-level-fill');
const $partSection     = document.getElementById('participants-section');
const $partList        = document.getElementById('participants-list');
const $canvas          = document.getElementById('audio-canvas');
const $agentStatus     = document.getElementById('agent-status');
const $transcript      = document.getElementById('transcript-messages');
const $debugLog        = document.getElementById('debug-log');
const $btnClearLog     = document.getElementById('btn-clear-log');
const $agentAudio      = document.getElementById('agent-audio');
const $btnDisconnect   = document.getElementById('btn-disconnect');
const $sessionCandidate= document.getElementById('session-candidate');
const $sessionRoom     = document.getElementById('session-room');
const $sessionTimer    = document.getElementById('session-timer');

// ─── State ──────────────────────────────────────────────────
let room = null;
let isMuted = false;
let micAnalyser = null;
let agentAnalyser = null;
let audioCtx = null;
let animFrameId = null;
let targetDurationMins = 30;
let durationTimerId = null;
let sessionStartTime = null;

// ─── Debug Logger ───────────────────────────────────────────
function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const div = document.createElement('div');
  div.className = `log-line log--${level}`;
  div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(msg)}`;
  $debugLog.appendChild(div);
  $debugLog.scrollTop = $debugLog.scrollHeight;
  console.log(`[${level.toUpperCase()}] ${msg}`);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

$btnClearLog.addEventListener('click', () => {
  $debugLog.innerHTML = '';
});

// ─── Badge ──────────────────────────────────────────────────
function setBadge(state) {
  $badge.className = `badge badge--${state}`;
  $badge.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 1: Setup Screen — Configure + Start Interview
// ═══════════════════════════════════════════════════════════════

function updateStartButton() {
  const nameOk = $candidateName.value.trim().length > 0;
  $btnStart.disabled = !nameOk;
}

$candidateName.addEventListener('input', updateStartButton);

// ─── Setup Error Display ────────────────────────────────────
function showSetupError(msg) {
  $setupError.textContent = msg;
  $setupError.classList.remove('hidden');
}

function hideSetupError() {
  $setupError.classList.add('hidden');
}

// ─── Start Interview ────────────────────────────────────────
$btnStart.addEventListener('click', async () => {
  if ($btnStart.disabled) return;

  const identity     = $candidateName.value.trim();
  const apiKey       = $apiKey.value.trim();
  const tokenServer  = $tokenServerUrl.value.trim();
  const wsUrl        = $wsUrl.value.trim();

  $btnStart.disabled = true;
  $btnStart.innerHTML = `
    <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <circle cx="12" cy="12" r="10" stroke-dasharray="40" stroke-dashoffset="10"/>
    </svg>
    Preparing…
  `;
  hideSetupError();

  try {
    // Step 1: Start interview session (no resume upload)
    log('Starting interview session…');

    const candidateId = document.getElementById('input-candidate-id').value.trim();
    const appId = document.getElementById('input-application-id').value.trim();
    const jobId = document.getElementById('input-job-id').value.trim();
    const durationInput = document.getElementById('input-duration').value.trim();
    targetDurationMins = durationInput ? parseInt(durationInput, 10) : 30;

    const payload = {
      identity,
      duration: targetDurationMins,
    };
    if (candidateId) payload.candidate_id = candidateId;
    if (appId) payload.application_id = appId;
    if (jobId) payload.job_id = jobId;

    // Include interview config if provided
    const configText = document.getElementById('input-interview-config').value.trim();
    if (configText) {
      try {
        JSON.parse(configText); // validate JSON
        payload.interviewConfig = configText;
        log('Interview config attached.', 'info');
      } catch (e) {
        throw new Error('Invalid JSON in Interview Config: ' + e.message);
      }
    }

    const startRes = await fetch(`${tokenServer}/start-interview`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({ error: `HTTP ${startRes.status}` }));
      throw new Error(err.error || `Start failed: HTTP ${startRes.status}`);
    }

    const { roomName } = await startRes.json();
    log(`Interview session created. Room: ${roomName}`, 'info');

    // Step 2: Get token
    log('Fetching token…');
    const tokenUrl = `${tokenServer}/token?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(identity)}`;
    const tokenRes = await fetch(tokenUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({ error: `HTTP ${tokenRes.status}` }));
      throw new Error(err.error || `Token failed: HTTP ${tokenRes.status}`);
    }

    const { token } = await tokenRes.json();
    log('Token received.', 'info');

    // Step 3: Update session info and switch screens
    $sessionCandidate.textContent = identity;
    $sessionRoom.textContent = roomName;
    $sessionTimer.textContent = `${String(targetDurationMins).padStart(2, '0')}:00`;

    // Switch to interview UI
    $setupScreen.classList.add('hidden');
    $appMain.classList.remove('hidden');

    // Step 4: Connect to LiveKit
    await connectToRoom(wsUrl, token);

  } catch (err) {
    showSetupError(err.message);
    $btnStart.disabled = false;
    $btnStart.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
      Start Interview
    `;
  }
});

// ═══════════════════════════════════════════════════════════════
//  PHASE 2: Interview Screen — Connect, Audio, Transcript
// ═══════════════════════════════════════════════════════════════

async function connectToRoom(wsUrl, token) {
  try {
    setBadge('connecting');
    log('Initiating connection…');

    room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // ── Room event handlers ──
    room.on(RoomEvent.Connected, () => {
      log('✓ Connected to room!', 'info');
      setBadge('connected');
      $btnDisconnect.disabled = false;
      $micSection.classList.remove('hidden');
      $partSection.classList.remove('hidden');
      $agentStatus.textContent = 'Connected — waiting for agent…';
      updateParticipants();
      
      // Start the UI Timer
      sessionStartTime = Date.now();
      const targetMs = targetDurationMins * 60 * 1000;
      
      if (durationTimerId) clearInterval(durationTimerId);
      durationTimerId = setInterval(() => {
        const elapsed = Date.now() - sessionStartTime;
        const remainingMs = targetMs - elapsed;
        
        const isNegative = remainingMs < 0;
        const absMs = Math.abs(remainingMs);
        const m = Math.floor(absMs / 60000);
        const s = Math.floor((absMs % 60000) / 1000);
        
        const timeStr = `${isNegative ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        $sessionTimer.textContent = timeStr;
        
        // CSS states
        if (isNegative) {
          $sessionTimer.classList.remove('timer-warning');
          $sessionTimer.classList.add('timer-danger');
        } else if (remainingMs <= 5 * 60 * 1000) { // 5 mins left
          $sessionTimer.classList.add('timer-warning');
        } else {
          $sessionTimer.classList.remove('timer-warning', 'timer-danger');
        }
      }, 1000);
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      log(`✗ Disconnected. Reason: ${reason ?? 'unknown'}`, 'warn');
      handleDisconnect();
    });

    room.on(RoomEvent.Reconnecting, () => {
      log('Reconnecting…', 'warn');
      setBadge('connecting');
    });

    room.on(RoomEvent.Reconnected, () => {
      log('✓ Reconnected', 'info');
      setBadge('connected');
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      log(`Participant joined: ${participant.identity}`, 'event');
      updateParticipants();
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      log(`Participant left: ${participant.identity}`, 'event');
      updateParticipants();
    });

    // ── Track subscriptions ──
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      log(`Track subscribed: ${track.kind} from ${participant.identity}`, 'event');

      if (track.kind === Track.Kind.Audio) {
        track.attach($agentAudio);
        log('Agent audio attached to playback element.', 'info');
        $agentStatus.textContent = 'Agent connected';
        $agentStatus.classList.add('speaking');
        setupAgentAnalyser(track);
        
        // High priority helps the browser prioritize these audio packets for low latency
        track.setPriority('high');
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      log(`Track unsubscribed: ${track.kind}`, 'event');
      $agentStatus.textContent = 'Agent disconnected';
      $agentStatus.classList.remove('speaking');
    });

    // ── Transcription events ──
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      for (const seg of segments) {
        const isAgent = participant?.identity !== room.localParticipant.identity;
        addTranscriptMessage(
          isAgent ? 'Agent' : 'You',
          seg.text,
          isAgent ? 'agent' : 'user',
          seg.id,
          seg.final
        );
      }
    });

    room.on(RoomEvent.DataReceived, (payload, participant, kind) => {
      try {
        const text = new TextDecoder().decode(payload);
        log(`Data received from ${participant?.identity ?? 'unknown'}: ${text.substring(0, 80)}…`, 'event');
      } catch { /* ignore binary data */ }
    });

    // ── Connect! ──
    log(`Connecting to ${wsUrl}…`);
    await room.connect(wsUrl, token);

    // Enable microphone
    log('Publishing microphone…');
    await room.localParticipant.setMicrophoneEnabled(true);
    log('✓ Microphone published.', 'info');

    // Set up mic level meter
    setupMicAnalyser();

    // Start visualizer
    startVisualizer();

  } catch (err) {
    log(`Connection failed: ${err.message}`, 'error');
    setBadge('disconnected');
  }
}

// ─── Disconnect ─────────────────────────────────────────────
$btnDisconnect.addEventListener('click', () => {
  if (room) {
    room.disconnect();
  }
});

function handleDisconnect() {
  setBadge('disconnected');
  $btnDisconnect.disabled = true;
  $micSection.classList.add('hidden');
  $partSection.classList.add('hidden');
  $agentStatus.textContent = 'Interview ended';
  $agentStatus.classList.remove('speaking');
  if (durationTimerId) {
    clearInterval(durationTimerId);
    durationTimerId = null;
  }
  if (animFrameId) cancelAnimationFrame(animFrameId);
  room = null;
}

// ─── Mute Toggle ────────────────────────────────────────────
$btnMute.addEventListener('click', () => {
  if (!room) return;
  isMuted = !isMuted;
  room.localParticipant.setMicrophoneEnabled(!isMuted);
  $btnMute.textContent = isMuted ? '🔇 Unmute' : '🎤 Mute';
  log(isMuted ? 'Microphone muted.' : 'Microphone unmuted.', 'info');
});

// ─── Participants ───────────────────────────────────────────
function updateParticipants() {
  if (!room) return;
  $partList.innerHTML = '';

  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  for (const p of all) {
    const li = document.createElement('li');
    li.className = 'participant-item';
    const isLocal = p === room.localParticipant;
    const isAgent = !isLocal;
    li.innerHTML = `
      <span class="participant-dot"></span>
      <span>${escapeHtml(p.identity || 'unknown')}</span>
      <span class="participant-tag ${isAgent ? 'participant-tag--agent' : 'participant-tag--user'}">
        ${isAgent ? 'Agent' : 'You'}
      </span>
    `;
    $partList.appendChild(li);
  }
}

// ─── Transcript ─────────────────────────────────────────────
function addTranscriptMessage(sender, text, role, id, isFinal) {
  if (!text || !text.trim()) return;

  const placeholder = $transcript.querySelector('.transcript-placeholder');
  if (placeholder) placeholder.remove();

  let div = document.getElementById(`msg-${id}`);
  if (!div) {
    div = document.createElement('div');
    div.id = `msg-${id}`;
    div.className = `msg msg--${role}`;
    
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    div.innerHTML = `
      <span class="msg-sender">${escapeHtml(sender)}</span>
      <span class="msg-text">${escapeHtml(text)}</span>
      <span class="msg-time">${ts}</span>
    `;
    $transcript.appendChild(div);
  } else {
    const textSpan = div.querySelector('.msg-text');
    if (textSpan) textSpan.textContent = text;
  }
  
  if (!isFinal) {
    div.classList.add('msg--interim');
  } else {
    div.classList.remove('msg--interim');
  }

  const container = document.getElementById('transcript-container');
  container.scrollTop = container.scrollHeight;
}

// ─── Audio Analysers ────────────────────────────────────────
function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function setupMicAnalyser() {
  try {
    const tracks = room.localParticipant.getTrackPublications();
    for (const [, pub] of tracks) {
      if (pub.track && pub.track.kind === Track.Kind.Audio) {
        const ctx = getAudioContext();
        const stream = new MediaStream([pub.track.mediaStreamTrack]);
        const source = ctx.createMediaStreamSource(stream);
        micAnalyser = ctx.createAnalyser();
        micAnalyser.fftSize = 256;
        source.connect(micAnalyser);
        log('Mic analyser connected.', 'info');
        return;
      }
    }
  } catch (e) {
    log(`Mic analyser error: ${e.message}`, 'warn');
  }
}

function setupAgentAnalyser(track) {
  try {
    const ctx = getAudioContext();
    const stream = new MediaStream([track.mediaStreamTrack]);
    const source = ctx.createMediaStreamSource(stream);
    agentAnalyser = ctx.createAnalyser();
    agentAnalyser.fftSize = 256;
    source.connect(agentAnalyser);
    log('Agent audio analyser connected.', 'info');
  } catch (e) {
    log(`Agent analyser error: ${e.message}`, 'warn');
  }
}

// ─── Visualizer ─────────────────────────────────────────────
function startVisualizer() {
  const ctx2d = $canvas.getContext('2d');
  const W = $canvas.width;
  const H = $canvas.height;

  function draw() {
    animFrameId = requestAnimationFrame(draw);

    ctx2d.fillStyle = '#151a25';
    ctx2d.fillRect(0, 0, W, H);

    // Mic levels → green bar
    if (micAnalyser) {
      const data = new Uint8Array(micAnalyser.frequencyBinCount);
      micAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const pct = Math.min(100, (avg / 128) * 100);
      $micFill.style.width = pct + '%';

      // Draw mic waveform (bottom half)
      const timeData = new Uint8Array(micAnalyser.fftSize);
      micAnalyser.getByteTimeDomainData(timeData);

      ctx2d.beginPath();
      ctx2d.strokeStyle = 'rgba(6, 182, 212, 0.6)';
      ctx2d.lineWidth = 2;
      const sliceW = W / timeData.length;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 128.0;
        const y = (H * 0.75) + (v - 1) * (H * 0.2);
        if (i === 0) ctx2d.moveTo(0, y);
        else ctx2d.lineTo(i * sliceW, y);
      }
      ctx2d.stroke();
    }

    // Agent waveform (top half)
    if (agentAnalyser) {
      const timeData = new Uint8Array(agentAnalyser.fftSize);
      agentAnalyser.getByteTimeDomainData(timeData);

      ctx2d.beginPath();
      ctx2d.strokeStyle = 'rgba(124, 58, 237, 0.7)';
      ctx2d.lineWidth = 2;
      const sliceW = W / timeData.length;
      for (let i = 0; i < timeData.length; i++) {
        const v = timeData[i] / 128.0;
        const y = (H * 0.25) + (v - 1) * (H * 0.2);
        if (i === 0) ctx2d.moveTo(0, y);
        else ctx2d.lineTo(i * sliceW, y);
      }
      ctx2d.stroke();
    }

    // Labels
    ctx2d.fillStyle = 'rgba(167, 139, 250, 0.5)';
    ctx2d.font = '10px Inter, sans-serif';
    ctx2d.fillText('AGENT', 8, 14);

    ctx2d.fillStyle = 'rgba(6, 182, 212, 0.5)';
    ctx2d.fillText('YOU', 8, H - 6);

    // Center divider
    ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, H / 2);
    ctx2d.lineTo(W, H / 2);
    ctx2d.stroke();
  }

  draw();
}

// ─── Init ───────────────────────────────────────────────────
log('Frontend loaded. Ready to connect.', 'info');
log(`LiveKit SDK version: ${LivekitClient.version}`, 'info');
log('Enter your name and click Start Interview to begin.', 'info');
