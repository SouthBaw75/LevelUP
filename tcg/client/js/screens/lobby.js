// screens/lobby.js — main menu: faction/deck select, ranked queue, private
// match (create/join), VS bot, deck builder entry.

import {
  FACTIONS, factionMeta, starterDecks, loadCustomDecks, deckValidity,
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
  if (howToPlayOpen()) return false; // howtoplay.js owns its own Escape handling
  if (ev.key === 'Escape' && modal) { cancelModalAction(); return true; }
  if (ev.key === 'Enter' && modalMode === 'privateJoin' && typing) { submitJoinCode(); return true; }
  return false;
}

// ---------- deck helpers ----------
function allDeckChoices() {
  const out = [];
  const starters = starterDecks();
  for (const f of ['nexus', 'vulcan', 'helix', 'obsidian']) {
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
function render() {
  const sel = selectedChoice();
  const selFaction = sel ? sel.faction : 'nexus';
  // tint the ambient horizon glow toward the selected conglomerate
  if (ambient) ambient.style.setProperty('--amb', factionMeta(selFaction).color);

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
      <div class="lobby-right">
        <div class="section-head"><span class="tag">Deck</span></div>
        <div class="deck-select" id="deck-select" style="max-height:200px"></div>
        <button class="btn ghost small" id="btn-builder">⛭ &nbsp;DECK BUILDER</button>
        <div class="section-head" style="margin-top:6px"><span class="tag">Engage</span></div>
        <div class="play-buttons">
          <button class="btn" id="btn-queue">▸ RANKED QUEUE <span class="sub">casual matchmaking</span></button>
          <button class="btn" id="btn-create">▸ PRIVATE MATCH <span class="sub">host — share a code</span></button>
          <button class="btn" id="btn-join">▸ JOIN PRIVATE <span class="sub">enter a code</span></button>
          <div class="bot-row">
            <button class="btn" id="btn-bot-normal">VS BOT · NORMAL</button>
            <button class="btn" id="btn-bot-hard">VS BOT · HARD</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // faction cards
  const grid = root.querySelector('#faction-grid');
  for (const f of ['nexus', 'vulcan', 'helix', 'obsidian']) {
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

  // deck rows
  const list = root.querySelector('#deck-select');
  const choices = allDeckChoices();
  if (!choices.length) {
    list.innerHTML = '<div class="tag" style="padding:12px">card database loading…</div>';
  }
  for (const c of choices) {
    const m = factionMeta(c.faction);
    const v = deckValidity(c.faction, c.cards);
    const row = document.createElement('button');
    row.className = 'deck-row' + (sel && c.selId === sel.selId ? ' selected' : '');
    row.style.setProperty('--fc', m.color);
    row.innerHTML = `
      <span class="dr-swatch"></span>
      <span><span class="dr-name">${escapeHtml(c.name)}</span><br>
      <span class="dr-sub">${escapeHtml(m.name)} · ${c.starter ? 'STARTER' : 'CUSTOM'}</span></span>
      <span class="dr-flag ${v.ok ? '' : 'invalid'}">${v.ok ? '30/30' : v.error.toUpperCase()}</span>
    `;
    row.addEventListener('click', () => { setSelectedDeckId(c.selId); render(); });
    list.appendChild(row);
  }

  // buttons
  root.querySelector('#btn-howto').addEventListener('click', () => openHowToPlay());
  root.querySelector('#btn-builder').addEventListener('click', () => showScreen('builder'));
  root.querySelector('#btn-queue').addEventListener('click', () => {
    const deck = requireValidDeck();
    if (!deck) return;
    if (!ensureConnected()) return;
    net.send({ t: 'queue', deck });
    openModal('searching');
  });
  root.querySelector('#btn-create').addEventListener('click', () => {
    const deck = requireValidDeck();
    if (!deck) return;
    if (!ensureConnected()) return;
    net.send({ t: 'createPrivate', deck });
    openModal('privateHost');
  });
  root.querySelector('#btn-join').addEventListener('click', () => {
    const deck = requireValidDeck();
    if (!deck) return;
    if (!ensureConnected()) return;
    openModal('privateJoin');
  });
  root.querySelector('#btn-bot-normal').addEventListener('click', () => startBot('normal'));
  root.querySelector('#btn-bot-hard').addEventListener('click', () => startBot('hard'));
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
  } else if (mode === 'privateJoin') {
    box.innerHTML = `
      <h3>JOIN PRIVATE MATCH</h3>
      <div class="modal-sub">Enter the 4-character boardroom code.</div>
      <input class="input code-input" id="join-code" maxlength="4" autocomplete="off" spellcheck="false" placeholder="····">
      <div style="display:flex;gap:10px">
        <button class="btn ghost" id="modal-cancel">BACK</button>
        <button class="btn primary" id="modal-join">JOIN</button>
      </div>
    `;
    box.querySelector('#modal-cancel').addEventListener('click', cancelModalAction);
    box.querySelector('#modal-join').addEventListener('click', submitJoinCode);
    setTimeout(() => box.querySelector('#join-code')?.focus(), 60);
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
  const input = modal?.querySelector('#join-code');
  const code = (input?.value || '').trim().toUpperCase();
  if (code.length !== 4) { toast('Code must be 4 characters.', 'warn'); input?.focus(); return; }
  const deck = requireValidDeck();
  if (!deck) return;
  net.send({ t: 'joinPrivate', code, deck });
  // stay in modal until gameStart or error
  const box = modal.querySelector('.modal');
  if (box) box.querySelector('#modal-join').disabled = true;
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
  // re-enable join button so the user can retry a bad code
  const joinBtn = modal?.querySelector('#modal-join');
  if (joinBtn) joinBtn.disabled = false;
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
