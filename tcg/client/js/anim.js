// anim.js — sequential event-animation queue + fx-layer helpers.
//
// The server sends {view, events, turnDeadline} after every accepted action.
// We queue each batch and play its events one at a time (~250–500 ms each) as
// visual flourishes over the CURRENT DOM, then hand the authoritative view to
// game.js for a full re-render. Events are never used to derive state — only
// to animate. New batches arriving mid-playback simply queue behind.

import { getCard } from './state.js';
import { renderCard, renderUnit, renderCardBack } from './components/card.js';
import * as audio from './audio.js';

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

// Tracks whose CEO power (if any) is the direct cause of the very next event —
// set when a heroPower event plays, consumed by the following damage/heal
// event so it can draw an energy arc from that CEO instead of a generic
// impact. Reset on every event so it never attaches to something unrelated.
let pendingPowerCaster = null;

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
  pendingPowerCaster = null;
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

/**
 * Decaying translate jitter on the table wrapper — never scroll/layout.
 * @param {'small'|'medium'|'heavy'} intensity  2px / 4px / 7px amplitude
 */
export function screenShake(intensity = 'small') {
  const table = hooks?.tableEl?.();
  if (!table) return;
  const spec = intensity === 'heavy' ? { amp: 7, dur: 450 }
    : intensity === 'medium' ? { amp: 4, dur: 380 }
    : { amp: 2, dur: 300 };
  table.style.setProperty('--shake-amp', spec.amp + 'px');
  table.style.setProperty('--shake-dur', spec.dur + 'ms');
  table.classList.remove('screen-shake');
  void table.offsetWidth; // restart cleanly if a shake is mid-flight
  table.classList.add('screen-shake');
  setTimeout(() => table.classList.remove('screen-shake'), spec.dur + 60);
}

/**
 * Hit-stop: freeze the fx layer's ongoing CSS animations for a beat (~60-90ms)
 * on heavy impacts to sell weight, then release.
 */
export function hitStop(ms = 75) {
  if (!fxLayer) return;
  fxLayer.classList.add('hit-stop');
  setTimeout(() => fxLayer.classList.remove('hit-stop'), ms);
}

/**
 * Floating combat number: spawns small, overshoot-pops, settles, then drifts
 * up along a slight random x-curve with a random tilt. opts.size adds
 * 'small'|'med'|'crit' styling; crits get a starburst behind them.
 */
export function floatNum(el, text, cls, opts = {}) {
  if (!el) return;
  const { x, y } = centerOf(el);
  if (opts.size === 'crit') {
    const b = document.createElement('div');
    b.className = 'crit-burst';
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    fxLayer.appendChild(b);
    setTimeout(() => b.remove(), 560);
  }
  const n = document.createElement('div');
  n.className = 'float-num ' + cls + (opts.size ? ' ' + opts.size : '');
  n.textContent = text;
  n.style.left = x + 'px';
  n.style.top = y + 'px';
  n.style.setProperty('--fx', (Math.random() * 36 - 18).toFixed(1) + 'px');
  n.style.setProperty('--frot', (Math.random() * 12 - 6).toFixed(1) + 'deg');
  fxLayer.appendChild(n);
  setTimeout(() => n.remove(), 1050);
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

/** Dust puff + double ground shockwave ring where a unit just materialized. */
function dustBurst(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const groundY = y + 34;
  for (let i = 0; i < 7; i++) {
    const p = document.createElement('div');
    p.className = 'dust-mote';
    const ang = Math.PI + Math.random() * Math.PI; // upward hemisphere
    const dist = 16 + Math.random() * 24;
    const size = 5 + Math.random() * 5; // 5-10px variance
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = x + (Math.random() * 26 - 13) + 'px';
    p.style.top = groundY + 'px';
    p.style.setProperty('--dx', (Math.cos(ang) * dist * 0.5) + 'px');
    p.style.setProperty('--dy', (Math.sin(ang) * dist - 16) + 'px');
    p.style.setProperty('--dr', ((Math.random() * 120 - 60) | 0) + 'deg');
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 640);
  }
  const ring = document.createElement('div');
  ring.className = 'summon-ring';
  ring.style.left = x + 'px';
  ring.style.top = groundY + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 480);
  const inner = document.createElement('div');
  inner.className = 'summon-ring inner';
  inner.style.left = x + 'px';
  inner.style.top = groundY + 'px';
  fxLayer.appendChild(inner);
  setTimeout(() => inner.remove(), 340);
}

/** Death: unit cracks into faction-tinted shards that fly out and fall, plus
 *  dark smoke motes drifting up. Fired just after the white-out flash. */
function deathBurst(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const fc = getComputedStyle(el).getPropertyValue('--fc').trim() || '#94a3b8';
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('div');
    s.className = 'death-shard';
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.setProperty('--fc', fc);
    s.style.width = (r.width * (0.26 + Math.random() * 0.14)) + 'px';
    s.style.height = (r.height * (0.22 + Math.random() * 0.14)) + 'px';
    s.style.setProperty('--dx', ((i - 1) * 36 + (Math.random() * 16 - 8)) + 'px');
    s.style.setProperty('--dy', (-(16 + Math.random() * 18)) + 'px');
    s.style.setProperty('--rr', ((Math.random() * 150 - 75) | 0) + 'deg');
    fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 620);
  }
  for (let i = 0; i < 4; i++) {
    const m = document.createElement('div');
    m.className = 'smoke-mote';
    const size = 8 + Math.random() * 8;
    m.style.width = size + 'px';
    m.style.height = size + 'px';
    m.style.left = (x + Math.random() * r.width * 0.6 - r.width * 0.3) + 'px';
    m.style.top = (y + Math.random() * 16 - 8) + 'px';
    m.style.setProperty('--dy', (-(26 + Math.random() * 22)) + 'px');
    m.style.setProperty('--dx', (Math.random() * 20 - 10) + 'px');
    m.style.animationDelay = (i * 45) + 'ms';
    fxLayer.appendChild(m);
    setTimeout(() => m.remove(), 900);
  }
}

/** Heal: soft radial bloom + 2-3 rising green plus-glyphs. */
function healBurst(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const bloom = document.createElement('div');
  bloom.className = 'heal-bloom';
  bloom.style.left = x + 'px';
  bloom.style.top = y + 'px';
  fxLayer.appendChild(bloom);
  setTimeout(() => bloom.remove(), 560);
  for (let i = 0; i < 3; i++) {
    const p = document.createElement('div');
    p.className = 'heal-plus';
    p.textContent = '+';
    p.style.left = (x + (i - 1) * 18 + (Math.random() * 10 - 5)) + 'px';
    p.style.top = (y + 12 + Math.random() * 10) + 'px';
    p.style.animationDelay = (i * 90) + 'ms';
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 900);
  }
}

/** Shield break: cyan-white flash ring + 6 hex shards spinning outward. */
function shieldShatter(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const ring = document.createElement('div');
  ring.className = 'shield-ring';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 460);
  for (let i = 0; i < 6; i++) {
    const s = document.createElement('div');
    s.className = 'hex-shard';
    const ang = (Math.PI * 2 * i) / 6 + (Math.random() * 0.5 - 0.25);
    const dist = 30 + Math.random() * 20;
    s.style.left = x + 'px';
    s.style.top = y + 'px';
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.setProperty('--rr', ((Math.random() * 260 - 130) | 0) + 'deg');
    fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 620);
  }
}

/** Buff: expanding green energy ring centered on the unit. */
function buffRing(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const ring = document.createElement('div');
  ring.className = 'buff-ring';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 560);
}

/** Hero power wind-up: ring contracting into the caster's portrait. */
function chargeRing(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const ring = document.createElement('div');
  ring.className = 'charge-ring';
  const fc = getComputedStyle(el).getPropertyValue('--fc').trim();
  if (fc) ring.style.setProperty('--fc', fc);
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 320);
}

/** Red vignette edge-flash across the whole table when a CEO takes damage. */
function heroHurtVignette() {
  const table = hooks?.tableEl?.();
  if (!table) return;
  const v = document.createElement('div');
  v.className = 'hero-hurt-vignette';
  table.appendChild(v);
  setTimeout(() => v.remove(), 360);
}

/** Small glowing shell lobbed from attacker to target (artillery-style arc trajectory). */
function fireShell(fromEl, toEl, duration = 260) {
  if (!fromEl || !toEl) return;
  const a = centerOf(fromEl), b = centerOf(toEl);
  const shell = document.createElement('div');
  shell.className = 'shell-projectile';
  shell.style.left = a.x + 'px';
  shell.style.top = a.y + 'px';
  fxLayer.appendChild(shell);
  void shell.offsetWidth;
  const midX = (a.x + b.x) / 2, midY = Math.min(a.y, b.y) - 44;
  const half = duration / 2;
  shell.style.transition = `left ${half}ms ease-out, top ${half}ms ease-out`;
  shell.style.left = midX + 'px';
  shell.style.top = midY + 'px';
  setTimeout(() => {
    shell.style.transition = `left ${half}ms ease-in, top ${half}ms ease-in`;
    shell.style.left = b.x + 'px';
    shell.style.top = b.y + 'px';
  }, half);
  setTimeout(() => shell.remove(), duration + 40);
}

/** Bigger artillery-style explosion: bright core flash + flying shrapnel +
 *  lingering smoke puffs that drift upward, for combat impacts. */
function explosionBurst(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const flash = document.createElement('div');
  flash.className = 'explosion-flash';
  flash.style.left = x + 'px';
  flash.style.top = y + 'px';
  fxLayer.appendChild(flash);
  setTimeout(() => flash.remove(), 420);
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.className = 'shrapnel';
    const ang = (Math.PI * 2 * i) / 8 + (Math.random() * 0.4 - 0.2);
    const dist = 34 + Math.random() * 28;
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 480);
  }
  for (let i = 0; i < 2; i++) {
    const s = document.createElement('div');
    s.className = 'smoke-puff';
    const size = 20 + Math.random() * 14;
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = (x + Math.random() * 24 - 12) + 'px';
    s.style.top = (y + Math.random() * 10 - 5) + 'px';
    s.style.setProperty('--dx', (Math.random() * 16 - 8) + 'px');
    s.style.animationDelay = (60 + i * 90) + 'ms';
    fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

/** Energy arc shot from a CEO portrait to the target of their power. */
function powerBeam(fromEl, toEl, color = '#7dd8ff', duration = 220) {
  if (!fromEl || !toEl) return;
  const a = centerOf(fromEl), b = centerOf(toEl);
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const beam = document.createElement('div');
  beam.className = 'power-beam';
  beam.style.left = a.x + 'px';
  beam.style.top = a.y + 'px';
  beam.style.width = dist + 'px';
  beam.style.setProperty('--beam-color', color);
  beam.style.transform = `rotate(${angle}deg) scaleX(0)`;
  fxLayer.appendChild(beam);
  void beam.offsetWidth;
  beam.style.transition = `transform ${duration}ms cubic-bezier(.2,.8,.3,1)`;
  beam.style.transform = `rotate(${angle}deg) scaleX(1)`;
  setTimeout(() => {
    beam.style.transition = 'opacity 160ms ease';
    beam.style.opacity = '0';
    setTimeout(() => beam.remove(), 180);
  }, duration);
  // bright head particle traveling the beam, bursting on arrival
  const head = document.createElement('div');
  head.className = 'beam-head';
  head.style.setProperty('--beam-color', color);
  head.style.left = a.x + 'px';
  head.style.top = a.y + 'px';
  fxLayer.appendChild(head);
  void head.offsetWidth;
  head.style.transition = `left ${duration}ms cubic-bezier(.5,0,1,.5), top ${duration}ms cubic-bezier(.5,0,1,.5)`;
  head.style.left = b.x + 'px';
  head.style.top = b.y + 'px';
  setTimeout(() => {
    head.remove();
    const burst = document.createElement('div');
    burst.className = 'beam-burst';
    burst.style.setProperty('--beam-color', color);
    burst.style.left = b.x + 'px';
    burst.style.top = b.y + 'px';
    fxLayer.appendChild(burst);
    setTimeout(() => burst.remove(), 380);
  }, duration);
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
  // Whoever's power (if any) immediately preceded THIS event — only
  // meaningful to the damage/heal case right below. Reset for every event
  // except when the event itself is the heroPower that arms it for the next one.
  const powerCaster = pendingPowerCaster;
  pendingPowerCaster = ev.e === 'heroPower' ? ev.player : null;
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
        // wrap so the flight path bows into a subtle arc (mid-keyframe lift
        // + a small rotation that settles) instead of a straight line
        ghost.classList.add('arc-inner');
        const wrap = document.createElement('div');
        wrap.appendChild(ghost);
        fly(wrap, centerOf(from), centerOf(to), 430, { scaleTo: ev.player === you ? 1.05 : 0.8, fade: ev.player !== you });
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
      setTimeout(() => f.remove(), 800);
      screenShake('small');
      const hero = hooks.resolveTarget('hero' + ev.player);
      floatNum(hero, 'FATIGUE −' + ev.amount, 'dmg', { size: 'med' });
      await wait(520);
      break;
    }
    case 'cardPlayed': {
      audio.playSfx('sfx-play');
      // Reveal the played card center-screen, then hand off to whatever it
      // causes (summon, damage, heal, buff, ...) — the very next events in
      // this same batch — while the card STAYS ON SCREEN. It only fades out
      // on its own timer afterwards, so the effect always visibly happens
      // while its cause is still visible, instead of the card vanishing
      // before you see what it did.
      const mine = ev.player === you;
      if (ev.cardId && getCard(ev.cardId)) {
        const ghost = renderCard(ev.cardId, { width: mine ? 130 : 185, interactive: false, showFlavor: false });
        ghost.classList.add('fly-card', 'card-reveal'); // premium reveal: bloom shadow + light sweep + faction aura
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
        // Non-blocking: fades/removes itself well after the queue has moved
        // on, so it lingers through the effect's own animation(s).
        const linger = mine ? 1100 : 1500;
        setTimeout(() => {
          ghost.style.transitionDuration = '220ms';
          ghost.style.opacity = '0';
          ghost.style.transform = 'translate(-50%,-50%) scale(0.85) translateY(-24px)';
          setTimeout(() => ghost.remove(), 260);
        }, linger);
        // Only block long enough for the reveal pop-in plus a short beat to
        // register the card before its effect starts playing.
        await wait(320);
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
          // legendary assets land with a one-time gold shimmer sweep
          if (el.classList.contains('rarity-legendary')) {
            el.classList.add('anim-legend-sweep');
            setTimeout(() => el.classList.remove('anim-legend-sweep'), 950);
          }
          // dust + shockwave at touchdown (~55% into the drop), so the burst
          // syncs with the squash frame instead of the spawn frame
          setTimeout(() => dustBurst(el), 210);
        }
      }
      await wait(430);
      break;
    }
    case 'attack': {
      audio.playSfx('sfx-attack');
      const atk = hooks.resolveTarget(ev.attackerId);
      const tgt = hooks.resolveTarget(ev.targetId);
      const heroHit = typeof ev.targetId === 'string' && ev.targetId.startsWith('hero');
      const up = atk
        ? ev.attackerId.startsWith('u') && atk.closest('.board-row') === hooks.boardRow(you)
        : false;
      if (atk) {
        // (a) anticipation: pull back away from the target with a slight tilt
        pulseClass(atk, up ? 'anim-windup-up' : 'anim-windup-down', 135);
      }
      await wait(115);
      if (atk) {
        // (b) strike: hard lunge with a motion streak trailing behind
        pulseClass(atk, up ? 'anim-lunge-up' : 'anim-lunge-down', 430);
        if (tgt) fireShell(atk, tgt, 180);
      }
      if (tgt) {
        // (c) impact + follow-through: white flash frame, knockback with
        // spring return, explosion + shake + hit-stop to sell the weight
        setTimeout(() => {
          pulseClass(tgt, 'anim-white-flash', 160);
          pulseClass(tgt, up ? 'anim-knock-up' : 'anim-knock-down', 430);
          explosionBurst(tgt);
          screenShake(heroHit ? 'medium' : 'small');
          hitStop(70);
        }, 160);
      }
      await wait(445);
      break;
    }
    case 'damage': {
      const heroTgt = typeof ev.targetId === 'string' && ev.targetId.startsWith('hero');
      if (heroTgt) audio.playSfx('sfx-ceo-damage');
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        pulseClass(tgt, 'anim-shake', 350);
        // A hero power's damage gets an energy arc from the acting CEO instead
        // of the generic impact flash, so it visually reads as an ability.
        const casterHero = powerCaster != null ? hooks.resolveTarget('hero' + powerCaster) : null;
        if (casterHero) {
          const color = getComputedStyle(casterHero).getPropertyValue('--fc').trim() || '#7dd8ff';
          powerBeam(casterHero, tgt, color || '#7dd8ff');
        } else {
          impactAt(tgt);
        }
        // number size scales with the hit: 1-2 small, 3-4 medium, 5+ crit
        const size = ev.amount >= 5 ? 'crit' : ev.amount >= 3 ? 'med' : 'small';
        floatNum(tgt, '−' + ev.amount, 'dmg', { size });
        if (heroTgt) {
          heroHurtVignette();
          screenShake('medium');
        }
        const integ = tgt.querySelector?.('.integrity');
        if (integ) pulseClass(integ, 'hurt', 450);
        // live-update visible stat chip so sequential events read correctly
        const hp = tgt.querySelector?.('.hp-chip');
        if (hp && /^-?\d+$/.test(hp.textContent)) {
          hp.textContent = String(Number(hp.textContent) - ev.amount);
          hp.classList.add('damaged');
        }
      }
      await wait(340);
      break;
    }
    case 'heal': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        healBurst(tgt);
        floatNum(tgt, '+' + ev.amount, 'heal', { size: ev.amount >= 4 ? 'med' : undefined });
      }
      await wait(320);
      break;
    }
    case 'shieldBreak': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        shieldShatter(tgt);
        tgt.classList.remove('has-shield');
      }
      await wait(380);
      break;
    }
    case 'death': {
      audio.playSfx('sfx-destroy');
      const el = hooks.resolveTarget(ev.unitId);
      if (el && el.classList.contains('unit')) {
        el.classList.add('anim-death'); // white-out flash, then crack + collapse
        setTimeout(() => deathBurst(el), 100); // shards fly right after the flash peak
        await wait(550);
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
        buffRing(el);
        floatNum(el, `+${ev.attack ?? 0}/+${ev.health ?? 0}`, 'buff');
        const atk = el.querySelector?.('.atk-chip');
        const hp = el.querySelector?.('.hp-chip');
        if (atk && typeof ev.attack === 'number' && /^-?\d+$/.test(atk.textContent)) atk.textContent = String(Number(atk.textContent) + ev.attack);
        if (hp && typeof ev.health === 'number' && /^-?\d+$/.test(hp.textContent)) hp.textContent = String(Number(hp.textContent) + ev.health);
        // stat chips overshoot-pop so the number change reads
        if (atk) pulseClass(atk, 'chip-pop', 460);
        if (hp) pulseClass(hp, 'chip-pop', 460);
      }
      await wait(420);
      break;
    }
    case 'keyword': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) {
        pulseClass(el, 'anim-kw-flash', 440);
        const badges = el.querySelector?.('.unit-kws');
        if (badges) pulseClass(badges, 'kw-pop', 440);
      }
      await wait(240);
      break;
    }
    case 'heroPower': {
      // cause precedes effect: the caster's portrait charges up (brightening
      // pulse + ring contracting inward) BEFORE the beam/effect that follows
      const hero = hooks.resolveTarget('hero' + ev.player);
      if (hero) {
        pulseClass(hero, 'anim-power-charge', 240);
        chargeRing(hero);
        await wait(200);
        pulseClass(hero, 'anim-buff', 450);
      }
      await wait(240);
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
      // terminal overlay is built by game.js right after this batch; a heavy
      // shake here lands as the VICTORY title slams in (defeat stays quiet)
      if (ev.winner === you) screenShake('heavy');
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
