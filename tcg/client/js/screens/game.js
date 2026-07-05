// screens/game.js — the match screen. Renders the authoritative view, drives
// targeting/attack/positioning input, and feeds server batches to the anim queue.

import { getCard, factionMeta, session, EMOTES, KEYWORD_NAMES, KEYWORD_HELP } from '../state.js';
import * as net from '../net.js';
import { showScreen, toast } from '../main.js';
import { renderCard, renderUnit, renderCardBack, renderContractTile, attachPreview, hidePreview } from '../components/card.js';
import { mountCeoPortrait, artSvg } from '../art.js';
import { initAnim, stopAnim, queueBatch, isAnimating, fxRoot, showBanner } from '../anim.js';
import * as audio from '../audio.js';

let root = null;
let active = false;

// match state (display only — server is authoritative)
let youIdx = 0;
let view = null;
let oppMeta = { name: 'Opponent', faction: 'neutral' };
let deadline = 0;
let over = false;
let pendingGameOver = null;

// input mode: null | {kind:'position', handIndex}
//           | {kind:'target', source:'hand'|'power'|'position', handIndex?, position?, targeting}
//           | {kind:'attack', attackerId}
let mode = null;
let arrowSvg = null;
let timerTimer = null;
let els = {};
const unitNames = new Map(); // unitId -> display name (survives death for the log)

export function mount(el) { root = el; }

export function enter(params) {
  active = true;
  over = false;
  pendingGameOver = null;
  mode = null;
  session.inGame = true;
  unitNames.clear();
  // Re-entering without exit() (e.g. rematch gameStart while already on this
  // screen): clear last game's terminal overlay and stale UI references.
  document.querySelector('.gameover-veil')?.remove();
  rematchOfferPending = false;
  emoteWheel = null;

  if (params && params.view) {
    youIdx = params.you ?? params.view.you?.index ?? 0;
    oppMeta = params.opponent || { name: 'Opponent', faction: params.view.opp?.faction || 'neutral' };
    view = params.view;
    deadline = params.turnDeadline || 0;
  }
  buildSkeleton();
  initAnim(hooks);
  renderView();
  logLine(`<b>Session opened</b> — ${escapeHtml(view?.you?.name || 'You')} vs ${escapeHtml(oppMeta.name)}`, 'turn-line');
  if (view && view.activePlayer === youIdx) showBanner('YOUR TURN', 'FISCAL ROUND ' + view.turn);
  else showBanner("OPPONENT'S TURN", 'FISCAL ROUND ' + (view?.turn ?? 1), 'opp');
  clearInterval(timerTimer);
  timerTimer = setInterval(updateTimer, 400);
}

export function exit() {
  active = false;
  session.inGame = false;
  clearInterval(timerTimer);
  stopAnim();
  cancelMode();
  hidePreview();
  document.querySelector('.gameover-veil')?.remove();
}

export function onKey(ev, typing) {
  if (typing) return false;
  if (ev.key === 'Escape') {
    if (mode || layoffChooser) { cancelMode(); return true; }
    return false;
  }
  if ((ev.key === ' ' || ev.key.toLowerCase() === 'e') && !over) {
    tryEndTurn();
    return true;
  }
  return false;
}

// ============================================================ skeleton
function buildSkeleton() {
  root.innerHTML = `
    <div class="game-table" id="g-table">
      <div class="strip opp-strip">
        <div class="hero-plate opp" id="g-hero-opp" data-target-id="hero${1 - youIdx}">
          <div class="hero-portrait" id="g-portrait-opp"></div>
          <div class="hero-id">
            <span class="hero-name" id="g-name-opp"></span>
            <span class="hero-corp" id="g-corp-opp"></span>
            <div class="capital-row" id="g-cap-opp"></div>
          </div>
          <div class="integrity" id="g-int-opp">30</div>
        </div>
        <div class="deck-pill" id="g-deck-opp" title="Opponent deck">${deckIcon()}<span id="g-deckn-opp">0</span></div>
        <div class="opp-hand" id="g-opp-hand"></div>
      </div>
      <div class="board-zone">
        <div class="board-floor" aria-hidden="true"></div>
        <div class="contract-zone opp" id="g-contracts-opp"></div>
        <div class="contract-zone me" id="g-contracts-me"></div>
        <div class="board-row opp-row" id="g-row-opp"></div>
        <div class="board-divider"></div>
        <div class="board-row my-row" id="g-row-me"></div>
      </div>
      <div class="strip my-strip">
        <div class="hero-plate me" id="g-hero-me" data-target-id="hero${youIdx}">
          <div class="hero-portrait" id="g-portrait-me"></div>
          <div class="hero-id">
            <span class="hero-name" id="g-name-me"></span>
            <span class="hero-corp" id="g-corp-me"></span>
            <div class="capital-row" id="g-cap-me"></div>
          </div>
          <div class="integrity" id="g-int-me">30</div>
        </div>
        <button class="power-btn" id="g-power" title="CEO Power"></button>
        <div class="deck-pill" id="g-deck-me" title="Your deck">${deckIcon()}<span id="g-deckn-me">0</span></div>
        <div style="position:relative;margin-left:auto;display:flex;align-items:center;gap:10px">
          <button class="emote-btn" id="g-emote" title="Corporate communications">🗨</button>
        </div>
      </div>
      <div class="hand-zone"><div class="hand-fan" id="g-hand"></div></div>
    </div>
    <div class="game-rail">
      <div class="turn-indicator" id="g-turn-ind">—</div>
      <div class="timer-bar"><div class="timer-fill" id="g-timer"></div></div>
      <button class="end-turn-btn" id="g-endturn">END TURN</button>
      <div class="rail-stats">
        <div class="rail-stat"><span>ROUND</span><span class="v" id="g-round">1</span></div>
        <div class="rail-stat"><span>YOUR DECK</span><span class="v" id="g-rs-deck-me">30</span></div>
        <div class="rail-stat"><span>ENEMY DECK</span><span class="v" id="g-rs-deck-opp">30</span></div>
      </div>
      <div class="log-panel" id="g-log">
        <div class="log-head" id="g-log-head"><span class="tag">Transaction Log</span><span class="tag" id="g-log-toggle">▾</span></div>
        <div class="log-body" id="g-log-body"></div>
      </div>
      <div class="rail-bottom">
        <button class="btn small ghost" id="g-menu-emote-hint" style="display:none"></button>
        <button class="btn small danger" id="g-concede">CONCEDE</button>
      </div>
    </div>
  `;

  els = {};
  for (const el of root.querySelectorAll('[id]')) els[el.id] = el;

  els['g-endturn'].addEventListener('click', tryEndTurn);
  els['g-concede'].addEventListener('click', () => {
    if (over) return;
    if (confirm('Concede the takeover? Your board will not forgive this.')) {
      net.send({ t: 'concede' });
    }
  });
  els['g-log-head'].addEventListener('click', () => {
    els['g-log'].classList.toggle('collapsed');
    els['g-log-toggle'].textContent = els['g-log'].classList.contains('collapsed') ? '▸' : '▾';
  });
  els['g-emote'].addEventListener('click', toggleEmoteWheel);
  els['g-power'].addEventListener('click', onPowerClick);

  // hero plates as targets
  for (const id of ['g-hero-opp', 'g-hero-me']) {
    els[id].addEventListener('click', () => onTargetClick(els[id].dataset.targetId));
  }

  // click-away / right-click cancels modes (and the layoff chooser)
  root.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) { cancelMode(); return; }
    // layoff chooser: close on any press outside it — except on its own unit,
    // whose click handler toggles it (closing here would make it re-open)
    if (layoffChooser && !ev.target.closest('.layoff-chooser')) {
      const unitEl = ev.target.closest('.unit');
      if (!unitEl || unitEl.dataset.unitId !== layoffChooser.dataset.unitId) closeLayoffChooser();
    }
    if (!mode) return;
    if (!ev.target.closest('.unit, .hand-card, .hero-plate, .drop-slot, .power-btn, .contract-tile, .layoff-chooser')) cancelMode();
  });
  root.addEventListener('mousemove', onMouseMove);
}

function deckIcon() {
  return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="9" height="12" rx="1.5" fill="none" stroke="currentColor"/><rect x="5" y="1" width="9" height="12" rx="1.5" fill="#0e1520" stroke="currentColor"/></svg>`;
}

// ============================================================ anim hooks
const hooks = {
  resolveTarget(id) {
    if (!id) return null;
    if (id === 'hero' + youIdx) return els['g-hero-me'];
    if (id.startsWith('hero')) return els['g-hero-opp'];
    // "c<N>" — filed contract tiles (either zone)
    if (/^c\d+$/.test(id)) return root.querySelector(`.contract-tile[data-target-id="${id}"]`);
    return root.querySelector(`[data-unit-id="${id}"]`);
  },
  boardRow(player) { return player === youIdx ? els['g-row-me'] : els['g-row-opp']; },
  contractZone(player) { return player === youIdx ? els['g-contracts-me'] : els['g-contracts-opp']; },
  deckAnchor(player) { return player === youIdx ? els['g-deck-me'] : els['g-deck-opp']; },
  handAnchor(player) { return player === youIdx ? els['g-hand'] : els['g-opp-hand']; },
  tableEl() { return els['g-table']; },
  applyView(batch) {
    view = batch.view || view;
    if (batch.turnDeadline) deadline = batch.turnDeadline;
    renderView();
  },
  logEvent,
  youIndex() { return youIdx; },
  factionOf(player) { return player === youIdx ? view.you.faction : view.opp.faction; },
  onBatchDone() {
    if (pendingGameOver) {
      const msg = pendingGameOver;
      pendingGameOver = null;
      showGameOver(msg);
    }
    renderView(); // refresh playability glows post-animation
  },
};

// ============================================================ rendering
function renderView() {
  if (!view || !active) return;
  const me = view.you, opp = view.opp;
  if (!me || !opp) return;

  // the board is about to be rebuilt: a surviving chooser would be anchored to
  // a detached element and could act on a stale unit id — always remove it
  closeLayoffChooser();

  // remember unit names for the log
  for (const u of [...(me.board || []), ...(opp.board || [])]) {
    const d = getCard(u.cardId);
    if (d) unitNames.set(u.id, d.name);
  }

  const myTurn = view.activePlayer === youIdx && !view.over;

  // heroes
  renderHero('me', me, myTurn);
  renderHero('opp', opp, !myTurn && !view.over);

  // opp hand backs
  const oh = els['g-opp-hand'];
  oh.innerHTML = '';
  const hc = opp.handCount ?? 0;
  for (let i = 0; i < hc; i++) oh.appendChild(renderCardBack(52));

  // boards
  renderBoard(els['g-row-opp'], opp.board || [], true);
  renderBoard(els['g-row-me'], me.board || [], false);

  // filed contracts (public on both sides; empty zone renders nothing)
  renderContracts(els['g-contracts-opp'], opp.contracts || []);
  renderContracts(els['g-contracts-me'], me.contracts || []);

  // hand
  renderHand(me.hand || [], myTurn);

  // deck counts
  els['g-deckn-me'].textContent = me.deckCount;
  els['g-deckn-opp'].textContent = opp.deckCount;
  els['g-rs-deck-me'].textContent = me.deckCount + (me.fatigue ? ` (FATIGUE ${me.fatigue})` : '');
  els['g-rs-deck-opp'].textContent = opp.deckCount + (opp.fatigue ? ` (FATIGUE ${opp.fatigue})` : '');
  els['g-round'].textContent = view.turn;
  els['g-deckn-me'].parentElement.classList.toggle('fatigue-warn', me.deckCount === 0);

  // turn indicator + end turn
  els['g-turn-ind'].textContent = view.over ? 'MARKET CLOSED' : myTurn ? 'YOUR TURN' : "OPPONENT'S TURN";
  els['g-turn-ind'].classList.toggle('yours', myTurn);
  const et = els['g-endturn'];
  et.disabled = !myTurn;
  et.classList.toggle('ready', myTurn);
  et.textContent = myTurn ? 'END TURN' : 'ENEMY TURN';

  // CEO power
  renderPower(me, myTurn);
  updateTimer();

  // restore mode highlights if a mode survives a re-render (drop mode etc.)
  if (mode) reapplyModeHighlights();
}

function renderHero(side, p, isActive) {
  const meSide = side === 'me';
  const plate = els[meSide ? 'g-hero-me' : 'g-hero-opp'];
  const fm = factionMeta(p.faction);
  plate.style.setProperty('--fc', fm.color);
  plate.classList.toggle('active-turn', isActive);
  const port = els[meSide ? 'g-portrait-me' : 'g-portrait-opp'];
  const ceoId = p.ceo?.cardId || p.faction + '_ceo';
  if (port.dataset.ceo !== ceoId) {
    port.dataset.ceo = ceoId;
    mountCeoPortrait(port, p.faction, ceoId);
    attachPreview(port, getCard(ceoId) || {
      id: ceoId, name: p.ceo?.name || fm.name, faction: p.faction, type: 'CEO',
      text: fm.identity, flavor: fm.tagline, rarity: 'legendary', health: p.maxIntegrity,
    });
  }
  els[meSide ? 'g-name-me' : 'g-name-opp'].textContent = p.name || (meSide ? 'You' : oppMeta.name);
  els[meSide ? 'g-corp-me' : 'g-corp-opp'].textContent = (p.ceo?.name ? p.ceo.name + ' · ' : '') + fm.name;
  els[meSide ? 'g-int-me' : 'g-int-opp'].textContent = p.integrity;

  // capital pips
  const capRow = els[meSide ? 'g-cap-me' : 'g-cap-opp'];
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
}

function renderBoard(row, board, enemy) {
  row.innerHTML = '';
  for (const u of board) {
    const el = renderUnit(u, { enemy });
    const def = getCard(u.cardId);
    if (def) {
      attachPreview(el, def, { attack: u.attack, health: u.health, damaged: u.health < (u.maxHealth ?? u.health) });
    }
    el.addEventListener('click', (ev) => { ev.stopPropagation(); onUnitClick(u, enemy, el); });
    row.appendChild(el);
  }
}

function renderContracts(container, contracts) {
  container.innerHTML = '';
  for (const c of contracts) {
    const def = getCard(c.cardId);
    const tile = renderContractTile(c, def);
    if (def) attachPreview(tile, def);
    // tiles are only ever clicked as targets (null-&-void effects)
    tile.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (mode && mode.kind === 'target') onTargetClick(c.id);
    });
    container.appendChild(tile);
  }
}

function renderHand(hand, myTurn) {
  const fan = els['g-hand'];
  fan.innerHTML = '';
  const n = hand.length;
  if (!n) return;
  const zoneW = fan.clientWidth || 800;
  const cardW = 128;
  const spacing = Math.min(cardW * 0.72, (zoneW - cardW - 40) / Math.max(n - 1, 1));
  hand.forEach((hc, i) => {
    const def = getCard(hc.cardId);
    const wrap = document.createElement('div');
    wrap.className = 'hand-card' + (hc.playable && myTurn ? ' playable' : ' unplayable');
    wrap.style.zIndex = 20 + i;
    const centerOffset = (i - (n - 1) / 2);
    wrap.style.left = `calc(50% + ${Math.round(centerOffset * spacing - cardW / 2)}px)`;
    wrap.style.transform = `rotate(${(centerOffset * Math.min(5, 26 / n)).toFixed(2)}deg)`;
    const cardEl = renderCard(def || hc.cardId, { width: cardW, cost: hc.cost, attack: hc.dynAttack, interactive: false });
    wrap.appendChild(cardEl);
    if (def) attachPreview(wrap, def, { cost: hc.cost, attack: hc.dynAttack });
    wrap.addEventListener('click', (ev) => { ev.stopPropagation(); onHandClick(hc, i); });
    fan.appendChild(wrap);
  });
}

function renderPower(me, myTurn) {
  const btn = els['g-power'];
  const p = me.power;
  if (!p) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const def = getCard(p.cardId);
  if (btn.dataset.power !== p.cardId) {
    btn.dataset.power = p.cardId;
    btn.innerHTML = artSvg(p.cardId, me.faction, 'POWER') + `<span class="power-cost">${p.cost}</span>`;
    attachPreview(btn, def || {
      id: p.cardId, name: 'CEO Power', faction: me.faction, type: 'POWER',
      cost: p.cost, text: 'Once per turn.', rarity: 'rare',
    }, { cost: p.cost });
  }
  const usable = myTurn && !p.used && me.capital >= p.cost && !view.over;
  btn.classList.toggle('usable', usable);
  btn.classList.toggle('used', p.used);
  btn.disabled = !usable;
}

function updateTimer() {
  const fill = els['g-timer'];
  if (!fill) return;
  if (!deadline || over) { fill.style.width = '100%'; fill.classList.remove('low'); return; }
  const total = 90000;
  const left = Math.max(0, deadline - Date.now());
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  fill.style.width = pct + '%';
  fill.classList.toggle('low', left < 15000);
}

// ============================================================ input modes
function tryEndTurn() {
  if (!view || over) return;
  if (view.activePlayer !== youIdx) return;
  cancelMode();
  net.sendAction({ type: 'endTurn' });
}

function onHandClick(hc, index) {
  if (over || !view || view.activePlayer !== youIdx) return;
  if (!hc.playable) { toast('Insufficient capital or no legal play.', 'warn', 1600); return; }
  cancelMode(true);
  const def = getCard(hc.cardId);
  const isAsset = def?.type === 'ASSET';
  markSelectedHand(index);

  if (isAsset) {
    if ((view.you.board || []).length >= 7) { toast('Board is at capacity (7 assets).', 'warn'); clearSelectedHand(); return; }
    mode = { kind: 'position', handIndex: index, targeting: hc.targeting || null };
    showDropSlots();
  } else if (hc.targeting) {
    mode = { kind: 'target', source: 'hand', handIndex: index, targeting: hc.targeting };
    startArrow(handCardEl(index), 'play-mode');
    highlightTargets(hc.targeting);
  } else {
    clearSelectedHand();
    net.sendAction({ type: 'playCard', handIndex: index, target: null, position: null });
  }
}

function onUnitClick(u, enemy, el) {
  if (over || !view) return;
  if (mode && (mode.kind === 'target')) { onTargetClick(u.id); return; }
  if (mode && mode.kind === 'attack') { onTargetClick(u.id); return; }
  if (enemy) return;
  if (view.activePlayer !== youIdx) return;
  // LAYOFF units (§3c): in the neutral state, offer ATTACK-or-LAYOFF instead
  // of entering attack mode directly. Clicking its own unit again toggles.
  if ((u.keywords || []).includes('layoff')) {
    if (layoffChooser && layoffChooser.dataset.unitId === u.id) { closeLayoffChooser(); return; }
    openLayoffChooser(u, el);
    return;
  }
  if (!u.canAttack) { toast(u.exhausted ? 'Asset is exhausted.' : 'Asset cannot attack yet.', 'warn', 1500); return; }
  enterAttackMode(u, el);
}

function enterAttackMode(u, el) {
  cancelMode(true);
  mode = { kind: 'attack', attackerId: u.id };
  el.classList.add('attack-source');
  startArrow(el, '');
  highlightAttackTargets();
}

// ---------- LAYOFF chooser (§3c) ----------
let layoffChooser = null;

function openLayoffChooser(u, el) {
  cancelMode(true); // clears any position/target/attack mode + old chooser
  const pop = document.createElement('div');
  pop.className = 'layoff-chooser';
  pop.dataset.unitId = u.id;

  const atkBtn = document.createElement('button');
  atkBtn.className = 'lc-btn lc-attack';
  atkBtn.innerHTML = `<span class="lc-icon">⚔</span><span class="lc-label">ATTACK</span>`;
  if (u.canAttack) {
    atkBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeLayoffChooser();
      enterAttackMode(u, el);
    });
  } else {
    const reason = u.exhausted ? 'Asset is exhausted.' : 'Asset cannot attack yet.';
    atkBtn.classList.add('disabled');
    atkBtn.title = reason;
    atkBtn.setAttribute('aria-disabled', 'true');
    atkBtn.addEventListener('click', (ev) => { ev.stopPropagation(); toast(reason, 'warn', 1500); });
  }
  pop.appendChild(atkBtn);

  const layBtn = document.createElement('button');
  layBtn.className = 'lc-btn lc-layoff';
  layBtn.title = KEYWORD_HELP.layoff;
  layBtn.innerHTML = `<span class="lc-icon">🪓</span><span class="lc-label">LAYOFF<span class="lc-sub">free · +Integrity</span></span>`;
  layBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeLayoffChooser();
    net.sendAction({ type: 'layoff', unitId: u.id });
  });
  pop.appendChild(layBtn);

  // anchor above the unit, inside the table so mousedown bubbles to the
  // click-away handler (which whitelists .layoff-chooser)
  const table = els['g-table'];
  const tr = table.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  pop.style.left = (r.left + r.width / 2 - tr.left) + 'px';
  pop.style.top = (r.top - tr.top - 8) + 'px';
  table.appendChild(pop);
  layoffChooser = pop;
}

function closeLayoffChooser() {
  if (layoffChooser) { layoffChooser.remove(); layoffChooser = null; }
}

function onPowerClick(ev) {
  ev?.stopPropagation();
  if (over || !view || view.activePlayer !== youIdx) return;
  const p = view.you.power;
  if (!p || p.used || view.you.capital < p.cost) return;
  cancelMode(true);
  if (p.targeting) {
    mode = { kind: 'target', source: 'power', targeting: p.targeting };
    startArrow(els['g-power'], 'play-mode');
    highlightTargets(p.targeting);
  } else {
    net.send({ t: 'action', action: { type: 'heroPower', target: null } });
  }
}

function onTargetClick(targetId) {
  if (!mode) return;
  const el = hooks.resolveTarget(targetId);
  if (!el || !el.classList.contains('targetable')) return;
  const m = mode;
  cancelMode();
  if (m.kind === 'attack') {
    net.sendAction({ type: 'attack', attackerId: m.attackerId, targetId });
  } else if (m.kind === 'target') {
    if (m.source === 'power') {
      net.sendAction({ type: 'heroPower', target: targetId });
    } else {
      net.sendAction({ type: 'playCard', handIndex: m.handIndex, target: targetId, position: m.position ?? null });
    }
  }
}

function showDropSlots() {
  const row = els['g-row-me'];
  const units = [...row.querySelectorAll('.unit')];
  const positions = units.length + 1;
  // insert slot elements interleaved
  for (let i = 0; i < positions; i++) {
    const slot = document.createElement('div');
    slot.className = 'drop-slot';
    slot.dataset.position = i;
    slot.title = 'Deploy here';
    slot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onSlotPicked(i);
    });
    row.insertBefore(slot, units[i] || null);
  }
}

function onSlotPicked(position) {
  if (!mode || mode.kind !== 'position') return;
  const { handIndex, targeting } = mode;
  removeDropSlots();
  if (targeting) {
    mode = { kind: 'target', source: 'hand', handIndex, position, targeting };
    startArrow(handCardEl(handIndex) || els['g-row-me'], 'play-mode');
    const any = highlightTargets(targeting);
    if (!any) { // no valid targets: play untargeted (engine decides / rejects)
      const m = mode;
      cancelMode();
      net.sendAction({ type: 'playCard', handIndex: m.handIndex, target: null, position: m.position });
    }
  } else {
    mode = null;
    clearSelectedHand();
    net.sendAction({ type: 'playCard', handIndex, target: null, position });
  }
}

function removeDropSlots() {
  root.querySelectorAll('.drop-slot').forEach((s) => s.remove());
}

function handCardEl(index) {
  return els['g-hand'].children[index] || null;
}

function markSelectedHand(index) {
  clearSelectedHand();
  handCardEl(index)?.classList.add('selected-for-play');
}

function clearSelectedHand() {
  root.querySelectorAll('.hand-card.selected-for-play').forEach((e) => e.classList.remove('selected-for-play'));
}

// which units/heroes light up for a targeting spec
function highlightTargets(targeting) {
  clearTargetHighlights();
  const myUnits = [...els['g-row-me'].querySelectorAll('.unit')];
  const oppUnits = [...els['g-row-opp'].querySelectorAll('.unit')];
  const oppTargetable = oppUnits.filter((el) => !el.classList.contains('has-stealth'));
  let targets = [];
  switch (targeting) {
    case 'any': targets = [...myUnits, ...oppTargetable, els['g-hero-me'], els['g-hero-opp']]; break;
    case 'anyUnit': targets = [...myUnits, ...oppTargetable]; break;
    case 'enemyUnit': targets = oppTargetable; break;
    // Counter Offer: only enemy assets whose printed cost is 4 or less light up.
    // Cost isn't modified in-game, so getCard(cardId).cost matches the server.
    case 'enemyUnitCost4':
      targets = oppTargetable.filter((el) => (getCard(el.dataset.cardId)?.cost ?? 0) <= 4); break;
    case 'friendlyUnit': targets = myUnits; break;
    // Firewall Upgrade: only friendly assets that don't already have FIREWALL
    case 'friendlyUnitNoFirewall':
      targets = myUnits.filter((el) => !el.classList.contains('has-firewall')); break;
    case 'enemyHero': targets = [els['g-hero-opp']]; break;
    case 'anyHero': targets = [els['g-hero-me'], els['g-hero-opp']]; break;
    case 'enemyContract': targets = [...els['g-contracts-opp'].querySelectorAll('.contract-tile')]; break;
    default: targets = [];
  }
  for (const t of targets) t.classList.add('targetable');
  dimNonTargets([...myUnits, ...oppUnits], targets);
  return targets.length > 0;
}

function highlightAttackTargets() {
  clearTargetHighlights();
  const oppUnits = [...els['g-row-opp'].querySelectorAll('.unit')];
  const attackable = oppUnits.filter((el) => !el.classList.contains('has-stealth'));
  const firewalls = attackable.filter((el) => el.classList.contains('has-firewall'));
  let targets;
  if (firewalls.length) {
    targets = firewalls; // firewall enforcement, visualized
  } else {
    targets = [...attackable, els['g-hero-opp']];
  }
  for (const t of targets) t.classList.add('targetable');
  dimNonTargets(oppUnits, targets);
}

function dimNonTargets(units, targets) {
  const set = new Set(targets);
  for (const u of units) if (!set.has(u)) u.classList.add('not-targetable');
}

function clearTargetHighlights() {
  root.querySelectorAll('.targetable').forEach((e) => e.classList.remove('targetable'));
  root.querySelectorAll('.not-targetable').forEach((e) => e.classList.remove('not-targetable'));
  root.querySelectorAll('.attack-source').forEach((e) => e.classList.remove('attack-source'));
}

function reapplyModeHighlights() {
  if (!mode) return;
  if (mode.kind === 'position') { removeDropSlots(); showDropSlots(); }
  else if (mode.kind === 'attack') {
    const el = hooks.resolveTarget(mode.attackerId);
    if (el) { el.classList.add('attack-source'); highlightAttackTargets(); }
    else cancelMode();
  } else if (mode.kind === 'target') {
    highlightTargets(mode.targeting);
  }
}

export function cancelMode(keepQuiet = false) {
  void keepQuiet;
  mode = null;
  clearSelectedHand();
  clearTargetHighlights();
  removeDropSlots();
  closeLayoffChooser();
  stopArrow();
}

// ---------- targeting arrow ----------
let arrowFrom = null;

function startArrow(fromEl, cls) {
  stopArrow();
  arrowFrom = fromEl;
  arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowSvg.setAttribute('class', 'arrow-svg');
  arrowSvg.innerHTML = `<line class="arrow-line ${cls}" x1="0" y1="0" x2="0" y2="0"/><polygon class="arrow-head ${cls}" points="0,0 0,0 0,0"/>`;
  fxRoot().appendChild(arrowSvg);
}

function stopArrow() {
  arrowFrom = null;
  if (arrowSvg) { arrowSvg.remove(); arrowSvg = null; }
}

function onMouseMove(ev) {
  if (!arrowSvg || !arrowFrom) return;
  const r = arrowFrom.getBoundingClientRect();
  const x1 = r.left + r.width / 2, y1 = r.top + r.height / 2;
  const x2 = ev.clientX, y2 = ev.clientY;
  const line = arrowSvg.querySelector('.arrow-line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const hl = 14;
  const head = arrowSvg.querySelector('.arrow-head');
  const p = (a, d) => `${x2 - Math.cos(ang + a) * d},${y2 - Math.sin(ang + a) * d}`;
  head.setAttribute('points', `${x2},${y2} ${p(0.42, hl)} ${p(-0.42, hl)}`);
}

// ============================================================ log
function nameOfTarget(id) {
  if (id === 'hero' + youIdx) return view?.you?.name || 'You';
  if (typeof id === 'string' && id.startsWith('hero')) return oppMeta.name || 'Opponent';
  return unitNames.get(id) || 'an asset';
}

function logEvent(ev) {
  const you = youIdx;
  const who = (p) => (p === you ? '<b>You</b>' : '<b>' + escapeHtml(oppMeta.name || 'Opponent') + '</b>');
  const card = (id) => '<b>' + escapeHtml(getCard(id)?.name || 'a card') + '</b>';
  switch (ev.e) {
    case 'turnStart':
      logLine(`— ROUND ${ev.turn} · ${ev.player === you ? 'YOUR TURN' : 'OPPONENT TURN'} —`, 'turn-line');
      break;
    case 'capital': break; // too noisy
    case 'draw':
      if (ev.player === you && ev.cardId) logLine(`You drew ${card(ev.cardId)}.`);
      else logLine(`${who(ev.player)} drew a card.`);
      break;
    case 'mill':
      logLine(`${who(ev.player)} overdrew — ${card(ev.cardId)} was <span class="dmg">shredded</span>.`);
      break;
    case 'fatigue':
      logLine(`${who(ev.player)} is out of assets to draw: <span class="dmg">fatigue ${ev.amount}</span>.`);
      break;
    case 'cardPlayed':
      logLine(`${who(ev.player)} played ${card(ev.cardId)}.`);
      break;
    case 'summon':
      if (ev.unit) {
        unitNames.set(ev.unit.id, getCard(ev.unit.cardId)?.name || ev.unit.cardId);
        logLine(`${card(ev.unit.cardId)} deployed to the floor.`);
      }
      break;
    case 'attack':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.attackerId))}</b> attacked <b>${escapeHtml(nameOfTarget(ev.targetId))}</b>.`);
      break;
    case 'damage':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.targetId))}</b> took <span class="dmg">${ev.amount} damage</span>.`);
      break;
    case 'heal':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.targetId))}</b> restored <span class="healtxt">${ev.amount} integrity</span>.`);
      break;
    case 'shieldBreak':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.targetId))}</b>'s patent protection was broken.`);
      break;
    case 'death':
      logLine(`${card(ev.cardId)} was <span class="dmg">liquidated</span>.`);
      break;
    case 'layoff':
      logLine(`${card(ev.cardId)} was <span class="dmg">laid off</span>.`);
      break;
    case 'severance':
      logLine(`${card(ev.cardId)} triggered a <span class="healtxt">severance payout</span>.`);
      break;
    case 'buff':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.unitId))}</b> gained +${ev.attack ?? 0}/+${ev.health ?? 0}.`);
      break;
    case 'keyword':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.unitId))}</b> gained ${escapeHtml(KEYWORD_NAMES[ev.keyword] || ev.keyword)}.`);
      break;
    case 'heroPower':
      logLine(`${who(ev.player)} exercised the CEO power.`);
      break;
    case 'returnToHand':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.unitId))}</b> was recalled to hand.`);
      break;
    case 'transform':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.unitId))}</b> was restructured into ${card(ev.cardId)}.`);
      break;
    case 'silence':
      logLine(`<b>${escapeHtml(nameOfTarget(ev.unitId))}</b> was gagged by legal.`);
      break;
    case 'contractFiled': {
      const term = ev.contract && ev.contract.turnsLeft != null ? ` (term: ${ev.contract.turnsLeft})` : '';
      logLine(`${who(ev.player)} filed ${card(ev.contract?.cardId)}${term}.`);
      break;
    }
    case 'contractVoided':
      if (ev.reason === 'expired') logLine(`${card(ev.cardId)} expired — term complete.`);
      else logLine(`${card(ev.cardId)} was declared <span class="dmg">null &amp; void</span>.`);
      break;
    case 'gameOver':
      logLine(`— MARKET CLOSED —`, 'turn-line');
      break;
    default: break;
  }
}

function logLine(html, cls = '') {
  const body = els['g-log-body'];
  if (!body) return;
  const line = document.createElement('div');
  line.className = 'log-line ' + cls;
  line.innerHTML = html;
  body.appendChild(line);
  while (body.childElementCount > 120) body.firstElementChild.remove();
  body.scrollTop = body.scrollHeight;
}

// ============================================================ emotes
let emoteWheel = null;
let lastEmoteAt = 0;

function toggleEmoteWheel(ev) {
  ev.stopPropagation();
  if (emoteWheel) { emoteWheel.remove(); emoteWheel = null; return; }
  emoteWheel = document.createElement('div');
  emoteWheel.className = 'emote-wheel';
  for (const [id, e] of Object.entries(EMOTES)) {
    const b = document.createElement('button');
    b.className = 'emote-option';
    b.innerHTML = `<span>${e.icon}</span><span>${escapeHtml(e.text)}</span>`;
    b.addEventListener('click', () => {
      emoteWheel?.remove(); emoteWheel = null;
      const now = Date.now();
      if (now - lastEmoteAt < 3000) { toast('Comms rate-limited by HR.', 'warn', 1400); return; }
      lastEmoteAt = now;
      net.send({ t: 'emote', id });
      showEmoteBubble(id, true);
    });
    emoteWheel.appendChild(b);
  }
  els['g-emote'].parentElement.appendChild(emoteWheel);
  const closeIfOutside = (ev2) => {
    if (emoteWheel && !emoteWheel.contains(ev2.target) && ev2.target !== els['g-emote']) {
      emoteWheel.remove(); emoteWheel = null;
      document.removeEventListener('mousedown', closeIfOutside);
    } else if (!emoteWheel) {
      document.removeEventListener('mousedown', closeIfOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeIfOutside), 0);
}

function showEmoteBubble(id, mine) {
  const e = EMOTES[id];
  if (!e) return;
  root.querySelector('.emote-bubble' + (mine ? '.from-me' : '.from-opp'))?.remove();
  const b = document.createElement('div');
  b.className = 'emote-bubble ' + (mine ? 'from-me' : 'from-opp');
  b.textContent = e.icon + '  ' + e.text;
  els['g-table'].appendChild(b);
  setTimeout(() => b.remove(), 3200);
}

// ============================================================ game over
function showGameOver(msg) {
  over = true;
  cancelMode();
  document.querySelector('.gameover-veil')?.remove();
  const won = msg.winner === youIdx;
  // Winning CEO's taunt — fired here (as the rematch overlay is built) so it
  // plays on EVERY end path (takeover, concede, timeout, desertion) and lands
  // exactly as the screen appears. `view` faction is stable for the whole match.
  // If it can't play, say WHY on screen — the three failure modes otherwise all
  // look identical (silence): no file for that faction, SFX muted, or blocked.
  if (typeof msg.winner === 'number' && view) {
    const wf = msg.winner === youIdx ? view.you?.faction : view.opp?.faction;
    if (wf) {
      const fname = factionMeta(wf)?.name || wf;
      audio.playCeoTaunt(wf).then((r) => {
        if (!r || r.status === 'played') return;
        if (r.status === 'muted') toast(`🔇 ${fname} CEO taunt is ready but SFX is muted — enable it in ⚙.`, 'warn', 6000);
        else if (r.status === 'no-file') toast(`🔊 No taunt audio for ${fname} — add ${r.expected}`, 'warn', 7000);
        else if (r.status === 'blocked') toast(`🔊 ${fname} CEO taunt was blocked by the browser.`, 'warn', 6000);
      });
    }
  }
  const reasons = {
    takeover: won ? 'Enemy CEO integrity reduced to zero.' : 'Your CEO integrity reached zero.',
    concede: won ? 'The rival board voted to capitulate.' : 'You conceded the takeover.',
    timeout: 'Decision deadline exceeded.',
    desertion: won ? 'Rival executive abandoned the negotiation.' : 'Connection abandoned.',
  };
  const veil = document.createElement('div');
  veil.className = 'gameover-veil';
  veil.innerHTML = `
    <div class="gameover-box">
      <div class="gameover-title ${won ? 'victory' : 'defeat'}">${won ? 'HOSTILE TAKEOVER<br>COMPLETE' : 'COMPANY LIQUIDATED'}</div>
      <div class="gameover-reason">${escapeHtml(reasons[msg.reason] || msg.reason || '')}</div>
      <div class="rematch-note" id="go-note" style="display:none">OPPONENT PROPOSES A REMATCH</div>
      <div class="gameover-actions">
        <button class="btn primary" id="go-rematch">REMATCH</button>
        <button class="btn ghost" id="go-lobby">BACK TO LOBBY</button>
      </div>
    </div>
  `;
  document.body.appendChild(veil);
  if (rematchOfferPending) { veil.querySelector('#go-note').style.display = ''; rematchOfferPending = false; }
  veil.querySelector('#go-rematch').addEventListener('click', () => {
    net.send({ t: 'rematch' });
    const btn = veil.querySelector('#go-rematch');
    btn.disabled = true;
    btn.textContent = 'AWAITING RIVAL…';
  });
  veil.querySelector('#go-lobby').addEventListener('click', () => {
    net.send({ t: 'leaveGame' });
    veil.remove();
    showScreen('lobby');
  });
}

let rematchOfferPending = false;

// ============================================================ net handlers
net.on('state', (msg) => {
  if (!active) return;
  queueBatch({ view: msg.view, events: msg.events || [], turnDeadline: msg.turnDeadline });
});

net.on('gameOver', (msg) => {
  if (!active) return;
  over = true;
  const batch = { view: msg.view || view, events: [], turnDeadline: 0 };
  if (isAnimating()) {
    queueBatch(batch);
    pendingGameOver = msg;
  } else {
    queueBatch(batch);
    // let the (empty) batch apply, then show
    setTimeout(() => showGameOver(msg), 350);
  }
});

net.on('actionError', (msg) => {
  if (!active) return;
  toast(msg.msg || 'Action rejected.', 'error', 2400);
  cancelMode();
  renderView(); // re-enable input from authoritative view
});

net.on('emote', (msg) => {
  if (!active) return;
  const mine = msg.from === youIdx || msg.from === view?.you?.name;
  if (mine) return; // we already displayed ours locally
  showEmoteBubble(msg.id, false);
});

net.on('rematchOffered', () => {
  if (!active) return;
  const note = document.querySelector('#go-note');
  if (note) note.style.display = '';
  else rematchOfferPending = true;
  toast('Opponent proposes a rematch.', '', 2600);
});

net.on('opponentLeft', () => {
  if (!active) return;
  toast('Opponent lost connection — desertion clause pending (30 s)…', 'warn', 5000);
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
