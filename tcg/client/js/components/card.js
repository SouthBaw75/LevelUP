// components/card.js — the single shared card renderer.
// Used by: hand, deck builder grid, deck list, board units (compact variant),
// enlarged hover previews, and event animations. All sizing is driven by the
// --cw CSS custom property so one component scales everywhere.

import { getCard, KEYWORD_NAMES, KEYWORD_HELP } from '../state.js';
import { mountArt, mountFactionIcon, factionColor } from '../art.js';

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

// Concise keyword glosses for the card FACE (the full sentences live in
// state.js KEYWORD_HELP and the How to Play glossary). Kept short so even a
// two-keyword card reads cleanly at hand size without clipping.
const KEYWORD_FACE_GLOSS = {
  firewall: 'Must be attacked first.',
  fasttrack: 'Can attack immediately.',
  stealth: 'Hidden until it attacks.',
  shielded: 'Ignores the first hit.',
  overtime: 'Attacks twice per turn.',
  toxic: 'Destroys what it damages.',
  siphon: 'Its damage heals your CEO.',
  layoff: 'Sacrifice: CEO gains its Integrity.',
  severance: 'Destroyed by foe: draw a card.',
  bullish: 'Overkill carries to the enemy CEO.',
  raid: 'Surviving an attack steals 1 enemy Capital.',
};

// Keyword display name: uniform across every card and faction — no per-card
// overrides. The same mechanic must always read as the same name so a player's
// knowledge of a keyword transfers between factions instead of resetting.
function kwName(k) {
  return KEYWORD_NAMES[k] || k.toUpperCase();
}

// Remove bare "<KEYWORD>." sentences from rules text (e.g. "FIREWALL. SIPHON.")
// so the face can replace them with real glosses instead of echoing the badge.
// Ability text like "Onboarding: deal 1 damage." is left untouched.
function stripKeywordSentences(text, keywords) {
  let t = text;
  for (const k of keywords) {
    const nm = KEYWORD_NAMES[k];
    if (!nm) continue;
    t = t.replace(new RegExp(escapeRegExp(nm) + '\\.\\s*', 'g'), '');
  }
  return t.trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Bold + faction-tint any ability/keyword LABEL that appears inline in rules
// text (e.g. "GOLDEN PARACHUTE", "ONBOARDING") so it matches the standalone
// keyword names. Keywords in the card's `keywords` array are already stripped
// into the gloss block, so what remains here are the triggered abilities and
// keyword references (e.g. "gains OVERTIME"). Longest labels first so a label
// that contains a shorter one can't be double-wrapped.
const ABILITY_LABELS = Object.values(KEYWORD_NAMES).sort((a, b) => b.length - a.length);
function highlightAbilities(text) {
  let html = escapeHtml(text);
  for (const label of ABILITY_LABELS) {
    html = html.replace(new RegExp(escapeRegExp(label), 'g'),
      `<span class="ability-label">${label}</span>`);
  }
  return html;
}

function faceGloss(k) {
  return KEYWORD_FACE_GLOSS[k] || KEYWORD_HELP[k] || '';
}

// Card ids currently "attached" to a board unit — rendered tucked underneath it
// (on the board and in the hover preview) so you can see WHAT is affecting it.
// v1: `distract` has exactly one source (Flirty Intern, ntr_037), so a
// distracted unit is carrying that intern. Generalizes cleanly if more
// attach-style cards are added later (return their ids here).
export function attachmentsFor(unit) {
  return unit && unit.distracted > 0 ? ['ntr_037'] : [];
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

  // faction symbol badge (drop-in assets/faction-icons/<faction>.png|webp,
  // else a placeholder monogram) — identifies which conglomerate the card
  // belongs to at a glance, independent of the accent-color border. Appended
  // to the card root (not the art frame) since mountArt replaces the art
  // frame's entire innerHTML when a real card image loads asynchronously.
  const badge = document.createElement('div');
  badge.className = 'faction-badge';
  badge.title = def.faction ? def.faction[0].toUpperCase() + def.faction.slice(1) : '';
  mountFactionIcon(badge, def.faction || 'neutral');
  el.appendChild(badge);

  // rarity gem
  const gem = document.createElement('div');
  gem.className = 'rarity-gem';
  gem.title = RARITY_LABEL[def.rarity] || 'Common';
  el.appendChild(gem);

  // name plate — wraps to two lines and shrinks by length so long names like
  // "Government Subsidy" read in full instead of being cut off with an ellipsis.
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = def.name;
  const nameLen = def.name ? def.name.length : 0;
  if (nameLen > 22) name.classList.add('xlong');
  else if (nameLen > 13) name.classList.add('long');
  el.appendChild(name);

  // type line — for assets, extended MTG-style with the card's ASSET CLASS
  // (its tribe tag) as a subtler trailing span, e.g. "ASSET · ROBOTIC".
  const typeLine = document.createElement('div');
  typeLine.className = 'card-typeline';
  const baseType = def.type === 'ASSET' ? 'ASSET' : def.type === 'OPERATION' ? 'OPERATION'
    : def.type === 'CONTRACT' ? 'CONTRACT'
    : def.type === 'CEO' ? 'CHIEF EXECUTIVE' : 'CEO POWER';
  typeLine.appendChild(document.createTextNode(baseType));
  if (def.type === 'ASSET' && Array.isArray(def.tags) && def.tags.length) {
    typeLine.classList.add('has-class');
    const cls = document.createElement('span');
    cls.className = 'card-assetclass';
    cls.textContent = ' · ' + def.tags.map((t) => t.toUpperCase()).join(' · ');
    const pretty = def.tags.map((t) => t[0].toUpperCase() + t.slice(1)).join(', ');
    cls.title = 'Asset class: ' + pretty;
    typeLine.appendChild(cls);
  }
  el.appendChild(typeLine);

  // body: rules text (+ flavor when zoomed)
  const body = document.createElement('div');
  body.className = 'card-body';

  // Rules text reads as one flowing block: each standalone keyword appears as
  // a bold inline name followed by a short plain-English gloss, then the card's
  // own ability text. So "FIREWALL. SIPHON." renders as
  //   FIREWALL Must be attacked first. SIPHON Its damage heals your CEO.
  // instead of a bare, unexplained keyword. Redundant bare keyword sentences
  // are stripped from the ability text first so nothing is said twice.
  const glossKws = def.keywords || [];
  const bodyText = stripKeywordSentences(def.text || '', glossKws);
  const glossLen = glossKws.reduce((n, k) => n + faceGloss(k).length + kwName(k).length + 2, 0);

  // Text + flavor share one vertical budget below the name plate — shrink
  // together once they'd otherwise overflow the body and get clipped.
  const combinedLen = bodyText.length + glossLen
    + (opts.showFlavor && def.flavor ? def.flavor.length : 0);
  if (combinedLen > 90) body.classList.add('tight');

  if (glossKws.length) {
    const gl = document.createElement('div');
    gl.className = 'kw-gloss';
    if (combinedLen > 70) gl.classList.add('long');
    if (combinedLen > 115) gl.classList.add('xlong');
    for (const k of glossKws) {
      const row = document.createElement('div');
      row.className = 'kwg-row';
      const nm = document.createElement('div');
      nm.className = 'kwg-name';
      nm.textContent = kwName(k);
      const dc = document.createElement('div');
      dc.className = 'kwg-desc';
      dc.textContent = faceGloss(k);
      row.append(nm, dc);
      gl.appendChild(row);
    }
    body.appendChild(gl);
  }
  if (bodyText) {
    const txt = document.createElement('div');
    txt.className = 'card-text';
    txt.innerHTML = highlightAbilities(bodyText); // inline ability labels → bold faction color
    if (combinedLen > 70) txt.classList.add('long');
    if (combinedLen > 115) txt.classList.add('xlong');
    body.appendChild(txt);
  }
  if (opts.showFlavor && def.flavor) {
    const fl = document.createElement('div');
    fl.className = 'card-flavor';
    fl.textContent = def.flavor;
    if (combinedLen > 70) fl.classList.add('long');
    if (combinedLen > 115) fl.classList.add('xlong');
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

  // Status-tag stack (bottom-center, the gap the stat chips leave free):
  // anything true of this LIVE unit that the card's printed def can't show.
  // Each source has no other home on this face — the kw-gloss block above
  // only reads def.keywords (the static definition), and none of these are
  // "attack/health" numbers the stat chips already cover. Stacked (not just
  // one-or-the-other) because a unit can carry more than one at once — e.g.
  // a granted keyword AND a Flirty Intern distraction simultaneously.
  if (def.type === 'ASSET') {
    const tags = [];
    if (opts.silenced) {
      // Silence wipes keywords to [], so it always wins over "granted" below —
      // there's nothing left to report a grant on top of.
      tags.push({ cls: 'silenced-badge', text: 'SILENCED', title: 'Silenced — stripped of all keywords and triggers.' });
    } else if (Array.isArray(opts.keywords)) {
      const granted = opts.keywords.filter((k) => !(def.keywords || []).includes(k));
      if (granted.length) {
        tags.push({
          cls: '', text: granted.map((k) => kwName(k)).join(' · '),
          title: granted.map((k) => kwName(k) + ' — ' + (KEYWORD_HELP[k] || faceGloss(k))).join('\n'),
        });
      }
    }
    // FLIRTY INTERN: can't attack for N more turns — shown as a rose pip on
    // the compact board card, but the enlarged preview had no equivalent.
    if (opts.distracted > 0) {
      const n = opts.distracted;
      tags.push({
        cls: 'distracted-badge', text: `DISTRACTED ${n}`,
        title: `Distracted — can't attack for ${n} more turn${n === 1 ? '' : 's'}.`,
      });
    }
    // Asset-class aura (contract, e.g. Retooling Order): the atk chip above
    // already shows the boosted number via .buffed, but not WHY — same gap
    // the compact board card's gold aura pip already fills.
    if (opts.counters && opts.counters.count) {
      const atkBonus = opts.counters.atk || 0;
      const lines = (opts.counters.sources || []).map((sc) => {
        const nm = getCard(sc.cardId)?.name || sc.cardId;
        return `${nm}: ${sc.atk > 0 ? '+' : ''}${sc.atk} Attack`;
      });
      tags.push({
        cls: 'counter-tag-badge', text: `${atkBonus > 0 ? '+' : ''}${atkBonus} ATK (${lines.length})`,
        title: 'Asset-class bonus — ' + lines.join(' · '),
      });
    }
    if (tags.length) {
      const stack = document.createElement('div');
      stack.className = 'status-tag-stack';
      for (const t of tags) {
        const b = document.createElement('div');
        b.className = 'granted-kw-badge status-tag' + (t.cls ? ' ' + t.cls : '');
        b.textContent = t.text;
        b.title = t.title;
        stack.appendChild(b);
      }
      el.appendChild(stack);
    }
  }

  // CONTRACT: fixed-term badge (bottom-center, where an asset's stat chips
  // would sit — contracts have no stats, so the slot is free)
  if (def.type === 'CONTRACT' && def.term != null) {
    const t = document.createElement('div');
    t.className = 'term-badge';
    t.textContent = 'TERM: ' + def.term;
    t.title = `Expires after ${def.term} of your turns`;
    el.appendChild(t);
  }

  if (opts.count !== undefined) {
    const c = document.createElement('div');
    c.className = 'card-count';
    c.textContent = '×' + opts.count;
    el.appendChild(c);
  }

  return el;
}

// ---------- filed contract tile (contract zone) ----------

// Small legal-document glyph used on filed-contract tiles (inherits currentColor).
const CONTRACT_GLYPH_SVG = `<svg viewBox="0 0 14 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M1.5 1.5 h7 l4 4 v11 h-11 z" fill="rgba(240,232,205,0.10)" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
  <path d="M8.5 1.5 v4 h4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
  <path d="M3.6 8.2 h6.8 M3.6 10.7 h6.8 M3.6 13.2 h4.4" stroke="currentColor" stroke-width="0.9" stroke-opacity="0.8"/>
</svg>`;

// Safe/vault glyph for reserve contracts (War Chest) — same hand-drawn,
// stroke-on-currentColor, faint-fill treatment as the folder above so the two
// read as a matched set, but the shape is a strongbox: body + inset door, a
// combination dial with ticks, a side handle, and little feet.
const RESERVE_GLYPH_SVG = `<svg viewBox="0 0 14 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="1.4" y="2.6" width="11.2" height="12" rx="1.2" fill="rgba(240,232,205,0.10)" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
  <rect x="3" y="4.1" width="8" height="9" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.9" stroke-opacity="0.85"/>
  <circle cx="7" cy="8.6" r="2" fill="none" stroke="currentColor" stroke-width="1"/>
  <circle cx="7" cy="8.6" r="0.5" fill="currentColor"/>
  <path d="M7 5.9 v-0.9 M7 11.3 v0.9 M4.3 8.6 h-0.9 M9.7 8.6 h0.9" stroke="currentColor" stroke-width="0.8" stroke-opacity="0.75" stroke-linecap="round"/>
  <path d="M2.9 14.6 v1.4 M11.1 14.6 v1.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;

// Tiny coin for the banked-amount badge (inherits currentColor).
const COIN_GLYPH_SVG = `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.1"/>
  <path d="M5 2.7 v4.6 M3.4 4 h2.2 a1.1 1.1 0 0 1 0 2.2 h-2.2" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/**
 * Compact document-styled tile for a FILED contract in a player's contract
 * zone. Not a board unit: cannot attack / be attacked; only null-&-void
 * effects target it (data-target-id carries the "c<N>" instance id).
 * @param {object} contract view entry {id, cardId, turnsLeft}
 * @param {object|null} def  card def (looked up from the db when omitted)
 */
export function renderContractTile(contract, def = null) {
  def = def || getCard(contract.cardId) || {};
  const el = document.createElement('div');
  el.className = `contract-tile faction-${def.faction || 'neutral'}`
    + (def.reserve ? ' is-reserve' : '');
  el.dataset.targetId = contract.id;
  el.dataset.cardId = contract.cardId;
  el.style.setProperty('--fc', factionColor(def.faction));

  // reserve contracts (War Chest) draw a safe/vault; everyone else the folder.
  // `def.reserve` is a public marker surfaced by the server for BOTH players,
  // so the opponent still sees a safe — they just don't see its balance.
  const isReserve = !!def.reserve;
  const glyph = document.createElement('div');
  glyph.className = 'ct-glyph' + (isReserve ? ' ct-glyph-safe' : '');
  glyph.innerHTML = isReserve ? RESERVE_GLYPH_SVG : CONTRACT_GLYPH_SVG;
  el.appendChild(glyph);

  const name = document.createElement('div');
  name.className = 'ct-name';
  name.textContent = def.name || contract.cardId;
  name.title = def.name || '';
  el.appendChild(name);

  // remaining-term pip ("3" counting down) for fixed-term contracts only
  if (contract.turnsLeft != null) {
    const pip = document.createElement('div');
    pip.className = 'ct-term';
    pip.textContent = contract.turnsLeft;
    pip.title = `Term: ${contract.turnsLeft} of the owner's turns remaining`;
    el.appendChild(pip);
  }

  // War Chest reserve (§reserve): banked-capital vault badge — styled like the
  // gold term pip. Only ever present on the OWNER's own view: the server
  // redacts `banked` from the opponent's copy, so `banked` is absent (not 0)
  // there and this badge simply never renders on enemy tiles.
  if (typeof contract.banked === 'number') {
    el.classList.add('has-reserve');
    const bank = document.createElement('div');
    bank.className = 'ct-bank';
    // a small drawn coin (matching the vault's stroke style) + the amount, so
    // the badge reads as "money in the safe" without an emoji clashing with
    // the hand-drawn glyphs elsewhere on the tile.
    bank.innerHTML = `<span class="ct-bank-glyph">${COIN_GLYPH_SVG}</span>${contract.banked}`;
    bank.title = `War Chest: ${contract.banked} Capital banked (max 8)`
      + (contract.banked > 0 ? ' — click on your turn to crack it open for Assets' : '');
    el.appendChild(bank);
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
  const fullName = def.name || unit.cardId;
  // Fit the label between the stat chips: shrink long names (.long), and
  // pre-ellipsize measured overflow — CSS text-overflow can't ellipsize
  // centered nowrap text (it hard-clips the start of the string).
  const fit = fitUnitName(fullName);
  if (fit.long) name.classList.add('long');
  name.textContent = fit.text;
  name.title = fullName;
  el.appendChild(name);

  // keyword icons row — a silenced unit has no keywords to show (Gag Order
  // wipes them), so that slot would just sit empty; repurpose it to flag the
  // silence itself, since otherwise a silenced unit looks identical to one
  // that was simply never printed with any keyword.
  const kws = unit.keywords || [];
  if (kws.length) {
    const row = document.createElement('div');
    row.className = 'unit-kws';
    for (const k of kws) {
      const ic = document.createElement('span');
      ic.className = 'unit-kw ukw-' + k;
      ic.title = kwName(k) + ' — ' + (KEYWORD_HELP[k] || '');
      ic.textContent = UNIT_KW_GLYPH[k] || '•';
      row.appendChild(ic);
    }
    el.appendChild(row);
  } else if (unit.silenced) {
    const row = document.createElement('div');
    row.className = 'unit-kws';
    const ic = document.createElement('span');
    ic.className = 'unit-kw ukw-silenced';
    ic.title = 'SILENCED — stripped of all keywords and triggers.';
    ic.textContent = '\u{1F507}'; // muted-speaker glyph
    row.appendChild(ic);
    el.appendChild(row);
  }
  if (kws.includes('firewall')) el.classList.add('has-firewall');
  if (kws.includes('stealth')) el.classList.add('has-stealth');
  if (kws.includes('shielded')) el.classList.add('has-shield');
  if (unit.silenced) el.classList.add('silenced');

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

  // §counters: asset-class aura bonus badge (top-left corner). Non-intrusive —
  // the atk chip already shows the boosted number with .buffed styling; this
  // pip surfaces HOW MANY bonuses are active and, via its tooltip, from what.
  if (unit.counters && unit.counters.count) {
    const cb = document.createElement('div');
    cb.className = 'unit-counter';
    const atk = unit.counters.atk || 0;
    cb.textContent = (atk > 0 ? '+' : '') + atk;
    const lines = (unit.counters.sources || []).map((sc) => {
      const nm = getCard(sc.cardId)?.name || sc.cardId;
      return `${nm}: ${sc.atk > 0 ? '+' : ''}${sc.atk} Attack`;
    });
    cb.title = 'Asset-class bonus — ' + lines.join(' · ');
    el.appendChild(cb);
  }

  // Attached cards (Flirty Intern) tuck in BEHIND the unit, a corner peeking out
  // its lower-left so you can see something is stuck to it. Prepended so it sits
  // behind the frame/name/chips in DOM order (no stacking context on .unit).
  const attachments = attachmentsFor(unit);
  if (attachments.length) {
    el.classList.add('has-attachment');
    for (const attId of attachments) {
      const tuck = renderCard(attId, { width: 52, interactive: false });
      tuck.classList.add('unit-attachment');
      el.insertBefore(tuck, el.firstChild);
    }
  }

  // Flirty Intern: a distracted asset can't attack — show a rose countdown pip
  // (top-right) with the turns remaining, and tint the unit as charmed.
  if (unit.distracted > 0) {
    el.classList.add('distracted');
    const db = document.createElement('div');
    db.className = 'unit-distracted';
    db.textContent = unit.distracted;
    db.title = `Distracted — can't attack for ${unit.distracted} more turn${unit.distracted === 1 ? '' : 's'}`;
    el.appendChild(db);
  }

  if (unit.canAttack && !opts.enemy) el.classList.add('ready');
  if (unit.exhausted) el.classList.add('exhausted');
  return el;
}

// Available label width on a board unit: 92px wide minus 20px padding per
// side (clear of the overhanging stat chips), minus a letter-spacing buffer.
const UNIT_NAME_MAX_PX = 50;
let measureCtx = null;

function fitUnitName(text) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const sans = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  measureCtx.font = '600 8.5px ' + sans;
  if (measureCtx.measureText(text).width <= UNIT_NAME_MAX_PX) return { text, long: false };
  measureCtx.font = '600 7.5px ' + sans;
  if (measureCtx.measureText(text).width <= UNIT_NAME_MAX_PX) return { text, long: true };
  let t = text;
  while (t.length > 1 && measureCtx.measureText(t + '…').width > UNIT_NAME_MAX_PX) {
    t = t.slice(0, -1).trimEnd();
  }
  return { text: t + '…', long: true };
}

const UNIT_KW_GLYPH = {
  firewall: '\u{1F6E1}', // shield
  fasttrack: '⚡',
  stealth: '◑',
  shielded: '⬡',
  overtime: '✖',
  toxic: '☠',
  siphon: '♥',
  layoff: '\u{1FA93}', // axe
  severance: '\u{1F4B0}', // money bag (payout)
  bullish: '\u{1F402}', // ox/bull — trample (and bull-market pun)
  raid: '\u{1FA99}', // coin — capital steal
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
  // Attached cards (Flirty Intern on a distracted unit): show them tucked under
  // the base card so the hover explains WHY the unit is affected. Keyed off the
  // same `distracted` the board unit passes into its preview overrides.
  const attachments = attachmentsFor(overrides);
  attachments.forEach((attId, i) => {
    const att = renderCard(attId, { width: 178, showFlavor: false, interactive: false });
    att.classList.add('preview-attachment');
    att.style.setProperty('--att-i', i);
    layer.insertBefore(att, card); // behind the base card in DOM/stacking
  });
  layer.classList.toggle('has-attachment', attachments.length > 0);
  layer.style.display = 'block';
  // position beside the anchor, clamped to viewport. Reminder text can grow
  // the card past the nominal height, so measure the real rendered height.
  const r = anchorEl.getBoundingClientRect();
  const cw = 250, ch = card.offsetHeight || cw * 1.45;
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
