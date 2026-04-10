# pokemon-rgb

`pokemon-rgb` is a Game Boy Color ROM source tree with a static browser deployment pipeline layered on top of it.

The repository produces two materially different outputs from the same source base:

- native ROM artifacts assembled by `rgbds`
- a GitHub Pages-compatible WebAssembly bundle that ships `pokered.gbc`, `binjgb.js`, `binjgb.wasm`, and a static HTML/CSS/JS shell

This README is intentionally scoped to the browser publication path and the files that control it.

## Relevant Files

- `Makefile`
  The authoritative build graph for both the ROM and the web bundle. The Pages entrypoint is emitted here.
- `.github/workflows/main.yml`
  CI plus GitHub Pages deployment. The `web` job builds `dist/web`; the `deploy` job publishes the Pages artifact on pushes to `main`.
- `web/player.html`
  Static document shell for the emulator surface. This file is copied to both `dist/web/index.html` and `dist/web/player.html`.
- `web/player.css`
  Responsive layout, canvas framing, control surface styling, and touch control presentation.
- `web/player.js`
  Browser runtime orchestration: ROM fetch, Emscripten module bootstrap, emulator lifecycle, IndexedDB persistence, import/export, keyboard/touch/gamepad handling, and fullscreen/audio behavior.
- `web/binjgb/exported.json`
  Overlay export list for the staged `binjgb` Emscripten build. This repo extends upstream exports with state APIs plus the runtime memory functions required by the JS host.
- `web/binjgb/wrapper.c`
  Overlay Emscripten wrapper used during the staged `binjgb` build. This is where browser-facing save-state hooks are injected without mutating the vendored submodule.
- `third_party/binjgb`
  Pinned emulator runtime source. The repo never edits this submodule in place; it stages an archive copy and patches that copy during the web build.
- `dist/web/`
  Final static site root. This directory is what GitHub Pages receives.

## Build Topology

### 1. ROM assembly

The Game Boy ROM is still the primary build artifact.

`make pokered.gbc` performs the normal `rgbasm` -> `rgblink` -> `rgbfix` pipeline. No browser-specific preprocessing happens inside the ROM build. The web port consumes the compiled ROM as an opaque binary payload.

That decision is important because it keeps the browser target operationally identical to local/native builds:

- ROM correctness remains owned by the existing assembly toolchain.
- The browser layer never recompiles or transforms gameplay logic into JavaScript.
- SHA-based save namespacing can be derived directly from the emitted `.gbc`.

### 2. Emulator staging

`make web` does not compile the vendored `third_party/binjgb` checkout in place.

Instead, the build graph creates `web/.build/binjgb`, archives the pinned submodule into that directory, and applies two repository-local overlays:

- `web/binjgb/exported.json`
- `web/binjgb/wrapper.c`

The staged copy is also patched for current toolchains:

- `cmake_minimum_required(VERSION 2.8)` is raised to `3.5` to survive current CMake behavior
- `HEAP8` and `HEAPU8` are exported from the Emscripten runtime so the browser host can construct typed-array views over wasm memory

This is deliberately done in the staged build tree instead of the submodule so upstream pinning remains clean and auditable.

### 3. Emscripten compilation

The staged emulator is compiled with Emscripten into:

- `dist/web/assets/binjgb.js`
- `dist/web/assets/binjgb.wasm`

The browser host relies on a specific exported surface:

- allocation and release: `_malloc`, `_free`
- ROM boot and main loop: `_emulator_new_simple`, `_emulator_run_until_f64`, `_emulator_delete`
- framebuffer/audio accessors
- SRAM read/write hooks
- save-state read/write hooks
- file-data helpers for transport buffers
- heap views for direct typed-array access

If any of those exports disappear, `web/player.js` will fail early during bootstrap rather than silently misbehave.

### 4. Static site assembly

The final site layout is assembled into `dist/web/`:

```text
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

Two HTML entrypoints are emitted intentionally:

- `index.html` is the canonical GitHub Pages root document
- `player.html` remains a stable deep link for iframe or direct embed use

The HTML shell uses relative URLs only, so the site is valid both at `/` and under a GitHub Pages project-site prefix such as `/pokemon-rgb/`.

## Browser Runtime Contract

The browser runtime in `web/player.js` is a thin host around the wasm emulator, not an emulator rewrite.

Boot sequence:

1. Load `assets/version.json`
2. Derive a storage namespace from `saveKey` or the ROM SHA
3. Open IndexedDB
4. Fetch `assets/pokered.gbc`
5. Instantiate `window.Binjgb()`
6. Load persisted SRAM/state metadata
7. Allocate ROM bytes into wasm memory
8. Create the emulator instance
9. Start the frame loop and enable the control surface

Persistence model:

- SRAM is stored in IndexedDB
- one manual save-state slot is stored in IndexedDB
- persistence is namespaced by ROM SHA to prevent silent state reuse across incompatible builds

Input model:

- keyboard
- touch controls
- Gamepad API

Runtime model:

- WebGL-backed canvas presentation when available
- browser audio unlock on first user gesture
- no backend
- no cloud sync
- no multiplayer transport

The runtime is intentionally single-player only. Link cable battles and trades are out of scope for this web target.

## GitHub Pages Publication

Publication is handled by `.github/workflows/main.yml`.

Behavior on `push` to `main`:

1. Checkout the repository with submodules
2. Install `rgbds`
3. Install and activate `emsdk` `5.0.5`
4. Run `make web`
5. Upload `dist/web` as a normal workflow artifact
6. Upload the same directory as the GitHub Pages artifact
7. Deploy that artifact with `actions/deploy-pages@v5`

The workflow is pinned to explicit Pages actions:

- `actions/configure-pages@v6`
- `actions/upload-pages-artifact@v5`
- `actions/deploy-pages@v5`

This repo is configured as a GitHub project site, so the expected public URL is:

`https://jamescastells.github.io/pokemon-rgb/`

The site root resolves to `dist/web/index.html`, which means the published URL opens the emulator directly instead of requiring `/player.html`.

## Local Bring-Up

### Native prerequisites

- `rgbds`
- `make`
- `git`

### Web prerequisites

- initialized submodules
- Emscripten `5.0.5` or a compatible toolchain that provides `emcmake`

Example:

```bash
git submodule update --init --recursive
git clone https://github.com/emscripten-core/emsdk
cd emsdk
./emsdk install 5.0.5
./emsdk activate 5.0.5
source ./emsdk_env.sh
export EMSCRIPTEN_CMAKE="$PWD/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
cd ../pokemon-rgb
make web binjgb_emscripten_cmake="$EMSCRIPTEN_CMAKE"
python3 -m http.server 8000 --directory dist/web
```

Open:

- `http://127.0.0.1:8000/`
- or `http://127.0.0.1:8000/player.html`

## Technical Constraints

- The web bundle ships a compiled `pokered.gbc` inside `dist/web/assets/`.
- The browser port is not a source-to-wasm conversion of the assembly code; it is ROM execution inside a wasm emulator.
- Save compatibility is ROM-hash scoped, not branch-name scoped.
- The site is static and CDN-friendly. There is no application server requirement.
- Deployment correctness depends on the staged `binjgb` overlay remaining synchronized with the expectations encoded in `web/player.js`.

## Verification Surface

Useful validation commands:

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/main.yml')"
node --check web/player.js
make web binjgb_emscripten_cmake="$EMSCRIPTEN_CMAKE"
```

For browser-level verification, serve `dist/web/` locally and confirm all of the following:

- root path `/` boots the emulator
- `player.html` remains a valid secondary entrypoint
- the canvas renders actual game frames
- IndexedDB persistence survives reloads
- save-state export/import remains functional
