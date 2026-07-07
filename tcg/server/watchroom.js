// HOSTILE TAKEOVER — AI-vs-AI watch room.
//
// A human SPECTATOR (no seat) picks two factions and a match count, then watches
// two bots play their starter decks against each other. Both seats are bot-
// driven; the room auto-advances through N matches, alternating who goes first
// to cancel first-player bias, keeps a per-faction win tally, and records a full
// play log the spectator can download for balance analysis.
//
// Unlike the PvP Room this has no grace/rematch/emote/reconnect machinery — the
// spectator is a passive observer. Reuses the engine + BotController only.

import crypto from 'node:crypto';
import { createGame, applyAction, getSpectatorView } from '../shared/engine.js';
import { STARTER_DECKS } from '../shared/cards.js';
import { BotController } from './bot.js';

const TURN_MS = 90_000;          // safety net; fast bots never reach it
const BETWEEN_GAMES_MS = 2600;   // pause on the game-over screen before the next match
const ACTION_CAP_PER_GAME = 4000; // hard backstop against a wedged simulation
const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian'];

let nextId = 1;

export class WatchRoom {
  /**
   * cfg: { factionA, factionB, matches, speed, difficulty }
   */
  constructor(lobby, spectator, cfg) {
    this.id = `watch${nextId++}`;
    this.lobby = lobby;
    this.spectator = spectator;
    this.destroyed = false;

    this.state = null;
    this.turnTimer = null;
    this.turnDeadline = null;
    this.betweenTimer = null;
    this.bots = [];
    this.actionsThisGame = 0;

    this.factions = [cfg.factionA, cfg.factionB]; // fixed screen slots: [0]=bottom, [1]=top
    this.difficulty = cfg.difficulty === 'normal' ? 'normal' : 'hard';
    this.speed = clampSpeed(cfg.speed);
    this.matchesTarget = clampMatches(cfg.matches);

    this.matchIndex = 0;                 // 0-based, current match
    this.tally = { [cfg.factionA]: 0, [cfg.factionB]: 0 }; // by faction (mirror-safe: same key just accumulates)
    this.draws = 0;
    this.games = [];                     // completed match records for the log
    this.currentActions = null;          // action log of the in-progress match

    spectator.watchRoom = this;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.destroyed) return;
    this.beginMatch();
  }

  beginMatch() {
    if (this.destroyed) return;
    this.clearTurnTimer();
    this.actionsThisGame = 0;
    this.currentActions = [];

    // Alternate who goes first each match so neither faction keeps the
    // first-player edge; factions stay pinned to their screen slots.
    const firstSeat = this.matchIndex % 2;
    const seed = crypto.randomInt(0, 2147483647);
    const decks = this.factions.map((f) => cloneDeck(f));
    const names = this.factions.map((f) => STARTER_DECKS[f].name);

    try {
      this.state = createGame({ decks, names, seed, firstPlayer: firstSeat });
    } catch (err) {
      console.error(`[${this.id}] createGame failed:`, err);
      this.sendSpectator({ t: 'error', msg: 'Failed to start simulation' });
      this.destroy();
      return;
    }

    this.matchMeta = { index: this.matchIndex, seed, firstSeat, firstFaction: this.factions[firstSeat] };

    // one bot per seat
    for (const b of this.bots) b.stop();
    this.bots = [0, 1].map((seat) => new BotController(this, seat, this.difficulty, this.speed));

    this.armTurnTimer();
    this.sendSpectator({
      t: 'watchStart',
      view: this.safeSpectatorView(),
      match: this.matchIndex + 1,
      matches: this.matchesTarget,
      factions: this.factions,
      firstSeat,
      tally: this.publicTally(),
    });
    this.pokeBots();
  }

  // ------------------------------------------------------------- turn timer

  armTurnTimer() {
    this.clearTurnTimer();
    this.turnDeadline = Date.now() + TURN_MS;
    this.turnTimer = setTimeout(() => this.onTurnExpired(), TURN_MS);
  }

  clearTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.turnDeadline = null;
  }

  onTurnExpired() {
    this.turnTimer = null;
    if (this.destroyed || !this.state || this.state.over) return;
    // A stalled bot: force the active seat to end its turn.
    this.applyBotAction(this.state.activePlayer, { type: 'endTurn' });
  }

  // ------------------------------------------------------------- bot driving

  pokeBots() {
    for (const b of this.bots) b.onStateChanged();
  }

  /** BotController entry point (mirrors Room.applyBotAction). */
  applyBotAction(seat, action) {
    if (this.destroyed || !this.state || this.state.over) return false;
    const prevActive = this.state.activePlayer;

    let result;
    try {
      result = applyAction(this.state, seat, action);
    } catch (err) {
      console.error(`[${this.id}] applyAction threw:`, err);
      result = { ok: false };
    }
    if (!result || !result.ok) return false;

    this.actionsThisGame++;
    const events = Array.isArray(result.events) ? result.events : [];
    this.recordAction(seat, action, events);

    const over = !!this.state.over;
    if (over) {
      this.clearTurnTimer();
    } else if (this.state.activePlayer !== prevActive || events.some((e) => e && e.e === 'turnStart')) {
      this.armTurnTimer();
    }

    this.sendSpectator({
      t: 'watchState',
      view: this.safeSpectatorView(),
      events,
      turnDeadline: this.turnDeadline,
    });

    if (over) {
      this.onMatchOver(events);
    } else if (this.actionsThisGame >= ACTION_CAP_PER_GAME) {
      // Wedged simulation — abandon this match as a draw rather than spin.
      console.error(`[${this.id}] action cap hit; abandoning match ${this.matchIndex + 1}`);
      this.onMatchOver([], { aborted: true });
    } else {
      this.pokeBots();
    }
    return true;
  }

  // --------------------------------------------------------- match completion

  onMatchOver(events, { aborted = false } = {}) {
    for (const b of this.bots) b.stop();
    this.clearTurnTimer();

    const winnerSeat = aborted ? null : this.state.winner;
    const winnerFaction =
      winnerSeat === 0 || winnerSeat === 1 ? this.factions[winnerSeat] : null;
    const overEvent = events.find((e) => e && e.e === 'gameOver');
    const reason = aborted ? 'aborted' : (overEvent && overEvent.reason) || 'takeover';

    if (winnerFaction) this.tally[winnerFaction] += 1;
    else this.draws += 1;

    this.games.push({
      index: this.matchIndex + 1,
      seed: this.matchMeta.seed,
      firstFaction: this.matchMeta.firstFaction,
      slots: { bottom: this.factions[0], top: this.factions[1] },
      winnerSeat,
      winnerFaction,
      reason,
      turns: this.state ? this.state.turn : 0,
      finalIntegrity: this.state ? this.state.players.map((p) => p.integrity) : [null, null],
      actions: this.currentActions,
    });

    const done = this.matchIndex + 1 >= this.matchesTarget;
    this.sendSpectator({
      t: 'watchGameOver',
      view: this.safeSpectatorView(),
      winnerSeat,
      winnerFaction,
      reason,
      match: this.matchIndex + 1,
      matches: this.matchesTarget,
      tally: this.publicTally(),
      done,
    });

    if (done) {
      this.sendSpectator({ t: 'watchComplete', log: this.buildLog(), tally: this.publicTally() });
      return; // room stays alive so the spectator can still download / review
    }

    this.matchIndex += 1;
    this.betweenTimer = setTimeout(() => {
      this.betweenTimer = null;
      this.beginMatch();
    }, BETWEEN_GAMES_MS);
  }

  // ---------------------------------------------------------------- play log

  recordAction(seat, action, events) {
    if (!this.currentActions) return;
    const p0 = this.state.players[0];
    const p1 = this.state.players[1];
    this.currentActions.push({
      turn: this.state.turn,
      seat,
      faction: this.factions[seat],
      action: compactAction(action),
      events: events.map(compactEvent).filter(Boolean),
      integrity: [p0.integrity, p1.integrity],
      capital: [p0.capital, p1.capital],
      board: [p0.board.length, p1.board.length],
      hand: [p0.hand.length, p1.hand.length],
    });
  }

  buildLog() {
    return {
      game: 'HOSTILE TAKEOVER',
      kind: 'ai-vs-ai-playtest',
      factions: { bottom: this.factions[0], top: this.factions[1] },
      difficulty: this.difficulty,
      matchesRequested: this.matchesTarget,
      matchesPlayed: this.games.length,
      tally: this.publicTally(),
      games: this.games,
    };
  }

  publicTally() {
    return {
      [this.factions[0]]: this.tally[this.factions[0]] || 0,
      [this.factions[1]]: this.tally[this.factions[1]] || 0,
      draws: this.draws,
      // explicit A/B too, so a mirror match (same faction both sides) is unambiguous
      a: { faction: this.factions[0] },
      b: { faction: this.factions[1] },
    };
  }

  // ------------------------------------------------------------ spectator I/O

  safeSpectatorView() {
    try { return getSpectatorView(this.state); } catch { return null; }
  }

  sendSpectator(msg) {
    if (this.spectator) this.lobby.sendTo(this.spectator, msg);
  }

  setSpeed(speed) {
    this.speed = clampSpeed(speed);
    for (const b of this.bots) b.setSpeed(this.speed);
  }

  // ---------------------------------------------------------------- teardown

  handleSpectatorGone() {
    // Nobody left to watch — reap the simulation.
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTurnTimer();
    if (this.betweenTimer) { clearTimeout(this.betweenTimer); this.betweenTimer = null; }
    for (const b of this.bots) b.stop();
    this.bots = [];
    if (this.spectator && this.spectator.watchRoom === this) this.spectator.watchRoom = null;
    this.spectator = null;
    this.lobby.removeWatchRoom(this);
  }
}

// ------------------------------------------------------------------ helpers

function clampMatches(n) {
  const v = Number.isFinite(n) ? Math.floor(n) : 5;
  return Math.max(1, Math.min(50, v));
}

function clampSpeed(s) {
  const v = Number.isFinite(s) ? s : 1;
  return Math.max(0.02, Math.min(2, v));
}

function cloneDeck(faction) {
  const d = STARTER_DECKS[faction];
  return { faction: d.faction, cards: [...d.cards] };
}

export function isFaction(f) {
  return FACTIONS.includes(f);
}

// Compact an action to the fields worth analyzing.
function compactAction(a) {
  if (!a || typeof a !== 'object') return { type: 'unknown' };
  const out = { type: a.type };
  if (a.handIndex !== undefined) out.handIndex = a.handIndex;
  if (a.target != null) out.target = a.target;
  if (a.position != null) out.position = a.position;
  if (a.attackerId) out.attackerId = a.attackerId;
  if (a.targetId) out.targetId = a.targetId;
  if (a.unitId) out.unitId = a.unitId;
  if (a.contractId) out.contractId = a.contractId;
  return out;
}

// Keep the salient fields of an event so the log stays analyzable but compact.
const EVENT_FIELDS = ['e', 'player', 'cardId', 'unitId', 'targetId', 'attackerId',
  'amount', 'gain', 'damage', 'dead', 'winner', 'reason', 'turns', 'keyword'];
function compactEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const k of EVENT_FIELDS) if (e[k] !== undefined) out[k] = e[k];
  return out.e ? out : null;
}
