// HOSTILE TAKEOVER — game engine (ENGINE module)
// Pure game logic per docs/DESIGN_CONTRACT.md §5. No I/O, no Math.random.
//
// Documented decisions where the contract is silent:
// - If both CEOs would die simultaneously, the ACTIVE player wins.
// - `concede` is legal at any time, even off-turn (it is not enumerated by
//   legalActions; the server sends it explicitly).
// - The going-first player draws a card at the start of their first turn
//   (so effectively 4 in hand vs 5 + subsidy, Hearthstone-style).
// - An ASSET with a targeted ONBOARDING may be played with no target when no
//   valid target exists (the effect fizzles). An OPERATION / CEO power that
//   requires a target is unplayable without a valid target.
// - STEALTH blocks targeting/attacks by the ENEMY only; you may target your
//   own stealthed assets. A stealthed FIREWALL does not force attackers
//   (it cannot be attacked) until its stealth breaks. Stealth breaks the
//   first time the unit deals damage (combat or effect).
// - TOXIC / SIPHON apply to any damage dealt by the unit (combat or effect).
//   Damage fully absorbed by PATENT PROTECTION is 0 damage dealt: no toxic
//   kill, no siphon heal.
// - `buff` events carry deltas (+/-), not totals. Discards are emitted as
//   `mill` events (closest fixed event type: card leaves hand, destroyed).
// - Death sweep processes boards in player order 0,1 (deterministic);
//   parachutes resolve in the order units died, and may chain.
// - Temporary capital may exceed maxCapital but total capital is capped at 10.
// - Taking control of an enemy asset (Hostile Takeover) is emitted as
//   `death` + `summon` under the new owner (new unit id, summoning-sick).
//   If the new owner's board is full, the asset is destroyed instead.

import { CARDS, STARTER_DECKS } from './cards.js';
export { CARDS, STARTER_DECKS };

const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian'];
const MAX_HAND = 10;
const MAX_BOARD = 7;
const MAX_CAPITAL = 10;
const POWER_COST = 2;
const TARGETINGS = [null, 'any', 'anyUnit', 'enemyUnit', 'friendlyUnit', 'enemyHero', 'anyHero'];

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32 stepping state.rng)
// ---------------------------------------------------------------------------
function rnd(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rndInt = (state, n) => Math.floor(rnd(state) * n);

function shuffle(state, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rndInt(state, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Deck validation
// ---------------------------------------------------------------------------
export function validateDeck(deck) {
  if (!deck || typeof deck !== 'object') return { ok: false, error: 'deck must be an object' };
  if (!FACTIONS.includes(deck.faction)) return { ok: false, error: 'invalid faction' };
  if (!Array.isArray(deck.cards) || deck.cards.length !== 30)
    return { ok: false, error: 'deck must contain exactly 30 cards' };
  const counts = new Map();
  for (const id of deck.cards) {
    const card = CARDS[id];
    if (!card) return { ok: false, error: `unknown card: ${id}` };
    if (!card.collectible) return { ok: false, error: `card not collectible: ${id}` };
    if (card.faction !== deck.faction && card.faction !== 'neutral')
      return { ok: false, error: `card ${id} is not legal in a ${deck.faction} deck` };
    const n = (counts.get(id) || 0) + 1;
    if (n > 2) return { ok: false, error: `more than 2 copies of ${id}` };
    counts.set(id, n);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------
export function createGame({ decks, names, seed }) {
  const state = {
    seed: seed >>> 0,
    rng: (seed ^ 0x9e3779b9) >>> 0,
    turn: 0,
    activePlayer: 0,
    over: false,
    winner: null,
    nextUnit: 1,
    players: [],
  };
  for (let i = 0; i < 2; i++) {
    const deck = decks[i];
    const faction = deck.faction;
    const ceoCardId = factionPrefix(faction) + '_ceo';
    state.players.push({
      name: names[i],
      faction,
      ceoCardId,
      powerCardId: CARDS[ceoCardId].powerId,
      integrity: 30,
      maxIntegrity: 30,
      capital: 0,
      maxCapital: 0,
      deck: shuffle(state, deck.cards.slice()),
      hand: [],
      board: [],
      fatigue: 0,
      powerUsed: false,
    });
  }
  // opening hands: first player 3, second player 4 + Government Subsidy
  const scratch = [];
  drawCards(state, 0, 3, scratch);
  drawCards(state, 1, 4, scratch);
  state.players[1].hand.push('ntr_subsidy');
  // player 0's first turn begins immediately (includes their turn-1 draw)
  startTurn(state, 0, scratch);
  return state;
}

function factionPrefix(faction) {
  return { nexus: 'nx', vulcan: 'vx', helix: 'hx', obsidian: 'ob' }[faction];
}

export function cloneState(state) {
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const hasKw = (unit, kw) => unit.keywords.includes(kw);
function removeKw(unit, kw) {
  const i = unit.keywords.indexOf(kw);
  if (i >= 0) unit.keywords.splice(i, 1);
}

function findUnit(state, id) {
  for (let owner = 0; owner < 2; owner++) {
    const idx = state.players[owner].board.findIndex((u) => u.id === id);
    if (idx >= 0) return { unit: state.players[owner].board[idx], owner, index: idx };
  }
  return null;
}

const isHeroId = (t) => t === 'hero0' || t === 'hero1';
const heroIndex = (t) => (t === 'hero0' ? 0 : 1);

function makeUnit(state, cardId, overrides = {}) {
  const card = CARDS[cardId];
  return {
    id: 'u' + state.nextUnit++,
    cardId,
    attack: card.attack,
    health: card.health,
    maxHealth: card.health,
    keywords: card.keywords.slice(),
    attacksUsed: 0,
    enteredTurn: state.turn,
    silenced: false,
    pendingDestroy: false,
    ...overrides,
  };
}

function maxAttacks(unit) {
  return hasKw(unit, 'overtime') ? 2 : 1;
}

function unitCanAttack(state, unit) {
  if (unit.attack <= 0) return false;
  if (unit.attacksUsed >= maxAttacks(unit)) return false;
  if (unit.enteredTurn === state.turn && !hasKw(unit, 'fasttrack')) return false;
  return true;
}

// firewall units that actually force attacks (stealthed firewalls don't — unattackable)
function forcedTargets(state, defender) {
  return state.players[defender].board.filter((u) => hasKw(u, 'firewall') && !hasKw(u, 'stealth'));
}

function attackTargetIds(state, attackerOwner) {
  const defender = 1 - attackerOwner;
  const forced = forcedTargets(state, defender);
  if (forced.length > 0) return forced.map((u) => u.id);
  const ids = state.players[defender].board.filter((u) => !hasKw(u, 'stealth')).map((u) => u.id);
  ids.push('hero' + defender);
  return ids;
}

// valid target ids for an effect with the given targeting, from `player`'s perspective
function validTargets(state, player, targeting) {
  const enemy = 1 - player;
  const enemyUnits = state.players[enemy].board.filter((u) => !hasKw(u, 'stealth')).map((u) => u.id);
  const friendlyUnits = state.players[player].board.map((u) => u.id);
  switch (targeting) {
    case 'any': return [...friendlyUnits, ...enemyUnits, 'hero' + player, 'hero' + enemy];
    case 'anyUnit': return [...friendlyUnits, ...enemyUnits];
    case 'enemyUnit': return enemyUnits;
    case 'friendlyUnit': return friendlyUnits;
    case 'enemyHero': return ['hero' + enemy];
    case 'anyHero': return ['hero' + player, 'hero' + enemy];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Damage / heal / death sweep
// ---------------------------------------------------------------------------
// source: { unit?, player, id? } — unit for keyword handling, id for the event
function dealDamage(state, ev, targetId, amount, source = {}) {
  if (state.over || amount <= 0) return 0;
  const evBase = { e: 'damage', targetId, amount };
  if (source.id) evBase.source = source.id;
  if (isHeroId(targetId)) {
    state.players[heroIndex(targetId)].integrity -= amount;
    ev.push(evBase);
  } else {
    const found = findUnit(state, targetId);
    if (!found) return 0;
    const { unit } = found;
    if (hasKw(unit, 'shielded')) {
      removeKw(unit, 'shielded');
      ev.push({ e: 'shieldBreak', targetId });
      breakStealth(source.unit);
      return 0;
    }
    unit.health -= amount;
    ev.push(evBase);
    if (source.unit && hasKw(source.unit, 'toxic')) unit.pendingDestroy = true;
  }
  if (source.unit && hasKw(source.unit, 'siphon')) {
    healTarget(state, ev, 'hero' + source.player, amount);
  }
  breakStealth(source.unit);
  return amount;
}

function breakStealth(unit) {
  if (unit) removeKw(unit, 'stealth');
}

function healTarget(state, ev, targetId, amount) {
  if (state.over || amount <= 0) return;
  let healed = 0;
  if (isHeroId(targetId)) {
    const p = state.players[heroIndex(targetId)];
    healed = Math.min(amount, p.maxIntegrity - p.integrity);
    p.integrity += healed;
  } else {
    const found = findUnit(state, targetId);
    if (!found) return;
    healed = Math.min(amount, found.unit.maxHealth - found.unit.health);
    found.unit.health += healed;
  }
  if (healed > 0) ev.push({ e: 'heal', targetId, amount: healed });
}

function checkHeroes(state, ev) {
  if (state.over) return true;
  const dead0 = state.players[0].integrity <= 0;
  const dead1 = state.players[1].integrity <= 0;
  if (!dead0 && !dead1) return false;
  let winner;
  if (dead0 && dead1) winner = state.activePlayer; // simultaneous: active player wins
  else winner = dead0 ? 1 : 0;
  endGame(state, ev, winner, 'takeover');
  return true;
}

function endGame(state, ev, winner, reason) {
  state.over = true;
  state.winner = winner;
  ev.push({ e: 'gameOver', winner, reason });
}

// Remove dead units, fire parachutes, loop until stable. Ends the game
// immediately if a CEO is at 0 between waves.
function sweepDeaths(state, ev) {
  for (let guard = 0; guard < 100; guard++) {
    if (checkHeroes(state, ev)) return;
    const dead = [];
    for (let owner = 0; owner < 2; owner++) {
      const board = state.players[owner].board;
      for (let i = board.length - 1; i >= 0; i--) {
        const u = board[i];
        if (u.health <= 0 || u.pendingDestroy) {
          board.splice(i, 1);
          dead.push({ unit: u, owner, index: i });
        }
      }
    }
    if (dead.length === 0) return;
    // deaths were collected per-board in reverse; report/resolve left-to-right
    dead.sort((a, b) => (a.owner - b.owner) || (a.index - b.index));
    for (const d of dead) ev.push({ e: 'death', unitId: d.unit.id, cardId: d.unit.cardId });
    for (const d of dead) {
      const card = CARDS[d.unit.cardId];
      if (!d.unit.silenced && card.effects.parachute) {
        runOps(state, ev, card.effects.parachute, {
          player: d.owner, sourceUnit: d.unit, target: null, position: d.index,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Draw / mill / fatigue / discard
// ---------------------------------------------------------------------------
function drawCards(state, player, count, ev) {
  const p = state.players[player];
  for (let i = 0; i < count; i++) {
    if (state.over) return;
    if (p.deck.length === 0) {
      p.fatigue += 1;
      ev.push({ e: 'fatigue', player, amount: p.fatigue });
      dealDamage(state, ev, 'hero' + player, p.fatigue, {});
      checkHeroes(state, ev);
      continue;
    }
    const cardId = p.deck.pop();
    if (p.hand.length >= MAX_HAND) {
      ev.push({ e: 'mill', player, cardId });
    } else {
      p.hand.push(cardId);
      ev.push({ e: 'draw', player, cardId });
    }
  }
}

function discardRandom(state, player, count, ev) {
  const p = state.players[player];
  for (let i = 0; i < count; i++) {
    if (p.hand.length === 0) return;
    const idx = rndInt(state, p.hand.length);
    const [cardId] = p.hand.splice(idx, 1);
    ev.push({ e: 'mill', player, cardId });
  }
}

// ---------------------------------------------------------------------------
// Summoning
// ---------------------------------------------------------------------------
function summonUnit(state, ev, player, cardId, position = null, overrides = {}) {
  const board = state.players[player].board;
  if (board.length >= MAX_BOARD) return null;
  const unit = makeUnit(state, cardId, overrides);
  let pos = position === null || position === undefined ? board.length : position;
  pos = Math.max(0, Math.min(pos, board.length));
  board.splice(pos, 0, unit);
  ev.push({
    e: 'summon', player,
    unit: { id: unit.id, cardId: unit.cardId, attack: unit.attack, health: unit.health, keywords: unit.keywords.slice() },
    position: pos,
  });
  return unit;
}

// ---------------------------------------------------------------------------
// Effect DSL
// ---------------------------------------------------------------------------
// ctx: { player, sourceUnit|null, target: targetId|null, position?: number }
export const OPS = {
  damage(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      dealDamage(state, ev, id, op.amount, sourceOf(ctx));
    }
  },
  aoeDamage(state, ev, op, ctx) {
    const sides = op.side === 'all' ? [0, 1] : [op.side === 'enemy' ? 1 - ctx.player : ctx.player];
    const ids = [];
    for (const s of sides) {
      for (const u of state.players[s].board) {
        if (op.excludeSelf && ctx.sourceUnit && u.id === ctx.sourceUnit.id) continue;
        ids.push(u.id);
      }
      if (op.includeHeroes) ids.push('hero' + s);
    }
    for (const id of ids) dealDamage(state, ev, id, op.amount, sourceOf(ctx));
  },
  heal(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) healTarget(state, ev, id, op.amount);
  },
  draw(state, ev, op, ctx) {
    const player = op.player === 'opponent' ? 1 - ctx.player : ctx.player;
    drawCards(state, player, op.count, ev);
  },
  summon(state, ev, op, ctx) {
    const player = op.forOpponent ? 1 - ctx.player : ctx.player;
    const n = op.count || 1;
    for (let i = 0; i < n; i++) {
      summonUnit(state, ev, player, op.cardId, ctx.position ?? null);
    }
  },
  buff(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      const u = found.unit;
      const da = op.attack || 0;
      const dh = op.health || 0;
      u.attack = Math.max(0, u.attack + da);
      u.health += dh;
      u.maxHealth += dh;
      ev.push({ e: 'buff', unitId: id, attack: da, health: dh });
    }
  },
  grantKeyword(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      if (!hasKw(found.unit, op.keyword)) {
        found.unit.keywords.push(op.keyword);
        ev.push({ e: 'keyword', unitId: id, keyword: op.keyword });
      }
    }
  },
  destroy(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (found) found.unit.pendingDestroy = true;
    }
  },
  returnToHand(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      const { unit, owner, index } = found;
      state.players[owner].board.splice(index, 1);
      ev.push({ e: 'returnToHand', unitId: unit.id });
      if (state.players[owner].hand.length >= MAX_HAND) {
        ev.push({ e: 'mill', player: owner, cardId: unit.cardId });
      } else {
        state.players[owner].hand.push(unit.cardId);
      }
    }
  },
  addCapital(state, ev, op, ctx) {
    const p = state.players[ctx.player];
    if (op.permanent) {
      p.maxCapital = Math.min(MAX_CAPITAL, p.maxCapital + op.amount);
    }
    p.capital = Math.min(MAX_CAPITAL, p.capital + op.amount);
    ev.push({ e: 'capital', player: ctx.player, capital: p.capital, maxCapital: p.maxCapital });
  },
  discardRandom(state, ev, op, ctx) {
    const player = op.player === 'self' ? ctx.player : 1 - ctx.player;
    discardRandom(state, player, op.count, ev);
  },
  transform(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      const u = found.unit;
      const card = CARDS[op.cardId];
      u.cardId = op.cardId;
      u.attack = card.attack;
      u.health = card.health;
      u.maxHealth = card.health;
      u.keywords = card.keywords.slice();
      u.silenced = false;
      u.attacksUsed = 0;
      u.enteredTurn = state.turn; // summoning-sick after transform
      u.pendingDestroy = false;
      ev.push({ e: 'transform', unitId: id, cardId: op.cardId });
    }
  },
  silence(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      found.unit.silenced = true;
      found.unit.keywords = [];
      ev.push({ e: 'silence', unitId: id });
    }
  },
  special(state, ev, op, ctx) {
    const fn = SPECIALS[op.key];
    if (fn) fn(state, ev, op, ctx);
  },
};

export const SPECIALS = {
  // take control of the targeted enemy asset (new id; destroyed if board full)
  stealUnit(state, ev, op, ctx) {
    const found = ctx.target && findUnit(state, ctx.target);
    if (!found) return;
    const { unit, owner, index } = found;
    state.players[owner].board.splice(index, 1);
    ev.push({ e: 'death', unitId: unit.id, cardId: unit.cardId });
    if (state.players[ctx.player].board.length >= MAX_BOARD) return; // no room: gone for good
    summonUnit(state, ev, ctx.player, unit.cardId, null, {
      attack: unit.attack, health: unit.health, maxHealth: unit.maxHealth,
      keywords: unit.keywords.slice(), silenced: unit.silenced,
    });
  },
  // summon a copy (current stats) of the targeted friendly asset
  summonCopy(state, ev, op, ctx) {
    const found = ctx.target && findUnit(state, ctx.target);
    if (!found) return;
    const u = found.unit;
    summonUnit(state, ev, ctx.player, u.cardId, null, {
      attack: u.attack, health: u.health, maxHealth: u.maxHealth,
      keywords: u.keywords.slice(), silenced: u.silenced,
    });
  },
  // destroy target friendly asset, gain temporary capital equal to its cost
  liquidate(state, ev, op, ctx) {
    const found = ctx.target && findUnit(state, ctx.target);
    if (!found) return;
    found.unit.pendingDestroy = true;
    const cost = CARDS[found.unit.cardId].cost;
    if (cost > 0) OPS.addCapital(state, ev, { op: 'addCapital', amount: cost }, ctx);
  },
};

function sourceOf(ctx) {
  return ctx.sourceUnit
    ? { unit: ctx.sourceUnit, player: ctx.player, id: ctx.sourceUnit.id }
    : { player: ctx.player, id: ctx.sourceCardId };
}

function resolveTargets(state, ctx, to) {
  switch (to || 'target') {
    case 'target': return ctx.target ? [ctx.target] : [];
    case 'self': return ctx.sourceUnit ? [ctx.sourceUnit.id] : [];
    case 'friendlyHero': return ['hero' + ctx.player];
    case 'enemyHero': return ['hero' + (1 - ctx.player)];
    case 'allFriendlyUnits': return state.players[ctx.player].board.map((u) => u.id);
    case 'allEnemyUnits': return state.players[1 - ctx.player].board.map((u) => u.id);
    case 'allUnits':
      return [...state.players[0].board, ...state.players[1].board].map((u) => u.id);
    default: return [];
  }
}

function runOps(state, ev, ops, ctx) {
  for (const op of ops) {
    if (state.over) return;
    const fn = OPS[op.op];
    if (fn) fn(state, ev, op, ctx);
  }
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------
function startTurn(state, player, ev) {
  state.turn += 1;
  state.activePlayer = player;
  const p = state.players[player];
  p.maxCapital = Math.min(MAX_CAPITAL, p.maxCapital + 1);
  p.capital = p.maxCapital;
  p.powerUsed = false;
  for (const u of p.board) u.attacksUsed = 0;
  ev.push({ e: 'turnStart', player, turn: state.turn });
  ev.push({ e: 'capital', player, capital: p.capital, maxCapital: p.maxCapital });
  drawCards(state, player, 1, ev);
  sweepDeaths(state, ev); // fatigue may have been lethal
}

function endTurn(state, ev) {
  const player = state.activePlayer;
  // end-of-turn triggers for the active player's board (snapshot: units present now)
  for (const u of state.players[player].board.slice()) {
    if (state.over) return;
    if (u.silenced) continue;
    if (!state.players[player].board.includes(u)) continue; // died mid-triggers
    const card = CARDS[u.cardId];
    if (card.effects.endOfTurn) {
      runOps(state, ev, card.effects.endOfTurn, { player, sourceUnit: u, target: null });
      sweepDeaths(state, ev);
    }
  }
  if (state.over) return;
  startTurn(state, 1 - player, ev);
}

// ---------------------------------------------------------------------------
// Target validation for playing cards / powers
// ---------------------------------------------------------------------------
function checkTarget(state, player, targeting, target, { fizzleAllowed }) {
  if (!targeting) {
    return target ? { ok: false, error: 'card does not take a target' } : { ok: true, target: null };
  }
  const valid = validTargets(state, player, targeting);
  if (valid.length === 0) {
    if (fizzleAllowed) {
      return target ? { ok: false, error: 'no valid targets' } : { ok: true, target: null };
    }
    return { ok: false, error: 'no valid targets' };
  }
  if (!valid.includes(target)) return { ok: false, error: 'invalid target' };
  return { ok: true, target };
}

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------
export function applyAction(state, playerIndex, action) {
  try {
    return applyActionInner(state, playerIndex, action);
  } catch (err) {
    return { ok: false, error: 'internal error: ' + (err && err.message) };
  }
}

function applyActionInner(state, playerIndex, action) {
  if (!state || !state.players) return { ok: false, error: 'invalid state' };
  if (playerIndex !== 0 && playerIndex !== 1) return { ok: false, error: 'invalid player' };
  if (!action || typeof action !== 'object' || typeof action.type !== 'string')
    return { ok: false, error: 'invalid action' };
  if (state.over) return { ok: false, error: 'game is over' };

  const ev = [];

  if (action.type === 'concede') {
    endGame(state, ev, 1 - playerIndex, 'concede');
    return { ok: true, events: ev };
  }

  if (state.activePlayer !== playerIndex) return { ok: false, error: 'not your turn' };
  const p = state.players[playerIndex];

  switch (action.type) {
    case 'endTurn': {
      endTurn(state, ev);
      return { ok: true, events: ev };
    }

    case 'playCard': {
      const idx = action.handIndex;
      if (!Number.isInteger(idx) || idx < 0 || idx >= p.hand.length)
        return { ok: false, error: 'invalid hand index' };
      const cardId = p.hand[idx];
      const card = CARDS[cardId];
      if (card.type !== 'ASSET' && card.type !== 'OPERATION')
        return { ok: false, error: 'card cannot be played' };
      if (card.cost > p.capital) return { ok: false, error: 'not enough capital' };
      if (card.type === 'ASSET' && p.board.length >= MAX_BOARD)
        return { ok: false, error: 'board is full' };

      const target = action.target ?? null;
      const targeting = card.effects.targeting || null;
      const tc = checkTarget(state, playerIndex, targeting, target, {
        fizzleAllowed: card.type === 'ASSET',
      });
      if (!tc.ok) return tc;

      p.capital -= card.cost;
      p.hand.splice(idx, 1);
      ev.push({ e: 'cardPlayed', player: playerIndex, cardId, handIndex: idx });

      if (card.type === 'ASSET') {
        const pos = Number.isInteger(action.position) ? action.position : null;
        const unit = summonUnit(state, ev, playerIndex, cardId, pos);
        // a targeted onboarding with no target (no valid targets existed) fizzles
        if (unit && card.effects.onboarding && (!targeting || tc.target !== null)) {
          runOps(state, ev, card.effects.onboarding, {
            player: playerIndex, sourceUnit: unit, target: tc.target, sourceCardId: cardId,
          });
        }
      } else {
        runOps(state, ev, card.effects.play || [], {
          player: playerIndex, sourceUnit: null, target: tc.target, sourceCardId: cardId,
        });
      }
      sweepDeaths(state, ev);
      return { ok: true, events: ev };
    }

    case 'attack': {
      const found = findUnit(state, action.attackerId);
      if (!found || found.owner !== playerIndex) return { ok: false, error: 'invalid attacker' };
      const attacker = found.unit;
      if (!unitCanAttack(state, attacker)) return { ok: false, error: 'asset cannot attack' };
      const legal = attackTargetIds(state, playerIndex);
      if (!legal.includes(action.targetId)) return { ok: false, error: 'invalid attack target' };

      attacker.attacksUsed += 1;
      ev.push({ e: 'attack', attackerId: attacker.id, targetId: action.targetId });
      if (isHeroId(action.targetId)) {
        dealDamage(state, ev, action.targetId, attacker.attack,
          { unit: attacker, player: playerIndex, id: attacker.id });
      } else {
        const def = findUnit(state, action.targetId);
        const defender = def.unit;
        const defAttack = defender.attack;
        dealDamage(state, ev, defender.id, attacker.attack,
          { unit: attacker, player: playerIndex, id: attacker.id });
        if (defAttack > 0) {
          dealDamage(state, ev, attacker.id, defAttack,
            { unit: defender, player: 1 - playerIndex, id: defender.id });
        }
      }
      sweepDeaths(state, ev);
      return { ok: true, events: ev };
    }

    case 'heroPower': {
      if (p.powerUsed) return { ok: false, error: 'power already used this turn' };
      if (p.capital < POWER_COST) return { ok: false, error: 'not enough capital' };
      const power = CARDS[p.powerCardId];
      const targeting = power.effects.targeting || null;
      const tc = checkTarget(state, playerIndex, targeting, action.target ?? null, {
        fizzleAllowed: false,
      });
      if (!tc.ok) return tc;
      p.capital -= POWER_COST;
      p.powerUsed = true;
      ev.push({ e: 'heroPower', player: playerIndex });
      runOps(state, ev, power.effects.play || [], {
        player: playerIndex, sourceUnit: null, target: tc.target, sourceCardId: p.powerCardId,
      });
      sweepDeaths(state, ev);
      return { ok: true, events: ev };
    }

    default:
      return { ok: false, error: 'unknown action type' };
  }
}

// ---------------------------------------------------------------------------
// legalActions
// ---------------------------------------------------------------------------
export function legalActions(state, playerIndex) {
  if (!state || state.over || state.activePlayer !== playerIndex) return [];
  const p = state.players[playerIndex];
  const actions = [{ type: 'endTurn' }];

  p.hand.forEach((cardId, handIndex) => {
    const card = CARDS[cardId];
    if (card.type !== 'ASSET' && card.type !== 'OPERATION') return;
    if (card.cost > p.capital) return;
    if (card.type === 'ASSET' && p.board.length >= MAX_BOARD) return;
    const targeting = card.effects.targeting || null;
    if (!targeting) {
      actions.push({ type: 'playCard', handIndex, target: null, position: null });
      return;
    }
    const targets = validTargets(state, playerIndex, targeting);
    if (targets.length === 0) {
      if (card.type === 'ASSET')
        actions.push({ type: 'playCard', handIndex, target: null, position: null });
      return;
    }
    for (const t of targets)
      actions.push({ type: 'playCard', handIndex, target: t, position: null });
  });

  for (const unit of p.board) {
    if (!unitCanAttack(state, unit)) continue;
    for (const t of attackTargetIds(state, playerIndex))
      actions.push({ type: 'attack', attackerId: unit.id, targetId: t });
  }

  if (!p.powerUsed && p.capital >= POWER_COST) {
    const power = CARDS[p.powerCardId];
    const targeting = power.effects.targeting || null;
    if (!targeting) {
      actions.push({ type: 'heroPower', target: null });
    } else {
      for (const t of validTargets(state, playerIndex, targeting))
        actions.push({ type: 'heroPower', target: t });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Views & redaction
// ---------------------------------------------------------------------------
function handEntry(state, playerIndex, cardId, isActive) {
  const card = CARDS[cardId];
  const p = state.players[playerIndex];
  const targeting = card.effects.targeting || null;
  let playable = false;
  if (isActive && !state.over && (card.type === 'ASSET' || card.type === 'OPERATION')
      && card.cost <= p.capital) {
    if (card.type === 'ASSET') {
      playable = p.board.length < MAX_BOARD;
    } else {
      playable = !targeting || validTargets(state, playerIndex, targeting).length > 0;
    }
  }
  return {
    cardId,
    cost: card.cost,
    playable,
    targeting,
    validPositions: card.type === 'ASSET',
  };
}

function unitView(state, unit, canAct) {
  return {
    id: unit.id,
    cardId: unit.cardId,
    attack: unit.attack,
    health: unit.health,
    maxHealth: unit.maxHealth,
    keywords: unit.keywords.slice(),
    canAttack: canAct ? unitCanAttack(state, unit) : false,
    exhausted: unit.attacksUsed >= maxAttacks(unit),
    damaged: unit.health < unit.maxHealth,
  };
}

function playerView(state, i, { self }) {
  const p = state.players[i];
  const isActive = state.activePlayer === i && !state.over;
  const powerCard = CARDS[p.powerCardId];
  const view = {
    index: i,
    name: p.name,
    faction: p.faction,
    integrity: p.integrity,
    maxIntegrity: p.maxIntegrity,
    capital: p.capital,
    maxCapital: p.maxCapital,
    ceo: { cardId: p.ceoCardId, name: CARDS[p.ceoCardId].name },
    power: {
      cardId: p.powerCardId,
      cost: powerCard.cost,
      used: p.powerUsed,
      targeting: powerCard.effects.targeting || null,
    },
    board: p.board.map((u) => unitView(state, u, self && isActive)),
    deckCount: p.deck.length,
    fatigue: p.fatigue,
  };
  if (self) view.hand = p.hand.map((cardId) => handEntry(state, i, cardId, isActive));
  else view.handCount = p.hand.length;
  return view;
}

export function getView(state, playerIndex) {
  return {
    turn: state.turn,
    activePlayer: state.activePlayer,
    you: playerView(state, playerIndex, { self: true }),
    opp: playerView(state, 1 - playerIndex, { self: false }),
    over: state.over,
    winner: state.winner,
  };
}

export function redactEvents(events, playerIndex) {
  return events.map((e) =>
    e.e === 'draw' && e.player !== playerIndex ? { ...e, cardId: null } : { ...e }
  );
}

// exported for data-integrity tests (engine-internal knowledge)
export const TARGETING_VALUES = TARGETINGS;
