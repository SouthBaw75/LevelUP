// screens/lobby.js — main menu: faction/deck select, ranked queue, private
// match (create/join), VS bot, deck builder entry.

import {
  FACTIONS, FACTION_IDS, factionMeta, starterDecks, loadCustomDecks, deckValidity,
  getSelectedDeckId, setSelectedDeckId, resolveDeck, session, getName,
} from '../state.js';
import * as net from '../net.js';
import * as audio from '../audio.js';
import { showScreen, toast } from '../main.js';
import { mountCeoPortrait } from '../art.js';
import { openHowToPlay, maybeAutoShow, isOpen as howToPlayOpen, close as closeHowToPlay } from '../howtoplay.js';

let root = null;
let modal = null;           // current modal veil element
let modalMode = null;       // 'searching' | 'privateHost' | 'privateJoin'
let firstEntry = true;
let ambient = null;         // persistent animated backdrop (survives re-renders)

// Ambient backdrop: drifting data motes (2 parallax layers), a city skyline
// with twinkling windows + blinking antenna beacons, a faction-tinted aurora
// glow on the horizon, and a periodic light sweep. All transform/opacity
// animations. Lives OUTSIDE the re-rendered content wrapper so faction-click
// re-renders never restart the animations.
const SKYLINE_SVG = `
<svg viewBox="0 0 1200 180" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="#0b111c">
    <rect x="0" y="90" width="70" height="90"/><rect x="60" y="60" width="46" height="120"/>
    <rect x="120" y="105" width="80" height="75"/><rect x="210" y="40" width="54" height="140"/>
    <rect x="278" y="88" width="66" height="92"/><rect x="352" y="66" width="40" height="114"/>
    <rect x="400" y="112" width="90" height="68"/><rect x="498" y="30" width="60" height="150"/>
    <rect x="566" y="84" width="48" height="96"/><rect x="622" y="58" width="72" height="122"/>
    <rect x="700" y="100" width="56" height="80"/><rect x="764" y="24" width="50" height="156"/>
    <rect x="822" y="78" width="76" height="102"/><rect x="906" y="50" width="44" height="130"/>
    <rect x="958" y="96" width="88" height="84"/><rect x="1054" y="64" width="58" height="116"/>
    <rect x="1120" y="92" width="80" height="88"/>
  </g>
  <g stroke="#0e1624" stroke-width="3">
    <line x1="789" y1="24" x2="789" y2="6"/><line x1="528" y1="30" x2="528" y2="12"/>
  </g>
  <circle class="beacon" cx="789" cy="6" r="3"/>
  <circle class="beacon" cx="528" cy="12" r="3" style="animation-delay:1.3s"/>
  <g>
    <rect class="win" x="222" y="58" width="6" height="8" rx="1"/>
    <rect class="win" x="244" y="74" width="6" height="8" rx="1" style="animation-delay:1.2s"/>
    <rect class="win" x="510" y="50" width="6" height="8" rx="1" style="animation-delay:.6s"/>
    <rect class="win" x="534" y="72" width="6" height="8" rx="1" style="animation-delay:2.1s"/>
    <rect class="win" x="522" y="96" width="6" height="8" rx="1" style="animation-delay:3.1s"/>
    <rect class="win" x="776" y="44" width="6" height="8" rx="1" style="animation-delay:1.7s"/>
    <rect class="win" x="796" y="66" width="6" height="8" rx="1" style="animation-delay:.3s"/>
    <rect class="win" x="778" y="92" width="6" height="8" rx="1" style="animation-delay:2.6s"/>
    <rect class="win" x="640" y="76" width="6" height="8" rx="1" style="animation-delay:1.0s"/>
    <rect class="win" x="668" y="98" width="6" height="8" rx="1" style="animation-delay:2.9s"/>
    <rect class="win" x="1070" y="84" width="6" height="8" rx="1" style="animation-delay:.9s"/>
    <rect class="win" x="1090" y="110" width="6" height="8" rx="1" style="animation-delay:2.2s"/>
    <rect class="win" x="72" y="78" width="6" height="8" rx="1" style="animation-delay:1.5s"/>
    <rect class="win" x="918" y="66" width="6" height="8" rx="1" style="animation-delay:3.4s"/>
  </g>
</svg>`;

export function mount(el) {
  el.innerHTML = `
    <div class="lobby-ambient" aria-hidden="true">
      <div class="amb-motes m1"></div>
      <div class="amb-motes m2"></div>
      <div class="amb-aurora"></div>
      <div class="amb-skyline">${SKYLINE_SVG}</div>
      <div class="amb-sweep"></div>
    </div>
    <div class="lobby-content"></div>
  `;
  ambient = el.querySelector('.lobby-ambient');
  root = el.querySelector('.lobby-content');
  // clicking anywhere outside the deck row collapses the CHANGE flyout
  document.addEventListener('click', (ev) => {
    const flyout = root?.querySelector('#deck-flyout.open');
    if (flyout && !ev.target.closest('#deck-current')) flyout.classList.remove('open');
  });
}

export function enter() {
  session.inGame = false;
  render();
  if (firstEntry) {
    firstEntry = false;
    maybeAutoShow();
  }
}

export function exit() {
  closeModal(false);
  closeHowToPlay();
}

export function onOnline(n) {
  const el = root.querySelector('#lobby-online');
  if (el && typeof n === 'number') el.innerHTML = `<span class="online-dot">●</span> ${n} ONLINE`;
}

export function onKey(ev, typing) {
  void typing;
  if (howToPlayOpen()) return false; // howtoplay.js owns its own Escape handling
  if (ev.key === 'Escape' && modal) { cancelModalAction(); return true; }
  const flyout = root?.querySelector('#deck-flyout.open');
  if (ev.key === 'Escape' && flyout) { flyout.classList.remove('open'); return true; }
  return false;
}

// ---------- deck helpers ----------
function allDeckChoices() {
  const out = [];
  const starters = starterDecks();
  for (const f of FACTION_IDS) {
    if (starters[f]) {
      out.push({
        selId: 'starter:' + f, name: starters[f].name || factionMeta(f).name + ' Starter',
        faction: f, cards: starters[f].cards, starter: true,
      });
    }
  }
  for (const d of loadCustomDecks()) {
    out.push({ selId: 'custom:' + d.id, name: d.name, faction: d.faction, cards: d.cards, starter: false });
  }
  return out;
}

function selectedChoice() {
  const choices = allDeckChoices();
  return choices.find((c) => c.selId === getSelectedDeckId()) || choices[0] || null;
}

function requireValidDeck() {
  const c = selectedChoice();
  if (!c) { toast('No deck selected.', 'warn'); return null; }
  const v = deckValidity(c.faction, c.cards);
  if (!v.ok) { toast('Deck invalid: ' + v.error, 'error'); return null; }
  return { faction: c.faction, cards: c.cards };
}

// ---------- render ----------
// Engage panel state — module-level so faction-click re-renders keep your
// place (active tab, chosen mode per tab, bot difficulty).
const engage = { tab: 'play', sel: { play: 'queue', private: 'host', watch: 'watch' }, diff: 'normal' };

// One mode = one radio card. The single launch CTA's label always states
// exactly what pressing it will do.
const ENGAGE_MODES = {
  play: [
    { id: 'queue', title: 'Ranked Queue', sub: 'Find an opponent online', cta: () => 'ENTER QUEUE' },
    { id: 'bot', title: 'VS Bot', sub: 'Practice against the AI', seg: true, cta: () => 'START VS BOT · ' + engage.diff.toUpperCase() },
  ],
  private: [
    { id: 'host', title: 'Host Match', sub: 'Get a 4-character code to share with a friend', cta: () => 'HOST PRIVATE MATCH' },
    { id: 'join', title: 'Join Match', sub: 'Enter a code from a friend', code: true, cta: () => 'JOIN MATCH' },
  ],
  watch: [
    { id: 'watch', title: 'AI vs AI', sub: 'Auto-run bot matches for playtesting — alternates who goes first, records a downloadable play log', watch: true, cta: () => 'START SIMULATION' },
  ],
};

function render() {
  const sel = selectedChoice();
  const selFaction = sel ? sel.faction : 'nexus';
  const fcColor = factionMeta(selFaction).color;
  // tint the ambient horizon glow toward the selected conglomerate
  if (ambient) ambient.style.setProperty('--amb', fcColor);

  root.innerHTML = `
    <div class="lobby-top">
      <div class="lobby-title">HOSTILE <small>TAKEOVER</small></div>
      <div class="lobby-user">
        <span id="lobby-online">${typeof session.online === 'number' ? `<span class="online-dot">●</span> ${session.online} ONLINE` : ''}</span>
        <span>EXEC: <b style="color:var(--ink)">${escapeHtml(getName())}</b></span>
        <button class="btn ghost small" id="btn-howto">❔ HOW TO PLAY</button>
      </div>
    </div>
    <div class="lobby-main">
      <div class="lobby-left">
        <div class="section-head"><span class="tag">Select your conglomerate</span></div>
        <div class="faction-grid" id="faction-grid"></div>
      </div>
      <div class="lobby-right" style="--fc:${fcColor}">
        <div class="section-head"><span class="tag">Deck</span></div>
        <div class="deck-current" id="deck-current"></div>
        <div class="section-head" style="margin-top:6px"><span class="tag">Engage</span></div>
        <div class="mode-tabs" role="tablist">
          <button class="mode-tab" data-tab="play" role="tab">Play</button>
          <button class="mode-tab" data-tab="private" role="tab">Private</button>
          <button class="mode-tab" data-tab="watch" role="tab">Watch</button>
        </div>
        <div class="mode-list" id="mode-list" role="radiogroup"></div>
        <button class="btn cta" id="btn-go"></button>
      </div>
    </div>
  `;

  // faction cards
  const grid = root.querySelector('#faction-grid');
  for (const f of FACTION_IDS) {
    const m = factionMeta(f);
    const card = document.createElement('button');
    card.className = 'faction-card' + (f === selFaction ? ' selected' : '');
    card.style.setProperty('--fc', m.color);
    card.innerHTML = `
      <div class="fc-portrait"></div>
      <span class="fc-check">ACTIVE</span>
      <span class="fc-industry">${escapeHtml(m.industry)}</span>
      <span class="fc-name">${escapeHtml(m.name)}</span>
      <span class="fc-tagline">“${escapeHtml(m.tagline)}”</span>
    `;
    mountCeoPortrait(card.querySelector('.fc-portrait'), f);
    card.addEventListener('click', () => {
      audio.playFactionSelect(f);
      // selecting a faction selects its starter deck (unless a custom deck of that faction is already selected)
      const cur = selectedChoice();
      if (!cur || cur.faction !== f) setSelectedDeckId('starter:' + f);
      render();
    });
    grid.appendChild(card);
  }

  renderDeckCurrent();
  renderEngage();

  root.querySelector('#btn-howto').addEventListener('click', () => openHowToPlay());
  root.querySelector('.mode-tabs').addEventListener('click', (ev) => {
    const t = ev.target.closest('.mode-tab');
    if (!t || t.dataset.tab === engage.tab) return;
    engage.tab = t.dataset.tab;
    renderEngage();
  });
  root.querySelector('#btn-go').addEventListener('click', goEngage);
}

/** Compact current-deck row: swatch + name + validity, with a CHANGE flyout
 *  listing every deck (starters + custom) and a deck-builder shortcut. */
function renderDeckCurrent() {
  const wrap = root.querySelector('#deck-current');
  const sel = selectedChoice();
  if (!sel) {
    wrap.innerHTML = '<div class="tag" style="padding:12px">card database loading…</div>';
    return;
  }
  const m = factionMeta(sel.faction);
  const v = deckValidity(sel.faction, sel.cards);
  wrap.style.setProperty('--fc', m.color);
  wrap.innerHTML = `
    <span class="dr-swatch"></span>
    <span class="dc-meta"><span class="dr-name">${escapeHtml(sel.name)}</span><br>
    <span class="dr-sub">${escapeHtml(m.name)} · ${sel.starter ? 'STARTER' : 'CUSTOM'}</span></span>
    <span class="dr-flag ${v.ok ? 'ok' : 'invalid'}">${v.ok ? '40/40' : v.error.toUpperCase()}</span>
    <button class="btn ghost small" id="btn-deck-change" aria-haspopup="listbox" aria-expanded="false">CHANGE ▾</button>
    <button class="btn ghost small" id="btn-builder" title="Open the deck builder">⛭</button>
    <div class="deck-flyout" id="deck-flyout" role="listbox"></div>
  `;
  const flyout = wrap.querySelector('#deck-flyout');
  for (const c of allDeckChoices()) {
    const cm = factionMeta(c.faction);
    const cv = deckValidity(c.faction, c.cards);
    const opt = document.createElement('button');
    opt.className = 'deck-opt' + (c.selId === sel.selId ? ' selected' : '');
    opt.style.setProperty('--fc', cm.color);
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', c.selId === sel.selId);
    opt.innerHTML = `
      <span class="dr-swatch"></span>
      <span class="do-meta"><span class="dr-name">${escapeHtml(c.name)}</span><br>
      <span class="dr-sub">${escapeHtml(cm.name)} · ${c.starter ? 'STARTER' : 'CUSTOM'}</span></span>
      <span class="dr-flag ${cv.ok ? '' : 'invalid'}">${cv.ok ? '40/40' : cv.error.toUpperCase()}</span>
    `;
    opt.addEventListener('click', () => { setSelectedDeckId(c.selId); render(); });
    flyout.appendChild(opt);
  }
  wrap.querySelector('#btn-deck-change').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = flyout.classList.toggle('open');
    wrap.querySelector('#btn-deck-change').setAttribute('aria-expanded', open);
  });
  wrap.querySelector('#btn-builder').addEventListener('click', () => showScreen('builder'));
}

/** Tab strip + radio mode cards + the single launch CTA. */
function renderEngage() {
  for (const t of root.querySelectorAll('.mode-tab')) {
    t.classList.toggle('active', t.dataset.tab === engage.tab);
  }
  const list = root.querySelector('#mode-list');
  const keepCode = list.querySelector('#join-code')?.value || '';
  list.innerHTML = '';
  const selId = engage.sel[engage.tab];
  for (const m of ENGAGE_MODES[engage.tab]) {
    const card = document.createElement('div');
    card.className = 'mode-card' + (m.id === selId ? ' selected' : '');
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', m.id === selId);
    card.tabIndex = 0;
    let html = `<span class="m-radio"></span><span class="m-meta"><span class="m-title">${m.title}</span><div class="m-sub">${m.sub}</div>`;
    if (m.code) {
      html += `<div class="m-code"><input class="input code-input" id="join-code" maxlength="4"
        autocomplete="off" spellcheck="false" placeholder="····" aria-label="boardroom code"></div>`;
    }
    if (m.watch) html += `<div class="m-watch" id="m-watch"></div>`;
    html += `</span>`;
    if (m.seg) {
      html += `<span class="m-seg">
        <button data-d="normal" class="${engage.diff === 'normal' ? 'on' : ''}">NORMAL</button>
        <button data-d="hard" class="${engage.diff === 'hard' ? 'on' : ''}">HARD</button></span>`;
    }
    card.innerHTML = html;
    card.addEventListener('click', (ev) => {
      const seg = ev.target.closest('.m-seg button');
      if (seg) {
        engage.diff = seg.dataset.d;
        renderEngage();
        return;
      }
      // clicks on inner controls of the already-selected card mustn't rebuild
      // (it would blur the code input / reset watch chips mid-interaction)
      if (m.id === engage.sel[engage.tab]) return;
      engage.sel[engage.tab] = m.id;
      renderEngage();
      root.querySelector('#join-code')?.focus();
    });
    card.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === card) {
        ev.preventDefault();
        engage.sel[engage.tab] = m.id;
        renderEngage();
      }
    });
    list.appendChild(card);
  }
  const inp = root.querySelector('#join-code');
  if (inp) {
    inp.value = keepCode;
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); goEngage(); }
    });
  }
  const mw = root.querySelector('#m-watch');
  if (mw) buildWatchInline(mw);

  const cur = ENGAGE_MODES[engage.tab].find((m) => m.id === engage.sel[engage.tab]) || ENGAGE_MODES[engage.tab][0];
  const go = root.querySelector('#btn-go');
  go.disabled = false;
  go.textContent = cur.cta();
}

/** Inline AI-vs-AI config (sides + match count) inside the Watch tab —
 *  replaces the old pre-launch modal. */
function buildWatchInline(mw) {
  mw.innerHTML = `
    <div class="ws-sides">
      <div class="ws-side"><div class="ws-label">SIDE A</div><div class="ws-factions" id="ws-a"></div></div>
      <div class="ws-vs">vs</div>
      <div class="ws-side"><div class="ws-label">SIDE B</div><div class="ws-factions" id="ws-b"></div></div>
    </div>
    <div class="ws-matches">
      <label for="ws-count">MATCHES</label>
      <input class="input" id="ws-count" type="number" min="1" max="50" value="${watchPick.matches}" inputmode="numeric">
      <span class="ws-hint">1–50</span>
    </div>
  `;
  for (const key of ['a', 'b']) {
    const wrapEl = mw.querySelector('#ws-' + key);
    for (const f of WATCH_FACTIONS) {
      const m = factionMeta(f);
      const chip = document.createElement('button');
      chip.className = 'ws-chip' + (watchPick[key] === f ? ' selected' : '');
      chip.style.setProperty('--fc', m.color);
      chip.textContent = m.name;
      chip.addEventListener('click', () => {
        watchPick[key] = f;
        for (const c of wrapEl.querySelectorAll('.ws-chip')) c.classList.remove('selected');
        chip.classList.add('selected');
      });
      wrapEl.appendChild(chip);
    }
  }
  mw.querySelector('#ws-count').addEventListener('change', (ev) => {
    watchPick.matches = Math.max(1, Math.min(50, parseInt(ev.target.value, 10) || 5));
  });
}

/** The single launch button: dispatch on (tab, selected mode). */
function goEngage() {
  const mode = engage.sel[engage.tab];
  if (engage.tab === 'play' && mode === 'queue') {
    const deck = requireValidDeck();
    if (!deck) return;
    if (!ensureConnected()) return;
    net.send({ t: 'queue', deck });
    openModal('searching');
  } else if (engage.tab === 'play' && mode === 'bot') {
    startBot(engage.diff);
  } else if (engage.tab === 'private' && mode === 'host') {
    const deck = requireValidDeck();
    if (!deck) return;
    if (!ensureConnected()) return;
    net.send({ t: 'createPrivate', deck });
    openModal('privateHost');
  } else if (engage.tab === 'private' && mode === 'join') {
    submitJoinCode();
  } else if (engage.tab === 'watch') {
    const count = Math.max(1, Math.min(50, parseInt(root.querySelector('#ws-count')?.value, 10) || 5));
    watchPick.matches = count;
    if (!ensureConnected()) return;
    net.send({
      t: 'watchBots',
      factionA: watchPick.a,
      factionB: watchPick.b,
      matches: count,
      speed: 0.5, // default 2×; adjustable live in the watch screen
      difficulty: 'hard',
    });
  }
}

function ensureConnected() {
  if (!net.isOpen()) {
    toast('Not connected — reconnecting…', 'warn');
    net.connect();
    return false;
  }
  return true;
}

function startBot(difficulty) {
  const deck = requireValidDeck();
  if (!deck) return;
  if (!ensureConnected()) return;
  net.send({ t: 'playBot', deck, difficulty });
}

// ---------- AI-vs-AI watch config (rendered inline in the Watch tab) ----------
const WATCH_FACTIONS = FACTION_IDS;
const watchPick = { a: 'nexus', b: 'obsidian', matches: 5 };

// ---------- modals ----------
function openModal(mode) {
  closeModal(false);
  modalMode = mode;
  modal = document.createElement('div');
  modal.className = 'modal-veil';
  const box = document.createElement('div');
  box.className = 'modal';
  modal.appendChild(box);

  if (mode === 'searching') {
    box.innerHTML = `
      <div class="searching-spinner"></div>
      <h3>SEARCHING<span class="searching-dots"></span></h3>
      <div class="modal-sub">Scanning the market for a rival executive.</div>
      <button class="btn danger" id="modal-cancel">CANCEL QUEUE</button>
    `;
    box.querySelector('#modal-cancel').addEventListener('click', cancelModalAction);
  } else if (mode === 'privateHost') {
    box.innerHTML = `
      <h3>PRIVATE MATCH</h3>
      <div class="modal-sub">Waiting for host code…</div>
      <div class="code-display" id="code-display"></div>
      <div class="modal-sub">Share this code. First rival to enter it joins your boardroom.</div>
      <button class="btn danger" id="modal-cancel">CANCEL LOBBY</button>
    `;
    box.querySelector('#modal-cancel').addEventListener('click', cancelModalAction);
  }

  modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) cancelModalAction(); });
  document.body.appendChild(modal);
}

function closeModal(send) {
  void send;
  if (modal) { modal.remove(); modal = null; modalMode = null; }
}

function cancelModalAction() {
  if (modalMode === 'searching') net.send({ t: 'cancelQueue' });
  if (modalMode === 'privateHost') net.send({ t: 'cancelPrivate' });
  closeModal(true);
}

function submitJoinCode() {
  const input = root.querySelector('#join-code');
  const code = (input?.value || '').trim().toUpperCase();
  if (code.length !== 4) { toast('Code must be 4 characters.', 'warn'); input?.focus(); return; }
  const deck = requireValidDeck();
  if (!deck) return;
  if (!ensureConnected()) return;
  net.send({ t: 'joinPrivate', code, deck });
  // hold the CTA until gameStart (screen switches) or error (re-enabled below)
  const go = root.querySelector('#btn-go');
  if (go) { go.disabled = true; go.textContent = 'JOINING…'; }
}

// ---------- net events ----------
net.on('queued', () => { /* modal already showing */ });
net.on('queueCanceled', () => { if (modalMode === 'searching') closeModal(false); });
net.on('privateCreated', (msg) => {
  if (modalMode !== 'privateHost') return;
  const disp = modal.querySelector('#code-display');
  const sub = modal.querySelector('.modal-sub');
  if (sub) sub.textContent = 'Boardroom open. Awaiting your rival.';
  if (disp) {
    disp.innerHTML = '';
    for (const ch of String(msg.code).toUpperCase()) {
      const s = document.createElement('span');
      s.textContent = ch;
      disp.appendChild(s);
    }
  }
});
net.on('gameStart', () => closeModal(false));
net.on('error', () => {
  // re-enable the launch button so the user can retry a bad private code
  const go = root?.querySelector('#btn-go');
  if (go && go.disabled) renderEngage();
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
