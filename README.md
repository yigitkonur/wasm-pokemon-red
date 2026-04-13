# wasm-pokemon-red

> How I got Pokémon Red running in a browser using WebAssembly — from Game Boy assembly to a static site.

## The idea

What if you could play Pokémon Red in a browser tab? No downloads, no extensions, no emulator apps — just open a URL and you're in Pallet Town. That's what this project does. It takes the actual disassembled Game Boy source code, compiles the ROM from scratch, wraps a C emulator in WebAssembly, and serves the whole thing as a static site on GitHub Pages. No backend. No cloud. Just HTML, JS, WASM, and a `.gbc` file.

Here's how I got there, step by step.

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

## Playing it

**[▶ Play it live](https://yigitkonur.github.io/wasm-pokemon-red/)**

Once the page loads, you're in. Controls:

| Action | Keyboard | Gamepad |
|--------|----------|---------|
| D-pad | Arrow keys | D-pad / Left stick |
| A | Z | A button |
| B | X | B button |
| Start | Enter | Start |
| Select | Backspace | Select |

On mobile, use the on-screen touch controls.

Your game saves automatically to IndexedDB — close the tab, come back later, and your progress is still there. There's also a manual save-state slot you can use for quick saves. Save data is scoped to the specific ROM build, so different builds won't clobber each other's saves.

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

### Quick validation

```bash
# Check the workflow YAML parses
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/main.yml')"

# Check player.js for syntax errors
node --check web/player.js

# Full web build
make web binjgb_emscripten_cmake="$EMSCRIPTEN_CMAKE"
```

---

## Technical constraints

A few things this project deliberately does **not** do:

- **No multiplayer.** Link cable battles and trades require two Game Boy instances communicating over a serial protocol. We'd need a signaling server, WebRTC or WebSocket transport, and cycle-accurate synchronization. It's a genuinely hard problem and it's out of scope.

- **No cloud sync.** Save data lives in your browser's IndexedDB. Clear your browser data and it's gone. There's no account system, no backend, no sync service.

- **No source-to-wasm compilation.** We're not transpiling Game Boy assembly into WebAssembly. The `.asm` files compile into a `.gbc` ROM through the normal rgbds toolchain, and that ROM runs inside a wasm-compiled emulator. The browser never sees or recompiles gameplay logic.

- **Save compatibility is ROM-hash scoped.** If you change the source and rebuild, your old save data won't load automatically. This is a feature, not a bug — it prevents corrupted saves from binary-incompatible ROMs.

- **The staged overlay must stay in sync with `player.js`.** If `exported.json` or `wrapper.c` drift from what the JavaScript host expects, things break. The emulator will fail at bootstrap with missing exports rather than silently misbehaving, so at least failures are loud.

---

*Built with [rgbds](https://rgbds.gbdev.io/), [binjgb](https://github.com/nicknassar/binjgb), [Emscripten](https://emscripten.org/), and a mass of caffeine.*
