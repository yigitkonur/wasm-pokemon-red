'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const express = require('express');
const cors = require('cors');

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
  const ttlSec = activePlayerId && turnStartedAt
    ? Math.max(0, TURN_TTL - Math.round((Date.now() - turnStartedAt) / 1000))
    : 0;
  const activeInfo = queue.find(p => p.id === activePlayerId);
  broadcastAll('status', {
    activeId: activePlayerId,
    activeName: activeInfo ? activeInfo.nickname : null,
    queueLen: queue.length,
    viewers: clients.size,
    turnTTL: ttlSec,
  });
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
  activePlayerId = player.id;
  turnStartedAt = Date.now();
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
    broadcastStatus();
  }

  // Clear Redis turn lock
  try {
    await redisExec('DEL', 'game:active_player');
  } catch (e) { console.warn('[redis] clear turn:', e.message); }
}

async function handleJoin(ws, { id, nickname }) {
  const info = clients.get(ws);
  if (!info || info.joined) return;

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
}

async function handleChat(ws, { text }) {
  const info = clients.get(ws);
  if (!info) return;
  text = (text || '').trim();
  if (!text || text.length > 280) return;

  const msg = { id: crypto.randomUUID(), pid: info.id, nick: info.nickname, text, ts: Date.now() };
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
  if (!info || info.id !== activePlayerId) return;
  if (!state) return;

  // Relay to spectators immediately
  for (const [clientWs, clientInfo] of clients) {
    if (clientWs !== ws && clientInfo.joined) {
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

// ── Express HTTP + WebSocket server ────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, clients: clients.size, queue: queue.length, active: activePlayerId });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Generate a temp ID until JOIN is received
  const connId = crypto.randomUUID();
  clients.set(ws, { id: connId, nickname: 'Spectator', joined: false });
  console.log(`[ws] connect: ${connId} (total: ${clients.size})`);

  // Send chat history on connect
  sendChatHistory(ws);
  // Send current status
  broadcastStatus();

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
        case 'ping':
          send(ws, 'pong', {});
          break;
      }
    } catch (err) {
      console.error('[ws] handler error:', err);
    }
  });

  ws.on('close', async () => {
    console.log(`[ws] disconnect: ${clients.get(ws)?.id}`);
    await handleLeave(ws);
    clients.delete(ws);
    broadcastStatus();
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Pokemon Arcade server running on port ${PORT}`);
});
