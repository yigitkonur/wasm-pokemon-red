'use strict';
const WebSocket = require('../server/node_modules/ws');
const WS_URL = 'wss://pokemon-arcade-server-production.up.railway.app/ws';

let passed = 0;
let failed = 0;
const results = [];

function check(label, val) {
  if (val) { passed++; results.push('  ✓ ' + label); }
  else      { failed++; results.push('  ✗ ' + label); }
}

const ws = new WebSocket(WS_URL);
const msgs = [];

ws.on('message', (data) => {
  try { msgs.push(JSON.parse(data)); } catch(_) {}
});

ws.on('open', () => {
  setTimeout(() => {
    ws.close();

    const statusMsg = msgs.find(m => m.type === 'status');
    const aiMsg     = msgs.find(m => m.type === 'ai_granted');

    check('received status message',          !!statusMsg);
    check('status has activeMode field',       statusMsg && 'activeMode' in statusMsg);
    check('status has aiHostId field',         statusMsg && 'aiHostId' in statusMsg);
    check('received ai_granted (first spectator)', !!aiMsg);
    if (aiMsg) check('ai_granted has reason field', 'reason' in aiMsg);

    console.log('\n── WS Smoke Test ──');
    results.forEach(r => console.log(r));
    const ok = failed === 0;
    console.log('\n' + (ok ? '✅  All WS checks passed.' : ('❌  ' + failed + ' check(s) failed.')));
    process.exit(ok ? 0 : 1);
  }, 2500);
});

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
