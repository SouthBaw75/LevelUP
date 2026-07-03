// art.js — procedural card artwork + CEO portraits.
// Deterministic per card id (hash → seeded PRNG), rendered as layered inline SVG
// in the card's faction palette. Card types get visually distinct compositions:
//   ASSET     → angular skyline / machine structures
//   OPERATION → radial energy burst / signal rings
//   CEO       → stylized executive bust portrait
//   POWER     → hexagonal corporate sigil
// Also exposes the drop-in artwork convention: real images placed in
// assets/card-art/<cardId>.(png|jpg|webp) replace the procedural placeholder.

import { FACTIONS } from './state.js';

// ---- deterministic PRNG ----
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- faction palettes: [deep bg, mid bg, accent, accent2, glow] ----
const PALETTES = {
  nexus:    ['#04121c', '#0a2436', '#22d3ee', '#38bdf8', '#a5f3fc'],
  vulcan:   ['#190b04', '#33150a', '#f97316', '#fb923c', '#fed7aa'],
  helix:    ['#04170d', '#0b2e1a', '#4ade80', '#2dd4bf', '#bbf7d0'],
  obsidian: ['#120a1c', '#251238', '#c084fc', '#e8b45a', '#f3e8ff'],
  neutral:  ['#0c1118', '#1c2530', '#94a3b8', '#cbd5e1', '#e2e8f0'],
};

function pal(faction) { return PALETTES[faction] || PALETTES.neutral; }

const NS = 'http://www.w3.org/2000/svg';
const W = 200, H = 150; // 4:3 landscape frame

function svgOpen(id) {
  return `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">`
    + `<defs>`
    + `<linearGradient id="bg${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="var(--art-c1)"/><stop offset="1" stop-color="var(--art-c0)"/></linearGradient>`
    + `<radialGradient id="gl${id}" cx="0.5" cy="0.45" r="0.7">`
    + `<stop offset="0" stop-color="var(--art-c2)" stop-opacity="0.55"/>`
    + `<stop offset="1" stop-color="var(--art-c2)" stop-opacity="0"/></radialGradient>`
    + `</defs>`;
}

function gridLayer(r) {
  const step = 14 + Math.floor(r() * 8);
  let d = '';
  for (let x = step; x < W; x += step) d += `M${x} 0V${H}`;
  for (let y = step; y < H; y += step) d += `M0 ${y}H${W}`;
  return `<path d="${d}" stroke="var(--art-c2)" stroke-opacity="0.08" stroke-width="1" fill="none"/>`;
}

function particles(r, n, colorVar, maxR = 1.6) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = (r() * W).toFixed(1), y = (r() * H).toFixed(1);
    const rad = (0.5 + r() * maxR).toFixed(2);
    const o = (0.25 + r() * 0.5).toFixed(2);
    s += `<circle cx="${x}" cy="${y}" r="${rad}" fill="var(${colorVar})" opacity="${o}"/>`;
  }
  return s;
}

// ---- ASSET: skyline / machine structure ----
function assetComposition(r) {
  let s = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#gl%ID%)" opacity="0.6"/>`;
  const n = 5 + Math.floor(r() * 4);
  const baseY = H - 8 - r() * 10;
  let x = 6 + r() * 14;
  for (let i = 0; i < n && x < W - 12; i++) {
    const w = 14 + r() * 26;
    const h = 30 + r() * 85;
    const y = baseY - h;
    const glassy = r() > 0.45;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"`
      + ` fill="var(--art-c1)" stroke="var(--art-c2)" stroke-opacity="${(0.35 + r() * 0.4).toFixed(2)}" stroke-width="1.2"/>`;
    if (glassy) {
      const rows = 2 + Math.floor(r() * 4);
      for (let k = 1; k <= rows; k++) {
        const wy = y + (h * k) / (rows + 1);
        s += `<line x1="${(x + 2).toFixed(1)}" y1="${wy.toFixed(1)}" x2="${(x + w - 2).toFixed(1)}" y2="${wy.toFixed(1)}"`
          + ` stroke="var(--art-c2)" stroke-opacity="0.5" stroke-width="1"/>`;
      }
    }
    if (r() > 0.55) { // antenna
      const ax = x + w * (0.2 + r() * 0.6);
      s += `<line x1="${ax.toFixed(1)}" y1="${y.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${(y - 8 - r() * 14).toFixed(1)}"`
        + ` stroke="var(--art-c3)" stroke-width="1.4"/>`
        + `<circle cx="${ax.toFixed(1)}" cy="${(y - 9 - r() * 14).toFixed(1)}" r="2" fill="var(--art-c4)"/>`;
    }
    x += w + 3 + r() * 10;
  }
  // horizon beam
  s += `<line x1="0" y1="${baseY.toFixed(1)}" x2="${W}" y2="${baseY.toFixed(1)}" stroke="var(--art-c2)" stroke-width="1.6" stroke-opacity="0.9"/>`;
  // diagonal light streak
  const sx = r() * W;
  s += `<polygon points="${sx.toFixed(0)},0 ${(sx + 26).toFixed(0)},0 ${(sx - 40).toFixed(0)},${H} ${(sx - 66).toFixed(0)},${H}"`
    + ` fill="var(--art-c2)" opacity="0.07"/>`;
  s += particles(r, 12, '--art-c4');
  return s;
}

// ---- OPERATION: radial burst / signal rings ----
function operationComposition(r) {
  const cx = 70 + r() * 60, cy = 55 + r() * 40;
  let s = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#gl%ID%)"/>`;
  const rings = 3 + Math.floor(r() * 3);
  for (let i = 0; i < rings; i++) {
    const rad = 14 + i * (12 + r() * 9);
    const dash = r() > 0.5 ? ` stroke-dasharray="${(4 + r() * 12).toFixed(0)} ${(4 + r() * 8).toFixed(0)}"` : '';
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="none"`
      + ` stroke="var(--art-c2)" stroke-opacity="${(0.85 - i * 0.14).toFixed(2)}" stroke-width="${(2.2 - i * 0.3).toFixed(1)}"${dash}/>`;
  }
  const rays = 7 + Math.floor(r() * 6);
  for (let i = 0; i < rays; i++) {
    const a = r() * Math.PI * 2;
    const r1 = 8 + r() * 10, r2 = 46 + r() * 55;
    s += `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}"`
      + ` x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}"`
      + ` stroke="var(--art-c3)" stroke-opacity="${(0.3 + r() * 0.55).toFixed(2)}" stroke-width="${(0.8 + r() * 1.6).toFixed(1)}"/>`;
  }
  s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(5 + r() * 5).toFixed(1)}" fill="var(--art-c4)"/>`;
  s += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(10 + r() * 6).toFixed(1)}" fill="var(--art-c2)" opacity="0.35"/>`;
  // data ticks along bottom, terminal-style
  let ticks = '';
  for (let x = 8; x < W - 8; x += 7) ticks += `M${x} ${H - 10 - r() * 14}V${H - 8}`;
  s += `<path d="${ticks}" stroke="var(--art-c2)" stroke-opacity="0.35" stroke-width="2"/>`;
  s += particles(r, 10, '--art-c4');
  return s;
}

// ---- CEO: executive bust silhouette ----
function ceoComposition(r) {
  const cx = W / 2;
  const headR = 20 + r() * 4;
  const headY = 52 + r() * 6;
  let s = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#gl%ID%)"/>`;
  // venetian-blind light bars behind
  for (let y = 8; y < H; y += 16) {
    s += `<rect x="0" y="${y}" width="${W}" height="6" fill="var(--art-c2)" opacity="0.06"/>`;
  }
  // shoulders
  const shW = 62 + r() * 16;
  s += `<path d="M${cx - shW} ${H} Q${cx - shW * 0.82} ${headY + headR + 12} ${cx - 16} ${headY + headR + 4}`
    + ` L${cx + 16} ${headY + headR + 4} Q${cx + shW * 0.82} ${headY + headR + 12} ${cx + shW} ${H} Z"`
    + ` fill="#05070c" stroke="var(--art-c2)" stroke-opacity="0.8" stroke-width="1.4"/>`;
  // collar + tie
  s += `<path d="M${cx - 9} ${headY + headR + 4} L${cx} ${headY + headR + 18} L${cx + 9} ${headY + headR + 4}"`
    + ` fill="none" stroke="var(--art-c4)" stroke-width="1.4"/>`;
  s += `<path d="M${cx - 4} ${headY + headR + 12} L${cx} ${H} L${cx + 4} ${headY + headR + 12} Z" fill="var(--art-c2)" opacity="0.9"/>`;
  // head
  s += `<circle cx="${cx}" cy="${headY}" r="${headR.toFixed(1)}" fill="#05070c" stroke="var(--art-c2)" stroke-width="1.6"/>`;
  // visor / glasses line (deterministic variety)
  if (r() > 0.35) {
    s += `<rect x="${(cx - headR * 0.85).toFixed(1)}" y="${(headY - 4).toFixed(1)}" width="${(headR * 1.7).toFixed(1)}" height="6"`
      + ` fill="var(--art-c2)" opacity="0.85" rx="2"/>`;
  } else {
    s += `<line x1="${(cx - headR * 0.7).toFixed(1)}" y1="${headY}" x2="${(cx - 3).toFixed(1)}" y2="${headY}" stroke="var(--art-c4)" stroke-width="2"/>`
      + `<line x1="${(cx + 3).toFixed(1)}" y1="${headY}" x2="${(cx + headR * 0.7).toFixed(1)}" y2="${headY}" stroke="var(--art-c4)" stroke-width="2"/>`;
  }
  // rim light
  s += `<path d="M${(cx - headR).toFixed(1)} ${headY} A${headR.toFixed(1)} ${headR.toFixed(1)} 0 0 1 ${cx} ${(headY - headR).toFixed(1)}"`
    + ` fill="none" stroke="var(--art-c4)" stroke-width="1.6" opacity="0.9"/>`;
  // halo ring
  s += `<circle cx="${cx}" cy="${headY + 6}" r="${headR + 16}" fill="none" stroke="var(--art-c2)" stroke-opacity="0.28" stroke-width="1"/>`;
  s += particles(r, 8, '--art-c4');
  return s;
}

// ---- POWER: hexagonal sigil ----
function powerComposition(r) {
  const cx = W / 2, cy = H / 2;
  let s = `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#gl%ID%)"/>`;
  function hex(rad, rot) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = rot + (i * Math.PI) / 3;
      pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
    }
    return pts.join(' ');
  }
  const baseRot = r() * Math.PI;
  s += `<polygon points="${hex(52, baseRot)}" fill="none" stroke="var(--art-c2)" stroke-opacity="0.35" stroke-width="1.4"/>`;
  s += `<polygon points="${hex(38, baseRot + 0.26)}" fill="var(--art-c1)" stroke="var(--art-c2)" stroke-width="2"/>`;
  s += `<polygon points="${hex(24, baseRot)}" fill="none" stroke="var(--art-c3)" stroke-width="1.6"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${(7 + r() * 5).toFixed(1)}" fill="var(--art-c4)"/>`;
  const spokes = 6;
  for (let i = 0; i < spokes; i++) {
    const a = baseRot + (i * Math.PI) / 3;
    s += `<line x1="${(cx + Math.cos(a) * 24).toFixed(1)}" y1="${(cy + Math.sin(a) * 24).toFixed(1)}"`
      + ` x2="${(cx + Math.cos(a) * 52).toFixed(1)}" y2="${(cy + Math.sin(a) * 52).toFixed(1)}"`
      + ` stroke="var(--art-c2)" stroke-opacity="0.5" stroke-width="1"/>`;
  }
  s += particles(r, 10, '--art-c4');
  return s;
}

let uid = 0;

/** Generate deterministic procedural SVG markup for a card. */
export function artSvg(cardId, faction, type) {
  const r = mulberry32(hash32(cardId || 'unknown'));
  const id = 'a' + (uid++).toString(36) + (hash32(cardId || 'x') % 997).toString(36);
  const p = pal(faction);
  let body;
  switch (type) {
    case 'OPERATION': body = operationComposition(r); break;
    case 'CEO': body = ceoComposition(r); break;
    case 'POWER': body = powerComposition(r); break;
    default: body = assetComposition(r); break;
  }
  body = body.replaceAll('%ID%', id);
  let out = svgOpen(id)
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg${id})"/>`
    + gridLayer(r)
    + body
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="2"/>`
    + `</svg>`;
  // bake literal palette colors so the SVG works anywhere (no CSS vars needed)
  for (let i = 0; i < 5; i++) out = out.replaceAll(`var(--art-c${i})`, p[i]);
  return out;
}

// ---- drop-in real artwork convention (see client/assets/card-art/README.md) ----
// assets/card-art/<cardId>.png → .jpg → .webp; cached probe results so the deck
// builder's big grid doesn't re-probe the same missing files.
const ART_EXTS = ['png', 'jpg', 'webp'];
const ICON_EXTS = ['png', 'webp']; // transparency-preserving formats only
const artCache = new Map(); // cardId -> Promise<string|null> (resolved url or null)
const ceoCache = new Map(); // faction -> Promise<string|null>
const iconCache = new Map(); // faction -> Promise<string|null>

export function findCardImage(cardId) {
  if (!cardId) return Promise.resolve(null);
  let p = artCache.get(cardId);
  if (!p) {
    p = probe('assets/card-art', cardId, 0, ART_EXTS);
    artCache.set(cardId, p);
  }
  return p;
}

// assets/ceo-art/<faction>.(png|jpg|webp) — one portrait per conglomerate.
export function findCeoImage(faction) {
  if (!faction) return Promise.resolve(null);
  let p = ceoCache.get(faction);
  if (!p) {
    p = probe('assets/ceo-art', faction, 0, ART_EXTS);
    ceoCache.set(faction, p);
  }
  return p;
}

// assets/faction-icons/<faction>.(png|webp) — one circular symbol per
// conglomerate (png/webp only, since transparency is the whole point).
export function findFactionIcon(faction) {
  if (!faction) return Promise.resolve(null);
  let p = iconCache.get(faction);
  if (!p) {
    p = probe('assets/faction-icons', faction, 0, ICON_EXTS);
    iconCache.set(faction, p);
  }
  return p;
}

// Probe <dir>/<name>.<ext> across the given extensions; resolve the first URL
// that loads, or null. Results are cached by the callers above so a screen
// re-render never re-probes the same missing files.
function probe(dir, name, i, exts) {
  if (i >= exts.length) return Promise.resolve(null);
  const url = `${dir}/${name}.${exts[i]}`;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => resolve(probe(dir, name, i + 1, exts));
    img.src = url;
  });
}

/**
 * Fill an art-frame element: procedural placeholder immediately (with a subtle
 * ART PENDING tag), swapped for the real image if one exists on disk.
 */
export function mountArt(frameEl, cardId, faction, type, { pending = true } = {}) {
  frameEl.classList.add('art-frame');
  frameEl.innerHTML = artSvg(cardId, faction, type);
  if (pending) {
    const tag = document.createElement('span');
    tag.className = 'art-pending';
    tag.textContent = 'ART PENDING';
    frameEl.appendChild(tag);
  }
  findCardImage(cardId).then((url) => {
    if (!url) return;
    const img = document.createElement('img');
    img.className = 'art-real';
    img.alt = '';
    img.src = url;
    frameEl.innerHTML = '';
    frameEl.appendChild(img);
  });
}

/** CEO portrait SVG (used on faction select + game hero plates). */
export function ceoPortraitSvg(cardId, faction) {
  return artSvg(cardId || faction + '_ceo', faction, 'CEO');
}

/**
 * Fill a portrait element with the procedural CEO SVG immediately, then swap in
 * a real drop-in portrait if assets/ceo-art/<faction>.(png|jpg|webp) exists.
 * Mirrors mountArt but keyed by faction (one CEO per conglomerate).
 */
export function mountCeoPortrait(el, faction, cardId) {
  el.classList.remove('has-photo');
  el.innerHTML = ceoPortraitSvg(cardId || faction + '_ceo', faction);
  findCeoImage(faction).then((url) => {
    if (!url) return;
    const img = document.createElement('img');
    img.className = 'ceo-real';
    img.alt = '';
    img.src = url;
    el.innerHTML = '';
    el.appendChild(img);
    // real photos get a lighter, wider treatment (see CSS .fc-portrait.has-photo)
    el.classList.add('has-photo');
  });
}

// Short placeholder monogram shown in the faction-icon badge until a real
// symbol is dropped into assets/faction-icons/. Kept distinct per faction id
// (avoids "N" colliding between nexus and neutral).
const ICON_GLYPH = { nexus: 'N', vulcan: 'V', helix: 'H', obsidian: 'O', neutral: 'IC' };

function iconPlaceholderSvg(faction) {
  const c = factionColor(faction);
  const glyph = ICON_GLYPH[faction] || '?';
  const fontSize = glyph.length > 1 ? 34 : 42;
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="#0b1220" fill-opacity="0.55"/>
    <circle cx="50" cy="50" r="45" fill="none" stroke="${c}" stroke-width="3" stroke-opacity="0.75"/>
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central"
          font-family="-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
          font-weight="800" font-size="${fontSize}" fill="${c}">${glyph}</text>
  </svg>`;
}

/**
 * Fill a small badge element with the faction's circular symbol: a placeholder
 * monogram immediately, swapped for a real drop-in icon if
 * assets/faction-icons/<faction>.(png|webp) exists. Faction-icons are looked
 * up by faction id only (one shared symbol per conglomerate, not per card).
 */
export function mountFactionIcon(el, faction) {
  el.innerHTML = iconPlaceholderSvg(faction);
  findFactionIcon(faction).then((url) => {
    if (!url) return;
    const img = document.createElement('img');
    img.className = 'icon-real';
    img.alt = '';
    img.src = url;
    el.innerHTML = '';
    el.appendChild(img);
  });
}

export function factionColor(faction) {
  return (FACTIONS[faction] || FACTIONS.neutral).color;
}

export function palette(faction) { return pal(faction); }
