/**
 * multiplayer.js — Shared Arcade Pokemon Red
 *
 * Turns the single-player WASM emulator into a "Twitch Plays Pokemon"
 * shared cabinet. One game, many players, turn-based control with
 * 5-second idle timeout, live chat, spectator state sync.
 *
 * Backend: Upstash Redis REST API (no server needed).
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /*  Configuration                                                      */
  /* ------------------------------------------------------------------ */
  const CFG = {
    REDIS_URL:
      "https://shining-aphid-98269.upstash.io",
    REDIS_TOKEN:
      "gQAAAAAAAX_dAAIncDFiYTBjMmYyMjdjN2Q0Y2ZlYjA4YjFhZmJiZjhjN2NmZXAxOTgyNjk",
    TURN_TTL: 6,                // seconds — Redis key expiry (includes 1 s grace)
    IDLE_TIMEOUT: 5,            // seconds — UI display for "idle" countdown
    POLL_MS: 1200,              // main status poll interval
    CHAT_POLL_MS: 1800,         // chat fetch interval
    HEARTBEAT_MS: 5000,         // viewer heartbeat
    STATE_PUSH_MS: 3000,        // active player pushes state to Redis
    SPECTATOR_PULL_MS: 4000,    // spectators pull state
    CHAT_CAP: 200,              // max stored messages
    NICK_MAX: 16,
  };

  /* ------------------------------------------------------------------ */
  /*  Upstash REST Client                                                */
  /* ------------------------------------------------------------------ */
  class Redis {
    constructor(url, token) {
      this.url = url;
      this.headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
    }

    async exec(/* ...args */) {
      const args = Array.from(arguments);
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error("Redis " + res.status);
      return (await res.json()).result;
    }

    async pipeline(cmds) {
      const res = await fetch(this.url + "/pipeline", {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(cmds),
      });
      if (!res.ok) throw new Error("Redis pipeline " + res.status);
      return (await res.json()).map(function (r) { return r.result; });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Player Identity  (localStorage-backed)                             */
  /* ------------------------------------------------------------------ */
  class Identity {
    constructor() {
      this.id = localStorage.getItem("mp-pid");
      if (!this.id) {
        this.id = crypto.randomUUID();
        localStorage.setItem("mp-pid", this.id);
      }
      this.nickname =
        localStorage.getItem("mp-nick") || Identity.randomNick();
    }

    static randomNick() {
      var adj = ["Red", "Blue", "Brave", "Swift", "Wild", "Lucky", "Cool", "Ace"];
      var mon = ["Trainer", "Pikachu", "Charmander", "Squirtle", "Bulbasaur",
                 "Eevee", "Mewtwo", "Snorlax", "Jigglypuff", "Gengar"];
      return (
        adj[(Math.random() * adj.length) | 0] +
        mon[(Math.random() * mon.length) | 0] +
        ((Math.random() * 100) | 0)
      );
    }

    setNickname(name) {
      name = (name || "").trim().substring(0, CFG.NICK_MAX);
      this.nickname = name || Identity.randomNick();
      localStorage.setItem("mp-nick", this.nickname);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Turn Manager                                                       */
  /* ------------------------------------------------------------------ */
  class TurnManager {
    constructor(redis, me) {
      this.redis = redis;
      this.me = me;
      this.isMyTurn = false;
      this.activeName = null;
      this.activeId = null;
      this.queuePos = -1;
      this.queueLen = 0;
      this.viewers = 0;
      this.joined = false;
      this.turnTTL = 0;
      this.onTurnStart = null;
      this.onTurnEnd = null;
    }

    async join() {
      if (this.joined) return;
      await this.redis.pipeline([
        ["RPUSH", "game:queue", this.me.id],
        ["SET", "player:" + this.me.id + ":name", this.me.nickname, "EX", "3600"],
        ["ZADD", "game:viewers", String(Date.now()), this.me.id],
      ]);
      this.joined = true;
    }

    async leave() {
      if (!this.joined) return;
      if (this.isMyTurn) {
        if (this.onTurnEnd) await this.onTurnEnd();
        await this.redis.exec("DEL", "game:active_player");
      }
      await this.redis.exec("LREM", "game:queue", "0", this.me.id);
      this.joined = false;
      this.isMyTurn = false;
    }

    async poll() {
      try {
        var r = await this.redis.pipeline([
          ["GET", "game:active_player"],
          ["LRANGE", "game:queue", "0", "-1"],
          ["ZCOUNT", "game:viewers", String(Date.now() - 30000), "+inf"],
          ["TTL", "game:active_player"],
        ]);
        var active = r[0], queue = r[1] || [], viewers = r[2], ttl = r[3];

        this.viewers = viewers || 0;
        this.queueLen = queue.length;
        this.turnTTL = ttl > 0 ? ttl : 0;
        if (this.joined) {
          this.queuePos = queue.indexOf(this.me.id);
        }

        var wasMyTurn = this.isMyTurn;

        if (!active) {
          // No active player — first in queue claims
          if (this.joined && queue.length > 0 && queue[0] === this.me.id) {
            var ok = await this.redis.exec(
              "SET", "game:active_player", this.me.id, "NX", "EX", String(CFG.TURN_TTL)
            );
            if (ok === "OK") {
              this.isMyTurn = true;
              this.activeId = this.me.id;
              this.activeName = this.me.nickname;
              // Rotate to back of queue
              await this.redis.pipeline([
                ["LPOP", "game:queue"],
                ["RPUSH", "game:queue", this.me.id],
              ]);
              if (!wasMyTurn && this.onTurnStart) await this.onTurnStart();
              return;
            }
          }
          this.isMyTurn = false;
          this.activeId = null;
          this.activeName = null;
        } else if (active === this.me.id) {
          this.isMyTurn = true;
          this.activeId = this.me.id;
          this.activeName = this.me.nickname;
          if (!wasMyTurn && this.onTurnStart) await this.onTurnStart();
        } else {
          if (wasMyTurn && this.onTurnEnd) await this.onTurnEnd();
          this.isMyTurn = false;
          this.activeId = active;
          var n = await this.redis.exec("GET", "player:" + active + ":name");
          this.activeName = n || "Trainer";
        }
      } catch (err) {
        console.warn("[MP] poll:", err);
      }
    }

    async recordInput() {
      if (!this.isMyTurn) return;
      try {
        await this.redis.exec("EXPIRE", "game:active_player", String(CFG.TURN_TTL));
      } catch (_) { /* best effort */ }
    }

    async heartbeat() {
      try {
        await this.redis.exec("ZADD", "game:viewers", String(Date.now()), this.me.id);
      } catch (_) { /* silent */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Chat Manager                                                       */
  /* ------------------------------------------------------------------ */
  class ChatManager {
    constructor(redis, me) {
      this.redis = redis;
      this.me = me;
      this.messages = [];
      this.lastId = null;
      this.onUpdate = null;
    }

    async send(text) {
      text = (text || "").trim();
      if (!text || text.length > 280) return;
      var msg = JSON.stringify({
        id: crypto.randomUUID(),
        pid: this.me.id,
        nick: this.me.nickname,
        text: text,
        ts: Date.now(),
      });
      await this.redis.pipeline([
        ["LPUSH", "game:chat", msg],
        ["LTRIM", "game:chat", "0", String(CFG.CHAT_CAP - 1)],
      ]);
    }

    async fetch() {
      try {
        var raw = await this.redis.exec("LRANGE", "game:chat", "0", "49");
        if (!raw || !Array.isArray(raw)) return;
        var parsed = [];
        for (var i = 0; i < raw.length; i++) {
          try { parsed.push(JSON.parse(raw[i])); } catch (_) {}
        }
        parsed.reverse();
        var newLast = parsed.length > 0 ? parsed[parsed.length - 1].id : null;
        if (newLast !== this.lastId) {
          this.messages = parsed;
          this.lastId = newLast;
          if (this.onUpdate) this.onUpdate(this.messages);
        }
      } catch (err) {
        console.warn("[MP] chat fetch:", err);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  State Sync                                                         */
  /* ------------------------------------------------------------------ */
  class StateSync {
    constructor(redis) {
      this.redis = redis;
      this.version = 0;
    }

    async upload(stateBuffer, sramBuffer) {
      var stateB64 = bufToB64(stateBuffer);
      var sramB64 = bufToB64(sramBuffer);
      await this.redis.pipeline([
        ["SET", "game:state", stateB64],
        ["SET", "game:sram", sramB64],
        ["INCR", "game:version"],
        ["SET", "game:state_ts", String(Date.now())],
      ]);
    }

    async download() {
      var r = await this.redis.pipeline([
        ["GET", "game:version"],
        ["GET", "game:state"],
        ["GET", "game:sram"],
      ]);
      var ver = parseInt(r[0]) || 0;
      if (ver <= this.version) return null;
      this.version = ver;
      if (!r[1]) return null;
      return {
        state: b64ToBuf(r[1]),
        sram: r[2] ? b64ToBuf(r[2]) : null,
        version: ver,
      };
    }

    async checkVersion() {
      var v = await this.redis.exec("GET", "game:version");
      return parseInt(v) || 0;
    }
  }

  /* ---- base64 ↔ ArrayBuffer helpers ---- */
  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToBuf(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* ------------------------------------------------------------------ */
  /*  Main Controller                                                    */
  /* ------------------------------------------------------------------ */
  class Multiplayer {
    constructor() {
      this.redis = new Redis(CFG.REDIS_URL, CFG.REDIS_TOKEN);
      this.me = new Identity();
      this.turn = new TurnManager(this.redis, this.me);
      this.chat = new ChatManager(this.redis, this.me);
      this.sync = new StateSync(this.redis);

      this._pollTimer = null;
      this._chatTimer = null;
      this._heartTimer = null;
      this._pushTimer = null;
      this._pullTimer = null;

      // Callbacks for player.js integration
      this.onStatusChange = null;   // (status) => void
      this.onTurnStart = null;      // () => void  — I gained control
      this.onTurnEnd = null;        // () => void  — I lost control
      this.onChatUpdate = null;     // (messages[]) => void

      this.emulator = null;         // set by player.js after init
    }

    /** Connect emulator instance for state sync */
    setEmulator(emu) {
      this.emulator = emu;
    }

    /** Start multiplayer session */
    async start() {
      var self = this;

      /* Turn callbacks wired to emulator state */
      this.turn.onTurnStart = async function () {
        // Load latest game state when gaining control
        try {
          var data = await self.sync.download();
          if (data && data.state && self.emulator) {
            self.emulator.loadState(data.state);
          }
        } catch (err) {
          console.warn("[MP] load state on turn start:", err);
        }
        if (self.onTurnStart) self.onTurnStart();
        self._startPush();
      };

      this.turn.onTurnEnd = async function () {
        // Save state before losing control
        try {
          if (self.emulator) {
            await self.sync.upload(
              self.emulator.captureState(),
              self.emulator.captureExtRam()
            );
          }
        } catch (err) {
          console.warn("[MP] save state on turn end:", err);
        }
        self._stopPush();
        if (self.onTurnEnd) self.onTurnEnd();
        self._startPull();
      };

      this.chat.onUpdate = function (msgs) {
        if (self.onChatUpdate) self.onChatUpdate(msgs);
      };

      // Join queue
      await this.turn.join();

      // Start poll loops
      this._pollTimer = setInterval(function () { self._poll(); }, CFG.POLL_MS);
      this._chatTimer = setInterval(function () { self.chat.fetch(); }, CFG.CHAT_POLL_MS);
      this._heartTimer = setInterval(function () { self.turn.heartbeat(); }, CFG.HEARTBEAT_MS);

      // Initial fetch
      await this._poll();
      await this.chat.fetch();

      // If not my turn, start spectator sync
      if (!this.turn.isMyTurn) {
        this._startPull();
      }
    }

    async _poll() {
      await this.turn.poll();
      if (this.onStatusChange) this.onStatusChange(this.getStatus());
    }

    /** Called from InputManager on every key press */
    async recordInput() {
      await this.turn.recordInput();
    }

    /** Periodically push full state while active */
    _startPush() {
      this._stopPull();
      var self = this;
      this._pushTimer = setInterval(async function () {
        if (!self.turn.isMyTurn || !self.emulator) return;
        try {
          await self.sync.upload(
            self.emulator.captureState(),
            self.emulator.captureExtRam()
          );
        } catch (err) {
          console.warn("[MP] push:", err);
        }
      }, CFG.STATE_PUSH_MS);
    }

    _stopPush() {
      if (this._pushTimer) {
        clearInterval(this._pushTimer);
        this._pushTimer = null;
      }
    }

    /** Periodically pull state while spectating */
    _startPull() {
      this._stopPull();
      var self = this;
      this._pullTimer = setInterval(async function () {
        if (self.turn.isMyTurn || !self.emulator) return;
        try {
          var ver = await self.sync.checkVersion();
          if (ver > self.sync.version) {
            var data = await self.sync.download();
            if (data && data.state) {
              self.emulator.loadState(data.state);
            }
          }
        } catch (err) {
          console.warn("[MP] pull:", err);
        }
      }, CFG.SPECTATOR_PULL_MS);
    }

    _stopPull() {
      if (this._pullTimer) {
        clearInterval(this._pullTimer);
        this._pullTimer = null;
      }
    }

    /** Current status snapshot */
    getStatus() {
      return {
        isMyTurn: this.turn.isMyTurn,
        activeName: this.turn.activeName,
        activeId: this.turn.activeId,
        queuePos: this.turn.queuePos,
        queueLen: this.turn.queueLen,
        viewers: this.turn.viewers,
        joined: this.turn.joined,
        nickname: this.me.nickname,
        playerId: this.me.id,
        turnTTL: this.turn.turnTTL,
        messages: this.chat.messages,
      };
    }

    /** Send chat message */
    async sendChat(text) {
      await this.chat.send(text);
      await this.chat.fetch();
      if (this.onStatusChange) this.onStatusChange(this.getStatus());
    }

    /** Update nickname */
    setNickname(name) {
      this.me.setNickname(name);
      this.redis.exec("SET", "player:" + this.me.id + ":name", this.me.nickname, "EX", "3600");
    }

    /** Disconnect */
    async stop() {
      await this.turn.leave();
      this._stopPush();
      this._stopPull();
      clearInterval(this._pollTimer);
      clearInterval(this._chatTimer);
      clearInterval(this._heartTimer);
    }
  }

  /* Export */
  window.Multiplayer = Multiplayer;
})();
