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

// Attachment cards (Flirty Intern) whose cardPlayed reveal is HANDED OFF to the
// following effect event, which flies the same revealed card onto its target
// and tucks it under (instead of the normal reveal-then-slide-aside). The board
// re-render then shows the persistent tuck (see components/card.js).
const ATTACHMENT_CARD_IDS = new Set(['ntr_037']); // Flirty Intern
let pendingAttachGhost = null;
// True while animating a batch that also ends the game — the bigHit case uses
// it to SKIP its CEO taunt so it doesn't collide with the victory taunt that
// showGameOver plays a beat later (a lethal 10+ hit would otherwise fire both).
let batchHasGameOver = false;
function clearAttachGhost() {
  if (pendingAttachGhost) { pendingAttachGhost.remove(); pendingAttachGhost = null; }
}

export function initAnim(h) {
  gen++; // invalidate any in-flight drain/delayed fx from a previous game
  hooks = h;
  if (!fxLayer) {
    fxLayer = document.createElement('div');
    fxLayer.id = 'fx-layer';
    document.body.appendChild(fxLayer);
  }
  fxLayer.innerHTML = '';
  ensureFxCanvas();
  resetFx(); // clear any lingering explosion particles from a previous game
  queue.length = 0;
  playing = false;
  cancelled = false;
  pendingPowerCaster = null;
  clearAttachGhost();
}

export function stopAnim() {
  gen++; // stale-mark every pending drain step and delayed fx callback
  cancelled = true;
  playing = false;
  queue.length = 0;
  pendingAttachGhost = null; // fxLayer wipe below removes the node
  if (fxLayer) fxLayer.innerHTML = '';
  resetFx(); // wipe any in-flight explosion particles from the canvas
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
    batchHasGameOver = events.some((e) => e && e.e === 'gameOver');
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

/** Spell/ability damage: canvas energy-strike burst (see spawnEnergyStrike
 *  below), scaled by the damage amount and colored by the struck unit/hero's
 *  own faction so even a −1 poke reads as a real hit instead of a flat flash. */
function impactAt(el, amount = 3) {
  if (!el) return;
  const { x, y } = centerOf(el);
  const fc = getComputedStyle(el).getPropertyValue('--fc').trim() || '#94a3b8';
  spawnEnergyStrike(x, y, amount, cssToRgb(fc));
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

// ===================== canvas detonation system (unit death) =====================
// A single viewport-covering <canvas> renders the death explosion: concussion
// flash + shockwave, a churning additive fireball, realistic GRAY smoke that
// expands and cools as it rises, glowing embers with trails, and tumbling card
// debris. Each faction drives the blast's energy color (fire/flash/embers/ring)
// while the smoke stays realistically neutral. Ported from the approved FX demo,
// scaled to board-unit size and tuned a touch shorter for in-play readability.
//
// The canvas runs its OWN rAF loop that sleeps when idle, so smoke lingers
// naturally after the death event's 550ms timeline has already moved on — the
// two are decoupled. Cleared on initAnim/stopAnim like the DOM fx layer.
let fxCanvas = null, fxCtx = null, fxRunning = false, fxLast = 0;
const fxPools = { smoke: [], fire: [], debris: [], embers: [], shocks: [], flashes: [], glints: [] };
const TAU = Math.PI * 2;
const rf = (a = 1, b = 0) => b + Math.random() * (a - b);

// --- css color → [r,g,b] (handles hex / rgb() / color-mix output) ---
const _rgbProbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
const _rgbCache = new Map();
function cssToRgb(str) {
  const key = str || '#94a3b8';
  let v = _rgbCache.get(key);
  if (v) return v;
  _rgbProbe.fillStyle = '#94a3b8';
  _rgbProbe.fillStyle = key; // invalid strings silently keep the fallback
  _rgbProbe.fillRect(0, 0, 1, 1);
  const d = _rgbProbe.getImageData(0, 0, 1, 1).data;
  v = [d[0], d[1], d[2]];
  _rgbCache.set(key, v);
  return v;
}

// --- sprite factories (offscreen canvases, drawn many times per frame) ---
function makePuff(rgb, seed) {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); let s = seed * 1000;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const lobes = 4 + ((seed * 3) | 0) % 3;
  for (let i = 0; i < lobes; i++) {
    const lx = S / 2 + (rand() - 0.5) * S * 0.34, ly = S / 2 + (rand() - 0.5) * S * 0.34;
    const lr = S * (0.24 + rand() * 0.2);
    const gr = g.createRadialGradient(lx, ly, 0, lx, ly, lr);
    gr.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.9)`);
    gr.addColorStop(0.55, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.32)`);
    gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(lx, ly, lr, 0, TAU); g.fill();
  }
  return c;
}
function makeFire(rgb) {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,0.95)');
  gr.addColorStop(0.28, `rgba(${Math.min(255, rgb[0] + 120)},${Math.min(255, rgb[1] + 90)},${Math.min(255, rgb[2] + 70)},0.8)`);
  gr.addColorStop(0.6, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.32)`);
  gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return c;
}
function makeDot(rgb) {
  const S = 32, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, `rgba(${Math.min(255, rgb[0] + 80)},${Math.min(255, rgb[1] + 60)},${Math.min(255, rgb[2] + 40)},0.9)`);
  gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return c;
}
// Smoke sprites are faction-INDEPENDENT (realistic gray, cooling ramp) → built
// once. Fire/ember sprites carry the energy color → cached per color.
let SMOKE_SPR = null;
function smokeSprites() {
  if (!SMOKE_SPR) {
    const ramp = [[150, 140, 128], [96, 90, 84], [66, 66, 72], [44, 45, 52], [28, 30, 37], [17, 19, 25]];
    SMOKE_SPR = ramp.map((rgb, i) => [0, 1, 2].map((v) => makePuff(rgb, i * 7 + v + 1)));
  }
  return SMOKE_SPR;
}
const _fireCache = new Map(), _dotCache = new Map();
const fireFor = (rgb) => { const k = rgb.join(','); let s = _fireCache.get(k); if (!s) { s = makeFire(rgb); _fireCache.set(k, s); } return s; };
const dotFor = (rgb) => { const k = rgb.join(','); let s = _dotCache.get(k); if (!s) { s = makeDot(rgb); _dotCache.set(k, s); } return s; };

// --- additional sprites/helpers for the attack-projectile archetypes ---
const mix = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
function makeCore(rgb) {
  // elongated white-hot comet/tracer head, points +x
  const W = 64, H = 32, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(W * 0.62, H / 2, 0, W * 0.62, H / 2, W * 0.42);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, `rgba(${Math.min(255, rgb[0] + 100)},${Math.min(255, rgb[1] + 80)},${Math.min(255, rgb[2] + 60)},0.95)`);
  gr.addColorStop(0.7, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`);
  gr.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.save(); g.translate(W / 2, H / 2); g.scale(1, 0.55); g.translate(-W / 2, -H / 2);
  g.fillStyle = gr; g.fillRect(0, 0, W, H); g.restore();
  return c;
}
function makeGlint(rgb) {
  // anamorphic lens-flare star: dominant horizontal ray, shorter vertical,
  // minor diagonals, hot center — the "expensive light" read on bright cores
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const hot = 'rgba(255,255,255,0.95)';
  const tint = `rgba(${Math.min(255, rgb[0] + 70)},${Math.min(255, rgb[1] + 55)},${Math.min(255, rgb[2] + 45)},0.5)`;
  const ray = (ang, len, w, alpha) => {
    g.save(); g.translate(S / 2, S / 2); g.rotate(ang); g.globalAlpha = alpha;
    const gr = g.createLinearGradient(-len, 0, len, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.28, tint);
    gr.addColorStop(0.5, hot); gr.addColorStop(0.72, tint); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-len, -w / 2, len * 2, w);
    g.restore();
  };
  ray(0, S * 0.5, 3, 0.95); ray(0, S * 0.5, 9, 0.3);
  ray(Math.PI / 2, S * 0.28, 2.5, 0.85); ray(Math.PI / 2, S * 0.28, 7, 0.25);
  ray(Math.PI / 4, S * 0.14, 2, 0.5); ray(-Math.PI / 4, S * 0.14, 2, 0.5);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, 10);
  gr.addColorStop(0, hot); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(S / 2, S / 2, 10, 0, TAU); g.fill();
  return c;
}
const _coreCache = new Map(), _glintCache = new Map(), _puffCache = new Map();
const coreFor = (rgb) => { const k = rgb.join(','); let s = _coreCache.get(k); if (!s) { s = makeCore(rgb); _coreCache.set(k, s); } return s; };
const glintFor = (rgb) => { const k = rgb.join(','); let s = _glintCache.get(k); if (!s) { s = makeGlint(rgb); _glintCache.set(k, s); } return s; };
const puffFor = (rgb) => { const k = rgb.join(','); let s = _puffCache.get(k); if (!s) { s = makePuff(rgb, 4); _puffCache.set(k, s); } return s; };
const bezier = (t, a, c, b) => { const mt = 1 - t; return { x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y }; };
const bezierDir = (t, a, c, b) => { const mt = 1 - t; return { x: 2 * mt * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * mt * (c.y - a.y) + 2 * t * (b.y - c.y) }; };

// Custom per-frame projectile logic (beams, shells, globs, rakes). Each entry:
// { update(dt, now)->bool alive, drawUnder?(ctx, now), draw?(ctx, now) }.
// drawUnder runs in the source-over pass, draw in the additive pass.
const fxUpdaters = [];

// immediate-mode helpers — call only from an updater's draw() (additive pass)
function lightCast(x, y, radius, rgb, alpha) {
  fxCtx.globalAlpha = alpha;
  fxCtx.drawImage(fireFor(rgb), x - radius, y - radius, radius * 2, radius * 2);
}
function glintDraw(x, y, size, rgb, alpha) {
  fxCtx.globalAlpha = alpha;
  fxCtx.drawImage(glintFor(rgb), x - size, y - size, size * 2, size * 2);
}
/** Launch pop at the attacker's edge: flash + glint + smoke pushed forward. */
function muzzle(x, y, rgb, dir, scale = 1) {
  const P = fxPools;
  P.flashes.push({ x, y, r: 3 * scale, max: 20 * scale, life: 0, dur: 0.09, rgb });
  P.glints.push({ x, y, s: 20 * scale, life: 0, dur: 0.18, rgb, rot: 0 });
  for (let i = 0; i < 4; i++) {
    P.smoke.push({ x: x + rf(4, -4), y: y + rf(4, -4),
      vx: dir.x * rf(55, 18) + rf(14, -14), vy: dir.y * rf(55, 18) - rf(18, 4),
      size: rf(7, 4) * scale, grow: rf(14, 8), life: 0, dur: rf(0.5, 0.3),
      rot: rf(TAU), vr: rf(0.7, -0.7), seed: (Math.random() * 3) | 0 });
  }
}

function ensureFxCanvas() {
  if (fxCanvas) return;
  fxCanvas = document.createElement('canvas');
  fxCanvas.id = 'fx-canvas';
  // just under #fx-layer (z 150) so DOM floats (damage numbers) stay readable
  // over the smoke; above the board so the blast reads as being in front.
  fxCanvas.style.cssText = 'position:fixed;inset:0;z-index:148;pointer-events:none;';
  document.body.appendChild(fxCanvas);
  fxCtx = fxCanvas.getContext('2d');
  sizeFxCanvas();
  addEventListener('resize', sizeFxCanvas);
}
function sizeFxCanvas() {
  if (!fxCanvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fxCanvas.width = Math.round(innerWidth * dpr);
  fxCanvas.height = Math.round(innerHeight * dpr);
  fxCanvas.style.width = innerWidth + 'px';
  fxCanvas.style.height = innerHeight + 'px';
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function resetFx() {
  for (const k in fxPools) fxPools[k].length = 0;
  fxUpdaters.length = 0;
  if (fxCtx) fxCtx.clearRect(0, 0, innerWidth, innerHeight);
}
function startFxLoop() {
  if (fxRunning) return;
  fxRunning = true; fxLast = performance.now();
  requestAnimationFrame(fxTick);
}

/** Spawn a full detonation at viewport (x,y). rad = unit min-dimension (blast
 *  scale); rgb = faction energy color. Wakes the canvas loop. */
function spawnDetonation(x, y, rad, rgb) {
  ensureFxCanvas();
  const s = rad / 140; // scale vs the approved demo (its card min-dim ~150)
  const P = fxPools;
  // flash + shockwaves (radii keyed to unit size)
  P.flashes.push({ x, y, r: rad * 0.12, max: rad * 1.0, life: 0, dur: 0.16, rgb });
  P.flashes.push({ x, y, r: rad * 0.05, max: rad * 0.5, life: 0, dur: 0.09, rgb });
  P.shocks.push({ x, y, r: rad * 0.1, max: rad * 1.5, life: 0, dur: 0.42, w: 3.0 * s, rgb });
  P.shocks.push({ x, y, r: rad * 0.06, max: rad * 0.9, life: 0, dur: 0.26, w: 2.0 * s, rgb });
  // fireball
  for (let i = 0; i < 20; i++) {
    const a = rf(TAU), sp = rf(190, 40) * s;
    P.fire.push({ x: x + Math.cos(a) * 6, y: y + Math.sin(a) * 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30 * s,
      size: rf(52, 28) * s, grow: rf(2.4, 1.3), life: 0, dur: rf(0.58, 0.32), rot: rf(TAU), vr: rf(3, -3), rgb });
  }
  // smoke (all at once; velocity/size variance gives the churn). Shorter life
  // than the demo so it doesn't linger over a live board.
  for (let i = 0; i < 40; i++) {
    const a = rf(TAU), sp = rf(140, 18) * s;
    P.smoke.push({ x: x + Math.cos(a) * rf(12, 0) * s, y: y + Math.sin(a) * rf(12, 0) * s,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(38, 10) * s,
      size: rf(44, 24) * s, grow: rf(32, 18) * s, life: -rf(0.14, 0), dur: rf(2.0, 1.1),
      rot: rf(TAU), vr: rf(0.8, -0.8), seed: (Math.random() * 3) | 0, turb: rf(24, 12) * s, phase: rf(TAU), buoy: rf(48, 24) * s });
  }
  // embers with trails
  for (let i = 0; i < 30; i++) {
    const a = rf(TAU), sp = rf(340, 70) * s;
    P.embers.push({ x, y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(56, 0) * s,
      size: rf(4.2, 1.5) * s, life: 0, dur: rf(1.4, 0.5), flick: rf(TAU), drag: rf(1.6, 1.1), rgb });
  }
  // card debris
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + rf(0.5, -0.5), sp = rf(220, 80) * s;
    P.debris.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(150, 55) * s,
      w: rf(24, 11) * s, h: rf(19, 9) * s, rot: rf(TAU), vr: rf(9, -9), life: 0, dur: rf(1.1, 0.75), rgb });
  }
  startFxLoop();
}

/** Melee attack impact: sharp flash + tight shockwave + a spray of sparks and
 *  a few chunky debris chips kicking off the struck unit, plus a brief puff
 *  of dust — much shorter-lived than the death cloud so it never lingers
 *  over a live board. Reuses spawnDetonation's particle pools/renderer, just
 *  smaller and quicker since the unit survives the hit. Fires on every
 *  attack, so this carries most of the game's combat "feel." */
function spawnImpact(x, y, rad, rgb, dir = null) {
  ensureFxCanvas();
  const s = rad / 140;
  const P = fxPools;
  P.flashes.push({ x, y, r: rad * 0.1, max: rad * 0.55, life: 0, dur: 0.11, rgb });
  P.shocks.push({ x, y, r: rad * 0.08, max: rad * 0.85, life: 0, dur: 0.26, w: 2.4 * s, rgb });
  P.glints.push({ x, y, s: rad * 0.28, life: 0, dur: 0.22, rgb, rot: 0 });
  for (let i = 0; i < 16; i++) {
    // with an incoming flight vector, most sparks spray back away from it
    const a = dir && Math.random() < 0.6 ? Math.atan2(-dir.y, -dir.x) + rf(1.1, -1.1) : rf(TAU);
    const sp = rf(300, 90) * s;
    P.embers.push({ x, y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(40, 0) * s,
      size: rf(3.6, 1.4) * s, life: 0, dur: rf(0.55, 0.22), flick: rf(TAU), drag: rf(2.2, 1.6), rgb });
  }
  for (let i = 0; i < 5; i++) {
    const a = rf(TAU), sp = rf(150, 50) * s;
    P.debris.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(90, 30) * s,
      w: rf(10, 5) * s, h: rf(8, 4) * s, rot: rf(TAU), vr: rf(10, -10), life: 0, dur: rf(0.55, 0.4), rgb });
  }
  for (let i = 0; i < 6; i++) {
    const a = rf(TAU), sp = rf(60, 10) * s;
    P.smoke.push({ x: x + Math.cos(a) * rf(8, 0) * s, y: y + Math.sin(a) * rf(8, 0) * s,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(20, 6) * s,
      size: rf(20, 12) * s, grow: rf(14, 8) * s, life: 0, dur: rf(0.42, 0.28),
      rot: rf(TAU), vr: rf(0.6, -0.6), seed: (Math.random() * 3) | 0, turb: rf(10, 4) * s, phase: rf(TAU), buoy: rf(20, 8) * s });
  }
  startFxLoop();
}

/** Spell/ability damage: a sharper "energy strike" — crackling flash + tight
 *  shockwave + a spray of sparks. No smoke, no debris: this damage comes from
 *  an off-screen effect, not a physical unit-on-unit impact. Scales with the
 *  amount so a 1 still lands as a beat and a big hit reads as a real crack. */
function spawnEnergyStrike(x, y, amount, rgb) {
  ensureFxCanvas();
  const rad = amount >= 5 ? 100 : amount >= 3 ? 78 : 56;
  const s = rad / 140;
  const P = fxPools;
  P.flashes.push({ x, y, r: rad * 0.14, max: rad * 0.6, life: 0, dur: 0.1, rgb });
  P.shocks.push({ x, y, r: rad * 0.06, max: rad * 0.7, life: 0, dur: 0.22, w: 2.0 * s, rgb });
  const n = amount >= 5 ? 18 : amount >= 3 ? 13 : 9;
  for (let i = 0; i < n; i++) {
    const a = rf(TAU), sp = rf(260, 80) * s;
    P.embers.push({ x, y, px: x, py: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rf(30, 0) * s,
      size: rf(3.2, 1.3) * s, life: 0, dur: rf(0.42, 0.2), flick: rf(TAU), drag: rf(2.4, 1.8), rgb });
  }
  startFxLoop();
}

// ===================== attack projectile archetypes =====================
// Every attack fires a projectile (or melee rake) picked by the ATTACKER's
// asset class — approved in the standalone FX demo, ported here with tighter
// game pacing. Each launch(a, b, rgb) spawns everything on the fx canvas and
// returns the ms until the payload visually lands, so the attack event can
// sync the target's flash/knockback/shake to the actual arrival instead of a
// fixed delay. Target reaction (hitTarget in the demo) stays in playEvent.
//
//   personnel → kinetic   white-hot comet, energy ribbon + smoke stream
//   robotic   → bullets   3-round tracer burst, shell casings
//   software  → laser     charge → instant beam w/ chromatic edges → collapse
//   organism  → bio       lobbed wobbling glob, acid splash  (pathogens)
//               claws     three jagged rakes across the card (beasts, override)
//   financial → ledger    five spinning gilded shards, ricochet glints
//   facility  → artillery heavy arcing shell, thick smoke, double shockwave
const ATTACK_FX = {};

ATTACK_FX.kinetic = {
  launch(a, b, rgb) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dur = Math.max(0.17, Math.min(0.3, 0.15 + dist * 0.0002));
    const arc = Math.min(48, 12 + dist * 0.085);
    const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - arc };
    const d0 = bezierDir(0, a, c, b), l0 = Math.hypot(d0.x, d0.y) || 1;
    muzzle(a.x + (d0.x / l0) * 46, a.y + (d0.y / l0) * 46, rgb, { x: d0.x / l0, y: d0.y / l0 });
    fxUpdaters.push({
      t: 0, acc: 0, pts: [], phase: rf(TAU), pos: null, dir: null,
      update(dt) {
        this.t += dt / dur;
        if (this.t >= 1) {
          const dE = bezierDir(1, a, c, b), lE = Math.hypot(dE.x, dE.y) || 1;
          spawnImpact(b.x, b.y, 100, rgb, { x: dE.x / lE, y: dE.y / lE });
          return false;
        }
        const p = bezier(this.t, a, c, b);
        const d = bezierDir(this.t, a, c, b), l = Math.hypot(d.x, d.y) || 1;
        this.pos = p; this.dir = { x: d.x / l, y: d.y / l };
        this.pts.unshift({ x: p.x, y: p.y }); if (this.pts.length > 15) this.pts.pop();
        this.acc += dt;
        while (this.acc > 0.014) {
          this.acc -= 0.014;
          fxPools.smoke.push({ x: p.x - this.dir.x * 8 + rf(3, -3), y: p.y - this.dir.y * 8 + rf(3, -3),
            vx: -this.dir.x * rf(34, 12) + rf(12, -12), vy: -this.dir.y * rf(34, 12) - rf(10, 2),
            size: rf(8, 4.5), grow: rf(15, 9), life: 0, dur: rf(0.55, 0.3),
            rot: rf(TAU), vr: rf(0.6, -0.6), seed: (Math.random() * 3) | 0 });
          if (Math.random() < 0.5) {
            const ba = Math.atan2(this.dir.y, this.dir.x) + Math.PI + rf(0.7, -0.7);
            fxPools.embers.push({ x: p.x, y: p.y, px: p.x, py: p.y,
              vx: Math.cos(ba) * rf(70, 20), vy: Math.sin(ba) * rf(70, 20),
              size: rf(2.4, 1), life: 0, dur: rf(0.3, 0.15), flick: rf(TAU), drag: rf(2, 1.4), rgb });
          }
        }
        return true;
      },
      drawUnder(ctx) {
        for (let i = 2; i < this.pts.length - 1; i++) {
          const q0 = this.pts[i], q1 = this.pts[i + 1], f = 1 - i / this.pts.length;
          ctx.globalAlpha = 0.16 * f;
          ctx.strokeStyle = 'rgb(110,112,120)';
          ctx.lineCap = 'round'; ctx.lineWidth = 9 * f + 2;
          ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
        }
      },
      draw(ctx, now) {
        if (!this.pos) return;
        const { x, y } = this.pos;
        const ang = Math.atan2(this.dir.y, this.dir.x);
        const pulse = 1 + Math.sin(now / 48 + this.phase) * 0.14;
        lightCast(x, y, 85, rgb, 0.13);
        for (let i = 0; i < this.pts.length - 1 && i < 9; i++) {
          const q0 = this.pts[i], q1 = this.pts[i + 1], f = 1 - i / 9;
          ctx.globalAlpha = 0.34 * f;
          ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.lineCap = 'round'; ctx.lineWidth = 6 * f + 1;
          ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
        }
        const gr = 26 * pulse;
        ctx.globalAlpha = 0.9;
        ctx.drawImage(fireFor(rgb), x - gr, y - gr, gr * 2, gr * 2);
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.globalAlpha = 1;
        ctx.drawImage(coreFor(rgb), -20, -7, 27, 14);
        ctx.restore();
        glintDraw(x, y, 15 * pulse, rgb, 0.85);
      },
    });
    return dur * 1000;
  },
};

ATTACK_FX.bullets = {
  launch(a, b, rgb) {
    const baseDist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dur = Math.max(0.1, Math.min(0.13, 0.08 + baseDist * 0.00008));
    const fireRound = (last) => {
      const tb = { x: b.x + rf(5, -5), y: b.y + rf(5, -5) };
      const c = { x: (a.x + tb.x) / 2, y: (a.y + tb.y) / 2 - rf(6, 3) };
      const d0 = bezierDir(0, a, c, tb), l0 = Math.hypot(d0.x, d0.y) || 1;
      const fdir = { x: d0.x / l0, y: d0.y / l0 };
      const mx = a.x + fdir.x * 46, my = a.y + fdir.y * 46;
      muzzle(mx, my, rgb, fdir, 0.7);
      // ejected brass casing
      fxPools.debris.push({ x: mx, y: my,
        vx: -fdir.x * rf(90, 45) + rf(24, -24), vy: -fdir.y * rf(90, 45) - rf(120, 60),
        w: 4, h: 2.5, rot: rf(TAU), vr: rf(16, -16), life: 0, dur: rf(0.55, 0.4),
        rgb: mix(rgb, [255, 210, 120], 0.5) });
      fxUpdaters.push({
        t: 0, pos: null, prev: { x: mx, y: my }, dir: fdir,
        update(dt) {
          this.t += dt / dur;
          if (this.t >= 1) {
            const dE = bezierDir(1, a, c, tb), lE = Math.hypot(dE.x, dE.y) || 1;
            const dir = { x: dE.x / lE, y: dE.y / lE };
            if (last) {
              spawnImpact(tb.x, tb.y, 90, rgb, dir);
            } else {
              fxPools.flashes.push({ x: tb.x, y: tb.y, r: 3, max: 16, life: 0, dur: 0.08, rgb });
              fxPools.glints.push({ x: tb.x, y: tb.y, s: 12, life: 0, dur: 0.14, rgb, rot: 0 });
              for (let i = 0; i < 5; i++) {
                const ba = Math.atan2(-dir.y, -dir.x) + rf(0.9, -0.9), sp = rf(180, 60);
                fxPools.embers.push({ x: tb.x, y: tb.y, px: tb.x, py: tb.y,
                  vx: Math.cos(ba) * sp, vy: Math.sin(ba) * sp - rf(25, 0),
                  size: rf(2.6, 1.1), life: 0, dur: rf(0.35, 0.18), flick: rf(TAU), drag: rf(2.2, 1.6), rgb });
              }
            }
            return false;
          }
          if (this.pos) this.prev = this.pos;
          const p = bezier(this.t, a, c, tb);
          const d = bezierDir(this.t, a, c, tb), l = Math.hypot(d.x, d.y) || 1;
          this.pos = p; this.dir = { x: d.x / l, y: d.y / l };
          return true;
        },
        draw(ctx) {
          if (!this.pos) return;
          const { x, y } = this.pos;
          lightCast(x, y, 50, rgb, 0.08);
          ctx.globalAlpha = 0.75;
          ctx.strokeStyle = `rgb(${Math.min(255, rgb[0] + 120)},${Math.min(255, rgb[1] + 90)},${Math.min(255, rgb[2] + 70)})`;
          ctx.lineCap = 'round'; ctx.lineWidth = 2.4;
          ctx.beginPath(); ctx.moveTo(this.prev.x, this.prev.y); ctx.lineTo(x, y); ctx.stroke();
          ctx.globalAlpha = 0.8;
          ctx.drawImage(fireFor(rgb), x - 12, y - 12, 24, 24);
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(this.dir.y, this.dir.x));
          ctx.globalAlpha = 1;
          ctx.drawImage(coreFor(rgb), -26, -4, 34, 8);
          ctx.restore();
        },
      });
    };
    fireRound(false);
    fxTimeout(() => { fireRound(false); startFxLoop(); }, 55);
    fxTimeout(() => { fireRound(true); startFxLoop(); }, 110);
    return 110 + dur * 1000;
  },
};

ATTACK_FX.laser = {
  launch(a, b, rgb) {
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy) || 1;
    const u = { x: dx / dist, y: dy / dist };
    const n = { x: -u.y, y: u.x };
    const mx = a.x + u.x * 46, my = a.y + u.y * 46;
    const hx = b.x, hy = b.y;
    const CHG = 0.11, BEAM = 0.2, COL = 0.1;
    const redEdge = mix(rgb, [255, 80, 80], 0.6);
    const bluEdge = mix(rgb, [90, 140, 255], 0.6);
    const innerC = mix(rgb, [255, 255, 255], 0.45);
    const coreC = mix(rgb, [255, 255, 255], 0.88);
    muzzle(mx, my, rgb, u, 0.8);
    fxUpdaters.push({
      t: 0, acc: 0, popped: false, phase: rf(TAU), jx: 0, jy: 0,
      update(dt, now) {
        this.t += dt;
        const j = rf(0.8, -0.8);
        this.jx = n.x * j; this.jy = n.y * j;
        if (this.t < CHG) {
          // suction embers converging on the muzzle (energy gathering)
          this.acc += dt;
          while (this.acc > 0.028) {
            this.acc -= 0.028;
            const ea = rf(TAU), er = rf(28, 20), ed = rf(0.18, 0.12);
            const ex = mx + Math.cos(ea) * er, ey = my + Math.sin(ea) * er;
            fxPools.embers.push({ x: ex, y: ey, px: ex, py: ey,
              vx: (mx - ex) / ed * 0.92, vy: (my - ey) / ed * 0.92 - 14,
              size: rf(1.9, 0.9), life: 0, dur: ed, flick: rf(TAU), drag: 0, rgb });
          }
          return true;
        }
        if (this.t < CHG + BEAM) {
          // spark fountain off the hit point while the beam burns
          this.acc += dt;
          while (this.acc > 0.025) {
            this.acc -= 0.025;
            for (let i = 0; i < 2; i++) {
              const ba = Math.atan2(-u.y, -u.x) + rf(0.8, -0.8), sp = rf(160, 60);
              fxPools.embers.push({ x: hx, y: hy, px: hx, py: hy,
                vx: Math.cos(ba) * sp, vy: Math.sin(ba) * sp - rf(90, 30),
                size: rf(2.6, 1.1), life: 0, dur: rf(0.4, 0.18), flick: rf(TAU), drag: rf(2, 1.4), rgb });
            }
          }
          return true;
        }
        if (!this.popped) {
          this.popped = true;
          spawnImpact(hx, hy, 85, rgb, u);
        }
        if (this.t < CHG + BEAM + COL) return true;
        for (let i = 0; i < 3; i++) { // scorch smoke wisps on exit
          fxPools.smoke.push({ x: hx + rf(8, -8), y: hy + rf(6, -6),
            vx: rf(16, -16), vy: -rf(34, 14),
            size: rf(7, 4), grow: rf(14, 8), life: -i * 0.04, dur: rf(0.6, 0.4),
            rot: rf(TAU), vr: rf(0.6, -0.6), seed: (Math.random() * 3) | 0 });
        }
        return false;
      },
      draw(ctx, now) {
        const flick = 0.85 + 0.15 * Math.sin(now * 0.56 + this.phase);
        if (this.t < CHG) {
          const cp = this.t / CHG, r = 18 * cp * flick;
          ctx.globalAlpha = 0.9 * cp * flick;
          ctx.drawImage(fireFor(rgb), mx - r, my - r, r * 2, r * 2);
          glintDraw(mx, my, 16 * cp, rgb, 0.85 * cp * flick);
          lightCast(mx, my, 44 * cp, rgb, 0.1 * cp);
          return;
        }
        const bt = this.t - CHG;
        const k = bt < BEAM ? 0 : Math.min(1, (bt - BEAM) / COL);
        const w = 1 - k;
        if (w <= 0) return;
        const x0 = mx + this.jx, y0 = my + this.jy;
        const x1 = hx + this.jx, y1 = hy + this.jy;
        const line = (ox, oy, wid, style, alpha) => {
          ctx.globalAlpha = alpha; ctx.strokeStyle = style;
          ctx.lineCap = 'round'; ctx.lineWidth = wid;
          ctx.beginPath(); ctx.moveTo(x0 + ox, y0 + oy); ctx.lineTo(x1 + ox, y1 + oy); ctx.stroke();
        };
        line(0, 0, (11 + Math.sin(now / 85 + this.phase) * 1.6) * w, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, 0.22 * w);
        line(n.x * 2, n.y * 2, 1 * w, `rgb(${redEdge[0]},${redEdge[1]},${redEdge[2]})`, 0.35 * w);
        line(-n.x * 2, -n.y * 2, 1 * w, `rgb(${bluEdge[0]},${bluEdge[1]},${bluEdge[2]})`, 0.35 * w);
        line(0, 0, 4 * w, `rgb(${innerC[0]},${innerC[1]},${innerC[2]})`, 0.85 * w);
        line(0, 0, 1.6 * rf(1.15, 0.85) * w, `rgb(${coreC[0]},${coreC[1]},${coreC[2]})`, 1 * w);
        const dot = dotFor(rgb);
        for (let i = 0; i < 3; i++) {
          const f = (bt * 2.4 + i / 3) % 1;
          const kx = x0 + (x1 - x0) * f, ky = y0 + (y1 - y0) * f;
          ctx.globalAlpha = 0.9 * w;
          ctx.drawImage(dot, kx - 5, ky - 5, 10, 10);
        }
        glintDraw(x0, y0, 14 * w, rgb, 0.8 * w * flick);
        glintDraw(x1, y1, 20 * (1 + 0.22 * Math.sin(now / 42 + this.phase)) * w, rgb, 0.9 * w);
        lightCast((x0 + x1) / 2, (y0 + y1) / 2, 90, rgb, 0.1 * w);
        lightCast(x1, y1, 60, rgb, 0.14 * w);
        if (k === 0) {
          const fr = 14 * flick;
          ctx.globalAlpha = 0.95;
          ctx.drawImage(fireFor(rgb), x1 - fr, y1 - fr, fr * 2, fr * 2);
        }
      },
    });
    return CHG * 1000;
  },
};

ATTACK_FX.bio = {
  launch(a, b, rgb) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dur = Math.max(0.26, Math.min(0.36, 0.2 + dist * 0.0003));
    const arc = Math.min(90, 40 + dist * 0.22);
    const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - arc };
    const dark = mix(rgb, [0, 0, 0], 0.25);
    const d0 = bezierDir(0, a, c, b), l0 = Math.hypot(d0.x, d0.y) || 1;
    muzzle(a.x + (d0.x / l0) * 46, a.y + (d0.y / l0) * 46, rgb, { x: d0.x / l0, y: d0.y / l0 }, 0.8);
    fxUpdaters.push({
      t: 0, acc: 0, drip: 0, pos: null,
      ph: [rf(TAU), rf(TAU), rf(TAU)],
      sats: [{ rad: rf(13, 9), rate: rf(0.011, 0.007), ph: rf(TAU) },
             { rad: rf(13, 9), rate: -rf(0.011, 0.007), ph: rf(TAU) }],
      lobes(now) {
        return [
          { dx: Math.sin(now / 92 + this.ph[0]) * 2.5, dy: Math.cos(now / 121 + this.ph[0]) * 2.2, r: 7 },
          { dx: Math.cos(now / 68 + this.ph[1]) * 2.6, dy: Math.sin(now / 103 + this.ph[1]) * 2.5, r: 5.5 },
          { dx: Math.sin(now / 57 + this.ph[2]) * 2.3, dy: Math.cos(now / 84 + this.ph[2]) * 2.6, r: 4.5 },
        ];
      },
      update(dt) {
        this.t += dt / dur;
        if (this.t >= 1) {
          const dE = bezierDir(1, a, c, b), lE = Math.hypot(dE.x, dE.y) || 1;
          const ex = dE.x / lE, ey = dE.y / lE;
          // acid splash: flattened double ring, up-and-out droplets, sizzle
          fxPools.shocks.push({ x: b.x, y: b.y, r: 5, max: 44, life: 0, dur: 0.24, w: 3, rgb });
          fxPools.shocks.push({ x: b.x, y: b.y, r: 8, max: 60, life: 0, dur: 0.3, w: 1.6, rgb });
          fxPools.flashes.push({ x: b.x, y: b.y, r: 6, max: 30, life: 0, dur: 0.1, rgb });
          const dn = 10 + ((Math.random() * 3) | 0);
          for (let i = 0; i < dn; i++) {
            const ua = -Math.PI / 2 + rf(1.1, -1.1), sp = rf(180, 60);
            fxPools.embers.push({ x: b.x, y: b.y, px: b.x, py: b.y,
              vx: Math.cos(ua) * sp - ex * sp * 0.45, vy: Math.sin(ua) * sp - ey * sp * 0.45,
              size: rf(2.8, 1.4), life: 0, dur: rf(0.5, 0.3), flick: rf(TAU), drag: rf(2, 1.4), rgb });
          }
          for (let i = 0; i < 3; i++) {
            const da = rf(TAU), sp = rf(90, 30);
            fxPools.debris.push({ x: b.x, y: b.y, vx: Math.cos(da) * sp, vy: Math.sin(da) * sp - rf(90, 40),
              w: rf(7, 3), h: rf(6, 3), rot: rf(TAU), vr: rf(8, -8), life: 0, dur: rf(0.45, 0.3), rgb });
          }
          fxUpdaters.push({
            t: 0, acc: 0,
            update(dt2) {
              this.t += dt2; this.acc += dt2;
              while (this.acc >= 0.05) {
                this.acc -= 0.05;
                fxPools.smoke.push({ x: b.x + rf(14, -14), y: b.y + rf(8, -8),
                  vx: rf(10, -10), vy: -rf(26, 12), size: rf(4, 2), grow: rf(6, 3),
                  life: 0, dur: rf(0.35, 0.2), rot: rf(TAU), vr: rf(0.6, -0.6), rgb });
              }
              return this.t < 0.45;
            },
          });
          return false;
        }
        const p = bezier(this.t, a, c, b);
        this.pos = p;
        this.acc += dt;
        while (this.acc > 0.03) {
          this.acc -= 0.03;
          fxPools.embers.push({ x: p.x + rf(4, -4), y: p.y + rf(4, -4), px: p.x, py: p.y,
            vx: rf(20, -20), vy: rf(20, -20),
            size: rf(2.6, 1.2), life: 0, dur: rf(0.4, 0.25), flick: rf(TAU), drag: rf(2, 1.4), rgb });
          if (Math.random() < 0.45) {
            fxPools.smoke.push({ x: p.x + rf(3, -3), y: p.y + rf(3, -3),
              vx: rf(14, -14), vy: rf(6, -14), size: rf(6, 3.5), grow: rf(8, 4),
              life: 0, dur: rf(0.4, 0.25), rot: rf(TAU), vr: rf(0.6, -0.6), rgb });
          }
        }
        this.drip += dt;
        while (this.drip > 0.04) {
          this.drip -= 0.04;
          fxPools.embers.push({ x: p.x + rf(3, -3), y: p.y + 4, px: p.x, py: p.y + 4,
            vx: rf(4, -4), vy: rf(30, 10),
            size: rf(2.2, 1), life: 0, dur: rf(0.4, 0.25), flick: rf(TAU), drag: rf(1.2, 0.8), rgb });
        }
        return true;
      },
      drawUnder(ctx, now) {
        if (!this.pos) return;
        const { x, y } = this.pos;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = `rgb(${dark[0]},${dark[1]},${dark[2]})`;
        for (const l of this.lobes(now)) {
          ctx.beginPath(); ctx.arc(x + l.dx, y + l.dy, l.r, 0, TAU); ctx.fill();
        }
      },
      draw(ctx, now) {
        if (!this.pos) return;
        const { x, y } = this.pos;
        lightCast(x, y, 55, rgb, 0.09);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(fireFor(rgb), x - 13, y - 13, 26, 26);
        for (const s of this.sats) {
          const sx = x + Math.cos(now * s.rate + s.ph) * s.rad;
          const sy = y + Math.sin(now * s.rate + s.ph) * s.rad;
          ctx.globalAlpha = 0.8;
          ctx.drawImage(dotFor(rgb), sx - 4, sy - 4, 8, 8);
        }
        glintDraw(x, y, 8, rgb, 0.7);
      },
    });
    return dur * 1000;
  },
};

ATTACK_FX.ledger = {
  launch(a, b, rgb) {
    const gold = mix(rgb, [255, 208, 96], 0.65);
    const bright = mix(gold, [255, 255, 255], 0.5);
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dur = Math.max(0.22, Math.min(0.3, 0.19 + dist * 0.0002));
    const arc = Math.min(40, 12 + dist * 0.07);
    const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - arc };
    const d0 = bezierDir(0, a, c, b), l0 = Math.hypot(d0.x, d0.y) || 1;
    muzzle(a.x + (d0.x / l0) * 46, a.y + (d0.y / l0) * 46, gold, { x: d0.x / l0, y: d0.y / l0 }, 0.8);
    const shards = [];
    for (let i = 0; i < 5; i++) {
      shards.push({
        t: -(i * 0.0125) / dur,
        bx: b.x + rf(7, -7), by: b.y + rf(7, -7),
        amp: rf(9, 4), phase: rf(TAU), freq: rf(3.2, 2.2),
        rot: rf(TAU), spin: rf(14, 9) * (Math.random() < 0.5 ? -1 : 1),
        gAcc: rf(0.09), eAcc: rf(0.05), pos: null, done: false,
      });
    }
    fxUpdaters.push({
      update(dt) {
        for (const s of shards) {
          if (s.done) continue;
          s.t += dt / dur;
          if (s.t < 0) continue;
          if (s.t >= 1) {
            s.done = true;
            if (shards.some((o) => !o.done)) {
              fxPools.flashes.push({ x: s.bx, y: s.by, r: 2, max: 12, life: 0, dur: 0.07, rgb: gold });
              fxPools.glints.push({ x: s.bx, y: s.by, s: 10, life: 0, dur: 0.13, rgb: gold, rot: rf(0.6, -0.6) });
              for (let i = 0; i < 3; i++) {
                const pa = rf(TAU), sp = rf(120, 50);
                fxPools.embers.push({ x: s.bx, y: s.by, px: s.bx, py: s.by,
                  vx: Math.cos(pa) * sp, vy: Math.sin(pa) * sp - rf(40, 10),
                  size: rf(2.2, 1), life: 0, dur: rf(0.3, 0.16), flick: rf(TAU), drag: rf(2.2, 1.6), rgb: gold });
              }
            } else {
              const tb = { x: s.bx, y: s.by };
              const dE = bezierDir(1, a, c, tb), lE = Math.hypot(dE.x, dE.y) || 1;
              spawnImpact(s.bx, s.by, 80, gold, { x: dE.x / lE, y: dE.y / lE });
              const hx = s.bx, hy = s.by;
              // ricochet glints pinging up off the hit point
              fxUpdaters.push({
                acc: 0.04, n: 0,
                update(dt2) {
                  this.acc += dt2;
                  while (this.acc >= 0.04 && this.n < 3) {
                    this.acc -= 0.04; this.n++;
                    fxPools.glints.push({ x: hx + rf(18, -18), y: hy - rf(20, 10),
                      s: rf(13, 8), life: 0, dur: 0.16, rgb: gold, rot: rf(0.6, -0.6) });
                  }
                  return this.n < 3;
                },
              });
            }
            continue;
          }
          const tb = { x: s.bx, y: s.by };
          const p = bezier(s.t, a, c, tb);
          const d = bezierDir(s.t, a, c, tb), l = Math.hypot(d.x, d.y) || 1;
          const wob = Math.sin(s.t * Math.PI * s.freq + s.phase) * s.amp * Math.sin(s.t * Math.PI);
          s.pos = { x: p.x - (d.y / l) * wob, y: p.y + (d.x / l) * wob };
          s.rot += dt * s.spin;
          s.gAcc += dt;
          while (s.gAcc > 0.09) {
            s.gAcc -= 0.09;
            fxPools.glints.push({ x: s.pos.x, y: s.pos.y, s: rf(10, 6), life: 0, dur: 0.16, rgb: gold, rot: rf(0.6, -0.6) });
          }
          s.eAcc += dt;
          while (s.eAcc > 0.05) {
            s.eAcc -= 0.05;
            if (Math.random() < 0.6) {
              fxPools.embers.push({ x: s.pos.x + rf(3, -3), y: s.pos.y + rf(3, -3), px: s.pos.x, py: s.pos.y,
                vx: rf(18, -18), vy: rf(12, -18),
                size: rf(1.8, 0.8), life: 0, dur: rf(0.25, 0.12), flick: rf(TAU), drag: rf(2.4, 1.8), rgb: gold });
            }
          }
        }
        return shards.some((s) => !s.done);
      },
      draw(ctx) {
        let mx = 0, my = 0, m = 0;
        for (const s of shards) {
          if (s.done || !s.pos) continue;
          mx += s.pos.x; my += s.pos.y; m++;
          ctx.globalAlpha = 0.9;
          ctx.drawImage(dotFor(gold), s.pos.x - 8, s.pos.y - 8, 16, 16);
          ctx.save(); ctx.translate(s.pos.x, s.pos.y); ctx.rotate(s.rot);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = `rgb(${bright[0]},${bright[1]},${bright[2]})`;
          ctx.beginPath(); ctx.moveTo(3.5, 0); ctx.lineTo(0, 2); ctx.lineTo(-3.5, 0); ctx.lineTo(0, -2);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        if (m) lightCast(mx / m, my / m, 60, gold, 0.08);
      },
    });
    return (dur + 0.06) * 1000;
  },
};

ATTACK_FX.artillery = {
  launch(a, b, rgb) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dur = Math.max(0.3, Math.min(0.42, 0.26 + dist * 0.0003));
    const arc = Math.min(100, 40 + dist * 0.24);
    const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - arc };
    const d0 = bezierDir(0, a, c, b), l0 = Math.hypot(d0.x, d0.y) || 1;
    const mdir = { x: d0.x / l0, y: d0.y / l0 };
    const mx = a.x + mdir.x * 46, my = a.y + mdir.y * 46;
    muzzle(mx, my, rgb, mdir, 1.6);
    fxPools.shocks.push({ x: mx, y: my, r: 4, max: 30, life: 0, dur: 0.2, w: 2, rgb });
    for (let i = 0; i < 3; i++) {
      fxPools.smoke.push({ x: mx + rf(6, -6), y: my + rf(6, -6),
        vx: mdir.x * rf(70, 25) + rf(18, -18), vy: mdir.y * rf(70, 25) - rf(26, 8),
        size: rf(13, 8), grow: rf(24, 14), life: -i * 0.02, dur: rf(0.7, 0.45),
        rot: rf(TAU), vr: rf(0.6, -0.6), seed: (Math.random() * 3) | 0 });
    }
    fxUpdaters.push({
      t: 0, acc: 0, phase: rf(TAU), pos: null, dir: null,
      update(dt) {
        this.t += dt / dur;
        if (this.t >= 1) {
          const dE = bezierDir(1, a, c, b), lE = Math.hypot(dE.x, dE.y) || 1;
          spawnImpact(b.x, b.y, 170, rgb, { x: dE.x / lE, y: dE.y / lE });
          fxTimeout(() => { fxPools.shocks.push({ x: b.x, y: b.y, r: 10, max: 80, life: 0, dur: 0.34, w: 3, rgb }); startFxLoop(); }, 70);
          for (let i = 0; i < 4; i++) {
            fxPools.smoke.push({ x: b.x + rf(12, -12), y: b.y + rf(6, -6),
              vx: rf(16, -16), vy: -rf(70, 34),
              size: rf(12, 7), grow: rf(26, 16), life: -0.05 * i, dur: rf(1, 0.7),
              rot: rf(TAU), vr: rf(0.5, -0.5), seed: (Math.random() * 3) | 0 });
          }
          return false;
        }
        const p = bezier(this.t, a, c, b);
        const d = bezierDir(this.t, a, c, b), l = Math.hypot(d.x, d.y) || 1;
        this.pos = p; this.dir = { x: d.x / l, y: d.y / l };
        this.acc += dt;
        while (this.acc > 0.012) {
          this.acc -= 0.012;
          fxPools.smoke.push({ x: p.x - this.dir.x * 10 + rf(4, -4), y: p.y - this.dir.y * 10 + rf(4, -4),
            vx: -this.dir.x * rf(30, 8) + rf(12, -12), vy: -this.dir.y * rf(30, 8) - rf(12, 2),
            size: rf(10, 6), grow: rf(20, 12), life: 0, dur: rf(0.75, 0.55),
            rot: rf(TAU), vr: rf(0.5, -0.5), seed: (Math.random() * 3) | 0 });
          if (Math.random() < 0.25) {
            const ba = Math.atan2(this.dir.y, this.dir.x) + Math.PI + rf(0.6, -0.6);
            fxPools.embers.push({ x: p.x, y: p.y, px: p.x, py: p.y,
              vx: Math.cos(ba) * rf(60, 18), vy: Math.sin(ba) * rf(60, 18),
              size: rf(2.2, 1), life: 0, dur: rf(0.3, 0.16), flick: rf(TAU), drag: rf(2, 1.4), rgb });
          }
        }
        return true;
      },
      drawUnder(ctx, now) {
        if (!this.pos) return;
        const { x, y } = this.pos;
        const ang = Math.atan2(this.dir.y, this.dir.x) + Math.sin(now / 85 + this.phase) * 0.14;
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.globalAlpha = 1; ctx.fillStyle = '#1a2130';
        ctx.beginPath();
        ctx.moveTo(-7, -3); ctx.lineTo(4, -3); ctx.quadraticCurveTo(7.5, 0, 4, 3);
        ctx.lineTo(-7, 3); ctx.quadraticCurveTo(-8.2, 0, -7, -3); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.75; ctx.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.lineWidth = 1.1; ctx.stroke();
        ctx.restore();
      },
      draw(ctx, now) {
        if (!this.pos) return;
        const { x, y } = this.pos;
        const ang = Math.atan2(this.dir.y, this.dir.x) + Math.sin(now / 85 + this.phase) * 0.14;
        const flick = 1 + Math.sin(now / 34 + this.phase) * 0.18;
        lightCast(x, y, 70, rgb, 0.11);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(fireFor(rgb), x - 16, y - 16, 32, 32);
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.globalAlpha = 0.95;
        const fw = 20 * flick;
        ctx.drawImage(coreFor(rgb), -8 - fw * 0.62, -4, fw, 8);
        ctx.restore();
      },
    });
    return dur * 1000;
  },
};

ATTACK_FX.claws = {
  // melee: no projectile — three JAGGED rakes tear across the target card,
  // delayed so they land as the attacker's lunge visually connects
  launch(a, b, rgb) {
    const DELAY = 0.13;
    const ang = -0.65 + rf(0.15, -0.15);
    const px = -Math.sin(ang), py = Math.cos(ang);
    const N = 11;
    const rakes = [];
    for (let i = 0; i < 3; i++) {
      const rAng = ang + rf(0.07, -0.07);
      const dX = Math.cos(rAng), dY = Math.sin(rAng);
      const off = (i - 1) * rf(19, 14);
      const along = (i - 1) * rf(9, 4);
      const len = 116 * (i === 1 ? rf(1.12, 0.98) : rf(0.98, 0.8));
      const cx = b.x + px * off + dX * along, cy = b.y + py * off + dY * along;
      const pts = [];
      for (let k = 0; k < N; k++) {
        const q = k / (N - 1);
        const alongPos = (q - 0.5) * len;
        const jit = rf(3.4, -3.4);
        pts.push({ x: cx + dX * alongPos - dY * jit, y: cy + dY * alongPos + dX * jit,
          w: Math.pow(Math.sin(Math.PI * q), 0.55) * rf(1.2, 0.7) });
      }
      for (let s = 0; s < 2; s++) { // snag kinks where the claw caught
        const k = 2 + ((Math.random() * (N - 4)) | 0);
        const j = (Math.random() < 0.5 ? -1 : 1) * rf(7.5, 4.5);
        pts[k].x += -dY * j; pts[k].y += dX * j;
      }
      const notches = []; // torn-back flaps along the cut
      const nn = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let s = 0; s < nn; s++) {
        notches.push({ k: 1 + ((Math.random() * (N - 2)) | 0),
          side: Math.random() < 0.5 ? -1 : 1, jut: rf(6.5, 3.4), base: rf(6.5, 3.8) });
      }
      rakes.push({ pts, notches, start: DELAY + 0.05 * i, sweep: 0.08, linger: 0.4,
        drip: rf(0.05), phase: rf(TAU) });
    }
    const dark = mix(rgb, [0, 0, 0], 0.78);
    const darkCss = `rgb(${dark[0]},${dark[1]},${dark[2]})`;
    const midC = mix(rgb, [255, 255, 255], 0.35);
    const coreC = mix(rgb, [255, 255, 255], 0.8);
    const headAt = (r, sw) => {
      const f = sw * (r.pts.length - 1);
      const i0 = Math.min(r.pts.length - 2, f | 0), fr = f - i0;
      const p0 = r.pts[i0], p1 = r.pts[i0 + 1];
      return { x: p0.x + (p1.x - p0.x) * fr, y: p0.y + (p1.y - p0.y) * fr, w: p0.w };
    };
    const strokePath = (ctx, r, sw, width, alpha, color) => {
      const f = sw * (r.pts.length - 1);
      const iEnd = Math.min(r.pts.length - 2, f | 0);
      ctx.strokeStyle = color; ctx.lineJoin = 'round';
      for (let k = 0; k <= iEnd; k++) {
        const p0 = r.pts[k];
        const p1 = k === iEnd ? headAt(r, sw) : r.pts[k + 1];
        ctx.globalAlpha = alpha;
        ctx.lineWidth = Math.max(0.6, width * (p0.w + p1.w) / 2);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      }
    };
    let finished = false;
    fxUpdaters.push({
      t: 0,
      update(dt) {
        this.t += dt;
        let alive = false;
        for (let i = 0; i < rakes.length; i++) {
          const r = rakes[i];
          const lt = this.t - r.start;
          if (lt < 0) { alive = true; continue; }
          const sw = Math.min(1, lt / r.sweep);
          if (sw < 1) {
            alive = true;
            const h = headAt(r, sw);
            if (Math.random() < 0.8) {
              fxPools.embers.push({ x: h.x, y: h.y, px: h.x, py: h.y,
                vx: Math.cos(ang) * rf(90, 30) + rf(50, -50), vy: Math.sin(ang) * rf(90, 30) - rf(60, 10),
                size: rf(2.6, 1.2), life: 0, dur: rf(0.4, 0.2), flick: rf(TAU), drag: rf(2, 1.4), rgb });
            }
          } else if (lt < r.sweep + r.linger) {
            alive = true;
            if (i === rakes.length - 1 && !finished) {
              finished = true;
              fxPools.flashes.push({ x: b.x, y: b.y, r: 4, max: 22, life: 0, dur: 0.1, rgb });
              for (let d = 0; d < 3; d++) {
                const da = rf(TAU), sp = rf(90, 30);
                fxPools.debris.push({ x: b.x, y: b.y, vx: Math.cos(da) * sp, vy: Math.sin(da) * sp - rf(60, 20),
                  w: rf(7, 3), h: rf(5, 3), rot: rf(TAU), vr: rf(8, -8), life: 0, dur: rf(0.45, 0.3), rgb });
              }
            }
            r.drip += dt;
            if (r.drip > 0.07 && lt < r.sweep + 0.25) {
              r.drip = 0;
              const g = r.pts[1 + ((Math.random() * (r.pts.length - 2)) | 0)];
              fxPools.embers.push({ x: g.x, y: g.y, px: g.x, py: g.y,
                vx: rf(12, -12), vy: rf(24, 6),
                size: rf(2.2, 1.2), life: 0, dur: rf(0.45, 0.25), flick: rf(TAU), drag: rf(1.2, 0.8), rgb });
            }
          }
        }
        return alive;
      },
      drawUnder(ctx) {
        ctx.lineCap = 'round';
        for (const r of rakes) {
          const lt = this.t - r.start;
          if (lt <= 0) continue;
          const sw = Math.min(1, lt / r.sweep);
          const fade = lt > r.sweep ? Math.max(0, 1 - (lt - r.sweep) / r.linger) : 1;
          if (fade <= 0) continue;
          strokePath(ctx, r, sw, 3.6, 0.55 * fade, darkCss);
          const passed = sw * (r.pts.length - 1);
          for (const n of r.notches) {
            if (passed <= n.k) continue;
            const p = r.pts[n.k];
            const q0 = r.pts[Math.max(0, n.k - 1)], q1 = r.pts[Math.min(r.pts.length - 1, n.k + 1)];
            let tx = q1.x - q0.x, ty = q1.y - q0.y;
            const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
            const nx = -ty * n.side, ny = tx * n.side;
            ctx.globalAlpha = 0.5 * fade;
            ctx.fillStyle = darkCss;
            ctx.beginPath();
            ctx.moveTo(p.x - tx * n.base / 2, p.y - ty * n.base / 2);
            ctx.lineTo(p.x + nx * n.jut, p.y + ny * n.jut);
            ctx.lineTo(p.x + tx * n.base / 2, p.y + ty * n.base / 2);
            ctx.closePath(); ctx.fill();
          }
        }
      },
      draw(ctx, now) {
        ctx.lineCap = 'round';
        let anyFade = 0;
        for (const r of rakes) {
          const lt = this.t - r.start;
          if (lt <= 0) continue;
          const sw = Math.min(1, lt / r.sweep);
          const fade = lt > r.sweep ? Math.max(0, 1 - (lt - r.sweep) / r.linger) : 1;
          if (fade <= 0) continue;
          anyFade = Math.max(anyFade, fade);
          const pulse = sw >= 1 ? 1 + Math.sin(now / 60 + r.phase) * 0.08 : 1;
          strokePath(ctx, r, sw, 8, 0.28 * fade * pulse, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
          strokePath(ctx, r, sw, 3.4, 0.8 * fade * pulse, `rgb(${midC[0]},${midC[1]},${midC[2]})`);
          strokePath(ctx, r, sw, 1.6, fade, `rgb(${coreC[0]},${coreC[1]},${coreC[2]})`);
          if (sw < 1) { const h = headAt(r, sw); glintDraw(h.x, h.y, 13, rgb, 0.9); }
        }
        if (anyFade > 0) lightCast(b.x, b.y, 70, rgb, 0.1 * anyFade);
      },
    });
    return (DELAY + 0.02) * 1000 + 20;
  },
};

// ---- archetype selection: attacker card class → attack fx ----
// Per-card overrides beat the tag lookup — Helix's actual BEASTS maul with
// claws while its lab-grown pathogens lob globs, and Bullion Golem (robotic
// + financial) throws gold, which is obviously funnier than bullets.
const ATTACK_FX_OVERRIDE = {
  ob_021: 'ledger', // Bullion Golem
  hx_t_hydra: 'claws', hx_t_labrat: 'claws', // Hydra Clone, Lab Rat
  hx_004: 'claws', // Plasma Leech
  hx_012: 'claws', // Hemo Harvester
  hx_014: 'claws', // Apex Specimen
  hx_016: 'claws', // Symbiotic Titan
  hx_017: 'claws', // The Hydra Initiative
  hx_020: 'claws', // Chimera Calf
  hx_022: 'claws', // Gigafauna
};
const TAG_FX = { robotic: 'bullets', software: 'laser', organism: 'bio', financial: 'ledger', facility: 'artillery' };
function attackFxFor(def) {
  if (!def) return 'kinetic';
  const o = ATTACK_FX_OVERRIDE[def.id];
  if (o) return o;
  for (const t of ['robotic', 'software', 'organism', 'financial', 'facility']) {
    if (def.tags && def.tags.includes(t)) return TAG_FX[t];
  }
  return 'kinetic'; // personnel + anything untagged
}

/** Fire the attacker's archetype at the target. Returns ms until the payload
 *  visually lands so the caller can sync the target's hit reaction. */
function launchAttackFx(key, atkEl, tgtEl) {
  ensureFxCanvas();
  const ra = atkEl.getBoundingClientRect(), rb = tgtEl.getBoundingClientRect();
  const a = { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 };
  const b = { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 };
  const fc = getComputedStyle(atkEl).getPropertyValue('--fc').trim() || '#94a3b8';
  const impactMs = (ATTACK_FX[key] || ATTACK_FX.kinetic).launch(a, b, cssToRgb(fc));
  startFxLoop();
  return Math.min(430, Math.round(impactMs));
}

function fxTick(now) {
  if (!fxRunning || !fxCtx) return;
  const dt = Math.min(0.05, (now - fxLast) / 1000); fxLast = now;
  const ctx = fxCtx, P = fxPools;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const SM = smokeSprites();

  // custom projectile logic (beams, shells, globs, rakes) advances first so
  // anything it spawns this frame still renders this frame
  for (let i = fxUpdaters.length - 1; i >= 0; i--) {
    if (!fxUpdaters[i].update(dt, now)) fxUpdaters.splice(i, 1);
  }

  // SMOKE (source-over, behind everything). Detonation smoke carries
  // turb/buoy/phase; simpler projectile-trail smoke omits them (|| 0).
  for (let i = P.smoke.length - 1; i >= 0; i--) {
    const p = P.smoke[i]; p.life += dt; if (p.life < 0) continue;
    const t = p.life / p.dur; if (t >= 1) { P.smoke.splice(i, 1); continue; }
    p.phase = (p.phase || 0) + dt * 1.4;
    p.vx += Math.sin(p.phase + p.y * 0.012) * (p.turb || 0) * dt;
    p.vy += (Math.cos(p.phase * 0.9 + p.x * 0.012) * (p.turb || 0) - (p.buoy || 0) * (0.4 + t)) * dt;
    p.vx *= (1 - 1.1 * dt); p.vy *= (1 - 1.0 * dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const sz = p.size + p.grow * p.life * (1 + t);
    const step = Math.min(SM.length - 1, (t * SM.length) | 0);
    const spr = p.rgb ? puffFor(p.rgb) : SM[step][(p.seed || 0) % SM[step].length];
    ctx.globalAlpha = Math.min(1, t / 0.09) * (1 - Math.pow(t, 1.7)) * 0.5;
    ctx.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.drawImage(spr, -sz, -sz, sz * 2, sz * 2); ctx.restore();
  }
  // updater bodies that belong under the glow (shell casings, glob body, cuts)
  ctx.globalCompositeOperation = 'source-over';
  for (const u of fxUpdaters) if (u.drawUnder) { ctx.globalAlpha = 1; u.drawUnder(ctx, now); }
  // FIRE (additive)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = P.fire.length - 1; i >= 0; i--) {
    const p = P.fire[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.fire.splice(i, 1); continue; }
    p.vx *= (1 - 2.6 * dt); p.vy = (p.vy - 46 * dt) * (1 - 2.6 * dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const sz = (p.size + p.grow * p.life * 40) * (1 - 0.15 * t);
    ctx.globalAlpha = (1 - t) * (1 - t) * 0.9;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.drawImage(fireFor(p.rgb), -sz, -sz, sz * 2, sz * 2); ctx.restore();
  }
  // updater glows/cores/beams (additive)
  for (const u of fxUpdaters) if (u.draw) { ctx.globalAlpha = 1; u.draw(ctx, now); }
  // DEBRIS (source-over)
  ctx.globalCompositeOperation = 'source-over';
  for (let i = P.debris.length - 1; i >= 0; i--) {
    const p = P.debris[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.debris.splice(i, 1); continue; }
    p.vy += 620 * dt; p.vx *= (1 - 0.6 * dt);
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const a = 1 - Math.pow(t, 2.2);
    ctx.globalAlpha = a; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = '#0a0f18'; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.globalAlpha = a * 0.85; ctx.strokeStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`; ctx.lineWidth = 1.3;
    ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
  }
  // EMBERS (additive, short trail)
  ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (let i = P.embers.length - 1; i >= 0; i--) {
    const p = P.embers[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.embers.splice(i, 1); continue; }
    p.px = p.x; p.py = p.y;
    p.vy += 300 * dt; p.vx *= (1 - p.drag * dt); p.vy *= (1 - p.drag * dt * 0.6);
    p.x += p.vx * dt; p.y += p.vy * dt; p.flick += dt * 30;
    const fl = 0.6 + 0.4 * Math.sin(p.flick), sz = p.size * (1 - 0.5 * t);
    ctx.globalAlpha = (1 - t) * 0.35 * fl;
    ctx.strokeStyle = `rgb(${Math.min(255, p.rgb[0] + 120)},${Math.min(255, p.rgb[1] + 90)},${Math.min(255, p.rgb[2] + 70)})`;
    ctx.lineWidth = sz * 0.9; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.globalAlpha = (1 - t) * fl; ctx.drawImage(dotFor(p.rgb), p.x - sz * 1.6, p.y - sz * 1.6, sz * 3.2, sz * 3.2);
  }
  // SHOCKWAVE (additive ring)
  for (let i = P.shocks.length - 1; i >= 0; i--) {
    const p = P.shocks[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.shocks.splice(i, 1); continue; }
    const r = p.r + (p.max - p.r) * (1 - Math.pow(1 - t, 2));
    ctx.globalAlpha = (1 - t) * 0.8;
    ctx.strokeStyle = `rgb(${Math.min(255, p.rgb[0] + 90)},${Math.min(255, p.rgb[1] + 70)},${Math.min(255, p.rgb[2] + 60)})`;
    ctx.lineWidth = Math.max(0.4, p.w * (1 - t)); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.stroke();
  }
  // FLASH (additive, on top)
  for (let i = P.flashes.length - 1; i >= 0; i--) {
    const p = P.flashes[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.flashes.splice(i, 1); continue; }
    const r = p.r + (p.max - p.r) * t;
    ctx.globalAlpha = 1 - t; ctx.drawImage(fireFor(p.rgb), p.x - r, p.y - r, r * 2, r * 2);
  }
  // GLINTS (additive, lens-flare twinkles: pop in fast, fade out)
  for (let i = P.glints.length - 1; i >= 0; i--) {
    const p = P.glints[i]; p.life += dt; const t = p.life / p.dur; if (t >= 1) { P.glints.splice(i, 1); continue; }
    const env = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const s = p.s * (0.6 + 0.6 * env);
    ctx.globalAlpha = env;
    ctx.save(); ctx.translate(p.x, p.y); if (p.rot) ctx.rotate(p.rot);
    ctx.drawImage(glintFor(p.rgb), -s, -s, s * 2, s * 2); ctx.restore();
  }

  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const alive = fxUpdaters.length + P.smoke.length + P.fire.length + P.debris.length + P.embers.length + P.shocks.length + P.flashes.length + P.glints.length;
  if (alive === 0) { fxRunning = false; return; } // sleep until the next blast
  requestAnimationFrame(fxTick);
}

/** Unit death: fire the canvas detonation at the unit's center in its faction
 *  color, plus a small screen kick. Fired just after the unit's white-out flash;
 *  the smoke lingers via the canvas loop after the unit itself is removed. */
function deathBurst(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const fc = getComputedStyle(el).getPropertyValue('--fc').trim() || '#94a3b8';
  spawnDetonation(r.left + r.width / 2, r.top + r.height / 2, Math.min(r.width, r.height), cssToRgb(fc));
  screenShake('small');
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

/* attack projectiles render on the #fx-canvas particle system — see the
   ATTACK_FX archetype registry above (launchAttackFx in the attack event). */

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
      // A real gain (Government Subsidy / Multilevel Marketing / Payday …) floats
      // a gold "+N Capital" over the pip row and gives it a quick pop; the
      // routine turn-start refill carries no `gain` and stays silent.
      if (ev.gain > 0) {
        const capRow = hooks.capitalAnchor?.(ev.player);
        if (capRow) {
          pulseClass(capRow, 'anim-reserve-pop', 460);
          floatNum(capRow, '+' + ev.gain + ' Capital', 'gold', { size: 'med' });
        }
        await wait(300);
      } else {
        await wait(120);
      }
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
      // EXCEPT when this same hit ends the game: skip it so it doesn't stack on
      // top of the victory taunt showGameOver plays a moment later.
      if (!batchHasGameOver) audio.playCeoTaunt(hooks.factionOf(ev.attackerPlayer));
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
        if (ATTACHMENT_CARD_IDS.has(ev.cardId)) {
          // Hand the revealed card off to the following effect event (distract),
          // which flies THIS same ghost onto the target and tucks it under.
          clearAttachGhost(); // drop any stale leftover first
          pendingAttachGhost = ghost;
          ghost.dataset.cx = cx; ghost.dataset.cy = cy;
          await wait(300);
        } else {
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
      const atk = hooks.resolveTarget(ev.attackerId);
      // the attacker's asset class picks both the projectile archetype and its
      // attack sound: sfx-attack-<archetype> with numbered variants, falling
      // back to the generic sfx-attack pool (kinetic uses it directly)
      const atkDef = atk?.dataset.cardId ? getCard(atk.dataset.cardId) : null;
      const fxKey = attackFxFor(atkDef);
      audio.playSfx(fxKey === 'kinetic' ? 'sfx-attack' : 'sfx-attack-' + fxKey, 'sfx-attack');
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
      }
      // the archetype projectile flies (or the claws rake) — launchAttackFx
      // reports when the payload visually lands so the target's reaction
      // syncs to the actual arrival (bullets ~230ms, laser beam-on ~110ms,
      // arcing shell ~300-420ms) instead of a fixed delay
      let impactMs = 160;
      if (atk && tgt) impactMs = launchAttackFx(fxKey, atk, tgt);
      if (tgt) {
        // (c) impact + follow-through: white flash frame, knockback with
        // spring return, shake + hit-stop to sell the weight; the canvas
        // burst itself is spawned by the archetype at its landing point
        // (generation-guarded: must never respawn fx after stopAnim/initAnim)
        fxTimeout(() => {
          pulseClass(tgt, 'anim-white-flash', 160);
          pulseClass(tgt, up ? 'anim-knock-up' : 'anim-knock-down', 430);
          screenShake(heroHit ? 'heavy' : 'medium');
          hitStop(90);
        }, impactMs);
      }
      await wait(Math.max(445, impactMs + 285));
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
      if (el && applied && pendingAttachGhost) {
        // Fly the revealed intern from center onto the target and tuck it under
        // (shrink to ~unit size, rotate to match the board tuck). After the
        // batch's applyView re-renders the persistent tuck behind the unit, this
        // flown ghost fades out — a seamless handoff to the real attachment.
        const ghost = pendingAttachGhost; pendingAttachGhost = null;
        const cx = Number(ghost.dataset.cx), cy = Number(ghost.dataset.cy);
        const to = centerOf(el);
        ghost.style.transitionDuration = '480ms';
        ghost.style.transform =
          `translate(-50%,-50%) translate(${to.x - cx}px, ${to.y - cy + 14}px) scale(0.42) rotate(-11deg)`;
        fxTimeout(() => {
          ghost.style.transitionDuration = '240ms';
          ghost.style.opacity = '0';
          setTimeout(() => ghost.remove(), 260);
        }, 500); // after the flight AND the batch's re-render (tuck now behind the unit)
        pulseClass(el, 'distract-pop', 620);
        floatNum(el, '\u{1F48B}', 'distract-mark', { size: 'med' });
        await wait(460);
      } else {
        if (el && applied) {
          pulseClass(el, 'distract-pop', 620);
          floatNum(el, '\u{1F48B}', 'distract-mark', { size: 'med' });
        }
        clearAttachGhost(); // safety: never let a handed-off ghost leak
        await wait(applied ? 300 : 40);
      }
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
