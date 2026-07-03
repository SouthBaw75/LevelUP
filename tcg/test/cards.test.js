// Data integrity: every card conforms to the contract schema and every DSL
// reference resolves to something the engine implements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARDS, STARTER_DECKS, validateDeck, OPS, SPECIALS, TARGETING_VALUES,
} from '../shared/engine.js';

const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian', 'neutral'];
const PREFIX = { nexus: 'nx', vulcan: 'vx', helix: 'hx', obsidian: 'ob', neutral: 'ntr' };
const KEYWORDS = ['firewall', 'fasttrack', 'stealth', 'shielded', 'overtime', 'toxic', 'siphon'];
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const TYPES = ['ASSET', 'OPERATION', 'CEO', 'POWER'];
const TRIGGERS = ['onboarding', 'play', 'parachute', 'endOfTurn'];

const all = Object.values(CARDS);
const collectible = all.filter((c) => c.collectible);

test('card ids are keys and follow <prefix>_<suffix>', () => {
  for (const [id, card] of Object.entries(CARDS)) {
    assert.equal(card.id, id);
    assert.ok(id.startsWith(PREFIX[card.faction] + '_'), `${id} prefix vs faction ${card.faction}`);
  }
});

test('every card conforms to the schema', () => {
  for (const card of all) {
    assert.ok(typeof card.name === 'string' && card.name.length > 0, card.id + ' name');
    assert.ok(FACTIONS.includes(card.faction), card.id + ' faction');
    assert.ok(TYPES.includes(card.type), card.id + ' type');
    assert.ok(Number.isInteger(card.cost) && card.cost >= 0 && card.cost <= 10, card.id + ' cost');
    assert.ok(RARITIES.includes(card.rarity), card.id + ' rarity');
    assert.equal(typeof card.collectible, 'boolean', card.id + ' collectible');
    assert.equal(typeof card.text, 'string', card.id + ' text');
    assert.ok(typeof card.flavor === 'string' && card.flavor.length > 0, card.id + ' flavor');
    assert.ok(Array.isArray(card.keywords), card.id + ' keywords');
    for (const kw of card.keywords) assert.ok(KEYWORDS.includes(kw), `${card.id} keyword ${kw}`);
    assert.ok(card.effects && typeof card.effects === 'object', card.id + ' effects');
    if (card.type === 'ASSET') {
      assert.ok(Number.isInteger(card.attack) && card.attack >= 0, card.id + ' attack');
      assert.ok(Number.isInteger(card.health) && card.health >= 1, card.id + ' health');
    }
    if (card.type === 'CEO') {
      assert.equal(card.health, 30, card.id + ' CEO health');
      assert.equal(CARDS[card.powerId]?.type, 'POWER', card.id + ' powerId');
      assert.equal(card.collectible, false);
    }
    if (card.type === 'POWER') {
      assert.equal(card.cost, 2, card.id + ' power cost');
      assert.equal(card.collectible, false);
      assert.ok(Array.isArray(card.effects.play), card.id + ' power ops');
    }
    if (card.effects.targeting !== undefined) {
      assert.ok(TARGETING_VALUES.includes(card.effects.targeting), card.id + ' targeting');
    }
  }
});

test('every referenced DSL op / special / token / keyword is implemented', () => {
  for (const card of all) {
    for (const [key, val] of Object.entries(card.effects)) {
      if (key === 'targeting') continue;
      assert.ok(TRIGGERS.includes(key), `${card.id} unknown trigger ${key}`);
      assert.ok(Array.isArray(val), `${card.id} trigger ${key} must be an ops array`);
      for (const op of val) {
        assert.ok(OPS[op.op], `${card.id} references unimplemented op "${op.op}"`);
        if (op.op === 'special') {
          assert.ok(SPECIALS[op.key], `${card.id} references unimplemented special "${op.key}"`);
        }
        if (op.op === 'summon' || op.op === 'transform') {
          const t = CARDS[op.cardId];
          assert.ok(t, `${card.id} references missing card ${op.cardId}`);
          assert.equal(t.type, 'ASSET', `${card.id} summons/transforms into non-ASSET`);
        }
        if (op.op === 'grantKeyword') {
          assert.ok(KEYWORDS.includes(op.keyword), `${card.id} grants unknown keyword`);
        }
        if (op.op === 'damage' || op.op === 'heal' || op.op === 'aoeDamage') {
          assert.ok(Number.isInteger(op.amount) && op.amount > 0, `${card.id} ${op.op} amount`);
        }
      }
    }
    // targeted play/onboarding effects must declare targeting, and vice versa
    const usesTarget = TRIGGERS.some((t) =>
      (card.effects[t] || []).some((op) => (op.to || (op.op === 'special' ? 'target' : '')) === 'target'));
    if (usesTarget) {
      assert.ok(card.effects.targeting, `${card.id} has target ops but no targeting`);
    }
  }
});

test('collectible counts match the contract (~120: 22 per faction + 30+ neutral)', () => {
  const byFaction = {};
  for (const c of collectible) byFaction[c.faction] = (byFaction[c.faction] || 0) + 1;
  assert.equal(byFaction.nexus, 22);
  assert.equal(byFaction.vulcan, 22);
  assert.equal(byFaction.helix, 22);
  assert.equal(byFaction.obsidian, 22);
  assert.ok(byFaction.neutral >= 30, 'at least 30 neutral');
  assert.equal(collectible.length, 120);
});

test('cost and rarity spreads', () => {
  const costs = new Set(collectible.map((c) => c.cost));
  assert.ok(costs.has(0), 'a 0-cost card exists');
  assert.ok(Math.max(...costs) === 10, 'a 10-cost card exists');
  for (const f of FACTIONS) {
    const cards = collectible.filter((c) => c.faction === f);
    for (const r of RARITIES) {
      assert.ok(cards.some((c) => c.rarity === r), `${f} has a ${r} card`);
    }
  }
});

test('CEO and POWER cards exist for all four factions; subsidy exists', () => {
  for (const f of ['nx', 'vx', 'hx', 'ob']) {
    const ceo = CARDS[`${f}_ceo`];
    const power = CARDS[`${f}_power`];
    assert.ok(ceo && ceo.type === 'CEO', f + '_ceo');
    assert.ok(power && power.type === 'POWER' && power.cost === 2, f + '_power');
    assert.equal(ceo.powerId, `${f}_power`);
  }
  const subsidy = CARDS.ntr_subsidy;
  assert.ok(subsidy && subsidy.type === 'OPERATION' && subsidy.cost === 0 && !subsidy.collectible);
});

test('contract sample card vx_004 matches the contract', () => {
  const c = CARDS.vx_004;
  assert.equal(c.name, 'Strike Battalion');
  assert.equal(c.faction, 'vulcan');
  assert.equal(c.type, 'ASSET');
  assert.equal(c.cost, 4);
  assert.deepEqual(c.keywords, ['fasttrack']);
  assert.equal(c.flavor, 'Quarterly targets are not a suggestion.');
});

test('STARTER_DECKS: four tuned decks that validate', () => {
  assert.deepEqual(Object.keys(STARTER_DECKS).sort(),
    ['helix', 'nexus', 'obsidian', 'vulcan']);
  for (const [key, deck] of Object.entries(STARTER_DECKS)) {
    assert.equal(deck.faction, key);
    assert.ok(typeof deck.name === 'string' && deck.name.length > 0);
    assert.deepEqual(validateDeck(deck), { ok: true }, key + ' deck validates');
  }
});
