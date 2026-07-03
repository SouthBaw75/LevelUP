// components/card.js — the single shared card renderer.
// Used by: hand, deck builder grid, deck list, board units (compact variant),
// enlarged hover previews, and event animations. All sizing is driven by the
// --cw CSS custom property so one component scales everywhere.

import { getCard, KEYWORD_NAMES, KEYWORD_HELP } from '../state.js';
import { mountArt, factionColor } from '../art.js';

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

function keywordBadges(keywords) {
  if (!keywords || !keywords.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'kw-badges';
  for (const k of keywords) {
    const b = document.createElement('span');
    b.className = 'kw-badge kw-' + k;
    b.textContent = KEYWORD_NAMES[k] || k.toUpperCase();
    b.title = KEYWORD_HELP[k] || '';
    wrap.appendChild(b);
  }
  return wrap;
}

/**
 * Render a full TCG card.
 * @param {object|string} defOrId card def or card id
 * @param {object} opts
 *   width      — px width (default 150)
 *   cost       — override cost (view hand cards may discount)
 *   attack     — override attack (board state)
 *   health     — override health
 *   damaged    — health chip red
 *   count      — deck-list style xN pip
 *   showFlavor — always show flavor text (used in the zoom preview)
 *   interactive— hover raises card (default true)
 */
export function renderCard(defOrId, opts = {}) {
  const def = typeof defOrId === 'string' ? getCard(defOrId) : defOrId;
  const el = document.createElement('div');
  if (!def) {
    el.className = 'card card-missing';
    el.textContent = '?';
    return el;
  }
  const width = opts.width || 150;
  el.className = `card faction-${def.faction} rarity-${def.rarity || 'common'} type-${(def.type || 'ASSET').toLowerCase()}`;
  el.style.setProperty('--cw', width + 'px');
  el.style.setProperty('--fc', factionColor(def.faction));
  el.dataset.cardId = def.id;
  if (opts.interactive === false) el.classList.add('no-hover');

  // cost chip (capital)
  const cost = opts.cost !== undefined ? opts.cost : def.cost;
  if (def.type !== 'CEO') {
    const chip = document.createElement('div');
    chip.className = 'cost-chip';
    chip.textContent = cost;
    if (opts.cost !== undefined && def.cost !== undefined && opts.cost < def.cost) chip.classList.add('discounted');
    el.appendChild(chip);
  }

  // art frame (drop-in real art or procedural placeholder)
  const art = document.createElement('div');
  art.className = 'card-art';
  mountArt(art, def.id, def.faction, def.type);
  el.appendChild(art);

  // rarity gem
  const gem = document.createElement('div');
  gem.className = 'rarity-gem';
  gem.title = RARITY_LABEL[def.rarity] || 'Common';
  el.appendChild(gem);

  // name plate
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = def.name;
  if (def.name && def.name.length > 18) name.classList.add('long');
  el.appendChild(name);

  // type line
  const typeLine = document.createElement('div');
  typeLine.className = 'card-typeline';
  typeLine.textContent = def.type === 'ASSET' ? 'ASSET' : def.type === 'OPERATION' ? 'OPERATION'
    : def.type === 'CEO' ? 'CHIEF EXECUTIVE' : 'CEO POWER';
  el.appendChild(typeLine);

  // body: keywords + rules text (+ flavor when zoomed)
  const body = document.createElement('div');
  body.className = 'card-body';
  const kb = keywordBadges(def.keywords);
  if (kb) body.appendChild(kb);
  if (def.text) {
    const txt = document.createElement('div');
    txt.className = 'card-text';
    txt.textContent = def.text;
    if (def.text.length > 90) txt.classList.add('long');
    body.appendChild(txt);
  }
  if (opts.showFlavor && def.flavor) {
    const fl = document.createElement('div');
    fl.className = 'card-flavor';
    fl.textContent = def.flavor;
    body.appendChild(fl);
  }
  el.appendChild(body);

  // stat chips
  if (def.type === 'ASSET' || (def.type === 'CEO' && def.health)) {
    if (def.type === 'ASSET') {
      const atk = document.createElement('div');
      atk.className = 'stat-chip atk-chip';
      atk.textContent = opts.attack !== undefined ? opts.attack : def.attack;
      if (opts.attack !== undefined && opts.attack > def.attack) atk.classList.add('buffed');
      el.appendChild(atk);
    }
    const hp = document.createElement('div');
    hp.className = 'stat-chip hp-chip';
    hp.textContent = opts.health !== undefined ? opts.health : def.health;
    if (opts.damaged) hp.classList.add('damaged');
    else if (opts.health !== undefined && opts.health > def.health) hp.classList.add('buffed');
    el.appendChild(hp);
  }

  if (opts.count !== undefined) {
    const c = document.createElement('div');
    c.className = 'card-count';
    c.textContent = '×' + opts.count;
    el.appendChild(c);
  }

  return el;
}

/**
 * Compact board unit (in-play ASSET). Shares the art frame + stat chip
 * treatment with the full card; hover shows the full card via the preview layer.
 * @param {object} unit view board entry {id, cardId, attack, health, maxHealth, keywords, canAttack, exhausted, damaged}
 */
export function renderUnit(unit, opts = {}) {
  const def = getCard(unit.cardId) || {};
  const el = document.createElement('div');
  el.className = `unit faction-${def.faction || 'neutral'} rarity-${def.rarity || 'common'}`;
  el.dataset.unitId = unit.id;
  el.dataset.cardId = unit.cardId;
  el.style.setProperty('--fc', factionColor(def.faction));

  const frame = document.createElement('div');
  frame.className = 'unit-frame';
  const art = document.createElement('div');
  art.className = 'unit-art';
  mountArt(art, unit.cardId, def.faction || 'neutral', def.type || 'ASSET');
  frame.appendChild(art);
  el.appendChild(frame);

  const name = document.createElement('div');
  name.className = 'unit-name';
  name.textContent = def.name || unit.cardId;
  el.appendChild(name);

  // keyword icons row
  const kws = unit.keywords || [];
  if (kws.length) {
    const row = document.createElement('div');
    row.className = 'unit-kws';
    for (const k of kws) {
      const ic = document.createElement('span');
      ic.className = 'unit-kw ukw-' + k;
      ic.title = (KEYWORD_NAMES[k] || k) + ' — ' + (KEYWORD_HELP[k] || '');
      ic.textContent = UNIT_KW_GLYPH[k] || '•';
      row.appendChild(ic);
    }
    el.appendChild(row);
  }
  if (kws.includes('firewall')) el.classList.add('has-firewall');
  if (kws.includes('stealth')) el.classList.add('has-stealth');
  if (kws.includes('shielded')) el.classList.add('has-shield');

  const atk = document.createElement('div');
  atk.className = 'stat-chip atk-chip';
  atk.textContent = unit.attack;
  if (def.attack !== undefined && unit.attack > def.attack) atk.classList.add('buffed');
  el.appendChild(atk);

  const hp = document.createElement('div');
  hp.className = 'stat-chip hp-chip';
  hp.textContent = unit.health;
  if (unit.damaged || (unit.maxHealth !== undefined && unit.health < unit.maxHealth)) hp.classList.add('damaged');
  else if (def.health !== undefined && unit.health > def.health) hp.classList.add('buffed');
  el.appendChild(hp);

  if (unit.canAttack && !opts.enemy) el.classList.add('ready');
  if (unit.exhausted) el.classList.add('exhausted');
  return el;
}

const UNIT_KW_GLYPH = {
  firewall: '\u{1F6E1}', // shield
  fasttrack: '⚡',
  stealth: '◑',
  shielded: '⬡',
  overtime: '✖',
  toxic: '☠',
  siphon: '♥',
};

// ---- enlarged hover preview layer ----
let previewLayer = null;
let previewFor = null;

function ensureLayer() {
  if (!previewLayer) {
    previewLayer = document.createElement('div');
    previewLayer.id = 'card-preview-layer';
    document.body.appendChild(previewLayer);
  }
  return previewLayer;
}

export function showPreview(defOrId, anchorEl, overrides = {}) {
  const layer = ensureLayer();
  const key = typeof defOrId === 'string' ? defOrId : defOrId && defOrId.id;
  if (previewFor === anchorEl && layer.childElementCount) return;
  previewFor = anchorEl;
  layer.innerHTML = '';
  const card = renderCard(defOrId, { width: 250, showFlavor: true, interactive: false, ...overrides });
  card.classList.add('preview-card');
  layer.appendChild(card);
  layer.style.display = 'block';
  // position beside the anchor, clamped to viewport
  const r = anchorEl.getBoundingClientRect();
  const cw = 250, ch = cw * 1.45;
  let x = r.right + 14;
  if (x + cw > innerWidth - 8) x = r.left - cw - 14;
  if (x < 8) x = Math.min(Math.max(8, r.left + r.width / 2 - cw / 2), innerWidth - cw - 8);
  let y = r.top + r.height / 2 - ch / 2;
  y = Math.max(8, Math.min(y, innerHeight - ch - 8));
  layer.style.left = x + 'px';
  layer.style.top = y + 'px';
  void key;
}

export function hidePreview() {
  previewFor = null;
  if (previewLayer) { previewLayer.style.display = 'none'; previewLayer.innerHTML = ''; }
}

/** Convenience: wire hover preview onto an element rendered for a card/unit. */
export function attachPreview(el, defOrId, overrides = {}) {
  el.addEventListener('mouseenter', () => showPreview(defOrId, el, overrides));
  el.addEventListener('mouseleave', hidePreview);
}

/** A face-down card back (opponent hand). */
export function renderCardBack(width = 60) {
  const el = document.createElement('div');
  el.className = 'card-back';
  el.style.setProperty('--cw', width + 'px');
  el.innerHTML = `<svg viewBox="0 0 60 84" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="1.5" y="1.5" width="57" height="81" rx="6" fill="#0d1420" stroke="#2a3b52" stroke-width="1.5"/>
    <rect x="6" y="6" width="48" height="72" rx="4" fill="none" stroke="#22d3ee" stroke-opacity="0.25"/>
    <path d="M30 22 L44 42 L30 62 L16 42 Z" fill="none" stroke="#22d3ee" stroke-opacity="0.7" stroke-width="1.6"/>
    <path d="M23 42 h14 M30 32 v20" stroke="#22d3ee" stroke-opacity="0.5" stroke-width="1.2"/>
    <circle cx="30" cy="42" r="3" fill="#22d3ee" fill-opacity="0.8"/>
  </svg>`;
  return el;
}
