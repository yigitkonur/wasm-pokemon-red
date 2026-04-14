# wasm-pokemon-red

> Pokémon Red compiled from Game Boy assembly, running in your browser as WebAssembly — with a shared live arcade so your visitors can take turns playing together.

**[▶ Play the live arcade now →](https://yigitkonur.github.io/wasm-pokemon-red/)**

This project does two things:

1. **WASM player** — takes the actual disassembled Game Boy source code, compiles the ROM from scratch, wraps a C emulator in WebAssembly, and serves the whole thing as a static site on GitHub Pages. No downloads, no extensions, no server needed to play.

2. **Shared live arcade** — adds a WebSocket relay server and Redis-backed state sync so every visitor to your site is watching (or playing) the same game, Twitch-style. Turn-based control passes between players. An AI bot fills in whenever nobody is actively playing.

Read on for the full technical walkthrough, the architecture diagram, and a self-hosting guide.

---

## Step 1: Get the ROM source

The first thing you need is the game itself. But we're not downloading a pre-built ROM from some sketchy corner of the internet — we're building it from source.

This repo contains the full `pokemon-rgb` source tree: the actual disassembled Game Boy Color assembly that the community has painstakingly reverse-engineered. Every route, every Pokémon cry, every text box — it's all here in `.asm` files. The compilation pipeline is `rgbds`, the standard Game Boy assembler toolchain:

```
rgbasm  →  rgblink  →  rgbfix  →  pokered.gbc
```

`make pokered.gbc` runs that pipeline and spits out a real, honest-to-god Game Boy ROM. You could flash it to a cart and play it on original hardware. This is important because it means the browser version plays the exact same game as the native build — we never transpile or recompile gameplay logic into JavaScript.

There's a nice side effect here: since the ROM is deterministic, we can SHA-hash it and use that hash to namespace save data. More on that later.

---

## Step 2: Pick an emulator

Okay, so we have a ROM. Now we need something that can run it in a browser. We need a Game Boy emulator that:

1. Is written in C (so Emscripten can compile it)
2. Is small and well-structured (so we're not dragging in a massive dependency)
3. Actually works

[binjgb](https://github.com/nicknassar/binjgb) checks all three boxes. It's a clean, minimal Game Boy emulator written in C by Ben Smith. It's designed to be embeddable, and — critically — it compiles with Emscripten without requiring a complete rewrite of its I/O layer.

We vendor it as a git submodule at `third_party/binjgb`. But here's the first gotcha: we can't just compile it in place.

---

## Step 3: Stage and patch the emulator

This is where things get interesting. The vendored `third_party/binjgb` is a pinned submodule. If we start editing files inside it, we lose the ability to cleanly track upstream changes. Every `git status` becomes a mess, every submodule update becomes a merge conflict. So we don't touch it.

Instead, the build creates a **staged copy** at `web/.build/binjgb` — an archive of the submodule — and applies our patches there. Think of it as "fork at build time, not at clone time."

We overlay two files from `web/binjgb/`:

- **`exported.json`** — the list of C functions we want Emscripten to expose to JavaScript. This includes the emulator lifecycle functions (`_emulator_new_simple`, `_emulator_run_until_f64`, `_emulator_delete`), memory allocation (`_malloc`, `_free`), framebuffer and audio accessors, and the save-state hooks we need for persistence.

- **`wrapper.c`** — a C wrapper that provides the browser-facing API surface. This is where save-state read/write hooks get injected. It keeps the original MIT license from binjgb and adds our glue code on top.

We also patch the staged copy directly for two gotchas that took me a minute to figure out:

1. **CMake minimum version**: binjgb's `CMakeLists.txt` declares `cmake_minimum_required(VERSION 2.8)`. Modern CMake yells about this and can change behavior. We bump it to `3.5`.

2. **`HEAP8` / `HEAPU8` exports**: the JavaScript host needs to create typed-array views over WebAssembly linear memory to shuttle ROM bytes and save data around. Emscripten doesn't export these by default anymore — you have to explicitly ask for them in the build flags. If you forget this, everything compiles fine but the JS host silently gets `undefined` when it tries to access wasm memory. Fun times.

The beauty of this approach is that `third_party/binjgb` stays pristine. You can `git submodule update` anytime and our patches just re-apply during the next `make web`.

---

## Step 4: Compile to WebAssembly

Now we point Emscripten at the staged, patched emulator and let it do its thing. The output is two files:

- `binjgb.js` — the Emscripten runtime glue
- `binjgb.wasm` — the compiled emulator

The `exported.json` overlay controls what's visible to JavaScript. Here's a taste of what gets exported:

```json
[
  "_emulator_new_simple",
  "_emulator_run_until_f64",
  "_emulator_delete",
  "_emulator_read_state",
  "_emulator_write_state",
  "_emulator_read_ext_ram",
  "_emulator_write_ext_ram",
  "_get_frame_buffer_ptr",
  "_get_audio_buffer_ptr",
  "_malloc",
  "_free"
]
```

Each of those becomes a callable function on the Emscripten module object in JavaScript. The exported surface includes ROM boot, the frame loop, audio/video buffer accessors, SRAM read/write, save-state serialization, and the memory management functions that let JS allocate into the wasm heap.

If any export goes missing (say, after an upstream binjgb update changes a function signature), `player.js` will fail loudly at bootstrap rather than silently breaking mid-game. That's intentional — fail fast beats corrupt save data every time.

---

## Step 5: Build the browser shell

The emulator is compiled, but wasm doesn't know how to render to a `<canvas>`, handle keyboard input, or persist save data. That's the job of the browser shell: `player.html`, `player.js`, and `player.css`.

**`player.js`** is the real workhorse — about 900 lines of orchestration code. Here's the boot sequence:

1. Fetch `assets/version.json` (build metadata)
2. Derive a storage namespace from the ROM's SHA hash
3. Open an IndexedDB database
4. Fetch `assets/pokered.gbc`
5. Instantiate the Emscripten module via `window.Binjgb()`
6. Check IndexedDB for existing SRAM and save-state data
7. Allocate ROM bytes into wasm linear memory
8. Create the emulator instance
9. Kick off the frame loop and enable input

The persistence model deserves a callout. SRAM (your in-game save file) and one manual save-state slot are both stored in IndexedDB, namespaced by the ROM's SHA hash. This means if you rebuild the ROM with code changes, your old saves won't silently load into an incompatible binary — they're keyed to the exact build that created them. It's a small thing, but it prevents the kind of "my save is corrupted and I don't know why" bug that's miserable to debug.

Input handling covers three paths: keyboard mapping (arrow keys + Z/X/Enter/Backspace for the Game Boy buttons), on-screen touch controls for mobile, and the Gamepad API for controllers. The canvas uses WebGL when available, and audio unlocks on the first user gesture (thanks, autoplay policies).

**`player.html`** is the static document shell — just a canvas, some control buttons, and the script/style includes. It gets copied to both `index.html` (the GitHub Pages root) and `player.html` (a stable deep-link for iframes or embeds).

**`player.css`** handles responsive layout, canvas framing, and the touch control surface. Nothing exotic — just CSS doing CSS things.

---

## Step 6: Bundle and deploy

The `Makefile` assembles everything into `dist/web/`:

```
dist/web/
  index.html
  player.html
  player.css
  player.js
  NOTICE.binjgb.txt
  assets/
    pokered.gbc
    binjgb.js
    binjgb.wasm
    version.json
```

That's the entire site. No bundler, no webpack, no node_modules. Just files.

Deployment is handled by GitHub Actions (`.github/workflows/main.yml`). On every push to `main`:

1. Check out the repo with submodules
2. Build and install `rgbds` from source
3. Install and activate Emscripten SDK (`emsdk 5.0.5`)
4. Run `make web`
5. Upload `dist/web/` as a GitHub Pages artifact
6. Deploy via `actions/deploy-pages@v5`

The HTML shell uses only relative URLs, so it works both at the repository root (`/`) and under a GitHub Pages project-site prefix like `/wasm-pokemon-red/`. The result is a fully static, CDN-friendly site with zero server-side requirements.

---

## Architecture

The full system has two layers. The browser layer works standalone. The arcade layer adds shared state and turn arbitration.

```
┌──────────────────────────────────────────────────────────────────┐
│  BUILD PIPELINE (GitHub Actions, runs once per push)             │
│                                                                  │
│  pokemon-red .asm files                                          │
│       │  rgbasm + rgblink + rgbfix                               │
│       ▼                                                          │
│  pokered.gbc  ──► copied to dist/web/assets/                     │
│                                                                  │
│  third_party/binjgb (C emulator, git submodule)                  │
│       │  stage to web/.build/binjgb                              │
│       │  overlay: web/binjgb/exported.json + wrapper.c           │
│       │  emcc (Emscripten)                                        │
│       ▼                                                          │
│  binjgb.js + binjgb.wasm  ──► copied to dist/web/assets/        │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  BROWSER LAYER (static, zero backend required)                   │
│                                                                  │
│  player.html  ──loads──►  player.js  ──loads──►  binjgb.wasm    │
│                              │                                   │
│                    ┌─────────┴─────────────────┐                 │
│                    │         │                 │                 │
│              <canvas>   IndexedDB         AudioContext           │
│              (WebGL)    SRAM + save-state  (unlocks on click)    │
│                    │                                             │
│              autoplay.js   ── AI bot (overworld + battles)       │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  ARCADE LAYER (optional, adds shared play)                       │
│                                                                  │
│  Browser A                  Railway WebSocket server             │
│  (human player)             server/server.js                     │
│       │  WebSocket (wss://) │                                    │
│       ◄────────────────────►│◄────► Upstash Redis (REST)        │
│                             │       game_state snapshot          │
│  Browser B                  │       chat history                 │
│  (spectator / queue)        │                                    │
│       │  WebSocket (wss://) │                                    │
│       ◄────────────────────►│                                    │
│                             │                                    │
│  Browser C                  │                                    │
│  (AI host — client-side)    │  server elects AI host when        │
│  autoplay.js runs when      │  no human owns the cabinet         │
│  server grants ai_granted   │                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Key repos and tools referenced

| Dependency | What it does | Where |
|---|---|---|
| [pret/pokered](https://github.com/pret/pokered) | Disassembled Pokémon Red/Blue source | `./` (this repo forks it) |
| [gbdev/rgbds](https://github.com/gbdev/rgbds) | Game Boy assembler — `rgbasm`, `rgblink`, `rgbfix` | installed in CI |
| [nicknassar/binjgb](https://github.com/nicknassar/binjgb) | Minimal C Game Boy emulator, Emscripten-friendly | `third_party/binjgb` |
| [emscripten-core/emsdk](https://github.com/emscripten-core/emsdk) | C→WebAssembly compiler toolchain | installed in CI |
| [bouletmarc/PokeBot](https://github.com/bouletmarc/PokeBot) | AI strategy reference for overworld + battle automation | inspiration for `web/autoplay.js` |
| [websockets/ws](https://github.com/websockets/ws) | Node.js WebSocket server library | `server/package.json` |
| [Upstash Redis](https://upstash.io/) | Serverless Redis (REST API) for game-state persistence | cloud dependency |
| [Railway](https://railway.app/) | Node.js WebSocket server hosting | cloud dependency |

---

## File map

Where everything lives and what to read first.

```
wasm-pokemon-red/
│
│  ── ROM build ────────────────────────────────────────────────
├── main.asm / audio.asm / home.asm / maps.asm / text.asm / ram.asm
│     Game Boy assembly source. Entry point is main.asm.
├── Makefile              ROM + web bundle build rules. Start here.
├── layout.link           RGBLINK script — how ROM sections are laid out.
├── roms.sha1             Expected SHA-1 hashes for deterministic builds.
│
│  ── Emscripten overlay ───────────────────────────────────────
├── third_party/binjgb/   Pinned submodule. Do not edit directly.
├── web/binjgb/
│   ├── exported.json     List of C functions Emscripten must expose to JS.
│   └── wrapper.c         C glue: save-state hooks injected into binjgb.
│
│  ── Browser shell ────────────────────────────────────────────
├── web/
│   ├── player.html       Static HTML shell. Start reading here for the UI.
│   ├── player.css        All styling: layout, canvas frame, touch controls.
│   ├── player.js         ~1400 lines. Emulator lifecycle, input, audio,
│   │                     IndexedDB persistence, speed control, state UI.
│   ├── multiplayer.js    WebSocket client. Handles join, turn, chat,
│   │                     game-state sync, AI protocol messages.
│   └── autoplay.js       AI bot. Reads RAM directly; navigates overworld,
│                         manages battles, recovers from stuck states.
│
│  ── Arcade server ────────────────────────────────────────────
├── server/
│   ├── server.js         Node.js WebSocket + Express server.
│   │                     Turn queue, AI election, Redis sync, chat relay.
│   └── package.json      Dependencies: ws, express, cors.
│
│  ── CI + deploy ──────────────────────────────────────────────
├── .github/workflows/main.yml
│                         Two jobs: `build` (ROM) and `web` (WASM bundle +
│                         GitHub Pages deploy). Read this to understand CI.
│
│  ── Dist (generated, do not edit) ────────────────────────────
└── dist/web/             Output of `make web`. Deployed to GitHub Pages.
    ├── index.html / player.html
    ├── player.css / player.js / autoplay.js / multiplayer.js
    └── assets/
        ├── pokered.gbc   The compiled ROM.
        ├── binjgb.js     Emscripten runtime glue.
        ├── binjgb.wasm   Compiled emulator binary.
        └── version.json  Build metadata (commit SHA, binjgb version).
```

### How to read `player.html`

`player.html` is the document shell. The DOM structure is:

```
<body>
  <header>                    ← site nav (links back to blog)
  <main>
    <section>                 ← page title + status pills
    <section.live-topbar>     ← join controls, multiplayer status, sound toggle
    <div.live-cabinet>        ← two-column desktop layout
      <div.live-cabinet__game>
        <section.player-section>   ← <canvas id="screen">
        <section.player-bar-section>  ← toolbar: pause/reset, speed, AI, fullscreen
        <details.secondary-controls>  ← save/load state, import/export save
        <section.controls-section>    ← touch D-pad + A/B/Start/Select
        <section#autoplay-panel>      ← AI bot status panel (hidden by default)
      </div>
      <aside.live-cabinet__chat>
        <section.chat-panel>   ← live chat messages + input
      </aside>
    </div>
    <section.keyboard-guide>  ← keyboard mapping reference
  </main>
  <footer>
</body>
```

`player.js` queries elements by `id` or `data-action`. The `handleAction(action, value)` function is the central dispatcher — search for it first when tracing any button behaviour.

---

## Playing it

**[▶ Play the live arcade →](https://yigitkonur.github.io/wasm-pokemon-red/)**

One game, shared between all visitors. Join to take a turn; spectate while others play. An AI bot keeps the game moving when nobody is in the queue.

### Controls

| Action | Keyboard | Touch | Gamepad |
|--------|----------|-------|---------|
| D-pad | Arrow keys | On-screen D-pad | D-pad / Left stick |
| A | Space / Enter | A button | A button |
| B | Shift / Z | B button | B button |
| Start | Esc | Start | Start |
| Select | Tab | Select | Select |
| Speed 1×/2×/4×/⚡ | 1 / 2 / 3 / 4 | Speed buttons | — |

Click the game screen to focus it. Clicking anywhere outside releases all held keys.

Sound is **muted by default** — click **Sound On** in the top bar to unmute.

### Multiplayer turn system

1. Open the page. You start as a spectator. The game state syncs from Redis — you see exactly what everyone else sees.
2. Enter a nickname and click **Join Game**. You enter the queue.
3. When your turn starts, the cabinet becomes **Playable**. Use keyboard or touch controls.
4. If you stop pressing keys for 5 seconds, your turn passes to the next person in the queue.
5. When no humans are queued, an AI bot automatically takes control and keeps exploring.

---

Your game saves automatically to IndexedDB — close the tab, come back later, and your progress is still there. There's also a manual save-state slot you can use for quick saves. Save data is scoped to the specific ROM build, so different builds won't clobber each other's saves.

---

## Embed the player on your own site

The player is fully standalone. You can drop a single self-contained `player.html` onto any static host — no build step required. All you need is the compiled `dist/web/` folder.

### Option A — iframe embed (simplest)

If you just want the game inside an existing page:

```html
<iframe
  src="https://yigitkonur.github.io/wasm-pokemon-red/player.html"
  width="560"
  height="600"
  allow="autoplay; gamepad"
  style="border:none; display:block;"
  title="Pokémon Red">
</iframe>
```

Adjust width/height to taste. The player is responsive — it will scale the canvas to fit.

### Option B — self-host the static files

1. Download the latest `pokemon-rgb-web` artifact from [GitHub Actions](https://github.com/yigitkonur/wasm-pokemon-red/actions) (built on every push), or build it yourself with `make web`.
2. Copy the contents of `dist/web/` to any static host (GitHub Pages, Netlify, Vercel, S3, nginx, or just `python3 -m http.server`).
3. Open `index.html` (or `player.html`) in a browser.

That's it — no Node.js, no database, no API keys needed for solo play.

> **Note:** The shared arcade features (live turn queue, chat, AI bot, Redis state sync) require the WebSocket server described in the next section. Solo play works without it.

### Option C — add the shared arcade to your own site

See [Run your own shared arcade](#run-your-own-shared-arcade) below. After deploying the server, point `web/multiplayer.js` line 13 at your own WebSocket URL:

```js
const WS_URL = "wss://your-server.railway.app/ws";
```

Then rebuild (`make web`) and deploy the static files.

---

## Run your own shared arcade

The shared arcade requires two hosted services:

| Service | Purpose | Free tier |
|---|---|---|
| Railway (or any Node.js host) | WebSocket server — turn queue, AI arbitration, chat relay | ✅ Yes (Hobby plan) |
| Upstash Redis | Serverless Redis — game-state snapshot persistence | ✅ Yes (10K commands/day) |

### Step 1: Set up Upstash Redis

1. Go to [upstash.com](https://upstash.com/) → Create a free database.
2. From the database dashboard, copy:
   - **REST URL** (looks like `https://YOUR-DB.upstash.io`)
   - **REST Token**

### Step 2: Deploy the WebSocket server on Railway

1. Fork this repo.
2. Go to [railway.app](https://railway.app/) → New Project → Deploy from GitHub repo.
3. Select your fork. Railway will auto-detect the `server/` directory.
4. Set these environment variables in the Railway dashboard:

   ```
   UPSTASH_REDIS_REST_URL=https://YOUR-DB.upstash.io
   UPSTASH_REDIS_REST_TOKEN=your_token_here
   PORT=3000
   ```

5. Railway assigns a public URL like `https://your-app.up.railway.app`.
6. Verify the server is healthy:

   ```bash
   curl https://your-app.up.railway.app/health
   # → {"ok":true,"clients":0,"queue":0,"active":null,"mode":"idle","aiHost":null}
   ```

### Step 3: Update the client WebSocket URL

In `web/multiplayer.js`, line 13:

```js
const WS_URL = "wss://your-app.up.railway.app/ws";
```

Rebuild and deploy the static files (`make web`, then push to GitHub Pages or your static host).

### Step 4: Configure GitHub Pages (if using GitHub)

Settings → Pages → Source: **GitHub Actions**. The CI workflow handles the rest automatically.

### Server protocol reference

The WebSocket server speaks JSON. Key message types:

| Message | Direction | Payload |
|---|---|---|
| `join` | client → server | `{ nickname }` |
| `leave` | client → server | — |
| `input` | client → server | `{ input, pressed }` |
| `chat` | client → server | `{ text }` |
| `push_state` | client → server | `{ state: <base64> }` |
| `status` | server → client | `{ activeId, activeName, queueLen, viewers, turnTTL, activeMode }` |
| `turn_start` | server → client | `{ playerId }` |
| `turn_end` | server → client | `{ playerId }` |
| `game_state` | server → client | `{ state: <base64> }` |
| `chat_message` | server → client | `{ nickname, text, ts }` |
| `ai_granted` | server → client | — |
| `ai_revoked` | server → client | — |

The `game_state` snapshot is the full emulator save-state serialized to base64 and stored in Redis under the key `pokemon:state`. Every client that joins receives this snapshot immediately so they are always watching the live cabinet, not a local cold boot.

---

## Local development

Want to build this yourself? Here's the full setup.

### Prerequisites

- `git`
- `make`
- `rgbds` (the Game Boy assembler toolchain — [install guide](https://rgbds.gbdev.io/install/))
- Emscripten SDK (`emsdk 5.0.5` or compatible)

### Build steps

```bash
# Clone with submodules
git clone --recursive https://github.com/yigitkonur/wasm-pokemon-red.git
cd wasm-pokemon-red

# Set up Emscripten (if you don't already have it)
git clone https://github.com/emscripten-core/emsdk
cd emsdk
./emsdk install 5.0.5
./emsdk activate 5.0.5
source ./emsdk_env.sh
export EMSCRIPTEN_CMAKE="$PWD/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
cd ..

# Build the web bundle
make web binjgb_emscripten_cmake="$EMSCRIPTEN_CMAKE"

# Serve it locally
python3 -m http.server 8000 --directory dist/web
```

Then open `http://127.0.0.1:8000/` and you should see the game boot.

If you just want the ROM without the browser stuff, `make pokered.gbc` is all you need (just rgbds + make, no Emscripten required).

### Run the arcade server locally

```bash
cd server
npm install
UPSTASH_REDIS_REST_URL=https://YOUR-DB.upstash.io \
UPSTASH_REDIS_REST_TOKEN=your_token_here \
node server.js
```

The server listens on `http://localhost:3000`. In `web/multiplayer.js` change `WS_URL` to `ws://localhost:3000/ws` for local development, then serve `dist/web/` in a separate terminal.

### Quick validation

```bash
# Check player.js and related files for syntax errors
node --check web/player.js
node --check web/multiplayer.js
node --check web/autoplay.js
node --check server/server.js

# Check the arcade handoff surface (additive features smoke test)
node scripts/verify-autoplay-handoff.js

# Full web build
make web binjgb_emscripten_cmake="$EMSCRIPTEN_CMAKE"
```

---

## Technical notes

A few design decisions worth knowing:

- **No link-cable multiplayer.** Link cable battles and trades require two synchronized Game Boy instances over a serial protocol with cycle-accurate timing. The shared arcade is turn-based screen sharing, not a dual-instance cable simulation — a genuinely different (and much harder) problem.

- **No transpilation.** Game Boy assembly compiles into a `.gbc` ROM via rgbds. That ROM runs inside a wasm-compiled C emulator. The browser never recompiles gameplay logic — it only runs the emulator binary.

- **Save compatibility is ROM-hash scoped.** SRAM and save-states are keyed to the SHA-1 of the compiled ROM. Rebuild from source, get a different hash, get a clean save namespace. This prevents silently loading a save into a binary-incompatible ROM — failures are loud rather than corrupting progress.

- **The Emscripten overlay must stay in sync with `player.js`.** If `web/binjgb/exported.json` or `web/binjgb/wrapper.c` drift from what the JS host expects, the emulator fails at bootstrap with a clear missing-export error rather than silently misbehaving.

- **AI is client-hosted, not server-side.** The bot (`autoplay.js`) runs in whoever the server designates as the AI host's browser tab, not in a headless process on Railway. This keeps the server stateless and cheap. The server only does arbitration.

- **Redis snapshot is eventually consistent.** The active player's browser pushes game state to Redis every ~10 seconds. A new visitor may be a few seconds behind the live cabinet, but this is invisible in practice.

---

*Built with [rgbds](https://rgbds.gbdev.io/), [binjgb](https://github.com/nicknassar/binjgb), [Emscripten](https://emscripten.org/), and the [pret/pokered](https://github.com/pret/pokered) disassembly.*
