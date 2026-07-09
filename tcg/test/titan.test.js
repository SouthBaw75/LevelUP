// Titan Petrocore (tp): boom-bust energy faction. Covers the five new engine
// primitives (DEPLETION, EXTRACT, BLOWOUT, drawTagBonus, enemyUnitIgnoreVeil)
// through their real printed cards, plus the faction-specific wiring
// (parachute chains, onFriendlyAssetPlayed/adjacencyBuff on the facility tag,
// the CEO power, and the Mineral Rights contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, legalActions, CARDS } from '../shared/engine.js';
import {
  newGame, addUnit, putInHand, giveCapital, fileContract, find, findAll,
} from './helpers.js';

const end = (s) => applyAction(s, s.activePlayer, { type: 'endTurn' });

test('DEPLETION: attacker loses -1/-1 each time it deals damage', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  const attacker = addUnit(s, 0, 'tp_003'); // Test Well, 3/2 DEPLETION
  const defender = addUnit(s, 1, 'ntr_002', { health: 6, maxHealth: 6 }); // survives the trade
  const r = applyAction(s, 0, { type: 'attack', attackerId: attacker.id, targetId: defender.id });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(attacker.attack, 2, 'DEPLETION: 3 -> 2 after dealing damage');
  const buff = findAll(r.events, 'buff').find((e) => e.unitId === attacker.id);
  assert.ok(buff && buff.attack === -1 && buff.health === -1, 'DEPLETION emits a -1/-1 buff event');
});

test('EXTRACT: free self-sacrifice any time for a flat Capital payout', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 0);
  const well = addUnit(s, 0, 'tp_013'); // Stripper Well, EXTRACT 2
  assert.ok(legalActions(s, 0).some((a) => a.type === 'extract' && a.unitId === well.id));
  const r = applyAction(s, 0, { type: 'extract', unitId: well.id });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[0].capital, 2, 'EXTRACT 2 grants exactly 2 Capital');
  assert.equal(s.players[0].board.length, 0, 'the well is sacrificed');
});

test('BLOWOUT: enters buffed by its printed counters, ticks down, detonates on neighbors', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_014'); // Wildcat Prospect: base 2/2, BLOWOUT 3
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  const prospect = s.players[0].board[0];
  assert.equal(prospect.attack, 5, 'enters at printed 2 + 3 counters = 5 attack');
  assert.equal(prospect.health, 5, 'enters at printed 2 + 3 counters = 5 health');
  const left = addUnit(s, 0, 'ntr_002', { health: 6, maxHealth: 6 });
  const right = addUnit(s, 0, 'ntr_002', { health: 6, maxHealth: 6 });
  s.players[0].board = [left, prospect, right];
  end(s); // hand the turn to player 1 so it can legally act
  giveCapital(s, 1, 10);
  for (let i = 0; i < 3; i++) {
    const zapIdx = putInHand(s, 1, 'nx_013'); // Ping: 1 damage to any target
    const zap = applyAction(s, 1, { type: 'playCard', handIndex: zapIdx, target: prospect.id, position: null });
    assert.equal(zap.ok, true, `ping #${i + 1} should be legal: ${zap.error || ''}`);
  }
  assert.equal(s.players[0].board.includes(prospect), false, 'BLOWOUT unit dies once its counters run out');
  // each of the 3 hits ticks off a counter AND a -1/-1 (5/5 -> 4/4 -> 3/3 -> 2/2,
  // with the raw damage on top); the detonation deals damage equal to the
  // FINAL (post-tick) Attack of 2 to each neighbor.
  assert.equal(prospect.attack, 2, 'final attack after 3 ticks: 5 - 3 = 2');
  assert.equal(left.health, 4, 'left neighbor: 6 health - 2 detonation damage = 4');
  assert.equal(right.health, 4, 'right neighbor: 6 health - 2 detonation damage = 4');
});

test('Seismic Survey: draws a bonus card when the top of the deck is a FACILITY asset', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_005');
  s.players[0].deck = ['tp_026', 'tp_008']; // deck.pop() draws from the END: tp_008 (facility) first
  const before = s.players[0].hand.length;
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[0].hand.length, before - 1 + 2, 'top card was FACILITY-tagged -> drew 2');
});

test('Seismic Survey: draws only 1 when the top of the deck is not a FACILITY asset', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_005');
  s.players[0].deck = ['tp_008', 'tp_026']; // top (end) is tp_026, a plain personnel vanilla
  const before = s.players[0].hand.length;
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[0].hand.length, before - 1 + 1, 'non-FACILITY top card -> drew only 1');
});

test('Directional Drilling: ignores CORPORATE VEIL and can target a stealthed asset', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_012');
  const veiled = addUnit(s, 1, 'nx_003'); // Spyware Agent, CORPORATE VEIL, 2/1
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: veiled.id, position: null });
  assert.equal(r.ok, true, `should legally target a veiled unit: ${r.error || ''}`);
  assert.equal(s.players[1].board.includes(veiled), false, '3 damage kills the 2/1 veiled unit');
});

test('Roughneck: GOLDEN PARACHUTE summons a 1/1 Wildcat Crew', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 10);
  const roughneck = addUnit(s, 1, 'tp_002', { health: 1 }); // one hit from death
  const idx = putInHand(s, 0, 'nx_013'); // Ping: 1 damage to any target
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: roughneck.id, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.ok(find(r.events, 'summon'), 'parachute summon fires');
  assert.ok(s.players[1].board.some((u) => u.cardId === 'tp_t_wildcat'), 'Wildcat Crew took the field');
});

test('Test Well: GOLDEN PARACHUTE summons a 1/1 Burning Derrick carrying DEPLETION', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 10);
  const well = addUnit(s, 1, 'tp_003', { health: 1 });
  const idx = putInHand(s, 0, 'nx_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: well.id, position: null });
  assert.equal(r.ok, true, r.error || '');
  const derrick = s.players[1].board.find((u) => u.cardId === 'tp_t_derrick');
  assert.ok(derrick, 'Burning Derrick took the field');
  assert.ok(derrick.keywords.includes('depletion'), 'Burning Derrick carries DEPLETION');
});

test('Blowout Preventer: FIREWALL, and GOLDEN PARACHUTE grants 1 Capital', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 10);
  giveCapital(s, 1, 0);
  const bop = addUnit(s, 1, 'tp_011', { health: 1 });
  assert.ok(bop.keywords.includes('firewall'));
  const idx = putInHand(s, 0, 'nx_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: bop.id, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[1].capital, 1, 'GOLDEN PARACHUTE granted 1 Capital');
});

test('Manufacturing Facility: gains 1 Capital whenever a ROBOTIC asset is played', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'tp_010'); // Manufacturing Facility
  const before = s.players[0].capital;
  const idx = putInHand(s, 0, 'tp_004'); // Iron Roughneck, ROBOTIC
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[0].capital, before - CARDS.tp_004.cost + 1, 'playing a ROBOTIC asset paid off 1 Capital');
});

test('LNG Terminal Facility: GOLDEN PARACHUTE gains 1 Capital per other FACILITY asset controlled', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 5); // headroom below the 10 cap so the +2 gain is observable
  addUnit(s, 0, 'tp_008'); // Pumpjack Field, facility
  addUnit(s, 0, 'tp_009'); // Refinery Facility, facility
  const lng = addUnit(s, 0, 'tp_015', { health: 1 }); // one hit from death
  const before = s.players[0].capital;
  const idx = putInHand(s, 0, 'nx_013'); // Ping: 1 damage to any target
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: lng.id, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[0].capital, before + 2, 'gained 1 Capital per OTHER FACILITY (2), not counting itself');
});

test('Refinery Facility: adjacent ROBOTIC assets gain +1/+1', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'tp_009'); // Refinery Facility at index 0
  const idx = putInHand(s, 0, 'tp_004'); // Iron Roughneck — ROBOTIC
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true, r.error || '');
  const placed = s.players[0].board[1];
  assert.equal(placed.cardId, 'tp_004');
  assert.equal(placed.attack, CARDS.tp_004.attack + 1, 'adjacent ROBOTIC gains +1 attack from Refinery Facility');
  assert.equal(placed.health, CARDS.tp_004.health + 1, 'adjacent ROBOTIC gains +1 health from Refinery Facility');
});

test('Emergency Flare-Off: FLARE deals damage to all assets, including your own', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const mine = addUnit(s, 0, 'ntr_002', { health: 5 });
  const theirs = addUnit(s, 1, 'ntr_002', { health: 5 });
  const idx = putInHand(s, 0, 'tp_025');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(mine.health, 4, 'FLARE hits your own assets too');
  assert.equal(theirs.health, 4, 'FLARE hits enemy assets');
});

test('The Gusher: BLOWOUT 4 and ONBOARDING deals 3 damage to the enemy CEO', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_024');
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, r.error || '');
  const gusher = s.players[0].board[0];
  // BLOWOUT ticks whenever the unit deals OR takes damage (see tickBlowout) —
  // its own ONBOARDING blast counts as "dealt damage", so one counter is
  // already spent by the time it resolves: printed 4 + 4 counters - 1 tick = 7.
  assert.equal(gusher.attack, CARDS.tp_024.attack + 4 - 1, 'ONBOARDING blast ticks its own BLOWOUT counter once');
  assert.equal(gusher.blowoutCounters, 3, 'one of the 4 BLOWOUT counters already spent');
  assert.equal(s.players[1].integrity, before - 3, 'ONBOARDING hit the enemy CEO for 3');
});

test('Drill Baby Drill (CEO power): 2 damage to an asset, gain 1 Capital', () => {
  const s = newGame('titan', 'nexus');
  giveCapital(s, 0, 5);
  const target = addUnit(s, 1, 'ntr_002', { health: 6, maxHealth: 6 });
  const r = applyAction(s, 0, { type: 'heroPower', target: target.id });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(target.health, 4);
  assert.equal(s.players[0].capital, 4, '5 - 2 power cost + 1 gained = 4');
});

test('Mineral Rights: at the start of your turn, gain 1 Capital', () => {
  const s = newGame('titan', 'nexus');
  fileContract(s, 0, 'tp_c01');
  end(s); // -> player 1's turn (owner-only trigger, stays silent)
  end(s); // -> player 0's turn 2: normal ramp (2) + Mineral Rights (+1) = 3
  assert.equal(s.players[0].capital, 3);
});

test('Force Majeure: declares an enemy contract null & void', () => {
  const s = newGame('titan', 'nexus');
  s.activePlayer = 0;
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'tp_007');
  const c = fileContract(s, 1, 'nx_c01');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: c.id, position: null });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(s.players[1].contracts.length, 0);
  assert.ok(find(r.events, 'contractVoided'));
});
