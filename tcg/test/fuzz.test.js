// Full-game fuzz: hundreds of complete random games across all faction
// pairings and seeds. The engine must never crash, never emit an unknown
// event, always terminate, and always produce serializable contract views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, legalActions, getView, redactEvents, cloneState,
  validateDeck, STARTER_DECKS,
} from '../shared/engine.js';

const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian'];
const EVENT_TYPES = new Set([
  'turnStart', 'capital', 'draw', 'mill', 'fatigue', 'cardPlayed', 'summon',
  'attack', 'damage', 'heal', 'shieldBreak', 'death', 'buff', 'keyword',
  'heroPower', 'returnToHand', 'silence', 'transform', 'gameOver',
  'contractFiled', 'contractVoided', 'layoff', 'severance', 'distract', 'capitalRaid',
]);

// independent PRNG for action choice (not the engine's)
function makeRnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

function checkViewBasics(view, playerIndex) {
  const json = JSON.stringify(view);
  assert.ok(json, 'view serializes');
  assert.equal(view.you.index, playerIndex);
  assert.equal(view.opp.index, 1 - playerIndex);
  assert.ok(Number.isInteger(view.turn) && view.turn >= 1);
  assert.ok(view.activePlayer === 0 || view.activePlayer === 1);
  assert.ok(Array.isArray(view.you.hand));
  assert.equal(view.opp.hand, undefined, 'opponent hand never exposed');
  assert.ok(Number.isInteger(view.opp.handCount));
  assert.ok(view.you.board.length <= 7 && view.opp.board.length <= 7);
  assert.equal(typeof view.over, 'boolean');
  for (const h of view.you.hand) {
    assert.equal(typeof h.cardId, 'string');
    assert.equal(typeof h.playable, 'boolean');
  }
  for (const u of [...view.you.board, ...view.opp.board]) {
    assert.ok(u.health >= 1, 'no dead unit remains on a board');
  }
  for (const u of view.opp.board) assert.equal(u.canAttack, false);
  // contracts are public on both sides, max 3, exact shape
  for (const side of [view.you, view.opp]) {
    assert.ok(Array.isArray(side.contracts), 'contracts array present');
    assert.ok(side.contracts.length <= 3, 'max 3 filed contracts');
    for (const c of side.contracts) {
      assert.deepEqual(Object.keys(c).sort(), ['cardId', 'id', 'turnsLeft']);
      assert.match(c.id, /^c\d+$/);
      assert.ok(c.turnsLeft === null || (Number.isInteger(c.turnsLeft) && c.turnsLeft >= 1));
    }
  }
}

function playGame(seed, f0, f1, decks) {
  const state = createGame({
    decks: decks || [STARTER_DECKS[f0], STARTER_DECKS[f1]],
    names: ['Fuzz0', 'Fuzz1'],
    seed,
  });
  const rnd = makeRnd(seed * 2654435761 + 1);
  let steps = 0;
  while (!state.over) {
    assert.ok(steps < 10000, `game did not terminate (seed ${seed} ${f0}v${f1})`);
    const active = state.activePlayer;
    assert.deepEqual(legalActions(state, 1 - active), [], 'no legal actions off-turn');
    const acts = legalActions(state, active);
    assert.ok(acts.length >= 1, 'endTurn always available');
    assert.ok(acts.some((a) => a.type === 'endTurn'));
    const action = acts[Math.floor(rnd() * acts.length)];
    const r = applyAction(state, active, action);
    assert.equal(r.ok, true,
      `legal action rejected (seed ${seed}): ${JSON.stringify(action)} -> ${r.error}`);
    for (const e of r.events) {
      assert.ok(EVENT_TYPES.has(e.e), `unknown event type ${e.e}`);
    }
    // redaction must not leak opponent draws
    for (const pi of [0, 1]) {
      for (const e of redactEvents(r.events, pi)) {
        if (e.e === 'draw' && e.player !== pi) assert.equal(e.cardId, null);
      }
    }
    if (steps % 13 === 0) {
      checkViewBasics(getView(state, 0), 0);
      checkViewBasics(getView(state, 1), 1);
    }
    steps++;
  }
  assert.ok(state.winner === 0 || state.winner === 1);
  checkViewBasics(getView(state, 0), 0);
  checkViewBasics(getView(state, 1), 1);
  return steps;
}

test('fuzz: 224 complete random games across all faction pairings', () => {
  let total = 0;
  let games = 0;
  for (let seed = 0; seed < 224; seed++) {
    const f0 = FACTIONS[seed % 4];
    const f1 = FACTIONS[(seed >> 2) % 4];
    total += playGame(seed, f0, f1);
    games++;
  }
  assert.equal(games, 224);
  assert.ok(total > 224 * 10, 'games actually played out');
});

// Contract-stuffed decks: 2x every faction contract + 2x each neutral answer,
// filled back to 40 from the faction's starter list. Contracts add both extra
// damage (vx_c02/vx_c03/ob_c01/nx_c03) and extra healing (hx_c01/hx_c02/hx_c03),
// but healing is flat per turn while fatigue escalates without bound, so the
// existing 10000-step cap still comfortably terminates every game — no cap
// raise was needed.
function contractDeck(faction) {
  const prefix = { nexus: 'nx', vulcan: 'vx', helix: 'hx', obsidian: 'ob' }[faction];
  const cards = [];
  const add = (id) => {
    if (cards.length < 40 && cards.filter((x) => x === id).length < 2) cards.push(id);
  };
  for (const n of [1, 2, 3]) { const id = `${prefix}_c0${n}`; add(id); add(id); }
  for (const id of ['ntr_c01', 'ntr_c01', 'ntr_c02', 'ntr_c02']) add(id);
  for (const id of STARTER_DECKS[faction].cards) add(id);
  return { faction, cards };
}

test('fuzz: contract-heavy games still terminate and views stay valid', () => {
  for (const f of FACTIONS) {
    assert.deepEqual(validateDeck(contractDeck(f)), { ok: true }, f + ' contract deck validates');
  }
  let total = 0;
  for (let seed = 1000; seed < 1032; seed++) {
    const f0 = FACTIONS[seed % 4];
    const f1 = FACTIONS[(seed >> 2) % 4];
    total += playGame(seed, f0, f1, [contractDeck(f0), contractDeck(f1)]);
  }
  assert.ok(total > 32 * 10, 'games actually played out');
});

test('fuzz: determinism — same seed and action script replays identically', () => {
  for (const seed of [3, 77, 1234]) {
    const mk = () => createGame({
      decks: [STARTER_DECKS.helix, STARTER_DECKS.obsidian],
      names: ['A', 'B'],
      seed,
    });
    const s1 = mk();
    const rnd = makeRnd(seed + 99);
    const script = [];
    while (!s1.over && script.length < 2000) {
      const acts = legalActions(s1, s1.activePlayer);
      const a = acts[Math.floor(rnd() * acts.length)];
      script.push([s1.activePlayer, a]);
      assert.ok(applyAction(s1, s1.activePlayer, a).ok);
    }
    const s2 = mk();
    for (const [pi, a] of script) {
      const r = applyAction(s2, pi, a);
      assert.equal(r.ok, true, 'replay accepted');
    }
    assert.equal(JSON.stringify(s2), JSON.stringify(s1), 'identical final state');
  }
});

test('fuzz: cloneState mid-game is safe for bot simulation', () => {
  const state = createGame({
    decks: [STARTER_DECKS.vulcan, STARTER_DECKS.nexus],
    names: ['A', 'B'],
    seed: 555,
  });
  const rnd = makeRnd(1);
  for (let i = 0; i < 60 && !state.over; i++) {
    const acts = legalActions(state, state.activePlayer);
    // simulate every legal action on a clone; original must be untouched
    const before = JSON.stringify(state);
    for (const a of acts.slice(0, 5)) {
      const c = cloneState(state);
      applyAction(c, c.activePlayer, a);
    }
    assert.equal(JSON.stringify(state), before, 'clone simulation left state untouched');
    const a = acts[Math.floor(rnd() * acts.length)];
    assert.ok(applyAction(state, state.activePlayer, a).ok);
  }
});
