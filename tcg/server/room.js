// HOSTILE TAKEOVER — game room: holds one engine state, applies actions,
// broadcasts per-player redacted views, runs the 90s turn timer, handles
// disconnect grace / desertion, rematch, emotes, and the bot controller.

import crypto from 'node:crypto';
import { createGame, applyAction, getView, redactEvents } from '../shared/engine.js';
import { BotController } from './bot.js';

const TURN_MS = 90_000;
const GRACE_MS = 30_000;
const EMOTE_COOLDOWN_MS = 3_000;
const EMOTES = new Set(['greetings', 'wellplayed', 'threaten', 'oops', 'thanks']);

let nextRoomId = 1;

/**
 * Validate + normalize a client-supplied action into a clean object containing
 * only the fields the contract defines. Returns null if malformed.
 */
export function cleanAction(a) {
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return null;
  switch (a.type) {
    case 'endTurn':
    case 'concede':
      return { type: a.type };
    case 'playCard': {
      if (!Number.isInteger(a.handIndex) || a.handIndex < 0 || a.handIndex > 9) return null;
      const target =
        typeof a.target === 'string' && a.target.length >= 1 && a.target.length <= 16
          ? a.target
          : null;
      const position =
        Number.isInteger(a.position) && a.position >= 0 && a.position <= 6 ? a.position : null;
      return { type: 'playCard', handIndex: a.handIndex, target, position };
    }
    case 'attack': {
      if (typeof a.attackerId !== 'string' || a.attackerId.length > 16) return null;
      if (typeof a.targetId !== 'string' || a.targetId.length > 16) return null;
      return { type: 'attack', attackerId: a.attackerId, targetId: a.targetId };
    }
    case 'heroPower': {
      const target =
        typeof a.target === 'string' && a.target.length >= 1 && a.target.length <= 16
          ? a.target
          : null;
      return { type: 'heroPower', target };
    }
    default:
      return null;
  }
}

/**
 * Room seats are ordered by player index: seat 0 goes first. The lobby decides
 * the initial coin flip; rematches swap seat order.
 *
 * seatSpec: { pid, name, deck, client|null, isBot, difficulty? }
 */
export class Room {
  constructor(lobby, seatSpecs) {
    this.id = `room${nextRoomId++}`;
    this.lobby = lobby;
    this.destroyed = false;
    this.state = null;
    this.turnDeadline = null;
    this.turnTimer = null;
    this.bot = null;
    this.lastGameOver = null; // { winner, reason } of the most recent finished game

    this.seats = seatSpecs.map((s) => ({
      pid: s.pid,
      name: s.name,
      deck: s.deck,
      client: s.client || null,
      isBot: !!s.isBot,
      difficulty: s.difficulty || null,
      wantsRematch: false,
      graceTimer: null,
      lastEmoteAt: 0,
      left: false,
    }));
    for (const seat of this.seats) {
      if (seat.client) seat.client.room = this;
    }
  }

  // ---------------------------------------------------------------- helpers

  seatIndexOf(pid) {
    return this.seats.findIndex((s) => s.pid === pid);
  }

  otherIndex(i) {
    return i === 0 ? 1 : 0;
  }

  send(i, msg) {
    const seat = this.seats[i];
    if (seat && seat.client) this.lobby.sendTo(seat.client, msg);
  }

  safeView(i) {
    try {
      return getView(this.state, i);
    } catch {
      return null;
    }
  }

  safeRedact(events, i) {
    try {
      return redactEvents(events, i);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------- game start

  start() {
    if (this.destroyed) return;
    this.lastGameOver = null;
    const seed = crypto.randomInt(0, 2147483647); // crypto-random engine seed
    try {
      this.state = createGame({
        decks: this.seats.map((s) => s.deck),
        names: this.seats.map((s) => s.name),
        seed,
      });
    } catch (err) {
      console.error(`[${this.id}] createGame failed:`, err);
      for (let i = 0; i < 2; i++) this.send(i, { t: 'error', msg: 'Failed to start game' });
      this.destroy();
      return;
    }

    const botSeat = this.seats.findIndex((s) => s.isBot);
    if (botSeat !== -1) {
      this.bot = new BotController(this, botSeat, this.seats[botSeat].difficulty);
    }

    this.armTurnTimer();
    for (let i = 0; i < 2; i++) this.sendGameStart(i);
    if (this.bot) this.bot.onStateChanged();
  }

  sendGameStart(i) {
    const opp = this.seats[this.otherIndex(i)];
    this.send(i, {
      t: 'gameStart',
      you: i,
      view: this.safeView(i),
      opponent: { name: opp.name, faction: opp.deck && opp.deck.faction },
      turnDeadline: this.turnDeadline,
    });
  }

  // ------------------------------------------------------------- turn timer

  armTurnTimer() {
    this.clearTurnTimer();
    this.turnDeadline = Date.now() + TURN_MS;
    this.turnTimer = setTimeout(() => this.onTurnExpired(), TURN_MS);
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  onTurnExpired() {
    this.turnTimer = null;
    if (this.destroyed || !this.state || this.state.over) return;
    const idx = this.state.activePlayer;
    const applied = this.applyAndBroadcast(idx, { type: 'endTurn' }, { forced: true });
    if (!applied && !this.state.over) {
      // endTurn should never fail for the active player; if the engine is
      // wedged, end the game rather than leave a zombie room.
      console.error(`[${this.id}] forced endTurn rejected — conceding player ${idx}`);
      this.applyAndBroadcast(idx, { type: 'concede' }, { forced: true });
      if (!this.state.over) this.destroy();
    }
  }

  // ------------------------------------------------------------ action flow

  /** Entry point for human actions (from lobby message dispatch). */
  handleAction(pid, rawAction) {
    const i = this.seatIndexOf(pid);
    if (i === -1) return;
    if (!this.state || this.state.over) {
      this.send(i, { t: 'actionError', msg: 'Game is over' });
      return;
    }
    const action = cleanAction(rawAction);
    if (!action) {
      this.send(i, { t: 'actionError', msg: 'Malformed action' });
      return;
    }
    this.applyAndBroadcast(i, action);
  }

  /** Entry point for the bot controller. Returns true if the action applied. */
  applyBotAction(i, action) {
    if (this.destroyed || !this.state || this.state.over) return false;
    return this.applyAndBroadcast(i, action);
  }

  /**
   * Apply one action for player i. On success broadcast per-player state to
   * both seats (and gameOver if terminal); on rejection send actionError to a
   * human actor only. Returns true if the engine accepted the action.
   */
  applyAndBroadcast(i, action, { forced = false } = {}) {
    if (this.destroyed || !this.state) return false;
    const prevActive = this.state.activePlayer;

    let result;
    try {
      result = applyAction(this.state, i, action);
    } catch (err) {
      console.error(`[${this.id}] applyAction threw:`, err);
      result = { ok: false, error: 'Internal engine error' };
    }

    if (!result || !result.ok) {
      if (!forced && !this.seats[i].isBot) {
        this.send(i, { t: 'actionError', msg: (result && result.error) || 'Illegal action' });
      }
      return false;
    }

    const events = Array.isArray(result.events) ? result.events : [];
    const over = !!this.state.over;

    if (over) {
      this.clearTurnTimer();
      this.turnDeadline = null;
    } else if (this.state.activePlayer !== prevActive || events.some((e) => e && e.e === 'turnStart')) {
      this.armTurnTimer();
    }

    for (let p = 0; p < 2; p++) {
      this.send(p, {
        t: 'state',
        view: this.safeView(p),
        events: this.safeRedact(events, p),
        turnDeadline: this.turnDeadline,
      });
    }

    if (over) {
      const overEvent = events.find((e) => e && e.e === 'gameOver');
      const reason = (overEvent && overEvent.reason) || 'takeover';
      this.finishGame(this.state.winner, reason);
    } else if (this.bot) {
      this.bot.onStateChanged();
    }
    return true;
  }

  /** Terminal broadcast + cleanup (rematch remains possible while both stay). */
  finishGame(winner, reason) {
    this.clearTurnTimer();
    this.turnDeadline = null;
    this.lastGameOver = { winner, reason };
    if (this.bot) this.bot.stop();
    for (let p = 0; p < 2; p++) {
      this.send(p, { t: 'gameOver', winner, reason, view: this.safeView(p) });
      // Post-game, disconnect grace no longer applies.
      this.clearGrace(p);
    }
    // If everyone already walked away, reap the room.
    if (this.seats.every((s) => s.isBot || !s.client)) this.destroy();
  }

  // ----------------------------------------------------------------- emotes

  handleEmote(pid, id) {
    const i = this.seatIndexOf(pid);
    if (i === -1) return;
    if (typeof id !== 'string' || !EMOTES.has(id)) return;
    const now = Date.now();
    const seat = this.seats[i];
    if (now - seat.lastEmoteAt < EMOTE_COOLDOWN_MS) return; // silently drop
    seat.lastEmoteAt = now;
    for (let p = 0; p < 2; p++) this.send(p, { t: 'emote', from: i, id });
  }

  // ---------------------------------------------------------------- rematch

  handleRematch(pid) {
    const i = this.seatIndexOf(pid);
    if (i === -1) return;
    if (!this.state || !this.state.over || this.destroyed) {
      this.send(i, { t: 'error', msg: 'No finished game to rematch' });
      return;
    }
    const other = this.seats[this.otherIndex(i)];
    if (!other.isBot && (!other.client || other.left)) {
      this.send(i, { t: 'error', msg: 'Opponent has left' });
      return;
    }
    this.seats[i].wantsRematch = true;
    if (other.isBot) other.wantsRematch = true;
    else if (!other.wantsRematch) this.send(this.otherIndex(i), { t: 'rematchOffered' });

    if (this.seats.every((s) => s.wantsRematch)) this.startRematch();
  }

  startRematch() {
    for (const s of this.seats) s.wantsRematch = false;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    this.seats.reverse(); // swap who goes first
    this.start();
  }

  // ------------------------------------------------- leave / concede / drop

  handleConcede(pid) {
    const i = this.seatIndexOf(pid);
    if (i === -1 || !this.state || this.state.over) return;
    this.applyAndBroadcast(i, { type: 'concede' });
  }

  handleLeave(pid) {
    const i = this.seatIndexOf(pid);
    if (i === -1) return;
    if (this.state && !this.state.over && !this.destroyed) {
      // Leaving mid-game is a concession.
      this.applyAndBroadcast(i, { type: 'concede' });
    }
    this.detachSeat(i);
  }

  detachSeat(i) {
    const seat = this.seats[i];
    seat.left = true;
    this.clearGrace(i);
    if (seat.client) {
      if (seat.client.room === this) seat.client.room = null;
      seat.client = null;
    }
    if (this.seats.every((s) => s.isBot || !s.client)) this.destroy();
  }

  // --------------------------------------------------- disconnect/reconnect

  clearGrace(i) {
    const seat = this.seats[i];
    if (seat.graceTimer) {
      clearTimeout(seat.graceTimer);
      seat.graceTimer = null;
    }
  }

  /** Socket died. Mid-game: 30s reconnect grace, then desertion. */
  handleDisconnect(pid) {
    const i = this.seatIndexOf(pid);
    if (i === -1 || this.destroyed) return;
    const seat = this.seats[i];
    seat.client = null;

    if (!this.state || this.state.over) {
      // Post-game (or pre-start failure): a disconnect is a permanent leave.
      this.detachSeat(i);
      return;
    }

    const other = this.seats[this.otherIndex(i)];
    if (!other.isBot && !other.client) {
      // Both humans gone mid-game: nobody to notify, nobody to reward.
      this.destroy();
      return;
    }

    this.send(this.otherIndex(i), { t: 'opponentLeft' });
    this.clearGrace(i);
    seat.graceTimer = setTimeout(() => {
      seat.graceTimer = null;
      this.handleDesertion(i);
    }, GRACE_MS);
  }

  handleDesertion(i) {
    if (this.destroyed || !this.state || this.state.over) return;
    // Settle the engine state via concede, but report the reason as desertion.
    this.clearTurnTimer();
    this.turnDeadline = null;
    if (this.bot) this.bot.stop();
    let winner = this.otherIndex(i);
    try {
      applyAction(this.state, i, { type: 'concede' });
      if (this.state.over && this.state.winner !== null && this.state.winner !== undefined) {
        winner = this.state.winner;
      }
    } catch {
      /* engine refused — server-authoritative outcome stands */
    }
    this.send(winner, { t: 'gameOver', winner, reason: 'desertion', view: this.safeView(winner) });
    this.destroy();
  }

  /** A socket with this seat's pid came back within the grace window. */
  handleReconnect(pid, client) {
    const i = this.seatIndexOf(pid);
    if (i === -1 || this.destroyed) return false;
    const seat = this.seats[i];
    if (seat.left || seat.client) return false;
    this.clearGrace(i);
    seat.client = client;
    client.room = this;
    this.sendGameStart(i);
    if (this.state && this.state.over) {
      const last = this.lastGameOver || { winner: this.state.winner, reason: 'takeover' };
      this.send(i, { t: 'gameOver', winner: last.winner, reason: last.reason, view: this.safeView(i) });
    } else {
      // Refresh the waiting opponent's UI (it saw opponentLeft).
      const o = this.otherIndex(i);
      this.send(o, {
        t: 'state',
        view: this.safeView(o),
        events: [],
        turnDeadline: this.turnDeadline,
      });
    }
    return true;
  }

  // ---------------------------------------------------------------- destroy

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTurnTimer();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    for (let i = 0; i < this.seats.length; i++) {
      this.clearGrace(i);
      const seat = this.seats[i];
      if (seat.client && seat.client.room === this) seat.client.room = null;
      seat.client = null;
    }
    this.lobby.removeRoom(this);
  }
}
