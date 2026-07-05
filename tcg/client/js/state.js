// state.js — app-wide state, card database access, localStorage persistence.
// The client NEVER computes game state; this module only holds lobby/app data
// and the card definitions fetched from the authoritative server.

// ---- Faction metadata (fallbacks per DESIGN_CONTRACT.md §2; server meta merges over) ----
export const FACTIONS = {
  nexus: {
    id: 'nexus', name: 'Nexus Dynamics', industry: 'AI & Software',
    color: '#22d3ee', tagline: 'Intelligence is a commodity. We set the price.',
    identity: 'Tempo & control — card draw, bounce, efficient operations.',
  },
  vulcan: {
    id: 'vulcan', name: 'Vulcan Heavy Industries', industry: 'Manufacturing & Defense',
    color: '#f97316', tagline: 'We build the future. Then we sell it weapons.',
    identity: 'Aggression — direct damage, FAST-TRACK, colossal late-game assets.',
  },
  helix: {
    id: 'helix', name: 'Helix Biosystems', industry: 'Biotech',
    color: '#4ade80', tagline: 'Growth is not a goal. It is an inevitability.',
    identity: 'Growth — healing, buffs, clone tokens, SIPHON.',
  },
  obsidian: {
    id: 'obsidian', name: 'Obsidian Capital', industry: 'Finance & Private Equity',
    color: '#c084fc', tagline: 'Everything is for sale. Especially you.',
    identity: 'Greed — capital ramp, sacrifice, GOLDEN PARACHUTE value.',
  },
  neutral: {
    id: 'neutral', name: 'Independent Contractors', industry: 'Freelance',
    color: '#94a3b8', tagline: 'Loyalty, invoiced hourly.',
    identity: 'Mercenaries usable by any conglomerate.',
  },
};

export const KEYWORD_NAMES = {
  firewall: 'FIREWALL',
  fasttrack: 'FAST-TRACK',
  stealth: 'STEALTH MODE',
  shielded: 'PATENT PROTECTION',
  overtime: 'OVERTIME',
  toxic: 'TOXIC ASSET',
  siphon: 'SIPHON',
  layoff: 'LAYOFF',
  severance: 'SEVERANCE',
  onboarding: 'ONBOARDING',
  parachute: 'GOLDEN PARACHUTE',
};

export const KEYWORD_HELP = {
  firewall: 'Enemies must attack this asset first.',
  fasttrack: 'Can attack the turn it is deployed.',
  stealth: 'Cannot be targeted or attacked until it deals damage.',
  shielded: 'Ignores the first damage it would take.',
  overtime: 'Can attack twice per turn.',
  toxic: 'Destroys any asset it damages.',
  siphon: 'Damage dealt also restores your CEO’s integrity.',
  layoff: 'Sacrifice during your turn (free): your CEO gains Integrity equal to its Durability.',
  severance: 'When destroyed by an enemy, draw a card.',
  onboarding: 'Effect when played from hand.',
  parachute: 'Effect when destroyed.',
};

export const EMOTES = {
  greetings: { icon: '\u{1F91D}', text: 'Pleasure doing business.' },
  wellplayed: { icon: '\u{1F4C8}', text: 'Strong quarter.' },
  threaten: { icon: '\u{1F4C9}', text: 'Your position is under review.' },
  oops: { icon: '\u{1F4C4}', text: 'That was... unbudgeted.' },
  thanks: { icon: '\u{1F4B0}', text: 'Noted and appreciated.' },
};

// ---- Card database (from GET /api/cards) ----
let db = null;

export async function loadCards() {
  if (db) return db;
  const res = await fetch('/api/cards');
  if (!res.ok) throw new Error('cards fetch failed: ' + res.status);
  db = await res.json();
  return db;
}

export function getDb() { return db; }
export function getCard(id) { return db && db.cards ? db.cards[id] : null; }
export function starterDecks() { return db ? db.starterDecks || {} : {}; }

export function factionMeta(id) {
  const base = FACTIONS[id] || FACTIONS.neutral;
  const remote = (db && db.factions && db.factions[id]) || {};
  return { ...base, ...remote, color: base.color };
}

export function collectibleCards() {
  if (!db || !db.cards) return [];
  return Object.values(db.cards).filter((c) => c.collectible !== false && (c.type === 'ASSET' || c.type === 'OPERATION' || c.type === 'CONTRACT'));
}

// ---- Identity persistence ----
const LS = {
  pid: 'ht_pid',
  name: 'ht_name',
  decks: 'ht_decks',
  selectedDeck: 'ht_selected_deck',
  seenTutorial: 'ht_seen_tutorial',
};

export function hasSeenTutorial() { return localStorage.getItem(LS.seenTutorial) === '1'; }
export function setSeenTutorial() { localStorage.setItem(LS.seenTutorial, '1'); }

export function getPid() {
  let pid = localStorage.getItem(LS.pid);
  if (!pid) {
    pid = (crypto.randomUUID ? crypto.randomUUID()
      : 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    localStorage.setItem(LS.pid, pid);
  }
  return pid;
}

export function getName() { return localStorage.getItem(LS.name) || ''; }
export function setName(n) { localStorage.setItem(LS.name, n); session.name = n; }

// ---- Custom decks ----
export function loadCustomDecks() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.decks) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveCustomDecks(decks) {
  localStorage.setItem(LS.decks, JSON.stringify(decks));
}

export function upsertCustomDeck(deck) {
  const decks = loadCustomDecks();
  const i = decks.findIndex((d) => d.id === deck.id);
  if (i >= 0) decks[i] = deck; else decks.push(deck);
  saveCustomDecks(decks);
}

export function deleteCustomDeck(id) {
  saveCustomDecks(loadCustomDecks().filter((d) => d.id !== id));
}

export function getSelectedDeckId() { return localStorage.getItem(LS.selectedDeck) || 'starter:nexus'; }
export function setSelectedDeckId(id) { localStorage.setItem(LS.selectedDeck, id); }

// Resolve a deck-selector id ("starter:<faction>" or "custom:<uuid>") to {name, faction, cards}
export function resolveDeck(selId) {
  if (!selId) return null;
  if (selId.startsWith('starter:')) {
    const f = selId.slice(8);
    const d = starterDecks()[f];
    return d ? { name: d.name || factionMeta(f).name + ' Starter', faction: d.faction || f, cards: d.cards } : null;
  }
  if (selId.startsWith('custom:')) {
    const d = loadCustomDecks().find((x) => 'custom:' + x.id === selId);
    return d ? { name: d.name, faction: d.faction, cards: d.cards } : null;
  }
  return null;
}

export function deckValidity(faction, cards) {
  if (!Array.isArray(cards)) return { ok: false, error: 'No cards' };
  if (cards.length !== 30) return { ok: false, error: `${cards.length}/30 cards` };
  const counts = {};
  for (const id of cards) {
    const def = getCard(id);
    if (!def) return { ok: false, error: 'Unknown card ' + id };
    if (def.faction !== faction && def.faction !== 'neutral') return { ok: false, error: 'Off-faction card: ' + def.name };
    if (!def.collectible && def.collectible !== undefined) return { ok: false, error: 'Non-collectible card: ' + def.name };
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > 2) return { ok: false, error: 'More than 2× ' + def.name };
  }
  return { ok: true };
}

// ---- Session (volatile) ----
export const session = {
  name: getName(),
  online: null,        // last known online count
  connected: false,
  inGame: false,
};
