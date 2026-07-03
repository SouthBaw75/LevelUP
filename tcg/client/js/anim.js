// anim.js — sequential event-animation queue + fx-layer helpers.
//
// The server sends {view, events, turnDeadline} after every accepted action.
// We queue each batch and play its events one at a time (~250–500 ms each) as
// visual flourishes over the CURRENT DOM, then hand the authoritative view to
// game.js for a full re-render. Events are never used to derive state — only
// to animate. New batches arriving mid-playback simply queue behind.

import { getCard } from './state.js';
import { renderCard, renderUnit, renderCardBack } from './components/card.js';

let hooks = null;
// hooks = {
//   resolveTarget(id) -> Element|null        ("uN" | "hero0" | "hero1")
//   boardRow(playerIndex) -> Element         (row container for that player's units)
//   deckAnchor(playerIndex) -> Element       (deck pill, draw origin)
//   handAnchor(playerIndex) -> Element       (hand zone, draw destination)
//   tableEl() -> Element                     (for banners / fatigue overlays)
//   applyView(batch) -> void                 (authoritative re-render)
//   logEvent(ev) -> void
//   youIndex() -> 0|1
//   onBatchDone() -> void
// }

let fxLayer = null;
const queue = [];
let playing = false;
let cancelled = false;

export function initAnim(h) {
  hooks = h;
  if (!fxLayer) {
    fxLayer = document.createElement('div');
    fxLayer.id = 'fx-layer';
    document.body.appendChild(fxLayer);
  }
  fxLayer.innerHTML = '';
  queue.length = 0;
  playing = false;
  cancelled = false;
}

export function stopAnim() {
  cancelled = true;
  queue.length = 0;
  if (fxLayer) fxLayer.innerHTML = '';
}

export function fxRoot() { return fxLayer; }

/** Queue a state batch: plays events sequentially, then applies the view. */
export function queueBatch(batch) {
  queue.push(batch);
  if (!playing) drain();
}

export function isAnimating() { return playing; }

async function drain() {
  playing = true;
  cancelled = false;
  while (queue.length) {
    const batch = queue.shift();
    const events = Array.isArray(batch.events) ? batch.events : [];
    for (const ev of events) {
      if (cancelled) break;
      try { hooks.logEvent(ev); } catch (err) { console.error(err); }
      try { await playEvent(ev); } catch (err) { console.error('[anim]', ev.e, err); }
    }
    if (cancelled) break;
    hooks.applyView(batch);
    await wait(60); // let layout settle between batches
  }
  playing = false;
  hooks.onBatchDone?.();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function centerOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ---------- fx primitives ----------
export function floatNum(el, text, cls) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const n = document.createElement('div');
  n.className = 'float-num ' + cls;
  n.textContent = text;
  n.style.left = x + 'px';
  n.style.top = y + 'px';
  fxLayer.appendChild(n);
  setTimeout(() => n.remove(), 950);
}

function impactAt(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const f = document.createElement('div');
  f.className = 'impact-flash';
  f.style.left = x + 'px';
  f.style.top = y + 'px';
  fxLayer.appendChild(f);
  setTimeout(() => f.remove(), 450);
}

function pulseClass(el, cls, ms) {
  if (!el) return;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** Fly an element (ghost) from rect A to rect B. */
function fly(ghost, from, to, ms = 420, { fade = false, scaleTo = 1 } = {}) {
  ghost.classList.add('fly-card');
  ghost.style.left = from.x + 'px';
  ghost.style.top = from.y + 'px';
  ghost.style.transform = 'translate(-50%,-50%)';
  fxLayer.appendChild(ghost);
  // force layout so the transition runs
  void ghost.offsetWidth;
  ghost.style.transitionDuration = ms + 'ms';
  ghost.style.left = to.x + 'px';
  ghost.style.top = to.y + 'px';
  ghost.style.transform = `translate(-50%,-50%) scale(${scaleTo})`;
  if (fade) ghost.style.opacity = '0';
  setTimeout(() => ghost.remove(), ms + 80);
}

export function showBanner(text, sub, cls = '') {
  const table = hooks.tableEl();
  const b = document.createElement('div');
  b.className = 'turn-banner ' + cls;
  b.innerHTML = escapeHtml(text) + (sub ? `<span class="sub">${escapeHtml(sub)}</span>` : '');
  table.appendChild(b);
  setTimeout(() => b.remove(), 1400);
}

// ---------- per-event playback ----------
async function playEvent(ev) {
  const you = hooks.youIndex();
  switch (ev.e) {
    case 'turnStart': {
      const yours = ev.player === you;
      showBanner(yours ? 'YOUR TURN' : "OPPONENT'S TURN", 'FISCAL ROUND ' + ev.turn, yours ? '' : 'opp');
      await wait(950);
      break;
    }
    case 'capital': {
      await wait(120);
      break;
    }
    case 'draw': {
      const from = hooks.deckAnchor(ev.player);
      const to = hooks.handAnchor(ev.player);
      if (from && to) {
        let ghost;
        if (ev.player === you && ev.cardId && getCard(ev.cardId)) {
          ghost = renderCard(ev.cardId, { width: 110, interactive: false });
        } else {
          ghost = renderCardBack(64);
        }
        fly(ghost, centerOf(from), centerOf(to), 430, { scaleTo: ev.player === you ? 1.05 : 0.8, fade: ev.player !== you });
      }
      await wait(340);
      break;
    }
    case 'mill': {
      const from = hooks.deckAnchor(ev.player);
      if (from) {
        const ghost = ev.cardId && getCard(ev.cardId)
          ? renderCard(ev.cardId, { width: 100, interactive: false })
          : renderCardBack(60);
        const c = centerOf(from);
        fly(ghost, c, { x: c.x, y: c.y - 90 }, 430, { fade: true, scaleTo: 0.6 });
      }
      await wait(380);
      break;
    }
    case 'fatigue': {
      const table = hooks.tableEl();
      const f = document.createElement('div');
      f.className = 'fatigue-flash';
      table.appendChild(f);
      setTimeout(() => f.remove(), 750);
      const hero = hooks.resolveTarget('hero' + ev.player);
      floatNum(hero, 'FATIGUE −' + ev.amount, 'dmg');
      await wait(520);
      break;
    }
    case 'cardPlayed': {
      // reveal the played card center-screen (brief for your own plays)
      const mine = ev.player === you;
      if (ev.cardId && getCard(ev.cardId)) {
        const ghost = renderCard(ev.cardId, { width: mine ? 130 : 185, interactive: false, showFlavor: false });
        ghost.classList.add('fly-card');
        const cx = innerWidth / 2 - 100, cy = innerHeight / 2 - 40;
        ghost.style.left = cx + 'px';
        ghost.style.top = cy + 'px';
        ghost.style.transform = 'translate(-50%,-50%) scale(0.7)';
        ghost.style.opacity = '0';
        fxLayer.appendChild(ghost);
        void ghost.offsetWidth;
        ghost.style.transitionDuration = '160ms';
        ghost.style.opacity = '1';
        ghost.style.transform = 'translate(-50%,-50%) scale(1)';
        const hold = mine ? 240 : 620;
        setTimeout(() => {
          ghost.style.transitionDuration = '200ms';
          ghost.style.opacity = '0';
          ghost.style.transform = 'translate(-50%,-50%) scale(0.85) translateY(-24px)';
          setTimeout(() => ghost.remove(), 240);
        }, hold);
        await wait(hold + 160);
      }
      break;
    }
    case 'summon': {
      // insert a real unit element at the position with a materialize animation;
      // the authoritative re-render at batch end reconciles.
      const row = hooks.boardRow(ev.player);
      if (row && ev.unit) {
        if (!row.querySelector(`[data-unit-id="${ev.unit.id}"]`)) {
          const el = renderUnit({ ...ev.unit, canAttack: false, exhausted: false }, { enemy: ev.player !== you });
          el.classList.add('anim-summon');
          const units = [...row.querySelectorAll('.unit')];
          const before = typeof ev.position === 'number' ? units[ev.position] : null;
          row.insertBefore(el, before || null);
        }
      }
      await wait(400);
      break;
    }
    case 'attack': {
      const atk = hooks.resolveTarget(ev.attackerId);
      const tgt = hooks.resolveTarget(ev.targetId);
      if (atk) {
        const up = ev.attackerId.startsWith('u') && atk.closest('.board-row') === hooks.boardRow(you);
        pulseClass(atk, up ? 'anim-lunge-up' : 'anim-lunge-down', 400);
      }
      if (tgt) setTimeout(() => { pulseClass(tgt, 'anim-shake', 350); impactAt(tgt); }, 160);
      await wait(420);
      break;
    }
    case 'damage': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        pulseClass(tgt, 'anim-shake', 350);
        impactAt(tgt);
        floatNum(tgt, '−' + ev.amount, 'dmg');
        const integ = tgt.querySelector?.('.integrity');
        if (integ) pulseClass(integ, 'hurt', 450);
        // live-update visible stat chip so sequential events read correctly
        const hp = tgt.querySelector?.('.hp-chip');
        if (hp && /^-?\d+$/.test(hp.textContent)) {
          hp.textContent = String(Number(hp.textContent) - ev.amount);
          hp.classList.add('damaged');
        }
      }
      await wait(330);
      break;
    }
    case 'heal': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) floatNum(tgt, '+' + ev.amount, 'heal');
      await wait(300);
      break;
    }
    case 'shieldBreak': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        const { x, y } = centerOf(tgt);
        const s = document.createElement('div');
        s.className = 'shatter-fx';
        s.textContent = '⬡';
        s.style.left = x + 'px';
        s.style.top = y + 'px';
        fxLayer.appendChild(s);
        setTimeout(() => s.remove(), 600);
        tgt.classList.remove('has-shield');
      }
      await wait(380);
      break;
    }
    case 'death': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el && el.classList.contains('unit')) {
        el.classList.add('anim-death');
        await wait(480);
        el.remove();
      } else {
        await wait(150);
      }
      break;
    }
    case 'buff': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) {
        pulseClass(el, 'anim-buff', 560);
        floatNum(el, `+${ev.attack ?? 0}/+${ev.health ?? 0}`, 'buff');
        const atk = el.querySelector?.('.atk-chip');
        const hp = el.querySelector?.('.hp-chip');
        if (atk && typeof ev.attack === 'number' && /^-?\d+$/.test(atk.textContent)) atk.textContent = String(Number(atk.textContent) + ev.attack);
        if (hp && typeof ev.health === 'number' && /^-?\d+$/.test(hp.textContent)) hp.textContent = String(Number(hp.textContent) + ev.health);
      }
      await wait(420);
      break;
    }
    case 'keyword': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) pulseClass(el, 'anim-buff', 400);
      await wait(220);
      break;
    }
    case 'heroPower': {
      const hero = hooks.resolveTarget('hero' + ev.player);
      if (hero) pulseClass(hero, 'anim-buff', 450);
      await wait(320);
      break;
    }
    case 'returnToHand': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) {
        const owner = el.closest('.board-row') === hooks.boardRow(hooks.youIndex()) ? hooks.youIndex() : 1 - hooks.youIndex();
        const to = hooks.handAnchor(owner);
        const ghost = renderCardBack(64);
        fly(ghost, centerOf(el), centerOf(to || el), 380, { fade: true, scaleTo: 0.8 });
        el.style.opacity = '0.15';
      }
      await wait(360);
      break;
    }
    case 'transform': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) { pulseClass(el, 'anim-summon', 450); }
      await wait(320);
      break;
    }
    case 'silence': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) pulseClass(el, 'anim-shake', 350);
      await wait(260);
      break;
    }
    case 'gameOver': {
      // terminal handling is done by game.js from the gameOver message/view
      await wait(200);
      break;
    }
    default:
      await wait(120);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
