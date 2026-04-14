'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://shining-aphid-98269.upstash.io';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAX_dAAIncDFiYTBjMmYyMjdjN2Q0Y2ZlYjA4YjFhZmJiZjhjN2NmZXAxOTgyNjk';
const TURN_TTL = 6;      // seconds — Redis key expiry
const IDLE_MS = 5000;    // ms — idle timeout before turn passes
const CHAT_CAP = 200;

// ── Redis REST helpers ──────────────────────────────────────────────────────
async function redisExec(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error('Redis ' + res.status);
  return (await res.json()).result;
}

async function redisPipeline(cmds) {
  const res = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error('Redis pipeline ' + res.status);
  return (await res.json()).map(r => r.result);
}

// ── State ───────────────────────────────────────────────────────────────────
// clients: Map<ws, { id, nickname, joined }>
const clients = new Map();
// queue: [{ id, nickname }]
let queue = [];
let activePlayerId = null;
let idleTimer = null;
let turnStartedAt = null;
let lastInputAt = null;

// AI host state
let activeMode = 'idle'; // 'idle' | 'human' | 'ai'
let aiHostId = null;
let aiHostWs = null;
let aiIdleTimer = null;
const AI_IDLE_MS = 8000; // revoke AI if no heartbeat within this window
const AI_ELECT_DELAY_MS = 1000; // ms after turn ends before electing AI host

// ── Broadcast helpers ───────────────────────────────────────────────────────
function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(type, payload, excludeWs = null) {
  for (const [ws] of clients) {
    if (ws !== excludeWs) send(ws, type, payload);
  }
}

function broadcastAll(type, payload) {
  broadcast(type, payload, null);
}

function broadcastStatus() {
  const ttlSec = activePlayerId && lastInputAt
    ? Math.max(0, Math.ceil((IDLE_MS - (Date.now() - lastInputAt)) / 1000))
    : 0;
  const activeInfo = queue.find(p => p.id === activePlayerId);
  broadcastAll('status', {
    activeId: activePlayerId,
    activeName: activeInfo ? activeInfo.nickname : null,
    queueLen: queue.length,
    viewers: clients.size,
    turnTTL: ttlSec,
    activeMode,
    aiHostId,
  });
}

// ── AI Host management ──────────────────────────────────────────────────────
function clearAiIdleTimer() {
  if (aiIdleTimer) { clearTimeout(aiIdleTimer); aiIdleTimer = null; }
}

function scheduleAiTimeout() {
  clearAiIdleTimer();
  aiIdleTimer = setTimeout(() => {
    if (aiHostId) {
      console.log(`[ai] idle timeout for ${aiHostId}`);
      revokeAiHost('timeout');
      setTimeout(electAiHost, AI_ELECT_DELAY_MS);
    }
  }, AI_IDLE_MS);
}

/** Revoke AI host control and notify them. */
function revokeAiHost(reason) {
  clearAiIdleTimer();
  if (!aiHostId) return;
  const prevWs = aiHostWs;
  const prevId = aiHostId;
  aiHostId = null;
  aiHostWs = null;
  if (activeMode === 'ai') activeMode = 'idle';
  if (prevWs && prevWs.readyState === prevWs.OPEN) {
    send(prevWs, 'ai_revoked', { reason });
  }
  console.log(`[ai] revoked from ${prevId} (${reason})`);
}

/**
 * Elect a spectator (connected, not in queue) as AI host.
 * No-op if a human player is active or an AI host is already set.
 */
function electAiHost() {
  if (activePlayerId || aiHostId) return;
  for (const [ws, info] of clients) {
    if (!info.joined && ws.readyState === ws.OPEN) {
      aiHostId = info.id;
      aiHostWs = ws;
      activeMode = 'ai';
      scheduleAiTimeout();
      send(ws, 'ai_granted', { reason: 'no_human' });
      broadcastStatus();
      console.log(`[ai] granted to spectator ${info.id}`);
      return;
    }
  }
}

// ── Turn management ─────────────────────────────────────────────────────────
function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleTurnTimeout() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    if (activePlayerId) {
      console.log(`[turn] idle timeout for ${activePlayerId}`);
      revokeAndAdvance('idle');
    }
  }, IDLE_MS);
}

async function grantTurn(player) {
  // Revoke AI control before granting to human
  revokeAiHost('human_turn');
  activeMode = 'human';
  activePlayerId = player.id;
  turnStartedAt = Date.now();
  lastInputAt = Date.now();
  scheduleTurnTimeout();

  // Set in Redis too (for persistence / crash recovery)
  try {
    await redisExec('SET', 'game:active_player', player.id, 'EX', String(TURN_TTL + 2));
  } catch (e) { console.warn('[redis] grant turn:', e.message); }

  // Notify active player
  for (const [ws, info] of clients) {
    if (info.id === player.id) {
      send(ws, 'turn_granted', { playerId: player.id, nickname: player.nickname });
    } else if (info.joined) {
      send(ws, 'turn_revoked', { reason: 'next_player' });
    }
  }
  broadcastStatus();
  console.log(`[turn] granted to ${player.nickname} (${player.id})`);
}

async function revokeAndAdvance(reason) {
  clearIdleTimer();
  const prev = activePlayerId;
  activePlayerId = null;
  turnStartedAt = null;
  lastInputAt = null;

  // Notify previous active player
  for (const [ws, info] of clients) {
    if (info.id === prev) {
      send(ws, 'turn_revoked', { reason });
    }
  }

  // Rotate queue: move expired player to end
  const idx = queue.findIndex(p => p.id === prev);
  if (idx >= 0) {
    const [player] = queue.splice(idx, 1);
    queue.push(player);
  }

  // Grant to next in queue
  if (queue.length > 0) {
    await grantTurn(queue[0]);
  } else {
    activeMode = 'idle';
    broadcastStatus();
    // No humans remain — elect an AI host after a short delay
    setTimeout(electAiHost, AI_ELECT_DELAY_MS);
  }

  // Clear Redis turn lock
  try {
    await redisExec('DEL', 'game:active_player');
  } catch (e) { console.warn('[redis] clear turn:', e.message); }
}

async function handleJoin(ws, { id, nickname }) {
  const info = clients.get(ws);
  if (!info || info.joined) return;

  // If this spectator was the AI host, revoke before they join as human
  if (info.id === aiHostId) {
    revokeAiHost('self_joined');
  }

  // Clean nickname
  nickname = (nickname || 'Trainer').trim().substring(0, 16) || 'Trainer';
  info.nickname = nickname;
  info.joined = true;

  // Add to queue if not already there
  if (!queue.find(p => p.id === id)) {
    queue.push({ id, nickname });
  }

  // Save name to Redis
  try {
    await redisExec('SET', `player:${id}:name`, nickname, 'EX', '3600');
  } catch (e) { /* best effort */ }

  send(ws, 'joined', { queuePos: queue.findIndex(p => p.id === id) + 1 });
  broadcastStatus();

  // If nobody is active, grant turn
  if (!activePlayerId) {
    await grantTurn(queue[0]);
  }
}

async function handleLeave(ws) {
  const info = clients.get(ws);
  if (!info || !info.joined) return;
  info.joined = false;
  queue = queue.filter(p => p.id !== info.id);

  if (activePlayerId === info.id) {
    await revokeAndAdvance('disconnect');
  } else {
    broadcastStatus();
  }
}

function handleInput(ws) {
  const info = clients.get(ws);
  if (!info || info.id !== activePlayerId) return;
  // Reset idle timer
  scheduleTurnTimeout();
  lastInputAt = Date.now();
}

async function handleChat(ws, { text }) {
  const info = clients.get(ws);
  if (!info) return;
  text = (text || '').trim();
  if (!text || text.length > 280) return;

  const msg = { id: randomUUID(), pid: info.id, nick: info.nickname, text, ts: Date.now() };
  const msgStr = JSON.stringify(msg);

  // Broadcast to all clients immediately
  broadcastAll('chat_msg', { msg });

  // Persist to Redis
  try {
    await redisPipeline([
      ['LPUSH', 'game:chat', msgStr],
      ['LTRIM', 'game:chat', '0', String(CHAT_CAP - 1)],
    ]);
  } catch (e) { console.warn('[redis] chat persist:', e.message); }
}

async function handleStatePush(ws, { state, sram }) {
  const info = clients.get(ws);
  if (!info) return;
  // Accept state from active human player OR current AI host
  if (info.id !== activePlayerId && info.id !== aiHostId) return;
  if (!state) return;

  // Relay to all connected clients (including spectators)
  for (const [clientWs] of clients) {
    if (clientWs !== ws) {
      send(clientWs, 'game_state', { state, sram });
    }
  }

  // Persist to Redis
  try {
    await redisPipeline([
      ['SET', 'game:state', state],
      ['SET', 'game:sram', sram || ''],
      ['INCR', 'game:version'],
    ]);
  } catch (e) { console.warn('[redis] state push:', e.message); }
}

// ── Load chat history from Redis ────────────────────────────────────────────
async function sendChatHistory(ws) {
  try {
    const raw = await redisExec('LRANGE', 'game:chat', '0', '49');
    if (!raw || !raw.length) return;
    const msgs = raw.map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean).reverse();
    send(ws, 'chat_history', { msgs });
  } catch (e) { console.warn('[redis] chat history:', e.message); }
}

async function sendInitialState(ws) {
  try {
    const [state, sram] = await redisPipeline([
      ['GET', 'game:state'],
      ['GET', 'game:sram'],
    ]);
    if (state) send(ws, 'game_state', { state, sram: sram || '' });
  } catch (e) { console.warn('[redis] initial state:', e.message); }
}

// ── Express HTTP + WebSocket server ────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, clients: clients.size, queue: queue.length, active: activePlayerId, mode: activeMode, aiHost: aiHostId });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Generate a temp ID until JOIN is received
  const connId = randomUUID();
  clients.set(ws, { id: connId, nickname: 'Spectator', joined: false });
  console.log(`[ws] connect: ${connId} (total: ${clients.size})`);

  // Send chat history on connect
  sendChatHistory(ws);
  sendInitialState(ws);
  // Send current status
  broadcastStatus();

  // Elect AI host if nobody is controlling the cabinet
  setTimeout(electAiHost, AI_ELECT_DELAY_MS);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const { type } = msg;

    try {
      switch (type) {
        case 'join':
          // Update permanent ID from client
          clients.get(ws).id = msg.id || connId;
          await handleJoin(ws, msg);
          break;
        case 'leave':
          await handleLeave(ws);
          break;
        case 'input':
          handleInput(ws);
          break;
        case 'chat':
          await handleChat(ws, msg);
          break;
        case 'state_push':
          await handleStatePush(ws, msg);
          break;
        case 'ai_input': {
          // Heartbeat from AI host to keep control alive
          const ainfo = clients.get(ws);
          if (ainfo && ainfo.id === aiHostId) scheduleAiTimeout();
          break;
        }
        case 'ping':
          send(ws, 'pong', {});
          break;
      }
    } catch (err) {
      console.error('[ws] handler error:', err);
    }
  });

  ws.on('close', async () => {
    const info = clients.get(ws);
    console.log(`[ws] disconnect: ${info?.id}`);

    // If AI host disconnects, revoke and try to re-elect
    if (info && info.id === aiHostId) {
      revokeAiHost('disconnect');
    }

    await handleLeave(ws);
    clients.delete(ws);
    broadcastStatus();

    // Re-elect AI host if needed after any disconnect
    setTimeout(electAiHost, AI_ELECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Pokemon Arcade server running on port ${PORT}`);
});
