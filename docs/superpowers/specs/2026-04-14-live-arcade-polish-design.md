# Live Arcade Polish Design

## Goal

Polish the shared Pokemon Red cabinet so visitors immediately attach to the live run, understand whether they can play, can control sound explicitly, see chat beside gameplay on desktop, and watch AI keep the cabinet moving only when no human owns control.

## Locked Decisions

### 1. Live layout

- The join/nickname controls move to the top of the live gameplay area instead of sitting below chat.
- Desktop uses a two-column live layout:
  - left column: join/status/audio strip, screen, player controls, autoplay details
  - right column: chat sidebar
- Mobile stays single-column with chat stacked below gameplay.
- The multiplayer status bar stays visible and becomes part of the top live strip instead of a detached row in the middle of the page.

### 2. Playability visibility

The UI must always expose one of these cabinet states:

- **Playable now** — the current visitor owns the turn
- **Queued** — the visitor joined and is waiting
- **Spectating** — another human owns the cabinet
- **AI is playing** — the cabinet is being driven automatically because no human owns it
- **Syncing live cabinet** — the visitor is waiting for the shared state snapshot before local controls are trusted

These states must be visible without opening a panel or reading tiny helper text.

### 3. Audio UX

- Audio defaults to **muted** for every fresh page load.
- The page gets an explicit sound toggle instead of relying only on the temporary unlock overlay.
- Clicking the sound toggle both unlocks audio (when required by the browser) and switches between muted/unmuted.
- The UI shows the current audio state continuously with plain text/icon feedback.

### 4. Shared-state-first boot

- The live shared state stored by the Railway + Redis system becomes the source of truth for multiplayer boot.
- A visitor should not visually start from a fresh local run and then “snap” into the shared run without explanation.
- On page load, the client should enter a short **syncing** state while waiting for the initial `game_state` snapshot from the server.
- Local IndexedDB SRAM/state remains available for manual save/export flows, but live multiplayer boot prefers the shared cabinet snapshot over the visitor’s local session.
- If Redis has no shared state yet, the page may fall back to the existing local/runtime bootstrap and then seed the shared run from the first active controller.

### 5. AI ownership model

The repo already contains partial overworld automation plus battle automation. The missing piece is not “battle-only AI” but **ownership**.

We will use **client-hosted AI with server arbitration**:

- The Railway server tracks whether the active controller is a human or AI.
- When no human owns the cabinet and at least one connected spectator is eligible, the server grants AI control to one client.
- That client runs the existing autoplay engine locally and pushes state to the server just like a human turn holder.
- When a human joins or gains control, the server revokes AI control before granting the human turn.
- AI never drives the cabinet while a human turn is active.

This keeps the current browser-hosted emulator architecture and avoids building a headless emulator on Railway.

### 6. Autoplay scope

- Keep the existing battle automation.
- Treat the current overworld logic as the starting point for “full autopilot”:
  - title/intro recovery
  - dialogue progression
  - random exploration
  - stuck recovery
  - Pokemon Center navigation
- Improve integration and reliability first so autoplay can safely own the cabinet.
- Do **not** turn this pass into a large quest-aware RPG bot rewrite. The goal is a live cabinet that keeps moving, not perfect game completion logic.

### 7. CSS cleanup

- Remove the special-case `!important` overrides on the join button and fold it into the shared button system.
- Normalize button heights, spacing, and alignment across:
  - join button
  - player bar buttons
  - sound toggle
  - chat send button
- Preserve the current blog-inspired visual language instead of adding a separate multiplayer visual style.

## Component Changes

### `web/player.html`

- Add a live cabinet wrapper that groups the top strip, gameplay stack, and right-side chat.
- Move the join section above the screen.
- Add a sound toggle control and status label in the live control strip.
- Keep autoplay details under the gameplay controls, not mixed with chat.

### `web/player.css`

- Add a responsive grid layout for desktop live view.
- Style the top control strip so join/status/audio feel like a unified header.
- Restyle chat as a true right sidebar on desktop.
- Replace the one-off multiplayer button overrides with reusable button variants.

### `web/player.js`

- Introduce explicit audio mute/unmute state and button wiring.
- Surface live cabinet state in the UI: syncing, spectating, queued, playable, AI-active.
- Prefer shared-state boot over local session visuals when multiplayer is available.
- Keep keyboard and touch input gated by human turn ownership.

### `web/multiplayer.js`

- Extend the client status model so the UI can distinguish human control from AI control.
- Expose initial sync state so the page knows when it is safe to describe the cabinet as live.
- Handle new server messages for AI grant/revoke if needed.

### `web/autoplay.js`

- Keep the current exploration + battle engine.
- Add multiplayer/AI ownership gates so autoplay only runs when this client is the current AI host or active human controller.
- Ensure autoplay yields immediately when ownership is revoked.

### `server/server.js`

- Track whether the active controller is human or AI.
- Elect an AI host only when no human owns the cabinet.
- Revoke AI before granting a human turn.
- Continue persisting the canonical shared `game_state`/`game:sram` snapshot for handoff.

## Error Handling

- If the shared snapshot is unavailable at boot, keep the UI in a syncing state briefly, then fall back cleanly instead of leaving the user in an ambiguous loading state.
- If AI host election fails or the AI host disconnects, the server should either elect another spectator or show the cabinet as idle/spectating — never both AI and human at once.
- If audio cannot be unlocked, keep the sound toggle visible and show a muted/locked state instead of silently failing.

## Verification Targets

- On first load, visitors see the live cabinet layout immediately, with chat on the right on desktop.
- Join controls are above the game.
- Sound starts muted and can be toggled on/off.
- The page clearly shows whether the visitor is spectating, queued, playing, or watching AI.
- AI only drives the cabinet when no human is in control.
- New visitors attach to the existing shared game instead of appearing to start a fresh local session.
