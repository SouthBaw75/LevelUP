// Rules coverage: turn structure, resources, draw, keywords, combat, targeting,
// death sweep, win conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, legalActions, getView, redactEvents, cloneState,
  CARDS, STARTER_DECKS,
} from '../shared/engine.js';
import { newGame, addUnit, putInHand, giveCapital, find, findAll } from './helpers.js';

const end = (s) => applyAction(s, s.activePlayer, { type: 'endTurn' });

// ---------------------------------------------------------------------------
// Opening / capital
// ---------------------------------------------------------------------------
test('opening hands: 3+turn-draw going first, 4+subsidy going second', () => {
  const s = newGame();
  assert.equal(s.activePlayer, 0);
  assert.equal(s.turn, 1);
  assert.equal(s.players[0].hand.length, 4); // 3 + start-of-turn draw
  assert.equal(s.players[1].hand.length, 5); // 4 + subsidy
  assert.ok(s.players[1].hand.includes('ntr_subsidy'));
  assert.equal(s.players[0].deck.length, 26);
  assert.equal(s.players[1].deck.length, 26);
});

test('capital ramps +1 per own turn, caps at 10, refills at turn start', () => {
  const s = newGame();
  assert.equal(s.players[0].capital, 1);
  assert.equal(s.players[0].maxCapital, 1);
  end(s); // -> p1 turn
  assert.equal(s.players[1].maxCapital, 1);
  end(s); // -> p0 turn 2
  assert.equal(s.players[0].maxCapital, 2);
  assert.equal(s.players[0].capital, 2);
  for (let i = 0; i < 24; i++) end(s);
  assert.equal(s.players[0].maxCapital, 10, 'capped at 10');
  assert.equal(s.players[1].maxCapital, 10);
});

test('spent capital refills to max next turn', () => {
  const s = newGame();
  end(s);
  const p1 = s.players[1];
  const idx = putInHand(s, 1, 'nx_013'); // 0-cost, but spend via subsidy interplay below
  p1.capital = 0; // pretend all spent
  end(s); end(s); // back to p1's turn
  assert.equal(p1.capital, p1.maxCapital);
});

test('Government Subsidy gives 1 capital this turn only', () => {
  const s = newGame();
  end(s); // p1 turn, capital 1
  const p1 = s.players[1];
  const idx = p1.hand.indexOf('ntr_subsidy');
  const r = applyAction(s, 1, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(p1.capital, 2, 'temp capital');
  assert.equal(p1.maxCapital, 1, 'max unchanged');
  assert.ok(find(r.events, 'capital'));
  end(s); end(s); // p1 turn 2
  assert.equal(p1.capital, 2, 'refill to normal max (2), no leftover');
});

// ---------------------------------------------------------------------------
// Draw, fatigue, mill
// ---------------------------------------------------------------------------
test('fatigue deals escalating damage on empty draws', () => {
  const s = newGame();
  s.players[0].deck = [];
  s.players[1].deck = [];
  end(s); // p1 draws: fatigue 1
  assert.equal(s.players[1].fatigue, 1);
  assert.equal(s.players[1].integrity, 29);
  end(s); // p0 fatigue 1
  end(s); // p1 fatigue 2
  assert.equal(s.players[1].fatigue, 2);
  assert.equal(s.players[1].integrity, 27);
  end(s); end(s); // p1 fatigue 3
  assert.equal(s.players[1].integrity, 24);
});

test('fatigue eventually kills and ends the game', () => {
  const s = newGame();
  s.players[0].deck = [];
  s.players[1].deck = [];
  s.players[1].integrity = 3;
  end(s); // fatigue 1 -> 2
  end(s);
  const r = end(s); // p1 fatigue 2 -> 0
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  const over = find(r.events, 'gameOver');
  assert.equal(over.reason, 'takeover');
  // no further actions accepted
  assert.equal(applyAction(s, 0, { type: 'endTurn' }).ok, false);
  assert.deepEqual(legalActions(s, 0), []);
});

test('drawing beyond 10 cards shreds the card (mill event)', () => {
  const s = newGame();
  const p1 = s.players[1];
  while (p1.hand.length < 10) p1.hand.push('ntr_001');
  const topCard = p1.deck[p1.deck.length - 1];
  const r = end(s); // p1 draws into a full hand
  const mill = find(r.events, 'mill');
  assert.ok(mill);
  assert.equal(mill.player, 1);
  assert.equal(mill.cardId, topCard);
  assert.equal(p1.hand.length, 10);
  assert.ok(!find(r.events, 'draw'));
});

// ---------------------------------------------------------------------------
// Board limit / playing assets
// ---------------------------------------------------------------------------
test('board limit of 7 assets is enforced', () => {
  const s = newGame();
  giveCapital(s, 0);
  for (let i = 0; i < 7; i++) addUnit(s, 0, 'ntr_001');
  const idx = putInHand(s, 0, 'ntr_002');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, false);
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'playCard' && a.handIndex === idx));
  // view says not playable
  const v = getView(s, 0);
  assert.equal(v.you.hand[idx].playable, false);
});

test('playCard costs capital, emits cardPlayed+summon, position respected', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  addUnit(s, 0, 'ntr_001');
  addUnit(s, 0, 'ntr_002');
  const idx = putInHand(s, 0, 'ntr_005');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 3);
  const played = find(r.events, 'cardPlayed');
  assert.deepEqual(played, { e: 'cardPlayed', player: 0, cardId: 'ntr_005', handIndex: idx });
  const summon = find(r.events, 'summon');
  assert.equal(summon.position, 1);
  assert.equal(s.players[0].board[1].cardId, 'ntr_005');
});

test('cannot play a card you cannot afford', () => {
  const s = newGame();
  const idx = putInHand(s, 0, 'vx_013'); // cost 6, capital is 1
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /capital/);
});

// ---------------------------------------------------------------------------
// Summoning sickness / FAST-TRACK / OVERTIME
// ---------------------------------------------------------------------------
test('summoning sickness: freshly played assets cannot attack until next turn', () => {
  const s = newGame();
  giveCapital(s, 0);
  const idx = putInHand(s, 0, 'ntr_005');
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  const unit = s.players[0].board[0];
  const r = applyAction(s, 0, { type: 'attack', attackerId: unit.id, targetId: 'hero1' });
  assert.equal(r.ok, false);
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'attack'));
  end(s); end(s); // back to p0
  const r2 = applyAction(s, 0, { type: 'attack', attackerId: unit.id, targetId: 'hero1' });
  assert.equal(r2.ok, true);
});

test('FAST-TRACK attacks the turn it is deployed', () => {
  const s = newGame();
  giveCapital(s, 0);
  const idx = putInHand(s, 0, 'vx_002');
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  const unit = s.players[0].board[0];
  const r = applyAction(s, 0, { type: 'attack', attackerId: unit.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, 28);
});

test('OVERTIME allows exactly two attacks per turn', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'vx_007'); // 2/3 overtime
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, false);
  assert.equal(s.players[1].integrity, 26);
  end(s); end(s);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
});

test('a normal asset attacks once per turn', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'ntr_005');
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, false);
});

// ---------------------------------------------------------------------------
// Combat math
// ---------------------------------------------------------------------------
test('asset vs asset combat is simultaneous', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_006'); // 3/2
  const d = addUnit(s, 1, 'ntr_013'); // 4/5
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: d.id });
  assert.equal(r.ok, true);
  assert.ok(find(r.events, 'attack'));
  assert.equal(findAll(r.events, 'damage').length, 2);
  assert.equal(d.health, 2, 'defender took 3');
  assert.equal(s.players[0].board.length, 0, 'attacker died to counterattack');
  const death = find(r.events, 'death');
  assert.equal(death.unitId, a.id);
});

test('attacking the CEO: only the attacker deals damage', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_006'); // 3/2
  applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' });
  assert.equal(s.players[1].integrity, 27);
  assert.equal(a.health, 2, 'attacker untouched');
});

// ---------------------------------------------------------------------------
// FIREWALL
// ---------------------------------------------------------------------------
test('FIREWALL forces attackers (units and CEO both protected)', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_006');
  const fw = addUnit(s, 1, 'ntr_007'); // 2/2 firewall
  const other = addUnit(s, 1, 'ntr_001');
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' }).ok, false);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: other.id }).ok, false);
  const legal = legalActions(s, 0).filter((x) => x.type === 'attack');
  assert.deepEqual(legal.map((x) => x.targetId), [fw.id]);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: fw.id }).ok, true);
});

test('a stealthed FIREWALL cannot be attacked and does not force', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_006');
  const fw = addUnit(s, 1, 'ntr_007');
  fw.keywords.push('stealth');
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: fw.id }).ok, false);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' }).ok, true);
});

// ---------------------------------------------------------------------------
// STEALTH
// ---------------------------------------------------------------------------
test('STEALTH: unattackable and untargetable by the enemy until it deals damage', () => {
  const s = newGame();
  giveCapital(s, 0);
  const spy = addUnit(s, 1, 'ntr_021'); // 3/2 stealth (enemy's)
  const a = addUnit(s, 0, 'ntr_006');
  // cannot attack it
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: spy.id }).ok, false);
  // cannot target it with an operation
  const idx = putInHand(s, 0, 'nx_016'); // 3 dmg to an asset
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: spy.id, position: null });
  assert.equal(r.ok, false);
  // not offered in legalActions targets
  const targets = legalActions(s, 0)
    .filter((x) => x.type === 'playCard' && x.handIndex === idx).map((x) => x.target);
  assert.ok(!targets.includes(spy.id));
});

test('you CAN target your own stealthed asset; stealth breaks when it deals damage', () => {
  const s = newGame();
  giveCapital(s, 0);
  const mine = addUnit(s, 0, 'ntr_021'); // my stealth unit
  const idx = putInHand(s, 0, 'hx_002'); // +1/+2 friendly
  s.players[0].faction = 'nexus'; // any faction can be in hand for engine purposes
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: mine.id, position: null });
  assert.equal(r.ok, true);
  // attack -> deals damage -> stealth breaks
  applyAction(s, 0, { type: 'attack', attackerId: mine.id, targetId: 'hero1' });
  assert.ok(!mine.keywords.includes('stealth'));
});

// ---------------------------------------------------------------------------
// PATENT PROTECTION (shielded)
// ---------------------------------------------------------------------------
test('shield absorbs the first damage with a shieldBreak event', () => {
  const s = newGame();
  const shielded = addUnit(s, 1, 'ntr_004'); // 1/1 shielded
  const a = addUnit(s, 0, 'ntr_006'); // 3/2
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: shielded.id });
  assert.equal(r.ok, true);
  assert.ok(find(r.events, 'shieldBreak'));
  assert.equal(shielded.health, 1, 'no damage through shield');
  assert.ok(!shielded.keywords.includes('shielded'));
  assert.equal(a.health, 1, 'counterattack still lands on attacker');
  // second hit goes through
  const b = addUnit(s, 0, 'ntr_003'); // 2/1
  const r2 = applyAction(s, 0, { type: 'attack', attackerId: b.id, targetId: shielded.id });
  assert.equal(r2.ok, true);
  assert.equal(s.players[1].board.length, 0);
});

// ---------------------------------------------------------------------------
// TOXIC / SIPHON
// ---------------------------------------------------------------------------
test('TOXIC destroys any asset it damages', () => {
  const s = newGame();
  const troll = addUnit(s, 0, 'ntr_020'); // 1/1 toxic
  const big = addUnit(s, 1, 'vx_013'); // 6/7
  const r = applyAction(s, 0, { type: 'attack', attackerId: troll.id, targetId: big.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'big asset destroyed by toxic');
  assert.equal(s.players[0].board.length, 0, 'toxic unit died to counterattack');
});

test('TOXIC does not destroy through a shield (0 damage dealt)', () => {
  const s = newGame();
  const troll = addUnit(s, 0, 'ntr_020');
  troll.health = 10; // survive the exchange for clarity
  troll.maxHealth = 10;
  const shielded = addUnit(s, 1, 'ntr_025'); // 6/6 shielded
  applyAction(s, 0, { type: 'attack', attackerId: troll.id, targetId: shielded.id });
  assert.equal(s.players[1].board.length, 1, 'shielded unit survives toxic hit');
});

test('SIPHON heals your CEO for damage dealt (both attack and defense)', () => {
  const s = newGame();
  s.players[0].integrity = 20;
  const leech = addUnit(s, 0, 'hx_012'); // 4/5 siphon
  const target = addUnit(s, 1, 'ntr_013'); // 4/5
  const r = applyAction(s, 0, { type: 'attack', attackerId: leech.id, targetId: target.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].integrity, 24);
  assert.ok(find(r.events, 'heal'));
});

test('SIPHON never overheals past 30', () => {
  const s = newGame();
  s.players[0].integrity = 29;
  const leech = addUnit(s, 0, 'hx_012');
  applyAction(s, 0, { type: 'attack', attackerId: leech.id, targetId: 'hero1' });
  assert.equal(s.players[0].integrity, 30);
});

// ---------------------------------------------------------------------------
// ONBOARDING / GOLDEN PARACHUTE
// ---------------------------------------------------------------------------
test('ONBOARDING runs when played from hand (draw)', () => {
  const s = newGame();
  giveCapital(s, 0);
  const before = s.players[0].hand.length;
  const idx = putInHand(s, 0, 'nx_002'); // onboarding: draw 1
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].hand.length, before + 1); // -played +drawn ... net +0? see below
  assert.ok(find(r.events, 'draw'));
});

test('targeted ONBOARDING requires a valid target when one exists, fizzles when none', () => {
  const s = newGame();
  giveCapital(s, 0);
  // no enemy assets: Cease & Desist can be played with no target (fizzles)
  const idx = putInHand(s, 0, 'nx_008');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.ok(!find(r.events, 'returnToHand'));
  // with an enemy asset, target becomes mandatory
  const enemy = addUnit(s, 1, 'ntr_005');
  const idx2 = putInHand(s, 0, 'nx_008');
  const bad = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: null, position: null });
  assert.equal(bad.ok, false);
  const good = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: enemy.id, position: null });
  assert.equal(good.ok, true);
  assert.ok(find(good.events, 'returnToHand'));
  assert.ok(s.players[1].hand.includes('ntr_005'));
});

test('GOLDEN PARACHUTE fires on death', () => {
  const s = newGame();
  const exec = addUnit(s, 1, 'ob_007'); // parachute: draw
  const a = addUnit(s, 0, 'vx_013'); // 6/7
  const handBefore = s.players[1].hand.length;
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: exec.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].hand.length, handBefore + 1, 'opponent drew from parachute');
  const draw = find(r.events, 'draw');
  assert.equal(draw.player, 1);
});

test('parachute chains resolve until stable (pod -> spore)', () => {
  const s = newGame();
  giveCapital(s, 0);
  const pod = addUnit(s, 1, 'hx_018'); // 1/1, parachute: summon spore
  const idx = putInHand(s, 0, 'nx_013'); // ping
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: pod.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 1);
  assert.equal(s.players[1].board[0].cardId, 'hx_t_spore');
  const summon = find(r.events, 'summon');
  assert.equal(summon.unit.cardId, 'hx_t_spore');
});

test('parachute summons respect the board limit', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const hydra = addUnit(s, 1, 'hx_017'); // parachute: summon two 3/3
  for (let i = 0; i < 6; i++) addUnit(s, 1, 'ntr_001'); // board now 7
  hydra.health = 1;
  const idx = putInHand(s, 0, 'nx_013');
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: hydra.id, position: null });
  // 7 -> death -> 6 -> only ONE clone fits
  assert.equal(s.players[1].board.length, 7);
  assert.equal(s.players[1].board.filter((u) => u.cardId === 'hx_t_hydra').length, 1);
});

test('mid-combat deaths trigger both parachutes', () => {
  const s = newGame();
  const clerk0 = addUnit(s, 0, 'ntr_008'); // 2/1 parachute draw
  const clerk1 = addUnit(s, 1, 'ntr_008');
  const h0 = s.players[0].hand.length;
  const h1 = s.players[1].hand.length;
  applyAction(s, 0, { type: 'attack', attackerId: clerk0.id, targetId: clerk1.id });
  assert.equal(s.players[0].board.length, 0);
  assert.equal(s.players[1].board.length, 0);
  assert.equal(s.players[0].hand.length, h0 + 1);
  assert.equal(s.players[1].hand.length, h1 + 1);
});

// ---------------------------------------------------------------------------
// Win conditions
// ---------------------------------------------------------------------------
test('reducing the enemy CEO to 0 wins immediately', () => {
  const s = newGame();
  s.players[1].integrity = 3;
  const a = addUnit(s, 0, 'ntr_006'); // 3 attack
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' });
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  const over = find(r.events, 'gameOver');
  assert.deepEqual(over, { e: 'gameOver', winner: 0, reason: 'takeover' });
});

test('simultaneous CEO death: the active player wins', () => {
  const s = newGame();
  giveCapital(s, 0);
  s.players[0].integrity = 0;
  s.players[1].integrity = 0;
  const idx = putInHand(s, 0, 'nx_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: 'hero1', position: null });
  assert.equal(r.ok, true);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0, 'active player wins the tie');
});

test('concede works for either player at any time', () => {
  const s = newGame();
  const r = applyAction(s, 1, { type: 'concede' }); // off-turn
  assert.equal(r.ok, true);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.deepEqual(find(r.events, 'gameOver'), { e: 'gameOver', winner: 0, reason: 'concede' });
});

// ---------------------------------------------------------------------------
// CEO powers
// ---------------------------------------------------------------------------
test('CEO power: costs 2, once per turn, resets next turn (vulcan ping)', () => {
  const s = newGame('vulcan', 'helix');
  giveCapital(s, 0, 5);
  const r = applyAction(s, 0, { type: 'heroPower', target: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, 29);
  assert.equal(s.players[0].capital, 3);
  assert.ok(find(r.events, 'heroPower'));
  assert.equal(applyAction(s, 0, { type: 'heroPower', target: 'hero1' }).ok, false, 'once per turn');
  assert.equal(getView(s, 0).you.power.used, true);
  end(s); end(s);
  assert.equal(getView(s, 0).you.power.used, false);
  assert.equal(applyAction(s, 0, { type: 'heroPower', target: 'hero1' }).ok, true);
});

test('CEO power rejected without capital; targeting exposed in view', () => {
  const s = newGame('vulcan', 'helix');
  assert.equal(s.players[0].capital, 1);
  assert.equal(applyAction(s, 0, { type: 'heroPower', target: 'hero1' }).ok, false);
  assert.equal(getView(s, 0).you.power.targeting, 'any');
  assert.equal(getView(s, 1).you.power.targeting, 'any'); // helix heal
  const s2 = newGame('nexus', 'obsidian');
  assert.equal(getView(s2, 0).you.power.targeting, null);
  assert.equal(getView(s2, 1).you.power.targeting, null);
});

test('nexus power draws and self-damages; obsidian power summons a Shell Corp', () => {
  const s = newGame('nexus', 'obsidian');
  giveCapital(s, 0, 2);
  const hand = s.players[0].hand.length;
  const r = applyAction(s, 0, { type: 'heroPower', target: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].hand.length, hand + 1);
  assert.equal(s.players[0].integrity, 28);
  end(s);
  giveCapital(s, 1, 2);
  const r2 = applyAction(s, 1, { type: 'heroPower', target: null });
  assert.equal(r2.ok, true);
  assert.equal(s.players[1].board[0].cardId, 'ob_t_shell');
});

test('helix power can heal a damaged asset', () => {
  const s = newGame('helix', 'vulcan');
  giveCapital(s, 0, 2);
  const u = addUnit(s, 0, 'ntr_013');
  u.health = 2;
  const r = applyAction(s, 0, { type: 'heroPower', target: u.id });
  assert.equal(r.ok, true);
  assert.equal(u.health, 4);
});

// ---------------------------------------------------------------------------
// DSL ops via cards
// ---------------------------------------------------------------------------
test('aoeDamage: System Purge hits all enemy assets only', () => {
  const s = newGame();
  giveCapital(s, 0);
  const mine = addUnit(s, 0, 'ntr_013');
  const e1 = addUnit(s, 1, 'ntr_005'); // 2/3
  const e2 = addUnit(s, 1, 'ntr_001'); // 1/1
  const idx = putInHand(s, 0, 'nx_017');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(mine.health, 5, 'friendly untouched');
  assert.equal(e1.health, 1);
  assert.equal(s.players[1].board.length, 1, 'the 1/1 died');
});

test('buff: Depreciation (-2/-2) can kill; Team Building buffs all friendlies', () => {
  const s = newGame();
  giveCapital(s, 0);
  const weak = addUnit(s, 1, 'ntr_005'); // 2/3
  const idx = putInHand(s, 0, 'ob_018');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: weak.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(weak.health, 1);
  const buff = find(r.events, 'buff');
  assert.deepEqual(buff, { e: 'buff', unitId: weak.id, attack: -2, health: -2 });
  // -2/-2 again kills it
  const idx2 = putInHand(s, 0, 'ob_018');
  const r2 = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: weak.id, position: null });
  assert.ok(find(r2.events, 'death'));
  assert.equal(s.players[1].board.length, 0);
  // team building
  const a = addUnit(s, 0, 'ntr_001');
  const b = addUnit(s, 0, 'ntr_002');
  const idx3 = putInHand(s, 0, 'ntr_026');
  applyAction(s, 0, { type: 'playCard', handIndex: idx3, target: null, position: null });
  assert.equal(a.attack, 2); assert.equal(a.health, 2);
  assert.equal(b.attack, 2); assert.equal(b.health, 3);
});

test('grantKeyword: Mandatory Overtime enables a second attack', () => {
  const s = newGame();
  giveCapital(s, 0);
  const u = addUnit(s, 0, 'ntr_005');
  applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' });
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, false);
  const idx = putInHand(s, 0, 'ntr_028');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: u.id, position: null });
  assert.ok(find(r.events, 'keyword'));
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
});

test('destroy: Market Crash destroys all assets, parachutes still fire', () => {
  const s = newGame();
  giveCapital(s, 0);
  addUnit(s, 0, 'ntr_013');
  addUnit(s, 1, 'ntr_013');
  addUnit(s, 1, 'hx_018'); // parachute: spore
  const idx = putInHand(s, 0, 'ob_014');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(findAll(r.events, 'death').length, 3);
  assert.equal(s.players[0].board.length, 0);
  assert.equal(s.players[1].board.length, 1, 'spore from parachute survives the crash');
  assert.equal(s.players[1].board[0].cardId, 'hx_t_spore');
});

test('returnToHand: bounced unit goes to owner hand; mills if hand full', () => {
  const s = newGame();
  giveCapital(s, 0);
  const enemy = addUnit(s, 1, 'ntr_013');
  const idx = putInHand(s, 0, 'nx_014');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: enemy.id, position: null });
  assert.ok(find(r.events, 'returnToHand'));
  assert.ok(s.players[1].hand.includes('ntr_013'));
  // full hand: bounce destroys
  const enemy2 = addUnit(s, 1, 'ntr_016');
  while (s.players[1].hand.length < 10) s.players[1].hand.push('ntr_001');
  const idx2 = putInHand(s, 0, 'nx_014');
  const r2 = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: enemy2.id, position: null });
  assert.equal(r2.ok, true);
  assert.ok(find(r2.events, 'mill'));
  assert.equal(s.players[1].hand.length, 10);
  assert.equal(s.players[1].board.length, 0);
});

test('transform: Deprecate turns an enemy asset into 1/1 Legacy Code', () => {
  const s = newGame();
  giveCapital(s, 0);
  const big = addUnit(s, 1, 'vx_013');
  const idx = putInHand(s, 0, 'nx_018');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: big.id, position: null });
  assert.equal(r.ok, true);
  const t = find(r.events, 'transform');
  assert.deepEqual(t, { e: 'transform', unitId: big.id, cardId: 'nx_t_legacy' });
  assert.equal(big.attack, 1);
  assert.equal(big.health, 1);
});

test('silence: Gag Order strips keywords and disables parachutes', () => {
  const s = newGame();
  giveCapital(s, 0);
  const exec = addUnit(s, 1, 'ob_007'); // parachute draw
  exec.keywords.push('firewall');
  const idx = putInHand(s, 0, 'ntr_029');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: exec.id, position: null });
  assert.ok(find(r.events, 'silence'));
  assert.deepEqual(exec.keywords, []);
  const hand1 = s.players[1].hand.length;
  const a = addUnit(s, 0, 'vx_013');
  applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: exec.id });
  assert.equal(s.players[1].hand.length, hand1, 'silenced parachute did not fire');
});

test('discardRandom: Talent Poacher makes the opponent discard (mill event)', () => {
  const s = newGame();
  giveCapital(s, 0);
  const before = s.players[1].hand.length;
  const idx = putInHand(s, 0, 'ntr_030');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].hand.length, before - 1);
  const mill = find(r.events, 'mill');
  assert.equal(mill.player, 1);
});

test('addCapital permanent: Aggressive Expansion ramps max capital', () => {
  const s = newGame('obsidian', 'nexus');
  giveCapital(s, 0, 3);
  s.players[0].maxCapital = 3;
  const idx = putInHand(s, 0, 'ob_006');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].maxCapital, 4);
  assert.equal(s.players[0].capital, 2); // 3 - 2 cost + 1
  end(s); end(s);
  assert.equal(s.players[0].maxCapital, 5, 'ramp persisted through turn growth');
});

test('special stealUnit: Hostile Takeover moves an enemy asset to your board', () => {
  const s = newGame();
  giveCapital(s, 0);
  const big = addUnit(s, 1, 'vx_013', { attack: 8, maxHealth: 9, health: 9 }); // buffed
  const idx = putInHand(s, 0, 'ob_015');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: big.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0);
  assert.equal(s.players[0].board.length, 1);
  const stolen = s.players[0].board[0];
  assert.equal(stolen.cardId, 'vx_013');
  assert.equal(stolen.attack, 8, 'buffs preserved');
  assert.equal(stolen.health, 9);
  assert.notEqual(stolen.id, big.id, 'new unit id');
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'attack'), 'stolen unit is summoning-sick');
});

test('special summonCopy: Mitosis copies current stats', () => {
  const s = newGame();
  giveCapital(s, 0);
  const u = addUnit(s, 0, 'hx_003', { attack: 5, health: 6, maxHealth: 6 });
  const idx = putInHand(s, 0, 'hx_010');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: u.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board.length, 2);
  const copy = s.players[0].board[1];
  assert.equal(copy.attack, 5);
  assert.equal(copy.health, 6);
});

test('special liquidate: The Liquidator converts a friendly asset into capital', () => {
  const s = newGame();
  giveCapital(s, 0, 6);
  addUnit(s, 0, 'ntr_013'); // cost 4
  const idx = putInHand(s, 0, 'ob_016');
  const target = s.players[0].board[0];
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: target.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 4, '6 - 6 cost + 4 refund');
  assert.equal(s.players[0].board.length, 1, 'sacrificed asset destroyed');
  assert.equal(s.players[0].board[0].cardId, 'ob_016');
});

test('endOfTurn trigger: The Algorithm draws at end of its controller turn', () => {
  const s = newGame();
  addUnit(s, 0, 'nx_012');
  const before = s.players[0].hand.length;
  const r = end(s);
  // draw for p0 (algorithm) then draw for p1 (turn start)
  const draws = findAll(r.events, 'draw');
  assert.equal(draws[0].player, 0);
  assert.equal(s.players[0].hand.length, before + 1);
});

// ---------------------------------------------------------------------------
// Views / redaction / cloning / bad input
// ---------------------------------------------------------------------------
test('getView matches the contract shape and hides the opponent hand', () => {
  const s = newGame();
  giveCapital(s, 0);
  addUnit(s, 0, 'ntr_007');
  const v = getView(s, 0);
  assert.deepEqual(Object.keys(v).sort(),
    ['activePlayer', 'opp', 'over', 'turn', 'winner', 'you'].sort());
  assert.equal(v.turn, s.turn);
  assert.equal(v.you.index, 0);
  assert.equal(typeof v.you.integrity, 'number');
  assert.equal(v.you.maxIntegrity, 30);
  assert.deepEqual(Object.keys(v.you.hand[0]).sort(),
    ['cardId', 'cost', 'playable', 'targeting', 'validPositions'].sort());
  const bu = v.you.board[0];
  assert.deepEqual(Object.keys(bu).sort(),
    ['attack', 'canAttack', 'cardId', 'damaged', 'exhausted', 'health', 'id', 'keywords', 'maxHealth'].sort());
  assert.equal(bu.canAttack, true);
  assert.equal(v.you.ceo.cardId, 'nx_ceo');
  assert.equal(typeof v.you.ceo.name, 'string');
  assert.equal(v.opp.hand, undefined, 'opponent hand hidden');
  assert.equal(typeof v.opp.handCount, 'number');
  assert.equal(v.opp.board.length, 0);
  // opp view of the same unit: canAttack always false
  const v1 = getView(s, 1);
  assert.equal(v1.opp.board[0].canAttack, false);
  assert.ok(JSON.stringify(v)); // serializable
});

test('redactEvents nulls opponent draw cardIds and keeps own', () => {
  const s = newGame();
  const r = end(s); // p1 draws
  const mine = redactEvents(r.events, 1);
  const theirs = redactEvents(r.events, 0);
  const d1 = mine.find((e) => e.e === 'draw');
  const d0 = theirs.find((e) => e.e === 'draw');
  assert.ok(d1.cardId, 'own draw visible');
  assert.equal(d0.cardId, null, 'opponent draw hidden');
  // original events untouched
  assert.ok(r.events.find((e) => e.e === 'draw').cardId);
});

test('cloneState is a deep, independent copy', () => {
  const s = newGame();
  const c = cloneState(s);
  c.players[0].integrity = 5;
  c.players[0].hand.push('ntr_001');
  addUnit(c, 0, 'ntr_002');
  assert.equal(s.players[0].integrity, 30);
  assert.notEqual(s.players[0].hand.length, c.players[0].hand.length);
  assert.equal(s.players[0].board.length, 0);
});

test('applyAction never throws on garbage, rejects out-of-turn actions', () => {
  const s = newGame();
  for (const bad of [
    null, undefined, 42, 'endTurn', {}, { type: 'launchIPO' },
    { type: 'playCard', handIndex: 99 }, { type: 'playCard', handIndex: -1 },
    { type: 'playCard', handIndex: 0, target: 'u999' },
    { type: 'attack', attackerId: 'u999', targetId: 'hero1' },
    { type: 'attack' }, { type: 'heroPower', target: 'nope' },
  ]) {
    const r = applyAction(s, 0, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, 'string');
  }
  // out of turn
  assert.equal(applyAction(s, 1, { type: 'endTurn' }).ok, false);
  assert.deepEqual(legalActions(s, 1), []);
  assert.equal(applyAction(s, 2, { type: 'endTurn' }).ok, false);
  assert.equal(s.over, false, 'state not corrupted');
});

test('legalActions always includes endTurn on your turn', () => {
  const s = newGame();
  const acts = legalActions(s, 0);
  assert.ok(acts.some((a) => a.type === 'endTurn'));
});
