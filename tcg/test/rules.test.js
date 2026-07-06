// Rules coverage: turn structure, resources, draw, keywords, combat, targeting,
// death sweep, win conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, legalActions, getView, redactEvents, cloneState,
  CARDS, STARTER_DECKS,
} from '../shared/engine.js';
import {
  newGame, addUnit, putInHand, giveCapital, fileContract, find, findAll,
} from './helpers.js';

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
  assert.equal(s.players[0].deck.length, 36);
  assert.equal(s.players[1].deck.length, 36);
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
  assert.equal(s.players[1].integrity, 39);
  end(s); // p0 fatigue 1
  end(s); // p1 fatigue 2
  assert.equal(s.players[1].fatigue, 2);
  assert.equal(s.players[1].integrity, 37);
  end(s); end(s); // p1 fatigue 3
  assert.equal(s.players[1].integrity, 34);
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
  assert.equal(s.players[1].integrity, 38);
});

test('OVERTIME allows exactly two attacks per turn', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'vx_007'); // 2/3 overtime
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, true);
  assert.equal(applyAction(s, 0, { type: 'attack', attackerId: u.id, targetId: 'hero1' }).ok, false);
  assert.equal(s.players[1].integrity, 36);
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
  assert.equal(s.players[1].integrity, 37);
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
  const idx = putInHand(s, 0, 'hx_002'); // +1/+2 friendly (engine doesn't care about deck faction here)
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

test('healing is uncapped: SIPHON overheals past base integrity', () => {
  const s = newGame();
  s.players[0].integrity = 29;
  const leech = addUnit(s, 0, 'hx_012'); // 4/5 siphon
  applyAction(s, 0, { type: 'attack', attackerId: leech.id, targetId: 'hero1' });
  assert.equal(s.players[0].integrity, 33, '29 + 4 siphon = 33, no 30 cap');
});

test('healing is uncapped: units heal past base durability, heal event carries full amount', () => {
  const s = newGame('helix', 'vulcan');
  giveCapital(s, 0, 2);
  const u = addUnit(s, 0, 'ntr_013'); // 4/5, at full health
  const r = applyAction(s, 0, { type: 'heroPower', target: u.id }); // Gene Therapy: restore 2
  assert.equal(r.ok, true);
  assert.equal(u.health, 7, 'full-health 5/5 healed for 2 -> 7');
  assert.equal(find(r.events, 'heal').amount, 2, 'event reports the full amount, not a clamped 0');
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
  // +1 put in hand, -1 played, +1 drawn => net +1 vs the original count
  assert.equal(s.players[0].hand.length, before + 1);
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
  const exec = addUnit(s, 1, 'ob_007'); // parachute: draw; ALSO carries SEVERANCE (§3d)
  const a = addUnit(s, 0, 'vx_013'); // 6/7
  const handBefore = s.players[1].hand.length;
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: exec.id });
  assert.equal(r.ok, true);
  // enemy kill double-dips: GOLDEN PARACHUTE (any death) + SEVERANCE (enemy-caused)
  assert.equal(s.players[1].hand.length, handBefore + 2, 'opponent drew from parachute AND severance');
  const draws = findAll(r.events, 'draw').filter((d) => d.player === 1);
  assert.equal(draws.length, 2);
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
  assert.equal(s.players[1].integrity, 39);
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
  assert.equal(s.players[0].integrity, 39);
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

test('destroy: The Nuclear Option wipes every asset, including the caster\'s own, parachutes still fire', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'ntr_013');
  addUnit(s, 0, 'vx_005');
  addUnit(s, 1, 'ntr_013');
  addUnit(s, 1, 'hx_018'); // parachute: spore
  const idx = putInHand(s, 0, 'ntr_035');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(findAll(r.events, 'death').length, 4, 'all 4 pre-wipe assets died');
  assert.equal(s.players[0].board.length, 0, 'caster\'s own board wiped too');
  assert.equal(s.players[1].board.length, 1, 'spore from parachute survives the wipe');
  assert.equal(s.players[1].board[0].cardId, 'hx_t_spore');
});

test('destroy: The Nuclear Option is symmetric — does NOT fire SEVERANCE on your own severance units', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'ntr_011'); // severance, owner p0 (the caster)
  const idx = putInHand(s, 0, 'ntr_035');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board.length, 0);
  assert.equal(find(r.events, 'severance'), undefined, 'self-inflicted wipe never triggers severance');
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

test('Counter Offer: steals an enemy asset costing 4 or less', () => {
  const s = newGame();
  giveCapital(s, 0);
  const cheap = addUnit(s, 1, 'vx_005'); // Foundry Worker, cost 2
  const idx = putInHand(s, 0, 'ob_023');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: cheap.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'left the enemy board');
  assert.equal(s.players[0].board.length, 1, 'joined our board');
  assert.equal(s.players[0].board[0].cardId, 'vx_005');
  assert.notEqual(s.players[0].board[0].id, cheap.id, 'new unit id on control change');
});

test('Counter Offer: an enemy asset costing 5+ is NOT a legal target', () => {
  const s = newGame();
  giveCapital(s, 0);
  const big = addUnit(s, 1, 'vx_013'); // War Factory, cost 6
  const idx = putInHand(s, 0, 'ob_023');
  // not enumerated as a legal play against the expensive unit
  const legal = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.ok(!legal.includes(big.id), 'cost-6 asset not offered as a target');
  // and the engine rejects it if a client tries anyway
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: big.id, position: null });
  assert.equal(r.ok, false, 'engine rejects the illegal steal');
  assert.equal(s.players[1].board.length, 1, 'the expensive asset stays put');
});

test('Counter Offer: a STEALTH enemy asset (even if cheap) is not targetable', () => {
  const s = newGame();
  giveCapital(s, 0);
  const sneaky = addUnit(s, 1, 'ntr_021'); // Corporate Spy, cost 3, STEALTH
  const idx = putInHand(s, 0, 'ob_023');
  const legal = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.ok(!legal.includes(sneaky.id), 'stealth hides it from Counter Offer');
});

test('Counter Offer: enumerated only against eligible enemy assets', () => {
  const s = newGame();
  giveCapital(s, 0);
  const cheap = addUnit(s, 1, 'vx_005'); // cost 2 — eligible
  addUnit(s, 1, 'vx_013');               // cost 6 — not eligible
  const idx = putInHand(s, 0, 'ob_023');
  const targets = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.deepEqual(targets, [cheap.id], 'exactly the one eligible target');
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
  assert.equal(v.you.maxIntegrity, 40);
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
  assert.equal(s.players[0].integrity, 40);
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

// ---------------------------------------------------------------------------
// CONTRACTS (§3b): filing, zone limit, expiry, null & void
// ---------------------------------------------------------------------------
test('filing a contract: cost, zone, cardPlayed->contractFiled, public in views', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  const idx = putInHand(s, 0, 'nx_c03');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 3, 'cost 2 deducted');
  const types = r.events.map((e) => e.e);
  assert.ok(types.indexOf('cardPlayed') !== -1 &&
    types.indexOf('cardPlayed') < types.indexOf('contractFiled'),
  'cardPlayed emitted before contractFiled');
  const filed = find(r.events, 'contractFiled');
  assert.equal(filed.player, 0);
  assert.match(filed.contract.id, /^c\d+$/);
  assert.equal(filed.contract.cardId, 'nx_c03');
  assert.equal(filed.contract.turnsLeft, null, 'no term -> null');
  assert.equal(s.players[0].contracts.length, 1);
  assert.equal(s.players[0].board.length, 0, 'contracts do not occupy board slots');
  // contracts are public on both views
  const expected = [{ id: filed.contract.id, cardId: 'nx_c03', turnsLeft: null }];
  assert.deepEqual(getView(s, 0).you.contracts, expected);
  assert.deepEqual(getView(s, 1).opp.contracts, expected);
});

test('filing a term contract reports turnsLeft in the event and view', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  const idx = putInHand(s, 0, 'nx_c02');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(find(r.events, 'contractFiled').contract.turnsLeft, 3);
  assert.equal(getView(s, 1).opp.contracts[0].turnsLeft, 3);
});

test('max 3 filed contracts: 4th is unplayable and rejected', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  for (const id of ['nx_c03', 'nx_c03', 'nx_c01']) fileContract(s, 0, id);
  const idx = putInHand(s, 0, 'nx_c02');
  assert.equal(getView(s, 0).you.hand[idx].playable, false, 'view says unplayable');
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'playCard' && a.handIndex === idx),
    'not enumerated');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, false);
  assert.equal(s.players[0].contracts.length, 3);
  // a slot frees -> playable again
  s.players[0].contracts.pop();
  assert.equal(getView(s, 0).you.hand[idx].playable, true);
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: idx, target: null, position: null }).ok, true);
});

test('term expiry: nx_c02 fires on exactly 3 owner turns, then contractVoided expired', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  const idx = putInHand(s, 0, 'nx_c02');
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  const cid = s.players[0].contracts[0].id;
  for (let round = 1; round <= 3; round++) {
    end(s); // -> p1's turn (contract silent: owner-only trigger)
    const r = end(s); // -> p0's turn: draw step, then contract draw, then decrement
    const p0draws = findAll(r.events, 'draw').filter((d) => d.player === 0);
    assert.equal(p0draws.length, 2, `round ${round}: turn draw + contract draw`);
    if (round < 3) {
      assert.equal(s.players[0].contracts[0].turnsLeft, 3 - round,
        'decrement AFTER the trigger');
      assert.ok(!find(r.events, 'contractVoided'));
    } else {
      assert.deepEqual(find(r.events, 'contractVoided'),
        { e: 'contractVoided', contractId: cid, cardId: 'nx_c02', reason: 'expired' });
      assert.equal(s.players[0].contracts.length, 0);
    }
  }
  // no further trigger after expiry (drain the hand so the turn draw isn't a mill)
  s.players[0].hand.length = 0;
  end(s);
  const r = end(s);
  assert.equal(findAll(r.events, 'draw').filter((d) => d.player === 0).length, 1);
});

test('Void Clause: voids an enemy contract; unplayable with no enemy contracts', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ntr_c02');
  // no enemy contracts -> unplayable (targeted OPERATION, no fizzle)
  assert.equal(getView(s, 0).you.hand[idx].playable, false);
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'playCard' && a.handIndex === idx));
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: idx, target: null, position: null }).ok, false);
  // enemy files one -> playable, target enumerated, void works
  const c = fileContract(s, 1, 'vx_c02');
  assert.equal(getView(s, 0).you.hand[idx].playable, true);
  assert.equal(getView(s, 0).you.hand[idx].targeting, 'enemyContract');
  const legal = legalActions(s, 0).filter((a) => a.type === 'playCard' && a.handIndex === idx);
  assert.deepEqual(legal.map((a) => a.target), [c.id], 'each enemy contract enumerated');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: c.id, position: null });
  assert.equal(r.ok, true);
  assert.deepEqual(find(r.events, 'contractVoided'),
    { e: 'contractVoided', contractId: c.id, cardId: 'vx_c02', reason: 'nullified' });
  assert.equal(s.players[1].contracts.length, 0);
});

test('Contract Attorney: onboarding nullify; fizzles when no enemy contracts', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  // fizzle: no enemy contracts, still deploys
  const idx = putInHand(s, 0, 'ntr_c01');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true, 'ASSET with no valid targets fizzles');
  assert.equal(s.players[0].board[0].cardId, 'ntr_c01');
  assert.ok(!find(r.events, 'contractVoided'));
  // with an enemy contract the target is mandatory
  const c = fileContract(s, 1, 'hx_c01');
  const idx2 = putInHand(s, 0, 'ntr_c01');
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: idx2, target: null, position: null }).ok, false);
  const r2 = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: c.id, position: null });
  assert.equal(r2.ok, true);
  assert.deepEqual(find(r2.events, 'contractVoided'),
    { e: 'contractVoided', contractId: c.id, cardId: 'hx_c01', reason: 'nullified' });
  assert.equal(s.players[1].contracts.length, 0);
});

test('contract garbage inputs: c-ids in wrong slots, own/unknown contracts rejected', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const mine = fileContract(s, 0, 'nx_c03');
  const theirs = fileContract(s, 1, 'vx_c02');
  const u = addUnit(s, 0, 'ntr_006');
  // c-id as an attack target
  assert.equal(applyAction(s, 0,
    { type: 'attack', attackerId: u.id, targetId: theirs.id }).ok, false);
  // c-id as a damage-op target (contracts cannot be targeted by damage)
  const iPing = putInHand(s, 0, 'nx_013');
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: iPing, target: theirs.id, position: null }).ok, false);
  // c-id as a heroPower target (nexus power takes no target)
  assert.equal(applyAction(s, 0, { type: 'heroPower', target: theirs.id }).ok, false);
  // playing a contract WITH a target
  const iC = putInHand(s, 0, 'nx_c01');
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: iC, target: 'hero1', position: null }).ok, false);
  // voiding your OWN contract, or an unknown c-id
  const iV = putInHand(s, 0, 'ntr_c02');
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: iV, target: mine.id, position: null }).ok, false);
  assert.equal(applyAction(s, 0,
    { type: 'playCard', handIndex: iV, target: 'c999', position: null }).ok, false);
  assert.equal(s.players[0].contracts.length, 1, 'state not corrupted');
  assert.equal(s.players[1].contracts.length, 1);
  assert.equal(s.over, false);
});

// ---------------------------------------------------------------------------
// CONTRACTS (§3b): static modifiers
// ---------------------------------------------------------------------------
test('nx_c01: operations cost 1 less (floor 0), stacks to -2; non-operations unaffected', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  fileContract(s, 0, 'nx_c01');
  const iPing = putInHand(s, 0, 'nx_013'); // op, cost 0
  const iTele = putInHand(s, 0, 'nx_019'); // op, cost 1
  const iSprint = putInHand(s, 0, 'nx_015'); // op, cost 3
  const iAsset = putInHand(s, 0, 'nx_004'); // ASSET, cost 2
  const iContract = putInHand(s, 0, 'nx_c03'); // CONTRACT, cost 2
  let v = getView(s, 0);
  assert.equal(v.you.hand[iPing].cost, 0, 'floor at 0');
  assert.equal(v.you.hand[iTele].cost, 0);
  assert.equal(v.you.hand[iSprint].cost, 2);
  assert.equal(v.you.hand[iAsset].cost, 2, 'asset cost unchanged');
  assert.equal(v.you.hand[iContract].cost, 2, 'contract cost unchanged');
  fileContract(s, 0, 'nx_c01'); // two copies stack: -2
  v = getView(s, 0);
  assert.equal(v.you.hand[iSprint].cost, 1);
  // validation + deduction use the same effective cost
  s.players[0].capital = 1;
  assert.equal(getView(s, 0).you.hand[iSprint].playable, true);
  assert.ok(legalActions(s, 0).some((a) => a.type === 'playCard' && a.handIndex === iSprint));
  const r = applyAction(s, 0,
    { type: 'playCard', handIndex: iSprint, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 0, 'deducted the reduced cost');
});

test("nx_c01 reduces only the owner's operations", () => {
  const s = newGame();
  fileContract(s, 0, 'nx_c01');
  end(s); // p1's turn
  const idx = putInHand(s, 1, 'nx_015'); // cost 3 op in p1's hand
  assert.equal(getView(s, 1).you.hand[idx].cost, 3, 'opponent gets no discount');
});

test('vx_c01: +1 damage on operations and CEO power, NOT combat; stacks', () => {
  const s = newGame('vulcan', 'helix');
  giveCapital(s, 0, 10);
  fileContract(s, 0, 'vx_c01');
  // operation: Shrapnel Burst 2 -> 3
  const enemy = addUnit(s, 1, 'ntr_013'); // 4/5
  const i1 = putInHand(s, 0, 'vx_003');
  const r1 = applyAction(s, 0, { type: 'playCard', handIndex: i1, target: enemy.id, position: null });
  assert.equal(find(r1.events, 'damage').amount, 3, 'event shows boosted amount');
  assert.equal(enemy.health, 2);
  // CEO power: Precision Strike 1 -> 2
  applyAction(s, 0, { type: 'heroPower', target: 'hero1' });
  assert.equal(s.players[1].integrity, 38);
  // combat damage NOT boosted
  const mine = addUnit(s, 0, 'ntr_006'); // 3/2
  applyAction(s, 0, { type: 'attack', attackerId: mine.id, targetId: 'hero1' });
  assert.equal(s.players[1].integrity, 35, '3 combat damage, no bonus');
  // unit-sourced onboarding damage NOT boosted (vx_004: 1 to enemy CEO)
  const i2 = putInHand(s, 0, 'vx_004');
  applyAction(s, 0, { type: 'playCard', handIndex: i2, target: null, position: null });
  assert.equal(s.players[1].integrity, 34, 'onboarding damage unaffected');
  // stacking: second copy -> Shrapnel Burst deals 4
  fileContract(s, 0, 'vx_c01');
  const i3 = putInHand(s, 0, 'vx_003');
  applyAction(s, 0, { type: 'playCard', handIndex: i3, target: enemy.id, position: null });
  assert.equal(s.players[1].board.length, 0, '2+2 kills the 2-health asset');
});

test('vx_c01 does not boost contract-trigger damage (vx_c02 still deals 1)', () => {
  const s = newGame('vulcan', 'helix');
  fileContract(s, 0, 'vx_c01');
  fileContract(s, 0, 'vx_c02');
  end(s);
  assert.equal(s.players[1].integrity, 39, 'end-of-turn contract damage not boosted');
});

// ---------------------------------------------------------------------------
// CONTRACTS (§3b): triggered contracts
// ---------------------------------------------------------------------------
test('nx_c03 fires per operation, after the op resolves; hero power does not trigger it', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  fileContract(s, 0, 'nx_c03');
  // op #1: Telemetry (draw) -> trigger 1 damage, after the draw
  const i1 = putInHand(s, 0, 'nx_019');
  const r1 = applyAction(s, 0, { type: 'playCard', handIndex: i1, target: null, position: null });
  assert.equal(s.players[1].integrity, 39);
  const types = r1.events.map((e) => e.e);
  assert.ok(types.indexOf('draw') < types.indexOf('damage'),
    'operation effects resolve before the trigger');
  // op #2: Ping the enemy CEO -> 1 (op) + 1 (trigger)
  const i2 = putInHand(s, 0, 'nx_013');
  applyAction(s, 0, { type: 'playCard', handIndex: i2, target: 'hero1', position: null });
  assert.equal(s.players[1].integrity, 37);
  // hero power is not an operation
  applyAction(s, 0, { type: 'heroPower', target: null });
  assert.equal(s.players[1].integrity, 37);
  // stacks: two copies -> 2 per operation
  fileContract(s, 0, 'nx_c03');
  const i3 = putInHand(s, 0, 'nx_019');
  applyAction(s, 0, { type: 'playCard', handIndex: i3, target: null, position: null });
  assert.equal(s.players[1].integrity, 35);
});

test('end-of-turn contracts (vx_c02, hx_c01) fire at owner turn end, before opponent turnStart', () => {
  const s = newGame();
  fileContract(s, 0, 'vx_c02');
  fileContract(s, 0, 'hx_c01');
  s.players[0].integrity = 20;
  const r = end(s);
  assert.equal(s.players[1].integrity, 39, 'vx_c02 hit the enemy CEO');
  assert.equal(s.players[0].integrity, 22, 'hx_c01 healed the owner');
  const types = r.events.map((e) => e.e);
  assert.ok(types.indexOf('damage') < types.indexOf('turnStart'), 'before opponent turnStart');
  assert.ok(types.indexOf('heal') < types.indexOf('turnStart'));
  // not on the opponent's turn end
  end(s);
  assert.equal(s.players[1].integrity, 39);
  assert.equal(s.players[0].integrity, 22);
});

test('hx_c01 overheals the CEO past base integrity (healing uncapped)', () => {
  const s = newGame();
  fileContract(s, 0, 'hx_c01');
  end(s);
  assert.equal(s.players[0].integrity, 42);
  assert.equal(s.players[0].maxIntegrity, 40);
});

test('vx_c03 both parties: the ACTIVE player takes 1 at the start of each turn', () => {
  const s = newGame();
  fileContract(s, 0, 'vx_c03');
  end(s); // p1's turn starts -> p1 takes 1 (owner's contract, opponent's turn)
  assert.equal(s.players[1].integrity, 39);
  assert.equal(s.players[0].integrity, 40);
  end(s); // p0's turn starts -> p0 takes 1 (own turn)
  assert.equal(s.players[0].integrity, 39);
  assert.equal(s.players[1].integrity, 39);
});

test('ob_c01 Payday: +1 temp capital and 1 self-damage at own turn start only', () => {
  const s = newGame();
  fileContract(s, 0, 'ob_c01');
  end(s); // p1's turn: nothing (not both-parties)
  assert.equal(s.players[0].integrity, 40);
  assert.equal(s.players[1].integrity, 40);
  end(s); // p0 turn 2: maxCapital 2, +1 temp -> 3; CEO takes 1
  assert.equal(s.players[0].maxCapital, 2);
  assert.equal(s.players[0].capital, 3);
  assert.equal(s.players[0].integrity, 39);
  end(s); end(s); // p0 turn 3: temp capital did not persist into max
  assert.equal(s.players[0].maxCapital, 3);
  assert.equal(s.players[0].capital, 4);
  assert.equal(s.players[0].integrity, 38);
});

test('lethal payday: ob_c01 self-damage can lose the game', () => {
  const s = newGame();
  fileContract(s, 0, 'ob_c01');
  s.players[0].integrity = 1;
  end(s); // p1's turn
  const r = end(s); // p0's turn start: payday kills p0
  assert.equal(s.over, true);
  assert.equal(s.winner, 1);
  assert.deepEqual(find(r.events, 'gameOver'), { e: 'gameOver', winner: 1, reason: 'takeover' });
});

test('ob_c02 Bridge Loan: +1 permanent max capital on each of its 2 turns, then expires', () => {
  const s = newGame();
  fileContract(s, 0, 'ob_c02'); // turn 1, maxCapital 1
  end(s);
  const r1 = end(s); // p0 turn 2: ramp -> 2, loan -> 3
  assert.equal(s.players[0].maxCapital, 3);
  assert.equal(s.players[0].capital, 3);
  assert.equal(s.players[0].contracts[0].turnsLeft, 1);
  assert.ok(!find(r1.events, 'contractVoided'));
  end(s);
  const r2 = end(s); // p0 turn 3: ramp -> 4, loan -> 5, term hits 0 -> expired
  assert.equal(s.players[0].maxCapital, 5, 'exactly +2 over the 2 turns');
  const voided = find(r2.events, 'contractVoided');
  assert.equal(voided.cardId, 'ob_c02');
  assert.equal(voided.reason, 'expired');
  assert.equal(s.players[0].contracts.length, 0);
  end(s);
  end(s); // p0 turn 4: ramp only
  assert.equal(s.players[0].maxCapital, 6, 'no further loan payouts');
});

test('ob_c02 respects the 10 max-capital cap', () => {
  const s = newGame();
  s.players[0].maxCapital = 10;
  fileContract(s, 0, 'ob_c02');
  end(s); end(s); // p0's turn: ramp capped, loan capped
  assert.equal(s.players[0].maxCapital, 10);
});

test('hx_c02 heals each friendly asset at own turn start (uncapped overheal)', () => {
  const s = newGame();
  fileContract(s, 0, 'hx_c02');
  const a = addUnit(s, 0, 'ntr_013', { health: 2 }); // 4/5 damaged
  const b = addUnit(s, 0, 'ntr_001'); // 1/1 at full health
  const enemy = addUnit(s, 1, 'ntr_005'); // 2/3
  end(s); // p1's turn: no trigger for p0's contract
  assert.equal(a.health, 2);
  const r = end(s); // p0's turn: both friendlies healed 1
  assert.equal(a.health, 3);
  assert.equal(b.health, 2, 'overheal past printed durability');
  assert.equal(enemy.health, 3, 'enemy assets untouched');
  assert.equal(findAll(r.events, 'heal').length, 2);
});

test('hx_c03 / ob_c03 fire on combat deaths and sweep deaths, per owner', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  fileContract(s, 1, 'hx_c03');
  fileContract(s, 1, 'ob_c03');
  fileContract(s, 0, 'hx_c03');
  s.players[0].integrity = 20;
  s.players[1].integrity = 20;
  const cap1 = s.players[1].capital;
  // combat death: p0's 3/2 kills p1's 1/1 (attacker survives)
  const mine = addUnit(s, 0, 'ntr_006');
  const theirs = addUnit(s, 1, 'ntr_001');
  const r = applyAction(s, 0, { type: 'attack', attackerId: mine.id, targetId: theirs.id });
  assert.equal(s.players[1].integrity, 22, 'hx_c03 healed on combat death');
  assert.equal(s.players[1].capital, cap1 + 1, 'ob_c03 temp capital on combat death');
  assert.ok(find(r.events, 'heal'));
  // sweep deaths via AoE operation: 2 more p1 units + p0's damaged unit all die
  addUnit(s, 1, 'ntr_001');
  addUnit(s, 1, 'ntr_001');
  mine.health = 1;
  const idx = putInHand(s, 0, 'ntr_027'); // Budget Cuts: 1 damage to ALL assets
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(s.players[1].integrity, 26, '+2 per friendly sweep death (x2)');
  assert.equal(s.players[1].capital, cap1 + 3);
  assert.equal(s.players[0].integrity, 22, "p0's own hx_c03 fired for p0's death only");
});

test("ob_c03 capital is 'this turn only' (swallowed by the next refill)", () => {
  const s = newGame();
  fileContract(s, 0, 'ob_c03');
  const victim = addUnit(s, 0, 'ntr_001');
  const killer = addUnit(s, 1, 'ntr_006', { enteredTurn: 0 });
  s.players[0].capital = 1;
  s.players[0].maxCapital = 1;
  end(s); // p1's turn
  applyAction(s, 1, { type: 'attack', attackerId: killer.id, targetId: victim.id });
  assert.equal(s.players[0].capital, 2, 'owner gained 1 temp capital mid-enemy-turn');
  end(s); // p0's turn: refill to max (2 after ramp)
  assert.equal(s.players[0].capital, s.players[0].maxCapital, 'temp capital gone');
});

// ---------------------------------------------------------------------------
// CONTRACTS (§3b): views, redaction, cloning
// ---------------------------------------------------------------------------
test('contract events pass redaction unchanged for both players', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  const idx = putInHand(s, 0, 'nx_c03');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  const filed = find(r.events, 'contractFiled');
  assert.deepEqual(redactEvents(r.events, 0).find((e) => e.e === 'contractFiled'), filed);
  assert.deepEqual(redactEvents(r.events, 1).find((e) => e.e === 'contractFiled'), filed);
  // voiding, seen by the voided player, is also unredacted
  const iV = putInHand(s, 1, 'ntr_c02');
  end(s);
  giveCapital(s, 1, 5);
  const r2 = applyAction(s, 1,
    { type: 'playCard', handIndex: iV, target: filed.contract.id, position: null });
  const voided = find(r2.events, 'contractVoided');
  assert.deepEqual(redactEvents(r2.events, 0).find((e) => e.e === 'contractVoided'), voided);
});

test('cloneState deep-copies contract state', () => {
  const s = newGame();
  fileContract(s, 0, 'nx_c02');
  const c = cloneState(s);
  c.players[0].contracts[0].turnsLeft = 1;
  c.players[0].contracts.push({ id: 'c99', cardId: 'nx_c03', turnsLeft: null });
  c.nextContract = 50;
  assert.equal(s.players[0].contracts.length, 1);
  assert.equal(s.players[0].contracts[0].turnsLeft, 3);
  assert.notEqual(s.nextContract, 50);
});

// ---------------------------------------------------------------------------
// LAYOFF (§3c): free sacrifice — heal your CEO by current Integrity
// ---------------------------------------------------------------------------
test('layoff heals CEO by CURRENT health; events layoff -> heal -> death', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'ob_017', { health: 1 }); // Escrow Guard 1/3, damaged to 1
  s.players[0].integrity = 20;
  const r = applyAction(s, 0, { type: 'layoff', unitId: u.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].integrity, 21, 'healed by current health (1), not maxHealth (3)');
  assert.equal(s.players[0].board.length, 0, 'unit destroyed');
  assert.deepEqual(r.events[0], { e: 'layoff', unitId: u.id, cardId: 'ob_017', player: 0 });
  assert.deepEqual(r.events[1], { e: 'heal', targetId: 'hero0', amount: 1 },
    'heal emitted BEFORE death, amount captured before removal');
  assert.deepEqual(r.events[2], { e: 'death', unitId: u.id, cardId: 'ob_017' });
});

test('layoff is free and ignores exhaustion / summoning sickness', () => {
  const s = newGame();
  s.players[0].capital = 0;
  // just deployed this turn AND already out of attacks: still layoff-able
  const u = addUnit(s, 0, 'ntr_001', { enteredTurn: s.turn, attacksUsed: 1 });
  const before = s.players[0].integrity;
  const r = applyAction(s, 0, { type: 'layoff', unitId: u.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 0, 'no capital spent');
  assert.equal(s.players[0].integrity, before + 1);
});

test('layoff illegal: no keyword / enemy unit / off-turn / unknown id', () => {
  const s = newGame();
  const noKw = addUnit(s, 0, 'ntr_002'); // Temp Worker: no LAYOFF
  assert.equal(applyAction(s, 0, { type: 'layoff', unitId: noKw.id }).ok, false);
  const theirs = addUnit(s, 1, 'ntr_001'); // has LAYOFF, but not p0's unit
  assert.equal(applyAction(s, 0, { type: 'layoff', unitId: theirs.id }).ok, false);
  assert.equal(applyAction(s, 1, { type: 'layoff', unitId: theirs.id }).ok, false,
    'not your turn');
  assert.equal(applyAction(s, 0, { type: 'layoff', unitId: 'u999' }).ok, false);
  assert.equal(s.players[0].board.length + s.players[1].board.length, 2,
    'nothing was destroyed');
  assert.equal(s.players[0].integrity, 40);
});

test('silence strips LAYOFF: action rejected and no longer enumerated', () => {
  const s = newGame();
  giveCapital(s, 0);
  const u = addUnit(s, 0, 'ntr_001');
  assert.ok(legalActions(s, 0).some((a) => a.type === 'layoff' && a.unitId === u.id));
  const idx = putInHand(s, 0, 'ntr_029'); // Gag Order: silence an asset
  applyAction(s, 0, { type: 'playCard', handIndex: idx, target: u.id, position: null });
  assert.equal(applyAction(s, 0, { type: 'layoff', unitId: u.id }).ok, false);
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'layoff'));
});

test('layoff heal is uncapped: pushes integrity past 40', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'ob_017'); // 1/3 at full health
  assert.equal(s.players[0].integrity, 40);
  applyAction(s, 0, { type: 'layoff', unitId: u.id });
  assert.equal(s.players[0].integrity, 43);
});

test('layoff fires GOLDEN PARACHUTE (Spore Pod summons a Spore)', () => {
  const s = newGame();
  const u = addUnit(s, 0, 'hx_018');
  const r = applyAction(s, 0, { type: 'layoff', unitId: u.id });
  assert.equal(s.players[0].board.length, 1);
  assert.equal(s.players[0].board[0].cardId, 'hx_t_spore');
  const types = r.events.map((e) => e.e);
  assert.ok(types.indexOf('death') < types.indexOf('summon'), 'parachute after death');
});

test('layoff fires onFriendlyAssetDestroyed (hx_c03 Life Insurance Policy)', () => {
  const s = newGame();
  fileContract(s, 0, 'hx_c03');
  const u = addUnit(s, 0, 'ob_017'); // current health 3
  s.players[0].integrity = 20;
  const r = applyAction(s, 0, { type: 'layoff', unitId: u.id });
  assert.equal(s.players[0].integrity, 25, 'layoff heal (3) + contract heal (2)');
  const heals = findAll(r.events, 'heal');
  assert.deepEqual(heals.map((h) => h.amount), [3, 2]);
});

test('ntr_033 Layoff Notice: layoffTarget special mirrors the action', () => {
  const s = newGame();
  giveCapital(s, 0, 5);
  const u = addUnit(s, 0, 'hx_018', { health: 1 });
  s.players[0].integrity = 20;
  const idx = putInHand(s, 0, 'ntr_033');
  // requires a friendly target
  assert.equal(
    applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null }).ok,
    false);
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: u.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 4, 'costs 1');
  assert.equal(s.players[0].integrity, 21, 'heal = current health');
  assert.equal(s.players[0].board.length, 1, 'destroyed; parachute Spore summoned');
  assert.equal(s.players[0].board[0].cardId, 'hx_t_spore');
  const types = r.events.map((e) => e.e);
  assert.deepEqual(types.slice(0, 5), ['cardPlayed', 'layoff', 'heal', 'death', 'summon'],
    'same layoff event/order as the action path');
  assert.deepEqual(find(r.events, 'layoff'),
    { e: 'layoff', unitId: u.id, cardId: 'hx_018', player: 0 });
});

test('legalActions enumerates layoff for eligible units only', () => {
  const s = newGame();
  const eligible = addUnit(s, 0, 'ntr_001');
  addUnit(s, 0, 'ntr_002'); // no keyword
  addUnit(s, 1, 'ntr_001'); // enemy
  const mine = legalActions(s, 0).filter((a) => a.type === 'layoff');
  assert.deepEqual(mine, [{ type: 'layoff', unitId: eligible.id }]);
  assert.deepEqual(legalActions(s, 1), [], 'off-turn: nothing enumerated');
  // scrapbot token is also eligible
  const bot = addUnit(s, 0, 'vx_t_scrapbot');
  assert.ok(legalActions(s, 0).some((a) => a.type === 'layoff' && a.unitId === bot.id));
});

// ---------------------------------------------------------------------------
// SEVERANCE (§3d) — enemy-caused death of a live-keyword unit pays its OWNER
// a compensation draw. Owner-caused deaths (LAYOFF, own AoE/destroy) never
// fire it — you don't get severance for quitting.
// ---------------------------------------------------------------------------

test('SEVERANCE: enemy combat kill pays out a card to the owner; event precedes its draw', () => {
  const s = newGame(); // p0 active
  const attacker = addUnit(s, 0, 'ntr_019'); // 7/7
  const sev = addUnit(s, 1, 'ntr_011'); // 4/2 severance (enemy of p0)
  const handBefore = s.players[1].hand.length;
  const r = applyAction(s, 0, { type: 'attack', attackerId: attacker.id, targetId: sev.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'severance unit died');
  assert.equal(s.players[1].hand.length, handBefore + 1, 'owner (p1) drew a card');
  const sevEv = find(r.events, 'severance');
  assert.ok(sevEv, 'severance event emitted');
  assert.deepEqual(
    { unitId: sevEv.unitId, cardId: sevEv.cardId, player: sevEv.player },
    { unitId: sev.id, cardId: 'ntr_011', player: 1 });
  const sevIdx = r.events.findIndex((e) => e.e === 'severance');
  const drawIdx = r.events.findIndex((e) => e.e === 'draw' && e.player === 1);
  assert.ok(sevIdx >= 0 && drawIdx > sevIdx, 'severance event precedes its draw event');
});

test('SEVERANCE: enemy destroy op fires it', () => {
  const s = newGame();
  const sev = addUnit(s, 1, 'ntr_015'); // severance (enemy of p0)
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ob_005'); // Destroy an enemy asset
  const handBefore = s.players[1].hand.length;
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: sev.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0);
  assert.ok(find(r.events, 'severance'));
  assert.equal(s.players[1].hand.length, handBefore + 1, 'owner (p1) drew a card');
});

test('SEVERANCE: enemy TOXIC kill fires it', () => {
  const s = newGame();
  const troll = addUnit(s, 0, 'ntr_020'); // 1/1 toxic
  const sev = addUnit(s, 1, 'ntr_034'); // 2/4 Whistleblower severance
  const handBefore = s.players[1].hand.length;
  const r = applyAction(s, 0, { type: 'attack', attackerId: troll.id, targetId: sev.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'toxic killed the severance unit');
  assert.ok(find(r.events, 'severance'));
  assert.equal(s.players[1].hand.length, handBefore + 1, 'owner (p1) drew a card');
});

test('SEVERANCE: owner-caused death (own AoE) does NOT fire', () => {
  const s = newGame();
  addUnit(s, 0, 'ntr_034', { health: 1, maxHealth: 1 }); // owner p0
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ntr_027'); // Budget Cuts: 1 dmg to all assets
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board.length, 0, 'own severance unit died to own AoE');
  assert.equal(find(r.events, 'severance'), undefined, 'no severance on owner kill');
  assert.equal(find(r.events, 'draw'), undefined, 'no bonus draw either');
});

test('SEVERANCE: owner self-destroy (LAYOFF Notice) does NOT fire', () => {
  const s = newGame();
  const sev = addUnit(s, 0, 'ntr_034'); // owner p0
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ntr_033'); // Layoff Notice (destroy friendly)
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: sev.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board.length, 0, 'unit laid off');
  assert.ok(find(r.events, 'layoff'));
  assert.equal(find(r.events, 'severance'), undefined, 'self-sacrifice never gets its own severance');
  assert.equal(find(r.events, 'draw'), undefined, 'no bonus draw either');
});

test('SEVERANCE: stale enemy tag is overwritten by a later owner destroy → no fire', () => {
  const s = newGame(); // p0 nexus, p1 vulcan
  const sev = addUnit(s, 0, 'ntr_034', { health: 4, maxHealth: 4 }); // owner p0
  // hand off to p1, who pings it non-lethally (killedBy := 1)
  end(s);
  giveCapital(s, 1, 10);
  const idx1 = putInHand(s, 1, 'ntr_027'); // 1 dmg to all assets
  applyAction(s, 1, { type: 'playCard', handIndex: idx1, target: null, position: null });
  assert.equal(sev.health, 3, 'survived the enemy ping');
  assert.equal(sev.killedBy, 1, 'tagged by the enemy ping');
  // back to p0, who destroys it themselves → killedBy overwritten to 0
  end(s);
  giveCapital(s, 0, 10);
  const idx2 = putInHand(s, 0, 'ntr_033'); // Layoff Notice
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx2, target: sev.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(find(r.events, 'severance'), undefined, 'stale enemy tag did not mis-fire');
});

test('SEVERANCE: silenced severance unit killed by enemy does NOT fire', () => {
  const s = newGame();
  const attacker = addUnit(s, 0, 'ntr_019'); // 7/7
  addUnit(s, 1, 'ntr_011', { silenced: true, keywords: [] }); // silenced severance
  const r = applyAction(s, 0, { type: 'attack', attackerId: attacker.id, targetId: s.players[1].board[0].id });
  assert.equal(r.ok, true);
  assert.equal(find(r.events, 'severance'), undefined, 'silence strips SEVERANCE');
});

test('SEVERANCE: a payout draw from an EMPTY deck backfires as fatigue on the OWNER — can be lethal to the owner, not the killer', () => {
  const s = newGame();
  const attacker = addUnit(s, 0, 'ntr_019'); // 7/7
  const sev = addUnit(s, 1, 'ntr_011'); // 4/2 severance, owner p1
  s.players[1].deck = []; // empty: the compensation draw pays fatigue instead
  s.players[1].fatigue = 0;
  s.players[1].integrity = 1; // the first fatigue point (1) is exactly lethal
  const r = applyAction(s, 0, { type: 'attack', attackerId: attacker.id, targetId: sev.id });
  assert.equal(r.ok, true);
  assert.ok(find(r.events, 'severance'), 'severance fired');
  assert.ok(find(r.events, 'fatigue'), 'empty deck → fatigue instead of a real draw');
  assert.equal(s.players[1].integrity, 0, "the OWNER's own CEO took the fatigue hit");
  assert.equal(s.over, true);
  assert.equal(s.winner, 0, 'the killer wins — the payout backfired on its own owner');
  assert.ok(find(r.events, 'gameOver'));
});

test('SEVERANCE: ntr_034 Whistleblower plays with the keyword and fires on enemy kill', () => {
  const s = newGame(); // p0 active
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ntr_034');
  const r0 = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: null });
  assert.equal(r0.ok, true);
  const w = s.players[0].board[s.players[0].board.length - 1];
  assert.equal(w.cardId, 'ntr_034');
  assert.ok(w.keywords.includes('severance'), 'has SEVERANCE keyword in play');
  // enemy destroys it next turn → owner (p0) gets the compensation draw
  end(s);
  giveCapital(s, 1, 10);
  const kidx = putInHand(s, 1, 'ob_005'); // destroy enemy asset
  const handBefore = s.players[0].hand.length;
  const r = applyAction(s, 1, { type: 'playCard', handIndex: kidx, target: w.id, position: null });
  assert.equal(r.ok, true);
  assert.ok(find(r.events, 'severance'));
  assert.equal(s.players[0].hand.length, handBefore + 1, 'the owner (p0) drew a card');
});

// ---------------------------------------------------------------------------
// COUNTERS §Phase 1 — Retooling Order (vx_c04): a live +1 Attack aura on the
// ROBOTIC asset class. Auras are computed live, never baked onto the unit.
// ---------------------------------------------------------------------------
const boardView = (s, p, unitId) => {
  const v = getView(s, p);
  return v.you.board.find((u) => u.id === unitId) || v.opp.board.find((u) => u.id === unitId);
};

test('COUNTER aura: Retooling Order gives ROBOTIC assets +1 Attack (view + combat)', () => {
  const s = newGame();
  const bot = addUnit(s, 0, 'vx_011'); // Blitz Mech, robotic
  const base = CARDS.vx_011.attack;
  assert.equal(boardView(s, 0, bot.id).attack, base, 'no aura yet');
  fileContract(s, 0, 'vx_c04');
  const v = boardView(s, 0, bot.id);
  assert.equal(v.attack, base + 1, 'effective attack boosted in view');
  assert.ok(v.counters && v.counters.count === 1 && v.counters.atk === 1, 'counters reported');
  assert.equal(v.counters.sources[0].cardId, 'vx_c04');
  // combat actually swings for the boosted number
  giveCapital(s, 0);
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: bot.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before - (base + 1), 'hero took the boosted hit');
});

test('COUNTER aura: only ROBOTIC-class assets are affected', () => {
  const s = newGame();
  const person = addUnit(s, 0, 'ntr_001'); // personnel
  fileContract(s, 0, 'vx_c04');
  const v = boardView(s, 0, person.id);
  assert.equal(v.attack, CARDS.ntr_001.attack, 'non-robotic unchanged');
  assert.equal(v.counters, undefined, 'no counters block on a non-matching unit');
});

test('COUNTER aura: two copies stack (+2)', () => {
  const s = newGame();
  const bot = addUnit(s, 0, 'vx_011');
  fileContract(s, 0, 'vx_c04');
  fileContract(s, 0, 'vx_c04');
  const v = boardView(s, 0, bot.id);
  assert.equal(v.attack, CARDS.vx_011.attack + 2);
  assert.equal(v.counters.count, 2);
  assert.equal(v.counters.atk, 2);
});

test('COUNTER aura: retracts the instant the contract is voided', () => {
  const s = newGame(); // p0 nexus, p1 vulcan
  const bot = addUnit(s, 0, 'vx_011');
  fileContract(s, 0, 'vx_c04');
  assert.equal(boardView(s, 0, bot.id).attack, CARDS.vx_011.attack + 1);
  const cid = s.players[0].contracts[0].id;
  end(s); // p1's turn
  giveCapital(s, 1);
  const idx = putInHand(s, 1, 'ntr_c02'); // Void Clause — null & void enemy contract
  const r = applyAction(s, 1, { type: 'playCard', handIndex: idx, target: cid, position: null });
  assert.equal(r.ok, true);
  assert.ok(find(r.events, 'contractVoided'));
  assert.equal(boardView(s, 0, bot.id).attack, CARDS.vx_011.attack, 'aura gone once contract left');
});

test('COUNTER aura: an aura only applies for the CURRENT owner (steal drops it)', () => {
  const s = newGame(); // p0 nexus, p1 vulcan
  const bot = addUnit(s, 1, 'vx_011'); // robotic, owned by p1
  fileContract(s, 1, 'vx_c04'); // p1 has the aura → boosted
  assert.equal(boardView(s, 1, bot.id).attack, CARDS.vx_011.attack + 1);
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ob_015'); // Hostile Takeover — steal any enemy asset
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: bot.id, position: null });
  assert.equal(r.ok, true);
  const stolen = s.players[0].board[s.players[0].board.length - 1];
  assert.equal(stolen.cardId, 'vx_011');
  // p0 has no Retooling Order, so the aura does NOT follow the unit
  assert.equal(boardView(s, 0, stolen.id).attack, CARDS.vx_011.attack, 'stolen unit unbuffed under new owner');
});

test('COUNTER aura: transform off the ROBOTIC class ends the buff', () => {
  const s = newGame(); // p0 nexus, p1 vulcan
  const bot = addUnit(s, 1, 'vx_011'); // robotic
  fileContract(s, 1, 'vx_c04');
  assert.equal(boardView(s, 1, bot.id).attack, CARDS.vx_011.attack + 1);
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'hx_021'); // Forced Mutation → Lab Rat (organism)
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: bot.id, position: null });
  assert.equal(r.ok, true);
  const now = s.players[1].board.find((u) => u.id === bot.id);
  assert.equal(now.cardId, 'hx_t_labrat', 'transformed');
  assert.equal(boardView(s, 1, bot.id).attack, CARDS.hx_t_labrat.attack, 'lab rat gets no robotic aura');
});

test('COUNTER aura: cloneState carries auras (bot simulation sees boosted stats)', () => {
  const s = newGame();
  const bot = addUnit(s, 0, 'vx_011');
  fileContract(s, 0, 'vx_c04');
  const clone = cloneState(s);
  assert.equal(boardView(clone, 0, bot.id).attack, CARDS.vx_011.attack + 1, 'aura survives clone');
});

// ---------------------------------------------------------------------------
// DYNAMIC ATTACK — Hedge Fund (ob_024): Attack always equals owner's Capital.
// ---------------------------------------------------------------------------
test('DYNAMIC attack: Hedge Fund attack equals current Capital, live', () => {
  const s = newGame();
  const hf = addUnit(s, 0, 'ob_024'); // prints 0 attack, dynamicAttack: capital
  s.players[0].capital = 4;
  assert.equal(boardView(s, 0, hf.id).attack, 4, 'attack = capital (4)');
  s.players[0].capital = 7;
  assert.equal(boardView(s, 0, hf.id).attack, 7, 'attack tracks capital up to 7');
  s.players[0].capital = 1;
  assert.equal(boardView(s, 0, hf.id).attack, 1, 'and back down to 1');
});

test('DYNAMIC attack: combat swings for current Capital; buffs & auras stack on top', () => {
  const s = newGame();
  const hf = addUnit(s, 0, 'ob_024', { enteredTurn: 0 }); // can attack
  s.players[0].capital = 6;
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: hf.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before - 6, 'hero took Capital-worth of damage');
  // a +2/+0 buff bakes onto the base and adds to the dynamic value
  s.players[0].board[0].attack += 2; // simulate a buff delta on the base
  assert.equal(boardView(s, 0, hf.id).attack, 6 + 2, 'buff stacks with the capital-driven attack');
});

test('DYNAMIC attack: at 0 Capital, attack is 0 and it cannot attack', () => {
  const s = newGame();
  const hf = addUnit(s, 0, 'ob_024', { enteredTurn: 0 });
  s.players[0].capital = 0;
  assert.equal(boardView(s, 0, hf.id).attack, 0);
  assert.ok(!legalActions(s, 0).some((a) => a.type === 'attack' && a.attackerId === hf.id),
    'a 0-attack Hedge Fund has no attack action');
});

test('DYNAMIC attack: Hedge Fund carries STEALTH (corporate veil) — untargetable until it attacks', () => {
  const s = newGame(); // p0 nexus, p1 vulcan
  const hf = addUnit(s, 1, 'ob_024');   // owned by p1, stealthed
  const other = addUnit(s, 1, 'ntr_013'); // non-stealth enemy, for contrast
  assert.ok(hf.keywords.includes('stealth'), 'has the stealth mechanic');
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ob_005'); // destroy an enemy asset (targeting enemyUnit)
  const targeted = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.ok(targeted.includes(other.id), 'the non-stealth unit IS a legal target');
  assert.ok(!targeted.includes(hf.id), 'the stealthed Hedge Fund is NOT targetable');
});

test('DYNAMIC attack: hand entry previews the live Capital value', () => {
  const s = newGame();
  s.players[0].hand.push('ob_024');
  s.players[0].capital = 5;
  const v = getView(s, 0);
  const entry = v.you.hand.find((h) => h.cardId === 'ob_024');
  assert.ok(entry, 'Hedge Fund in hand');
  assert.equal(entry.dynAttack, 5, 'hand shows current capital as its attack');
});

// ---------------------------------------------------------------------------
// ADJACENCY BUFF — Armor Plant (vx_009): an asset placed immediately beside it
// gains +1 Integrity (armor), baked at placement, both directions.
// ---------------------------------------------------------------------------
test('ARMOR: an asset deployed beside Armor Plant gains +1 Integrity', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'vx_009'); // Armor Plant at index 0
  const idx = putInHand(s, 0, 'ntr_013'); // 4/5
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.cardId, 'ntr_013');
  assert.equal(placed.health, CARDS.ntr_013.health + 1, '+1 current durability');
  assert.equal(placed.maxHealth, CARDS.ntr_013.health + 1, '+1 max durability');
  const buff = findAll(r.events, 'buff').find((e) => e.unitId === placed.id);
  assert.ok(buff && buff.health === 1 && buff.attack === 0, 'a +0/+1 buff was emitted');
});

test('ARMOR: an asset deployed NOT adjacent gets nothing', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'vx_009');   // index 0
  addUnit(s, 0, 'vx_005');   // index 1 (a spacer)
  const idx = putInHand(s, 0, 'ntr_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 2 }); // right of the spacer
  assert.equal(r.ok, true);
  const placed = s.players[0].board[2];
  assert.equal(placed.health, CARDS.ntr_013.health, 'no armor when not beside the plant');
  assert.equal(findAll(r.events, 'buff').length, 0);
});

test('ARMOR: dropping Armor Plant beside existing assets buffs them (both directions)', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const left = addUnit(s, 0, 'ntr_013');  // index 0
  const right = addUnit(s, 0, 'vx_005');  // index 1
  const idx = putInHand(s, 0, 'vx_009');  // Armor Plant
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 }); // between them
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[1].cardId, 'vx_009', 'plant landed in the middle');
  assert.equal(left.health, CARDS.ntr_013.health + 1, 'left neighbor armored');
  assert.equal(right.health, CARDS.vx_005.health + 1, 'right neighbor armored');
});

test('ARMOR: an asset flanked by TWO Armor Plants gets +2', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'vx_009'); // index 0
  addUnit(s, 0, 'vx_009'); // index 1
  const idx = putInHand(s, 0, 'ntr_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 }); // between the two plants
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.health, CARDS.ntr_013.health + 2, 'armored by both plants');
});

test('ARMOR: an enemy Armor Plant never armors your assets', () => {
  const s = newGame();
  addUnit(s, 1, 'vx_009'); // enemy plant at their index 0
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'ntr_013');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 0 });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[0].health, CARDS.ntr_013.health, 'no cross-board armor');
});

// ---------------------------------------------------------------------------
// ADJACENCY BUFF (class-gated) — Bioreactor (hx_007): +1/+1 to an ORGANISM
// asset placed immediately beside it; unlike Armor Plant, non-organisms get
// nothing. Same both-directions/baked-permanently engine path as Armor Plant.
// ---------------------------------------------------------------------------
test('BIOREACTOR: an ORGANISM asset deployed beside it gains +1/+1', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'hx_007'); // Bioreactor at index 0
  const idx = putInHand(s, 0, 'hx_001'); // Lab Culture — organism
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.cardId, 'hx_001');
  assert.equal(placed.attack, CARDS.hx_001.attack + 1);
  assert.equal(placed.health, CARDS.hx_001.health + 1);
  assert.equal(placed.maxHealth, CARDS.hx_001.health + 1);
  const buff = findAll(r.events, 'buff').find((e) => e.unitId === placed.id);
  assert.ok(buff && buff.attack === 1 && buff.health === 1, 'a +1/+1 buff was emitted');
});

test('BIOREACTOR: a non-ORGANISM asset deployed beside it gets nothing', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'hx_007'); // Bioreactor
  const idx = putInHand(s, 0, 'ntr_013'); // personnel, not organism
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.attack, CARDS.ntr_013.attack, 'no bonus — wrong asset class');
  assert.equal(placed.health, CARDS.ntr_013.health, 'no bonus — wrong asset class');
  assert.equal(findAll(r.events, 'buff').length, 0);
});

test('BIOREACTOR: dropping it beside an existing ORGANISM buffs both directions', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const organism = addUnit(s, 0, 'hx_001'); // index 0
  const idx = putInHand(s, 0, 'hx_007'); // Bioreactor
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 }); // beside it
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[1].cardId, 'hx_007');
  assert.equal(organism.attack, CARDS.hx_001.attack + 1, 'existing organism neighbor buffed');
  assert.equal(organism.health, CARDS.hx_001.health + 1, 'existing organism neighbor buffed');
});

test('BIOREACTOR: dropping it beside an existing non-ORGANISM buffs nothing', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const personnel = addUnit(s, 0, 'ntr_013'); // index 0, not organism
  const idx = putInHand(s, 0, 'hx_007'); // Bioreactor
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  assert.equal(personnel.attack, CARDS.ntr_013.attack, 'wrong asset class — no buff');
  assert.equal(personnel.health, CARDS.ntr_013.health, 'wrong asset class — no buff');
});

test('BIOREACTOR: an enemy Bioreactor never buffs your organisms', () => {
  const s = newGame();
  addUnit(s, 1, 'hx_007'); // enemy Bioreactor at their index 0
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'hx_001'); // organism, but on the other board
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 0 });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[0].attack, CARDS.hx_001.attack, 'no cross-board bonus');
  assert.equal(s.players[0].board[0].health, CARDS.hx_001.health, 'no cross-board bonus');
});

// ---------------------------------------------------------------------------
// ADJACENCY BUFF (class-gated) — Compute Cluster (nx_020): +1/+1 to a SOFTWARE
// asset placed immediately beside it. Same engine path as Bioreactor, just a
// different class filter — this suite mainly guards the class-gate itself.
// ---------------------------------------------------------------------------
test('COMPUTE CLUSTER: a SOFTWARE asset deployed beside it gains +1/+1', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'nx_020'); // Compute Cluster at index 0
  const idx = putInHand(s, 0, 'nx_002'); // Web Crawler — software
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.cardId, 'nx_002');
  assert.equal(placed.attack, CARDS.nx_002.attack + 1);
  assert.equal(placed.health, CARDS.nx_002.health + 1);
  const buff = findAll(r.events, 'buff').find((e) => e.unitId === placed.id);
  assert.ok(buff && buff.attack === 1 && buff.health === 1, 'a +1/+1 buff was emitted');
});

test('COMPUTE CLUSTER: a non-SOFTWARE asset deployed beside it gets nothing', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'nx_020'); // Compute Cluster
  const idx = putInHand(s, 0, 'ntr_013'); // personnel, not software
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  const placed = s.players[0].board[1];
  assert.equal(placed.attack, CARDS.ntr_013.attack, 'no bonus — wrong asset class');
  assert.equal(placed.health, CARDS.ntr_013.health, 'no bonus — wrong asset class');
  assert.equal(findAll(r.events, 'buff').length, 0);
});

test('COMPUTE CLUSTER: dropping it beside an existing SOFTWARE asset buffs both directions', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const soft = addUnit(s, 0, 'nx_002'); // Web Crawler, index 0
  const idx = putInHand(s, 0, 'nx_020'); // Compute Cluster
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 1 });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[1].cardId, 'nx_020');
  assert.equal(soft.attack, CARDS.nx_002.attack + 1, 'existing software neighbor buffed');
  assert.equal(soft.health, CARDS.nx_002.health + 1, 'existing software neighbor buffed');
});

test('COMPUTE CLUSTER: an enemy Compute Cluster never buffs your software', () => {
  const s = newGame();
  addUnit(s, 1, 'nx_020'); // enemy Compute Cluster at their index 0
  giveCapital(s, 0, 10);
  const idx = putInHand(s, 0, 'nx_002'); // software, but on the other board
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: null, position: 0 });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board[0].attack, CARDS.nx_002.attack, 'no cross-board bonus');
  assert.equal(s.players[0].board[0].health, CARDS.nx_002.health, 'no cross-board bonus');
});

// ---------------------------------------------------------------------------
// FIREWALL UPGRADE (ntr_036): grant FIREWALL to a friendly asset that lacks it.
// ---------------------------------------------------------------------------
test('FIREWALL UPGRADE: grants FIREWALL to a friendly asset', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const u = addUnit(s, 0, 'ntr_013'); // no firewall
  const idx = putInHand(s, 0, 'ntr_036');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: u.id, position: null });
  assert.equal(r.ok, true);
  assert.ok(u.keywords.includes('firewall'), 'asset now has FIREWALL');
  assert.ok(find(r.events, 'keyword'), 'keyword grant event emitted');
});

test('FIREWALL UPGRADE: assets that already have FIREWALL are not legal targets', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const already = addUnit(s, 0, 'ntr_007'); // Security Guard — already FIREWALL
  const fresh = addUnit(s, 0, 'ntr_013');   // no firewall
  const idx = putInHand(s, 0, 'ntr_036');
  const targets = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.ok(targets.includes(fresh.id), 'the non-firewall asset IS a target');
  assert.ok(!targets.includes(already.id), 'the already-firewall asset is NOT');
});

test('FIREWALL UPGRADE: an enemy asset is never a legal target', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const enemy = addUnit(s, 1, 'ntr_013');
  addUnit(s, 0, 'ntr_002'); // a friendly target so the card is playable
  const idx = putInHand(s, 0, 'ntr_036');
  const targets = legalActions(s, 0)
    .filter((a) => a.type === 'playCard' && a.handIndex === idx)
    .map((a) => a.target);
  assert.ok(!targets.includes(enemy.id), 'cannot upgrade an enemy asset');
});

// ---------------------------------------------------------------------------
// BULLISH (trample): attack beyond a blocker's Integrity spills to the enemy CEO.
// ---------------------------------------------------------------------------
test('BULLISH: excess attack over the blocker tramples to the enemy CEO', () => {
  const s = newGame();
  const bull = addUnit(s, 0, 'vx_017', { attack: 8, enteredTurn: 0 }); // 8-attack bullish
  const blocker = addUnit(s, 1, 'ntr_002', { health: 3, maxHealth: 3 });
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: bull.id, targetId: blocker.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'blocker destroyed');
  assert.equal(s.players[1].integrity, before - 5, 'overflow (8 − 3) hit the CEO');
});

test('BULLISH: no overflow when attack does not exceed the blocker', () => {
  const s = newGame();
  const bull = addUnit(s, 0, 'vx_017', { attack: 4, enteredTurn: 0 });
  const blocker = addUnit(s, 1, 'ntr_013', { health: 5, maxHealth: 5 });
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: bull.id, targetId: blocker.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before, 'blocker soaked it all — no trample');
});

test('BULLISH: a non-bullish attacker never tramples', () => {
  const s = newGame();
  const norm = addUnit(s, 0, 'ntr_019', { attack: 9, enteredTurn: 0 }); // 9 attack, no bullish
  const blocker = addUnit(s, 1, 'ntr_002', { health: 2, maxHealth: 2 });
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: norm.id, targetId: blocker.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before, 'no keyword, no overflow');
});

test('BULLISH: tramples THROUGH a firewall blocker into the CEO', () => {
  const s = newGame();
  const bull = addUnit(s, 0, 'vx_017', { attack: 8, enteredTurn: 0 });
  const wall = addUnit(s, 1, 'ntr_007', { health: 2, maxHealth: 2 }); // Security Guard, FIREWALL 2 hp
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: bull.id, targetId: wall.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before - 6, 'overflow (8 − 2) went through the taunt');
});

test('BULLISH: attacking the CEO directly deals full damage (no overflow concept)', () => {
  const s = newGame();
  const bull = addUnit(s, 0, 'vx_017', { attack: 8, enteredTurn: 0 });
  const before = s.players[1].integrity;
  const r = applyAction(s, 0, { type: 'attack', attackerId: bull.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].integrity, before - 8);
});

test('BULLISH: lethal overflow ends the game', () => {
  const s = newGame();
  s.players[1].integrity = 4;
  const bull = addUnit(s, 0, 'vx_017', { attack: 9, enteredTurn: 0 });
  addUnit(s, 1, 'ntr_002', { health: 2, maxHealth: 2 });
  const r = applyAction(s, 0, { type: 'attack', attackerId: bull.id, targetId: s.players[1].board[0].id });
  assert.equal(r.ok, true);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0, 'trample overflow (7) was lethal');
});

test('BULLISH + SIPHON (Gigafauna): overflow to the CEO also siphons', () => {
  const s = newGame();
  s.players[0].integrity = 10; // room to heal
  const giga = addUnit(s, 0, 'hx_022', { attack: 9, enteredTurn: 0 }); // siphon + bullish
  addUnit(s, 1, 'ntr_002', { health: 2, maxHealth: 2 });
  const r = applyAction(s, 0, { type: 'attack', attackerId: giga.id, targetId: s.players[1].board[0].id });
  assert.equal(r.ok, true);
  // 9 total damage dealt (2 to blocker + 7 trample) → siphon heals owner for all of it
  assert.equal(s.players[0].integrity, 10 + 9, 'siphon healed for all damage incl. the trample');
});

// ---------------------------------------------------------------------------
// RAID (Corporate Raider ob_009): a survived attack banks a 1-Capital steal
// against the defender, applied once at the start of their next turn.
// ---------------------------------------------------------------------------
test('RAID: attacking the enemy CEO directly and surviving banks a capital drain', () => {
  const s = newGame();
  const raider = addUnit(s, 0, 'ob_009');
  const r = applyAction(s, 0, { type: 'attack', attackerId: raider.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].capitalDrain, 1);
  const ev = find(r.events, 'capitalRaid');
  assert.ok(ev, 'capitalRaid event emitted');
  assert.equal(ev.player, 0);
  assert.equal(ev.targetPlayer, 1);
  assert.equal(ev.unitId, raider.id);
  assert.equal(ev.cardId, 'ob_009');
});

test('RAID: the banked drain reduces the victim\'s capital exactly once, then clears', () => {
  const s = newGame();
  const raider = addUnit(s, 0, 'ob_009');
  applyAction(s, 0, { type: 'attack', attackerId: raider.id, targetId: 'hero1' });
  end(s); // -> player 1's turn: startTurn applies + clears the drain
  assert.equal(s.players[1].maxCapital, 1);
  assert.equal(s.players[1].capital, 0, 'drain knocked a full point off this turn only');
  assert.equal(s.players[1].capitalDrain, 0, 'drain cleared after being applied');
});

test('RAID: killing a blocker while surviving still banks the drain', () => {
  const s = newGame();
  const raider = addUnit(s, 0, 'ob_009'); // 4/4/5
  const weak = addUnit(s, 1, 'ntr_013', { attack: 2, health: 3, maxHealth: 3 });
  const r = applyAction(s, 0, { type: 'attack', attackerId: raider.id, targetId: weak.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].board.length, 0, 'blocker destroyed');
  assert.equal(raider.health, 3, 'raider took 2 retaliation but survived');
  assert.equal(s.players[1].capitalDrain, 1);
});

test('RAID: dying to retaliation does NOT bank a drain', () => {
  const s = newGame();
  const raider = addUnit(s, 0, 'ob_009'); // 4/4/5
  const brawler = addUnit(s, 1, 'ntr_013', { attack: 6, health: 6, maxHealth: 6 });
  const r = applyAction(s, 0, { type: 'attack', attackerId: raider.id, targetId: brawler.id });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].board.length, 0, 'raider died to retaliation');
  assert.equal(s.players[1].capitalDrain, 0, 'no drain — the raider did not survive');
  assert.equal(find(r.events, 'capitalRaid'), undefined);
});

test('RAID: a non-RAID attacker never banks a drain', () => {
  const s = newGame();
  const norm = addUnit(s, 0, 'ntr_019');
  const r = applyAction(s, 0, { type: 'attack', attackerId: norm.id, targetId: 'hero1' });
  assert.equal(r.ok, true);
  assert.equal(s.players[1].capitalDrain, 0);
  assert.equal(find(r.events, 'capitalRaid'), undefined);
});

test('RAID: two survived raids before the victim\'s next turn stack the drain', () => {
  const s = newGame();
  const raider1 = addUnit(s, 0, 'ob_009');
  const raider2 = addUnit(s, 0, 'ob_009');
  applyAction(s, 0, { type: 'attack', attackerId: raider1.id, targetId: 'hero1' });
  applyAction(s, 0, { type: 'attack', attackerId: raider2.id, targetId: 'hero1' });
  assert.equal(s.players[1].capitalDrain, 2, 'both raids banked');
});

// ---------------------------------------------------------------------------
// FLIRTY INTERN (ntr_037): distract an enemy asset — can't attack for 3 turns.
// ---------------------------------------------------------------------------
test('FLIRTY INTERN: charms an enemy asset for 3 turns', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const foe = addUnit(s, 1, 'ntr_013');
  const idx = putInHand(s, 0, 'ntr_037');
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: foe.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(foe.distracted, 3, 'distracted counter set to 3');
  const ev = find(r.events, 'distract');
  assert.ok(ev && ev.turns === 3, 'distract event carries the count');
});

test('FLIRTY INTERN: a distracted unit cannot be declared as an attacker', () => {
  const s = newGame();
  end(s); // p1 active
  const foe = addUnit(s, 1, 'ntr_013', { distracted: 2, enteredTurn: -5 });
  const acts = legalActions(s, 1).filter((a) => a.type === 'attack' && a.attackerId === foe.id);
  assert.equal(acts.length, 0, 'charmed — no attack action offered');
  foe.distracted = 0;
  const freed = legalActions(s, 1).filter((a) => a.type === 'attack' && a.attackerId === foe.id);
  assert.ok(freed.length > 0, 'once the counter hits 0 it can attack again');
});

test('FLIRTY INTERN: the counter ticks down only at the end of the OWNER’s turn', () => {
  const s = newGame(); // p0 active; foe belongs to p1
  const foe = addUnit(s, 1, 'ntr_013', { distracted: 3, enteredTurn: -5 });
  end(s); assert.equal(foe.distracted, 3, 'p0 turn ended — p1 unit untouched');
  end(s); assert.equal(foe.distracted, 2, 'p1 turn ended — ticked to 2');
  end(s); assert.equal(foe.distracted, 2, 'p0 turn ended — still 2');
  end(s); assert.equal(foe.distracted, 1, 'p1 turn ended — ticked to 1');
  end(s); assert.equal(foe.distracted, 1, 'p0 turn ended — still 1');
  end(s); assert.equal(foe.distracted, 0, 'p1 turn ended — free again');
});

test('FLIRTY INTERN: SILENCE (Gag Order) cleanses the distraction', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const foe = addUnit(s, 1, 'ntr_013', { distracted: 3 });
  const idx = putInHand(s, 0, 'ntr_029'); // Gag Order — silence an asset
  const r = applyAction(s, 0, { type: 'playCard', handIndex: idx, target: foe.id, position: null });
  assert.equal(r.ok, true);
  assert.equal(foe.distracted, 0, 'silence removed the charm');
});

// ---------------------------------------------------------------------------
// BIG HIT — cumulative ENEMY-caused damage to a hero within one game-turn
// crossing BIG_HIT_THRESHOLD (10) fires a one-time `bigHit` event (client
// plays the attacker's CEO taunt). Self-inflicted damage never counts.
// ---------------------------------------------------------------------------
test('BIG HIT: cumulative enemy damage crossing the threshold fires once, with correct fields', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_019', { attack: 6 });
  const b = addUnit(s, 0, 'ntr_020', { attack: 6 });
  const r1 = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' });
  assert.equal(find(r1.events, 'bigHit'), undefined, 'first hit alone (6) is below the threshold');
  const r2 = applyAction(s, 0, { type: 'attack', attackerId: b.id, targetId: 'hero1' });
  const bh = find(r2.events, 'bigHit');
  assert.ok(bh, 'cumulative 12 this turn crosses the threshold');
  assert.equal(bh.targetPlayer, 1);
  assert.equal(bh.attackerPlayer, 0);
  assert.equal(bh.amount, 12);
});

test('BIG HIT: damage that never crosses the threshold does not fire', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_019', { attack: 9 });
  const r = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' });
  assert.equal(find(r.events, 'bigHit'), undefined);
});

test('BIG HIT: fires once per turn, then resets on a later turn', () => {
  const s = newGame();
  const a = addUnit(s, 0, 'ntr_019', { attack: 10 });
  const b = addUnit(s, 0, 'ntr_020', { attack: 5 });
  const c = addUnit(s, 0, 'ntr_006', { attack: 10 });
  const r1 = applyAction(s, 0, { type: 'attack', attackerId: a.id, targetId: 'hero1' });
  assert.ok(find(r1.events, 'bigHit'), 'crosses the threshold on the first hit');
  const r2 = applyAction(s, 0, { type: 'attack', attackerId: b.id, targetId: 'hero1' });
  assert.equal(find(r2.events, 'bigHit'), undefined, 'does not re-fire again this same turn');
  end(s); end(s); // p1's turn, then back to p0 — resets tracking for the new turn
  const r3 = applyAction(s, 0, { type: 'attack', attackerId: c.id, targetId: 'hero1' });
  assert.ok(find(r3.events, 'bigHit'), 'fires again on a later turn');
});

test('BIG HIT: self-inflicted damage (fatigue) never fires it, even stacked past the threshold', () => {
  const s = newGame();
  s.players[0].deck = [];
  s.players[0].integrity = 200; // survive enough empty draws to stack fatigue past 10
  let r;
  while (s.players[0].fatigue < 10) {
    end(s); // p1's turn (their deck is untouched — no fatigue for them)
    r = end(s); // back to p0 — draws from an empty deck, fatigues
  }
  assert.equal(s.players[0].fatigue, 10);
  assert.equal(find(r.events, 'bigHit'), undefined, 'fatigue self-damage never fires bigHit');
  assert.equal(s.players[0].bigHitFired, false);
});

// ---------------------------------------------------------------------------
// CORPORATE LOBBYIST (ntr_038): while in play, your CONTRACTS cost 1 less.
// The inverse of nx_c01 (an ASSET discounting CONTRACTS, not a CONTRACT
// discounting OPERATIONS) — same live/stacking/floor-at-0 behavior, mirrored
// off assetStatic instead of contractStatic.
// ---------------------------------------------------------------------------
test('CORPORATE LOBBYIST: contracts cost 1 less (floor 0), stacks; non-contracts unaffected', () => {
  const s = newGame(); // nexus vs vulcan
  giveCapital(s, 0, 10);
  addUnit(s, 0, 'ntr_038'); // Corporate Lobbyist (1 copy: -1)
  const iC4 = putInHand(s, 0, 'nx_c02'); // CONTRACT, cost 4
  const iC2 = putInHand(s, 0, 'nx_c03'); // CONTRACT, cost 2
  const iOp = putInHand(s, 0, 'nx_015'); // OPERATION, cost 3
  const iAsset = putInHand(s, 0, 'nx_004'); // ASSET, cost 2
  let v = getView(s, 0);
  assert.equal(v.you.hand[iC4].cost, 3, 'reduced by 1');
  assert.equal(v.you.hand[iC2].cost, 1, 'reduced by 1');
  assert.equal(v.you.hand[iOp].cost, 3, 'operation cost unchanged');
  assert.equal(v.you.hand[iAsset].cost, 2, 'asset cost unchanged');
  addUnit(s, 0, 'ntr_038'); // 2nd copy: -2
  addUnit(s, 0, 'ntr_038'); // 3rd copy: -3, enough to floor the cost-2 contract
  v = getView(s, 0);
  assert.equal(v.you.hand[iC4].cost, 1, '4 − 3');
  assert.equal(v.you.hand[iC2].cost, 0, '2 − 3 floored at 0, never negative');
  // validation + deduction use the same effective cost
  s.players[0].capital = 1;
  assert.equal(getView(s, 0).you.hand[iC4].playable, true);
  assert.ok(legalActions(s, 0).some((a) => a.type === 'playCard' && a.handIndex === iC4));
  const r = applyAction(s, 0, { type: 'playCard', handIndex: iC4, target: null, position: null });
  assert.equal(r.ok, true);
  assert.equal(s.players[0].capital, 0, 'deducted the reduced cost');
});

test("CORPORATE LOBBYIST reduces only the owner's contracts", () => {
  const s = newGame();
  addUnit(s, 0, 'ntr_038');
  end(s); // p1's turn
  const idx = putInHand(s, 1, 'nx_c03'); // CONTRACT, cost 2, in p1's hand
  assert.equal(getView(s, 1).you.hand[idx].cost, 2, 'opponent gets no discount');
});

test('CORPORATE LOBBYIST: discount is live — vanishes the instant it leaves the board', () => {
  const s = newGame();
  giveCapital(s, 0, 10);
  const lob = addUnit(s, 0, 'ntr_038');
  const idx = putInHand(s, 0, 'nx_c03'); // CONTRACT, cost 2
  assert.equal(getView(s, 0).you.hand[idx].cost, 1, 'discounted while the lobbyist is in play');
  s.players[0].board = s.players[0].board.filter((u) => u.id !== lob.id);
  assert.equal(getView(s, 0).you.hand[idx].cost, 2, 'discount gone once the lobbyist leaves the board');
});

// ---------------------------------------------------------------------------
// REGULATORY CAPTURE (ntr_c03): while in play, your OPPONENT's cards cost 1
// more. The evil twin of Corporate Lobbyist — filed by the caster, but it's
// the caster's OPPONENT who pays, on every card type (not just contracts).
// ---------------------------------------------------------------------------
test('REGULATORY CAPTURE: taxes the OPPONENT across every card type; casters own costs untouched', () => {
  const s = newGame(); // nexus vs vulcan
  fileContract(s, 0, 'ntr_c03'); // filed by p0
  const iAsset = putInHand(s, 1, 'vx_002'); // ASSET
  const iOp = putInHand(s, 1, 'vx_010'); // OPERATION
  const iContract = putInHand(s, 1, 'vx_c01'); // CONTRACT
  const baseAsset = CARDS.vx_002.cost, baseOp = CARDS.vx_010.cost, baseContract = CARDS.vx_c01.cost;
  const v1 = getView(s, 1);
  assert.equal(v1.you.hand[iAsset].cost, baseAsset + 1, 'enemy asset taxed');
  assert.equal(v1.you.hand[iOp].cost, baseOp + 1, 'enemy operation taxed');
  assert.equal(v1.you.hand[iContract].cost, baseContract + 1, 'enemy contract taxed');
  // the CASTER's own costs are untouched by their own Regulatory Capture
  const iMine = putInHand(s, 0, 'nx_004'); // ASSET, cost 2
  assert.equal(getView(s, 0).you.hand[iMine].cost, CARDS.nx_004.cost, 'caster pays no tax on their own contract');
});

test('REGULATORY CAPTURE: stacks — two copies tax the opponent by 2', () => {
  const s = newGame();
  fileContract(s, 0, 'ntr_c03');
  fileContract(s, 0, 'ntr_c03');
  const idx = putInHand(s, 1, 'vx_002');
  assert.equal(getView(s, 1).you.hand[idx].cost, CARDS.vx_002.cost + 2);
});

test('REGULATORY CAPTURE stacks additively with the taxed player\'s own opCostReduction', () => {
  const s = newGame('vulcan', 'nexus'); // p1 is nexus, can field Terms of Service
  fileContract(s, 0, 'ntr_c03'); // p0 taxes p1 by +1 on everything
  fileContract(s, 1, 'nx_c01'); // p1's own -1 OPERATION discount
  const iOp = putInHand(s, 1, 'nx_015'); // OPERATION, cost 3
  const iAsset = putInHand(s, 1, 'nx_004'); // ASSET, cost 2
  const v = getView(s, 1);
  assert.equal(v.you.hand[iOp].cost, CARDS.nx_015.cost, 'own -1 op discount cancels the +1 tax on operations');
  assert.equal(v.you.hand[iAsset].cost, CARDS.nx_004.cost + 1, 'assets still feel the full tax');
});

test('REGULATORY CAPTURE: live — the tax stops the instant the contract leaves play', () => {
  const s = newGame();
  fileContract(s, 0, 'ntr_c03');
  const idx = putInHand(s, 1, 'vx_002');
  assert.equal(getView(s, 1).you.hand[idx].cost, CARDS.vx_002.cost + 1, 'taxed while filed');
  s.players[0].contracts = [];
  assert.equal(getView(s, 1).you.hand[idx].cost, CARDS.vx_002.cost, 'tax gone once nullified/removed');
});

test('REGULATORY CAPTURE does not tax the CEO power (fixed cost, not effectiveCost-driven)', () => {
  const s = newGame();
  fileContract(s, 0, 'ntr_c03');
  assert.equal(getView(s, 1).you.power.cost, 2, "CEO power cost is untouched by the enemy's tax");
});
