// HOSTILE TAKEOVER — bot opponent ("normal" | "hard").
//
// The bot lives inside a Room and has no socket. On each of its turns it loops:
//   1. legalActions(state, botIndex)
//   2. score every candidate by applying it to a cloneState and evaluating the
//      resulting position (lethal detection, material, integrity, card advantage)
//   3. hard  → pick the best;  normal → noisy pick among the top 3
//   4. apply through the room's normal action path (so broadcasts/timers work),
//      wait 600–1200 ms, repeat — until it picks endTurn or hits the action cap.
//
// All engine calls are wrapped: a throwing engine can never crash the process.

import crypto from 'node:crypto';
import { legalActions, applyAction, cloneState, getView } from '../shared/engine.js';

const ACTION_CAP_PER_TURN = 50;
const MIN_DELAY_MS = 600;
const MAX_DELAY_MS = 1200;
const WIN_SCORE = 1e9;
const LOSS_SCORE = -1e9;

const KEYWORD_VALUE = {
  firewall: 0.8,
  shielded: 0.9,
  toxic: 0.7,
  siphon: 0.5,
  stealth: 0.4,
  overtime: 0.8,
  fasttrack: 0.1,
};

export const BOT_NAMES = {
  normal: 'Middle Manager BOT',
  hard: 'The Board (BOT)',
};

function unitValue(u) {
  let v = (u.attack || 0) * 1.1 + (u.health || 0) * 1.0 + 0.4;
  if (Array.isArray(u.keywords)) {
    for (const kw of u.keywords) v += KEYWORD_VALUE[kw] || 0;
  }
  if ((u.attack || 0) === 0) v -= 0.5; // walls without teeth are worth less
  return v;
}

/** Static evaluation of a (possibly cloned) state from the bot's seat. */
export function evaluate(state, me) {
  if (state.over) {
    if (state.winner === me) return WIN_SCORE;
    if (state.winner === null || state.winner === undefined) return 0;
    return LOSS_SCORE;
  }
  let view;
  try {
    view = getView(state, me);
  } catch {
    return LOSS_SCORE / 2; // unreadable position — avoid it
  }
  const you = view.you, opp = view.opp;

  let score = 0;
  // CEO integrity differential (the actual win condition).
  score += (you.integrity - opp.integrity) * 1.0;
  // Board material — value the enemy board slightly higher so the bot trades.
  let myBoard = 0, oppBoard = 0;
  for (const u of you.board || []) myBoard += unitValue(u);
  for (const u of opp.board || []) oppBoard += unitValue(u);
  score += myBoard * 1.0 - oppBoard * 1.05;
  // Hand advantage.
  score += (you.hand ? you.hand.length : 0) * 0.9 - (opp.handCount || 0) * 0.9;
  // Pressure: reward pushing a wounded enemy CEO toward lethal range...
  if (opp.integrity <= 10) score += (10 - opp.integrity) * 0.4;
  // ...and value survival more when we are the one bleeding.
  if (you.integrity <= 10) score -= (10 - you.integrity) * 0.5;
  return score;
}

function scoreAction(state, me, action) {
  let clone;
  try {
    clone = cloneState(state);
  } catch {
    return LOSS_SCORE;
  }
  let result;
  try {
    result = applyAction(clone, me, action);
  } catch {
    return LOSS_SCORE;
  }
  if (!result || !result.ok) return LOSS_SCORE;
  return evaluate(clone, me);
}

/** Pick the bot's next action, or null if there is nothing legal (not its turn). */
export function chooseAction(state, me, difficulty) {
  let actions;
  try {
    actions = legalActions(state, me);
  } catch {
    actions = [];
  }
  if (!Array.isArray(actions) || actions.length === 0) return null;
  if (actions.length === 1) return actions[0];

  const scored = actions
    .map((action) => ({ action, score: scoreAction(state, me, action) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  // Always take an on-the-spot win, regardless of difficulty.
  if (best.score >= WIN_SCORE / 2) return best.action;

  if (difficulty === 'hard') return best.action;

  // "normal": noisy pick among the top 3 non-suicidal candidates.
  const pool = scored.filter((s) => s.score > LOSS_SCORE / 2).slice(0, 3);
  if (pool.length === 0) return best.action;
  const weights = [0.6, 0.25, 0.15].slice(0, pool.length);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = (crypto.randomInt(0, 1000) / 1000) * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i].action;
  }
  return pool[0].action;
}

/**
 * Drives a bot seat inside a room. The room calls onStateChanged() after every
 * broadcast; the controller schedules one delayed step at a time and funnels
 * chosen actions back through room.applyBotAction() so the normal broadcast /
 * timer / game-over machinery runs.
 */
export class BotController {
  constructor(room, seatIndex, difficulty) {
    this.room = room;
    this.seatIndex = seatIndex;
    this.difficulty = difficulty === 'hard' ? 'hard' : 'normal';
    this.timer = null;
    this.actionsThisTurn = 0;
    this.turnKey = null;
    this.stopped = false;
  }

  onStateChanged() {
    if (this.stopped || this.timer) return;
    const state = this.room.state;
    if (!state || state.over) return;
    if (state.activePlayer !== this.seatIndex) {
      this.actionsThisTurn = 0;
      this.turnKey = null;
      return;
    }
    const key = `${state.turn}:${state.activePlayer}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.actionsThisTurn = 0;
    }
    const delay = MIN_DELAY_MS + crypto.randomInt(0, MAX_DELAY_MS - MIN_DELAY_MS + 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.step();
    }, delay);
  }

  step() {
    if (this.stopped) return;
    const state = this.room.state;
    if (!state || state.over || this.room.destroyed) return;
    if (state.activePlayer !== this.seatIndex) return;

    let action;
    if (this.actionsThisTurn >= ACTION_CAP_PER_TURN) {
      action = { type: 'endTurn' }; // loop guard
    } else {
      try {
        action = chooseAction(state, this.seatIndex, this.difficulty);
      } catch {
        action = { type: 'endTurn' };
      }
    }
    if (!action) return;
    this.actionsThisTurn++;

    const ok = this.room.applyBotAction(this.seatIndex, action);
    if (!ok && action.type !== 'endTurn') {
      // Engine rejected our simulation-approved move — bail out of the turn
      // rather than loop on it.
      this.actionsThisTurn = ACTION_CAP_PER_TURN;
      this.room.applyBotAction(this.seatIndex, { type: 'endTurn' });
    }
    // applyBotAction → broadcast → onStateChanged() schedules the next step.
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
