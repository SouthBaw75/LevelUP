// HOSTILE TAKEOVER — lobby: WebSocket connection lifecycle, hello handshake,
// matchmaking queue, private lobbies, playBot, message dispatch, rate limiting,
// heartbeat, and reconnect routing. One Lobby instance per server process.

import crypto from 'node:crypto';
import { validateDeck } from '../shared/engine.js';
import { STARTER_DECKS } from '../shared/cards.js';
import { Room } from './room.js';
import { BOT_NAMES } from './bot.js';
import { WatchRoom, isFaction } from './watchroom.js';

const RATE_LIMIT_MSGS_PER_SEC = 20;
const PRIVATE_LOBBY_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
// Unambiguous alphabet: no I/L/O/0/1.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Anonymous CEO';
  const cleaned = raw
    // strip control chars, zero-width/bidi marks, BOM
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
    .trim();
  return cleaned.length >= 1 ? cleaned : 'Anonymous CEO';
}

export class Lobby {
  constructor() {
    /** pid -> client record */
    this.clients = new Map();
    /** FIFO matchmaking queue of pids */
    this.queue = [];
    /** code -> { hostPid, timer, createdAt } */
    this.privates = new Map();
    /** live Room set */
    this.rooms = new Set();
    /** live WatchRoom set (AI-vs-AI spectator sims) */
    this.watchRooms = new Set();
    this.heartbeat = setInterval(() => this.reapDeadSockets(), HEARTBEAT_INTERVAL_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  // ------------------------------------------------------------------ stats

  counts() {
    let online = 0;
    for (const c of this.clients.values()) if (c.helloed) online++;
    return { online, inQueue: this.queue.length, activeGames: this.rooms.size };
  }

  removeRoom(room) {
    this.rooms.delete(room);
  }

  removeWatchRoom(room) {
    this.watchRooms.delete(room);
  }

  // ------------------------------------------------------------- connection

  /** New WebSocket. pidHint comes from the ?pid= query param (may be null). */
  addSocket(ws, pidHint) {
    const client = {
      ws,
      pid: null,
      pidHint: typeof pidHint === 'string' && PID_RE.test(pidHint) ? pidHint : null,
      name: null,
      helloed: false,
      deck: null,
      room: null,
      watchRoom: null,
      privateCode: null,
      alive: true,
      rl: { windowStart: 0, count: 0 },
    };

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      try {
        this.handleMessage(client, data, isBinary);
      } catch (err) {
        console.error('[lobby] message handler error:', err);
        this.sendTo(client, { t: 'error', msg: 'Internal server error' });
      }
    });
    ws.on('close', () => this.handleClose(client));
    ws.on('error', () => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });
  }

  sendTo(client, msg) {
    if (!client || !client.ws || client.ws.readyState !== 1 /* OPEN */) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      /* socket died mid-send; close handler cleans up */
    }
  }

  sendError(client, msg) {
    this.sendTo(client, { t: 'error', msg });
  }

  reapDeadSockets() {
    for (const client of this.clients.values()) {
      if (!client.alive) {
        try {
          client.ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  // --------------------------------------------------------------- dispatch

  handleMessage(client, data, isBinary) {
    // Rate limit: > 20 msgs/sec → close.
    const now = Date.now();
    if (now - client.rl.windowStart >= 1000) {
      client.rl.windowStart = now;
      client.rl.count = 0;
    }
    if (++client.rl.count > RATE_LIMIT_MSGS_PER_SEC) {
      try {
        client.ws.close(1008, 'rate limit exceeded');
      } catch {
        /* ignore */
      }
      return;
    }

    if (isBinary) {
      this.sendError(client, 'Binary messages not supported');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.sendError(client, 'Invalid JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
      this.sendError(client, 'Malformed message');
      return;
    }

    if (msg.t === 'ping') {
      this.sendTo(client, { t: 'pong' });
      return;
    }
    if (msg.t === 'hello') {
      this.handleHello(client, msg);
      return;
    }
    if (!client.helloed) {
      this.sendError(client, 'Send hello first');
      return;
    }

    switch (msg.t) {
      case 'queue':
        this.handleQueue(client, msg.deck);
        break;
      case 'cancelQueue':
        this.removeFromQueue(client.pid);
        this.sendTo(client, { t: 'queueCanceled' });
        break;
      case 'createPrivate':
        this.handleCreatePrivate(client, msg.deck);
        break;
      case 'joinPrivate':
        this.handleJoinPrivate(client, msg.code, msg.deck);
        break;
      case 'cancelPrivate':
        this.cancelPrivate(client);
        break;
      case 'playBot':
        this.handlePlayBot(client, msg.deck, msg.difficulty);
        break;
      case 'watchBots':
        this.handleWatchBots(client, msg);
        break;
      case 'watchSpeed':
        if (client.watchRoom) client.watchRoom.setSpeed(Number(msg.speed));
        break;
      case 'watchStop':
        if (client.watchRoom) client.watchRoom.destroy();
        break;
      case 'action':
        if (client.room) client.room.handleAction(client.pid, msg.action);
        else this.sendError(client, 'Not in a game');
        break;
      case 'concede':
        if (client.room) client.room.handleConcede(client.pid);
        else this.sendError(client, 'Not in a game');
        break;
      case 'emote':
        if (client.room) client.room.handleEmote(client.pid, msg.id);
        break;
      case 'rematch':
        if (client.room) client.room.handleRematch(client.pid);
        else this.sendError(client, 'Not in a game');
        break;
      case 'leaveGame':
        if (client.room) client.room.handleLeave(client.pid);
        break;
      default:
        this.sendError(client, `Unknown message type: ${msg.t.slice(0, 32)}`);
    }
  }

  // ------------------------------------------------------------------ hello

  handleHello(client, msg) {
    if (client.helloed) {
      this.sendTo(client, { t: 'helloOk', playerId: client.pid, online: this.counts().online });
      return;
    }
    let pid = client.pidHint;
    if (pid && this.clients.has(pid)) {
      // Same identity connected twice (new tab / stale socket): the newest
      // socket wins; the old one is closed and cleaned up like a disconnect.
      const old = this.clients.get(pid);
      this.clients.delete(pid);
      this.handleClose(old); // full disconnect cleanup (queue, private lobby, room grace)
      old.pid = null; // its eventual 'close' event must not touch the new record
      try {
        old.ws.close(4000, 'superseded by new connection');
      } catch {
        /* ignore */
      }
    }
    if (!pid) pid = crypto.randomUUID();

    client.pid = pid;
    client.name = sanitizeName(msg.name);
    client.helloed = true;
    this.clients.set(pid, client);
    this.sendTo(client, { t: 'helloOk', playerId: pid, online: this.counts().online });

    // Reconnect: if a running game is waiting on this pid, reattach.
    for (const room of this.rooms) {
      if (room.seatIndexOf(pid) !== -1 && room.handleReconnect(pid, client)) break;
    }
    // Reconnect: if a watch-mode simulation is waiting on this pid (grace
    // window after a spectator disconnect), reattach and resume pushing state.
    for (const wr of this.watchRooms) {
      if (wr.handleReconnect(client)) break;
    }
  }

  // ------------------------------------------------------------ deck checks

  checkDeck(client, deck) {
    if (!client.helloed) {
      this.sendError(client, 'Send hello first');
      return null;
    }
    if (client.room) {
      this.sendError(client, 'Already in a game');
      return null;
    }
    if (this.queue.includes(client.pid)) {
      this.sendError(client, 'Already in queue');
      return null;
    }
    if (client.privateCode) {
      this.sendError(client, 'Cancel your private lobby first');
      return null;
    }
    if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
      this.sendError(client, 'Missing deck');
      return null;
    }
    let result;
    try {
      result = validateDeck(deck);
    } catch (err) {
      console.error('[lobby] validateDeck threw:', err);
      result = { ok: false, error: 'Deck validation failed' };
    }
    if (!result || !result.ok) {
      this.sendError(client, (result && result.error) || 'Invalid deck');
      return null;
    }
    // Keep only the contract fields.
    return { faction: deck.faction, cards: Array.isArray(deck.cards) ? [...deck.cards] : [] };
  }

  // ------------------------------------------------------------ matchmaking

  handleQueue(client, deck) {
    const clean = this.checkDeck(client, deck);
    if (!clean) return;
    client.deck = clean;
    this.queue.push(client.pid);
    this.sendTo(client, { t: 'queued' });
    this.tryMatch();
  }

  removeFromQueue(pid) {
    const i = this.queue.indexOf(pid);
    if (i !== -1) this.queue.splice(i, 1);
  }

  tryMatch() {
    while (this.queue.length >= 2) {
      const a = this.clients.get(this.queue.shift());
      const b = this.clients.get(this.queue.shift());
      if (!a || !a.helloed || a.room) {
        if (b) this.queue.unshift(b.pid);
        continue;
      }
      if (!b || !b.helloed || b.room) {
        this.queue.unshift(a.pid);
        continue;
      }
      this.startPvpRoom(a, b);
    }
  }

  startPvpRoom(a, b) {
    // Coin flip who is player 0 (goes first).
    const [first, second] = crypto.randomInt(0, 2) === 0 ? [a, b] : [b, a];
    const room = new Room(this, [
      { pid: first.pid, name: first.name, deck: first.deck, client: first },
      { pid: second.pid, name: second.name, deck: second.deck, client: second },
    ]);
    this.rooms.add(room);
    room.start();
  }

  // -------------------------------------------------------- private lobbies

  generateCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
      if (!this.privates.has(code)) return code;
    }
    return null;
  }

  handleCreatePrivate(client, deck) {
    const clean = this.checkDeck(client, deck);
    if (!clean) return;
    const code = this.generateCode();
    if (!code) {
      this.sendError(client, 'No lobby codes available, try again');
      return;
    }
    client.deck = clean;
    client.privateCode = code;
    const timer = setTimeout(() => {
      const entry = this.privates.get(code);
      if (!entry) return;
      this.privates.delete(code);
      const host = this.clients.get(entry.hostPid);
      if (host && host.privateCode === code) {
        host.privateCode = null;
        this.sendError(host, 'Private lobby expired');
      }
    }, PRIVATE_LOBBY_TTL_MS);
    if (timer.unref) timer.unref();
    this.privates.set(code, { hostPid: client.pid, timer, createdAt: Date.now() });
    this.sendTo(client, { t: 'privateCreated', code });
  }

  cancelPrivate(client) {
    if (!client.privateCode) return;
    const entry = this.privates.get(client.privateCode);
    if (entry && entry.hostPid === client.pid) {
      clearTimeout(entry.timer);
      this.privates.delete(client.privateCode);
    }
    client.privateCode = null;
  }

  handleJoinPrivate(client, code, deck) {
    const clean = this.checkDeck(client, deck);
    if (!clean) return;
    const normalized = typeof code === 'string' ? code.trim().toUpperCase().slice(0, 8) : '';
    const entry = this.privates.get(normalized);
    if (!entry) {
      this.sendError(client, 'Lobby code not found or expired');
      return;
    }
    if (entry.hostPid === client.pid) {
      this.sendError(client, 'You cannot join your own lobby');
      return;
    }
    const host = this.clients.get(entry.hostPid);
    if (!host || !host.helloed || host.room) {
      clearTimeout(entry.timer);
      this.privates.delete(normalized);
      this.sendError(client, 'Lobby host is no longer available');
      return;
    }
    clearTimeout(entry.timer);
    this.privates.delete(normalized);
    host.privateCode = null;
    client.deck = clean;
    this.startPvpRoom(host, client);
  }

  // -------------------------------------------------------------- bot games

  handlePlayBot(client, deck, difficulty) {
    const clean = this.checkDeck(client, deck);
    if (!clean) return;
    const level = difficulty === 'hard' ? 'hard' : 'normal';

    let botDeck;
    try {
      const keys = Object.keys(STARTER_DECKS);
      const pick = STARTER_DECKS[keys[crypto.randomInt(0, keys.length)]];
      botDeck = { faction: pick.faction, cards: [...pick.cards] };
    } catch (err) {
      console.error('[lobby] failed to build bot deck:', err);
      this.sendError(client, 'Bot is unavailable');
      return;
    }

    client.deck = clean;
    const human = { pid: client.pid, name: client.name, deck: clean, client };
    const bot = {
      pid: `bot-${crypto.randomUUID()}`,
      name: BOT_NAMES[level],
      deck: botDeck,
      client: null,
      isBot: true,
      difficulty: level,
    };
    const seats = crypto.randomInt(0, 2) === 0 ? [human, bot] : [bot, human];
    const room = new Room(this, seats);
    this.rooms.add(room);
    room.start();
  }

  // ------------------------------------------------------ AI-vs-AI watch mode

  handleWatchBots(client, msg) {
    if (client.room || client.watchRoom) {
      this.sendError(client, 'Already in a game');
      return;
    }
    const factionA = msg.factionA;
    const factionB = msg.factionB;
    if (!isFaction(factionA) || !isFaction(factionB)) {
      this.sendError(client, 'Pick two valid factions');
      return;
    }
    const room = new WatchRoom(this, client, {
      factionA,
      factionB,
      matches: Number(msg.matches),
      speed: Number(msg.speed),
      difficulty: msg.difficulty === 'normal' ? 'normal' : 'hard',
    });
    this.watchRooms.add(room);
    room.start();
  }

  // ------------------------------------------------------------- disconnect

  handleClose(client) {
    if (client.pid && this.clients.get(client.pid) === client) {
      this.clients.delete(client.pid);
    }
    if (client.pid) this.removeFromQueue(client.pid);
    this.cancelPrivate(client);
    if (client.room) {
      const room = client.room;
      client.room = null;
      room.handleDisconnect(client.pid);
    }
    if (client.watchRoom) {
      // A watch spectator dropped — the simulation keeps running; give it a
      // reconnect grace (see WatchRoom.handleSpectatorGone) rather than
      // tearing the whole run down over a network blip.
      const wr = client.watchRoom;
      client.watchRoom = null;
      wr.handleSpectatorGone();
    }
    client.helloed = false;
  }

  // ---------------------------------------------------------------- teardown

  shutdown() {
    clearInterval(this.heartbeat);
    for (const room of [...this.rooms]) room.destroy();
    for (const room of [...this.watchRooms]) room.destroy();
    for (const entry of this.privates.values()) clearTimeout(entry.timer);
    this.privates.clear();
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
  }
}
