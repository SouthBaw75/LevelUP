// anim.js — sequential event-animation queue + fx-layer helpers.
//
// The server sends {view, events, turnDeadline} after every accepted action.
// We queue each batch and play its events one at a time (~250–500 ms each) as
// visual flourishes over the CURRENT DOM, then hand the authoritative view to
// game.js for a full re-render. Events are never used to derive state — only
// to animate. New batches arriving mid-playback simply queue behind.

import { getCard } from './state.js';
import { renderCard, renderUnit, renderCardBack, renderContractTile } from './components/card.js';
import * as audio from './audio.js';

let hooks = null;
// hooks = {
//   resolveTarget(id) -> Element|null        ("uN" | "hero0" | "hero1")
//   boardRow(playerIndex) -> Element         (row container for that player's units)
//   contractZone(playerIndex) -> Element     (filed-contract stack for that player)
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
// Generation token: bumped by initAnim/stopAnim so any drain() loop or delayed
// fx callback started under an older generation can detect it is stale and
// bail instead of applying an old batch to new hooks or respawning fx onto a
// cleared #fx-layer (e.g. concede mid-batch → rematch).
let gen = 0;

// Tracks whose CEO power (if any) is the direct cause of the very next event —
// set when a heroPower event plays, consumed by the following damage/heal
// event so it can draw an energy arc from that CEO instead of a generic
// impact. Reset on every event so it never attaches to something unrelated.
let pendingPowerCaster = null;

export function initAnim(h) {
  gen++; // invalidate any in-flight drain/delayed fx from a previous game
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
  gen++; // stale-mark every pending drain step and delayed fx callback
  cancelled = true;
  playing = false;
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
  const g = gen; // this drain is only valid for the generation it started in
  playing = true;
  cancelled = false;
  while (queue.length && g === gen) {
    const batch = queue.shift();
    const events = Array.isArray(batch.events) ? batch.events : [];
    for (const ev of events) {
      if (cancelled || g !== gen) break;
      try { hooks.logEvent(ev); } catch (err) { console.error(err); }
      try { await playEvent(ev); } catch (err) { console.error('[anim]', ev.e, err); }
      if (g !== gen) break; // initAnim/stopAnim happened while we were awaiting
    }
    if (cancelled || g !== gen) break;
    hooks.applyView(batch);
    await wait(60); // let layout settle between batches
    if (g !== gen) break;
  }
  if (g !== gen) return; // stale drain: never touch state or call new-game hooks
  playing = false;
  hooks.onBatchDone?.();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** setTimeout that no-ops if initAnim/stopAnim ran before it fired — required
 *  for every delayed callback that appends to or mutates the fx layer / board. */
function fxTimeout(fn, ms) {
  const g = gen;
  setTimeout(() => { if (g === gen) fn(); }, ms);
}

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

function impactAt(el, amount = 3) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const f = document.createElement('div');
  f.className = 'impact-flash';
  // scale the flash with the hit: small pokes get a tight, still-full-opacity
  // flash (~60px) so even −1 lands with a visible beat
  const sz = amount <= 2 ? 60 : 90;
  f.style.width = sz + 'px';
  f.style.height = sz + 'px';
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
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.className = 'dust-mote';
    const ang = Math.PI + Math.random() * Math.PI; // upward hemisphere
    const dist = 26 + Math.random() * 34; // wider travel so it reads on the dark board
    const size = 7 + Math.random() * 7; // 7-14px variance
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = x + (Math.random() * 30 - 15) + 'px';
    p.style.top = groundY + 'px';
    p.style.setProperty('--dx', (Math.cos(ang) * dist * 0.6) + 'px');
    p.style.setProperty('--dy', (Math.sin(ang) * dist - 20) + 'px');
    p.style.setProperty('--dr', ((Math.random() * 120 - 60) | 0) + 'deg');
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 900);
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
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const ring = document.createElement('div');
  ring.className = 'shield-ring';
  // ring sized to the unit it protected (~1.2×), not a fixed 60px
  const sz = Math.max(r.width, r.height) * 1.2;
  ring.style.width = sz + 'px';
  ring.style.height = sz + 'px';
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

/** Debuff: red warning ring contracting inward onto the weakened unit. */
function debuffRing(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const ring = document.createElement('div');
  ring.className = 'debuff-ring';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 560);
}

/** Legendary touchdown: gold ring contracting onto the landed asset. */
function legendRing(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const ring = document.createElement('div');
  ring.className = 'charge-ring gold';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 400);
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
  // position once at launch; all motion is compositor-friendly transform
  shell.style.left = a.x + 'px';
  shell.style.top = a.y + 'px';
  shell.style.transform = 'translate(-50%,-50%)';
  fxLayer.appendChild(shell);
  void shell.offsetWidth;
  const midX = (a.x + b.x) / 2, midY = Math.min(a.y, b.y) - 44;
  const half = duration / 2;
  // phase 1: arc up to the midpoint
  shell.style.transition = `transform ${half}ms ease-out`;
  shell.style.transform = `translate(-50%,-50%) translate(${midX - a.x}px, ${midY - a.y}px)`;
  fxTimeout(() => {
    // phase 2: accelerate down onto the target
    shell.style.transition = `transform ${half}ms ease-in`;
    shell.style.transform = `translate(-50%,-50%) translate(${b.x - a.x}px, ${b.y - a.y}px)`;
  }, half);
  setTimeout(() => shell.remove(), duration + 40);
}

/** Bigger artillery-style explosion: bright core flash + an expanding
 *  shockwave ring + flying shrapnel + lingering smoke puffs, for combat
 *  impacts. Scaled up for a punchier, more satisfying hit. */
function explosionBurst(el) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const flash = document.createElement('div');
  flash.className = 'explosion-flash';
  flash.style.left = x + 'px';
  flash.style.top = y + 'px';
  fxLayer.appendChild(flash);
  setTimeout(() => flash.remove(), 480);
  const ring = document.createElement('div');
  ring.className = 'explosion-ring';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  fxLayer.appendChild(ring);
  setTimeout(() => ring.remove(), 460);
  for (let i = 0; i < 11; i++) {
    const p = document.createElement('div');
    p.className = 'shrapnel';
    const ang = (Math.PI * 2 * i) / 11 + (Math.random() * 0.4 - 0.2);
    const dist = 48 + Math.random() * 40;
    const size = 6 + Math.random() * 4;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    fxLayer.appendChild(p);
    setTimeout(() => p.remove(), 520);
  }
  for (let i = 0; i < 4; i++) {
    const s = document.createElement('div');
    s.className = 'smoke-puff';
    const size = 30 + Math.random() * 22;
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = (x + Math.random() * 40 - 20) + 'px';
    s.style.top = (y + Math.random() * 16 - 8) + 'px';
    s.style.setProperty('--dx', (Math.random() * 24 - 12) + 'px');
    s.style.animationDelay = (60 + i * 70) + 'ms';
    fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 950);
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
  // bright head particle traveling the beam, bursting on arrival — the travel
  // is transform-only (left/top set once at spawn)
  const head = document.createElement('div');
  head.className = 'beam-head';
  head.style.setProperty('--beam-color', color);
  head.style.left = a.x + 'px';
  head.style.top = a.y + 'px';
  head.style.transform = 'translate(-50%,-50%)';
  fxLayer.appendChild(head);
  void head.offsetWidth;
  head.style.transition = `transform ${duration}ms cubic-bezier(.5,0,1,.5)`;
  head.style.transform = `translate(-50%,-50%) translate(${b.x - a.x}px, ${b.y - a.y}px)`;
  fxTimeout(() => {
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

/** Folded-corner legal-document ghost that flies to the contract zone. */
function contractDocGhost() {
  const g = document.createElement('div');
  g.className = 'contract-doc-ghost';
  g.innerHTML = `<svg viewBox="0 0 40 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M3 2 h24 l10 10 v38 h-34 z" fill="#e8e0c6" stroke="#8a8266" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M27 2 v10 h10" fill="#cfc6a6" stroke="#8a8266" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M8 20 h24 M8 25 h24 M8 30 h24 M8 35 h16" stroke="#6b6450" stroke-width="1.6" stroke-opacity="0.75"/>
    <circle cx="30" cy="42" r="4.5" fill="none" stroke="#a3372f" stroke-width="1.6"/>
    <path d="M27 45.5 l-2 4 M33 45.5 l2 4" stroke="#a3372f" stroke-width="1.4"/>
  </svg>`;
  return g;
}

/** Severance-paperwork + payout ghost lobbed from a dying SEVERANCE unit to
 *  its OWNER's deck (foreshadowing the compensation draw that follows; §3d). */
function severanceDocGhost() {
  const g = document.createElement('div');
  g.className = 'severance-doc';
  g.innerHTML = `<svg viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 3 h16 l7 7 v27 h-23 z" fill="#e8e0c6" stroke="#8a8266" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M20 3 v7 h7" fill="#cfc6a6" stroke="#8a8266" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M8 16 h15 M8 20 h15 M8 24 h10" stroke="#6b6450" stroke-width="1.3" stroke-opacity="0.75"/>
    <circle cx="32" cy="30" r="9" fill="#e6c766" stroke="#7a5c1e" stroke-width="1.2"/>
    <text x="32" y="34" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11" font-weight="700" fill="#4a3a10">$</text>
  </svg>`;
  return g;
}

/** Nullified contract: the tile is cut into falling paper strips. */
function shredBurst(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div');
    s.className = 'paper-strip';
    s.style.left = (r.left + (i + 0.5) * (r.width / 5)) + 'px';
    s.style.top = (r.top + r.height / 2 + (Math.random() * 8 - 4)) + 'px';
    s.style.height = (r.height * (0.6 + Math.random() * 0.3)) + 'px';
    s.style.setProperty('--dx', (Math.random() * 24 - 12).toFixed(1) + 'px');
    s.style.setProperty('--dy', (26 + Math.random() * 26).toFixed(1) + 'px');
    s.style.setProperty('--rr', ((Math.random() * 90 - 45) | 0) + 'deg');
    s.style.animationDelay = (i * 22) + 'ms';
    fxLayer.appendChild(s);
    setTimeout(() => s.remove(), 700);
  }
}

function pulseClass(el, cls, ms) {
  if (!el) return;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** Fly an element (ghost) from rect A to rect B. left/top are set once at the
 *  origin; the flight itself is a pure transform transition (translate+scale). */
function fly(ghost, from, to, ms = 420, { fade = false, scaleTo = 1 } = {}) {
  ghost.classList.add('fly-card');
  ghost.style.left = from.x + 'px';
  ghost.style.top = from.y + 'px';
  ghost.style.transform = 'translate(-50%,-50%)';
  fxLayer.appendChild(ghost);
  // force layout so the transition runs
  void ghost.offsetWidth;
  ghost.style.transitionDuration = ms + 'ms';
  ghost.style.transform = `translate(-50%,-50%) translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${scaleTo})`;
  if (fade) ghost.style.opacity = '0';
  setTimeout(() => ghost.remove(), ms + 80);
}

/** FLIP removal: record sibling unit positions, remove the element, then
 *  invert-transform the siblings and transition them to identity so the row
 *  re-centers smoothly instead of teleporting. Generation-guarded. */
function flipRemove(el, g = gen) {
  const row = el.parentElement;
  if (!row) { el.remove(); return; }
  const sibs = [...row.querySelectorAll('.unit')].filter((u) => u !== el);
  const before = sibs.map((u) => u.getBoundingClientRect().left);
  el.remove();
  sibs.forEach((u, i) => {
    const dx = before[i] - u.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) return;
    u.style.transition = 'none';
    u.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => {
      if (g !== gen) { u.style.transition = ''; u.style.transform = ''; return; }
      requestAnimationFrame(() => {
        if (g !== gen) { u.style.transition = ''; u.style.transform = ''; return; }
        u.style.transition = 'transform 200ms cubic-bezier(0, 0, 0.2, 1)';
        u.style.transform = 'translateX(0)';
        setTimeout(() => {
          u.style.transition = '';
          u.style.transform = '';
        }, 240);
      });
    });
  });
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
  // Generation this event started under. Any code that runs after an internal
  // `await` must re-check (g0 === gen) before touching the DOM or scheduling
  // fx — stopAnim/initAnim may have reset the game while we were waiting.
  const g0 = gen;
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
      // mini-banner so an empty deck reads as the systemic event it is
      showBanner('FATIGUE', 'DECK EMPTY −' + ev.amount, 'fatigue');
      // pulse the empty deck pill (carries .fatigue-warn once deckCount hits 0)
      const pill = hooks.deckAnchor(ev.player);
      if (pill) pulseClass(pill, 'fatigue-pulse', 900);
      const hero = hooks.resolveTarget('hero' + ev.player);
      floatNum(hero, 'FATIGUE −' + ev.amount, 'dmg', { size: 'med' });
      await wait(640);
      break;
    }
    case 'capitalRaid': {
      // RAID: the raider survived combat and banked a 1-capital hit against
      // the victim's next turn — flash the victim's hero + pip row now, since
      // the actual deduction won't show until their next startTurn.
      const hero = hooks.resolveTarget('hero' + ev.targetPlayer);
      if (hero) { pulseClass(hero, 'anim-shake', 350); floatNum(hero, 'CAPITAL RAIDED −1', 'dmg', { size: 'med' }); }
      const capRow = hooks.capitalAnchor?.(ev.targetPlayer);
      if (capRow) pulseClass(capRow, 'anim-shake', 350);
      await wait(420);
      break;
    }
    case 'bigHit': {
      // A single game-turn just did BIG_HIT_THRESHOLD+ damage to this hero —
      // let the attacker's CEO gloat. Fire-and-forget like other one-shot sfx;
      // the taunt shouldn't block the animation queue while it plays out.
      audio.playCeoTaunt(hooks.factionOf(ev.attackerPlayer));
      const hero = hooks.resolveTarget('hero' + ev.targetPlayer);
      if (hero) floatNum(hero, 'BIG HIT!', 'dmg', { size: 'med' });
      await wait(60);
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
        // After the reveal beat, slide the ghost aside to the lower-left of
        // the table (transform-only) so it never occludes summons/impacts at
        // board center while it lingers.
        const tr = hooks.tableEl()?.getBoundingClientRect();
        const px = tr ? (tr.left + 120) - cx : -Math.round(innerWidth * 0.32);
        const py = tr ? (tr.bottom - 245) - cy : Math.round(innerHeight * 0.22);
        fxTimeout(() => {
          ghost.style.transitionDuration = '420ms';
          ghost.style.transform = `translate(-50%,-50%) translate(${px}px, ${py}px) scale(0.8) rotate(-5deg)`;
        }, 340);
        // Non-blocking: fades/removes itself well after the queue has moved
        // on, so it lingers through the effect's own animation(s).
        const linger = mine ? 1100 : 1500;
        fxTimeout(() => {
          ghost.style.transitionDuration = '220ms';
          ghost.style.opacity = '0';
          ghost.style.transform = `translate(-50%,-50%) translate(${px}px, ${py - 22}px) scale(0.72) rotate(-5deg)`;
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
          // legendary assets land with a one-time gold shimmer sweep, plus a
          // contracting gold charge-ring + small shake on touchdown
          if (el.classList.contains('rarity-legendary')) {
            el.classList.add('anim-legend-sweep');
            setTimeout(() => el.classList.remove('anim-legend-sweep'), 950);
            fxTimeout(() => {
              legendRing(el);
              screenShake('small');
            }, 230);
          }
          // dust + shockwave at touchdown (~48% into the drop), so the burst
          // syncs with the squash frame instead of the spawn frame
          fxTimeout(() => dustBurst(el), 230);
        }
      }
      await wait(460);
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
      if (g0 !== gen) break; // reset while winding up: no strike/impact fx
      if (atk) {
        // target-relative lunge: drive the strike keyframes with the actual
        // vector to the target (~60% of the distance, capped for readability)
        // so cross-board / hero attacks connect instead of tapping air
        if (tgt) {
          const a = centerOf(atk), b = centerOf(tgt);
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 1;
          const mag = Math.min(dist * 0.6, 120);
          dx = (dx / dist) * mag;
          dy = (dy / dist) * mag;
          atk.style.setProperty('--lx', dx.toFixed(1) + 'px');
          atk.style.setProperty('--ly', dy.toFixed(1) + 'px');
        } else {
          atk.style.removeProperty('--lx');
          atk.style.removeProperty('--ly');
        }
        // (b) strike: hard lunge with a motion streak trailing behind
        pulseClass(atk, up ? 'anim-lunge-up' : 'anim-lunge-down', 430);
        if (tgt) fireShell(atk, tgt, 180);
      }
      if (tgt) {
        // (c) impact + follow-through: white flash frame, knockback with
        // spring return, explosion + shake + hit-stop to sell the weight
        // (generation-guarded: must never respawn fx after stopAnim/initAnim)
        fxTimeout(() => {
          pulseClass(tgt, 'anim-white-flash', 160);
          pulseClass(tgt, up ? 'anim-knock-up' : 'anim-knock-down', 430);
          explosionBurst(tgt);
          screenShake(heroHit ? 'heavy' : 'medium');
          hitStop(90);
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
          impactAt(tgt, ev.amount);
        }
        // brief brightness dip on the struck frame so even −1 has a beat
        pulseClass(tgt, 'anim-hit-dip', 150);
        // number size scales with the hit: 1-2 small, 3-4 medium, 5+ crit
        const size = ev.amount >= 5 ? 'crit' : ev.amount >= 3 ? 'med' : 'small';
        floatNum(tgt, '−' + ev.amount, 'dmg', { size });
        if (heroTgt) {
          heroHurtVignette();
          screenShake('medium');
        }
        // live-update visible stat chips so sequential events read correctly
        // (clamped at 0 — chips must never display negative values; the
        // death/gameOver that follows resolves them)
        const integ = tgt.querySelector?.('.integrity');
        if (integ) {
          pulseClass(integ, 'hurt', 450);
          if (/^\d+$/.test(integ.textContent)) {
            integ.textContent = String(Math.max(0, Number(integ.textContent) - ev.amount));
          }
        }
        const hp = tgt.querySelector?.('.hp-chip');
        if (hp && /^-?\d+$/.test(hp.textContent)) {
          hp.textContent = String(Math.max(0, Number(hp.textContent) - ev.amount));
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
        // live-increment the visible chip (unit hp / hero integrity) so a heal
        // mid-batch reads immediately, mirroring the damage path
        const hp = tgt.querySelector?.('.hp-chip');
        if (hp && /^-?\d+$/.test(hp.textContent)) {
          hp.textContent = String(Number(hp.textContent) + ev.amount);
          pulseClass(hp, 'chip-pop', 460);
        }
        const integ = tgt.querySelector?.('.integrity');
        if (integ && /^\d+$/.test(integ.textContent)) {
          integ.textContent = String(Number(integ.textContent) + ev.amount);
          pulseClass(integ, 'chip-pop', 460);
        }
      }
      await wait(320);
      break;
    }
    case 'shieldBreak': {
      const tgt = hooks.resolveTarget(ev.targetId);
      if (tgt) {
        shieldShatter(tgt);
        // brief white flash on the frame so the pop registers on the unit too
        pulseClass(tgt, 'anim-white-flash', 170);
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
        fxTimeout(() => deathBurst(el), 100); // shards fly right after the flash peak
        await wait(550);
        if (g0 !== gen) break; // game reset while we were mid-death
        flipRemove(el, g0); // FLIP: neighbors glide into the gap instead of snapping
      } else {
        await wait(150);
      }
      break;
    }
    case 'buff': {
      const el = hooks.resolveTarget(ev.unitId);
      if (el) {
        // deltas may be negative (debuffs like Depreciation −2/−2): debuffs
        // get a shake + red contracting ring, buffs the green pulse + ring
        const neg = (ev.attack ?? 0) < 0 || (ev.health ?? 0) < 0;
        if (neg) {
          pulseClass(el, 'anim-shake', 350);
          debuffRing(el);
        } else {
          pulseClass(el, 'anim-buff', 560);
          buffRing(el);
        }
        // format signs properly and clamp the live chips at 0 like the engine
        const sgn = (n) => (n >= 0 ? '+' + n : '−' + Math.abs(n));
        floatNum(el, `${sgn(ev.attack ?? 0)}/${sgn(ev.health ?? 0)}`, neg ? 'dmg' : 'buff');
        const atk = el.querySelector?.('.atk-chip');
        const hp = el.querySelector?.('.hp-chip');
        if (atk && typeof ev.attack === 'number' && /^-?\d+$/.test(atk.textContent)) atk.textContent = String(Math.max(0, Number(atk.textContent) + ev.attack));
        if (hp && typeof ev.health === 'number' && /^-?\d+$/.test(hp.textContent)) hp.textContent = String(Math.max(0, Number(hp.textContent) + ev.health));
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
        if (g0 !== gen) break;
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
    case 'distract': {
      // Flirty Intern: a soft rose "charm" pulse when applied (turns === 3);
      // the per-turn ticks just update the countdown pip via the re-render.
      const el = hooks.resolveTarget(ev.unitId);
      const applied = ev.turns >= 3;
      if (el && applied) {
        pulseClass(el, 'distract-pop', 620);
        floatNum(el, '\u{1F48B}', 'distract-mark', { size: 'med' });
      }
      await wait(applied ? 300 : 40);
      break;
    }
    case 'layoff': {
      // §3c: always followed by heal (owner's hero) then death in the same
      // batch — this beat only sells the "pink slip" moment; the heal event
      // renders the +N float / chip update and the death event removes the
      // unit with FLIP.
      audio.playSfx('sfx-layoff', 'sfx-play'); // optional drop-in; falls back
      const el = hooks.resolveTarget(ev.unitId);
      if (el) {
        const { x, y } = centerOf(el);
        // pink slip slapped over the unit — rotate-in slam like the void stamp
        const slip = document.createElement('div');
        slip.className = 'pink-slip';
        slip.textContent = 'PINK SLIP';
        slip.style.left = x + 'px';
        slip.style.top = y + 'px';
        fxLayer.appendChild(slip);
        setTimeout(() => slip.remove(), 780);
        // brief desaturating dip on the frame while the slip lands
        pulseClass(el, 'anim-layoff-dip', 420);
        // pale wisp drifting from the unit to the OWNER's hero plate,
        // foreshadowing the heal that follows. Launches on the slam beat;
        // outlives the blocking window → non-blocking + generation-guarded.
        const hero = hooks.resolveTarget('hero' + ev.player);
        if (hero) {
          fxTimeout(() => {
            const wisp = document.createElement('div');
            wisp.className = 'layoff-wisp';
            wisp.style.left = x + 'px';
            wisp.style.top = y + 'px';
            wisp.style.transform = 'translate(-50%,-50%)';
            fxLayer.appendChild(wisp);
            void wisp.offsetWidth;
            const h = centerOf(hero);
            // flight is a pure transform transition (left/top set once at spawn)
            wisp.style.transition = 'transform 420ms cubic-bezier(0.3, 0.8, 0.4, 1), opacity 420ms ease-in';
            wisp.style.transform = `translate(-50%,-50%) translate(${h.x - x}px, ${h.y - y}px) scale(0.55)`;
            wisp.style.opacity = '0.15';
            setTimeout(() => wisp.remove(), 480);
          }, 220);
        }
      }
      await wait(420);
      break;
    }
    case 'severance': {
      // §3d: real severance — compensation TO the owner, not a suit against
      // the enemy. A paperwork+payout ghost arcs from the dying unit's board
      // position to the OWNER's own deck, landing with a gold "PAID" stamp
      // that foreshadows the `draw` event which IMMEDIATELY FOLLOWS in this
      // same batch (that event owns the actual card-to-hand flight). This
      // beat renders no card/number of its own — only the arc plus a soft
      // gold pulse on the deck pill.
      audio.playSfx('sfx-severance', 'sfx-play'); // optional drop-in; falls back
      const SEV_GOLD = '#e6c766'; // payout gold — distinct from cyan CEO-power beams
      const deckPill = hooks.deckAnchor(ev.player); // owner's own deck
      // The dying unit may already be mid death-removal (or gone) from the DOM.
      // Fall back to the owner's board-row center; if that too is missing, skip
      // the origin entirely and just pulse the deck pill.
      const originEl = hooks.resolveTarget(ev.unitId);
      const originRow = hooks.boardRow?.(ev.player);
      const from = originEl ? centerOf(originEl)
        : (originRow ? centerOf(originRow) : null);
      if (deckPill) {
        const to = centerOf(deckPill);
        if (from) {
          // paperwork ghost arcs origin → owner's deck (two-phase transform
          // arc; left/top set once at spawn, all motion is transform-only)
          const doc = severanceDocGhost();
          doc.style.left = from.x + 'px';
          doc.style.top = from.y + 'px';
          doc.style.transform = 'translate(-50%,-50%) rotate(-10deg) scale(0.7)';
          fxLayer.appendChild(doc);
          void doc.offsetWidth;
          const midX = (from.x + to.x) / 2, midY = Math.min(from.y, to.y) - 54;
          doc.style.transition = 'transform 200ms ease-out';
          doc.style.transform = `translate(-50%,-50%) translate(${midX - from.x}px, ${midY - from.y}px) rotate(6deg) scale(1)`;
          fxTimeout(() => {
            doc.style.transition = 'transform 200ms ease-in';
            doc.style.transform = `translate(-50%,-50%) translate(${to.x - from.x}px, ${to.y - from.y}px) rotate(16deg) scale(0.82)`;
          }, 200);
          setTimeout(() => doc.remove(), 460);
          // payout-gold energy line reinforcing the path — reuses the CEO-power
          // beam primitive (beam A→B with a color). Only when the dying unit is
          // still in the DOM (powerBeam needs both endpoints).
          if (originEl) powerBeam(originEl, deckPill, SEV_GOLD, 240);
        }
        // arrival at the deck as the payout lands (~on the draw beat): a gold
        // "PAID" stamp + a soft pulse on the deck pill. NO card/number here —
        // the following `draw` event renders the actual card flying to hand.
        fxTimeout(() => {
          const stamp = document.createElement('div');
          stamp.className = 'severance-verdict';
          stamp.textContent = 'PAID';
          stamp.style.left = to.x + 'px';
          stamp.style.top = to.y + 'px';
          fxLayer.appendChild(stamp);
          setTimeout(() => stamp.remove(), 640);
          pulseClass(deckPill, 'severance-pulse', 500); // gold payout glow (fatigue-pulse is red — wrong tone here)
        }, from ? 380 : 40);
      }
      await wait(from ? 430 : 200);
      break;
    }
    case 'contractFiled': {
      // Follows cardPlayed in the same batch (which already played sfx-play):
      // a document ghost detaches from the reveal position, flies to the
      // owner's zone slot, lands with a squash + gold "EXECUTED" stamp ring,
      // and the tile pops in. Authoritative re-render reconciles at batch end.
      audio.playSfx('sfx-contract-filed'); // optional drop-in; silent if absent
      const zone = hooks.contractZone?.(ev.player);
      const c = ev.contract || {};
      let tile = null;
      if (zone && c.id && !zone.querySelector(`[data-target-id="${c.id}"]`)) {
        tile = renderContractTile(c);
        tile.classList.add('contract-pre'); // laid out (so we can aim) but invisible
        zone.appendChild(tile);
      }
      const dest = tile ? centerOf(tile) : (zone ? centerOf(zone) : null);
      if (dest) {
        // origin = the cardPlayed reveal position (same coords as its ghost)
        const from = { x: innerWidth / 2 - 100, y: innerHeight / 2 - 40 };
        fly(contractDocGhost(), from, dest, 290, { scaleTo: 0.5 });
        fxTimeout(() => {
          if (tile) {
            tile.classList.remove('contract-pre');
            tile.classList.add('contract-pop'); // squash-in + brightness stamp beat
            setTimeout(() => tile.classList.remove('contract-pop'), 500);
          }
          const ring = document.createElement('div');
          ring.className = 'stamp-ring';
          ring.style.left = dest.x + 'px';
          ring.style.top = dest.y + 'px';
          fxLayer.appendChild(ring);
          setTimeout(() => ring.remove(), 520);
        }, 280);
      } else if (tile) {
        tile.classList.remove('contract-pre');
      }
      await wait(500);
      break;
    }
    case 'contractVoided': {
      const tile = hooks.resolveTarget(ev.contractId);
      const expired = ev.reason === 'expired';
      audio.playSfx(expired ? 'sfx-contract-expire' : 'sfx-contract-void',
        expired ? undefined : 'sfx-destroy');
      if (tile) {
        const { x, y } = centerOf(tile);
        const stamp = document.createElement('div');
        stamp.className = 'void-stamp ' + (expired ? 'expired' : 'nullified');
        stamp.textContent = expired ? 'EXPIRED' : 'NULL & VOID';
        stamp.style.left = x + 'px';
        stamp.style.top = y + 'px';
        fxLayer.appendChild(stamp);
        setTimeout(() => stamp.remove(), expired ? 950 : 850);
        if (expired) {
          // quiet: gray stamp fades in, the tile grays out and dissolves
          tile.classList.add('contract-expire');
          await wait(600);
        } else {
          // the red stamp slams in first; the shred lands on the impact beat
          fxTimeout(() => {
            if (!tile.isConnected) return;
            screenShake('small');
            hitStop(60);
            tile.classList.add('contract-shred');
            shredBurst(tile);
          }, 190);
          await wait(620);
        }
        if (g0 !== gen) break; // reset mid-void: leave the DOM to the new game
        tile.remove(); // stack collapses; authoritative re-render reconciles
      } else {
        await wait(200);
      }
      break;
    }
    case 'gameOver': {
      // terminal overlay is built by game.js right after this batch; a heavy
      // shake here lands as the VICTORY title slams in (defeat stays quiet).
      // The winning CEO's taunt is fired by game.js showGameOver (fires on
      // every end path, in sync with the overlay), not here.
      if (ev.winner === you) screenShake('heavy');
      await wait(200);
      break;
    }
    case 'bankCapital': {
      // War Chest (§reserve): capital socked away at end of turn. Owner-only
      // event (redacted for the opponent), so this only ever plays on your own
      // tile — a subtle gold vault pulse + a small "+N BANKED" float. Quick.
      const tile = hooks.resolveTarget(ev.contractId);
      if (tile) {
        pulseClass(tile, 'anim-bank-pulse', 520);
        floatNum(tile, '+' + ev.amount + ' BANKED', 'gold');
      }
      await wait(200);
      break;
    }
    case 'reserveActivated': {
      // War Chest cracked open (public): a more emphatic gold burst on the tile
      // plus a pulse of the owner's capital pip row — the reserve tops up
      // ASSET-only capital right now, so it reads as a big moment.
      audio.playSfx('sfx-play');
      const tile = hooks.resolveTarget(ev.contractId);
      if (tile) pulseClass(tile, 'anim-warchest-crack', 560);
      const capRow = hooks.capitalAnchor?.(ev.player);
      if (capRow) pulseClass(capRow, 'anim-reserve-pop', 560);
      const anchor = tile || capRow;
      if (anchor) floatNum(anchor, 'WAR CHEST +' + ev.amount, 'gold', { size: 'med' });
      await wait(260);
      break;
    }
    default:
      await wait(120);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
