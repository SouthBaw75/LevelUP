// Shared white-box test helpers (not a test file — node --test ignores it).
import { createGame, CARDS, STARTER_DECKS } from '../shared/engine.js';

export function newGame(f0 = 'nexus', f1 = 'vulcan', seed = 1) {
  return createGame({
    decks: [STARTER_DECKS[f0], STARTER_DECKS[f1]],
    names: ['Alice', 'Bob'],
    seed,
  });
}

// Put a unit straight onto a player's board (no summoning sickness by default).
export function addUnit(state, player, cardId, overrides = {}) {
  const card = CARDS[cardId];
  const unit = {
    id: 'u' + state.nextUnit++,
    cardId,
    attack: card.attack,
    health: card.health,
    maxHealth: card.health,
    keywords: card.keywords.slice(),
    attacksUsed: 0,
    enteredTurn: 0, // played "long ago": can attack
    silenced: false,
    pendingDestroy: false,
    ...overrides,
  };
  state.players[player].board.push(unit);
  return unit;
}

export function putInHand(state, player, cardId) {
  state.players[player].hand.push(cardId);
  return state.players[player].hand.length - 1; // hand index
}

export function giveCapital(state, player, amount = 10) {
  state.players[player].capital = amount;
  state.players[player].maxCapital = Math.max(state.players[player].maxCapital, amount);
}

export const evTypes = (events) => events.map((e) => e.e);
export const find = (events, type) => events.find((e) => e.e === type);
export const findAll = (events, type) => events.filter((e) => e.e === type);
