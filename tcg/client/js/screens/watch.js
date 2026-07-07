// screens/watch.js — AI-vs-AI spectator ("watch mode").
//
// A read-only god view of two bots playing their starter decks: both hands are
// face-up, neither side is interactive. Built for balance playtesting — runs N
// matches back-to-back, alternates who goes first, keeps a per-faction win
// tally, and lets you download a full play log for analysis. Reuses the pure
// card/unit renderers from components/card.js but none of game.js's targeting /
// animation machinery.

import { getCard, factionMeta, session } from '../state.js';
import * as net from '../net.js';
import { showScreen } from '../main.js';
import { renderUnit, renderCard, renderContractTile, attachPreview, hidePreview } from '../components/card.js';
import { mountCeoPortrait } from '../art.js';

let root = null;
let active = false;
let view = null;            // god view: { turn, activePlayer, over, winner, players:[p0,p1] }
let factions = ['nexus', 'obsidian'];
let matchNo = 1, matchesTotal = 1;
let tally = null;
let speedIdx = 1;           // index into SPEEDS
let logEntries = [];        // narrative event lines
let downloadLog = null;     // populated on watchComplete
let els = {};
const unitNames = new Map(); // unitId -> display name (survives death, for the log)

// speed presets: label -> scale (smaller = faster). Mirrors WatchRoom clamps.
const SPEEDS = [
  { label: '1×', scale: 1 },
  { label: '2×', scale: 0.5 },
  { label: '4×', scale: 0.25 },
  { label: 'MAX', scale: 0.02 },
];

export function mount(el) { root = el; }

export function enter(params) {
  active = true;
  session.inGame = true;
  factions = params?.factions || factions;
  matchNo = params?.match || 1;
  matchesTotal = params?.matches || 1;
  tally = params?.tally || null;
  view = params?.view || null;
  logEntries = [];
  downloadLog = null;
  unitNames.clear();
  speedIdx = params?.speedIdx ?? 1;
  buildSkeleton();
  if (view) renderView();
  logLine(`Simulation opened — ${label(factions[0])} vs ${label(factions[1])}, ${matchesTotal} match${matchesTotal === 1 ? '' : 'es'}.`);
}

export function exit() {
  active = false;
  session.inGame = false;
  hidePreview();
  document.querySelector('.watch-overlay')?.remove();
}

export function onKey(ev) {
  if (ev.key === 'Escape') { stopAndLeave(); return true; }
  return false;
}

function label(f) { return factionMeta(f)?.name || f; }
function color(f) { return factionMeta(f)?.color || '#94a3b8'; }

// ============================================================ skeleton
function buildSkeleton() {
  root.innerHTML = `
    <div class="watch-table">
      <div class="strip watch-strip top" id="w-strip-top">
        ${heroPlateHtml('top')}
        <div class="watch-hand" id="w-hand-top"></div>
      </div>
      <div class="board-zone watch-board">
        <div class="board-floor" aria-hidden="true"></div>
        <div class="contract-zone opp" id="w-contracts-top"></div>
        <div class="contract-zone me" id="w-contracts-bot"></div>
        <div class="board-row opp-row" id="w-row-top"></div>
        <div class="board-divider"></div>
        <div class="board-row my-row" id="w-row-bot"></div>
      </div>
      <div class="strip watch-strip bottom" id="w-strip-bot">
        ${heroPlateHtml('bot')}
        <div class="watch-hand" id="w-hand-bot"></div>
      </div>
    </div>
    <div class="watch-rail">
      <div class="watch-title">AI vs AI · PLAYTEST</div>
      <div class="watch-match" id="w-match">MATCH 1 / 1</div>
      <div class="watch-scoreboard" id="w-score"></div>
      <div class="watch-acting" id="w-acting">—</div>

      <div class="watch-controls">
        <div class="watch-ctl-label">SPEED</div>
        <div class="watch-speed" id="w-speed"></div>
      </div>

      <div class="log-panel" id="w-log">
        <div class="log-head"><span class="tag">Play-by-play</span></div>
        <div class="log-body" id="w-log-body"></div>
      </div>

      <div class="watch-rail-bottom">
        <button class="btn small" id="w-download" disabled>⭳ DOWNLOAD LOG</button>
        <button class="btn small danger" id="w-stop">STOP · BACK TO LOBBY</button>
      </div>
    </div>
  `;
  els = {};
  for (const el of root.querySelectorAll('[id]')) els[el.id] = el;

  // speed buttons
  const sp = els['w-speed'];
  SPEEDS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'watch-speed-btn' + (i === speedIdx ? ' active' : '');
    b.textContent = s.label;
    b.addEventListener('click', () => setSpeed(i));
    sp.appendChild(b);
  });

  els['w-download'].addEventListener('click', doDownload);
  els['w-stop'].addEventListener('click', stopAndLeave);

  renderScoreboard();
  els['w-match'].textContent = `MATCH ${matchNo} / ${matchesTotal}`;
}

function heroPlateHtml(side) {
  return `
    <div class="hero-plate ${side === 'bot' ? 'me' : 'opp'}" id="w-hero-${side}">
      <div class="hero-portrait" id="w-portrait-${side}"></div>
      <div class="hero-id">
        <span class="hero-name" id="w-name-${side}"></span>
        <span class="hero-corp" id="w-corp-${side}"></span>
        <div class="capital-row" id="w-cap-${side}"></div>
      </div>
      <div class="integrity" id="w-int-${side}">40</div>
    </div>
    <div class="deck-pill" id="w-deck-${side}"><span id="w-deckn-${side}">0</span> deck</div>
  `;
}

// ============================================================ rendering
function renderView() {
  if (!view || !active) return;
  // players[0] = bottom slot (faction A), players[1] = top slot (faction B)
  const bot = view.players[0], top = view.players[1];
  if (!bot || !top) return;

  // remember unit names so the log can still name a unit after it dies
  for (const u of [...(bot.board || []), ...(top.board || [])]) {
    const d = getCard(u.cardId);
    if (d) unitNames.set(u.id, d.name);
  }

  renderHero('bot', bot, view.activePlayer === 0 && !view.over);
  renderHero('top', top, view.activePlayer === 1 && !view.over);

  renderBoard(els['w-row-bot'], bot.board || [], false);
  renderBoard(els['w-row-top'], top.board || [], true);

  renderHandFaceUp(els['w-hand-bot'], bot.hand || []);
  renderHandFaceUp(els['w-hand-top'], top.hand || []);

  renderContracts(els['w-contracts-bot'], bot.contracts || []);
  renderContracts(els['w-contracts-top'], top.contracts || []);

  els['w-deckn-bot'].textContent = bot.deckCount;
  els['w-deckn-top'].textContent = top.deckCount;

  // acting indicator
  const acting = els['w-acting'];
  if (view.over) {
    acting.textContent = 'MARKET CLOSED';
    acting.style.color = 'var(--ink-dim)';
  } else {
    const af = factions[view.activePlayer];
    acting.textContent = `${label(af)} ACTING`;
    acting.style.color = color(af);
  }
}

function renderHero(side, p, isActive) {
  const plate = els[`w-hero-${side}`];
  const fm = factionMeta(p.faction);
  plate.style.setProperty('--fc', fm.color);
  plate.classList.toggle('active-turn', isActive);
  const port = els[`w-portrait-${side}`];
  const ceoId = p.ceo?.cardId || p.faction + '_ceo';
  if (port.dataset.ceo !== ceoId) {
    port.dataset.ceo = ceoId;
    mountCeoPortrait(port, p.faction, ceoId);
  }
  els[`w-name-${side}`].textContent = p.name || fm.name;
  els[`w-corp-${side}`].textContent = (p.ceo?.name ? p.ceo.name + ' · ' : '') + fm.name;
  els[`w-int-${side}`].textContent = p.integrity;

  const capRow = els[`w-cap-${side}`];
  capRow.innerHTML = '';
  const maxC = Math.max(p.maxCapital, 0);
  for (let i = 0; i < maxC; i++) {
    const pip = document.createElement('span');
    pip.className = 'capital-pip ' + (i < p.capital ? 'lit' : 'spent');
    capRow.appendChild(pip);
  }
  const lbl = document.createElement('span');
  lbl.className = 'capital-label';
  lbl.textContent = `${p.capital}/${p.maxCapital}`;
  capRow.appendChild(lbl);
  if (p.assetCapitalBonus > 0) {
    const bonus = document.createElement('span');
    bonus.className = 'capital-bonus';
    bonus.textContent = `+${p.assetCapitalBonus}`;
    bonus.title = `War Chest: +${p.assetCapitalBonus} ASSET capital`;
    capRow.appendChild(bonus);
  }
}

function renderBoard(row, board, enemy) {
  row.innerHTML = '';
  for (const u of board) {
    const el = renderUnit(u, { enemy });
    const def = getCard(u.cardId);
    if (def) {
      attachPreview(el, def, {
        attack: u.attack, health: u.health, damaged: u.health < (u.maxHealth ?? u.health),
        keywords: u.keywords, silenced: u.silenced, distracted: u.distracted, counters: u.counters,
      });
    }
    row.appendChild(el);
  }
}

function renderHandFaceUp(container, hand) {
  container.innerHTML = '';
  for (const entry of hand) {
    const cardId = typeof entry === 'string' ? entry : entry.cardId;
    const def = getCard(cardId);
    const el = renderCard(def || cardId, { width: 58, interactive: false });
    if (def) attachPreview(el, def);
    container.appendChild(el);
  }
}

function renderContracts(container, contracts) {
  container.innerHTML = '';
  for (const c of contracts) {
    const def = getCard(c.cardId);
    const tile = renderContractTile(c, def);
    if (def) attachPreview(tile, def);
    container.appendChild(tile);
  }
}

function renderScoreboard() {
  const sb = els['w-score'];
  if (!sb) return;
  const a = factions[0], b = factions[1];
  const wa = tally ? (tally[a] || 0) : 0;
  const wb = tally ? (tally[b] || 0) : 0;
  const draws = tally ? (tally.draws || 0) : 0;
  // mirror match: both sides same faction — label them A/B so the count reads
  const mirror = a === b;
  sb.innerHTML = `
    <div class="score-side" style="--fc:${color(a)}">
      <span class="score-faction">${label(a)}${mirror ? ' (A)' : ''}</span>
      <span class="score-wins">${mirror ? Math.ceil(wa) : wa}</span>
    </div>
    <div class="score-vs">vs</div>
    <div class="score-side" style="--fc:${color(b)}">
      <span class="score-faction">${label(b)}${mirror ? ' (B)' : ''}</span>
      <span class="score-wins">${mirror ? Math.floor(wb) : wb}</span>
    </div>
    ${draws ? `<div class="score-draws">${draws} draw${draws === 1 ? '' : 's'}</div>` : ''}
  `;
}

// ============================================================ controls
function setSpeed(i) {
  speedIdx = i;
  for (const b of els['w-speed'].querySelectorAll('.watch-speed-btn')) b.classList.remove('active');
  els['w-speed'].children[i]?.classList.add('active');
  net.send({ t: 'watchSpeed', speed: SPEEDS[i].scale });
}

function stopAndLeave() {
  net.send({ t: 'watchStop' });
  showScreen('lobby');
}

function doDownload() {
  if (!downloadLog) return;
  const blob = new Blob([JSON.stringify(downloadLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = `${factions[0]}-vs-${factions[1]}-${downloadLog.matchesPlayed}g`;
  a.href = url;
  a.download = `hostile-takeover-playtest-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================ play log
function logLine(text, cls = '') {
  logEntries.push({ text, cls });
  const body = els['w-log-body'];
  if (!body) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.innerHTML = text;
  body.appendChild(line);
  while (body.childElementCount > 200) body.firstElementChild.remove();
  body.scrollTop = body.scrollHeight;
}

function nameOf(cardId) {
  return getCard(cardId)?.name || cardId;
}

// Resolve a unit/hero id to a display name (hero ids → "<Faction> CEO").
function unitName(id) {
  if (!id) return 'a unit';
  if (id === 'hero0') return label(factions[0]) + ' CEO';
  if (id === 'hero1') return label(factions[1]) + ' CEO';
  return unitNames.get(id) || 'a unit';
}

// Narrate the salient events of a batch into the play-by-play. Event shapes
// match the engine's emissions (see shared/engine.js).
function narrate(events) {
  for (const e of events || []) {
    switch (e.e) {
      case 'turnStart':
        logLine(`<b style="color:${color(factions[e.player])}">— ${label(factions[e.player])} · turn ${e.turn} —</b>`, 'turn-line');
        break;
      case 'cardPlayed':
        if (e.cardId) logLine(`${sideDot(e.player)} plays <b>${escapeHtml(nameOf(e.cardId))}</b>.`);
        break;
      case 'contractFiled':
        if (e.cardId) logLine(`${sideDot(e.player)} files <b>${escapeHtml(nameOf(e.cardId))}</b>.`);
        break;
      case 'summon':
        if (e.cardId) logLine(`${sideDot(e.player)} summons <b>${escapeHtml(nameOf(e.cardId))}</b>.`);
        break;
      case 'attack':
        logLine(`${escapeHtml(unitName(e.attackerId))} <span class="dmg">→</span> ${escapeHtml(unitName(e.targetId))}.`);
        break;
      case 'heroPower':
        if (e.player != null) logLine(`${sideDot(e.player)} uses CEO power.`);
        break;
      case 'death':
        logLine(`<span class="dmg">✖</span> ${escapeHtml(nameOf(e.cardId) || unitName(e.unitId))} destroyed.`);
        break;
      default:
        break; // gameOver handled by watchGameOver
    }
  }
}

function sideDot(player) {
  const f = factions[player];
  return `<span style="color:${color(f)};font-weight:700">${label(f)}</span>`;
}

// ============================================================ net handlers
net.on('watchStart', (msg) => {
  // A watchStart can arrive while we're still on the lobby (first match) — the
  // lobby transitions us here. Subsequent matches arrive while already active.
  if (!active) { showScreen('watch', { ...msg, speedIdx }); return; }
  factions = msg.factions || factions;
  matchNo = msg.match; matchesTotal = msg.matches;
  tally = msg.tally;
  view = msg.view;
  unitNames.clear();
  document.querySelector('.watch-overlay')?.remove();
  els['w-match'].textContent = `MATCH ${matchNo} / ${matchesTotal}`;
  renderScoreboard();
  logLine(`<b>Match ${matchNo}</b> begins — ${label(factions[msg.firstSeat])} goes first.`, 'turn-line');
  renderView();
});

net.on('watchState', (msg) => {
  if (!active) return;
  view = msg.view;
  narrate(msg.events);
  renderView();
});

net.on('watchGameOver', (msg) => {
  if (!active) return;
  view = msg.view;
  tally = msg.tally;
  renderView();
  renderScoreboard();
  const wf = msg.winnerFaction;
  logLine(`<b>Match ${msg.match} over</b> — ${wf ? `${label(wf)} wins` : 'draw'} (${escapeHtml(msg.reason)}).`, 'turn-line');
  if (!msg.done) showBetween(msg);
});

net.on('watchComplete', (msg) => {
  if (!active) return;
  downloadLog = msg.log;
  tally = msg.tally;
  els['w-download'].disabled = false;
  renderScoreboard();
  showFinal(msg);
});

// ============================================================ overlays
function showBetween(msg) {
  document.querySelector('.watch-overlay')?.remove();
  const wf = msg.winnerFaction;
  const box = document.createElement('div');
  box.className = 'watch-overlay between';
  box.innerHTML = `
    <div class="watch-overlay-inner">
      <div class="wo-title" style="color:${wf ? color(wf) : 'var(--ink)'}">${wf ? label(wf) + ' WINS' : 'DRAW'}</div>
      <div class="wo-sub">Match ${msg.match} of ${msg.matches} · next match starting…</div>
    </div>`;
  root.appendChild(box);
}

function showFinal(msg) {
  document.querySelector('.watch-overlay')?.remove();
  const a = factions[0], b = factions[1];
  const wa = msg.tally[a] || 0, wb = msg.tally[b] || 0, draws = msg.tally.draws || 0;
  const mirror = a === b;
  const leader = mirror ? null : (wa === wb ? null : (wa > wb ? a : b));
  const box = document.createElement('div');
  box.className = 'watch-overlay final';
  box.innerHTML = `
    <div class="watch-overlay-inner">
      <div class="wo-title">SIMULATION COMPLETE</div>
      <div class="wo-score">
        <span style="color:${color(a)}">${label(a)}${mirror ? ' (A)' : ''} ${mirror ? Math.ceil(wa) : wa}</span>
        <span class="wo-dash">—</span>
        <span style="color:${color(b)}">${mirror ? Math.floor(wb) : wb} ${label(b)}${mirror ? ' (B)' : ''}</span>
      </div>
      <div class="wo-sub">${msg.log.matchesPlayed} matches${draws ? ` · ${draws} draw${draws === 1 ? '' : 's'}` : ''}${leader ? ` · ${label(leader)} leads` : (mirror ? '' : ' · dead even')}</div>
      <div class="wo-actions">
        <button class="btn primary" id="wo-download">⭳ DOWNLOAD PLAY LOG</button>
        <button class="btn ghost" id="wo-lobby">BACK TO LOBBY</button>
      </div>
      <div class="wo-note">Send the downloaded log to Claude to analyze balance.</div>
    </div>`;
  root.appendChild(box);
  box.querySelector('#wo-download').addEventListener('click', doDownload);
  box.querySelector('#wo-lobby').addEventListener('click', stopAndLeave);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
