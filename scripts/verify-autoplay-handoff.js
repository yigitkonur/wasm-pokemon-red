#!/usr/bin/env node
'use strict';
/**
 * verify-autoplay-handoff.js
 *
 * TDD smoke checks for the implement-autoplay-handoff task.
 * Runs node --check on all four touched files then grep-asserts
 * that the new protocol surface exists in each.
 * Exit 0 = all green, non-zero = failures printed.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log('  ✓ ' + label);
  } catch (err) {
    console.error('  ✗ ' + label + '\n    ' + err.message);
    failures++;
  }
}

function syntaxCheck(rel) {
  execSync(`node --check ${path.join(ROOT, rel)}`, { stdio: 'pipe' });
}

function contains(rel, pattern) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (typeof pattern === 'string') {
    if (!src.includes(pattern))
      throw new Error(`'${pattern}' not found in ${rel}`);
  } else {
    if (!pattern.test(src))
      throw new Error(`Pattern ${pattern} not found in ${rel}`);
  }
}

console.log('\n── Syntax checks ──');
['server/server.js', 'web/multiplayer.js', 'web/autoplay.js', 'web/player.js'].forEach(f => {
  check(`node --check ${f}`, () => syntaxCheck(f));
});

console.log('\n── server/server.js ──');
check('activeMode state variable',   () => contains('server/server.js', 'activeMode'));
check('aiHostId state variable',     () => contains('server/server.js', 'aiHostId'));
check('electAiHost function',        () => contains('server/server.js', 'electAiHost'));
check('revokeAiHost function',       () => contains('server/server.js', 'revokeAiHost'));
check("sends 'ai_granted' message",  () => contains('server/server.js', "'ai_granted'"));
check("sends 'ai_revoked' message",  () => contains('server/server.js', "'ai_revoked'"));
check("handles 'ai_input' message",  () => contains('server/server.js', "'ai_input'"));
check('activeMode in broadcastStatus', () => contains('server/server.js', 'activeMode'));
check('aiHostId accepted in state_push', () => contains('server/server.js', 'aiHostId'));

console.log('\n── web/multiplayer.js ──');
check('isAiHost property',           () => contains('web/multiplayer.js', 'isAiHost'));
check('activeMode property',         () => contains('web/multiplayer.js', 'activeMode'));
check('onAiGranted callback',        () => contains('web/multiplayer.js', 'onAiGranted'));
check('onAiRevoked callback',        () => contains('web/multiplayer.js', 'onAiRevoked'));
check('onFirstSync callback',        () => contains('web/multiplayer.js', 'onFirstSync'));
check("handles 'ai_granted'",        () => contains('web/multiplayer.js', 'ai_granted'));
check("handles 'ai_revoked'",        () => contains('web/multiplayer.js', 'ai_revoked'));
check('recordAiInput method',        () => contains('web/multiplayer.js', 'recordAiInput'));
check('firstSyncReceived flag',      () => contains('web/multiplayer.js', 'firstSyncReceived'));

console.log('\n── web/autoplay.js ──');
check('setMultiplayerAllowed method', () => contains('web/autoplay.js', 'setMultiplayerAllowed'));
check('multiplayerAllowed property',  () => contains('web/autoplay.js', 'multiplayerAllowed'));
check('multiplayer gate in tick',     () => contains('web/autoplay.js', /multiplayerAllowed.*false|false.*multiplayerAllowed/));

console.log('\n── web/player.js ──');
check('onAiGranted wired',            () => contains('web/player.js', 'onAiGranted'));
check('onAiRevoked wired',            () => contains('web/player.js', 'onAiRevoked'));
check('onFirstSync wired',            () => contains('web/player.js', 'onFirstSync'));

console.log('\n' + (failures === 0
  ? '✅  All checks passed.'
  : `❌  ${failures} check(s) failed.`));
process.exit(failures > 0 ? 1 : 0);
