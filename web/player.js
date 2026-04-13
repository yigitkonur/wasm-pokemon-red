/*
 * Pokemon RGB web player.
 *
 * This runtime borrows the browser integration patterns from binjgb's
 * docs/simple.js and docs/demo.js, both distributed under the MIT license.
 */
"use strict";

const RESULT_OK = 0;
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const AUDIO_FRAMES = 4096;
const AUDIO_LATENCY_SEC = 0.1;
const MAX_UPDATE_SEC = 5 / 60;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;
const GAMEPAD_POLLING_INTERVAL = 1000 / 60 / 4;
const STANDARD_GAMEPAD_MAPPING = "standard";
const STORAGE_DB_NAME = "pokemon-rgb-web";
const STORAGE_STORE_NAME = "sessions";
const DEFAULT_SAVE_KEY_BASE = "pokemon-rgb:red";

const elements = {
  buildLabel: document.getElementById("build-label"),
  errorBanner: document.getElementById("error-banner"),
  exportSaveButton: document.querySelector('[data-action="export-save"]'),
  exportStateButton: document.querySelector('[data-action="export-state"]'),
  importSaveInput: document.getElementById("import-save-input"),
  importStateInput: document.getElementById("import-state-input"),
  loadStateButton: document.querySelector('[data-action="load-state"]'),
  overlayMessage: document.getElementById("overlay-message"),
  pauseButton: document.getElementById("pause-button"),
  runtimeStatus: document.getElementById("runtime-status"),
  saveLabel: document.getElementById("save-label"),
  screen: document.getElementById("screen"),
  screenFrame: document.getElementById("screen-frame"),
  touchButtons: Array.from(document.querySelectorAll("[data-input]")),
};

const app = {
  emulator: null,
  module: null,
  persistTimerId: 0,
  romBaseName: "pokered",
  romBuffer: null,
  session: null,
  sessionStore: null,
  storageKey: null,
  version: null,
  wasRunningBeforeHide: false,
};

async function bootstrap() {
  if (typeof window.Binjgb !== "function") {
    throw new Error("binjgb.js did not load correctly.");
  }

  bindUi();
  setButtonsEnabled(false);
  setStatus("Loading build metadata");

  app.sessionStore = new SessionStore(STORAGE_DB_NAME, STORAGE_STORE_NAME);
  app.version = await fetchJson(new URL("assets/version.json", window.location.href));
  app.storageKey = createStorageKey(app.version);
  app.romBaseName = stripExtension(app.version.rom || "pokered.gbc");

  elements.buildLabel.textContent = [
    app.version.appVersion || "local",
    app.version.emulatorVersion || "binjgb",
  ].join(" / ");

  const [romBuffer, module, storedSession] = await Promise.all([
    fetchArrayBuffer(new URL(`assets/${app.version.rom}`, window.location.href)),
    window.Binjgb(),
    app.sessionStore.load(app.storageKey),
  ]);

  app.module = module;
  app.romBuffer = romBuffer;
  app.session = normalizeSession(storedSession, app.storageKey, app.version);

  startRuntime(app.session.sram);
  renderSessionLabel("Ready");
  setButtonsEnabled(true);
  refreshButtonState();
}

function bindUi() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAction(button.dataset.action)
        .catch((error) => handleError(error))
        .finally(() => elements.screenFrame.focus({preventScroll: true}));
    });
  });

  elements.importSaveInput.addEventListener("change", (event) => {
    importBinary(event.target.files[0], "save").catch((error) => handleError(error));
  });

  elements.importStateInput.addEventListener("change", (event) => {
    importBinary(event.target.files[0], "state").catch((error) => handleError(error));
  });

  document.addEventListener("visibilitychange", () => {
    if (!app.emulator) {
      return;
    }
    if (document.hidden) {
      app.wasRunningBeforeHide = !app.emulator.isPaused;
      if (app.wasRunningBeforeHide) {
        app.emulator.pause();
        syncPauseButton();
      }
    } else if (app.wasRunningBeforeHide) {
      app.emulator.resume();
      app.wasRunningBeforeHide = false;
      syncPauseButton();
    }
  });

  window.addEventListener("pagehide", () => {
    flushSram().catch(() => {});
  });
}

async function handleAction(action) {
  clearError();
  switch (action) {
    case "pause":
      ensureRuntime();
      if (app.emulator.isPaused) {
        app.emulator.resume();
      } else {
        app.emulator.pause();
      }
      syncPauseButton();
      break;
    case "reset":
      await flushSram();
      startRuntime(app.session.sram);
      break;
    case "fullscreen":
      await requestFullscreen(elements.screenFrame);
      break;
    case "save-state":
      ensureRuntime();
      app.session.state = app.emulator.captureState();
      await persistSession("State saved");
      break;
    case "load-state":
      ensureRuntime();
      if (!app.session.state) {
        throw new Error("No stored save state is available yet.");
      }
      app.emulator.loadState(app.session.state);
      setStatus("State restored");
      break;
    case "import-save":
      elements.importSaveInput.click();
      break;
    case "export-save":
      ensureRuntime();
      downloadBinary(`${app.romBaseName}.sav`, await currentSram(), "application/octet-stream");
      break;
    case "import-state":
      elements.importStateInput.click();
      break;
    case "export-state":
      ensureRuntime();
      downloadBinary(
          `${app.romBaseName}.state`,
          app.emulator.captureState(),
          "application/octet-stream");
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function importBinary(file, kind) {
  if (!file) {
    return;
  }
  ensureRuntime();
  const buffer = await file.arrayBuffer();

  if (kind === "save") {
    app.emulator.loadExtRam(buffer);
    app.session.sram = cloneArrayBuffer(buffer);
    await persistSession("Save imported");
    elements.importSaveInput.value = "";
    return;
  }

  if (kind === "state") {
    app.emulator.loadState(buffer);
    app.session.state = cloneArrayBuffer(buffer);
    await persistSession("State imported");
    elements.importStateInput.value = "";
    return;
  }

  throw new Error(`Unsupported import type: ${kind}`);
}

function startRuntime(initialSram) {
  if (app.emulator) {
    app.emulator.destroy();
  }

  app.emulator = new EmulatorRuntime(app.module, app.romBuffer, {
    canvas: elements.screen,
    onAudioUnlocked: () => {
      elements.overlayMessage.hidden = true;
    },
    onSramDirty: scheduleSramPersist,
    sram: initialSram,
    touchButtons: elements.touchButtons,
  });

  syncPauseButton();
  refreshButtonState();
  setStatus("Running");
}

function scheduleSramPersist() {
  window.clearTimeout(app.persistTimerId);
  app.persistTimerId = window.setTimeout(() => {
    flushSram().catch((error) => handleError(error));
  }, 800);
}

async function flushSram() {
  if (!app.emulator) {
    return;
  }
  app.session.sram = app.emulator.captureExtRam();
  await persistSession();
}

async function persistSession(statusMessage) {
  app.session.updatedAt = new Date().toISOString();
  await app.sessionStore.save(app.session);
  renderSessionLabel(statusMessage || "Local save updated");
  refreshButtonState();
}

async function currentSram() {
  ensureRuntime();
  const sram = app.emulator.captureExtRam();
  app.session.sram = sram;
  return sram;
}

function refreshButtonState() {
  const hasRuntime = Boolean(app.emulator);
  const hasState = Boolean(app.session && app.session.state);
  elements.loadStateButton.disabled = !hasRuntime || !hasState;
  elements.exportSaveButton.disabled = !hasRuntime;
  elements.exportStateButton.disabled = !hasRuntime;
}

function syncPauseButton() {
  const paused = !app.emulator || app.emulator.isPaused;
  elements.pauseButton.textContent = paused ? "Resume" : "Pause";
}

function setButtonsEnabled(enabled) {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = !enabled;
  });
  elements.touchButtons.forEach((button) => {
    button.disabled = !enabled;
  });
}

function ensureRuntime() {
  if (!app.emulator) {
    throw new Error("The emulator runtime is not ready yet.");
  }
}

function setStatus(message) {
  elements.runtimeStatus.textContent = message;
}

function renderSessionLabel(message) {
  const fragments = [];
  fragments.push(message || "Local save storage ready");
  if (app.session.updatedAt) {
    fragments.push(`updated ${formatTimestamp(app.session.updatedAt)}`);
  }
  if (app.session.state) {
    fragments.push("manual state slot ready");
  }
  elements.saveLabel.textContent = fragments.join(" • ");
}

function clearError() {
  elements.errorBanner.hidden = true;
  elements.errorBanner.textContent = "";
}

function handleError(error) {
  const message = error instanceof Error ? error.message : String(error);
  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = message;
  setStatus("Error");
  console.error(error);
}

function createStorageKey(version) {
  const params = new URLSearchParams(window.location.search);
  const base = params.get("saveKey") || DEFAULT_SAVE_KEY_BASE;
  return `${base}:${version.romSha1}`;
}

function normalizeSession(session, key, version) {
  const record = session && session.romSha1 === version.romSha1 ? session : {};
  return {
    appVersion: version.appVersion || "local",
    key,
    romSha1: version.romSha1,
    sram: record.sram ? cloneArrayBuffer(record.sram) : null,
    state: record.state ? cloneArrayBuffer(record.state) : null,
    updatedAt: record.updatedAt || null,
  };
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${url.pathname}`);
    }
    return response.json();
  });
}

function fetchArrayBuffer(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${url.pathname}`);
    }
    return response.arrayBuffer();
  });
}

function cloneArrayBuffer(bufferLike) {
  if (!bufferLike) {
    return null;
  }
  if (bufferLike instanceof ArrayBuffer) {
    return bufferLike.slice(0);
  }
  if (ArrayBuffer.isView(bufferLike)) {
    return bufferLike.buffer.slice(
        bufferLike.byteOffset,
        bufferLike.byteOffset + bufferLike.byteLength);
  }
  throw new Error("Unsupported binary value.");
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

function formatTimestamp(isoString) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(isoString));
}

function downloadBinary(filename, bufferLike, mimeType) {
  const payload = bufferLike instanceof Blob ? bufferLike : new Blob([bufferLike], {type: mimeType});
  const url = URL.createObjectURL(payload);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function requestFullscreen(element) {
  if (!document.fullscreenElement && element.requestFullscreen) {
    await element.requestFullscreen();
  } else if (document.exitFullscreen) {
    await document.exitFullscreen();
  }
}

function makeWasmBuffer(module, ptr, size) {
  const heap = module.HEAPU8 || module.HEAP8;
  if (!heap) {
    throw new Error("The emulator heap views were not exported from binjgb.js.");
  }
  return new Uint8Array(heap.buffer, ptr, size);
}

function alignRomBuffer(sourceBuffer) {
  const alignedSize = (sourceBuffer.byteLength + 0x7fff) & ~0x7fff;
  if (alignedSize === sourceBuffer.byteLength) {
    return cloneArrayBuffer(sourceBuffer);
  }
  const aligned = new Uint8Array(alignedSize);
  aligned.set(new Uint8Array(sourceBuffer));
  return aligned.buffer;
}

class SessionStore {
  constructor(dbName, storeName) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbPromise = this.open();
  }

  async open() {
    if (!("indexedDB" in window)) {
      throw new Error("IndexedDB is not available in this browser.");
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName, {keyPath: "key"});
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async load(key) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const request = tx.objectStore(this.storeName).get(key);
      request.onerror = () => reject(request.error || new Error("Failed to read browser save."));
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async save(record) {
    const db = await this.dbPromise;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to persist browser save."));
      tx.objectStore(this.storeName).put(record);
    });
  }
}

bootstrap().catch((error) => {
  handleError(error);
});

class EmulatorRuntime {
  constructor(module, romBuffer, options) {
    this.module = module;
    this.options = options;
    this.alignedRomBuffer = alignRomBuffer(romBuffer);
    this.romDataPtr = this.module._malloc(this.alignedRomBuffer.byteLength);
    makeWasmBuffer(this.module, this.romDataPtr, this.alignedRomBuffer.byteLength)
        .set(new Uint8Array(this.alignedRomBuffer));

    this.e = this.module._emulator_new_simple(
        this.romDataPtr,
        this.alignedRomBuffer.byteLength,
        AudioManager.sampleRate,
        AUDIO_FRAMES);
    if (this.e === 0) {
      throw new Error("The bundled ROM could not be started.");
    }

    this.audio = new AudioManager(module, this.e, options.onAudioUnlocked);
    this.video = new VideoManager(module, this.e, options.canvas);
    this.input = new InputManager(module, this.e, options.touchButtons, elements.screenFrame);
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.rafToken = null;

    if (options.sram) {
      this.loadExtRam(options.sram);
    }

    this.run();
  }

  destroy() {
    cancelAnimationFrame(this.rafToken);
    this.audio.destroy();
    this.input.destroy();
    this.module._emulator_delete(this.e);
    this.module._free(this.romDataPtr);
  }

  get isPaused() {
    return this.rafToken === null;
  }

  get ticks() {
    return this.module._emulator_get_ticks_f64(this.e);
  }

  pause() {
    if (this.isPaused) {
      return;
    }
    cancelAnimationFrame(this.rafToken);
    this.rafToken = null;
    this.audio.pause();
    setStatus("Paused");
  }

  resume() {
    if (!this.isPaused) {
      return;
    }
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.audio.resume();
    this.requestFrame();
    setStatus("Running");
  }

  run() {
    this.input.focusFrame();
    this.requestFrame();
  }

  requestFrame() {
    this.rafToken = requestAnimationFrame((timestamp) => this.onAnimationFrame(timestamp));
  }

  onAnimationFrame(startMs) {
    this.requestFrame();
    const startSec = startMs / 1000;
    const deltaSec = Math.max(startSec - (this.lastRafSec || startSec), 0);
    const deltaTicks = Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
    const untilTicks = this.ticks + deltaTicks - this.leftoverTicks;

    this.runUntil(untilTicks);
    this.leftoverTicks = (this.ticks - untilTicks) | 0;
    this.lastRafSec = startSec;
    this.video.renderTexture();
  }

  runUntil(untilTicks) {
    while (true) {
      const event = this.module._emulator_run_until_f64(this.e, untilTicks);
      if (event & EVENT_NEW_FRAME) {
        this.video.uploadTexture();
      }
      if (event & EVENT_AUDIO_BUFFER_FULL) {
        this.audio.pushBuffer();
      }
      if (event & EVENT_UNTIL_TICKS) {
        break;
      }
    }
    if (this.module._emulator_was_ext_ram_updated(this.e)) {
      this.options.onSramDirty();
    }
  }

  withFileData(factory, callback) {
    const fileDataPtr = factory.call(this.module, this.e);
    const buffer = makeWasmBuffer(
        this.module,
        this.module._get_file_data_ptr(fileDataPtr),
        this.module._get_file_data_size(fileDataPtr));
    const result = callback(fileDataPtr, buffer);
    this.module._file_data_delete(fileDataPtr);
    return result;
  }

  loadExtRam(extRamBuffer) {
    this.withFileData(this.module._ext_ram_file_data_new, (fileDataPtr, buffer) => {
      if (buffer.byteLength !== extRamBuffer.byteLength) {
        throw new Error("This save file does not match Pokemon RGB's SRAM size.");
      }
      buffer.set(new Uint8Array(extRamBuffer));
      const result = this.module._emulator_read_ext_ram(this.e, fileDataPtr);
      if (result !== RESULT_OK) {
        throw new Error("The save file could not be loaded.");
      }
    });
    this.video.uploadTexture();
    this.video.renderTexture();
  }

  captureExtRam() {
    return this.withFileData(this.module._ext_ram_file_data_new, (fileDataPtr, buffer) => {
      const result = this.module._emulator_write_ext_ram(this.e, fileDataPtr);
      if (result !== RESULT_OK) {
        throw new Error("The current save data could not be exported.");
      }
      return new Uint8Array(buffer).slice().buffer;
    });
  }

  loadState(stateBuffer) {
    this.withFileData(this.module._state_file_data_new, (fileDataPtr, buffer) => {
      if (buffer.byteLength !== stateBuffer.byteLength) {
        throw new Error("This state file is incompatible with the current build.");
      }
      buffer.set(new Uint8Array(stateBuffer));
      const result = this.module._emulator_read_state(this.e, fileDataPtr);
      if (result !== RESULT_OK) {
        throw new Error("The state file could not be restored.");
      }
    });
    this.video.uploadTexture();
    this.video.renderTexture();
  }

  captureState() {
    return this.withFileData(this.module._state_file_data_new, (fileDataPtr, buffer) => {
      const result = this.module._emulator_write_state(this.e, fileDataPtr);
      if (result !== RESULT_OK) {
        throw new Error("The current emulator state could not be captured.");
      }
      return new Uint8Array(buffer).slice().buffer;
    });
  }
}

class AudioManager {
  static get sampleRate() {
    const context = AudioManager.getContext();
    return context ? context.sampleRate : 48000;
  }

  static getContext() {
    if (AudioManager.context !== undefined) {
      return AudioManager.context;
    }
    const Context = window.AudioContext || window.webkitAudioContext;
    AudioManager.context = Context ? new Context() : null;
    return AudioManager.context;
  }

  constructor(module, emulatorHandle, onUnlocked) {
    this.module = module;
    this.context = AudioManager.getContext();
    this.available = Boolean(this.context);
    this.buffer = makeWasmBuffer(
        this.module,
        this.module._get_audio_buffer_ptr(emulatorHandle),
        this.module._get_audio_buffer_capacity(emulatorHandle));
    this.onUnlocked = onUnlocked;
    this.started = !this.available || AudioManager.unlocked;
    this.startSec = 0;

    if (this.available) {
      if (this.started) {
        elements.overlayMessage.hidden = true;
      } else {
        this.boundStartPlayback = () => this.startPlayback();
        window.addEventListener("keydown", this.boundStartPlayback, true);
        window.addEventListener("click", this.boundStartPlayback, true);
        window.addEventListener("touchend", this.boundStartPlayback, true);
      }
    } else {
      elements.overlayMessage.hidden = true;
    }
  }

  startPlayback() {
    if (!this.available) {
      return;
    }
    if (this.boundStartPlayback) {
      window.removeEventListener("keydown", this.boundStartPlayback, true);
      window.removeEventListener("click", this.boundStartPlayback, true);
      window.removeEventListener("touchend", this.boundStartPlayback, true);
    }
    AudioManager.unlocked = true;
    this.started = true;
    this.context.resume();
    if (this.onUnlocked) {
      this.onUnlocked();
    }
  }

  pushBuffer() {
    if (!this.available || !this.started) {
      return;
    }

    const nowSec = this.context.currentTime;
    const nowWithLatency = nowSec + AUDIO_LATENCY_SEC;
    this.startSec = this.startSec || nowWithLatency;

    if (this.startSec < nowSec) {
      this.startSec = nowWithLatency;
    }

    const output = this.context.createBuffer(2, AUDIO_FRAMES, this.context.sampleRate);
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);

    for (let index = 0; index < AUDIO_FRAMES; index += 1) {
      left[index] = this.buffer[index * 2] / 255;
      right[index] = this.buffer[index * 2 + 1] / 255;
    }

    const source = this.context.createBufferSource();
    source.buffer = output;
    source.connect(this.context.destination);
    source.start(this.startSec);
    this.startSec += AUDIO_FRAMES / this.context.sampleRate;
  }

  pause() {
    if (this.available && this.started) {
      this.context.suspend();
    }
  }

  resume() {
    if (this.available && this.started) {
      this.context.resume();
    }
  }

  destroy() {
    if (!this.available || !this.boundStartPlayback) {
      return;
    }
    window.removeEventListener("keydown", this.boundStartPlayback, true);
    window.removeEventListener("click", this.boundStartPlayback, true);
    window.removeEventListener("touchend", this.boundStartPlayback, true);
  }
}

AudioManager.context = undefined;
AudioManager.unlocked = false;

class VideoManager {
  constructor(module, emulatorHandle, canvas) {
    this.module = module;
    this.canvas = canvas;
    if (window.navigator.userAgent.match(/iPhone|iPad/i)) {
      this.renderer = new CanvasRenderer(canvas);
    } else {
      try {
        this.renderer = new WebGlRenderer(canvas);
      } catch (error) {
        console.warn("Falling back to 2D canvas renderer.", error);
        this.renderer = new CanvasRenderer(canvas);
      }
    }
    this.buffer = makeWasmBuffer(
        this.module,
        this.module._get_frame_buffer_ptr(emulatorHandle),
        this.module._get_frame_buffer_size(emulatorHandle));
  }

  uploadTexture() {
    this.renderer.uploadTexture(this.buffer);
  }

  renderTexture() {
    this.renderer.renderTexture();
  }
}

class CanvasRenderer {
  constructor(canvas) {
    this.context = canvas.getContext("2d");
    this.imageData = this.context.createImageData(canvas.width, canvas.height);
  }

  uploadTexture(buffer) {
    this.imageData.data.set(buffer);
  }

  renderTexture() {
    this.context.putImageData(this.imageData, 0, 0);
  }
}

class WebGlRenderer {
  constructor(canvas) {
    this.gl = canvas.getContext("webgl", {preserveDrawingBuffer: true});
    if (!this.gl) {
      throw new Error("WebGL is unavailable.");
    }

    const {gl} = this;
    const widthScale = SCREEN_WIDTH / 256;
    const heightScale = SCREEN_HEIGHT / 256;

    const vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, heightScale,
      1, -1, widthScale, heightScale,
      -1, 1, 0, 0,
      1, 1, widthScale, 0,
    ]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        256,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 aPos;
      attribute vec2 aTexCoord;
      varying highp vec2 vTexCoord;
      void main(void) {
        gl_Position = vec4(aPos, 0.0, 1.0);
        vTexCoord = aTexCoord;
      }
    `);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
      varying highp vec2 vTexCoord;
      uniform sampler2D uSampler;
      void main(void) {
        gl_FragColor = texture2D(uSampler, vTexCoord);
      }
    `);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "WebGL link failed.");
    }

    gl.useProgram(program);

    const position = gl.getAttribLocation(program, "aPos");
    const texCoord = gl.getAttribLocation(program, "aTexCoord");
    const sampler = gl.getUniformLocation(program, "uSampler");

    gl.enableVertexAttribArray(position);
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 16, 8);
    gl.uniform1i(sampler, 0);
  }

  uploadTexture(buffer) {
    this.gl.texSubImage2D(
        this.gl.TEXTURE_2D,
        0,
        0,
        0,
        SCREEN_WIDTH,
        SCREEN_HEIGHT,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        buffer);
  }

  renderTexture() {
    this.gl.clearColor(0, 0, 0, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }
}

class InputManager {
  constructor(module, emulatorHandle, touchButtons, frameElement) {
    this.module = module;
    this.e = emulatorHandle;
    this.frameElement = frameElement;
    this.keyHandlers = {
      ArrowDown: this.module._set_joyp_down.bind(null, this.e),
      ArrowLeft: this.module._set_joyp_left.bind(null, this.e),
      ArrowRight: this.module._set_joyp_right.bind(null, this.e),
      ArrowUp: this.module._set_joyp_up.bind(null, this.e),
      Enter: this.module._set_joyp_A.bind(null, this.e),
      Escape: this.module._set_joyp_start.bind(null, this.e),
      KeyX: this.module._set_joyp_A.bind(null, this.e),
      KeyZ: this.module._set_joyp_B.bind(null, this.e),
      ShiftLeft: this.module._set_joyp_B.bind(null, this.e),
      ShiftRight: this.module._set_joyp_B.bind(null, this.e),
      Space: this.module._set_joyp_A.bind(null, this.e),
      Tab: this.module._set_joyp_select.bind(null, this.e),
    };
    this.activeKeyCodes = new Set();
    this.touchButtons = touchButtons;

    this.bindKeyboard();
    this.bindTouchControls();
    this.gamepad = new GamepadInput(module, emulatorHandle);
    this.gamepad.init();
  }

  bindKeyboard() {
    this.boundKeyDown = (event) => this.onKey(event, true);
    this.boundKeyUp = (event) => this.onKey(event, false);
    this.boundPointerDown = (event) => this.onPointerDown(event);
    this.boundWindowBlur = () => this.releaseActiveKeys();
    this.boundVisibilityChange = () => {
      if (document.hidden) {
        this.releaseActiveKeys();
      }
    };
    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    window.addEventListener("blur", this.boundWindowBlur);
    document.addEventListener("pointerdown", this.boundPointerDown);
    document.addEventListener("visibilitychange", this.boundVisibilityChange);
  }

  bindTouchControls() {
    this.touchBindings = {
      a: this.module._set_joyp_A.bind(null, this.e),
      b: this.module._set_joyp_B.bind(null, this.e),
      down: this.module._set_joyp_down.bind(null, this.e),
      left: this.module._set_joyp_left.bind(null, this.e),
      right: this.module._set_joyp_right.bind(null, this.e),
      select: this.module._set_joyp_select.bind(null, this.e),
      start: this.module._set_joyp_start.bind(null, this.e),
      up: this.module._set_joyp_up.bind(null, this.e),
    };

    this.touchButtonListeners = this.touchButtons.map((button) => {
      const handler = this.touchBindings[button.dataset.input];
      const onPress = (event) => {
        handler(true);
        button.classList.add("is-active");
        button.setPointerCapture(event.pointerId);
        event.preventDefault();
      };
      const onRelease = (event) => {
        handler(false);
        button.classList.remove("is-active");
        event.preventDefault();
      };

      button.addEventListener("pointerdown", onPress);
      button.addEventListener("pointerup", onRelease);
      button.addEventListener("pointercancel", onRelease);
      button.addEventListener("pointerleave", onRelease);
      return {button, onPress, onRelease};
    });
  }

  focusFrame() {
    if (!this.frameElement || document.activeElement === this.frameElement) {
      return;
    }
    this.frameElement.focus({preventScroll: true});
  }

  onPointerDown(event) {
    if (this.frameElement && this.frameElement.contains(event.target)) {
      this.focusFrame();
      return;
    }
    this.releaseActiveKeys();
  }

  onKey(event, isDown) {
    const handler = this.keyHandlers[event.code];
    if (!handler) {
      return;
    }
    if (isDown && event.repeat) {
      event.preventDefault();
      return;
    }
    handler(isDown);
    if (isDown) {
      this.activeKeyCodes.add(event.code);
    } else {
      this.activeKeyCodes.delete(event.code);
    }
    event.preventDefault();
  }

  releaseActiveKeys() {
    this.activeKeyCodes.forEach((code) => {
      const handler = this.keyHandlers[code];
      if (handler) {
        handler(false);
      }
    });
    this.activeKeyCodes.clear();
  }

  destroy() {
    this.releaseActiveKeys();
    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    window.removeEventListener("blur", this.boundWindowBlur);
    document.removeEventListener("pointerdown", this.boundPointerDown);
    document.removeEventListener("visibilitychange", this.boundVisibilityChange);
    this.touchButtonListeners.forEach(({button, onPress, onRelease}) => {
      button.removeEventListener("pointerdown", onPress);
      button.removeEventListener("pointerup", onRelease);
      button.removeEventListener("pointercancel", onRelease);
      button.removeEventListener("pointerleave", onRelease);
    });
    this.gamepad.shutdown();
  }
}

class GamepadInput {
  constructor(module, emulatorHandle) {
    this.module = module;
    this.e = emulatorHandle;
  }

  init() {
    this.state = {
      apiId: undefined,
      buttons: {changed: [], current: [], previous: undefined},
      axes: {changed: [], current: [], previous: undefined},
      keybinds: undefined,
      timerId: undefined,
    };

    this.boundConnected = (event) => this.onConnected(event);
    this.boundDisconnected = () => this.releaseGamepad();
    window.addEventListener("gamepadconnected", this.boundConnected);
    window.addEventListener("gamepaddisconnected", this.boundDisconnected);

    this.checkAlreadyConnected();
  }

  shutdown() {
    this.releaseGamepad();
    window.removeEventListener("gamepadconnected", this.boundConnected);
    window.removeEventListener("gamepaddisconnected", this.boundDisconnected);
  }

  checkAlreadyConnected() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let index = 0; index < pads.length; index += 1) {
      if (pads[index] && pads[index].connected) {
        this.startGamepad(pads[index]);
        return;
      }
    }
  }

  onConnected(event) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.startGamepad(pads[event.gamepad.index]);
  }

  startGamepad(gamepad) {
    if (!gamepad) {
      return;
    }
    this.state.apiId = gamepad.index;
    this.state.keybinds = gamepad.mapping === STANDARD_GAMEPAD_MAPPING ?
      [
        {button: 0, handler: this.module._set_joyp_B.bind(null, this.e), type: "button"},
        {button: 1, handler: this.module._set_joyp_A.bind(null, this.e), type: "button"},
        {button: 8, handler: this.module._set_joyp_select.bind(null, this.e), type: "button"},
        {button: 9, handler: this.module._set_joyp_start.bind(null, this.e), type: "button"},
        {button: 12, handler: this.module._set_joyp_up.bind(null, this.e), type: "button"},
        {button: 13, handler: this.module._set_joyp_down.bind(null, this.e), type: "button"},
        {button: 14, handler: this.module._set_joyp_left.bind(null, this.e), type: "button"},
        {button: 15, handler: this.module._set_joyp_right.bind(null, this.e), type: "button"},
      ] :
      [
        {button: 0, handler: this.module._set_joyp_A.bind(null, this.e), type: "button"},
        {button: 1, handler: this.module._set_joyp_B.bind(null, this.e), type: "button"},
        {button: 2, handler: this.module._set_joyp_select.bind(null, this.e), type: "button"},
        {button: 3, handler: this.module._set_joyp_start.bind(null, this.e), type: "button"},
        {button: 0, handler: this.module._set_joyp_left.bind(null, this.e), type: "axis"},
        {button: 1, handler: this.module._set_joyp_right.bind(null, this.e), type: "axis"},
        {button: 2, handler: this.module._set_joyp_up.bind(null, this.e), type: "axis"},
        {button: 3, handler: this.module._set_joyp_down.bind(null, this.e), type: "axis"},
      ];

    window.clearInterval(this.state.timerId);
    this.state.timerId = window.setInterval(() => this.update(), GAMEPAD_POLLING_INTERVAL);
  }

  releaseGamepad() {
    window.clearInterval(this.state.timerId);
    this.state.timerId = undefined;
    this.state.apiId = undefined;
    this.state.buttons.previous = undefined;
    this.state.axes.previous = undefined;
  }

  update() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gamepad = pads[this.state.apiId];
    if (!gamepad || !gamepad.connected) {
      this.releaseGamepad();
      return;
    }

    this.cacheButtons(gamepad);
    this.state.keybinds.forEach((binding) => {
      const bucket = binding.type === "button" ? this.state.buttons : this.state.axes;
      if (!bucket.changed[binding.button]) {
        return;
      }
      binding.handler(bucket.current[binding.button]);
    });
  }

  cacheButtons(gamepad) {
    for (let index = 0; index < gamepad.buttons.length; index += 1) {
      this.state.buttons.current[index] =
        gamepad.buttons[index].pressed || gamepad.buttons[index].value > 0;
      this.state.buttons.changed[index] =
        this.state.buttons.previous &&
        this.state.buttons.current[index] !== this.state.buttons.previous[index];
    }

    for (let index = 0; index < gamepad.axes.length; index += 1) {
      this.state.axes.current[index * 2] = gamepad.axes[index] < -0.35;
      this.state.axes.current[index * 2 + 1] = gamepad.axes[index] > 0.35;
      this.state.axes.changed[index * 2] =
        this.state.axes.previous &&
        this.state.axes.current[index * 2] !== this.state.axes.previous[index * 2];
      this.state.axes.changed[index * 2 + 1] =
        this.state.axes.previous &&
        this.state.axes.current[index * 2 + 1] !== this.state.axes.previous[index * 2 + 1];
    }

    this.state.buttons.previous = this.state.buttons.current.slice(0);
    this.state.axes.previous = this.state.axes.current.slice(0);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
  }
  return shader;
}
