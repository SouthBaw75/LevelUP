// Data integrity: every card conforms to the contract schema and every DSL
// reference resolves to something the engine implements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARDS, STARTER_DECKS, validateDeck, OPS, SPECIALS, TARGETING_VALUES,
} from '../shared/engine.js';

const FACTIONS = ['nexus', 'vulcan', 'helix', 'obsidian', 'neutral'];
const PREFIX = { nexus: 'nx', vulcan: 'vx', helix: 'hx', obsidian: 'ob', neutral: 'ntr' };
const KEYWORDS = ['firewall', 'fasttrack', 'stealth', 'shielded', 'overtime', 'toxic', 'siphon',
  'layoff', 'severance', 'bullish', 'raid'];
const TAG_VALUES = ['robotic', 'software', 'facility', 'organism', 'financial', 'personnel'];
const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const TYPES = ['ASSET', 'OPERATION', 'CEO', 'POWER', 'CONTRACT'];
const TRIGGERS = ['onboarding', 'play', 'parachute', 'endOfTurn',
  'startOfTurn', 'onOperationPlayed', 'onFriendlyAssetDestroyed'];
const STATIC_KEYS = ['opCostReduction', 'opDamageBonus', 'contractCostReduction', 'enemyCostIncrease'];
const ASSET_ONLY_STATIC_KEYS = ['contractCostReduction'];

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
      assert.equal(card.health, 40, card.id + ' CEO health');
      assert.equal(CARDS[card.powerId]?.type, 'POWER', card.id + ' powerId');
      assert.equal(card.collectible, false);
    }
    if (card.type === 'POWER') {
      assert.equal(card.cost, 2, card.id + ' power cost');
      assert.equal(card.collectible, false);
      assert.ok(Array.isArray(card.effects.play), card.id + ' power ops');
    }
    if (card.type === 'CONTRACT') {
      assert.equal(card.attack, undefined, card.id + ' contracts have no attack');
      assert.equal(card.health, undefined, card.id + ' contracts have no health');
      assert.deepEqual(card.keywords, [], card.id + ' contracts have no keywords');
    }
    if (card.term !== undefined) {
      assert.equal(card.type, 'CONTRACT', card.id + ' term is contract-only');
      assert.ok(Number.isInteger(card.term) && card.term >= 1, card.id + ' term');
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
      if (key === 'static') {
        for (const [sk, sv] of Object.entries(val)) {
          assert.ok(STATIC_KEYS.includes(sk), `${card.id} unknown static ${sk}`);
          assert.ok(Number.isInteger(sv) && sv > 0, `${card.id} static ${sk} value`);
          const wantType = ASSET_ONLY_STATIC_KEYS.includes(sk) ? 'ASSET' : 'CONTRACT';
          assert.equal(card.type, wantType, `${card.id} static ${sk} is ${wantType.toLowerCase()}-only`);
        }
        continue;
      }
      if (key === 'bothParties') {
        assert.equal(card.type, 'CONTRACT', `${card.id} bothParties is contract-only`);
        assert.equal(val, true, `${card.id} bothParties`);
        continue;
      }
      if (key === 'reserve') {
        assert.equal(card.type, 'CONTRACT', `${card.id} reserve is contract-only`);
        assert.ok(val && typeof val === 'object', `${card.id} reserve object`);
        assert.equal(val.assetOnly, true, `${card.id} reserve.assetOnly`);
        continue;
      }
      if (key === 'aura') {
        assert.equal(card.type, 'CONTRACT', `${card.id} aura is contract-only`);
        assert.ok(val && typeof val === 'object', `${card.id} aura object`);
        assert.ok(val.match && TAG_VALUES.includes(val.match.tag), `${card.id} aura match.tag`);
        assert.ok(Number.isInteger(val.attack) && val.attack !== 0, `${card.id} aura attack`);
        continue;
      }
      if (key === 'dynamicAttack') {
        assert.equal(card.type, 'ASSET', `${card.id} dynamicAttack is asset-only`);
        assert.ok(['capital'].includes(val), `${card.id} dynamicAttack source`);
        assert.equal(card.attack, 0, `${card.id} dynamicAttack cards print 0 base attack`);
        continue;
      }
      if (key === 'adjacencyBuff') {
        assert.equal(card.type, 'ASSET', `${card.id} adjacencyBuff is asset-only`);
        assert.ok(val && typeof val === 'object', `${card.id} adjacencyBuff object`);
        assert.ok(Number.isInteger(val.attack ?? 0) && Number.isInteger(val.health ?? 0),
          `${card.id} adjacencyBuff deltas`);
        if (val.match) assert.ok(TAG_VALUES.includes(val.match.tag), `${card.id} adjacencyBuff match.tag`);
        continue;
      }
      if (key === 'combatBonus') {
        assert.equal(card.type, 'ASSET', `${card.id} combatBonus is asset-only`);
        assert.ok(val && typeof val === 'object', `${card.id} combatBonus object`);
        assert.ok(TAG_VALUES.includes(val.vsTag), `${card.id} combatBonus.vsTag`);
        assert.ok(Number.isInteger(val.damage) && val.damage > 0, `${card.id} combatBonus.damage`);
        continue;
      }
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

test('collectible counts match the contract (26 vulcan, 30 obsidian, 25 nexus/helix + 44 neutral = 150)', () => {
  const byFaction = {};
  for (const c of collectible) byFaction[c.faction] = (byFaction[c.faction] || 0) + 1;
  assert.equal(byFaction.nexus, 25);
  assert.equal(byFaction.vulcan, 26); // + vx_c04 Retooling Order (counter aura)
  assert.equal(byFaction.helix, 25);
  assert.equal(byFaction.obsidian, 30); // + ob_023 Counter Offer; + ob_024 Hedge Fund; + ob_025 Franchise; + ob_026 Executive Suite; + ob_027 Mega Yacht
  assert.equal(byFaction.neutral, 44); // + ntr_035..ntr_040, ntr_c03 Regulatory Capture, ntr_c04 War Chest
  assert.equal(collectible.length, 150);
  // CONTRACT cards: 3 per faction, plus vx_c04 (a 4th Vulcan, the counter card), plus
  // the neutral pair ntr_c03 Regulatory Capture and ntr_c04 War Chest
  const contracts = collectible.filter((c) => c.type === 'CONTRACT');
  assert.equal(contracts.length, 15);
  for (const f of ['nexus', 'helix', 'obsidian']) {
    assert.equal(contracts.filter((c) => c.faction === f).length, 3, f + ' contracts');
  }
  assert.equal(contracts.filter((c) => c.faction === 'vulcan').length, 4, 'vulcan contracts (+Retooling Order)');
  assert.equal(contracts.filter((c) => c.faction === 'neutral').length, 2, 'neutral contracts (Regulatory Capture, War Chest)');
});

test('tribal tags: every ASSET has ≥1 valid tag; non-assets untagged; spot checks', () => {
  for (const c of Object.values(CARDS)) {
    assert.ok(Array.isArray(c.tags), c.id + ' has a tags array');
    for (const t of c.tags) assert.ok(TAG_VALUES.includes(t), `${c.id}: unknown tag "${t}"`);
    if (c.type === 'ASSET') assert.ok(c.tags.length >= 1, c.id + ' (ASSET) must have a tribe');
    else assert.equal(c.tags.length, 0, c.id + ' (' + c.type + ') should be untagged');
  }
  // spot-check one of each tribe + the intentional dual-tag
  assert.deepEqual(CARDS.vx_011.tags, ['robotic'], 'Blitz Mech');
  assert.deepEqual(CARDS.nx_002.tags, ['software'], 'Web Crawler');
  assert.deepEqual(CARDS.vx_013.tags, ['facility'], 'War Factory');
  assert.deepEqual(CARDS.hx_022.tags, ['organism'], 'Gigafauna');
  assert.deepEqual(CARDS.ob_t_shell.tags, ['financial'], 'Shell Corp');
  assert.deepEqual(CARDS.ntr_001.tags, ['personnel'], 'Unpaid Intern (default)');
  assert.deepEqual(CARDS.ob_021.tags, ['robotic', 'financial'], 'Bullion Golem dual-tag');
  // the Vulcan robotic tribe is exactly these six
  const robotic = Object.values(CARDS).filter((c) => c.faction === 'vulcan' && c.tags.includes('robotic')).map((c) => c.id).sort();
  assert.deepEqual(robotic, ['vx_002', 'vx_011', 'vx_016', 'vx_017', 'vx_022', 'vx_t_scrapbot']);
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

test('§3b contract set matches the spec table exactly', () => {
  const table = [
    // id, name, cost, term
    ['nx_c01', 'Terms of Service', 3, undefined],
    ['nx_c02', 'Data Harvesting Agreement', 4, 3],
    ['nx_c03', 'Push Notification Consent', 2, undefined],
    ['vx_c01', 'Munitions Contract', 4, undefined],
    ['vx_c02', 'Overtime Mandate', 3, undefined],
    ['vx_c03', 'Escalation Clause', 5, undefined],
    ['hx_c01', 'Corporate Wellness Program', 3, undefined],
    ['hx_c02', 'Regeneration Rider', 4, undefined],
    ['hx_c03', 'Life Insurance Policy', 2, undefined],
    ['ob_c01', 'Payday Lending Agreement', 2, undefined],
    ['ob_c02', 'Bridge Loan', 4, 2],
    ['ob_c03', 'Liquidation Rights', 3, undefined],
  ];
  for (const [id, name, cost, term] of table) {
    const c = CARDS[id];
    assert.ok(c, id + ' exists');
    assert.equal(c.name, name, id + ' name');
    assert.equal(c.cost, cost, id + ' cost');
    assert.equal(c.type, 'CONTRACT', id + ' type');
    assert.equal(c.term, term, id + ' term');
    assert.equal(c.collectible, true, id + ' collectible');
    assert.ok(c.flavor.length > 0, id + ' flavor');
  }
  // rarity spread: commons/rares; vx_c03 & ob_c02 epic
  assert.equal(CARDS.vx_c03.rarity, 'epic');
  assert.equal(CARDS.ob_c02.rarity, 'epic');
  for (const [id] of table) {
    if (id !== 'vx_c03' && id !== 'ob_c02') {
      assert.ok(['common', 'rare'].includes(CARDS[id].rarity), id + ' common/rare');
    }
  }
  // neutral answers: attorney is an ASSET, void clause an OPERATION
  const atty = CARDS.ntr_c01;
  assert.equal(atty.type, 'ASSET');
  assert.equal(atty.cost, 3);
  assert.equal(atty.attack, 2);
  assert.equal(atty.health, 3);
  assert.equal(atty.effects.targeting, 'enemyContract');
  assert.deepEqual(atty.effects.onboarding, [{ op: 'nullify', to: 'target' }]);
  const voidClause = CARDS.ntr_c02;
  assert.equal(voidClause.type, 'OPERATION');
  assert.equal(voidClause.cost, 1);
  assert.equal(voidClause.effects.targeting, 'enemyContract');
  assert.deepEqual(voidClause.effects.play, [{ op: 'nullify', to: 'target' }]);
});

test('starter decks each swapped in ONE faction contract + ONE Void Clause (still 40)', () => {
  for (const [key, deck] of Object.entries(STARTER_DECKS)) {
    assert.equal(deck.cards.length, 40, key + ' is 40 cards');
    assert.equal(deck.cards.filter((id) => id === 'ntr_c02').length, 1,
      key + ' has exactly one Void Clause');
    const contracts = deck.cards.filter((id) => CARDS[id].type === 'CONTRACT');
    // vulcan carries a second faction contract, vx_c04 Retooling Order (§3e counters)
    const expected = key === 'vulcan' ? 2 : 1;
    assert.equal(contracts.length, expected, `${key} has ${expected} on-faction CONTRACT card(s)`);
    for (const cid of contracts) assert.equal(CARDS[cid].faction, key, key + ' contract is on-faction');
  }
});
