// screens/builder.js — full deck builder: collection browser with filters,
// mana curve, 40-card list, save/rename/delete, randomize remainder.

import {
  factionMeta, getDb, getCard, loadCustomDecks, upsertCustomDeck,
  deleteCustomDeck, deckValidity, setSelectedDeckId, getSelectedDeckId, starterDecks,
  FACTION_IDS,
} from '../state.js';
import { showScreen, toast } from '../main.js';
import { renderCard, attachPreview } from '../components/card.js';

let root = null;

// working deck
let work = null; // { id, name, faction, cards: [ids] }
let filters = { faction: null, cost: null, type: null, rarity: null, q: '' };

const FACTION_ORDER = FACTION_IDS;

export function mount(el) { root = el; }

export function enter(params) {
  // load selected custom deck if one is selected, else start fresh from selection
  if (!work || params?.reset) work = null;
  if (!work) {
    const selId = getSelectedDeckId();
    if (selId.startsWith('custom:')) {
      const d = loadCustomDecks().find((x) => 'custom:' + x.id === selId);
      if (d) work = { id: d.id, name: d.name, faction: d.faction, cards: [...d.cards] };
    }
    if (!work) work = newDeck('nexus');
  }
  filters = { faction: null, cost: null, type: null, rarity: null, q: '' };
  render();
}

export function exit() {}

export function onKey(ev, typing) {
  if (ev.key === 'Escape' && !typing) { showScreen('lobby'); return true; }
  return false;
}

function newDeck(faction) {
  const starter = starterDecks()[faction];
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : 'd' + Date.now().toString(36)),
    name: 'New ' + factionMeta(faction).name.split(' ')[0] + ' Deck',
    faction,
    cards: starter ? [] : [],
  };
}

// ---------- render ----------
function render() {
  const m = factionMeta(work.faction);
  root.innerHTML = `
    <div class="builder-top">
      <button class="btn ghost small" id="b-back">← LOBBY</button>
      <h2>DECK BUILDER</h2>
      <span class="tag" style="color:${m.color}">${escapeHtml(m.name)} + NEUTRAL</span>
      <div class="spacer"></div>
      <span class="tag">Faction:</span>
      <div class="filter-group" id="b-faction-pick"></div>
      <button class="btn ghost small" id="b-new">＋ NEW DECK</button>
    </div>
    <div class="builder-main">
      <div class="collection">
        <div class="filters" id="b-filters"></div>
        <div class="card-grid" id="b-grid"></div>
      </div>
      <div class="deck-pane panel">
        <div class="deck-name-row">
          <input class="input" id="b-name" maxlength="28" value="${escapeAttr(work.name)}" spellcheck="false">
        </div>
        <div class="deck-meta">
          <span class="deck-count" id="b-count"></span>
          <span class="deck-validity" id="b-valid"></span>
        </div>
        <div class="curve-chart" id="b-curve"></div>
        <div class="deck-list" id="b-list"></div>
        <div class="deck-actions">
          <button class="btn small" id="b-random">RANDOMIZE REST</button>
          <button class="btn small primary" id="b-save">SAVE DECK</button>
          <button class="btn small danger" id="b-delete">DELETE</button>
        </div>
      </div>
    </div>
  `;

  // faction picker (locks pool)
  const fp = root.querySelector('#b-faction-pick');
  for (const f of FACTION_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'filter-pill f-' + f + (work.faction === f ? ' on' : '');
    btn.textContent = f;
    btn.title = factionMeta(f).name;
    btn.addEventListener('click', () => {
      if (work.faction === f) return;
      if (work.cards.length && !confirm('Switching faction clears off-faction cards. Continue?')) return;
      work.faction = f;
      work.cards = work.cards.filter((id) => {
        const d = getCard(id);
        return d && (d.faction === f || d.faction === 'neutral');
      });
      render();
    });
    fp.appendChild(btn);
  }

  renderFilters();
  renderGrid();
  renderDeckPane();

  root.querySelector('#b-back').addEventListener('click', () => showScreen('lobby'));
  root.querySelector('#b-new').addEventListener('click', () => { work = newDeck(work.faction); render(); });
  root.querySelector('#b-name').addEventListener('input', (ev) => { work.name = ev.target.value; });
  root.querySelector('#b-random').addEventListener('click', randomizeRemainder);
  root.querySelector('#b-save').addEventListener('click', saveDeck);
  root.querySelector('#b-delete').addEventListener('click', removeDeck);
}

function renderFilters() {
  const wrap = root.querySelector('#b-filters');
  wrap.innerHTML = '';

  const search = document.createElement('input');
  search.className = 'input';
  search.placeholder = 'Search cards…';
  search.value = filters.q;
  search.addEventListener('input', () => { filters.q = search.value; renderGrid(); });
  wrap.appendChild(search);

  wrap.appendChild(pillGroup(
    [['all', null], [factionMeta(work.faction).name.split(' ')[0], work.faction], ['Neutral', 'neutral']],
    filters.faction, (v) => { filters.faction = v; renderGrid(); },
  ));
  wrap.appendChild(pillGroup(
    [['any cost', null], ['0-1', '01'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6+', '6+']],
    filters.cost, (v) => { filters.cost = v; renderGrid(); },
  ));
  wrap.appendChild(pillGroup(
    [['all types', null], ['Assets', 'ASSET'], ['Operations', 'OPERATION'], ['Contracts', 'CONTRACT']],
    filters.type, (v) => { filters.type = v; renderGrid(); },
  ));
  wrap.appendChild(pillGroup(
    [['all rarities', null], ['C', 'common'], ['R', 'rare'], ['E', 'epic'], ['L', 'legendary']],
    filters.rarity, (v) => { filters.rarity = v; renderGrid(); },
  ));
}

function pillGroup(options, current, onPick) {
  const g = document.createElement('div');
  g.className = 'filter-group';
  for (const [label, val] of options) {
    const b = document.createElement('button');
    b.className = 'filter-pill' + (current === val ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      onPick(val);
      for (const s of g.children) s.classList.remove('on');
      b.classList.add('on');
    });
    g.appendChild(b);
  }
  return g;
}

// Collectible types that belong in a deck (CEO/POWER/tokens stay out).
const DECKABLE_TYPES = new Set(['ASSET', 'OPERATION', 'CONTRACT']);

function poolCards() {
  const db = getDb();
  const all = db && db.cards ? Object.values(db.cards) : [];
  return all
    .filter((c) => c.collectible !== false && DECKABLE_TYPES.has(c.type))
    .filter((c) => c.faction === work.faction || c.faction === 'neutral')
    .sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
}

function filteredCards() {
  const q = filters.q.trim().toLowerCase();
  return poolCards().filter((c) => {
    if (filters.faction && c.faction !== filters.faction) return false;
    if (filters.type && c.type !== filters.type) return false;
    if (filters.rarity && c.rarity !== filters.rarity) return false;
    if (filters.cost) {
      if (filters.cost === '01' && c.cost > 1) return false;
      else if (filters.cost === '6+' && c.cost < 6) return false;
      else if (!['01', '6+'].includes(filters.cost) && c.cost !== Number(filters.cost)) return false;
    }
    if (q) {
      const hay = (c.name + ' ' + (c.text || '') + ' ' + (c.keywords || []).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function countIn(id) { return work.cards.filter((x) => x === id).length; }

function renderGrid() {
  const grid = root.querySelector('#b-grid');
  grid.innerHTML = '';
  const cards = filteredCards();
  if (!cards.length) {
    grid.innerHTML = '<div class="empty-hint">NO MATCHES — ADJUST FILTERS</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const def of cards) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    const n = countIn(def.id);
    if (n >= maxCopies(def)) cell.classList.add('maxed');
    const cardEl = renderCard(def, { width: 148 });
    attachPreview(cardEl, def);
    cardEl.addEventListener('click', () => addCard(def));
    cardEl.addEventListener('contextmenu', (ev) => { ev.preventDefault(); removeCard(def.id); });
    cell.appendChild(cardEl);
    if (n > 0) {
      const pips = document.createElement('div');
      pips.className = 'in-deck-pips';
      for (let i = 0; i < n; i++) pips.appendChild(document.createElement('i'));
      cell.appendChild(pips);
    }
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

function maxCopies(def) { return def.rarity === 'legendary' ? 2 : 2; } // contract: max 2 of any card

function addCard(def) {
  if (work.cards.length >= 40) { toast('Deck is full (40 cards).', 'warn'); return; }
  if (countIn(def.id) >= maxCopies(def)) { toast('Maximum 2 copies of a card.', 'warn'); return; }
  work.cards.push(def.id);
  renderGrid();
  renderDeckPane();
}

function removeCard(id) {
  const i = work.cards.indexOf(id);
  if (i >= 0) {
    work.cards.splice(i, 1);
    renderGrid();
    renderDeckPane();
  }
}

function renderDeckPane() {
  // count + validity
  const countEl = root.querySelector('#b-count');
  countEl.textContent = work.cards.length + ' / 40';
  countEl.classList.toggle('full', work.cards.length === 40);
  const v = deckValidity(work.faction, work.cards);
  const validEl = root.querySelector('#b-valid');
  validEl.textContent = v.ok ? 'TOURNAMENT LEGAL' : v.error.toUpperCase();
  validEl.className = 'deck-validity ' + (v.ok ? 'ok' : 'bad');

  // curve
  const curve = root.querySelector('#b-curve');
  curve.innerHTML = '';
  curve.style.setProperty('--fc', factionMeta(work.faction).color);
  const buckets = new Array(8).fill(0); // 0..6, 7+
  for (const id of work.cards) {
    const d = getCard(id);
    if (!d) continue;
    buckets[Math.min(d.cost, 7)]++;
  }
  const max = Math.max(4, ...buckets);
  buckets.forEach((n, i) => {
    const col = document.createElement('div');
    col.className = 'curve-col';
    col.innerHTML = `<span class="curve-count">${n || ''}</span>`;
    const bar = document.createElement('div');
    bar.className = 'curve-bar';
    bar.style.height = Math.round((n / max) * 44) + 'px';
    col.appendChild(bar);
    const num = document.createElement('span');
    num.className = 'curve-num';
    num.textContent = i === 7 ? '7+' : i;
    col.appendChild(num);
    curve.appendChild(col);
  });

  // list
  const list = root.querySelector('#b-list');
  list.innerHTML = '';
  const grouped = new Map();
  for (const id of work.cards) grouped.set(id, (grouped.get(id) || 0) + 1);
  const rows = [...grouped.entries()]
    .map(([id, n]) => ({ def: getCard(id), n }))
    .filter((r) => r.def)
    .sort((a, b) => (a.def.cost - b.def.cost) || a.def.name.localeCompare(b.def.name));
  for (const { def, n } of rows) {
    const line = document.createElement('button');
    line.className = 'deck-line rarity-' + (def.rarity || 'common');
    line.innerHTML = `<span class="dl-cost">${def.cost}</span><span class="dl-name">${escapeHtml(def.name)}</span><span class="dl-x">×${n}</span>`;
    line.title = 'Click to remove one copy';
    attachPreview(line, def);
    line.addEventListener('click', () => removeCard(def.id));
    list.appendChild(line);
  }
  if (!rows.length) list.innerHTML = '<div class="empty-hint" style="padding:20px 0">CLICK CARDS TO ADD THEM</div>';
}

function randomizeRemainder() {
  const pool = poolCards();
  let guard = 800;
  while (work.cards.length < 40 && guard-- > 0) {
    const def = pool[Math.floor(Math.random() * pool.length)];
    if (countIn(def.id) < maxCopies(def)) work.cards.push(def.id);
  }
  renderGrid();
  renderDeckPane();
  toast('Deck filled with random ' + factionMeta(work.faction).name + ' + neutral cards.');
}

function saveDeck() {
  work.name = (root.querySelector('#b-name').value || 'Unnamed Deck').trim().slice(0, 28) || 'Unnamed Deck';
  const v = deckValidity(work.faction, work.cards);
  upsertCustomDeck({ id: work.id, name: work.name, faction: work.faction, cards: [...work.cards] });
  setSelectedDeckId('custom:' + work.id);
  toast(v.ok ? `Saved “${work.name}” — tournament legal.` : `Saved “${work.name}” (incomplete — ${v.error}).`);
}

function removeDeck() {
  if (!confirm(`Delete deck “${work.name}”?`)) return;
  deleteCustomDeck(work.id);
  if (getSelectedDeckId() === 'custom:' + work.id) setSelectedDeckId('starter:' + work.faction);
  work = newDeck(work.faction);
  render();
  toast('Deck deleted.');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
