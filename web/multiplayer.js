/**
 * multiplayer.js — Shared Arcade Pokemon Red
 *
 * Turns the single-player WASM emulator into a "Twitch Plays Pokemon"
 * shared cabinet. One game, many players, turn-based control with
 * live chat and spectator state sync.
 *
 * Backend: Railway WebSocket server.
 */
(function () {
  "use strict";

  const WS_URL = "wss://pokemon-arcade-server-production.up.railway.app/ws";
  const NICK_MAX = 16;

  /* ------------------------------------------------------------------ */
  /*  base64 ↔ ArrayBuffer helpers                                       */
  /* ------------------------------------------------------------------ */
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
      name = (name || "").trim().substring(0, NICK_MAX);
      this.nickname = name || Identity.randomNick();
      localStorage.setItem("mp-nick", this.nickname);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Main Controller                                                    */
  /* ------------------------------------------------------------------ */
  class Multiplayer {
    constructor() {
      this.ws = null;
      this.me = new Identity();
      this.emulator = null;
      this.turn = { joined: false, isMyTurn: false };
      this.status = { activeId: null, activeName: null, queueLen: 0, viewers: 0, turnTTL: 0 };
      this.chatMessages = [];

      this._intentionallyStopped = false;
      this._pingTimer = null;
      this._stateTimer = null;
      this._reconnectDelay = 1000;

      // Callbacks for player.js integration
      this.onStatusChange = null;
      this.onTurnStart = null;
      this.onTurnEnd = null;
      this.onChatUpdate = null;
    }

    /** Store emulator reference for state capture/restore */
    setEmulator(emu) {
      this.emulator = emu;
    }

    /** Update nickname */
    setNickname(name) {
      this.me.setNickname(name);
    }

    /** Connect and join the queue */
    async start() {
      this._intentionallyStopped = false;
      this.turn.joined = true;
      this._connect();
      // Wait for WS open (or timeout after 5s)
      await new Promise(function (resolve) {
        var self = this;
        if (self.ws && self.ws.readyState === WebSocket.OPEN) { resolve(); return; }
        var check = setInterval(function () {
          if (self.ws && self.ws.readyState === WebSocket.OPEN) {
            clearInterval(check); resolve();
          }
        }, 100);
        setTimeout(function () { clearInterval(check); resolve(); }, 5000);
      }.bind(this));
      this._send("join", { id: this.me.id, nickname: this.me.nickname });
    }

    /** Leave queue and close connection */
    async stop() {
      this._intentionallyStopped = true;
      this.turn.joined = false;
      this.turn.isMyTurn = false;
      this._stopStatePush();
      clearInterval(this._pingTimer);
      if (this.ws) {
        this._send("leave", {});
        this.ws.close();
        this.ws = null;
      }
    }

    /** Send a chat message */
    async sendChat(text) {
      this._send("chat", { text: text });
    }

    /** Called on every keypress while it is our turn */
    recordInput() {
      this._send("input", {});
    }

    /** Current status snapshot */
    getStatus() {
      return {
        isMyTurn: this.turn.isMyTurn,
        activeName: this.status.activeName,
        activeId: this.status.activeId,
        queueLen: this.status.queueLen,
        viewers: this.status.viewers,
        joined: this.turn.joined,
        nickname: this.me.nickname,
        playerId: this.me.id,
        turnTTL: this.status.turnTTL,
        messages: this.chatMessages,
      };
    }

    /* ---------------------------------------------------------------- */
    /*  Internal — WebSocket lifecycle                                   */
    /* ---------------------------------------------------------------- */
    _connect() {
      if (this._intentionallyStopped) return;
      var self = this;
      var ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = function () {
        self._reconnectDelay = 1000;
        if (self.turn.joined) {
          self._send("join", { id: self.me.id, nickname: self.me.nickname });
        }
        self._pingTimer = setInterval(function () { self._send("ping", {}); }, 25000);
      };

      ws.onmessage = function (event) {
        try { self._onMessage(JSON.parse(event.data)); } catch (_) {}
      };

      ws.onclose = function () {
        clearInterval(self._pingTimer);
        self._pingTimer = null;
        if (!self._intentionallyStopped) {
          setTimeout(function () { self._connect(); }, self._reconnectDelay);
          self._reconnectDelay = Math.min(self._reconnectDelay * 2, 30000);
        }
      };

      ws.onerror = function () { /* onclose handles reconnect */ };
    }

    _onMessage(msg) {
      switch (msg.type) {
        case "status":
          this.status = {
            activeId: msg.activeId,
            activeName: msg.activeName,
            queueLen: msg.queueLen,
            viewers: msg.viewers,
            turnTTL: msg.turnTTL,
          };
          if (this.onStatusChange) this.onStatusChange(this.getStatus());
          break;

        case "turn_granted": {
          var wasMyTurn = this.turn.isMyTurn;
          this.turn.isMyTurn = true;
          if (!wasMyTurn) {
            if (this.onTurnStart) this.onTurnStart();
            this._startStatePush();
          }
          break;
        }

        case "turn_revoked": {
          var hadTurn = this.turn.isMyTurn;
          this.turn.isMyTurn = false;
          this._stopStatePush();
          if (hadTurn) {
            if (this.emulator) {
              try {
                this._send("state_push", {
                  state: bufToB64(this.emulator.captureState()),
                  sram: bufToB64(this.emulator.captureExtRam()),
                });
              } catch (_) {}
            }
            if (this.onTurnEnd) this.onTurnEnd();
          }
          break;
        }

        case "chat_msg":
          this.chatMessages.push(msg.msg);
          if (this.chatMessages.length > 200) {
            this.chatMessages = this.chatMessages.slice(-200);
          }
          if (this.onChatUpdate) this.onChatUpdate(this.chatMessages);
          break;

        case "chat_history":
          this.chatMessages = msg.msgs || [];
          if (this.onChatUpdate) this.onChatUpdate(this.chatMessages);
          break;

        case "game_state":
          if (!this.turn.isMyTurn && this.emulator && msg.state) {
            try { this.emulator.loadState(b64ToBuf(msg.state)); } catch (_) {}
          }
          break;

        case "pong":
          break;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Internal — state push while active                              */
    /* ---------------------------------------------------------------- */
    _startStatePush() {
      this._stopStatePush();
      var self = this;
      this._stateTimer = setInterval(function () {
        if (!self.turn.isMyTurn || !self.emulator) return;
        try {
          self._send("state_push", {
            state: bufToB64(self.emulator.captureState()),
            sram: bufToB64(self.emulator.captureExtRam()),
          });
        } catch (_) {}
      }, 3000);
    }

    _stopStatePush() {
      if (this._stateTimer) {
        clearInterval(this._stateTimer);
        this._stateTimer = null;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  Internal — send helper                                          */
    /* ---------------------------------------------------------------- */
    _send(type, payload) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(Object.assign({ type: type }, payload)));
      }
    }
  }

  /* Export */
  window.Multiplayer = Multiplayer;
})();
