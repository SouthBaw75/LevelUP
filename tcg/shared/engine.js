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
//
// CONTRACT (§3b) decisions where the contract is silent:
// - Start-of-turn contract phase order: the ACTIVE player's own contracts in
//   filing order (each contract's term decrements right after its own trigger),
//   THEN the opponent's both-parties contracts in filing order. Both-parties
//   ops run with ctx.player = the ACTIVE player ("that player" in card text).
// - End-of-turn order: board (asset) endOfTurn triggers first, then the active
//   player's contract endOfTurn triggers, then the opponent's turnStart.
// - `onFriendlyAssetDestroyed` fires for every friendly asset death processed
//   by the death sweep (combat, effect damage, destroy ops) — the stealUnit
//   special's control-change `death` is not a destruction and does not fire it.
//   These triggers fire BEFORE the dead wave's parachutes resolve.
// - `opDamageBonus` boosts damage from any no-unit, non-contract source (i.e.
//   OPERATION and CEO POWER damage ops), including self-damage ops. Combat,
//   onboarding/parachute (unit-sourced), contract-trigger and fatigue damage
//   are never boosted.
// - Hand entries in the view report the LIVE effective cost (after
//   opCostReduction / contractCostReduction / enemyCostIncrease) so client
//   affordability display matches `playable`.
// - `onOperationPlayed` fires after the operation's own effects fully resolve
//   (deaths swept), for EVERY operation the owner plays — including Government
//   Subsidy and Void Clause. CEO powers are not operations and never fire it.

import { CARDS, STARTER_DECKS } from './cards.js';
export { CARDS, STARTER_DECKS };

const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian'];
const MAX_HAND = 10;
const MAX_BOARD = 7;
const MAX_CAPITAL = 10;
const POWER_COST = 2;
const MAX_CONTRACTS = 3;
const BIG_HIT_THRESHOLD = 10; // cumulative enemy hero damage in one game-turn that fires a CEO taunt
const PLAYABLE_TYPES = ['ASSET', 'OPERATION', 'CONTRACT'];
const TARGETINGS = [null, 'any', 'anyUnit', 'enemyUnit', 'enemyUnitCost4', 'friendlyUnit',
  'friendlyUnitNoFirewall', 'enemyHero', 'anyHero', 'enemyContract'];

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
  if (!Array.isArray(deck.cards) || deck.cards.length !== 40)
    return { ok: false, error: 'deck must contain exactly 40 cards' };
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
    nextContract: 1, // contract instance ids "c<N>" (own counter, distinct from "u<N>")
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
      integrity: 40,
      maxIntegrity: 40,
      capital: 0,
      maxCapital: 0,
      capitalDrain: 0, // RAID (Corporate Raider): banked reduction applied to this turn's capital, then cleared
      assetCapitalBonus: 0, // War Chest: activated reserve, spendable on ASSETS only, cleared at this player's next turn start
      deck: shuffle(state, deck.cards.slice()),
      hand: [],
      board: [],
      contracts: [], // filed contracts, in filing order: { id, cardId, turnsLeft }
      fatigue: 0,
      powerUsed: false,
      turnDamage: 0, // cumulative enemy-caused hero damage this game-turn (bigHit taunt trigger)
      bigHitFired: false, // whether bigHit already fired for this player this game-turn
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
    killedBy: null, // §3d: player index that put this unit on a death path (last-writer-wins)
    distracted: 0,  // Flirty Intern: turns of "can't attack" remaining; ticks down each owner turn
    ...overrides,
  };
}

function maxAttacks(unit) {
  return hasKw(unit, 'overtime') ? 2 : 1;
}

function unitCanAttack(state, unit) {
  if (unit.distracted > 0) return false; // Flirty Intern: charmed, can't attack
  if (effectiveAttack(state, unit) <= 0) return false;
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
    // enemy assets printed cost ≤ 4 — for Counter Offer's outbid-poach (§Counter Offer).
    // Cost is never modified in-game, so the printed CARDS[cardId].cost is stable/correct.
    case 'enemyUnitCost4':
      return state.players[enemy].board
        .filter((u) => !hasKw(u, 'stealth') && (CARDS[u.cardId]?.cost ?? 0) <= 4)
        .map((u) => u.id);
    case 'friendlyUnit': return friendlyUnits;
    // friendly assets that don't already have FIREWALL (Firewall Upgrade)
    case 'friendlyUnitNoFirewall':
      return state.players[player].board.filter((u) => !hasKw(u, 'firewall')).map((u) => u.id);
    case 'enemyHero': return ['hero' + enemy];
    case 'anyHero': return ['hero' + player, 'hero' + enemy];
    case 'enemyContract': return state.players[enemy].contracts.map((c) => c.id);
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Contracts (§3b)
// ---------------------------------------------------------------------------
// ctx for ops run by a contract trigger. `contractSource` keeps this damage
// out of the opDamageBonus path (that bonus is for operations/CEO powers only).
function contractCtx(player, contract) {
  return {
    player, sourceUnit: null, target: null,
    sourceCardId: contract.cardId, contractSource: true,
    sourceContract: contract, // instance-state ops (bankCapital) write to it
  };
}

// Sum a static modifier (opCostReduction / opDamageBonus) over the player's
// filed contracts — evaluated live, multiple copies stack.
function contractStatic(state, player, key) {
  let total = 0;
  for (const c of state.players[player].contracts) {
    const st = CARDS[c.cardId].effects.static;
    if (st && st[key]) total += st[key];
  }
  return total;
}

// Sum a static modifier (contractCostReduction) over the player's board
// ASSETS — mirrors contractStatic but sourced from units in play rather than
// filed contracts (Corporate Lobbyist: a lobbyist discounts contracts, not
// the other way around). Live, multiple copies stack, vanishes the instant
// the source leaves the board.
function assetStatic(state, player, key) {
  let total = 0;
  for (const u of state.players[player].board) {
    const st = CARDS[u.cardId].effects.static;
    if (st && st[key]) total += st[key];
  }
  return total;
}

// §counters — per-unit aura modifiers. Unlike the `buff` op (which bakes deltas
// permanently onto a unit's stats), auras are computed LIVE from the owner's
// filed contracts every time a stat is read. So they appear/vanish on their own
// as contracts or matching units enter/leave, and steal/copy naturally drop them
// (the new owner's auras reapply). Phase 1 covers ATTACK only.
function auraMatches(match, def) {
  if (!match || !def) return false;
  if (match.tag) return (def.tags || []).includes(match.tag);
  return false;
}
// Owner index (0|1) of a board unit, or -1 if it is not on either board.
function ownerOf(state, unit) {
  if (state.players[0].board.includes(unit)) return 0;
  if (state.players[1].board.includes(unit)) return 1;
  return -1;
}
// Detailed counter contribution to `unit` from `owner`'s aura contracts:
// { atk, count, sources: [{cardId, atk}] }.
function unitCounters(state, owner, unit) {
  const def = CARDS[unit.cardId];
  const sources = [];
  let atk = 0;
  for (const c of state.players[owner].contracts) {
    const aura = CARDS[c.cardId].effects.aura;
    if (aura && aura.attack && auraMatches(aura.match, def)) {
      atk += aura.attack;
      sources.push({ cardId: c.cardId, atk: aura.attack });
    }
  }
  return { atk, count: sources.length, sources };
}
// Live effective attack = base (incl. baked buffs) + dynamic term + aura, floored
// at 0. `effects.dynamicAttack: 'capital'` ties a unit's Attack to its owner's
// current Capital (printed base is 0; Capital drives it, so it re-reads live on
// every view/combat). Pass `owner` when known to skip the board scan.
export function effectiveAttack(state, unit, owner) {
  const o = owner === undefined ? ownerOf(state, unit) : owner;
  let base = unit.attack;
  if (o >= 0 && CARDS[unit.cardId]?.effects?.dynamicAttack === 'capital') {
    base += state.players[o].capital;
  }
  const aura = o >= 0 ? unitCounters(state, o, unit).atk : 0;
  return Math.max(0, base + aura);
}

// Affiliate Influencer (§combatBonus): flat extra damage an attacker deals when
// it strikes a DEFENDER asset whose class matches `vsTag`. Folded into the
// combat damage number (no separate event), the way auras fold into
// effectiveAttack. Silence strips it (it's an ability), same as keywords.
function combatTagBonus(attacker, defenderDef) {
  if (attacker.silenced) return 0;
  const cb = CARDS[attacker.cardId]?.effects?.combatBonus;
  if (cb && cb.vsTag && (defenderDef?.tags || []).includes(cb.vsTag)) return cb.damage || 0;
  return 0;
}

// THE one cost helper: view display, playable calc, applyAction validation and
// capital deduction all go through here. opCostReduction (nx_c01) applies to
// the owner's OPERATIONs only; contractCostReduction (Corporate Lobbyist)
// applies to the owner's CONTRACTs only; enemyCostIncrease (Regulatory
// Capture) applies to ALL of the OWNER's OPPONENT's card types — filed
// against you, it raises what you pay, not what its filer pays. Every term
// stacks additively before a single floor-at-0 (so e.g. your own
// opCostReduction can offset an enemy's tax on operations specifically,
// while your assets/contracts still feel the full tax).
function effectiveCost(state, player, card) {
  let cost = card.cost;
  if (card.type === 'OPERATION') cost -= contractStatic(state, player, 'opCostReduction');
  else if (card.type === 'CONTRACT') cost -= assetStatic(state, player, 'contractCostReduction');
  cost += contractStatic(state, 1 - player, 'enemyCostIncrease');
  return Math.max(0, cost);
}

// War Chest (§reserve): what `p` can actually pay for `card`. An activated
// reserve (assetCapitalBonus) tops up capital for ASSETS ONLY; operations and
// contracts spend plain capital. handEntry, legalActions and applyAction all
// gate through here so display, enumeration and validation agree.
function spendingBudget(p, card) {
  return p.capital + (card.type === 'ASSET' ? p.assetCapitalBonus : 0);
}

// Remove a filed contract from play (either owner) and emit contractVoided.
function voidContract(state, ev, contractId, reason) {
  for (let owner = 0; owner < 2; owner++) {
    const list = state.players[owner].contracts;
    const i = list.findIndex((c) => c.id === contractId);
    if (i >= 0) {
      const [c] = list.splice(i, 1);
      ev.push({ e: 'contractVoided', contractId: c.id, cardId: c.cardId, reason });
      return true;
    }
  }
  return false;
}

// Run one trigger ('endOfTurn' | 'onOperationPlayed') across a player's filed
// contracts in filing order, sweeping deaths after each (damage may be lethal).
function fireContractTrigger(state, ev, player, trigger) {
  const list = state.players[player].contracts;
  for (const c of list.slice()) {
    if (state.over) return;
    if (!list.includes(c)) continue; // voided mid-phase
    const ops = CARDS[c.cardId].effects[trigger];
    if (ops) {
      runOps(state, ev, ops, contractCtx(player, c));
      sweepDeaths(state, ev);
    }
  }
}

// Start-of-turn contract phase (after the draw step):
// 1. the active player's own contracts, in filing order — trigger, then term
//    decrement (spec: decrement AFTER its trigger; 0 -> voided as 'expired');
// 2. the opponent's both-parties contracts (vx_c03) also fire on this turn,
//    with ctx.player = the active player ("that player" = whoever's turn it is).
function runContractStartOfTurn(state, player, ev) {
  const own = state.players[player].contracts;
  for (const c of own.slice()) {
    if (state.over) return;
    if (!own.includes(c)) continue; // voided mid-phase
    const card = CARDS[c.cardId];
    if (card.effects.startOfTurn) {
      runOps(state, ev, card.effects.startOfTurn, contractCtx(player, c));
      sweepDeaths(state, ev);
      if (state.over) return;
    }
    if (c.turnsLeft !== null) {
      c.turnsLeft -= 1;
      if (c.turnsLeft <= 0) voidContract(state, ev, c.id, 'expired');
    }
  }
  const theirs = state.players[1 - player].contracts;
  for (const c of theirs.slice()) {
    if (state.over) return;
    if (!theirs.includes(c)) continue;
    const card = CARDS[c.cardId];
    if (card.effects.bothParties && card.effects.startOfTurn) {
      runOps(state, ev, card.effects.startOfTurn, contractCtx(player, c));
      sweepDeaths(state, ev);
    }
  }
}

// ---------------------------------------------------------------------------
// Damage / heal / death sweep
// ---------------------------------------------------------------------------
// source: { unit?, player, id? } — unit for keyword handling, id for the event
function dealDamage(state, ev, targetId, amount, source = {}) {
  if (state.over || amount <= 0) return 0;
  // vx_c01 opDamageBonus: no-unit sources that are operations / CEO powers
  // (source.isSpell) deal +N. Combat, contract-trigger and fatigue damage
  // never carry isSpell, so they are unaffected.
  if (source.isSpell) amount += contractStatic(state, source.player, 'opDamageBonus');
  const evBase = { e: 'damage', targetId, amount };
  if (source.id) evBase.source = source.id;
  if (isHeroId(targetId)) {
    const hi = heroIndex(targetId);
    const victim = state.players[hi];
    victim.integrity -= amount;
    ev.push(evBase);
    // bigHit taunt: cumulative ENEMY-caused damage to this hero this game-turn
    // crossing the threshold fires the attacker's CEO taunt once per turn.
    // Self-damage (own fatigue, own contract upkeep, own CEO power) never
    // counts — there's no "enemy" to taunt.
    if (typeof source.player === 'number' && source.player !== hi) {
      victim.turnDamage += amount;
      if (!victim.bigHitFired && victim.turnDamage >= BIG_HIT_THRESHOLD) {
        victim.bigHitFired = true;
        ev.push({ e: 'bigHit', targetPlayer: hi, attackerPlayer: source.player, amount: victim.turnDamage });
      }
    }
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
    // §3d kill attribution: record the causing player on any health reduction
    // (and any TOXIC-set death), guarded to a real player index; last-writer-wins.
    if (typeof source.player === 'number') unit.killedBy = source.player;
    if (source.unit && hasKw(source.unit, 'toxic')) {
      unit.pendingDestroy = true;
      if (typeof source.player === 'number') unit.killedBy = source.player;
    }
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

// Healing is UNCAPPED: integrity and unit durability may exceed their base
// values (a CEO at 40/40 healed for 2 goes to 42). maxIntegrity/maxHealth
// remain the BASE stats used for display/damaged-styling, not a heal ceiling.
function healTarget(state, ev, targetId, amount) {
  if (state.over || amount <= 0) return;
  if (isHeroId(targetId)) {
    state.players[heroIndex(targetId)].integrity += amount;
  } else {
    const found = findUnit(state, targetId);
    if (!found) return;
    found.unit.health += amount;
  }
  ev.push({ e: 'heal', targetId, amount });
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

// Remove dead units, fire parachutes, loop until stable. Each wave's own dead
// units are always fully swept/resolved BEFORE the hero check, so a unit that
// dies in the same action that also kills a CEO (e.g. BULLISH overflow) still
// gets its death event/parachute/severance; the game then ends after that
// wave rather than starting a new one.
function sweepDeaths(state, ev) {
  for (let guard = 0; guard < 100; guard++) {
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
    // Collect and remove THIS wave's dead units before checking heroes — a
    // BULLISH overflow (or any single action) can knock out a blocker and the
    // enemy CEO in the same breath, and the blocker's corpse must still be
    // swept (death event, parachute, severance) even though the game is about
    // to end. Checking heroes first would return before any of that ran,
    // leaving a health<=0 unit sitting on the board in the final view.
    if (dead.length === 0) { if (checkHeroes(state, ev)) return; return; }
    // deaths were collected per-board in reverse; report/resolve left-to-right
    dead.sort((a, b) => (a.owner - b.owner) || (a.index - b.index));
    for (const d of dead) ev.push({ e: 'death', unitId: d.unit.id, cardId: d.unit.cardId });
    // Contract reactions to friendly asset deaths (hx_c03: heal; ob_c03: temp
    // capital) fire per death, before the wave's parachutes. Recursion guard:
    // these effects are heal/addCapital only and cannot create further deaths;
    // even a pathological chain is bounded by this loop's `guard`.
    for (const d of dead) {
      const list = state.players[d.owner].contracts;
      for (const c of list.slice()) {
        if (state.over) break;
        if (!list.includes(c)) continue;
        const ops = CARDS[c.cardId].effects.onFriendlyAssetDestroyed;
        if (ops) runOps(state, ev, ops, contractCtx(d.owner, c));
      }
    }
    for (const d of dead) {
      const card = CARDS[d.unit.cardId];
      if (!d.unit.silenced && card.effects.parachute) {
        runOps(state, ev, card.effects.parachute, {
          player: d.owner, sourceUnit: d.unit, target: null, position: d.index,
        });
      }
    }
    // §3d SEVERANCE: after parachutes, an ENEMY-caused death of a live-keyword
    // (non-silenced) severance unit pays out — the OWNER draws a card (real
    // severance is compensation to the departed, not a suit against the
    // company). Emit the `severance` event before its `draw`. Fatigue from an
    // empty deck (if any) is handled by drawCards itself, including the
    // checkHeroes call on lethal fatigue damage.
    for (const d of dead) {
      if (state.over) break;
      if (d.unit.silenced || !hasKw(d.unit, 'severance')) continue;
      if (d.unit.killedBy !== 1 - d.owner) continue;
      ev.push({ e: 'severance', unitId: d.unit.id, cardId: d.unit.cardId, player: d.owner });
      drawCards(state, d.owner, 1, ev);
    }
    // now that this wave's units are fully swept and resolved, see if any of
    // it (or the reactions it triggered) was also lethal to a CEO — end here
    // rather than starting a new wave.
    if (checkHeroes(state, ev)) return;
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
    unit: { id: unit.id, cardId: unit.cardId, attack: effectiveAttack(state, unit, player), health: unit.health, keywords: unit.keywords.slice() },
    position: pos,
  });
  applyAdjacencyBuffs(state, ev, player, pos);
  return unit;
}

// An adjacencyBuff with no `match` applies to any neighbor (Armor Plant); one
// with `match: { tag }` (Bioreactor) only reaches neighbors carrying that tag.
// Reuses auraMatches's tag check, just defaulting to "always matches" when
// the buff itself carries no filter.
function adjacencyMatches(buff, def) {
  return !buff.match || auraMatches(buff.match, def);
}
// Placement-time adjacency buffs (Armor Plant: +1 Integrity to whatever sits
// immediately left/right of it). Baked on deploy — persists even if the source
// later leaves — matching "when placed beside it, gets a buff". Runs BOTH ways:
// a unit dropped next to a granter, and a granter dropped next to existing units.
function applyAdjacencyBuffs(state, ev, player, pos) {
  const board = state.players[player].board;
  const unit = board[pos];
  if (!unit) return;
  // 1) a granter immediately beside the newly-placed unit buffs it
  for (const j of [pos - 1, pos + 1]) {
    const nb = board[j];
    const buff = nb && CARDS[nb.cardId].effects.adjacencyBuff;
    if (buff && adjacencyMatches(buff, CARDS[unit.cardId])) grantStatBuff(ev, unit, buff);
  }
  // 2) if the newly-placed unit is itself a granter, buff its existing neighbors
  const mine = CARDS[unit.cardId].effects.adjacencyBuff;
  if (mine) {
    for (const j of [pos - 1, pos + 1]) {
      if (board[j] && adjacencyMatches(mine, CARDS[board[j].cardId])) grantStatBuff(ev, board[j], mine);
    }
  }
}
function grantStatBuff(ev, unit, buff) {
  const da = buff.attack || 0, dh = buff.health || 0;
  if (!da && !dh) return;
  unit.attack = Math.max(0, unit.attack + da);
  unit.health += dh;
  unit.maxHealth += dh;
  ev.push({ e: 'buff', unitId: unit.id, attack: da, health: dh });
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
      if (found) {
        found.unit.pendingDestroy = true;
        found.unit.killedBy = ctx.player; // §3d: attributed to the caster
      }
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
      found.unit.distracted = 0; // silence cleanses the Flirty Intern debuff too
      ev.push({ e: 'silence', unitId: id });
    }
  },
  // Flirty Intern: charm the target — it can't attack for `turns` of its owner's
  // turns; the counter ticks down at the end of each of those turns (see endTurn).
  distract(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      const found = findUnit(state, id);
      if (!found) continue;
      found.unit.distracted = op.turns || 3;
      ev.push({ e: 'distract', unitId: id, turns: found.unit.distracted });
    }
  },
  special(state, ev, op, ctx) {
    const fn = SPECIALS[op.key];
    if (fn) fn(state, ev, op, ctx);
  },
  // null & void: remove the targeted contract from play (targeting
  // 'enemyContract' — target validation already restricts to enemy contracts)
  nullify(state, ev, op, ctx) {
    for (const id of resolveTargets(state, ctx, op.to)) {
      voidContract(state, ev, id, 'nullified');
    }
  },
  // War Chest (§reserve): bank the owner's unspent Capital onto the SOURCE
  // contract instance, up to `cap` total (default 8). Banking does NOT deduct
  // from capital — it resets at the owner's next startTurn anyway, and a
  // deduction would break dynamicAttack:'capital' units during the opponent's
  // turn. Two filed War Chests therefore bank independently (intended).
  bankCapital(state, ev, op, ctx) {
    const c = ctx.sourceContract;
    if (!c) return;
    const amount = Math.max(0,
      Math.min(state.players[ctx.player].capital, (op.cap ?? 8) - (c.banked || 0)));
    if (amount > 0) {
      c.banked = (c.banked || 0) + amount;
      ev.push({ e: 'bankCapital', player: ctx.player, contractId: c.id, cardId: c.cardId, amount, total: c.banked });
    }
  },
};

// §3c LAYOFF resolution (shared by the `layoff` action and the `layoffTarget`
// special so both paths emit identical events, in the spec-fixed order):
// 1. emit `layoff`; 2. heal the actor's CEO by the unit's CURRENT health
// (captured before removal, uncapped, via the standard heal path); 3. destroy
// through the same path as the `destroy` op (pendingDestroy + standard
// sweepDeaths) so GOLDEN PARACHUTE and onFriendlyAssetDestroyed contract
// triggers (hx_c03, ob_c03) fire normally.
function layoffUnit(state, ev, player, unit) {
  ev.push({ e: 'layoff', unitId: unit.id, cardId: unit.cardId, player });
  healTarget(state, ev, 'hero' + player, unit.health);
  unit.pendingDestroy = true;
  unit.killedBy = player; // §3d: self-sacrifice — owner-caused, so severance must NOT fire
  sweepDeaths(state, ev);
}

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
  // §3c: lay off the targeted friendly asset (targeting 'friendlyUnit' —
  // validTargets already restricts to the caster's own board). Same 3 steps
  // and same `layoff` event as the layoff action, so the client animates
  // both paths identically.
  layoffTarget(state, ev, op, ctx) {
    const found = ctx.target && findUnit(state, ctx.target);
    if (!found) return;
    layoffUnit(state, ev, ctx.player, found.unit);
  },
  // destroy target friendly asset, gain temporary capital equal to its cost
  liquidate(state, ev, op, ctx) {
    const found = ctx.target && findUnit(state, ctx.target);
    if (!found) return;
    found.unit.pendingDestroy = true;
    found.unit.killedBy = ctx.player; // §3d: owner-caused sacrifice, no severance
    const cost = CARDS[found.unit.cardId].cost;
    if (cost > 0) OPS.addCapital(state, ev, { op: 'addCapital', amount: cost }, ctx);
  },
};

function sourceOf(ctx) {
  if (ctx.sourceUnit) return { unit: ctx.sourceUnit, player: ctx.player, id: ctx.sourceUnit.id };
  // no-unit source: an OPERATION or CEO POWER — unless it came from a
  // contract trigger, which is not "operation damage" for opDamageBonus.
  return { player: ctx.player, id: ctx.sourceCardId, isSpell: !ctx.contractSource };
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
  // bigHit taunt tracking is scoped to "this game-turn" for BOTH players (a
  // both-parties contract, for instance, can still hit the non-active player
  // this turn) — reset before any of this turn's own damage effects run.
  for (const pl of state.players) { pl.turnDamage = 0; pl.bigHitFired = false; }
  const p = state.players[player];
  p.maxCapital = Math.min(MAX_CAPITAL, p.maxCapital + 1);
  // RAID: a banked capitalDrain (from a Corporate Raider-style successful
  // attack) reduces THIS turn's capital once, then clears — a one-turn hit,
  // not a lasting maxCapital scar.
  p.capital = Math.max(0, p.maxCapital - p.capitalDrain);
  p.capitalDrain = 0;
  p.assetCapitalBonus = 0; // War Chest: an unspent activated reserve expires with the fresh refill
  p.powerUsed = false;
  for (const u of p.board) u.attacksUsed = 0;
  ev.push({ e: 'turnStart', player, turn: state.turn });
  ev.push({ e: 'capital', player, capital: p.capital, maxCapital: p.maxCapital });
  drawCards(state, player, 1, ev);
  sweepDeaths(state, ev); // fatigue may have been lethal
  // §3b: contract startOfTurn triggers fire after the draw step, then term
  // countdown; the opponent's both-parties contracts fire on this turn too.
  if (!state.over) runContractStartOfTurn(state, player, ev);
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
  // Flirty Intern: tick down "distracted" counters on the ending player's own
  // units (blocked for `turns` of their turns; reaches 0 → can attack again).
  for (const u of state.players[player].board) {
    if (u.distracted > 0) {
      u.distracted -= 1;
      ev.push({ e: 'distract', unitId: u.id, turns: u.distracted });
    }
  }
  // §3b: contract endOfTurn triggers (vx_c02, hx_c01) fire at the end of the
  // owner's turn, after board triggers, before the opponent's turnStart.
  fireContractTrigger(state, ev, player, 'endOfTurn');
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
      if (!PLAYABLE_TYPES.includes(card.type))
        return { ok: false, error: 'card cannot be played' };
      const cost = effectiveCost(state, playerIndex, card);
      if (cost > spendingBudget(p, card)) return { ok: false, error: 'not enough capital' };
      if (card.type === 'ASSET' && p.board.length >= MAX_BOARD)
        return { ok: false, error: 'board is full' };
      if (card.type === 'CONTRACT' && p.contracts.length >= MAX_CONTRACTS)
        return { ok: false, error: 'contract zone is full' };

      const target = action.target ?? null;
      const targeting = card.effects.targeting || null;
      const tc = checkTarget(state, playerIndex, targeting, target, {
        fizzleAllowed: card.type === 'ASSET',
      });
      if (!tc.ok) return tc;

      // War Chest (§reserve): ASSETS drain the activated reserve FIRST, then
      // capital; everything else pays plain capital (budget-gated above).
      if (card.type === 'ASSET') {
        const fromBonus = Math.min(p.assetCapitalBonus, cost);
        p.assetCapitalBonus -= fromBonus;
        p.capital -= cost - fromBonus;
      } else {
        p.capital -= cost;
      }
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
      } else if (card.type === 'CONTRACT') {
        const contract = {
          id: 'c' + state.nextContract++,
          cardId,
          turnsLeft: Number.isInteger(card.term) ? card.term : null,
        };
        // War Chest (§reserve): only reserve contracts carry a private bank;
        // every other contract keeps its exact historical shape.
        if (card.effects.reserve) contract.banked = 0;
        p.contracts.push(contract);
        ev.push({
          e: 'contractFiled', player: playerIndex,
          contract: { id: contract.id, cardId, turnsLeft: contract.turnsLeft },
        });
      } else {
        runOps(state, ev, card.effects.play || [], {
          player: playerIndex, sourceUnit: null, target: tc.target, sourceCardId: cardId,
        });
        sweepDeaths(state, ev);
        // nx_c03: fires after the operation's own effects have fully resolved
        fireContractTrigger(state, ev, playerIndex, 'onOperationPlayed');
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
      // §counters: combat uses LIVE effective attack (base + auras), so a
      // buffed robotic unit actually swings for its boosted number.
      const atkPower = effectiveAttack(state, attacker, playerIndex);
      if (isHeroId(action.targetId)) {
        dealDamage(state, ev, action.targetId, atkPower,
          { unit: attacker, player: playerIndex, id: attacker.id });
      } else {
        const def = findUnit(state, action.targetId);
        const defender = def.unit;
        const defAttack = effectiveAttack(state, defender, def.owner);
        // Affiliate Influencer (§combatBonus): +N vs a matching-class defender,
        // added to the swing before trample math so the bonus carries too.
        const vsPower = atkPower + combatTagBonus(attacker, CARDS[defender.cardId]);
        // BULLISH (trample): assign lethal to the blocker, and any attack beyond
        // its current Integrity spills to the enemy CEO. The two hits sum to the
        // attacker's Attack, so siphon/etc. count the damage exactly once.
        const blockerHp = Math.max(0, defender.health);
        const overflow = hasKw(attacker, 'bullish') ? Math.max(0, vsPower - blockerHp) : 0;
        dealDamage(state, ev, defender.id, overflow > 0 ? blockerHp : vsPower,
          { unit: attacker, player: playerIndex, id: attacker.id });
        if (overflow > 0) {
          dealDamage(state, ev, 'hero' + (1 - playerIndex), overflow,
            { unit: attacker, player: playerIndex, id: attacker.id });
        }
        if (defAttack > 0) {
          dealDamage(state, ev, attacker.id, defAttack,
            { unit: defender, player: 1 - playerIndex, id: defender.id });
        }
      }
      // RAID (Corporate Raider): a successful attack that the raider survives
      // (checked BEFORE the death sweep, so retaliation/toxic already count)
      // banks a one-turn capital steal against the enemy — applied and cleared
      // at the start of their very next turn (see startTurn).
      if (hasKw(attacker, 'raid') && attacker.health > 0 && !attacker.pendingDestroy) {
        const victim = 1 - playerIndex;
        state.players[victim].capitalDrain += 1;
        ev.push({ e: 'capitalRaid', unitId: attacker.id, cardId: attacker.cardId, player: playerIndex, targetPlayer: victim });
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

    // §3c LAYOFF: free sacrifice — no capital cost, no exhaustion requirement
    // (a just-deployed or already-attacked asset may still be laid off).
    case 'layoff': {
      const found = findUnit(state, action.unitId);
      if (!found || found.owner !== playerIndex) return { ok: false, error: 'invalid unit' };
      if (!hasKw(found.unit, 'layoff'))
        return { ok: false, error: 'asset does not have LAYOFF' };
      layoffUnit(state, ev, playerIndex, found.unit);
      return { ok: true, events: ev };
    }

    // War Chest (§reserve): crack open a banked reserve — free, any time on
    // your turn, does not end the turn. The bank becomes ASSET-only spending
    // power for the rest of this turn (cleared at this player's next startTurn).
    case 'activateReserve': {
      const c = p.contracts.find((x) => x.id === action.contractId);
      if (!c) return { ok: false, error: 'invalid contract' };
      if (!CARDS[c.cardId].effects.reserve)
        return { ok: false, error: 'contract has no reserve' };
      if (!(c.banked > 0)) return { ok: false, error: 'reserve is empty' };
      p.assetCapitalBonus += c.banked;
      ev.push({ e: 'reserveActivated', player: playerIndex, contractId: c.id, cardId: c.cardId, amount: c.banked });
      c.banked = 0;
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
    if (!PLAYABLE_TYPES.includes(card.type)) return;
    if (effectiveCost(state, playerIndex, card) > spendingBudget(p, card)) return;
    if (card.type === 'ASSET' && p.board.length >= MAX_BOARD) return;
    if (card.type === 'CONTRACT' && p.contracts.length >= MAX_CONTRACTS) return;
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

  // §3c: one free layoff per LAYOFF-keyword unit (no cost / exhaustion gate;
  // silence empties keywords, so silenced units are excluded automatically)
  for (const unit of p.board) {
    if (hasKw(unit, 'layoff')) actions.push({ type: 'layoff', unitId: unit.id });
  }

  // War Chest (§reserve): free activation for any filed reserve with a bank
  for (const c of p.contracts) {
    if (CARDS[c.cardId].effects.reserve && c.banked > 0)
      actions.push({ type: 'activateReserve', contractId: c.id });
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
  // live effective cost (opCostReduction / contractCostReduction) so display matches playable calc
  const cost = effectiveCost(state, playerIndex, card);
  let playable = false;
  if (isActive && !state.over && PLAYABLE_TYPES.includes(card.type) && cost <= spendingBudget(p, card)) {
    if (card.type === 'ASSET') {
      playable = p.board.length < MAX_BOARD;
    } else if (card.type === 'CONTRACT') {
      playable = p.contracts.length < MAX_CONTRACTS; // max 3 filed
    } else {
      playable = !targeting || validTargets(state, playerIndex, targeting).length > 0;
    }
  }
  const entry = {
    cardId,
    cost,
    playable,
    targeting,
    validPositions: card.type === 'ASSET',
  };
  // dynamic-attack cards preview their live value in hand (= current Capital)
  if (card.effects.dynamicAttack === 'capital') entry.dynAttack = p.capital;
  return entry;
}

function unitView(state, unit, canAct, owner) {
  const ctr = unitCounters(state, owner, unit);
  const v = {
    id: unit.id,
    cardId: unit.cardId,
    attack: effectiveAttack(state, unit, owner), // §counters: live (base + auras)
    health: unit.health,
    maxHealth: unit.maxHealth,
    keywords: unit.keywords.slice(),
    canAttack: canAct ? unitCanAttack(state, unit) : false,
    exhausted: unit.attacksUsed >= maxAttacks(unit),
    damaged: unit.health < unit.maxHealth,
  };
  if (ctr.count) v.counters = ctr; // {atk, count, sources} — omitted when none
  if (unit.distracted > 0) v.distracted = unit.distracted; // Flirty Intern countdown
  if (unit.silenced) v.silenced = true; // Gag Order: stripped of keywords/triggers
  return v;
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
    board: p.board.map((u) => unitView(state, u, self && isActive, i)),
    // §3b: contracts are public — full detail on both `you` and `opp`.
    // EXCEPT a reserve's bank (War Chest): private, owner's own view only.
    contracts: p.contracts.map((c) => {
      const v = { id: c.id, cardId: c.cardId, turnsLeft: c.turnsLeft };
      if (self && CARDS[c.cardId].effects.reserve) v.banked = c.banked;
      return v;
    }),
    deckCount: p.deck.length,
    fatigue: p.fatigue,
    capitalDrain: p.capitalDrain, // RAID: pending capital reduction for this player's next turn
    assetCapitalBonus: p.assetCapitalBonus, // War Chest: activated reserve — public once cracked open, like capital
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
  // contractFiled / contractVoided are public (§3b) and pass through
  // unredacted; the opponent's bankCapital events (War Chest) are DROPPED
  // outright — the bank total is private. reserveActivated stays public.
  return events
    .filter((e) => !(e.e === 'bankCapital' && e.player !== playerIndex))
    .map((e) =>
      e.e === 'draw' && e.player !== playerIndex ? { ...e, cardId: null } : { ...e }
    );
}

// exported for data-integrity tests (engine-internal knowledge)
export const TARGETING_VALUES = TARGETINGS;
