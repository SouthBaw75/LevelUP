// validateDeck coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck, STARTER_DECKS } from '../shared/engine.js';

const good = () => ({ faction: 'nexus', cards: STARTER_DECKS.nexus.cards.slice() });

test('accepts a legal 30-card deck', () => {
  assert.deepEqual(validateDeck(good()), { ok: true });
});

test('rejects malformed input', () => {
  assert.equal(validateDeck(null).ok, false);
  assert.equal(validateDeck('nexus').ok, false);
  assert.equal(validateDeck({}).ok, false);
  assert.equal(validateDeck({ faction: 'nexus' }).ok, false);
  assert.equal(validateDeck({ faction: 'nexus', cards: 'nx_001' }).ok, false);
});

test('rejects invalid faction (including neutral as a deck faction)', () => {
  assert.equal(validateDeck({ faction: 'neutral', cards: good().cards }).ok, false);
  assert.equal(validateDeck({ faction: 'enron', cards: good().cards }).ok, false);
});

test('rejects wrong deck size', () => {
  const d29 = good(); d29.cards.pop();
  assert.equal(validateDeck(d29).ok, false);
  const d31 = good(); d31.cards.push('ntr_001');
  assert.equal(validateDeck(d31).ok, false);
});

test('rejects more than 2 copies', () => {
  const d = good();
  d.cards[0] = d.cards[1] = d.cards[2] = 'nx_001';
  // rebuild to exactly 30 with a triple
  const cards = ['nx_001', 'nx_001', 'nx_001', ...STARTER_DECKS.nexus.cards.slice(0, 27)
    .filter((id) => id !== 'nx_001')];
  while (cards.length < 30) cards.push('ntr_002');
  assert.equal(validateDeck({ faction: 'nexus', cards: cards.slice(0, 30) }).ok, false);
});

test('rejects unknown card ids', () => {
  const d = good(); d.cards[0] = 'zz_999';
  const r = validateDeck(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown/);
});

test('rejects non-collectible cards (tokens, subsidy, CEO, POWER)', () => {
  for (const bad of ['ntr_subsidy', 'ob_t_shell', 'nx_ceo', 'nx_power']) {
    const d = good(); d.cards[0] = bad;
    assert.equal(validateDeck(d).ok, false, bad + ' must be rejected');
  }
});

test('rejects off-faction cards, accepts neutrals', () => {
  const d = good(); d.cards[0] = 'vx_001'; // vulcan card in nexus deck
  assert.equal(validateDeck(d).ok, false);
  const d2 = good(); d2.cards[0] = 'ntr_001'; // neutral ok (only one copy present)
  assert.equal(validateDeck(d2).ok, true);
});
