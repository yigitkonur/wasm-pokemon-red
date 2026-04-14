# Live Arcade Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the shared Pokemon Red cabinet so join/sound/playability are obvious, chat sits beside gameplay on desktop, AI can drive the cabinet only when no human owns it, and every visitor boots into the shared live run instead of a misleading fresh local view.

**Architecture:** Keep the current browser-hosted emulator plus Railway WebSocket relay. Move layout responsibilities into a new live cabinet shell in `web/player.html` + `web/player.css`, add explicit state and audio UI wiring in `web/player.js`, and extend `web/multiplayer.js` plus `server/server.js` to arbitrate AI ownership and expose shared-state sync status. Reuse the existing autoplay engine instead of rewriting it into a quest-aware bot.

**Tech Stack:** Static HTML/CSS, vanilla browser JavaScript, binjgb WASM runtime, Railway Node.js WebSocket server, Redis-backed shared state.

---

## File Structure

- Modify: `web/player.html`
  - Introduce a live cabinet wrapper with top controls, gameplay column, and chat sidebar.
- Modify: `web/player.css`
  - Add responsive grid layout, unified button variants, top-strip layout, and desktop sidebar styles.
- Modify: `web/player.js`
  - Wire sound toggle, syncing/playability states, and shared-state-first boot behavior.
- Modify: `web/multiplayer.js`
  - Add AI/sync-aware status handling and any protocol changes needed for UI.
- Modify: `web/autoplay.js`
  - Gate autoplay by ownership so it only runs when allowed.
- Modify: `server/server.js`
  - Add AI ownership arbitration and expose active human/AI state in status messages.

### Task 1: Reshape the live layout shell

**Files:**
- Modify: `web/player.html`
- Modify: `web/player.css`

- [ ] **Step 1: Add the live cabinet wrapper and move join controls above the screen**

```html
<section class="live-cabinet">
  <div class="live-cabinet__main">
    <section class="live-topbar" id="live-topbar">
      <div class="live-topbar__join">
        <input type="text" id="mp-nickname" class="mp-nick-input" maxlength="16">
        <button type="button" id="mp-join-btn" class="action-btn action-btn--primary">Join Game</button>
      </div>
      <section class="mp-bar" id="mp-bar">
        <span class="mp-active-label" id="mp-active-label">Syncing live cabinet</span>
      </section>
      <div class="live-topbar__controls">
        <button type="button" id="sound-toggle-btn" class="action-btn action-btn--ghost">
          <span id="sound-toggle-label">Sound off</span>
        </button>
      </div>
    </section>

    <section class="player-section">
      <div class="screen-frame" id="screen-frame" tabindex="0">
        <canvas id="screen" width="160" height="144" aria-label="Pokemon RGB display"></canvas>
        <p id="overlay-message" class="overlay-message" aria-live="polite">Syncing live cabinet…</p>
      </div>
    </section>

    <section class="player-bar-section">
      <div class="player-bar">...</div>
    </section>

    <section id="autoplay-panel" class="autoplay-panel" hidden>
      <div class="autoplay-header">
        <p class="caps-label">AutoPlay</p>
        <span id="autoplay-state" class="pill autoplay-pill">Idle</span>
      </div>
    </section>
  </div>

  <aside class="live-cabinet__chat">
    <section class="chat-panel" id="chat-panel">
      ...
    </section>
  </aside>
</section>
```

- [ ] **Step 2: Add a responsive desktop grid and keep mobile stacked**

```css
.live-cabinet {
  display: grid;
  gap: 1rem;
}

@media (min-width: 1024px) {
  .live-cabinet {
    grid-template-columns: minmax(0, 1.35fr) minmax(20rem, 0.65fr);
    align-items: start;
  }
}
```

- [ ] **Step 3: Replace one-off multiplayer button styles with shared button variants**

```css
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.5rem;
  padding: 0 0.875rem;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-primary);
}

.action-btn--primary {
  background: #f59e0b;
  color: #111;
}
```

- [ ] **Step 4: Run a syntax-free structural smoke check**

Run:

```bash
cd /Users/yigitkonur/wasm-pokemon-red && rg -n "live-cabinet|live-topbar|action-btn" web/player.html web/player.css
```

Expected: matches in both files for the new layout shell and button classes.

### Task 2: Add explicit sound and playability UI wiring

**Files:**
- Modify: `web/player.html`
- Modify: `web/player.js`
- Modify: `web/player.css`

- [ ] **Step 1: Add a sound toggle button and a cabinet-state badge in the top bar**

```html
<div class="live-topbar__controls">
  <button type="button" id="sound-toggle-btn" class="action-btn action-btn--ghost">
    <span id="sound-toggle-label">Sound off</span>
  </button>
  <span id="cabinet-state-pill" class="pill">Syncing live cabinet</span>
</div>
```

- [ ] **Step 2: Add explicit audio state to `AudioManager` and expose it to the UI**

```js
this.muted = true;

toggleMuted() {
  this.muted = !this.muted;
  if (this.context && this.started) {
    this.context[this.muted ? "suspend" : "resume"]();
  }
  return !this.muted;
}
```

- [ ] **Step 3: Update player UI state mapping**

```js
function describeCabinetState(status) {
  if (status.syncing) return { label: "Syncing live cabinet", tone: "syncing" };
  if (status.isMyTurn) return { label: "Playable now", tone: "playing" };
  if (status.joined) return { label: "Queued", tone: "queued" };
  if (status.activeMode === "ai") return { label: "AI is playing", tone: "ai" };
  return { label: "Spectating", tone: "watching" };
}
```

- [ ] **Step 4: Verify the browser code still parses**

Run:

```bash
cd /Users/yigitkonur/wasm-pokemon-red && node --check web/player.js
```

Expected: no output and exit code 0.

### Task 3: Prefer shared-state boot over misleading local start

**Files:**
- Modify: `web/player.js`
- Modify: `web/multiplayer.js`

- [ ] **Step 1: Add a syncing flag to multiplayer status**

```js
this.status = {
  activeId: null,
  activeName: null,
  activeMode: "idle",
  queueLen: 0,
  viewers: 0,
  turnTTL: 0,
  syncing: true,
};
```

- [ ] **Step 2: Clear syncing only after the first live snapshot or a bounded fallback**

```js
this._initialSyncTimer = setTimeout(() => {
  this.status.syncing = false;
  this._emitStatus();
}, 1500);
```

- [ ] **Step 3: Keep local runtime boot, but gate the UI until shared state has a chance to arrive**

```js
if (status.syncing) {
  elements.screenFrame.classList.add("is-syncing");
  elements.overlayMessage.textContent = "Syncing live cabinet…";
  elements.overlayMessage.hidden = false;
} else {
  elements.screenFrame.classList.remove("is-syncing");
}
```

- [ ] **Step 4: Verify multiplayer client parses**

Run:

```bash
cd /Users/yigitkonur/wasm-pokemon-red && node --check web/multiplayer.js
```

Expected: no output and exit code 0.

### Task 4: Add AI ownership arbitration

**Files:**
- Modify: `server/server.js`
- Modify: `web/multiplayer.js`
- Modify: `web/autoplay.js`
- Modify: `web/player.js`

- [ ] **Step 1: Extend server status with active mode and AI host selection**

```js
let activeMode = null; // "human" | "ai" | null
let aiHostId = null;
```

```js
broadcastAll("status", {
  activeId,
  activeName,
  activeMode,
  queueLen: queue.length,
  viewers: clients.size,
  turnTTL: ttlSec,
});
```

- [ ] **Step 2: Grant AI control only when no human owns the cabinet**

```js
if (!activePlayerId && queue.length === 0) {
  const aiHost = pickEligibleSpectator();
  if (aiHost) {
    activePlayerId = aiHost.id;
    activeMode = "ai";
    send(aiHost.ws, "ai_granted", {});
  }
}
```

- [ ] **Step 3: Revoke AI as soon as a human turn is granted**

```js
function revokeAi(reason) {
  if (!aiHostId) return;
  send(findClientById(aiHostId), "ai_revoked", { reason });
  aiHostId = null;
  activeMode = null;
}
```

- [ ] **Step 4: Gate autoplay by granted ownership**

```js
tick() {
  if (!this.active) return;
  if (this.ownerMode === "ai" && !this.canControl()) {
    this.releaseAll();
    return;
  }
  this._processHeldButtons();
  const state = this.detectState();
  if (state === "battling") return this.handleBattle();
  if (state === "text") return this.handleTextbox();
  if (state === "exploring") return this.handleOverworld();
  if (state === "title") return this.handleTitle();
}
```

- [ ] **Step 5: Verify server and autoplay code parse**

Run:

```bash
cd /Users/yigitkonur/wasm-pokemon-red && node --check server/server.js && node --check web/autoplay.js
```

Expected: no output and exit code 0.

### Task 5: Validate the live cabinet end to end

**Files:**
- Modify: none unless fixes are needed during verification

- [ ] **Step 1: Run local/static syntax checks**

```bash
cd /Users/yigitkonur/wasm-pokemon-red && node --check web/player.js && node --check web/multiplayer.js && node --check web/autoplay.js && node --check server/server.js
```

- [ ] **Step 2: Push the web changes and let CI deploy**

```bash
cd /Users/yigitkonur/wasm-pokemon-red && git add web/player.html web/player.css web/player.js web/multiplayer.js web/autoplay.js server/server.js docs/superpowers/specs/2026-04-14-live-arcade-polish-design.md docs/superpowers/plans/2026-04-14-live-arcade-polish.md && git commit -m "feat: polish live arcade layout, sound, and AI ownership"
```

- [ ] **Step 3: Verify the deployed site with agent-browser**

Check:

```text
1. Join controls render above the game.
2. Desktop shows chat on the right.
3. Sound button starts off and can toggle on.
4. A spectator sees syncing/spectating/AI states clearly.
5. A human turn revokes AI control cleanly.
6. A fresh visitor attaches to the current shared game instead of appearing to boot a new one.
```

- [ ] **Step 4: Redeploy the Railway server if server.js changed**

```bash
cd /Users/yigitkonur/wasm-pokemon-red/server && railway up --detach
```

## Self-Review

- Spec coverage: layout, sound, playability indicators, AI ownership, and shared-state-first boot are all mapped to tasks above.
- Placeholder scan: no unfinished markers remain.
- Type consistency: `activeMode`, `syncing`, `ai_granted`, and `ai_revoked` are used consistently across server/client tasks.
